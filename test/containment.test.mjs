// A probe runs in a child process under Node's permission model, with a
// browser it did not launch. Each probe here tries to get out and must fail.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { connect, createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { browserChoice, CONFIGURED, DECOY, hunt, makeRepo, noBrowser, probe, runIdOf, SIGN_IN, SIGNIN_PROBE, startFixture, startTlsFixture } from './helpers.mjs';
import { closedProxy, runProbe } from '../dist/probe-host.mjs';

test('the browser proxy rejects malformed authorities without an uncaught runner error', { timeout: 10_000 }, async () => {
  const server = await closedProxy([]);
  const { port } = server.address();
  try {
    for (const request of ['CONNECT : HTTP/1.1\r\n\r\n', 'CONNECT [::1 HTTP/1.1\r\n\r\n', 'GET http://: HTTP/1.1\r\n\r\n']) {
      await new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.end(request));
        socket.once('data', () => { socket.destroy(); resolve(); });
        socket.once('close', resolve);
        socket.once('error', reject);
      });
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('controlled probe errors redact a one-megabyte credential without throwing', async () => {
  const secret = 'x'.repeat(1_000_000);
  process.env.GIANT_TOKEN = secret;
  try {
    const result = await runProbe({
      runDir: '/unused', probe: secret, probeFile: '/unused', target: 'http://192.0.2.1/', browser: 'chrome',
      allowedHosts: [], signInVariables: ['GIANT_TOKEN'], shotsDir: '/unused',
    });
    assert.equal(result.probe, '[session value]');
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally {
    delete process.env.GIANT_TOKEN;
  }
});

test('controlled probe errors redact credentials containing the complete marker', async () => {
  const secret = 'abc[session value]xyz';
  process.env.MARKER_TOKEN = secret;
  try {
    const result = await runProbe({
      runDir: '/unused', probe: secret, probeFile: '/unused', target: 'http://192.0.2.1/', browser: 'chrome',
      allowedHosts: [], signInVariables: ['MARKER_TOKEN'], shotsDir: '/unused',
    });
    assert.equal(result.probe, '[session value]');
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally {
    delete process.env.MARKER_TOKEN;
  }
});

describe('proxy HTTP protocol handling', { timeout: 20_000 }, () => {
  let proxy;
  let origin;
  let originPort;
  let proxyPort;
  const requests = [];
  before(async () => {
    origin = createNetServer((socket) => {
      socket.once('data', (data) => {
        requests.push(data.toString('latin1'));
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    originPort = origin.address().port;
    proxy = await closedProxy([]);
    proxyPort = proxy.address().port;
  });
  beforeEach(() => { requests.length = 0; });
  after(async () => {
    await new Promise((r) => proxy.close(r));
    await new Promise((r) => origin.close(r));
  });
  const exchange = (raw, headersOnly = false) => new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => socket.write(raw));
    let text = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('proxy exchange timed out')); }, 2000);
    const done = () => { clearTimeout(timer); resolve({ text, socket }); };
    socket.on('data', (data) => {
      text += data.toString('latin1');
      if (headersOnly && text.includes('\r\n\r\n')) done();
    });
    socket.once('close', done);
    socket.once('error', reject);
  });

  test('TE plus CL is rejected without forwarding ambiguous bytes', async () => {
    await exchange(`POST http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n0\r\n\r\n`);
    assert.equal(requests.length, 0);
  });

  test('conflicting duplicate Content-Length headers are rejected without forwarding', async () => {
    await exchange(`POST http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc`);
    assert.equal(requests.length, 0);
  });

  test('Connection-nominated and hop-by-hop headers are not forwarded', async () => {
    const { socket } = await exchange(`GET http://127.0.0.1:${originPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: keep-alive, X-Internal-Hop\r\nX-Internal-Hop: must-not-forward\r\nKeep-Alive: timeout=60\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: secret\r\n\r\n`, true);
    socket.destroy();
    assert.equal(requests.length, 1);
    assert.doesNotMatch(requests[0], /X-Internal-Hop|Keep-Alive|Proxy-Connection|Proxy-Authorization/i);
  });

  test('a pipelined unlisted second request is not tunneled with the first', async () => {
    await exchange(`GET http://127.0.0.1:${originPort}/first HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\nGET http://0.0.0.0:${originPort}/second HTTP/1.1\r\nHost: 0.0.0.0:${originPort}\r\n\r\n`);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/first/);
    assert.doesNotMatch(requests.join(''), /\/second/);
  });

  test('an authorized Upgrade preserves its semantics and tunnels only a valid 101 response', async () => {
    const upgraded = new Set();
    const upgradeOrigin = createHttpServer();
    upgradeOrigin.on('upgrade', (req, socket) => {
      upgraded.add(socket);
      socket.on('error', () => {});
      if (!/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(req.headers.connection ?? '')) {
        socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    await new Promise((r) => upgradeOrigin.listen(0, '127.0.0.1', r));
    try {
      const { text, socket } = await exchange(`GET http://127.0.0.1:${upgradeOrigin.address().port}/socket HTTP/1.1\r\nHost: 127.0.0.1:${upgradeOrigin.address().port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, true);
      assert.match(text, /^HTTP\/1\.1 101 /);
      socket.destroy();
    } finally {
      for (const socket of upgraded) socket.destroy();
      await new Promise((r) => upgradeOrigin.close(r));
    }
  });
});

const eventually = async (predicate) => {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
};

test('closing a downstream client aborts a hung ordinary upstream response', { timeout: 10_000 }, async () => {
  let seen;
  const requestSeen = new Promise((r) => { seen = r; });
  const origin = createHttpServer((req) => seen(req.socket));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const proxy = await closedProxy([]);
  let client;
  try {
    client = connect(proxy.address().port, '127.0.0.1', () => {
      client.write(`GET http://127.0.0.1:${origin.address().port}/hung HTTP/1.1\r\nHost: 127.0.0.1:${origin.address().port}\r\n\r\n`);
    });
    const upstreamSocket = await requestSeen;
    let closed = false;
    upstreamSocket.once('close', () => { closed = true; });
    client.destroy();
    assert.equal(await eventually(() => closed), true, 'the origin request remains open after its downstream client closes');
  } finally {
    client?.destroy();
    await new Promise((r) => proxy.close(r));
    origin.closeAllConnections();
    await new Promise((r) => origin.close(r));
  }
});

test('proxy.close aborts a continuously streaming ordinary upstream response', { timeout: 10_000 }, async () => {
  let markClosed;
  const upstreamClosed = new Promise((r) => { markClosed = r; });
  const origin = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
    const interval = setInterval(() => res.write('chunk'), 10);
    res.once('close', () => { clearInterval(interval); markClosed(); });
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const proxy = await closedProxy([]);
  let client;
  try {
    const firstChunk = new Promise((resolve, reject) => {
      client = connect(proxy.address().port, '127.0.0.1', () => {
        client.write(`GET http://127.0.0.1:${origin.address().port}/stream HTTP/1.1\r\nHost: 127.0.0.1:${origin.address().port}\r\n\r\n`);
      });
      client.once('data', resolve);
      client.once('error', reject);
    });
    await firstChunk;
    await new Promise((r) => proxy.close(r));
    let closed = false;
    upstreamClosed.then(() => { closed = true; });
    assert.equal(await eventually(() => closed), true, 'the streaming origin remains open after proxy.close');
  } finally {
    client?.destroy();
    origin.closeAllConnections();
    await new Promise((r) => origin.close(r));
  }
});

test('a real browser can use a loopback WebSocket through the probe proxy', { skip: noBrowser, timeout: 60_000 }, async () => {
  const upgraded = new Set();
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>WebSocket fixture</body></html>');
  });
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('error', () => {});
    if (!/(?:^|,)\s*upgrade\s*(?:,|$)/i.test(req.headers.connection ?? '')) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-ws-')));
  const { port } = server.address();
  const probeFile = path.join(dir, 'websocket.mjs');
  writeFileSync(probeFile, `export default async function (rr) {
    await rr.goto('/');
    const answer = await rr.page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket('ws://' + location.host + '/socket');
      ws.onmessage = (e) => resolve(e.data);
      ws.onerror = () => resolve('websocket-error');
      setTimeout(() => resolve('websocket-timeout'), 3000);
    }));
    rr.expect('loopback-upgrade', answer === 'ok', answer);
  }`);
  try {
    const result = await runProbe({
      runDir: dir, probe: 'websocket', probeFile, target: `http://127.0.0.1:${port}`, browser: browserChoice.name,
      allowedHosts: [], signInVariables: [], shotsDir: path.join(dir, 'shots'), timeoutMs: 10_000,
    });
    assert.equal(result.error, null, result.error);
    assert.equal(result.checks[0]?.pass, true, JSON.stringify(result));
  } finally {
    for (const socket of upgraded) socket.destroy();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('explicit external host allowlisting', { skip: noBrowser, timeout: 120_000 }, () => {
  let tls;
  let dir;
  before(async () => {
    tls = await startTlsFixture();
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-allow-')));
  });
  after(async () => {
    await tls?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const run = async (name, body, allowedHosts = [tls.externalAllowedHost]) => {
    const probeFile = path.join(dir, `${name}.mjs`);
    writeFileSync(probeFile, `export default async function (rr) {\n${body}\n}\n`);
    return runProbe({
      runDir: dir, probe: name, probeFile, target: tls.externalUrl, browser: browserChoice.name,
      allowedHosts: Object.freeze(allowedHosts), ignoreHTTPSErrors: true,
      signInVariables: [], shotsDir: path.join(dir, 'shots'), timeoutMs: 20_000,
    });
  };

  test('a real browser reaches only the exact allowlisted HTTPS authority, including without page routes', async () => {
    const result = await run('allowlisted-https', `
      const refused = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
      await rr.goto('/');
      rr.expect('exact-https-host', (await rr.page.textContent('body')) === 'allowed HTTPS');
      const api = await rr.request('GET', '/');
      rr.expect('host-request', api.status === 200 && api.text === 'allowed HTTPS', api);
      rr.expect('wrong-host', /refused by the browser relay/.test(await refused(() => rr.page.goto(${JSON.stringify(tls.wrongHostUrl)}))));
      rr.expect('wrong-port', /refused by the browser relay/.test(await refused(() => rr.page.goto(${JSON.stringify(tls.wrongPortUrl)}))));
      rr.expect('external-http', /refused by the browser relay/.test(await refused(() => rr.page.goto(${JSON.stringify(tls.externalUrl.replace('https:', 'http:'))}))));
      rr.expect('unlisted-redirect', /blockedbyclient|ERR_EMPTY_RESPONSE/i.test(await refused(() => rr.goto('/redirect'))));

      const browser = rr.page.context().browser();
      const bare = (await browser._channel.newContext({ baseURL: rr.web, ignoreHTTPSErrors: true, selectorEngines: [] })).context._object;
      const page = await bare.newPage();
      await page.goto('/');
      rr.expect('raw-context-allowed-https', (await page.textContent('body')) === 'allowed HTTPS');
      const fetched = await page.evaluate((urls) => Promise.all(urls.map((url) => fetch(url, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked'))), [${JSON.stringify(tls.wrongHostUrl)}, ${JSON.stringify(tls.wrongPortUrl)}, ${JSON.stringify(tls.loopbackAliasWrongPortUrl)}]);
      rr.expect('proxy-blocks-wrong-authorities', fetched.every((x) => x === 'blocked'), fetched);
      await bare.close();
    `);
    assert.equal(result.error, null, JSON.stringify({ error: result.error, output: result.output, checks: result.checks }));
    assert.deepEqual(result.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), [], JSON.stringify(result));
    assert.equal(tls.hits.wrongHost, 0, 'the unlisted redirect and wrong-host fetches never reached their decoy');
    assert.equal(tls.hits.wrongPort, 0, 'the wrong-port fetch never reached its decoy');
  });

  test('a real browser refuses a non-loopback target omitted from the run allowlist', async () => {
    const result = await run('omitted-target', `rr.expect('probe-must-not-run', true);`, []);
    assert.match(String(result.error), /target must be loopback or an exact hosts.allow entry/);
    assert.equal(result.checks.length, 0);
  });
});

describe('containment', { skip: noBrowser, timeout: 300_000 }, () => {
  let app;
  let dir;
  let runId;
  // A file outside the run folder that the browser must not read for a probe,
  // and an HTTP proxy on loopback that answers for any host it is asked for.
  let decoy;
  let proxy;
  const DECOY_TEXT = 'decoy outside the run folder\n';
  const run = (name, body) => {
    const r = probe(dir, runId, name, `import fs from 'node:fs';\nimport os from 'node:os';\nimport path from 'node:path';\nexport default async function (rr) {\n${body}\n}\n`);
    assert.ok(r.result, r.stdout + r.stderr);
    assert.equal(r.result.error, null, r.result.error);
    return r.result;
  };
  const passed = (result) => {
    assert.ok(result.checks.length > 0);
    assert.deepEqual(result.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), []);
  };

  before(async () => {
    app = await startFixture();
    dir = makeRepo(app);
    const collisionRoot = `${dir}${CONFIGURED.SHFIX_SHORT}`;
    renameSync(dir, collisionRoot);
    dir = collisionRoot;
    const configFile = path.join(dir, '.stillhunter', 'config.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    writeFileSync(configFile, JSON.stringify({ ...config, auth: { env: ['SHFIX_EMAIL', 'SHFIX_PASSWORD', 'SHFIX_SHORT', 'CUSTOM_TOKEN'] } }));
    const started = hunt(['start'], { cwd: dir });
    runId = runIdOf(started.stdout);
    assert.ok(runId);
    const contextFile = path.join(dir, '.stillhunter', 'runs', runId, 'context.json');
    const context = JSON.parse(readFileSync(contextFile, 'utf8'));
    const rootStat = statSync(context.root);
    const dirStat = statSync(dir);
    assert.deepEqual([rootStat.dev, rootStat.ino], [dirStat.dev, dirStat.ino], 'root is the generated repository path, not credential storage');
    const { root, ...persistedContext } = context;
    const persistedContextText = JSON.stringify(persistedContext);
    assert.deepEqual(context.signInVariables, ['CUSTOM_TOKEN', 'SHFIX_EMAIL', 'SHFIX_PASSWORD', 'SHFIX_SHORT']);
    for (const value of Object.values(CONFIGURED)) {
      assert.ok(!started.stdout.includes(value));
      assert.ok(!readFileSync(configFile, 'utf8').includes(value));
      assert.ok(!persistedContextText.includes(value));
    }
    decoy = path.join(dir, 'decoy.txt');
    writeFileSync(decoy, DECOY_TEXT);
    // Its own process: the runner calls block this one while a probe runs.
    proxy = spawn(process.execPath, ['-e', "require('node:http').createServer((q, s) => s.end('proxied')).listen(0, '127.0.0.1', function () { console.log('listening ' + this.address().port); })"], { stdio: ['ignore', 'pipe', 'inherit'] });
    proxy.port = await new Promise((resolve) => proxy.stdout.on('data', (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); }));
  });
  after(() => {
    proxy?.kill();
    app?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a probe cannot read ~/.ssh or anything outside the run folder', () => {
    passed(run('read', `
      const denied = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code; } };
      rr.expect('ssh-denied', denied(() => fs.readdirSync(path.join(os.homedir(), '.ssh'))) === 'ERR_ACCESS_DENIED');
      rr.expect('ssh-key-denied', denied(() => fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_ed25519'))) === 'ERR_ACCESS_DENIED');
      rr.expect('config-denied', denied(() => fs.readFileSync(path.join(process.cwd(), '..', '..', '..', 'config.json'))) === 'ERR_ACCESS_DENIED');
      rr.expect('run-folder-readable', denied(() => fs.readFileSync(path.join(process.cwd(), '..', 'context.json'))) === 'allowed');
    `));
  });

  test('a probe cannot start a process or a worker', () => {
    passed(run('spawn', `
      const cp = await import('node:child_process');
      const wt = await import('node:worker_threads');
      const code = (f) => { try { const r = f(); return r?.error?.code ?? 'allowed'; } catch (e) { return e.code; } };
      rr.expect('spawn-denied', code(() => cp.spawnSync(process.execPath, ['-v'])) === 'ERR_ACCESS_DENIED');
      rr.expect('exec-denied', code(() => cp.execSync('echo hi')) === 'ERR_ACCESS_DENIED');
      rr.expect('worker-denied', code(() => new wt.Worker('1', { eval: true })) === 'ERR_ACCESS_DENIED');
    `));
  });

  test('a probe cannot signal another process', async () => {
    // A process the probe may not end: the user's, standing in for the app.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    try {
      passed(run('signal', `
        const tried = (f) => { try { f(); return 'allowed'; } catch (e) { return String(e.message); } };
        rr.expect('kill-refused', /may not signal/.test(tried(() => process.kill(${victim.pid}, 'SIGTERM'))));
        rr.expect('probe-of-parent-refused', /may not signal/.test(tried(() => process.kill(process.ppid, 0))));
        rr.expect('raw-kill-refused', /may not signal/.test(tried(() => process._kill(${victim.pid}, 15))));
        rr.expect('cannot-restore', tried(() => { process.kill = () => {}; }) !== 'allowed'
          && tried(() => Object.defineProperty(process, 'kill', { value: () => {} })) !== 'allowed'
          && /may not signal/.test(tried(() => process.kill(${victim.pid}))));
      `));
      assert.equal(victim.exitCode, null);
      assert.equal(victim.signalCode, null);
    } finally {
      victim.kill();
    }
  });

  test('a probe can write only its scratch folder, not outside it', () => {
    // The child's cwd is the run folder's scratch folder.
    passed(run('write', `
      const code = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code; } };
      rr.expect('repo-write-denied', code(() => fs.writeFileSync(path.join(process.cwd(), '..', '..', '..', '..', 'escaped.txt'), 'x')) === 'ERR_ACCESS_DENIED');
      rr.expect('tmp-write-denied', code(() => fs.writeFileSync(path.join(os.tmpdir(), 'stillhunter-escaped.txt'), 'x')) === 'ERR_ACCESS_DENIED');
      rr.expect('scratch-writable', code(() => fs.writeFileSync(path.join(process.cwd(), 'inside.txt'), 'x')) === 'allowed');
    `));
    assert.ok(!existsSync(path.join(dir, 'escaped.txt')));
    assert.ok(existsSync(path.join(dir, '.stillhunter', 'runs', runId, 'scratch', 'inside.txt')));
  });

  test('a probe cannot write the runner state it would otherwise be trusted to hold', () => {
    const run2 = () => path.join(dir, '.stillhunter', 'runs', runId);
    const before = existsSync(path.join(run2(), 'context.json')) && readFileSync(path.join(run2(), 'context.json'), 'utf8');
    passed(run('tamper', `
      const run = path.join(process.cwd(), '..');
      const code = (f) => { try { f(); return 'allowed'; } catch (e) { return e.code; } };
      rr.expect('context-write-denied', code(() => fs.writeFileSync(path.join(run, 'context.json'), '{}')) === 'ERR_ACCESS_DENIED');
      rr.expect('findings-write-denied', code(() => fs.writeFileSync(path.join(run, 'findings.json'), '{}')) === 'ERR_ACCESS_DENIED');
      rr.expect('finish-state-write-denied', code(() => fs.writeFileSync(path.join(run, 'finish-state.json'), '{}')) === 'ERR_ACCESS_DENIED');
      rr.expect('sibling-result-write-denied', code(() => fs.writeFileSync(path.join(run, 'probes', 'other.result.json'), '{}')) === 'ERR_ACCESS_DENIED');
      rr.expect('context-still-readable', code(() => fs.readFileSync(path.join(run, 'context.json'))) === 'allowed');
    `));
    // The runner's own context file is unchanged by the probe.
    assert.equal(before && readFileSync(path.join(run2(), 'context.json'), 'utf8'), before);
  });

  test('a probe cannot open a second, unguarded context or browser', () => {
    passed(run('context', `
      const browser = rr.page.context().browser();
      const refused = async (f) => { try { await f(); return 'allowed'; } catch (e) { return /not available in a probe/.test(e.message) ? 'refused' : e.message; } };
      rr.expect('new-context-refused', (await refused(() => browser.newContext())) === 'refused');
      rr.expect('new-page-refused', (await refused(() => browser.newPage())) === 'refused');
      rr.expect('browser-cdp-refused', (await refused(() => browser.newBrowserCDPSession())) === 'refused');
      rr.expect('context-cdp-refused', (await refused(() => rr.page.context().newCDPSession(rr.page))) === 'refused');
      const extra = await rr.newPage();
      rr.expect('page-cdp-refused', (await refused(() => rr.page.context().newCDPSession(extra))) === 'refused');
      rr.expect('prototype-refused', (await refused(() => Object.getPrototypeOf(browser).newContext.call(browser))) === 'refused');
      rr.expect('launch-refused', (await refused(() => browser.browserType().launch())) === 'refused');
      rr.expect('connect-refused', (await refused(() => browser.browserType().connect('ws://127.0.0.1:1/'))) === 'refused');
      const p = await rr.newPage({ width: 375, height: 700, timezoneId: 'Pacific/Auckland', locale: 'fr-FR' });
      await rr.goto('/login', p);
      const zone = await p.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      rr.expect('factory-applies-options', zone === 'Pacific/Auckland' && (await p.evaluate(() => navigator.language)) === 'fr-FR', zone);
      const blocked = await p.evaluate(() => fetch('http://192.0.2.1/').then(() => 'reached', () => 'blocked'));
      rr.expect('factory-context-loopback-only', blocked === 'blocked', blocked);
      // Routes do not see WebSockets; the browser's proxy stops this one at once
      // instead of letting it try the (unroutable) documentation address.
      const socket = await p.evaluate(() => new Promise((resolve) => {
        const started = Date.now();
        const ws = new WebSocket('ws://192.0.2.1/');
        ws.onopen = () => resolve('open');
        ws.onclose = () => resolve(Date.now() - started < 3000 ? 'refused' : 'slow');
        setTimeout(() => resolve('hung'), 5000);
      }));
      rr.expect('socket-refused-by-proxy', socket === 'refused', socket);
    `));
  });

  // Playwright's raw channel reaches the browser server without the guarded
  // factory: each of these got out before the host relayed and checked the
  // protocol. Only a length or a yes/no is recorded, never what was read.
  test('a probe cannot get around the guards through Playwright\'s raw protocol', () => {
    const file = JSON.stringify(pathToFileURL(decoy).href);
    const result = run('raw', `
      const browser = rr.page.context().browser();
      const refused = async (f) => { try { return { got: await f() }; } catch (e) { return { refused: /refused by the browser relay/.test(e.message), message: e.message.split('\\n')[0].slice(0, 200) }; } };
      const read = (text) => (typeof text === 'string' && text.length === ${DECOY_TEXT.length} ? 'read' : 'not read');

      const browserCdp = await refused(async () => {
        const session = (await browser._channel.newBrowserCDPSession()).session._object;
        const { targetId } = await session.send('Target.createTarget', { url: ${file} });
        return targetId ? 'opened a file: target' : 'no target';
      });
      rr.expect('browser-cdp-refused', browserCdp.refused === true, browserCdp);

      const contextCdp = await refused(async () => {
        const session = (await rr.context._channel.newCDPSession({ page: rr.page._channel })).session._object;
        const { targetId } = await session.send('Target.createTarget', { url: ${file} });
        return targetId ? 'opened a file: target' : 'no target';
      });
      rr.expect('context-cdp-refused', contextCdp.refused === true, contextCdp);

      const proxied = await refused(async () => {
        const context = (await browser._channel.newContext({ baseURL: rr.web, proxy: { server: 'http://127.0.0.1:${proxy.port}' }, selectorEngines: [] })).context._object;
        const p = await context.newPage();
        await p.goto('http://stillhunter-escape.test/', { timeout: 5000 });
        return (await p.textContent('body')) === 'proxied' ? 'reached a non-loopback host' : 'not reached';
      });
      rr.expect('own-proxy-refused', proxied.refused === true, proxied);

      const fileGoto = await refused(async () => { await rr.page.goto(${file}); return read(await rr.page.textContent('body')); });
      rr.expect('file-goto-refused', fileGoto.refused === true, fileGoto);
      const rawFileGoto = await refused(async () => { await rr.page.mainFrame()._channel.goto({ url: ${file} }); return read(await rr.page.textContent('body')); });
      rr.expect('raw-file-goto-refused', rawFileGoto.refused === true, rawFileGoto);
      const remoteGoto = await refused(() => rr.page.goto('http://192.0.2.1/', { timeout: 5000 }));
      rr.expect('remote-goto-refused', remoteGoto.refused === true, remoteGoto);

      const form = await rr.newPage();
      await form.setContent('<input type="file">');
      const upload = await refused(async () => {
        await form.mainFrame()._channel.setInputFiles({ selector: 'input', localPaths: [${JSON.stringify(decoy)}], timeout: 5000 });
        return read(await form.evaluate(() => document.querySelector('input').files[0]?.text()));
      });
      rr.expect('host-file-upload-refused', upload.refused === true, upload);

      const hostFetch = await refused(() => rr.context.request.get('http://192.0.2.1/', { timeout: 3000, maxRedirects: 0 }));
      rr.expect('host-fetch-refused', hostFetch.refused === true, hostFetch);

      const launch = await refused(async () => { await browser._parent._channel.launch({}); return 'launched an unguarded browser'; });
      rr.expect('raw-launch-refused', launch.refused === true, launch);

      // A context opened through the raw channel has no loopback route and no
      // watchers (the relay cannot tell it from the factory's own), so the
      // browser-wide closed proxy and the relay are what hold it.
      const bare = (await browser._channel.newContext({ baseURL: rr.web, selectorEngines: [] })).context._object;
      const bp = await bare.newPage();
      await bp.goto('/login');
      rr.expect('bare-context-opens', new URL(bp.url()).pathname === '/login', bp.url());
      const bareFetch = await bp.evaluate(() => Promise.all(['http://192.0.2.1/', 'http://stillhunter-escape.test/'].map((u) => fetch(u).then((r) => r.text(), () => 'blocked'))));
      rr.expect('bare-context-fetch-blocked', bareFetch.every((x) => x === 'blocked'), bareFetch);
      const bareGoto = await refused(() => bp.goto('http://192.0.2.1/', { timeout: 5000 }));
      rr.expect('bare-context-remote-goto-refused', bareGoto.refused === true, bareGoto);
      const bareFile = await refused(() => bp.goto(${file}));
      rr.expect('bare-context-file-goto-refused', bareFile.refused === true, bareFile);
      // A page's own script cannot leave http for file: either.
      await bp.evaluate((u) => { location.href = u; }, ${file}).catch(() => {});
      await rr.sleep(1000);
      rr.expect('bare-context-script-stays-http', new URL(bp.url()).protocol === 'http:', bp.url().slice(0, 40));
      rr.expect('bare-context-file-not-read', read(await bp.textContent('body').catch(() => null)) === 'not read');
      // Restoring a storage state opens a page at each origin it lists.
      const origins = await refused(() => browser._channel.newContext({ baseURL: rr.web, selectorEngines: [], storageState: { cookies: [], origins: [{ origin: ${file}, localStorage: [] }] } }));
      rr.expect('file-origin-storage-refused', origins.refused === true, origins);
      const setOrigins = await refused(() => rr.context._channel.setStorageState({ storageState: { cookies: [], origins: [{ origin: 'http://192.0.2.1', localStorage: [] }] } }));
      rr.expect('remote-origin-storage-refused', setOrigins.refused === true, setOrigins);
      await bare.close();

      // The guarded factory and the probe API still work after all of that.
      await rr.goto('/login');
      rr.expect('factory-still-works', (await rr.observe()).headings.includes('Sign in'));
    `);
    passed(result);
    assert.doesNotMatch(JSON.stringify(result), /decoy outside the run folder/);
  });

  test('a stray rejected promise does not lose the checks already recorded', () => {
    const r = probe(dir, runId, 'stray', `export default async function (rr) {
      rr.expect('recorded-before-stray', false, 'this must survive the stray rejection');
      rr.page.locator('#does-not-exist').click({ timeout: 500 });
      await rr.sleep(1500);
      rr.expect('recorded-after-stray', false, 'this too');
    }`);
    assert.ok(r.result, r.stdout + r.stderr);
    assert.deepEqual(r.result.checks.map((c) => c.name), ['recorded-before-stray', 'recorded-after-stray'], JSON.stringify(r.result));
    assert.match(String(r.result.error), /unhandled rejection|Timeout/i);
  });

  // The child reads the saved session and sign-in variables, so a probe can
  // print them; what the runner keeps and shows never holds their raw values.
  test('a probe that prints the saved session or a sign-in value leaves no raw value in its result', () => {
    const signedIn = probe(dir, runId, 'signin', SIGNIN_PROBE);
    assert.equal(signedIn.result?.checks?.[0]?.pass, true, signedIn.stdout);
    const session = JSON.parse(readFileSync(path.join(dir, '.stillhunter', 'runs', runId, 'scratch', 'session.json'), 'utf8'));
    const values = session.cookies.map((c) => c.value).filter((v) => v.length >= 8);
    assert.ok(values.length > 0, 'the fixture app sets a session cookie');
    const r = probe(dir, runId, 'leak', `import fs from 'node:fs';
      import path from 'node:path';
      export default async function (rr) {
        const text = fs.readFileSync(path.join(process.cwd(), 'session.json'), 'utf8');
        rr.expect('session-readable', text.length > 0, String(text.length));
        console.log(text);
        console.log(process.env.SHFIX_PASSWORD);
        console.log(process.env.SHFIX_SHORT, process.env.CUSTOM_TOKEN);
        rr.note('session', text);
        rr.note('password', process.env.SHFIX_PASSWORD);
        rr.note('short', process.env.SHFIX_SHORT);
        rr.note('custom', process.env.CUSTOM_TOKEN);
        rr.note('object', { [process.env.CUSTOM_TOKEN]: { [process.env.SHFIX_SHORT]: 'nested' } });
        rr.note('cookies', await rr.context.cookies());
        rr.expect('leak-in-detail', false, text + ' ' + process.env.SHFIX_PASSWORD);
        await rr.goto('/');
        rr.note('page-cookie', await rr.page.evaluate(() => document.cookie));
      }`);
    assert.ok(r.result, r.stdout + r.stderr);
    assert.equal(r.result.checks[0].pass, true, 'a probe can read the session it starts from');
    const kept = readFileSync(path.join(dir, '.stillhunter', 'runs', runId, 'probes', 'leak.result.json'), 'utf8');
    for (const shown of [r.stdout, kept]) {
      assert.equal(values.filter((v) => shown.includes(v)).length, 0, 'no session value is shown or kept');
      assert.ok(!shown.includes(SIGN_IN.SHFIX_PASSWORD), 'no raw sign-in value is shown or kept');
      assert.ok(!shown.includes(CONFIGURED.CUSTOM_TOKEN), 'no custom credential is shown or kept');
      assert.ok(shown.includes('[session value]'));
    }
    assert.equal(r.result.notes.find((n) => n.label === 'short').value, '[session value]');
    assert.equal(r.result.notes.find((n) => n.label === 'custom').value, '[session value]');
    assert.deepEqual(r.result.notes.find((n) => n.label === 'object').value, { '[session value]': { '[session value]': 'nested' } });
  });

  test('a probe sees only PATH and the sign-in variables start named', () => {
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process it starts, and
    // Node on Linux sets UV_USE_IO_URING=0 in its own environment at startup
    // (it does so even under `env -i`), so neither comes from the runner. On
    // Windows, libuv copies the variables Windows needs to start a process into
    // every child it spawns, from the parent's environment, when they are missing.
    const result = run('env', `
      const WINDOWS = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'TEMP', 'USERDOMAIN', 'USERPROFILE', 'WINDIR'];
      const keys = Object.keys(process.env).map((k) => k.toUpperCase());
      rr.note('keys', keys);
      rr.expect('no-decoy', !keys.includes('SHFIX_SECRET_TOKEN'));
      rr.expect('no-home', !keys.includes('HOME'));
      rr.expect('sign-in-present', typeof process.env.SHFIX_PASSWORD === 'string');
      rr.expect('configured-present', process.env.SHFIX_SHORT === ${JSON.stringify(CONFIGURED.SHFIX_SHORT)} && process.env.CUSTOM_TOKEN === ${JSON.stringify(CONFIGURED.CUSTOM_TOKEN)});
      rr.expect('only-allowed', keys.every((k) => k === 'PATH' || k === 'SYSTEMROOT' || (process.platform === 'win32' && WINDOWS.includes(k)) || k === '__CF_USER_TEXT_ENCODING' || (k === 'UV_USE_IO_URING' && process.env[k] === '0') || ['CUSTOM_TOKEN', 'SHFIX_EMAIL', 'SHFIX_PASSWORD', 'SHFIX_SHORT'].includes(k)), keys);
    `);
    passed(result);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(DECOY.SHFIX_SECRET_TOKEN));
  });
});
