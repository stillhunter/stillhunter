import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prompt, writeTestRuntime } from '../benchmark/comparison/lib.mjs';
import { classifyRegressionRuns, evaluateRegressionJob, evaluateWithVariants, processOutcome, regressionJobs, replayOutcome } from '../benchmark/comparison/regression.mjs';
import { keepConfirmedTests } from '../benchmark/comparison/trial.mjs';

function resultsWithFinding(t, arm) {
  const results = mkdtempSync(path.join(tmpdir(), 'sh-regression-jobs-'));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const id = `harvest-stats__hx1__${arm}__t1`;
  const dir = path.join(results, 'trials', id);
  mkdirSync(dir, { recursive: true });
  const finding = { title: 'A planted bug', status: 'observed', where: '', steps: '', expected: '', actual: '', evidence: '' };
  const trial = { id, meta: { id, arm, feature: 'harvest-stats', bug: 'hx1' }, findings: [finding] };
  const judgment = { reports: [{ id: 'F1', key: `${id}#0`, planted: 'hx1', issue: 'hx1' }], issues: { hx1: 'A planted bug.' } };
  return { results, dir, finding, trial, judgment };
}

test('the MCP regression runtime resolves the pinned Playwright installation', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-regression-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'mcp', 'node_modules', '@playwright', 'mcp', 'cli.js');
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, '');
  writeFileSync(path.join(path.dirname(cli), 'package.json'), JSON.stringify({ version: '0.0.83' }));
  const core = path.join(dir, 'mcp', 'node_modules', 'playwright-core');
  mkdirSync(core);
  writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.0.0', main: 'index.cjs' }));
  writeFileSync(path.join(core, 'index.cjs'), 'module.exports = { chromium: "pinned chromium" };');
  writeTestRuntime(dir, { PW_MCP_DIR: path.join(dir, 'mcp') });
  const runtime = path.join(dir, 'tests', 'runtime.mjs');
  const check = path.join(dir, 'tests', 'check.mjs');
  writeFileSync(check, 'import { chromium, assert } from "./runtime.mjs"; assert.equal(chromium, "pinned chromium"); console.log("runtime ok");');
  const r = spawnSync(process.execPath, [check], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runtime ok/);
  assert.ok(!readFileSync(runtime, 'utf8').includes('stillhunter'));
});

test('regression jobs match retained tests to planted findings without exposing arm names in ids', (t) => {
  const mcp = resultsWithFinding(t, 'playwright');
  mkdirSync(path.join(mcp.dir, 'scratch', 'tests'), { recursive: true });
  writeFileSync(path.join(mcp.dir, 'scratch', 'tests.json'), JSON.stringify({ tests: [{ title: 'A planted bug', file: 'tests/one.mjs' }] }));
  writeFileSync(path.join(mcp.dir, 'scratch', 'tests', 'one.mjs'), 'export default async function () {}');

  const sh = resultsWithFinding(t, 'stillhunter');
  const kept = path.join(sh.dir, 'stillhunter', 'tests', 'benchmark-1');
  mkdirSync(kept, { recursive: true });
  writeFileSync(path.join(kept, 'test.json'), JSON.stringify({ title: 'A planted bug' }));
  writeFileSync(path.join(kept, 'test.mjs'), 'export default async function () {}');

  const jobs = regressionJobs([mcp.trial, sh.trial], { 'harvest-stats': mcp.judgment }, mcp.results);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].key, 'planted-F1');
  assert.equal(jobs[0].test.kind, 'mcp');
  assert.equal(jobs[0].test.source, path.join(mcp.dir, 'scratch', 'tests', 'one.mjs'));

  const shJobs = regressionJobs([sh.trial], { 'harvest-stats': sh.judgment }, sh.results);
  assert.equal(shJobs[0].test.kind, 'stillhunter');
  assert.equal(shJobs[0].test.name, 'benchmark-1');
});

test('missing and unsafe MCP test artifacts remain missing rather than being executed', (t) => {
  const x = resultsWithFinding(t, 'adversarial');
  mkdirSync(path.join(x.dir, 'scratch'), { recursive: true });
  writeFileSync(path.join(x.dir, 'scratch', 'tests.json'), JSON.stringify({ tests: [{ title: 'A planted bug', file: '../outside.mjs' }] }));
  const jobs = regressionJobs([x.trial], { 'harvest-stats': x.judgment }, x.results);
  assert.equal(jobs[0].test, null);
  assert.match(jobs[0].reason, /unsafe|missing|unreadable/i);
});

test('regression quality requires two buggy failures and a clean pass', () => {
  assert.equal(classifyRegressionRuns(['failed', 'failed'], ['passed']), 'valid');
  assert.equal(classifyRegressionRuns(['failed', 'passed'], ['passed']), 'unstable');
  assert.equal(classifyRegressionRuns(['passed', 'passed'], ['passed']), 'not-sensitive');
  assert.equal(classifyRegressionRuns(['failed', 'failed'], ['failed']), 'wrong-expectation');
  assert.equal(classifyRegressionRuns(['failed', 'inconclusive'], ['passed']), 'inconclusive');
});

test('replay and process outcomes distinguish assertions from incomplete execution', () => {
  assert.equal(replayOutcome(1, 'FAIL  benchmark-1: expected correct behavior'), 'failed');
  assert.equal(replayOutcome(1, 'FAIL  benchmark-1: A bug (expectation "check" not reached: browser crashed)'), 'inconclusive');
  assert.equal(replayOutcome(0, 'PASS  benchmark-1: expectation holds'), 'passed');
  assert.equal(replayOutcome(1, 'INCONCLUSIVE  benchmark-1: reset failed'), 'inconclusive');
  assert.equal(replayOutcome(1, 'runner crashed'), 'inconclusive');
  assert.equal(processOutcome({ status: 0, stderr: '' }), 'passed');
  assert.equal(processOutcome({ status: 1, stderr: 'AssertionError [ERR_ASSERTION]: no' }), 'failed');
  assert.equal(processOutcome({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: '' }), 'inconclusive');
  assert.equal(processOutcome({ status: null, signal: 'SIGKILL', stderr: 'AssertionError [ERR_ASSERTION]: before timeout' }), 'inconclusive');
  assert.equal(replayOutcome(null, 'FAIL  benchmark-1: before timeout'), 'inconclusive');
  assert.equal(processOutcome({ status: 1, stderr: 'SyntaxError: bad test' }), 'inconclusive');
});


test('both MCP arms must leave standalone tests that assert correct behavior', () => {
  const vars = { WEB: 'http://localhost:3701', API: 'http://localhost:8701/api', SCRATCH: '/tmp/scratch', OUT: '/tmp/findings.json' };
  for (const arm of ['playwright', 'adversarial']) {
    const text = prompt(arm, vars);
    assert.match(text, /tests\.json/);
    assert.match(text, /\.\/runtime\.mjs/);
    assert.match(text, /correct behavior/i);
    assert.match(text, /fails while the bug is present/i);
  }
  assert.doesNotMatch(prompt('stillhunter', vars), /tests\.json/);
});

test('Stillhunter retention keeps every confirmed finding and records failures', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-regression-keep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = '20261122-000000-hunt-abcd';
  const runDir = path.join(dir, '.stillhunter', 'runs', run);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify({ confirmed: [
    { title: 'one', probe: 'probe-one', check: 'first check' },
    { title: 'two', probe: 'probe-two', check: 'second check' },
  ] }));
  const cli = path.join(dir, 'plugin', 'dist', 'hunt.mjs');
  mkdirSync(path.dirname(cli), { recursive: true });
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(cli, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv.includes('second check')) process.exit(1);\n`);
  const kept = keepConfirmedTests(dir, path.join(dir, 'plugin'));
  assert.equal(kept.kept.length, 1);
  assert.equal(kept.errors.length, 1);
  assert.match(kept.errors[0], /two/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['keep', '--run', run, '--probe', 'probe-one', '--check', 'first check', '--as', 'benchmark-1']);
  assert.deepEqual(calls[1].slice(0, 2), ['keep', '--run']);
});


test('regression evaluation runs the buggy variant twice and clean once, but never runs a missing test', async () => {
  const calls = [];
  const job = { key: 'planted-F1', findingKey: 'a#0', feature: 'harvest-stats', bug: 'hx1', title: 'A bug', test: { kind: 'mcp', source: '/tmp/test.mjs' } };
  const result = await evaluateRegressionJob(job, async (bug) => {
    calls.push(bug);
    return bug === 'clean' ? { outcome: 'passed' } : { outcome: 'failed' };
  });
  assert.deepEqual(calls, ['hx1', 'hx1', 'clean']);
  assert.equal(result.classification, 'valid');
  assert.deepEqual(result.buggyRuns.map((r) => r.outcome), ['failed', 'failed']);
  assert.deepEqual(result.cleanRuns.map((r) => r.outcome), ['passed']);

  calls.length = 0;
  const missing = await evaluateRegressionJob({ ...job, test: null, reason: 'no test' }, async (bug) => { calls.push(bug); });
  assert.equal(missing.classification, 'missing');
  assert.equal(missing.available, false);
  assert.deepEqual(calls, []);
});


test('a reset or execution exception becomes an inconclusive attempt without discarding other attempts', async () => {
  const job = { key: 'planted-F1', findingKey: 'a#0', feature: 'harvest-stats', bug: 'hx1', title: 'A bug', test: { kind: 'mcp', source: '/tmp/test.mjs' } };
  let buggy = 0;
  const result = await evaluateRegressionJob(job, async (bug) => {
    if (bug === 'clean') return { outcome: 'passed' };
    buggy++;
    if (buggy === 2) throw new Error('reset failed');
    return { outcome: 'failed' };
  });
  assert.equal(result.classification, 'inconclusive');
  assert.deepEqual(result.buggyRuns.map((r) => r.outcome), ['failed', 'inconclusive']);
  assert.match(result.buggyRuns[1].error, /reset failed/);
  assert.deepEqual(result.cleanRuns.map((r) => r.outcome), ['passed']);
});


test('variant lifecycle closes the buggy app before opening clean and closes clean afterward', async () => {
  const events = [];
  const job = { key: 'planted-F1', findingKey: 'a#0', feature: 'harvest-stats', bug: 'hx1', title: 'A bug', test: { kind: 'mcp', source: '/tmp/test.mjs' } };
  const result = await evaluateWithVariants(job, async (bug) => {
    events.push(`open ${bug}`);
    return {
      run: async () => { events.push(`run ${bug}`); return { outcome: bug === 'clean' ? 'passed' : 'failed' }; },
      close: async () => { events.push(`close ${bug}`); },
    };
  });
  assert.equal(result.classification, 'valid');
  assert.deepEqual(events, ['open hx1', 'run hx1', 'run hx1', 'close hx1', 'open clean', 'run clean', 'close clean']);
});
