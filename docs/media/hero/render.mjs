// Renders a scene folder frame by frame in headless Chromium.
//
// Scene contract (scene.html in the scene folder):
//   window.DURATION            loop length in seconds
//   await window.setup({ width, height, theme })   theme is 'dark' or 'light'
//   await window.renderAt(t)   draws the frame at time t (seconds, 0 <= t < DURATION);
//                              must be deterministic: no Date.now, no Math.random
//                              without a seed, no requestAnimationFrame timing.
// The import map in scene.html can use /node_modules/three/... (served from this folder).
//
// Usage:
//   node render.mjs <sceneDir> --theme dark|light [--fps 24] [--width 1280] [--height 640]
//                   [--out <dir>] [--at 0,2.5,5] [--sheet sheet.png] [--webp out.webp] [--q 78]
//   --at renders only those times (seconds) and, with --sheet, tiles them into one image.
//   Without --at, renders the whole loop; --webp encodes it as a looping animated WebP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sceneDir = path.resolve(args[0]);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const theme = opt('theme', 'dark');
const fps = Number(opt('fps', 24));
const width = Number(opt('width', 1280));
const height = Number(opt('height', 640));
const out = path.resolve(opt('out', path.join(sceneDir, `frames-${theme}`)));
const at = opt('at');
const sheet = opt('sheet');
const webp = opt('webp');
const q = opt('q', '78');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = url.startsWith('/node_modules/') ? path.join(ROOT, url) : path.join(sceneDir, url === '/' ? 'scene.html' : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof window.setup === 'function' && typeof window.renderAt === 'function', null, { timeout: 20000 });
  await page.evaluate(async (o) => { await window.setup(o); }, { width, height, theme });
  await page.evaluate(() => document.fonts?.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const times = at ? at.split(',').map(Number) : Array.from({ length: Math.round(duration * fps) }, (_, i) => i / fps);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const started = performance.now();
  for (const [i, t] of times.entries()) {
    await page.evaluate(async (t) => { await window.renderAt(t); }, t);
    const file = path.join(out, `f${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: file, type: 'png' });
    files.push(file);
  }
  const ms = performance.now() - started;
  console.log(`rendered ${files.length} frames (${theme}, ${width}x${height}) in ${(ms / 1000).toFixed(1)}s -> ${out}`);
  if (sheet && files.length) {
    const cols = Math.min(files.length, Number(opt('cols', 3)));
    const rows = Math.ceil(files.length / cols);
    const inputs = files.flatMap((f) => ['-i', f]);
    const scale = files.map((_, i) => `[${i}:v]scale=${Math.round(width / 2)}:-1[s${i}]`).join(';');
    const layout = files.map((_, i) => `${(i % cols) * Math.round(width / 2)}_${Math.floor(i / cols) * Math.round(height / 2)}`).join('|');
    const stack = `${scale};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=gray`;
    const r = files.length === 1
      ? spawnSync('cp', [files[0], sheet])
      : spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', stack, path.resolve(sheet)], { encoding: 'utf8' });
    if (r.status !== 0) console.error(r.stderr);
    else console.log(`sheet ${path.resolve(sheet)} (${cols}x${rows}, times ${times.join(', ')})`);
  }
  if (webp && !at) {
    const frameMs = String(Math.round(1000 / fps));
    const r = spawnSync('img2webp', ['-loop', '0', '-lossy', '-q', q, '-m', '6', '-d', frameMs, ...files, '-o', path.resolve(webp)], { encoding: 'utf8' });
    if (r.status !== 0) console.error(r.stderr);
    else console.log(`webp ${path.resolve(webp)} ${(fs.statSync(webp).size / 1048576).toFixed(2)} MB`);
  }
} finally {
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close();
  server.close();
}
