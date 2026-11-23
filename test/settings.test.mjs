// The new settings, end to end against the fixture app in a real browser:
// extra hosts (for every probe, and for the sign-in only until it saves its
// session), sign-in variables named in the config, a reset that runs only
// before re-runs, and start's --url and its message when no app is found.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hunt, makeRepo, noBrowser, probe, runIdOf, startFixture } from './helpers.mjs';

const RELAY = /refused by the browser relay/;
// Allowed all the way to the proxy, which opened a tunnel that then failed:
// these test hosts do not exist.
const TUNNEL = /ERR_TUNNEL_CONNECTION_FAILED/;

// Where a navigation ended, in a page of its own: loaded, or the first line of its error.
const VISIT = `async function visit(rr, url) {
  const p = await rr.newPage();
  try { await p.goto(url, { timeout: 15000 }); return 'loaded'; } catch (e) { return String(e.message).split('\\n')[0]; } finally { await p.close(); }
}`;

const setConfig = (dir, config) => writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify(config, null, 2));

describe('settings in a real browser', { skip: noBrowser }, () => {
  let app;
  before(async () => { app = await startFixture(); });
  after(() => app?.stop());

  test('listed hosts get past the relay and the route; sign-in hosts only for the sign-in probe, until it saves its session', () => {
    const dir = makeRepo(app);
    try {
      setConfig(dir, { target: { url: app.url }, network: { allow: ['api.example.test'], allowForSignIn: ['login.example.test'] } });
      const s = hunt(['start', '--depth', 'quick'], { cwd: dir });
      assert.match(s.stdout, /network: loopback, plus https to api\.example\.test for every probe, plus https to login\.example\.test for the sign-in probe until it calls rr\.saveSession\(\)/);
      const runId = runIdOf(s.stdout);

      // The first probe may sign in, so the sign-in host is open to it until it saves.
      const first = probe(dir, runId, 'signin', `${VISIT}
export default async function (rr) {
  rr.note('login-before', await visit(rr, 'https://login.example.test/'));
  rr.note('api', await visit(rr, 'https://api.example.test/'));
  rr.note('api-http', await visit(rr, 'http://api.example.test/'));
  rr.note('other', await visit(rr, 'https://other.example.test/'));
  await rr.goto('/');
  await rr.saveSession();
  rr.note('login-after', await visit(rr, 'https://login.example.test/'));
  rr.note('fetch-after', await rr.page.evaluate(() => fetch('https://login.example.test/x').then(() => 'ok', (e) => String(e))));
  rr.expect('signed', true);
}
`);
      const notes = Object.fromEntries(first.result.notes.map((n) => [n.label, n.value]));
      // Past the relay, the route and the proxy: only the tunnel fails here (no such host).
      for (const key of ['login-before', 'api']) assert.match(notes[key], TUNNEL, `${key}: ${notes[key]}`);
      assert.match(notes['api-http'], RELAY, 'plain http to a listed host');
      assert.match(notes.other, RELAY);
      assert.match(notes['login-after'], RELAY, 'the sign-in host closed when the session was saved');
      assert.match(notes['fetch-after'], /TypeError/);
      assert.ok(first.result.blocked.some((u) => u.startsWith('https://login.example.test/x')), 'the route blocked the page\'s own request too');

      // Another probe never gets the sign-in host, and still gets the allow host.
      const other = probe(dir, runId, 'other', `${VISIT}
export default async function (rr) {
  rr.note('login', await visit(rr, 'https://login.example.test/'));
  rr.note('api', await visit(rr, 'https://api.example.test/'));
  rr.expect('ran', true);
}
`);
      const o = Object.fromEntries(other.result.notes.map((n) => [n.label, n.value]));
      assert.match(o.login, RELAY);
      assert.match(o.api, TUNNEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('signIn.variables names exactly what a probe gets, and start stops when one is not set', () => {
    const dir = makeRepo(app);
    try {
      setConfig(dir, { target: { url: app.url }, signIn: { variables: ['SHFIX_EMAIL', 'SHFIX_PASSWORD'] } });
      const s = hunt(['start', '--depth', 'quick'], { cwd: dir, env: { OTHER_PASS: 'would-match-the-ending' } });
      assert.match(s.stdout, /sign-in variables named in the config \(names only\): SHFIX_EMAIL, SHFIX_PASSWORD/);
      const r = probe(dir, runIdOf(s.stdout), 'env', `export default async function (rr) {
  rr.note('env', Object.keys(process.env).filter((k) => k.toUpperCase() !== 'PATH').sort());
  rr.expect('ran', true);
}
`);
      const env = r.result.notes.find((n) => n.label === 'env').value;
      assert.ok(env.includes('SHFIX_EMAIL') && env.includes('SHFIX_PASSWORD'), env.join(','));
      assert.ok(!env.includes('OTHER_PASS'), env.join(','));

      setConfig(dir, { target: { url: app.url }, signIn: { variables: ['SHFIX_EMAIL', 'NOT_SET_ANYWHERE'] } });
      const stopped = hunt(['start', '--depth', 'quick'], { cwd: dir });
      assert.equal(stopped.status, 1);
      assert.match(stopped.stdout, /names sign-in variable the environment does not hold: NOT_SET_ANYWHERE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with "resetBefore": "re-runs", hunt probes share app data and only finish resets, once per re-run', async () => {
    const dir = makeRepo(app);
    try {
      setConfig(dir, { target: { url: app.url }, reset: 'node reset.mjs', resetBefore: 're-runs' });
      let resets = await app.resets();
      const s = hunt(['start', '--depth', 'quick'], { cwd: dir });
      assert.match(s.stdout, /reset: only before each re-run in finish and each replayed test/);
      assert.equal((await app.resets()) - resets, 1, 'start still checks the reset once');
      const runId = runIdOf(s.stdout);

      resets = await app.resets();
      const r = probe(dir, runId, 'empty', `export default async function (rr) {
  const f = await rr.fault('**/api/items', 500);
  await rr.goto('/');
  const o = await rr.observe();
  rr.expect('load-failure-shown-as-error', o.alerts.length > 0 && !o.text.includes('No items yet'), { alerts: o.alerts, text: o.text });
  await f.clear();
}
`);
      assert.equal(r.result.before, undefined, 'no reset before a hunt probe');
      assert.equal((await app.resets()) - resets, 0);

      const input = JSON.stringify({ findings: [{ title: 'Load failure shown as an empty list', severity: 'medium', probe: 'empty', check: 'load-failure-shown-as-error' }], dismissed: [], leads: [] });
      resets = await app.resets();
      let f = hunt(['finish', '--run', runId], { cwd: dir, input });
      if (/finish refused/.test(f.stdout)) f = hunt(['finish', '--run', runId], { cwd: dir, input });
      assert.match(f.stdout, /1 confirmed/);
      assert.equal((await app.resets()) - resets, 2, 'one reset before each of the two re-runs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--url names the app for one hunt; with none and nothing found, start says how to name it', () => {
    const dir = makeRepo(app);
    try {
      setConfig(dir, {});
      const none = hunt(['start', '--depth', 'quick'], { cwd: dir });
      assert.equal(none.status, 1);
      assert.match(none.stdout, /No running Nuxt, Vite or Next dev server of this repository was found/);
      assert.match(none.stdout, /\{ "target": \{ "url": "http:\/\/localhost:5173" \} \}/);
      assert.match(none.stdout, /\/stillhunter:hunt the checkout at http:\/\/localhost:5173/);

      const s = hunt(['start', '--depth', 'quick', '--url', `${app.url}/some/page`], { cwd: dir });
      assert.match(s.stdout, new RegExp(`target: ${app.url.replace(/[.]/g, '\\.')} \\(--url\\)`));
      assert.match(s.stdout, /To skip --url next time, set it in \.stillhunter\/config\.json/);
      const ctx = JSON.parse(readFileSync(path.join(dir, '.stillhunter', 'runs', runIdOf(s.stdout), 'context.json'), 'utf8'));
      assert.equal(ctx.target, app.url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
