import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverage, endpointOf, foldPath } from '../dist/coverage.mjs';

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
