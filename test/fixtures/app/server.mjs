// A small app with known defects, for the runner's integration tests:
// - at 375 px the summary bar runs past the right edge of the screen;
// - when loading the list fails, the page says the list is empty;
// - GET /api/coin answers ok on every second call, so a check on it is flaky.
// POST /__reset puts the data back and signs everyone out, and GET /__resets
// says how many times it ran; POST /__fix removes the empty-list defect.
// Sign-in uses SHFIX_EMAIL and SHFIX_PASSWORD.
//   node server.mjs   (prints "listening <port>")
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const EMAIL = process.env.SHFIX_EMAIL ?? 'tester@example.com';
const PASSWORD = process.env.SHFIX_PASSWORD ?? 'fixture-password';
const START_ITEMS = [{ id: 1, name: 'First item' }, { id: 2, name: 'Second item' }];

let items = structuredClone(START_ITEMS);
let sessions = new Set();
let coinCalls = 0;
let resets = 0;
let fixed = false;

const LOGIN = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>
<h1>Sign in</h1>
<form id="f"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>
<p id="msg" role="alert"></p>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  if (r.ok) location.href = '/'; else document.getElementById('msg').textContent = 'Wrong email or password';
});
</script>`;

const home = () => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Items</title>
<style>
  body { font: 16px sans-serif; margin: 0; padding: 8px; }
  .summary { display: flex; gap: 12px; min-width: 600px; background: #eef; }
</style>
<h1>Items</h1>
<div class="summary"><span>Total items</span><span id="count">-</span><span>Last change today</span></div>
<ul id="list"></ul>
<p id="state"></p>
<script>
const FIXED = ${fixed};
async function load() {
  const state = document.getElementById('state');
  try {
    const r = await fetch('/api/items');
    if (!r.ok) throw new Error('status ' + r.status);
    const list = await r.json();
    document.getElementById('count').textContent = String(list.length);
    document.getElementById('list').innerHTML = list.map((i) => '<li>' + i.name.replace(/</g, '&lt;') + '</li>').join('');
    state.textContent = list.length ? '' : 'No items yet';
  } catch (e) {
    if (FIXED) { state.setAttribute('role', 'alert'); state.textContent = 'Could not load the items. Try again.'; }
    else state.textContent = 'No items yet';
  }
}
load();
</script>`;

function cookie(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

function body(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); } catch { resolve(null); }
    });
  });
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const signedIn = sessions.has(cookie(req));
  if (req.method === 'POST' && url.pathname === '/__reset') {
    items = structuredClone(START_ITEMS);
    sessions = new Set();
    resets += 1;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__resets') return json(res, 200, { resets });
  if (req.method === 'POST' && url.pathname === '/__fix') {
    fixed = true;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(LOGIN);
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const b = await body(req);
    if (!b || b.email !== EMAIL || b.password !== PASSWORD) return json(res, 401, { detail: 'Wrong email or password' });
    const sid = randomBytes(16).toString('hex');
    sessions.add(sid);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/api/echo') {
    let raw = '';
    for await (const c of req) raw += c;
    return json(res, 200, { raw, contentType: req.headers['content-type'] ?? null, test: req.headers['x-test'] ?? null });
  }
  if (url.pathname === '/api/coin') {
    coinCalls += 1;
    return json(res, 200, { ok: coinCalls % 2 === 0, call: coinCalls });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!signedIn) return json(res, 401, { detail: 'Sign in first' });
    if (url.pathname === '/api/items' && req.method === 'GET') return json(res, 200, items);
    return json(res, 404, { detail: 'Not found' });
  }
  if (url.pathname === '/') {
    if (!signedIn) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(home());
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
