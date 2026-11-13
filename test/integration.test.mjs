// The whole hunt with no model: start, probe, finish, keep and replay against
// the fixture app, asserting what is confirmed, refused, intermittent and
// replayed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DECOY, hunt, makeRepo, noBrowser, probe, runIdOf, SIGN_IN, SIGNIN_PROBE, startFixture } from './helpers.mjs';

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
// Its host crashes on the first proof re-run only, so the runner must retry it.
const CRASHY = `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('crashy-count') ? Number(fs.readFileSync('crashy-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('crashy-count', String(n));
  if (n === 2) process.exit(1);
  await rr.goto('/');
  rr.expect('count-matches-list', false, 'summary says 2, list says 2, flagged anyway');
}
`;

describe('a hunt against the fixture app', { skip: noBrowser, timeout: 600_000 }, () => {
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
    { title: 'A check on a typed value fails', severity: 'low', probe: 'literal', check: 'literal-check' },
  ];
  const dismissed = [{ probe: 'misc', check: 'misc-a', reason: 'probe-wrong', why: 'selector typo' }];

  test('start prints the change, the specs and the flags, and ignores run folders', () => {
    // Ten minutes, so the coverage refusal (while more than 180 s remain)
    // still applies however slow the probes below are.
    const r = hunt(['start', '--depth', 'quick', '--minutes', '10', '--min-severity', 'high', '--focus', 'the summary bar'], { cwd: dir });
    assert.equal(r.status, 0, r.stdout);
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

  test('probes keep a numbered result per run with every request and each page viewport', () => {
    assert.equal(probe(dir, runId, 'signin', SIGNIN_PROBE).result?.checks?.[0]?.pass, true);
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
    assert.match(first.stdout, /seen but never faulted: POST \/api\/login/);
    assert.match(first.stdout, /pages never seen at 375 px: \/login/);
    assert.match(first.stdout, /This is said once/);

    const resetsBefore = await app.resets();
    const r = finish({ findings, dismissed, leads: [{ title: 'Maybe the count lags behind', why: 'could not make it happen' }] });
    assert.equal(r.status, 0, r.stdout);
    // App data is reset before each re-run and each retry: two re-runs of
    // each of five probes, and one retry of crashy's first.
    assert.equal((await app.resets()) - resetsBefore, 11);
    assert.match(r.stdout, /4 confirmed, 1 intermittent, 0 did not reproduce/);
    assert.match(r.stdout, /1\. HIGH {3}A failed load is shown as an empty list/);
    assert.doesNotMatch(r.stdout, /The summary bar runs off the screen/);
    // The medium intermittent is below the high floor, so the printed report
    // hides it and counts it among the hidden; report.txt keeps it.
    assert.match(r.stdout, new RegExp(`4 medium/low findings hidden: \\.stillhunter/runs/${runId}/report\\.txt`));
    assert.doesNotMatch(r.stdout, /Intermittent \(1 of 2\), not counted/);
    assert.doesNotMatch(r.stdout, /The coin answer is wrong/);
    assert.match(r.stdout, /Coverage\nendpoints seen: /);
    assert.doesNotMatch(r.stdout, /Maybe the count lags behind/);

    const report = readFileSync(path.join(runDir(), 'report.txt'), 'utf8');
    assert.match(report, /LOW {4}The summary bar runs off the screen at 375 px/);
    assert.match(report, /Intermittent \(1 of 2\), not counted:\n- The coin answer is wrong/);
    assert.match(report, /Dismissed:\n- misc \/ misc-a: probe-wrong: selector typo/);
    assert.match(report, /Unaccounted \(failed, neither claimed nor dismissed\):\n- misc \/ misc-b: left unexplained/);
    const saved = JSON.parse(readFileSync(path.join(runDir(), 'findings.json'), 'utf8'));
    assert.deepEqual(saved.confirmed.map((f) => f.probe), ['empty', 'crashy', 'layout', 'literal']);
    assert.ok(saved.notes.some((n) => /^crashy re-run 1: .*retried once$/.test(n)), saved.notes.join('\n'));
    assert.equal(saved.confirmed[0].runs.length, 2);
    assert.deepEqual(saved.intermittent.map((f) => f.probe), ['flaky']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(runDir(), 'leads.json'), 'utf8')).map((l) => l.title), ['Maybe the count lags behind']);
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
    // A kept test that throws before its expectation guards nothing, so it fails.
    const broken = path.join(dir, '.stillhunter', 'tests', 'throws-early');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'test.mjs'), "export default async function (rr) {\n  throw new Error('broke before the expectation');\n  rr.expect('never-reached', true);\n}\n");
    writeFileSync(path.join(broken, 'test.json'), JSON.stringify({ check: 'never-reached', title: 'Throws before its expectation', severity: 'low', keptFrom: { run: runId, probe: 'x' } }));
    const resetsBefore = await app.resets();
    const failing = hunt(['replay'], { cwd: dir });
    // App data is reset once before each kept test.
    assert.equal((await app.resets()) - resetsBefore, 2);
    assert.match(readFileSync(gitignore, 'utf8'), /^\/runs\/$/m);
    assert.equal(failing.status, 1, failing.stdout);
    assert.match(failing.stdout, /stillhunter \| replay \| 2 tests \| 0 passed, 2 failed/);
    assert.match(failing.stdout, /FAIL {2}items-load-error: A failed load is shown as an empty list \(expectation "load-failure-shown-as-error" fails: /);
    assert.match(failing.stdout, /FAIL {2}throws-early: Throws before its expectation \(expectation "never-reached" not reached: Error: broke before the expectation/);
    assert.doesNotMatch(failing.stdout, /sign-in failed/);

    await app.post('/__fix');
    const passing = hunt(['replay', 'items-load-error'], { cwd: dir });
    assert.equal(passing.status, 0, passing.stdout);
    assert.match(passing.stdout, /stillhunter \| replay \| 1 test \| 1 passed, 0 failed/);
    assert.match(passing.stdout, /PASS {2}items-load-error: .*\(expectation "load-failure-shown-as-error" holds\)/);
    const stillBroken = hunt(['replay', 'throws-early'], { cwd: dir });
    assert.equal(stillBroken.status, 1, stillBroken.stdout);
    assert.match(stillBroken.stdout, /FAIL {2}throws-early: .*not reached/);
    assert.match(hunt(['replay', 'nope'], { cwd: dir }).stdout, /No kept test named nope\. Kept tests: items-load-error, throws-early\./);
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
      const runId = runIdOf(hunt(['start', '--minutes', '1'], { cwd: dir }).stdout);
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
