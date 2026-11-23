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
import { connect, createServer, type Server, type Socket } from 'node:net';
import { allowedTunnel, type HostPolicy, LOOPBACK_ONLY } from './hosts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwrightCoreDir } from './browser.mjs';
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
  signInVariables: string[];
  shotsDir: string;
  headed?: boolean;
  slowMo?: number;
  keepOpenMs?: number;
  timeoutMs?: number;
  // Hosts besides loopback the browser may reach over https. The sign-in
  // hosts are given only to a probe that may sign in.
  network?: HostPolicy;
}

// The child's one writable place for a session and its own scratch, shared by
// every probe of a run so a saved session carries from one probe to the next.
export const scratchDir = (runDir: string) => path.join(runDir, 'scratch');
// The session the run's sign-in saved, which every probe of the run starts from.
export const sessionPath = (runDir: string) => path.join(scratchDir(runDir), 'session.json');

// Node 22 has no network permission; later versions have one switch for all
// of it, and the child needs it to reach the browser. Either way a probe's own
// Node code can reach the network; the browser is held to loopback below.
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
  const out: Record<string, string> = {};
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (pathKey && env[pathKey] !== undefined) out[pathKey] = env[pathKey]!;
  // Windows cannot open a socket in a process without SystemRoot.
  if (platform === 'win32') {
    const root = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
    if (root && env[root] !== undefined) out[root] = env[root]!;
  }
  for (const name of names) if (env[name] !== undefined) out[name] = env[name]!;
  return out;
}

export interface GatedProxy {
  server: Server;
  port: number;
  // Ends the sign-in: tunnels to sign-in hosts are cut, and no new one opens.
  closeSignIn(): void;
  // Every CONNECT the proxy refused, host and port.
  refused: string[];
}

const MAX_HEAD = 8 * 1024;
const TLS_HANDSHAKE = 0x16;
const MAX_REFUSED = 20;

export type Dial = (host: string, port: number) => Socket;
const directDial: Dial = (host, port) => connect({ host, port });

// The browser's proxy: a local port that drops every connection except an
// HTTPS tunnel (CONNECT host:port) to a host the policy lists. Chrome never
// sends loopback through a proxy, and WebRTC is held to the proxy, so a
// connection to any other host fails, whatever context or socket a page
// opens. With no hosts listed it drops everything, as it always did. Plain
// http through the proxy is never forwarded, and a tunnel that does not start
// with a TLS handshake is cut, so listed hosts are reached over TLS only. The
// tunnel carries TLS end to end: the proxy sees the host name, never the
// traffic.
export function gatedProxy(policy: HostPolicy = LOOPBACK_ONLY, dial: Dial = directDial): Promise<GatedProxy> {
  let signIn = [...policy.signIn];
  const refused: string[] = [];
  const signInTunnels = new Set<Socket>();
  const server = createServer((client) => {
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > MAX_HEAD) client.destroy();
        return;
      }
      client.off('data', onData);
      client.pause();
      const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const m = /^CONNECT ([A-Za-z0-9.-]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
      const host = m?.[1]?.toLowerCase().replace(/\.$/, '') ?? '';
      const port = Number(m?.[2] ?? 0);
      const current: HostPolicy = { allow: policy.allow, signIn };
      if (!m || port < 1 || port > 65535 || !allowedTunnel(host, current)) {
        if (refused.length < MAX_REFUSED) refused.push(m ? `${host}:${port}` : line.slice(0, 120));
        client.destroy();
        return;
      }
      const forSignIn = !allowedTunnel(host, { allow: policy.allow, signIn: [] });
      const upstream = dial(host, port);
      const tunnel = [client, upstream];
      if (forSignIn) for (const t of tunnel) signInTunnels.add(t);
      let open = false;
      const drop = () => { for (const t of tunnel) { t.destroy(); signInTunnels.delete(t); } };
      // An allowed host that cannot be reached answers 502, so the browser
      // says the tunnel failed rather than that nothing answered: the host was
      // allowed, and the network is what failed.
      upstream.on('error', () => {
        if (!open && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', drop);
        else drop();
      });
      client.on('error', drop);
      upstream.on('close', () => { if (open) drop(); });
      client.on('close', drop);
      upstream.once('connect', () => {
        open = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // A tunnel carries TLS only: its first byte must start a TLS
        // handshake record (0x16). Chrome tunnels a plain ws:// WebSocket
        // through the proxy too, and that would reach a listed host in the clear.
        const forward = (first: Buffer) => {
          if (first[0] !== TLS_HANDSHAKE) return drop();
          upstream.write(first);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        };
        const rest = head.subarray(end + 4);
        if (rest.length) forward(rest);
        else {
          client.once('data', (first: Buffer) => { client.pause(); forward(first); });
          client.resume();
        }
      });
    };
    client.on('data', onData);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: (server.address() as { port: number }).port,
      refused,
      closeSignIn: () => {
        signIn = [];
        for (const t of signInTunnels) t.destroy();
        signInTunnels.clear();
      },
    }));
  });
}

export const REDACTED = '[session value]';
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

export function redact<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return secrets.reduce((s, x) => s.split(x).join(REDACTED), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);

export async function runProbe(job: HostJob): Promise<ProbeResult> {
  const scratch = scratchDir(job.runDir);
  mkdirSync(job.shotsDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  const sessionFile = sessionPath(job.runDir);
  const before = sessionValues(sessionFile);
  const timeoutMs = job.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { chromium } = await import('playwright-core');
  const network = job.network ?? LOOPBACK_ONLY;
  let proxy: GatedProxy | null = null;
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | null = null;
  let relay: Relay | null = null;
  try {
    proxy = await gatedProxy(network);
    server = await chromium.launchServer({ channel: job.browser, headless: !job.headed, host: '127.0.0.1', args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    relay = await startRelay(server.wsEndpoint(), job.target, network);
  } catch (e) {
    await server?.kill().catch(() => {});
    proxy?.server.close();
    return emptyResult(job.probe, `the browser did not start: ${String((e as Error).message).split('\n')[0]}`, 'crash');
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
    child.on('message', (m: { nonce?: string; result?: ProbeResult; fatal?: string; signedIn?: boolean }) => {
      // The sign-in saved its session: the sign-in hosts close for the rest
      // of this probe. This needs no nonce, since it can only take access away.
      if (m?.signedIn === true) {
        proxy!.closeSignIn();
        relay!.closeSignIn();
        if (child.connected) child.send({ signInClosed: true });
        return;
      }
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
      network,
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
  proxy.server.close();
  // The proxy's own refusals stay out of the result: the browser's background
  // traffic (updates, safe browsing) lands there too, and says nothing about the app.
  result.refused = [...relay.refused];
  result.output = output.trim();
  if (result.hostError && result.output) result.error = `${result.error ?? ''} | output: ${result.output.slice(-400)}`;
  // The session as it was before this run and as the run may have saved it,
  // plus the raw sign-in values the child was given.
  const credentials = job.signInVariables.flatMap((name) => {
    const value = process.env[name];
    return value && value.length >= 4 ? [value] : [];
  });
  return redact(result, [...new Set([...before, ...sessionValues(sessionFile), ...credentials])]);
}
