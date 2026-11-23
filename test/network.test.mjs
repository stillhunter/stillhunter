// The hosts a probe may reach besides loopback: which patterns the config may
// list, what they match, what the relay lets through for each, and the
// browser's proxy, which opens HTTPS tunnels only to listed hosts and closes
// the sign-in ones for good once the sign-in saves its session.
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { test } from 'node:test';
import { allowedTunnel, allowedUrl, hostMatches, keptOrigins, networkLine, patternProblem } from '../dist/hosts.mjs';
import { gatedProxy } from '../dist/probe-host.mjs';
import { refusal } from '../dist/relay.mjs';

const target = 'http://127.0.0.1:3000';
const policy = { allow: ['api.staging.example.com', '*.cdn.example.net'], signIn: ['*.auth0.com', 'accounts.example.org'] };

test('a host pattern is a host name or a wildcard for its subdomains, nothing more', () => {
  for (const p of ['api.example.com', '*.example.com', 'API.Example.COM', '10.0.0.5', 'a-b.example.co.uk']) assert.equal(patternProblem(p), null, p);
  for (const p of ['*', '*.com', 'com', '', 42, 'https://api.example.com', 'api.example.com:8443', 'api.example.com/v1', 'user@api.example.com',
    'localhost', 'app.localhost', '*.localhost', '-bad.example.com', 'exa mple.com', 'example..com', '*example.com']) {
    assert.notEqual(patternProblem(p), null, String(p));
  }
});

test('a wildcard matches subdomains only, and nothing matches by suffix alone', () => {
  assert.ok(hostMatches('api.staging.example.com', policy.allow));
  assert.ok(hostMatches('API.STAGING.EXAMPLE.COM.', policy.allow), 'case and a trailing dot');
  assert.ok(hostMatches('img.cdn.example.net', policy.allow));
  assert.ok(hostMatches('a.b.cdn.example.net', policy.allow));
  for (const h of ['cdn.example.net', 'evilcdn.example.net', 'staging.example.com', 'api.staging.example.com.evil.net', 'xapi.staging.example.com']) {
    assert.ok(!hostMatches(h, policy.allow), h);
  }
});

test('listed hosts are reached over https only, sign-in hosts only while the sign-in is open', () => {
  assert.ok(allowedUrl('http://localhost:5173/x', policy));
  assert.ok(allowedUrl('https://api.staging.example.com/v1/items', policy));
  assert.ok(!allowedUrl('http://api.staging.example.com/v1/items', policy), 'plain http to a listed host');
  assert.ok(!allowedUrl('https://user:pw@api.staging.example.com/', policy), 'credentials in the URL');
  assert.ok(!allowedUrl('wss://api.staging.example.com/', policy));
  assert.ok(allowedUrl('https://tenant.auth0.com/authorize', policy));
  assert.ok(!allowedUrl('https://tenant.auth0.com/authorize', policy, { signIn: false }));
  assert.ok(!allowedUrl('https://example.org/', policy));
  assert.ok(allowedTunnel('api.staging.example.com', policy));
  assert.ok(allowedTunnel('tenant.auth0.com', policy));
  assert.ok(!allowedTunnel('localhost', { allow: ['localhost'], signIn: [] }));
  assert.ok(!allowedTunnel('example.org', policy));
});

test('start says what the browser can reach', () => {
  assert.equal(networkLine([], []), 'network: loopback only');
  assert.equal(networkLine(['api.staging.example.com'], ['*.auth0.com']),
    'network: loopback, plus https to api.staging.example.com for every probe, plus https to *.auth0.com for the sign-in probe until it calls rr.saveSession()');
});

const ask = (type, method, params, scope) => refusal(type, { id: 'a@1', guid: 'x', method, params }, target, scope);

test('the relay lets probes reach the listed hosts, and the sign-in hosts only while open', () => {
  const open = { policy, signInOpen: true };
  const closed = { policy, signInOpen: false };
  assert.equal(ask('Frame', 'goto', { url: 'https://api.staging.example.com/' }, closed), null);
  assert.match(String(ask('Frame', 'goto', { url: 'http://api.staging.example.com/' }, closed)), /not an http or https URL on a loopback host, or an https URL/);
  assert.equal(ask('Frame', 'goto', { url: 'https://tenant.auth0.com/login' }, open), null);
  assert.match(String(ask('Frame', 'goto', { url: 'https://tenant.auth0.com/login' }, closed)), /tenant\.auth0\.com/);
  // With no policy, exactly as before: loopback only.
  assert.match(String(ask('Frame', 'goto', { url: 'https://api.staging.example.com/' })), /is not an http or https URL on a loopback host$/);
  // A context's base URL stays the loopback target.
  assert.match(String(ask('Browser', 'newContext', { baseURL: 'https://api.staging.example.com' }, open)), /loopback http or https baseURL/);
  // The browser server's own requests reach the allow hosts, never the sign-in ones.
  assert.equal(ask('APIRequestContext', 'fetch', { url: 'https://api.staging.example.com/x', maxRedirects: 0 }, open), null);
  assert.match(String(ask('APIRequestContext', 'fetch', { url: 'https://tenant.auth0.com/x', maxRedirects: 0 }, open)), /tenant\.auth0\.com/);
  // A storage state may restore allow-host origins, never sign-in ones.
  const state = (origin) => ({ cookies: [], origins: [{ origin, localStorage: [] }] });
  assert.equal(ask('BrowserContext', 'setStorageState', { storageState: state('https://api.staging.example.com') }, open), null);
  assert.match(String(ask('BrowserContext', 'setStorageState', { storageState: state('https://tenant.auth0.com') }, open)), /storage state may hold only/);
});

test('a saved session keeps loopback and allow-host origins, and drops sign-in ones', () => {
  const state = {
    cookies: [{ name: 'sid', value: 'x', domain: 'tenant.auth0.com' }],
    origins: [{ origin: 'http://localhost:5173' }, { origin: 'https://api.staging.example.com' }, { origin: 'https://tenant.auth0.com' }, { origin: 'chrome://x' }],
  };
  assert.deepEqual(keptOrigins(state, policy), { cookies: state.cookies, origins: [{ origin: 'http://localhost:5173' }, { origin: 'https://api.staging.example.com' }] });
});

// A stand-in for a remote host: an echo server the proxy's dial is pointed at.
async function echoServer() {
  const server = createServer((s) => { s.on('error', () => {}); s.pipe(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

// Sends one request head to the proxy and returns what came back before it closed.
function talk(port, head, then = null) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    let got = '';
    let sent = false;
    s.on('data', (d) => {
      got += d;
      if (then && !sent && got.includes('\r\n\r\n')) { sent = true; s.write(then); }
      if (then && got.endsWith(then)) s.end();
    });
    s.on('close', () => resolve(got));
    s.on('error', () => {});
    s.write(head);
  });
}

test('the proxy tunnels only to listed hosts and drops everything else', async (t) => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const dialed = [];
  const proxy = await gatedProxy(policy, (host, port) => { dialed.push(`${host}:${port}`); return connect({ host: '127.0.0.1', port: echo.port }); });
  t.after(() => proxy.server.close());
  // A TLS record starts with 0x16; the echo stands in for the remote end.
  const hello = '\x16\x03\x01hello';
  const ok = await talk(proxy.port, 'CONNECT api.staging.example.com:443 HTTP/1.1\r\nHost: api.staging.example.com:443\r\n\r\n', hello);
  assert.equal(ok, `HTTP/1.1 200 Connection Established\r\n\r\n${hello}`);
  // Anything else in the tunnel, such as a plain ws:// upgrade, is cut before it reaches the host.
  const plain = await talk(proxy.port, 'CONNECT api.staging.example.com:80 HTTP/1.1\r\n\r\n', 'GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n');
  assert.equal(plain, 'HTTP/1.1 200 Connection Established\r\n\r\n');
  for (const head of ['CONNECT example.org:443 HTTP/1.1\r\n\r\n', 'CONNECT 127.0.0.1:22 HTTP/1.1\r\n\r\n', 'CONNECT localhost:8000 HTTP/1.1\r\n\r\n',
    'GET http://api.staging.example.com/ HTTP/1.1\r\nHost: api.staging.example.com\r\n\r\n', 'CONNECT api.staging.example.com:99999 HTTP/1.1\r\n\r\n', 'garbage\r\n\r\n']) {
    assert.equal(await talk(proxy.port, head), '', head);
  }
  assert.deepEqual(dialed, ['api.staging.example.com:443', 'api.staging.example.com:80'], 'nothing else was dialed');
  assert.ok(proxy.refused.includes('example.org:443'));
});

test('an allowed host that cannot be reached gets a 502, so the browser says the tunnel failed', async (t) => {
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const proxy = await gatedProxy(policy, () => connect({ host: '127.0.0.1', port }));
  t.after(() => proxy.server.close());
  assert.match(await talk(proxy.port, 'CONNECT api.staging.example.com:443 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 502 Bad Gateway\r\n/);
});

test('once the sign-in saves its session, the proxy cuts its open sign-in tunnels and opens no new one', async (t) => {
  const echo = await echoServer();
  t.after(() => echo.server.close());
  const proxy = await gatedProxy(policy, () => connect({ host: '127.0.0.1', port: echo.port }));
  t.after(() => proxy.server.close());
  // An open tunnel to a sign-in host, and one to an allow host.
  const open = (host) => new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: proxy.port });
    s.on('error', () => {});
    s.once('data', () => resolve(s));
    s.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
  });
  const signInTunnel = await open('tenant.auth0.com');
  const apiTunnel = await open('api.staging.example.com');
  const signInClosed = new Promise((r) => signInTunnel.on('close', r));
  proxy.closeSignIn();
  await signInClosed;
  assert.ok(!apiTunnel.destroyed, 'the allow-host tunnel stays open');
  apiTunnel.destroy();
  assert.equal(await talk(proxy.port, 'CONNECT tenant.auth0.com:443 HTTP/1.1\r\n\r\n'), '');
});
