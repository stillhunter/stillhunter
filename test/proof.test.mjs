// finish's wall limit, end to end: a claimed probe that hangs in its re-runs
// is cut short so finish ends in time, is listed as not re-run rather than as
// not reproducing, and the report written after each proved probe is there to
// read while finish is still running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DECOY, HUNT, hunt, huntAsync, makeRepo, noBrowser, probe, runIdOf, SIGN_IN, SIGNIN_PROBE, startFixture } from './helpers.mjs';

// Room for the two probes proved first, each re-run after a reset and a
// sign-in, on a slow CI runner, and for the hanging re-run to start after
// them; short enough that the wall limit, not the probe's own 100 s time
// limit, is what cuts that re-run short.
const WALL_SECONDS = 120;

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
// Its first run, in the hunt, answers at once; every re-run hangs.
const HANG = `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('hang-count') ? Number(fs.readFileSync('hang-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('hang-count', String(n));
  rr.expect('answers-in-time', false, 'the hunt run answers; a re-run hangs');
  if (n > 1 || import.meta.url.includes('/proof/')) await new Promise(() => {});
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

describe('the wall limit', { skip: noBrowser, timeout: 400_000 }, () => {
  test('a hanging re-run is cut short, finish ends in time, and each proved probe is reported as it goes', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
      assert.ok(runId);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      assert.equal(probe(dir, runId, 'signin', SIGNIN_PROBE).result?.checks?.[0]?.pass, true);
      for (const [name, script] of [['empty', EMPTY], ['flaky', FLAKY], ['hang', HANG]]) assert.equal(probe(dir, runId, name, script).result.checks[0].pass, false, name);
      const claims = {
        findings: [
          { title: 'It hangs when asked again', severity: 'medium', probe: 'hang', check: 'answers-in-time' },
          { title: 'A failed load is shown as an empty list', severity: 'high', probe: 'empty', check: 'load-failure-shown-as-error' },
          { title: 'The coin answer is wrong', severity: 'high', probe: 'flaky', check: 'coin-ok' },
        ],
      };

      const started = Date.now();
      const child = spawn(process.execPath, [HUNT, 'finish', '--run', runId], {
        cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...SIGN_IN, ...DECOY, STILLHUNTER_FINISH_WALL_SECONDS: String(WALL_SECONDS) },
      });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stdout += d; });
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.stdin.end(JSON.stringify(claims));

      // While the hanging probe is being proved, the report on disk already
      // holds the two probes proved before it: a finish stopped now leaves them.
      let midway = null;
      let done = false;
      exited.then(() => { done = true; });
      while (!done && !midway) {
        if (existsSync(path.join(runDir, 'proof', 'hang.mjs'))) midway = { findings: readJson(path.join(runDir, 'findings.json')), report: readFileSync(path.join(runDir, 'report.txt'), 'utf8') };
        else await sleep(100);
      }
      const code = await exited;
      const seconds = (Date.now() - started) / 1000;

      assert.ok(midway, 'finish got to the hanging probe');
      assert.equal(midway.findings.proof.complete, false);
      assert.deepEqual(midway.findings.proof.proved, ['empty', 'flaky']);
      assert.deepEqual(midway.findings.confirmed.map((f) => f.probe), ['empty']);
      assert.deepEqual(midway.findings.intermittent.map((f) => f.probe), ['flaky']);
      assert.deepEqual(midway.findings.notRerun.map((f) => f.probe), ['hang']);
      assert.match(midway.report, /1\. HIGH {3}A failed load is shown as an empty list/);
      assert.match(midway.report, /finish had not ended when this was written/);

      assert.equal(code, 0, stdout);
      assert.ok(seconds < WALL_SECONDS, `finish took ${seconds} s, past its ${WALL_SECONDS} s wall limit`);
      const saved = readJson(path.join(runDir, 'findings.json'));
      assert.equal(saved.proof.complete, true);
      assert.equal(saved.proof.wallLimitSeconds, WALL_SECONDS);
      assert.ok(saved.proof.finishSeconds < WALL_SECONDS, String(saved.proof.finishSeconds));
      assert.deepEqual(saved.proof.order, ['empty', 'flaky', 'hang']);
      // Cut short by the wall limit, the hanging probe says nothing about the
      // bug: it is not counted, and not listed as failing to reproduce.
      assert.deepEqual(saved.notRerun.map((f) => f.probe), ['hang']);
      assert.deepEqual(saved.dropped, []);
      assert.deepEqual(saved.proof.proved, ['empty', 'flaky']);
      // Nor is a cut-short run taken for a crash and retried: there is no time.
      assert.ok(existsSync(path.join(runDir, 'proof', 'hang.1.result.json')), 'the hanging re-run was started');
      assert.deepEqual(saved.notes.filter((n) => n.startsWith('hang ')), []);
      assert.ok(!existsSync(path.join(runDir, 'proof', 'hang.1.retry.result.json')));
      assert.match(stdout, /1 confirmed, 1 intermittent, 0 did not reproduce, 1 not re-run in time/);
      // With every severity shown, the printed report lists the intermittent
      // claim and the one there was no time for.
      assert.match(stdout, /Intermittent \(1 of 2\), not counted:\n- The coin answer is wrong \(probe flaky, expectation "coin-ok"\)/);
      assert.match(stdout, /Not re-run in time, not counted:\n- It hangs when asked again \(probe hang, expectation "answers-in-time"\)/);
      assert.ok(!existsSync(`${path.join(runDir, 'findings.json')}.${child.pid}.tmp`));
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('proof reset strategy and independent attempts', { skip: noBrowser, timeout: 300_000 }, () => {
  test('proof mode resets only proof and replay, with fresh scratch and shots for every attempt', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({
        target: { url: app.url },
        hosts: { allow: [new URL(app.url).host] },
        auth: { env: ['SHFIX_EMAIL', 'SHFIX_PASSWORD'] },
        reset: { command: 'node reset.mjs', strategy: 'proof' },
      }));
      const resetsAtStart = await app.resets();
      const started = hunt(['start', '--minutes', '3'], { cwd: dir });
      assert.equal(started.status, 0, started.stdout);
      assert.equal(await app.resets(), resetsAtStart, 'proof mode does not reset at start');
      assert.match(started.stdout, /^reset: app data is reset before every proof re-run and every replayed test; start and hunt probes keep app data$/m);
      const runId = runIdOf(started.stdout);
      const runDir = path.join(dir, '.stillhunter', 'runs', runId);
      const countedSignIn = SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('proof-signin-count') ? Number(fs.readFileSync('proof-signin-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('proof-signin-count', String(n));
`);
      assert.equal(probe(dir, runId, 'signin', countedSignIn).result?.checks?.[0]?.pass, true);
      const stateful = `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('proof-attempt-count') ? Number(fs.readFileSync('proof-attempt-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('proof-attempt-count', String(n));
  const signIns = Number(fs.readFileSync('proof-signin-count', 'utf8'));
  await rr.goto('/');
  await rr.screenshot('attempt');
  rr.expect('isolated-attempt', false, JSON.stringify({ n, signIns }));
}
`;
      const firstHunt = probe(dir, runId, 'stateful', stateful).result;
      const secondHunt = probe(dir, runId, 'stateful', stateful).result;
      assert.equal(JSON.parse(firstHunt.checks[0].detail).n, 1);
      assert.equal(JSON.parse(secondHunt.checks[0].detail).n, 2, 'ordinary hunt scratch still persists');
      assert.equal(await app.resets(), resetsAtStart, 'proof mode does not reset before hunt probes');

      const claims = { findings: [{ title: 'Stateful claim', severity: 'high', probe: 'stateful', check: 'isolated-attempt' }] };
      const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
      assert.equal(finished.status, 0, finished.stdout);
      assert.equal((await app.resets()) - resetsAtStart, 2, 'one reset before each proof attempt');
      const proofResults = [1, 2].map((k) => JSON.parse(readFileSync(path.join(runDir, 'proof', `stateful.${k}.result.json`), 'utf8')));
      for (const [i, result] of proofResults.entries()) {
        assert.deepEqual(JSON.parse(result.checks[0].detail), { n: 1, signIns: 1 }, `proof attempt ${i + 1}`);
        assert.equal(result.before.resetError, null);
        assert.equal(result.before.signIn.probe, 'signin');
        assert.equal(result.before.signIn.error, null);
        const signIn = JSON.parse(readFileSync(path.join(runDir, 'proof', `stateful.${i + 1}.signin.result.json`), 'utf8'));
        assert.equal(signIn.checks[0].pass, true, 'the recorded sign-in flow reran');
        assert.equal(signIn.savedSession, true);
      }
      const shots = proofResults.map((r) => r.shots[0]);
      assert.equal(new Set(shots).size, 2, 'proof attempts cannot overwrite each other\'s screenshots');
      for (const [i, shot] of shots.entries()) {
        const shotDir = statSync(path.dirname(shot));
        const attemptDir = statSync(path.join(runDir, 'proof', `stateful.${i + 1}`, 'shots'));
        assert.deepEqual([shotDir.dev, shotDir.ino], [attemptDir.dev, attemptDir.ino], `proof attempt ${i + 1} screenshot directory`);
        assert.ok(existsSync(shot), `retained proof screenshot: ${shot}`);
      }
      const saved = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
      assert.deepEqual(saved.confirmed.map((f) => f.probe), ['stateful']);
      assert.deepEqual(saved.notRerunnable, []);

      const kept = hunt(['keep', '--run', runId, '--probe', 'stateful', '--check', 'isolated-attempt'], { cwd: dir });
      assert.equal(kept.status, 0, kept.stdout);
      const beforeReplay = await app.resets();
      const replayed = hunt(['replay', 'stateful'], { cwd: dir });
      assert.equal(replayed.status, 1, replayed.stdout);
      assert.match(replayed.stdout, /FAIL {2}stateful:/);
      assert.equal((await app.resets()) - beforeReplay, 1, 'proof mode resets before every kept-test replay');
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


test('fresh proof scratch reruns the recorded sign-in without enabling a reset', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const resets = await app.resets();
    const started = hunt(['start', '--minutes', '3'], { cwd: dir });
    assert.equal(started.status, 0, started.stdout);
    const runId = runIdOf(started.stdout);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    assert.equal(probe(dir, runId, 'signin', SIGNIN_PROBE).result?.checks?.[0]?.pass, true);
    const needsSession = `export default async function (rr) {
  const r = await rr.request('GET', '/api/items');
  if (r.status !== 200) throw new Error('the proof did not start signed in: ' + r.status);
  rr.expect('authenticated-items', false, 'signed in');
}
`;
    assert.equal(probe(dir, runId, 'needs-session', needsSession).result.checks[0].pass, false);
    const claims = { findings: [{ title: 'Needs its recorded sign-in', severity: 'high', probe: 'needs-session', check: 'authenticated-items' }] };
    const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
    assert.equal(finished.status, 0, finished.stdout);
    assert.equal(await app.resets(), resets, 'no phase gained a reset');
    const saved = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
    assert.deepEqual(saved.confirmed.map((f) => f.probe), ['needs-session']);
    assert.deepEqual(saved.notRerunnable, []);
    for (const k of [1, 2]) {
      const result = JSON.parse(readFileSync(path.join(runDir, 'proof', `needs-session.${k}.result.json`), 'utf8'));
      assert.equal(result.before.signIn.probe, 'signin');
      assert.equal(result.before.signIn.error, null);
      assert.equal(result.before.resetError, null);
      const signIn = JSON.parse(readFileSync(path.join(runDir, 'proof', `needs-session.${k}.signin.result.json`), 'utf8'));
      assert.equal(signIn.savedSession, true);
    }
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('repeated finish starts empty proof attempts and preserves every evidence generation', { skip: noBrowser, timeout: 180_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
    assert.ok(runId);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    const script = (generation) => `import fs from 'node:fs';
export default async function (rr) {
  const n = fs.existsSync('finish-count') ? Number(fs.readFileSync('finish-count', 'utf8')) + 1 : 1;
  fs.writeFileSync('finish-count', String(n));
  await rr.goto('/');
  await rr.screenshot('attempt');
  rr.expect('isolated-finish', false, JSON.stringify({ n, generation: '${generation}' }));
}
`;
    const claims = (generation) => ({ findings: [{ title: `${generation} finish`, severity: 'high', probe: 'stateful', check: 'isolated-finish' }] });
    const finish = (generation) => hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims(generation)) });

    const firstScript = script('first');
    assert.equal(probe(dir, runId, 'stateful', firstScript).result.checks[0].pass, false);
    const first = finish('first');
    assert.equal(first.status, 0, first.stdout);
    const proofDir = path.join(runDir, 'proof');
    const firstResults = [1, 2].map((k) => JSON.parse(readFileSync(path.join(proofDir, `stateful.${k}.result.json`), 'utf8')));
    for (const result of firstResults) assert.deepEqual(JSON.parse(result.checks[0].detail), { n: 1, generation: 'first' });
    const firstShots = firstResults.map((r) => r.shots[0]);
    const firstShotBytes = firstShots.map((file) => readFileSync(file));
    const firstFindings = readFileSync(path.join(runDir, 'findings.json'), 'utf8');
    const firstReport = readFileSync(path.join(runDir, 'report.txt'), 'utf8');
    assert.match(firstReport, /repro: .*proof\/generations\/1\/stateful\.mjs/);

    const secondScript = script('second');
    assert.equal(probe(dir, runId, 'stateful', secondScript).result.checks[0].pass, false);
    const second = finish('second');
    assert.equal(second.status, 0, second.stdout);
    const secondResults = [1, 2].map((k) => JSON.parse(readFileSync(path.join(proofDir, `stateful.${k}.result.json`), 'utf8')));
    for (const result of secondResults) assert.deepEqual(JSON.parse(result.checks[0].detail), { n: 1, generation: 'second' });
    const secondShots = secondResults.map((r) => r.shots[0]);
    for (const [i, file] of secondShots.entries()) {
      assert.notEqual(file, firstShots[i], 'a later finish cannot overwrite an earlier screenshot');
      assert.ok(existsSync(file), file);
      assert.ok(readFileSync(firstShots[i]).equals(firstShotBytes[i]), 'the first screenshot bytes remain intact');
    }

    const firstGeneration = path.join(proofDir, 'generations', '1');
    const secondGeneration = path.join(proofDir, 'generations', '2');
    assert.equal(readFileSync(path.join(firstGeneration, 'stateful.mjs'), 'utf8'), firstScript);
    assert.equal(readFileSync(path.join(firstGeneration, 'findings.json'), 'utf8'), firstFindings);
    assert.equal(readFileSync(path.join(firstGeneration, 'report.txt'), 'utf8'), firstReport);
    for (const k of [1, 2]) {
      const archived = JSON.parse(readFileSync(path.join(firstGeneration, `stateful.${k}.result.json`), 'utf8'));
      assert.deepEqual(JSON.parse(archived.checks[0].detail), { n: 1, generation: 'first' });
      assert.equal(readFileSync(path.join(secondGeneration, `stateful.${k}.result.json`), 'utf8'), readFileSync(path.join(proofDir, `stateful.${k}.result.json`), 'utf8'));
    }
    assert.equal(readFileSync(path.join(proofDir, 'stateful.mjs'), 'utf8'), secondScript);
    assert.equal(readFileSync(path.join(secondGeneration, 'findings.json'), 'utf8'), readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
    assert.equal(readFileSync(path.join(secondGeneration, 'report.txt'), 'utf8'), readFileSync(path.join(runDir, 'report.txt'), 'utf8'));
    assert.match(readFileSync(path.join(runDir, 'report.txt'), 'utf8'), /repro: .*proof\/generations\/2\/stateful\.mjs/);

    writeFileSync(path.join(runDir, 'probes', 'stateful.mjs'), '// overwritten live probe\n');
    writeFileSync(path.join(proofDir, 'stateful.mjs'), '// corrupted compatibility snapshot\n');
    const kept = hunt(['keep', '--run', runId, '--probe', 'stateful', '--check', 'isolated-finish', '--as', 'second-finish'], { cwd: dir });
    assert.equal(kept.status, 0, kept.stdout);
    assert.equal(readFileSync(path.join(dir, '.stillhunter', 'tests', 'second-finish', 'test.mjs'), 'utf8'), secondScript);
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('parallel finish calls cannot share or corrupt a proof generation', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
    assert.ok(runId);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    const script = `export default async function (rr) {
  rr.expect('parallel-finish', false, 'claimed');
}
`;
    assert.equal(probe(dir, runId, 'parallel', script).result.checks[0].pass, false);
    const claims = JSON.stringify({ findings: [{ title: 'Parallel finish', severity: 'high', probe: 'parallel', check: 'parallel-finish' }] });
    const results = await Promise.all([
      huntAsync(['finish', '--run', runId], { cwd: dir, input: claims }),
      huntAsync(['finish', '--run', runId], { cwd: dir, input: claims }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [0, 1], results.map((r) => r.stdout).join('\n'));
    const rejected = results.find((r) => r.status === 1);
    assert.match(rejected.stdout, /another finish.*already running|finish lock/i);
    const generations = readdirSync(path.join(runDir, 'proof', 'generations'));
    assert.equal(generations.length, 1, 'only the finish holding the lock reserved evidence');
    const generation = generations[0];
    const findings = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8'));
    assert.equal(String(findings.proof.generation), generation);
    assert.equal(readFileSync(path.join(runDir, 'proof', 'generations', generation, 'parallel.mjs'), 'utf8'), script);
    assert.ok(!existsSync(path.join(runDir, 'finish.lock')), 'the winner releases its lock');
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('proof uses the claimed hunt attempt sign-in, not a later run-wide sign-in', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
    assert.ok(runId);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    const signIn = (marker) => SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  fs.writeFileSync('signin-provenance', '${marker}');
`);
    const claimedScript = `import fs from 'node:fs';
export default async function (rr) {
  const marker = fs.existsSync('signin-provenance') ? fs.readFileSync('signin-provenance', 'utf8') : 'none';
  rr.expect('recorded-signin', false, marker);
}
`;
    assert.equal(probe(dir, runId, 'signin-a', signIn('A')).result.checks[0].pass, true);
    const claimed = probe(dir, runId, 'claimed', claimedScript).result;
    assert.equal(claimed.checks[0].pass, false);
    assert.equal(probe(dir, runId, 'signin-b', signIn('B')).result.checks[0].pass, true);
    const claims = { findings: [{ title: 'Recorded sign-in', severity: 'high', probe: 'claimed', check: 'recorded-signin' }] };
    const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
    assert.equal(finished.status, 0, finished.stdout);
    for (const k of [1, 2]) {
      const result = JSON.parse(readFileSync(path.join(runDir, 'proof', `claimed.${k}.result.json`), 'utf8'));
      assert.equal(result.before.signIn.probe, 'signin-a');
      assert.equal(result.checks[0].detail, 'A');
    }
    const recorded = JSON.parse(readFileSync(path.join(runDir, 'probes', 'claimed.result.json'), 'utf8'));
    assert.equal(recorded.before.signIn.probe, 'signin-a');
    assert.equal(recorded.before.signIn.savedSession, true);
    assert.equal(recorded.before.resetError, null);

    const kept = hunt(['keep', '--run', runId, '--probe', 'claimed', '--check', 'recorded-signin', '--as', 'recorded-signin'], { cwd: dir });
    assert.equal(kept.status, 0, kept.stdout);
    assert.equal(readFileSync(path.join(dir, '.stillhunter', 'tests', '_signin.mjs'), 'utf8'), signIn('A'));
    const generation = JSON.parse(readFileSync(path.join(runDir, 'findings.json'), 'utf8')).proof.generation;
    const generationDir = path.join(runDir, 'proof', 'generations', String(generation));
    assert.deepEqual(JSON.parse(readFileSync(path.join(generationDir, 'claimed.setup.json'), 'utf8')), { signIn: 'signin-a' });
    assert.equal(readFileSync(path.join(generationDir, 'claimed.signin.mjs'), 'utf8'), signIn('A'));
    const replayed = hunt(['replay', 'recorded-signin'], { cwd: dir });
    assert.equal(replayed.status, 1, replayed.stdout);
    assert.match(replayed.stdout, /FAIL {2}recorded-signin:.*fails: A\)/);
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proof sign-in and claimed probe screenshots with the same name cannot overwrite each other', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
    assert.ok(runId);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    const signIn = SIGNIN_PROBE.replace('  await rr.saveSession();\n', "  await rr.screenshot('shared');\n  await rr.saveSession();\n");
    assert.equal(probe(dir, runId, 'signin', signIn).result.checks[0].pass, true);
    const claimed = `export default async function (rr) {
  await rr.goto('/login');
  await rr.screenshot('shared');
  rr.expect('screenshot-paths', false, 'claimed');
}
`;
    assert.equal(probe(dir, runId, 'claimed', claimed).result.checks[0].pass, false);
    const claims = { findings: [{ title: 'Screenshot paths', severity: 'high', probe: 'claimed', check: 'screenshot-paths' }] };
    const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
    assert.equal(finished.status, 0, finished.stdout);
    for (const k of [1, 2]) {
      const setup = JSON.parse(readFileSync(path.join(runDir, 'proof', `claimed.${k}.signin.result.json`), 'utf8'));
      const result = JSON.parse(readFileSync(path.join(runDir, 'proof', `claimed.${k}.result.json`), 'utf8'));
      assert.notEqual(setup.shots[0], result.shots[0]);
      assert.match(setup.shots[0], /signin-shots/);
      assert.ok(existsSync(setup.shots[0]));
      assert.ok(existsSync(result.shots[0]));
    }
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('no-reset provenance follows the last session writer when a clean older sign-in exists', { skip: noBrowser, timeout: 120_000 }, async () => {
  const app = await startFixture();
  const dir = makeRepo(app);
  try {
    writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: app.url } }));
    const runId = runIdOf(hunt(['start', '--minutes', '3'], { cwd: dir }).stdout);
    assert.ok(runId);
    const runDir = path.join(dir, '.stillhunter', 'runs', runId);
    const signIn = (marker, failAfterSave = false) => SIGNIN_PROBE.replace('export default async function (rr) {\n', `import fs from 'node:fs';
export default async function (rr) {
  fs.writeFileSync('signin-provenance', '${marker}');
`).replace("  rr.expect('signed-in', new URL(rr.page.url()).pathname === '/', rr.page.url());", `  rr.expect('signed-in', new URL(rr.page.url()).pathname === '/', rr.page.url());
${failAfterSave ? "  throw new Error('after saving the session');" : ''}`);
    assert.equal(probe(dir, runId, 'signin-a', signIn('A')).result.checks[0].pass, true);
    probe(dir, runId, 'signin-b', signIn('B', true));
    const failedB = JSON.parse(readFileSync(path.join(runDir, 'probes', 'signin-b.result.json'), 'utf8'));
    assert.equal(failedB.savedSession, true);
    assert.match(failedB.error, /after saving the session/);
    const claimedScript = `import fs from 'node:fs';
export default async function (rr) {
  const marker = fs.existsSync('signin-provenance') ? fs.readFileSync('signin-provenance', 'utf8') : 'none';
  rr.expect('actual-session-writer', false, marker);
}
`;
    const claimed = probe(dir, runId, 'claimed', claimedScript).result;
    assert.equal(claimed.checks[0].detail, 'B', 'the hunt scratch holds the session B saved');
    const claims = { findings: [{ title: 'Actual session writer', severity: 'high', probe: 'claimed', check: 'actual-session-writer' }] };
    const finished = hunt(['finish', '--run', runId], { cwd: dir, input: JSON.stringify(claims) });
    assert.equal(finished.status, 0, finished.stdout);
    const recorded = JSON.parse(readFileSync(path.join(runDir, 'probes', 'claimed.result.json'), 'utf8'));
    assert.equal(recorded.before.signIn.probe, 'signin-b');
    for (const k of [1, 2]) {
      const result = JSON.parse(readFileSync(path.join(runDir, 'proof', `claimed.${k}.result.json`), 'utf8'));
      assert.equal(result.before.signIn.probe, 'signin-b');
      assert.equal(result.before.signIn.savedSession, true);
      assert.equal(result.checks[0].detail, 'B');
    }
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
