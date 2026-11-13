// Shared by the tests that drive the runner against the fixture app.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseBrowser, installedOnThisMachine } from '../dist/browser.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HUNT = path.join(ROOT, 'dist', 'hunt.mjs');
const SERVER = path.join(ROOT, 'test', 'fixtures', 'app', 'server.mjs');

export const SIGN_IN = { SHFIX_EMAIL: 'tester@example.com', SHFIX_PASSWORD: 'fixture-password-77' };
export const DECOY = { SHFIX_SECRET_TOKEN: 'not-for-probes-1234' };

export const browserChoice = chooseBrowser(null, installedOnThisMachine());
export const noBrowser = browserChoice.ok ? false : `no browser installed: ${browserChoice.message}`;

export function hunt(args, { cwd, input, env } = {}) {
  return spawnSync(process.execPath, [HUNT, ...args], {
    cwd, input, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...SIGN_IN, ...DECOY, ...env },
  });
}

// One request on its own connection: a kept-alive one that the app closed
// while a long runner call ran would fail the next call with ECONNRESET.
function call(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, method, agent: false }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve(text));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function startFixture() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...SIGN_IN }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (d) => {
      text += d;
      const m = /listening (\d+)/.exec(text);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`fixture app exited ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    post: (p) => call(port, 'POST', p),
    // How many times the configured reset has run against the app.
    resets: async () => JSON.parse(await call(port, 'GET', '/__resets')).resets,
    stop: () => child.kill(),
  };
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A repository whose base commit is "the app" and whose working tree holds a
// change: one edited file and one new file.
export function makeRepo(app, { change = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-int-')));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'web', 'items.js'), 'export const title = "Items";\n');
  writeFileSync(path.join(dir, 'reset.mjs'), `await fetch(${JSON.stringify(`${app.url}/__reset`)}, { method: 'POST' });\n`);
  mkdirSync(path.join(dir, '.stillhunter', 'specs'), { recursive: true });
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node reset.mjs' }, null, 2));
  writeFileSync(path.join(dir, '.stillhunter', '.gitignore'), '/.env\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(path.join(dir, '.stillhunter', 'specs', 'request.txt'), 'Show a summary bar above the list of items.\n');
  if (change) {
    writeFileSync(path.join(dir, 'web', 'items.js'), 'export const title = "Items";\nexport const summary = true;\n');
    writeFileSync(path.join(dir, 'web', 'summary.css'), '.summary { display: flex; min-width: 600px; }\n');
  }
  return dir;
}

export const runIdOf = (stdout) => /stillhunter \| run (\d{8}-\d{6}-hunt-[a-z0-9]{4})/.exec(stdout)?.[1];

export function probe(dir, runId, name, script) {
  const r = hunt(['probe', '--run', runId, '--name', name], { cwd: dir, input: script });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  return { ...r, result: parsed };
}

export const SIGNIN_PROBE = `export default async function (rr) {
  await rr.goto('/login');
  await rr.page.getByLabel('Email').fill(process.env.SHFIX_EMAIL);
  await rr.page.getByLabel('Password').fill(process.env.SHFIX_PASSWORD);
  await rr.page.getByRole('button', { name: 'Sign in' }).click();
  await rr.page.waitForURL((u) => u.pathname === '/');
  await rr.ready();
  await rr.saveSession();
  rr.expect('signed-in', new URL(rr.page.url()).pathname === '/', rr.page.url());
}
`;
