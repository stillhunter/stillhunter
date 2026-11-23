// Finding a Vite or Next dev server that belongs to this repository. Each
// candidate folder gets a marker file for a moment, and a server counts only
// if it serves that marker's bytes: another app on the port, or another
// checkout of the same app, does not. The servers here stand in for Vite
// (/@fs/<absolute path>) and Next (/_next/static/ from .next/static).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { devCandidates, devServerUrl, fsUrlPath } from '../dist/target.mjs';

function repo(t, apps) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-dev-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.next/\n');
  for (const [dir, deps, extra = []] of apps) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ devDependencies: deps }));
    for (const e of extra) mkdirSync(path.join(root, dir, e), { recursive: true });
  }
  return root;
}

// Serves files the way the stand-in dev server would: Vite from anywhere
// under root at /@fs<path>, Next from <dir>/.next/static at /_next/static/.
async function serve(t, kind, root) {
  const server = createServer((req, res) => {
    const url = decodeURI(new URL(req.url, 'http://x').pathname);
    let file = null;
    if (kind === 'Vite' && url.startsWith('/@fs/')) file = url.slice('/@fs'.length);
    if (kind === 'Next' && url.startsWith('/_next/static/')) file = path.join(root, '.next', 'static', url.slice('/_next/static/'.length));
    if (file && file.startsWith(root) && existsSync(file)) { res.end(readFileSync(file)); return; }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

const markersLeft = (dir) => readdirSync(dir, { recursive: true }).filter((f) => String(f).includes('stillhunter-target-'));

test('Vite and Next candidates are folders whose package.json depends on vite or next, not nuxt', (t) => {
  const root = repo(t, [['web', { vite: '7.0.0' }], ['site', { next: '16.0.0' }], ['nuxt-app', { nuxt: '4.0.0', vite: '7.0.0' }], ['lib', { react: '19.0.0' }]]);
  assert.deepEqual(devCandidates(root).map((c) => [path.relative(root, c.dir), c.kind]), [['site', 'Next'], ['web', 'Vite']]);
});

test('a Vite dev server that serves this folder\'s marker is found, and the marker is removed', async (t) => {
  const root = repo(t, [['web', { vite: '7.0.0' }, ['node_modules']]]);
  const port = await serve(t, 'Vite', path.join(root, 'web'));
  const { found } = await devServerUrl(root, undefined, { Vite: [port], Next: [] });
  assert.deepEqual(found, [{ url: `http://localhost:${port}`, kind: 'Vite', dir: path.join(root, 'web') }]);
  assert.deepEqual(markersLeft(path.join(root, 'web')), []);
});

test('a Vite dev server of another checkout of the same app is not taken for this one', async (t) => {
  const here = repo(t, [['web', { vite: '7.0.0' }, ['node_modules']]]);
  const other = repo(t, [['web', { vite: '7.0.0' }, ['node_modules']]]);
  const port = await serve(t, 'Vite', path.join(other, 'web'));
  assert.deepEqual((await devServerUrl(here, undefined, { Vite: [port], Next: [] })).found, []);
});

test('a Next dev server that serves this folder\'s marker from .next/static is found, and an unrelated server is not', async (t) => {
  const root = repo(t, [['site', { next: '16.0.0' }, ['.next/static']]]);
  const port = await serve(t, 'Next', path.join(root, 'site'));
  const otherRoot = repo(t, [['site', { next: '16.0.0' }, ['.next/static']]]);
  const otherPort = await serve(t, 'Next', path.join(otherRoot, 'site'));
  const { found } = await devServerUrl(root, undefined, { Vite: [], Next: [otherPort, port] });
  assert.deepEqual(found.map((f) => f.url), [`http://localhost:${port}`]);
  assert.deepEqual(markersLeft(path.join(root, 'site')), []);
});

test('the /@fs path keeps the leading slash Vite expects for a Windows drive', () => {
  assert.equal(fsUrlPath('/home/me/app/node_modules/x.txt'), '/@fs/home/me/app/node_modules/x.txt');
  assert.equal(fsUrlPath('C:\\work\\my app\\x.txt'), '/@fs/C:/work/my%20app/x.txt');
});
