import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chooseBrowser } from '../dist/browser.mjs';
import { answers, lockUrlPath, nuxtCandidates } from '../dist/target.mjs';

test('the lock URL path is Vite\'s /@fs form, with a leading slash for Windows drives', () => {
  assert.equal(lockUrlPath('/home/me/app'), '/_nuxt/@fs/home/me/app/.nuxt/nuxt.lock');
  assert.equal(lockUrlPath('C:\\work\\my app'), '/_nuxt/@fs/C:/work/my%20app/.nuxt/nuxt.lock');
});

test('Nuxt candidates are folders git sees whose package.json depends on nuxt', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sh-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  for (const [dir, deps] of [['web', { nuxt: '4.0.0' }], ['other', { vite: '7.0.0' }], ['node_modules/x', { nuxt: '4.0.0' }]]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'nuxt.config.ts'), 'export default {}\n');
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ devDependencies: deps }));
  }
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  assert.deepEqual(nuxtCandidates(root).map((c) => path.relative(root, c.dir)), ['web']);
});

test('answers() is null when nothing listens', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  assert.equal(await answers(`http://127.0.0.1:${port}/`), null);
});

test('a pinned browser that is missing stops the hunt; otherwise Chrome, Edge, Chromium in order', () => {
  const only = (name) => (n) => n === name;
  assert.deepEqual(chooseBrowser(null, only('msedge')), { ok: true, name: 'msedge' });
  assert.deepEqual(chooseBrowser(null, () => true), { ok: true, name: 'chrome' });
  const missing = chooseBrowser('chrome', only('msedge'));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /"browser": "chrome" in \.stillhunter\/config\.json names Google Chrome, which isn't installed/);
  assert.equal(chooseBrowser(null, () => false).ok, false);
});
