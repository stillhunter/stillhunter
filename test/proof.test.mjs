// finish's wall limit, end to end: a claimed probe that hangs in its re-runs
// is cut short so finish ends in time, is listed as not re-run rather than as
// not reproducing, and the report written after each proved probe is there to
// read while finish is still running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { DECOY, HUNT, hunt, makeRepo, noBrowser, probe, runIdOf, SIGN_IN, SIGNIN_PROBE, startFixture } from './helpers.mjs';

const WALL_SECONDS = 90;

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
  if (n > 1) await new Promise(() => {});
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

describe('the wall limit', { skip: noBrowser, timeout: 400_000 }, () => {
  test('a hanging re-run is cut short, finish ends in time, and each proved probe is reported as it goes', async () => {
    const app = await startFixture();
    const dir = makeRepo(app);
    try {
      const runId = runIdOf(hunt(['start', '--minutes', '1'], { cwd: dir }).stdout);
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
