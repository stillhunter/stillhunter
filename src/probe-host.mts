// The probe host: it launches the browser, then runs the probe in a child Node
// process under Node's permission model. The child may read the run folder and
// this package's own code, but write only a scratch folder and its shots
// folder, so it cannot touch the runner's own files (context.json, the result
// files, findings.json, finish-state.json) that the runner trusts. It starts
// no processes, workers or addons, sees only PATH and the sign-in variables
// `start` named, and never launches a browser: it connects to this one, and
// only through the relay, which checks every protocol message it sends.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { type ClientRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, request, type Server } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { playwrightCoreDir } from './browser.mjs';
import { allowedUrl, credentialValues, redact } from './common.mjs';
export { REDACTED, redact } from './common.mjs';
import type { ChildJob } from './probe-child.mjs';
import { type Relay, startRelay } from './relay.mjs';
import { emptyResult, type ProbeResult } from './results.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'probe-child.mjs');
export const PROBE_TIMEOUT_MS = 100_000;
export const KILL_GRACE_MS = 20_000;
const OUTPUT_TAIL = 2000;

export interface HostJob {
  runDir: string;
  probe: string;
  probeFile: string;
  target: string;
  browser: string;
  allowedHosts: readonly string[];
  ignoreHTTPSErrors?: boolean;
  signInVariables: string[];
  scratchDir?: string;
  shotsDir: string;
  headed?: boolean;
  slowMo?: number;
  keepOpenMs?: number;
  timeoutMs?: number;
}

// The default writable place for a session and scratch, shared by ordinary
// hunt probes and replayed tests. A proof passes its own attempt directory.
export const scratchDir = (runDir: string) => path.join(runDir, 'scratch');
// The session the run's sign-in saved, which every probe of the run starts from.
export const sessionPath = (runDir: string) => path.join(scratchDir(runDir), 'session.json');

// Node 22 has no network permission; later versions have one switch for all
// of it, and the child needs it to reach the browser. Either way a probe's own
// Node code can reach the network; the browser is held to authorized hosts below.
export const NODE_NET_PERMISSION = process.allowedNodeEnvironmentFlags.has('--allow-net');

function both(p: string): string[] {
  try {
    const real = realpathSync.native(p);
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

// When playwright-core loads on Linux it asks whether it runs under WSL or in a
// container, by reading these system files. One of those checks is not
// wrapped in a try, and the permission model makes a refused existsSync throw,
// so without them every probe would stop before it ran. They hold no user data,
// and they are granted as exact paths.
export const LINUX_PLATFORM_FILES = ['/proc/version', '/proc/sys/fs/binfmt_misc/WSLInterop', '/run/WSL', '/run/.containerenv', '/.dockerenv', '/proc/self/cgroup'];

// Reads cover the run folder (its own probe, session and results) and this
// package's compiled code and playwright-core, but not the package root, so a
// dev checkout's repository, node_modules and benchmark answers stay unread.
// Writes cover only the folders the child owns.
export function permissionArgs(runDir: string, writeDirs: string[], platform: NodeJS.Platform = process.platform): string[] {
  const reads = [
    ...new Set([
      ...[runDir, HERE, playwrightCoreDir()].map((p) => path.resolve(p)).flatMap(both),
      ...(platform === 'linux' ? LINUX_PLATFORM_FILES : []),
    ]),
  ];
  const writes = [...new Set(writeDirs.map((p) => path.resolve(p)).flatMap(both))];
  return [
    '--permission',
    ...reads.map((p) => `--allow-fs-read=${p}`),
    ...writes.map((p) => `--allow-fs-write=${p}`),
    ...(NODE_NET_PERMISSION ? ['--allow-net'] : []),
    '--disable-warning=ExperimentalWarning',
  ];
}

export function childEnv(names: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (pathKey && typeof env[pathKey] === 'string') out[pathKey] = env[pathKey]!;
  // Windows cannot open a socket in a process without SystemRoot.
  if (platform === 'win32') {
    const root = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
    if (root && typeof env[root] === 'string') out[root] = env[root]!;
  }
  for (const name of names) if (Object.hasOwn(env, name) && typeof env[name] === 'string') out[name] = env[name]!;
  return out;
}

const PROXY_TIMEOUT_MS = 10_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardHeaders(headers: IncomingHttpHeaders, upgrade = false): IncomingHttpHeaders {
  const nominated = (headers.connection ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const out = { ...headers };
  for (const name of Object.keys(out)) if (HOP_BY_HOP.has(name) || nominated.includes(name)) delete out[name];
  if (upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = headers.upgrade;
  }
  return out;
}

function proxyUrl(address: string, allowedHosts: readonly string[], protocol: 'http:' | 'https:'): URL | null {
  if (!allowedUrl(address, 'http://127.0.0.1', allowedHosts)) return null;
  const url = new URL(address);
  return url.protocol === protocol ? url : null;
}

function upstreamOptions(url: URL, req: IncomingMessage, upgrade = false) {
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers: forwardHeaders(req.headers, upgrade),
    agent: false,
  };
}

function pipeSockets(client: Duplex, upstream: Duplex, clientHead: Buffer, upstreamHead: Buffer): void {
  client.once('error', () => upstream.destroy());
  upstream.once('error', () => client.destroy());
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
  if (clientHead.length) upstream.write(clientHead);
  if (upstreamHead.length) client.write(upstreamHead);
  client.pipe(upstream);
  upstream.pipe(client);
}

// Every browser connection uses this proxy, loopback included. Node's HTTP
// parser handles ordinary requests; only authorized CONNECT and valid 101
// upgrades become raw tunnels. Tracked sockets are destroyed at probe teardown.
export function closedProxy(allowedHosts: readonly string[]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const upstreamRequests = new Set<ClientRequest>();
    const server = createServer((req, res) => {
      const url = proxyUrl(req.url ?? '', allowedHosts, 'http:');
      if (!url) {
        res.writeHead(403, { connection: 'close' });
        res.end();
        return;
      }
      const upstream = request(upstreamOptions(url, req));
      upstreamRequests.add(upstream);
      upstream.once('close', () => upstreamRequests.delete(upstream));
      res.once('close', () => upstream.destroy());
      req.once('aborted', () => upstream.destroy());
      upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy());
      upstream.on('response', (answer) => {
        answer.once('error', () => res.end());
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, forwardHeaders(answer.headers));
        answer.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { connection: 'close' });
        res.end();
      });
      req.pipe(upstream);
    });
    server.headersTimeout = PROXY_TIMEOUT_MS;
    server.requestTimeout = PROXY_TIMEOUT_MS;
    server.timeout = 0;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    server.on('connect', (req, client, head) => {
      const url = proxyUrl(`https://${req.url ?? ''}`, allowedHosts, 'https:');
      if (!url) return client.destroy();
      const upstream = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) });
      upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      upstream.once('close', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        if (!client.writable) return upstream.destroy();
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    });
    server.on('upgrade', (req, client, head) => {
      const url = proxyUrl(req.url ?? '', allowedHosts, 'http:');
      if (!url || req.method !== 'GET' || !req.headers.upgrade) return client.destroy();
      const upstream = request(upstreamOptions(url, req, true));
      upstream.setTimeout(PROXY_TIMEOUT_MS, () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.on('response', (answer) => {
        answer.resume();
        client.destroy();
      });
      upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
        if (answer.statusCode !== 101 || !/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(answer.headers.connection ?? '') || !answer.headers.upgrade) {
          upstreamSocket.destroy();
          client.destroy();
          return;
        }
        upstream.setTimeout(0);
        upstreamSocket.setTimeout(0);
        if (!client.writable) return upstreamSocket.destroy();
        const headers = forwardHeaders(answer.headers, true);
        let response = `HTTP/1.1 101 ${answer.statusMessage || 'Switching Protocols'}\r\n`;
        for (const [name, value] of Object.entries(headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) response += `${name}: ${item}\r\n`;
        }
        client.write(`${response}\r\n`);
        pipeSockets(client, upstreamSocket, head, upstreamHead);
      });
      upstream.end();
    });
    const close = server.close.bind(server);
    server.close = (callback) => {
      for (const socket of sockets) socket.destroy();
      for (const upstream of upstreamRequests) upstream.destroy();
      return close(callback);
    };
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const closeProxy = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

const MIN_REDACTED = 8;

// The cookie and storage values of the run's saved session. The child must
// read the session to start signed in, so a probe could print it; the result
// the hunter reads never holds these values as they are.
export function sessionValues(file: string): string[] {
  let state: { cookies?: { value?: unknown }[]; origins?: { localStorage?: { value?: unknown }[] }[] };
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as typeof state;
  } catch {
    return [];
  }
  const values = [...(state.cookies ?? []).map((c) => c?.value), ...(state.origins ?? []).flatMap((o) => (o?.localStorage ?? []).map((i) => i?.value))];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length >= MIN_REDACTED))].sort((a, b) => b.length - a.length);
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);

export async function runProbe(job: HostJob): Promise<ProbeResult> {
  const credentials = credentialValues(job.signInVariables);
  const allowedHosts = Object.freeze([...(job.allowedHosts ?? [])]);
  if (!allowedUrl(job.target, job.target, allowedHosts)) return redact(emptyResult(job.probe, 'the target must be loopback or an exact hosts.allow entry; external targets must use HTTPS', 'crash'), credentials, 'result');
  const scratch = job.scratchDir ?? scratchDir(job.runDir);
  mkdirSync(job.shotsDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const sessionFile = path.join(scratch, 'session.json');
  const before = sessionValues(sessionFile);
  const timeoutMs = job.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { chromium } = await import('playwright-core');
  let proxy: Server | null = null;
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | null = null;
  let relay: Relay | null = null;
  try {
    proxy = await closedProxy(allowedHosts);
    const { port } = proxy.address() as { port: number };
    server = await chromium.launchServer({ channel: job.browser, headless: !job.headed, host: '127.0.0.1', args: [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    relay = await startRelay(server.wsEndpoint(), job.target, allowedHosts);
  } catch (e) {
    await server?.kill().catch(() => {});
    if (proxy) await closeProxy(proxy);
    return redact(emptyResult(job.probe, `the browser did not start: ${String((e as Error).message).split('\n')[0]}`, 'crash'), [...credentials, ...sessionValues(sessionFile)], 'result');
  }

  const nonce = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [...permissionArgs(job.runDir, [scratch, job.shotsDir]), CHILD], {
    cwd: scratch,
    env: childEnv(job.signInVariables),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => { output = tail(output + d.toString('utf8')); });
  child.stderr?.on('data', (d: Buffer) => { output = tail(output + d.toString('utf8')); });

  const result = await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (r: ProbeResult) => { if (!settled) { settled = true; clearTimeout(killer); resolve(r); } };
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(emptyResult(job.probe, `probe timed out after ${Math.round((timeoutMs + KILL_GRACE_MS) / 1000)} s and was stopped`, 'timeout'));
    }, timeoutMs + KILL_GRACE_MS + (job.keepOpenMs ?? 0));
    child.on('message', (m: { nonce?: string; result?: ProbeResult; fatal?: string }) => {
      if (m?.nonce !== nonce) return;
      if (m.result) settle(m.result);
      else settle(emptyResult(job.probe, `probe host failed: ${m.fatal ?? 'unknown error'}`, 'crash'));
    });
    child.on('error', (e) => settle(emptyResult(job.probe, `probe host failed to start: ${e.message}`, 'crash')));
    child.on('exit', (code, signal) => {
      // Let a message sent just before exit arrive first.
      setImmediate(() => settle(emptyResult(job.probe, `probe host gave no result (exit ${code ?? signal})`, code === 0 ? 'no-result' : 'crash')));
    });
    const message: ChildJob = {
      nonce,
      wsEndpoint: relay!.endpoint,
      probe: job.probe,
      probeFile: job.probeFile,
      target: job.target,
      allowedHosts,
      ignoreHTTPSErrors: job.ignoreHTTPSErrors,
      sessionFile,
      shotsDir: job.shotsDir,
      timeoutMs,
      slowMo: job.slowMo ?? 0,
      keepOpenMs: job.keepOpenMs ?? 0,
    };
    child.send(message);
  });
  if (child.exitCode === null) child.kill('SIGKILL');
  // Each run starts from scratch, so the browser is killed rather than closed
  // gracefully: it is much faster, and its profile folder is removed either way.
  await relay.close().catch(() => {});
  await server.kill().catch(() => {});
  await closeProxy(proxy);
  result.refused = [...relay.refused];
  result.output = output.trim();
  if (result.hostError && result.output) result.error = `${result.error ?? ''} | output: ${result.output.slice(-400)}`;
  // The session as it was before this run and as the run may have saved it,
  // plus the raw sign-in values the child was given.
  return redact(result, [...before, ...sessionValues(sessionFile), ...credentials], 'result');
}
