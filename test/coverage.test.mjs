import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverage, endpointOf, foldPath, pageOf } from '../dist/coverage.mjs';

const T = 'http://localhost:3000';

test('ids in paths are folded: numbers, UUIDs, long hex and long tokens', () => {
  assert.equal(foldPath('/api/plants/42'), '/api/plants/:id');
  assert.equal(foldPath('/api/u/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f/files/'), '/api/u/:id/files');
  assert.equal(foldPath('/api/blob/a1b2c3d4e5f60718'), '/api/blob/:id');
  assert.equal(foldPath('/api/share/Xk29dkQ01msLp3zzQ8aa'), '/api/share/:id');
  assert.equal(foldPath('/api/v2/summary'), '/api/v2/summary');
  assert.equal(foldPath('/'), '/');
});

test('endpoints are method and folded path; assets and dev-server requests are not endpoints', () => {
  assert.equal(endpointOf('get', 'http://localhost:3000/api/items/7?x=1', T), 'GET /api/items/:id');
  assert.equal(endpointOf('POST', 'http://127.0.0.1:8000/api/items', T), 'POST 127.0.0.1:8000/api/items');
  assert.equal(endpointOf('GET', 'http://localhost:3000/_nuxt/app.vue', T), null);
  assert.equal(endpointOf('GET', 'http://localhost:3000/assets/logo.svg', T), null);
  assert.equal(endpointOf('GET', 'data:text/plain,x', T), null);
});

test('coverage lists endpoints never faulted and pages never seen at 375 px', () => {
  const run = (requests, faults, pages) => ({ requests, faults, pages });
  const c = coverage([
    run(
      [{ method: 'GET', url: `${T}/api/items`, via: 'page' }, { method: 'GET', url: `${T}/api/items/3`, via: 'page' }, { method: 'DELETE', url: `${T}/api/items/9`, via: 'rr.request' }],
      [{ method: 'GET', url: `${T}/api/items`, fault: '500' }],
      [{ id: 1, viewport: { width: 1280, height: 800 }, visited: [{ url: `${T}/items`, width: 1280 }, { url: `${T}/items/3`, width: 1280 }] }],
    ),
    run(
      [{ method: 'GET', url: `${T}/api/items/5`, via: 'page' }],
      [{ method: 'GET', url: `${T}/api/items`, fault: '"malformed"' }, { method: 'GET', url: `${T}/api/items`, fault: '500' }],
      [{ id: 1, viewport: { width: 375, height: 800 }, visited: [{ url: `${T}/items`, width: 375 }, { url: 'https://elsewhere.example/', width: 375 }] }],
    ),
  ], T);
  assert.deepEqual(c.endpoints, [{ endpoint: 'GET /api/items', faults: ['"malformed"', '500'] }, { endpoint: 'GET /api/items/:id', faults: [] }]);
  assert.deepEqual(c.neverFaulted, ['GET /api/items/:id']);
  assert.deepEqual(c.pages, [{ page: '/items', widths: [375, 1280] }, { page: '/items/:id', widths: [1280] }]);
  assert.deepEqual(c.neverNarrow, ['/items/:id']);
  assert.deepEqual(c.viewports, ['375x800', '1280x800']);
});

test('page calls to non-loopback hosts the route blocked are not endpoints', () => {
  const c = coverage([{
    requests: [
      { method: 'GET', url: `${T}/api/items`, via: 'page' },
      { method: 'POST', url: 'https://analytics.example.com/collect', via: 'page', failure: 'net::ERR_BLOCKED_BY_CLIENT' },
      { method: 'GET', url: 'https://www.googletagmanager.com/gtag/js', via: 'page', failure: 'net::ERR_BLOCKED_BY_CLIENT' },
      { method: 'GET', url: 'http://127.0.0.1:8000/api/other', via: 'page' },
    ],
    faults: [],
    pages: [],
  }], T);
  assert.deepEqual(c.endpoints.map((e) => e.endpoint), ['GET /api/items', 'GET 127.0.0.1:8000/api/other']);
  assert.deepEqual(c.neverFaulted, ['GET /api/items', 'GET 127.0.0.1:8000/api/other']);
});

test('an external target keeps same-origin API coverage and faults without counting other hosts or assets', () => {
  const target = 'https://app.example.com';
  const c = coverage([{
    requests: [
      { method: 'GET', url: `${target}/api/items`, via: 'page' },
      { method: 'POST', url: `${target}/api/items`, via: 'page' },
      { method: 'GET', url: `${target}/_nuxt/app.vue`, via: 'page' },
      { method: 'GET', url: `${target}/assets/logo.svg`, via: 'page' },
      { method: 'POST', url: 'https://analytics.example.com/collect', via: 'page' },
    ],
    faults: [{ method: 'GET', url: `${target}/api/items`, fault: '500' }],
    pages: [],
  }], target);
  assert.deepEqual(c.endpoints, [{ endpoint: 'GET /api/items', faults: ['500'] }, { endpoint: 'POST /api/items', faults: [] }]);
  assert.deepEqual(c.neverFaulted, ['POST /api/items']);
});

test('the dev server\'s own requests and pages are not coverage', () => {
  for (const p of ['/__nuxt_dev__/error-overlay/3txzmn1dd2eod', '/__nuxt_devtools__/client', '/_nuxt/pages/index.vue', '/_nuxt/builds/meta/dev.json', '/__vite_ping', '/@vite/client', '/@fs/src/main.ts', '/@id/virtual:x', '/_next/static/chunks/app/page', '/_next/webpack-hmr', '/__nextjs_original-stack-frame', '/__webpack_hmr', '/sockjs-node/info', '/favicon.ico']) {
    assert.equal(endpointOf('GET', `${T}${p}`, T), null, p);
    assert.equal(pageOf(`${T}${p}`, T), null, p);
  }
  // Only a path that starts with one of them: the app's own routes stay, and
  // so do framework paths that carry the app's data.
  assert.equal(endpointOf('GET', `${T}/api/__nuxt`, T), 'GET /api/__nuxt');
  assert.equal(endpointOf('GET', `${T}/nuxt/settings`, T), 'GET /nuxt/settings');
  assert.equal(pageOf(`${T}/next/steps`, T), '/next/steps');
  assert.equal(endpointOf('GET', `${T}/_next/data/abc123/orders/7.json?id=7`, T), 'GET /_next/data/abc123/orders/7.json');
  assert.equal(endpointOf('GET', `${T}/_next/image?url=%2Fa.png&w=640`, T), 'GET /_next/image');
  assert.equal(endpointOf('GET', `${T}/__nuxt_island/OrderCard_abc.json`, T), 'GET /__nuxt_island/OrderCard_abc.json');
  const c = coverage([{
    requests: [{ method: 'GET', url: `${T}/__nuxt_dev__/error-overlay/abc`, via: 'page' }, { method: 'GET', url: `${T}/api/items`, via: 'page' }],
    faults: [],
    pages: [{ id: 1, viewport: { width: 1280, height: 800 }, visited: [{ url: `${T}/items`, width: 1280 }, { url: `${T}/__nuxt_dev__/error-overlay/abc`, width: 1280 }] }],
  }], T);
  assert.deepEqual(c.neverFaulted, ['GET /api/items']);
  assert.deepEqual(c.neverNarrow, ['/items']);
});

test('what a probe saw while it signed in is left out of coverage, and the page it landed on stays', () => {
  // It opened /login, posted the form (the login page also asked who is
  // signed in), landed on / and saved the session there, then went on.
  const signin = {
    probe: 'signin',
    requests: [
      { method: 'GET', url: `${T}/api/auth/me`, via: 'page' }, { method: 'POST', url: `${T}/api/auth/login`, via: 'page' },
      { method: 'GET', url: `${T}/api/dashboard`, via: 'page' }, { method: 'GET', url: `${T}/api/tasks`, via: 'page' },
    ],
    faults: [],
    pages: [{ id: 1, viewport: { width: 1280, height: 800 }, visited: [{ url: `${T}/login`, width: 1280 }, { url: `${T}/`, width: 1280 }, { url: `${T}/tasks`, width: 1280 }] }],
    signInFlow: { requests: 2, pages: [`${T}/login`] },
  };
  const c = coverage([signin], T);
  assert.deepEqual(c.neverFaulted, ['GET /api/dashboard', 'GET /api/tasks']);
  assert.deepEqual(c.neverNarrow, ['/', '/tasks']);
  // What another probe saw counts, the sign-in page and its requests included.
  const login = {
    probe: 'login-errors',
    requests: [{ method: 'POST', url: `${T}/api/auth/login`, via: 'page' }],
    faults: [{ method: 'GET', url: `${T}/api/dashboard`, fault: '500' }],
    pages: [{ id: 1, viewport: { width: 375, height: 800 }, visited: [{ url: `${T}/login`, width: 375 }] }],
  };
  const both = coverage([signin, login], T);
  assert.deepEqual(both.endpoints, [{ endpoint: 'GET /api/dashboard', faults: ['500'] }, { endpoint: 'GET /api/tasks', faults: [] }, { endpoint: 'POST /api/auth/login', faults: [] }]);
  assert.deepEqual(both.pages, [{ page: '/', widths: [1280] }, { page: '/login', widths: [375] }, { page: '/tasks', widths: [1280] }]);
  // A result with no sign-in in it counts whole.
  const { signInFlow, ...plain } = signin;
  assert.ok(signInFlow);
  assert.deepEqual(coverage([plain], T).neverFaulted, ['GET /api/auth/me', 'GET /api/dashboard', 'GET /api/tasks', 'POST /api/auth/login']);
});
