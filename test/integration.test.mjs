// The whole hunt with no model: start, probe, finish, keep and replay against
// the fixture app, asserting what is confirmed, refused, intermittent and
// replayed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CONFIGURED, DECOY, hunt, huntAsync, makeRepo, noBrowser, probe, runIdOf, SIGN_IN, SIGNIN_PROBE, startFixture, startTlsFixture } from './helpers.mjs';

const LAYOUT = `export default async function (rr) {
  const p = await rr.newPage({ width: 375, height: 800 });
  await rr.goto('/', p);
  const o = await rr.observe(p);
  await rr.screenshot('items-375', { page: p });
  rr.expect('nothing-off-screen-at-375', !o.layout.some((c) => c.kind === 'off-screen'), o.layout);
}
`;
const EMPTY = `export default async function (rr) {
  const f = await rr.fault('**/api/items', 500);
  await rr.goto('/');
  const o = await rr.observe();
  rr.expect('load-failure-shown-as-error', o.alerts.length > 0 && !o.text.includes('No items yet'), { alerts: o.alerts, text: o.text });
  await f.clear();
}
`;
const FLAKY = `export default async function (rr) {
  const r = await rr.request('GET', '/api/coin');
  rr.expect('coin-ok', r.json?.ok === true, r.json);
}
`;
const MISC = `export default async function (rr) {
  await rr.goto('/');
  await rr.page.evaluate(() => fetch('/api/echo', { method: 'POST', body: '{}' }));
  rr.expect('misc-a', false, 'a selector that matched nothing');
  rr.expect('misc-b', false, 'left unexplained');
  const echo = await rr.request('POST', '/api/echo', '{"n": 1e309}\u0000', { raw: true, headers: { 'x-test': 'yes' } });
  rr.expect('misc-ok', echo.status === 200 && echo.json.raw === '{"n": 1e309}\u0000' && echo.json.contentType === 'application/json' && echo.json.test === 'yes', echo.json);
  const typed = await rr.request('POST', '/api/echo', 'as json');
  rr.expect('misc-json', typed.json.raw === '"as json"', typed.json);
  rr.note('a-note', 'just a note');
}
`;
// More requests than a probe's printed result lists (the last 30).
const MANY = `export default async function (rr) {
  for (let i = 0; i < 40; i++) await rr.request('POST', '/api/echo', { i });
  rr.expect('many-answered', true);
}
`;
// It holds a sign-in value typed literally, so keep must refuse it.
const LITERAL = `export default async function (rr) {
  const typed = '${SIGN_IN.SHFIX_PASSWORD}';
  rr.expect('literal-check', typed.length === 0, 'fails every time');
}
`;
// Its check fails in the hunt; every re-run throws before it gets there.
const GONE = `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('gone-count') ? Number(fs.readFileSync('gone-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('gone-count', String(n));
  if (n > 1 || import.meta.url.includes('/proof/')) throw new Error('the list was not there to check');
  await rr.goto('/');
  rr.expect('list-has-three-items', false, 'two items listed');
  rr.expect('count-says-three', false, 'the count says 2');
}
`;
// Its host crashes on the first proof re-run only, so the runner must retry it.
const CRASHY = `import fs from 'node:fs';
import path from 'node:path';
export default async function (rr) {
  const n = fs.existsSync('crashy-count') ? Number(fs.readFileSync('crashy-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('crashy-count', String(n));
  if (import.meta.url.includes('/proof/') && path.basename(path.dirname(process.cwd())) === 'crashy.1') process.exit(1);
  await rr.goto('/');
  rr.expect('count-matches-list', false, 'summary says 2, list says 2, flagged anyway');
}
`;

// Every probe resets and signs in first, so the suite has room for twice the
// browser work it had before resets.
describe('a hunt against the fixture app', { skip: noBrowser, timeout: 900_000 }, () => {
  let app;
  let dir;
  let runId;
  const runDir = () => path.join(dir, '.stillhunter', 'runs', runId);
  const finish = (input) => hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(input) });

  before(async () => {
    app = await startFixture();
    dir = makeRepo(app);
  });
  after(() => {
    app?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const findings = [
    { title: 'A failed load is shown as an empty list', severity: 'high', probe: 'empty', check: 'load-failure-shown-as-error', where: '/' },
    { title: 'The summary bar runs off the screen at 375 px', severity: 'low', probe: 'layout', check: 'nothing-off-screen-at-375', where: '/' },
    { title: 'The coin answer is wrong', severity: 'medium', probe: 'flaky', check: 'coin-ok', where: 'GET /api/coin' },
    { title: 'The count does not match the list', severity: 'medium', probe: 'crashy', check: 'count-matches-list', where: '/' },
    { title: 'A check on a typed value fails', severity: 'low', probe: 'literal', check: 'literal-check', expected: `never store ${SIGN_IN.SHFIX_PASSWORD}`, [SIGN_IN.SHFIX_PASSWORD]: 'findings key' },
    // Claimed before the high claim on the same probe, so the report must sort them.
    { title: 'The count is one short', severity: 'medium', probe: 'gone', check: 'count-says-three', where: '/' },
    { title: 'The list is one item short', severity: 'high', probe: 'gone', check: 'list-has-three-items', where: '/' },
  ];
  const dismissed = [{ probe: 'misc', check: 'misc-a', reason: 'probe-wrong', why: 'selector typo' }];

  test('start prints the change, the specs and the flags, resets app data once, and ignores run folders', async () => {
    // Ten minutes, so the coverage refusal (while more than 180 s remain)
    // still applies however slow the probes below are.
    const resetsBefore = await app.resets();
    const r = hunt(['start', '--depth', 'quick', '--minutes', '10', '--min-severity', 'high', '--focus', 'the summary bar'], { cwd: dir });
    assert.equal(r.status, 0, r.stdout);
    assert.equal((await app.resets()) - resetsBefore, 1);
    assert.match(r.stdout, /^reset: app data is reset before every probe and every re-run, back to what the app holds now, and the sign-in probe then signs in again; the reset took \d+(\.\d)? s$/m);
    runId = runIdOf(r.stdout);
    assert.ok(runId, r.stdout);
    assert.match(r.stdout, /budget: 10 min \(depth quick\) \| report: high severity and above/);
    assert.match(r.stdout, /focus: the summary bar/);
    assert.match(r.stdout, /=== spec: \.stillhunter\/specs\/request\.txt ===\nShow a summary bar above the list of items\./);
    assert.match(r.stdout, /\+export const summary = true;/);
    assert.match(r.stdout, /=== untracked file: web\/summary\.css ===\n\.summary \{ display: flex; min-width: 600px; \}/);
    assert.match(r.stdout, /sign-in variables set in the environment \(names only\): .*SHFIX_EMAIL, SHFIX_PASSWORD/);
    assert.doesNotMatch(r.stdout, new RegExp(SIGN_IN.SHFIX_PASSWORD));
    assert.match(readFileSync(path.join(dir, '.stillhunter', '.gitignore'), 'utf8'), /^\/\.env\n\/runs\/\n$/);
    const ctx = JSON.parse(readFileSync(path.join(runDir(), 'context.json'), 'utf8'));
    assert.equal(ctx.minSeverity, 'high');
    assert.equal(ctx.focus, 'the summary bar');
    assert.equal(ctx.deadline - ctx.startedAt, 10 * 60_000);
  });

  test('each probe starts from a reset, signed in again by the sign-in probe unless it is the sign-in probe', async () => {
    const probes = path.join(runDir(), 'probes');
    let resets = await app.resets();
    const signin = probe(dir, runId, 'signin', SIGNIN_PROBE).result;
    assert.equal(signin?.checks?.[0]?.pass, true, JSON.stringify(signin));
    // The reset, and no sign-in before the sign-in probe itself: none exists yet.
    assert.equal((await app.resets()) - resets, 1);
    assert.equal(signin.before.signIn, null);
    assert.equal(signin.before.resetError, null);
    assert.equal(typeof signin.before.resetSeconds, 'number');
    assert.ok(!('warning' in signin));
    assert.ok(!existsSync(path.join(probes, 'signin.1.signin.result.json')));

    resets = await app.resets();
    const again = probe(dir, runId, 'signin', SIGNIN_PROBE).result;
    // Now it is the sign-in probe, and it is still not run twice.
    assert.equal((await app.resets()) - resets, 1);
    assert.equal(again.before.signIn, null);
    assert.ok(!existsSync(path.join(probes, 'signin.2.signin.result.json')));

    // The reset signs everyone out, so the items this probe reads show the
    // sign-in probe ran again first.
    resets = await app.resets();
    const r = probe(dir, runId, 'reads-items', `export default async function (rr) {
  const r = await rr.request('GET', '/api/items');
  rr.expect('items-read', r.status === 200 && r.json.length === 2, r.status);
}
`).result;
    assert.equal((await app.resets()) - resets, 1);
    assert.equal(r.checks[0].pass, true, JSON.stringify(r));
    assert.equal(r.before.signIn.probe, 'signin');
    assert.equal(r.before.signIn.error, null);
    assert.equal(typeof r.before.signIn.seconds, 'number');
    assert.ok(!('warning' in r));
    assert.equal(JSON.parse(readFileSync(path.join(probes, 'reads-items.1.signin.result.json'), 'utf8')).savedSession, true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(probes, 'reads-items.result.json'), 'utf8')).before, r.before);
  });

  test('probes keep a numbered result per run with every request and each page viewport', () => {
    const first = probe(dir, runId, 'layout', LAYOUT);
    const second = probe(dir, runId, 'layout', LAYOUT);
    assert.equal(first.result.run, 1);
    assert.equal(second.result.run, 2);
    for (const f of ['layout.1.result.json', 'layout.2.result.json', 'layout.result.json']) assert.ok(existsSync(path.join(runDir(), 'probes', f)), f);
    const kept = JSON.parse(readFileSync(path.join(runDir(), 'probes', 'layout.result.json'), 'utf8'));
    assert.equal(kept.run, 2);
    assert.equal(kept.checks[0].pass, false);
    assert.match(kept.checks[0].detail, /off-screen/);
    assert.ok(kept.pages.some((p) => p.viewport?.width === 375 && p.visited.some((v) => v.width === 375)));
    assert.ok(kept.requests.some((q) => q.url.endsWith('/api/items') && q.status === 200));
    assert.ok(existsSync(path.join(runDir(), 'shots', 'items-375.png')));
    assert.ok(second.result.shots[0].endsWith(path.join('shots', 'items-375.png')));

    const empty = probe(dir, runId, 'empty', EMPTY).result;
    assert.equal(empty.checks[0].pass, false, JSON.stringify(empty));
    const faultedRequest = JSON.parse(readFileSync(path.join(runDir(), 'probes', 'empty.result.json'), 'utf8')).requests.find((q) => q.url.endsWith('/api/items'));
    assert.equal(faultedRequest.fault, '500');
    assert.equal(probe(dir, runId, 'flaky', FLAKY).result.checks[0].pass, false);
    const misc = probe(dir, runId, 'misc', MISC).result;
    assert.deepEqual(misc.checks.map((c) => [c.name, c.pass]), [['misc-a', false], ['misc-b', false], ['misc-ok', true], ['misc-json', true]], JSON.stringify(misc.checks));
    // Everything an ordinary probe does passes the browser relay.
    for (const r of [first.result, second.result, empty, misc]) assert.deepEqual(r.refused, [], JSON.stringify(r.refused));
    const echoes = JSON.parse(readFileSync(path.join(runDir(), 'probes', 'misc.result.json'), 'utf8')).requests.filter((q) => q.via === 'rr.request');
    assert.deepEqual(echoes.map((q) => q.status), [200, 200]);
    assert.equal(probe(dir, runId, 'crashy', CRASHY).result.checks[0].pass, false);
    assert.equal(probe(dir, runId, 'literal', LITERAL).result.checks[0].pass, false);
    assert.equal(probe(dir, runId, 'gone', GONE).result.checks[0].pass, false);

    // The result file keeps every request; what the probe prints lists the last 30.
    const many = probe(dir, runId, 'many', MANY);
    assert.equal(many.result.requests.total, 40);
    assert.equal(many.result.requests.last.length, 30);
    assert.equal(many.result.requests.last[0].url, many.result.requests.last[29].url);
    const kept40 = JSON.parse(readFileSync(path.join(runDir(), 'probes', 'many.result.json'), 'utf8')).requests;
    assert.equal(kept40.length, 40);
    assert.ok(kept40.every((q) => q.via === 'rr.request' && q.status === 200));
  });

  test('finish refuses claims it cannot check, saying how to fix them', () => {
    const r = finish({
      findings: [
        { title: 'Passing', probe: 'signin', check: 'signed-in' },
        { title: 'A note', probe: 'misc', check: 'a-note' },
        { title: 'No probe', probe: 'nope', check: 'x' },
      ],
    });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /finish refused/);
    assert.match(r.stdout, /check "signed-in" passed in the latest run of "signin"/);
    assert.match(r.stdout, /"a-note" is a note in "misc", not a check/);
    assert.match(r.stdout, /no probe named "nope"/);
    assert.ok(!existsSync(path.join(runDir(), 'proof')), 'nothing is re-run');
  });

  test('finish refuses once for unaccounted checks and coverage gaps, then accepts', async () => {
    const first = finish({ findings, dismissed, leads: [] });
    assert.equal(first.status, 2, first.stdout);
    assert.match(first.stdout, /misc \/ misc-b: left unexplained/);
    assert.doesNotMatch(first.stdout, /misc \/ misc-a:/);
    // Only the sign-in probe saw POST /api/login and /login, so neither is a gap.
    assert.match(first.stdout, /seen but never faulted: POST \/api\/echo\n/);
    assert.match(first.stdout, /pages never seen at 375 px: none\n/);
    assert.doesNotMatch(first.stdout, /\/api\/login|\/login\b/);
    assert.match(first.stdout, /This is said once/);

    const resetsBefore = await app.resets();
    const r = finish({ findings, dismissed, leads: [{ title: 'Maybe the count lags behind', why: 'could not make it happen', [SIGN_IN.SHFIX_PASSWORD]: { nested: 'lead key' } }] });
    assert.equal(r.status, 0, r.stdout);
    // App data is reset before each re-run and each retry: two re-runs of
    // each of six probes, and one retry of crashy's first. (11 before gone
    // was claimed: its two re-runs add 2.)
    assert.equal((await app.resets()) - resetsBefore, 13);
    assert.match(r.stdout, /4 confirmed, 1 intermittent, 0 did not reproduce, 2 could not re-run\n/);
    assert.match(r.stdout, /1\. HIGH {3}A failed load is shown as an empty list/);
    // Its re-runs never got to the check, so it is not said to not reproduce.
    assert.match(r.stdout, /\nCould not re-run, not counted:\n- The list is one item short \(probe gone, expectation "list-has-three-items"\): re-run 1 never reached the check: Error: the list was not there to check.*; re-run 2 never reached the check: Error: the list was not there to check[^\n]*\n\n/);
    assert.doesNotMatch(r.stdout, /The count is one short/);
    assert.doesNotMatch(r.stdout, /The summary bar runs off the screen/);
    // The medium intermittent and the medium claim that could not be re-run
    // are below the high floor, so the printed report hides them and counts
    // them among the hidden (three confirmed, one intermittent and one that
    // could not be re-run); report.txt keeps them.
    assert.match(r.stdout, new RegExp(`5 medium/low findings hidden: \\.stillhunter/runs/${runId}/report\\.txt`));
    assert.doesNotMatch(r.stdout, /Intermittent \(1 of 2\), not counted/);
    assert.doesNotMatch(r.stdout, /The coin answer is wrong/);
    assert.match(r.stdout, /Coverage\nendpoints seen: /);
    assert.doesNotMatch(r.stdout, /Maybe the count lags behind/);

    const report = readFileSync(path.join(runDir(), 'report.txt'), 'utf8');
    assert.match(report, /LOW {4}The summary bar runs off the screen at 375 px/);
    assert.match(report, /Intermittent \(1 of 2\), not counted:\n- The coin answer is wrong \(probe flaky, expectation "coin-ok"\): (failed on re-run 1; held on re-run 2|held on re-run 1; failed on re-run 2)\n/);
    // Most severe first, though the medium claim was not listed last.
    assert.match(report, /\nCould not re-run, not counted:\n- The list is one item short [^\n]*\n- The count is one short \(probe gone, expectation "count-says-three"\): re-run 1 never reached the check/);
    assert.match(report, /Dismissed:\n- misc \/ misc-a: probe-wrong: selector typo/);
    assert.match(report, /Unaccounted \(failed, neither claimed nor dismissed\):\n- misc \/ misc-b: left unexplained/);
    assert.match(report, /expected: never store \[session value\]/);
    assert.doesNotMatch(report, new RegExp(SIGN_IN.SHFIX_PASSWORD));
    const saved = JSON.parse(readFileSync(path.join(runDir(), 'findings.json'), 'utf8'));
    assert.ok(!JSON.stringify(saved).includes(SIGN_IN.SHFIX_PASSWORD));
    assert.equal(saved.confirmed.find((f) => f.probe === 'literal')['[session value]'], 'findings key');
    assert.deepEqual(saved.confirmed.map((f) => f.probe), ['empty', 'crashy', 'layout', 'literal']);
    assert.ok(saved.notes.some((n) => /^crashy re-run 1: .*retried once$/.test(n)), saved.notes.join('\n'));
    assert.equal(saved.confirmed[0].runs.length, 2);
    assert.deepEqual(saved.intermittent.map((f) => f.probe), ['flaky']);
    assert.deepEqual(saved.notRerunnable.map((f) => f.check), ['list-has-three-items', 'count-says-three']);
    assert.deepEqual(saved.dropped, []);
    assert.doesNotMatch(report, /Did not reproduce/);
    // The sign-in went well, so nothing is said about it.
    assert.doesNotMatch(report, /After reset/);
    assert.equal(JSON.parse(readFileSync(path.join(runDir(), 'proof', 'empty.1.result.json'), 'utf8')).before.signIn.probe, 'signin');
    const leads = JSON.parse(readFileSync(path.join(runDir(), 'leads.json'), 'utf8'));
    assert.deepEqual(leads.map((l) => l.title), ['Maybe the count lags behind']);
    assert.deepEqual(leads[0]['[session value]'], { nested: 'lead key' });
    assert.ok(!JSON.stringify(leads).includes(SIGN_IN.SHFIX_PASSWORD));
    const proof = readdirSync(path.join(runDir(), 'proof'));
    for (const f of ['empty.1.result.json', 'empty.2.result.json', 'flaky.1.result.json', 'flaky.2.result.json', 'empty.1.signin.result.json', 'crashy.1.result.json', 'crashy.1.retry.result.json']) assert.ok(proof.includes(f), f);
    // The hunt's own latest results are never overwritten by the proof.
    assert.equal(JSON.parse(readFileSync(path.join(runDir(), 'probes', 'flaky.result.json'), 'utf8')).checks[0].pass, false);
  });

  test('keep saves a confirmed finding as a test with no session or credential', () => {
    const refused = hunt(['keep', '--run', runId, '--probe', 'flaky', '--check', 'coin-ok'], { cwd: dir });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /confirmed no finding with probe "flaky"/);
    // Confirmed, but it holds a sign-in value as typed text.
    const literal = hunt(['keep', '--run', runId, '--probe', 'literal', '--check', 'literal-check'], { cwd: dir });
    assert.equal(literal.status, 1, literal.stdout);
    assert.match(literal.stdout, /The probe holds the value of SHFIX_PASSWORD\. Kept tests never hold a credential; read it from process\.env\.SHFIX_PASSWORD instead\./);
    assert.doesNotMatch(literal.stdout, new RegExp(SIGN_IN.SHFIX_PASSWORD));
    assert.ok(!existsSync(path.join(dir, '.stillhunter', 'tests')), 'nothing was kept');

    // The live probe file is overwritten after finish (as a re-run would do);
    // keep must save the script finish proved, from its proof snapshot.
    writeFileSync(path.join(runDir(), 'probes', 'empty.mjs'), '// overwritten after finish\nexport default async function (rr) {}\n');
    const r = hunt(['keep', '--run', runId, '--probe', 'empty', '--check', 'load-failure-shown-as-error', '--as', 'items-load-error'], { cwd: dir });
    assert.equal(r.status, 0, r.stdout);
    const tests = path.join(dir, '.stillhunter', 'tests');
    assert.doesNotMatch(readFileSync(path.join(tests, 'items-load-error', 'test.mjs'), 'utf8'), /overwritten after finish/);
    assert.deepEqual(readdirSync(tests).sort(), ['_signin.mjs', 'items-load-error']);
    assert.deepEqual(readdirSync(path.join(tests, 'items-load-error')).sort(), ['test.json', 'test.mjs']);
    const meta = JSON.parse(readFileSync(path.join(tests, 'items-load-error', 'test.json'), 'utf8'));
    assert.deepEqual(meta, { check: 'load-failure-shown-as-error', title: findings[0].title, severity: 'high', keptFrom: { run: runId, probe: 'empty' } });
    for (const f of [path.join(tests, '_signin.mjs'), path.join(tests, 'items-load-error', 'test.mjs'), path.join(tests, 'items-load-error', 'test.json')]) {
      const text = readFileSync(f, 'utf8');
      assert.doesNotMatch(text, new RegExp(SIGN_IN.SHFIX_PASSWORD));
      assert.doesNotMatch(text, /sid=|cookies|storageState/);
    }
    assert.match(readFileSync(path.join(tests, '_signin.mjs'), 'utf8'), /saveSession/);
  });

  test('replay fails while the defect is there and passes once it is fixed', async () => {
    // A fresh clone might replay before any hunt; replay must still keep run
    // folders (which hold a session) out of git.
    const gitignore = path.join(dir, '.stillhunter', '.gitignore');
    writeFileSync(gitignore, '/.env\n');
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node reset.mjs', auth: { env: ['SHFIX_EMAIL', 'SHFIX_PASSWORD', 'CUSTOM_TOKEN'] } }));
    // A kept test that throws before its expectation guards nothing, so it fails.
    const broken = path.join(dir, '.stillhunter', 'tests', 'throws-early');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'test.mjs'), "export default async function (rr) {\n  throw new Error('broke before the expectation');\n  rr.expect('never-reached', true);\n}\n");
    writeFileSync(path.join(broken, 'test.json'), JSON.stringify({ check: 'never-reached', title: `Throws before its expectation ${CONFIGURED.CUSTOM_TOKEN}`, severity: 'low', keptFrom: { run: runId, probe: 'x' } }));
    const resetsBefore = await app.resets();
    const failing = hunt(['replay'], { cwd: dir });
    // App data is reset once before each kept test.
    assert.equal((await app.resets()) - resetsBefore, 2);
    assert.match(readFileSync(gitignore, 'utf8'), /^\/runs\/$/m);
    assert.equal(failing.status, 1, failing.stdout);
    assert.match(failing.stdout, /stillhunter \| replay \| 2 tests \| 0 passed, 2 failed/);
    assert.match(failing.stdout, /FAIL {2}items-load-error: A failed load is shown as an empty list \(expectation "load-failure-shown-as-error" fails: /);
    assert.match(failing.stdout, /FAIL {2}throws-early: Throws before its expectation \[session value\] \(expectation "never-reached" not reached: Error: broke before the expectation/);
    assert.doesNotMatch(failing.stdout, new RegExp(CONFIGURED.CUSTOM_TOKEN));
    assert.doesNotMatch(failing.stdout, /sign-in failed/);
    const configuredReplayDir = /^results: (.+)$/m.exec(failing.stdout)?.[1];
    assert.ok(configuredReplayDir, failing.stdout);
    const replayContextFile = path.join(dir, configuredReplayDir, 'context.json');
    const replayContext = JSON.parse(readFileSync(replayContextFile, 'utf8'));
    assert.deepEqual(replayContext.signInVariables, ['CUSTOM_TOKEN', 'SHFIX_EMAIL', 'SHFIX_PASSWORD']);
    assert.ok(!readFileSync(replayContextFile, 'utf8').includes(CONFIGURED.CUSTOM_TOKEN));

    await app.post('/__fix');
    const passing = hunt(['replay', 'items-load-error'], { cwd: dir });
    assert.equal(passing.status, 0, passing.stdout);
    assert.match(passing.stdout, /stillhunter \| replay \| 1 test \| 1 passed, 0 failed/);
    assert.match(passing.stdout, /PASS {2}items-load-error: .*\(expectation "load-failure-shown-as-error" holds\)/);

    writeFileSync(path.join(dir, 'bad-replay-reset.mjs'), "process.exit(9);\n");
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node bad-replay-reset.mjs' }));
    const unreset = hunt(['replay', 'items-load-error'], { cwd: dir });
    assert.equal(unreset.status, 1, unreset.stdout);
    assert.match(unreset.stdout, /stillhunter \| replay \| 1 test \| 0 passed, 0 failed, 1 inconclusive/);
    assert.match(unreset.stdout, /INCONCLUSIVE {2}items-load-error: .*reset \("node bad-replay-reset\.mjs"\) failed: exit 9/);
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node reset.mjs' }));

    const tests = path.join(dir, '.stillhunter', 'tests');
    for (const name of ['replay-first', 'replay-second']) {
      mkdirSync(path.join(tests, name));
      writeFileSync(path.join(tests, name, 'test.mjs'), "export default async function (rr) { rr.expect('setup-check', true); }\n");
      writeFileSync(path.join(tests, name, 'test.json'), JSON.stringify({ check: 'setup-check', title: 'Setup is reliable', severity: 'low', keptFrom: { run: runId, probe: name } }));
    }
    const signInFile = path.join(tests, '_signin.mjs');
    writeFileSync(signInFile, SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('replay-signin-count') ? Number(fs.readFileSync('replay-signin-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('replay-signin-count', String(n));
  if (n > 1) throw new Error('replay sign-in failed before saving');
`));
    writeFileSync(path.join(dir, 'reset-keeping-sessions.mjs'), `await fetch(${JSON.stringify(`${app.url}/__reset?sessions=keep`)}, { method: 'POST' });\n`);
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node reset-keeping-sessions.mjs' }));
    const badSignIn = hunt(['replay', 'replay-first', 'replay-second'], { cwd: dir });
    assert.equal(badSignIn.status, 1, badSignIn.stdout);
    assert.match(badSignIn.stdout, /stillhunter \| replay \| 2 tests \| 1 passed, 0 failed, 1 inconclusive/);
    assert.match(badSignIn.stdout, /INCONCLUSIVE {2}replay-second: .*sign-in failed: Error: replay sign-in failed before saving/);
    const replayDir = /^results: (.+)$/m.exec(badSignIn.stdout)?.[1];
    assert.ok(replayDir, badSignIn.stdout);
    assert.ok(!existsSync(path.join(dir, replayDir, 'scratch', 'session.json')), 'a failed re-sign-in cannot reuse the previous test\'s session');
    writeFileSync(signInFile, SIGNIN_PROBE);
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node reset.mjs' }));

    const stillBroken = hunt(['replay', 'throws-early'], { cwd: dir });
    assert.equal(stillBroken.status, 1, stillBroken.stdout);
    assert.match(stillBroken.stdout, /FAIL {2}throws-early: .*not reached/);
    assert.match(hunt(['replay', 'nope'], { cwd: dir }).stdout, /No kept test named nope\. Kept tests: items-load-error, replay-first, replay-second, throws-early\./);
  });

  test('the decoy variable never reached a probe', () => {
    for (const f of readdirSync(path.join(runDir(), 'probes'))) {
      assert.doesNotMatch(readFileSync(path.join(runDir(), 'probes', f), 'utf8'), new RegExp(DECOY.SHFIX_SECRET_TOKEN), f);
    }
  });
});

describe('the proof budget', { skip: noBrowser, timeout: 300_000 }, () => {
  test('finish proves the most severe claims first and lists what it had no time for as not counted', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      // Three minutes: room for a reset and a sign-in before each probe, and
      // never more than the 180 s that would bring a coverage refusal.
      const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      assert.equal(probe(dir, runId, 'signin', SIGNIN_PROBE).result?.checks?.[0]?.pass, true);
      assert.equal(probe(dir, runId, 'layout', LAYOUT).result.checks[0].pass, false);
      // Slower than the proof budget below, so the second claim cannot start
      // however fast finish gets to the first.
      assert.equal(probe(dir, runId, 'empty', EMPTY.replace('{\n', '{\n  await rr.sleep(4000);\n')).result.checks[0].pass, false);
      const claims = {
        findings: [
          { title: 'The summary bar runs off the screen at 375 px', severity: 'low', probe: 'layout', check: 'nothing-off-screen-at-375' },
          { title: 'A failed load is shown as an empty list', severity: 'high', probe: 'empty', check: 'load-failure-shown-as-error' },
        ],
      };
      for (const bad of ['0', '421', 'soon']) {
        const r = hunt(['finish', '--run', runId, '--proof-seconds', bad], { cwd: dir, input: JSON.stringify(claims) });
        assert.equal(r.status, 2, r.stdout);
        assert.match(r.stdout, /--proof-seconds is a whole number from 1 to 420/);
      }
      // A three-second budget has room for the first probe only, and the high
      // claim goes first though it was listed second.
      const r = hunt(['finish', '--run', runId, '--proof-seconds', '3'], { cwd: dir, input: JSON.stringify(claims) });
      assert.equal(r.status, 0, r.stdout);
      assert.match(r.stdout, /1 confirmed, 0 intermittent, 0 did not reproduce, 1 not re-run in time/);
      assert.match(r.stdout, /1\. HIGH {3}A failed load is shown as an empty list/);
      assert.match(r.stdout, /Not re-run in time, not counted:\n- The summary bar runs off the screen at 375 px \(probe layout, expectation "nothing-off-screen-at-375"\)/);
      const saved = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.deepEqual(saved.confirmed.map((f) => f.probe), ['empty']);
      assert.deepEqual(saved.notRerun.map((f) => f.probe), ['layout']);
      assert.deepEqual(saved.proof.order, ['empty', 'layout']);
      assert.deepEqual(saved.proof.proved, ['empty']);
      assert.equal(saved.proof.complete, true);
      assert.equal(saved.proof.budgetSeconds, 3);
      assert.ok(saved.proof.finishSeconds >= 8 && saved.proof.finishSeconds < 540, String(saved.proof.finishSeconds));
      assert.ok(!existsSync(path.join(runDir, 'proof', 'layout.1.result.json')));
      const report = readFileSync(path.join(runDir, 'report.txt'), 'utf8');
      assert.match(report, /Not re-run in time, not counted:\n- The summary bar runs off the screen/);
      assert.match(report, /Proof: 1 of 2 claimed probes re-run in \d+ s \(budget 3 s\)\n/);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('target authorization', { skip: noBrowser, timeout: 120_000 }, () => {
  test('start refuses a non-loopback target omitted from hosts.allow and an allowlisted HTTP target', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      const config = path.join(dir, '.stillhunter', 'config.json');
      writeFileSync(config, JSON.stringify({ target: { url: 'https://localhost.:443' } }));
      const omitted = hunt(['start'], { cwd: dir });
      assert.equal(omitted.status, 1, omitted.stdout);
      assert.match(omitted.stdout, /target must be loopback or an exact hosts.allow entry/);

      writeFileSync(config, JSON.stringify({ target: { url: 'http://localhost.:443' }, hosts: { allow: ['localhost.:443'] } }));
      const http = hunt(['start'], { cwd: dir });
      assert.equal(http.status, 1, http.stdout);
      assert.match(http.stdout, /target must be loopback or an exact hosts.allow entry/);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('start reaches an exact allowlisted HTTPS target and snapshots its allowlist', async () => {
    const app = await startFixture();
    const tls = await startTlsFixture();
    const dir = makeRepo(app);
    try {
      writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: tls.url }, hosts: { allow: [tls.allowedHost] }, reset: 'node reset.mjs' }));
      const r = await huntAsync(['start'], { cwd: dir, env: { NODE_EXTRA_CA_CERTS: tls.certFile } });
      assert.equal(r.status, 0, r.stdout);
      const runId = runIdOf(r.stdout);
      const ctx = JSON.parse(readFileSync(path.join(dir, '.stillhunter', 'runs', runId, 'context.json'), 'utf8'));
      assert.deepEqual(ctx.allowedHosts, [tls.allowedHost]);
    } finally {
      await tls.stop();
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('feature mode', { skip: noBrowser, timeout: 120_000 }, () => {
  test('with no change, start needs a focus and then tests that feature as it stands', async () => {
    const app = await startFixture();
    const dir = makeRepo(app, { change: false });
    try {
      const none = hunt(['start'], { cwd: dir });
      assert.equal(none.status, 1);
      assert.match(none.stdout, /No change found\. Name a feature to hunt, for example: \/stillhunter:hunt the checkout flow/);
      const r = hunt(['start', '--focus', 'the items list'], { cwd: dir });
      assert.equal(r.status, 0, r.stdout);
      assert.match(r.stdout, /mode: feature\. There is no change against the base, so this hunt tests "the items list" as it stands\./);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the reset at start', { skip: noBrowser, timeout: 120_000 }, () => {
  test('a reset that fails stops start, and without a reset nothing is reset', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      const config = path.join(dir, '.stillhunter', 'config.json');
      writeFileSync(path.join(dir, 'bad-reset.mjs'), "process.stdout.write('resetting\\n');\nprocess.stderr.write('database is locked\\n');\nprocess.exit(3);\n");
      writeFileSync(config, JSON.stringify({ target: { url: app.url }, reset: 'node bad-reset.mjs' }));
      const failed = hunt(['start'], { cwd: dir });
      assert.equal(failed.status, 1, failed.stdout);
      assert.match(failed.stdout, /^--- stillhunter \(copy this block unchanged\) ---\nstillhunter \| stopped\nThe app's reset failed, so the hunt did not start: reset \("node bad-reset\.mjs"\) failed: exit 3: database is locked\nFix the reset/);
      assert.ok(!existsSync(path.join(dir, '.stillhunter', 'runs')), 'no run was started');

      // Without a reset, start and probe behave as before.
      writeFileSync(config, JSON.stringify({ target: { url: app.url } }));
      const resets = await app.resets();
      const r = hunt(['start'], { cwd: dir });
      assert.equal(r.status, 0, r.stdout);
      assert.doesNotMatch(r.stdout, /^reset:/m);
      const runId = runIdOf(r.stdout);
      const p = probe(dir, runId, 'look', "export default async function (rr) {\n  await rr.goto('/login');\n  rr.expect('login-page', true);\n}\n").result;
      assert.equal(p.checks[0].pass, true, JSON.stringify(p));
      assert.equal(p.before.resetSeconds, 0);
      assert.equal(p.before.resetError, null);
      assert.equal(p.before.signIn, null);
      assert.ok(!('warning' in p), JSON.stringify(p));
      assert.equal(await app.resets(), resets);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Records when it started, takes 1.5 s, and works on its first run (at
// start) only, as a reset would that a locked database stops.
const SLOW_THEN_FAILING_RESET = `import fs from 'node:fs';
const n = fs.existsSync('reset-count') ? Number(fs.readFileSync('reset-count', 'utf8')) + 1 : 1;
fs.writeFileSync('reset-count', String(n));
if (n > 1) { process.stderr.write('database is locked\\n'); process.exit(5); }
fs.writeFileSync('reset-started', String(Date.now()));
await new Promise((r) => setTimeout(r, 1500));
`;

describe('the reset before a probe', { skip: noBrowser, timeout: 120_000 }, () => {
  test('the reset at start counts against the budget, and a reset that fails before a probe is said first while the probe still runs', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      writeFileSync(path.join(dir, 'flaky-reset.mjs'), SLOW_THEN_FAILING_RESET);
      writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url }, reset: 'node flaky-reset.mjs' }));
      const r = hunt(['start', '--minutes', '3'], { cwd: dir });
      assert.equal(r.status, 0, r.stdout);
      const runId = runIdOf(r.stdout);
      const took = Number(/the reset took (\d+(?:\.\d)?) s$/m.exec(r.stdout)?.[1]);
      assert.ok(took >= 1.5, r.stdout);
      // The budget's clock started before the reset did.
      const ctx = JSON.parse(readFileSync(path.join(dir, '.stillhunter', 'runs', runId, 'context.json'), 'utf8'));
      assert.ok(ctx.startedAt <= Number(readFileSync(path.join(dir, 'reset-started'), 'utf8')), JSON.stringify(ctx));
      assert.equal(ctx.deadline - ctx.startedAt, 3 * 60_000);

      const p = probe(dir, runId, 'look', "export default async function (rr) {\n  await rr.goto('/login');\n  rr.expect('login-page', true);\n}\n");
      assert.equal(Object.keys(p.result)[0], 'warning', p.stdout);
      assert.equal(p.result.warning, 'Before this probe, the reset ("node flaky-reset.mjs") failed: exit 5: database is locked. App data may not be in its reset state.');
      assert.equal(p.result.checks[0].pass, true, 'the probe ran');
      assert.match(p.result.before.resetError, /^reset \("node flaky-reset\.mjs"\) failed: exit 5/);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const signinCounted = (counter, lines) => SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('${counter}') ? Number(fs.readFileSync('${counter}', 'utf8')) + 1 : 1;
  fs.writeFileSync('${counter}', String(n));
`).replace('  await rr.saveSession();\n', `  await rr.saveSession();\n${lines}`);
// Saves its session on every run; from its second run on, a later step fails,
// as one that goes on to read data would.
const LATE_FAILING_SIGNIN = signinCounted('signin-count', "  if (n > 1 || import.meta.url.includes('/proof/')) throw new Error('a later step of the sign-in probe failed');\n");
const ITEMS_LISTED = `export default async function (rr) {
  const r = await rr.request('GET', '/api/items');
  rr.expect('items-listed', r.status === 200, 'status ' + r.status);
}
`;
const NO_ITEMS = `export default async function (rr) {
  const r = await rr.request('GET', '/api/items');
  rr.note('status', r.status);
  rr.expect('no-items', r.status === 200 && r.json.length === 0, 'status ' + r.status + ', ' + (r.json?.length ?? 0) + ' items');
}
`;
// Fails its check in the hunt; every re-run throws before it.
const LATER = `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('later-count') ? Number(fs.readFileSync('later-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('later-count', String(n));
  if (n > 1 || import.meta.url.includes('/proof/')) throw new Error('the page was not there to check');
  rr.expect('later-check', false, 'fails in the hunt');
}
`;

describe('each claim is proved from the sign-in its hunt run had', { skip: noBrowser, timeout: 300_000 }, () => {
  test('signed out before any sign-in, and signed in by a sign-in probe that saved its session and then failed', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    // Sessions outlive this app's reset, so a probe starts signed out only
    // because the runner drops the run's saved session with each reset.
    writeFileSync(path.join(dir, 'reset.mjs'), `await fetch(${JSON.stringify(`${app.url}/__reset?sessions=keep`)}, { method: 'POST' });\n`);
    try {
      const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
      assert.ok(runId);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      // Before any sign-in probe exists, a probe runs signed out.
      const anon = probe(dir, runId, 'anon', ITEMS_LISTED).result;
      assert.equal(anon.checks[0].detail, 'status 401', JSON.stringify(anon));
      assert.equal(anon.before.signIn, null);
      assert.equal(probe(dir, runId, 'signin', LATE_FAILING_SIGNIN).result?.checks?.[0]?.pass, true);

      // The sign-in before this probe saved its session, then failed: the
      // probe ran with that session, and is told so.
      const lists = probe(dir, runId, 'lists', NO_ITEMS);
      assert.equal(Object.keys(lists.result)[0], 'warning', lists.stdout);
      assert.match(lists.result.warning, /^After the reset, the sign-in probe "signin" saved a session, then failed: Error: a later step of the sign-in probe failed.*\. This probe ran with that session\. Keep the sign-in probe to signing in: it runs before every probe\.$/);
      assert.doesNotMatch(lists.result.warning, /signed out/);
      assert.deepEqual(lists.result.notes, [{ label: 'status', value: 200 }]);
      assert.equal(lists.result.before.signIn.savedSession, true);

      // Run again, the sign-in probe's own latest run ends in an error after
      // saving its session. No probe signed in cleanly, so it is still the one
      // that signs in before the next probe, which is told why it failed.
      assert.match(probe(dir, runId, 'signin', LATE_FAILING_SIGNIN).result.error, /a later step of the sign-in probe failed/);
      const later = probe(dir, runId, 'later', LATER);
      assert.equal(Object.keys(later.result)[0], 'warning', later.stdout);
      assert.match(later.result.warning, /^After the reset, the sign-in probe "signin" saved a session, then failed: Error: a later step of the sign-in probe failed.*\. This probe ran with that session\./);
      assert.equal(later.result.before.signIn.probe, 'signin');
      assert.equal(later.result.before.signIn.savedSession, true);

      const claims = { findings: [
        { title: 'Items are not listed', severity: 'high', probe: 'anon', check: 'items-listed' },
        { title: 'Items are listed when there should be none', severity: 'high', probe: 'lists', check: 'no-items' },
        { title: 'The later check fails', severity: 'medium', probe: 'later', check: 'later-check' },
      ] };
      const r = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
      assert.equal(r.status, 0, r.stdout);
      // anon is re-run signed out, as its hunt run was, so its 401 reproduces;
      // lists is re-run after the same sign-in, which again saved its session.
      assert.match(r.stdout, /2 confirmed, 0 intermittent, 0 did not reproduce, 1 could not re-run\n/);
      const findings = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.deepEqual(findings.confirmed.map((f) => [f.probe, f.runs]), [['anon', ['status 401', 'status 401']], ['lists', ['status 200, 2 items', 'status 200, 2 items']]]);
      for (const k of [1, 2]) {
        assert.equal(JSON.parse(readFileSync(path.join(runDir, 'proof', `anon.${k}.result.json`), 'utf8')).before.signIn, null);
        assert.equal(JSON.parse(readFileSync(path.join(runDir, 'proof', `later.${k}.result.json`), 'utf8')).before.signIn.probe, 'signin');
        assert.equal(JSON.parse(readFileSync(path.join(runDir, 'proof', `lists.${k}.result.json`), 'utf8')).before.signIn.probe, 'signin');
      }
      assert.ok(findings.notes.some((n) => /^before lists 1: the sign-in probe "signin" saved a session, then failed: Error: a later step/.test(n)), findings.notes.join('\n'));
      // later's re-runs were signed in, as its hunt run was, and threw before
      // the check: could not re-run, with no sign-in line before it.
      assert.match(r.stdout, /\nCould not re-run, not counted:\n- The later check fails \(probe later, expectation "later-check"\): re-run 1 never reached the check: Error: the page was not there to check/);
      assert.doesNotMatch(r.stdout, /ran signed out/);
      // The sign-in page and its request are not coverage; the page it landed
      // on, and what that page asked for, are.
      assert.deepEqual(findings.coverage.endpoints, [{ endpoint: 'GET /api/items', faults: [] }]);
      assert.deepEqual(findings.coverage.pages.map((p) => p.page), ['/']);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Signs in on its first two runs (its own in the hunt, and again before the
// next probe), then fails before saving a session, as a sign-in would whose
// page changed under it.
const FRAGILE_SIGNIN = SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('signin-count') ? Number(fs.readFileSync('signin-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('signin-count', String(n));
  if (n > 2 || import.meta.url.includes('/proof/')) throw new Error('the sign-in form was not there');
`);
const NEEDS_SESSION = `export default async function (rr) {
  const r = await rr.request('GET', '/api/items');
  if (r.status !== 200) throw new Error('GET /api/items answered ' + r.status);
  rr.expect('no-items-listed', r.json.length === 0, r.json);
}
`;

describe('a sign-in that fails after a reset', { skip: noBrowser, timeout: 300_000 }, () => {
  test('the probe says so first and runs signed out, and finish says so first and counts the claim as not re-run', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
      assert.ok(runId);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      // Run before any sign-in probe existed, so signed out.
      assert.equal(probe(dir, runId, 'anon', ITEMS_LISTED).result.checks[0].detail, 'status 401');
      assert.equal(probe(dir, runId, 'signin', FRAGILE_SIGNIN).result?.checks?.[0]?.pass, true);
      const needs = probe(dir, runId, 'needs', NEEDS_SESSION).result;
      assert.equal(needs.checks[0].pass, false, JSON.stringify(needs));
      assert.ok(!('warning' in needs));

      // The third sign-in fails: the probe still runs, signed out, and its
      // output starts by saying why.
      const after = probe(dir, runId, 'after', "export default async function (rr) {\n  const r = await rr.request('GET', '/api/items');\n  rr.note('status', r.status);\n}\n");
      assert.equal(Object.keys(after.result)[0], 'warning', after.stdout);
      assert.match(after.result.warning, /^After the reset, the sign-in probe "signin" failed: Error: the sign-in form was not there.*\. This probe ran signed out\.$/);
      assert.deepEqual(after.result.notes, [{ label: 'status', value: 401 }]);
      const saved = JSON.parse(readFileSync(path.join(runDir, 'probes', 'after.result.json'), 'utf8'));
      assert.match(saved.before.signIn.error, /the sign-in form was not there/);

      const claims = { findings: [
        { title: 'Items are not listed', severity: 'high', probe: 'anon', check: 'items-listed' },
        { title: 'Items are listed when there should be none', severity: 'high', probe: 'needs', check: 'no-items-listed' },
      ] };
      const r = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
      assert.equal(r.status, 0, r.stdout);
      // anon is re-run signed out, as its hunt run was, though "signin" is
      // still the sign-in probe: nothing signs in before it.
      assert.match(r.stdout, /1 confirmed, 0 intermittent, 0 did not reproduce, 1 could not re-run\n/);
      for (const k of [1, 2]) assert.equal(JSON.parse(readFileSync(path.join(runDir, 'proof', `anon.${k}.result.json`), 'utf8')).before.signIn, null);
      // needs' hunt run was signed in and its re-runs were not, so they say nothing.
      assert.match(r.stdout, /\nCould not re-run, not counted:\nAfter reset, the sign-in probe "signin" failed: Error: the sign-in form was not there.*\. Each claimed probe then ran signed out\.\n- Items are listed when there should be none \(probe needs, expectation "no-items-listed"\): re-run 1 does not count: it ran signed out, as the sign-in after the reset failed, which it had not before the hunt run; re-run 2 does not count: /);
      const findings = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.deepEqual(findings.notRerunnable.map((f) => f.probe), ['needs']);
      assert.deepEqual(findings.confirmed.map((f) => [f.probe, f.runs]), [['anon', ['status 401', 'status 401']]]);
      assert.deepEqual(findings.dropped, []);
      assert.ok(findings.notes.some((n) => /^before needs 1: signing in again with "signin" failed: Error: the sign-in form was not there/.test(n)), findings.notes.join('\n'));
      assert.match(readFileSync(path.join(runDir, 'report.txt'), 'utf8'), /\nCould not re-run, not counted:\nAfter reset, the sign-in probe "signin" failed: Error: the sign-in form was not there.*\. Each claimed probe then ran signed out\.\n/);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('schema-named credentials preserve the runner protocol', { skip: noBrowser, timeout: 180_000 }, () => {
  test('probe results and finish findings keep fixed keys through keep', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    const env = {
      SCHEMA_REQUESTS: 'requests',
      SCHEMA_CHECKS: 'checks',
      SCHEMA_ERROR: 'error',
      SCHEMA_CONFIRMED: 'confirmed',
      SCHEMA_TITLE: 'title',
      SCHEMA_GENERATION: 'generation',
    };
    try {
      const configFile = path.join(dir, '.stillhunter', 'config.json');
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      writeFileSync(configFile, JSON.stringify({ ...config, auth: { env: Object.keys(env) } }));
      const started = hunt(['start', '--minutes', '3'], { cwd: dir, env });
      const runId = runIdOf(started.stdout);
      assert.ok(runId, started.stdout);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      const script = `export default async function (rr) {
        rr.note('schema-map', { [process.env.SCHEMA_REQUESTS]: 'arbitrary' });
        rr.expect('schema-check', false, 'failure');
      }`;
      const p = probe(dir, runId, 'schema', script, env);
      assert.ok(p.result, p.stdout + p.stderr);
      for (const key of ['checks', 'requests', 'error']) assert.ok(Object.hasOwn(p.result, key), `${key}: ${p.stdout}`);
      assert.deepEqual(p.result.notes[0].value, { '[session value]': 'arbitrary' });
      const savedResult = JSON.parse(readFileSync(path.join(runDir, 'probes', 'schema.result.json'), 'utf8'));
      for (const key of ['checks', 'requests', 'error']) assert.ok(Object.hasOwn(savedResult, key), key);

      const claims = { findings: [{ title: 'Schema finding', severity: 'high', probe: 'schema', check: 'schema-check' }], dismissed: [], leads: [] };
      const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims), env });
      assert.equal(finished.status, 0, finished.stdout);
      const findings = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.ok(Object.hasOwn(findings, 'confirmed'));
      assert.ok(Object.hasOwn(findings.confirmed[0], 'title'));
      assert.equal(findings.proof.generation, 1);

      assert.equal(probe(dir, runId, 'schema', script, env).result.checks[0].pass, false);
      const finishedAgain = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims), env });
      assert.equal(finishedAgain.status, 0, finishedAgain.stdout);
      const secondFindings = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.equal(secondFindings.proof.generation, 2);
      writeFileSync(path.join(runDir, 'probes', 'schema.mjs'), '// overwritten live probe\n');
      writeFileSync(path.join(runDir, 'proof', 'schema.mjs'), '// overwritten compatibility snapshot\n');
      const kept = hunt(['keep', '--run', runId, '--probe', 'schema', '--check', 'schema-check', '--as', 'schema-kept'], { cwd: dir, env });
      assert.equal(kept.status, 0, kept.stdout);
      assert.equal(readFileSync(path.join(dir, '.stillhunter', 'tests', 'schema-kept', 'test.mjs'), 'utf8'), script);
      const meta = JSON.parse(readFileSync(path.join(dir, '.stillhunter', 'tests', 'schema-kept', 'test.json'), 'utf8'));
      assert.equal(meta.title, 'Schema finding');
      assert.equal(meta.check, 'schema-check');
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
