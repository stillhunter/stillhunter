import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO } from '../benchmark/comparison/lib.mjs';

test('analysis reports planted reproduction separately from detection recall', (t) => {
  const results = mkdtempSync(path.join(tmpdir(), 'sh-analysis-'));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const arms = ['playwright', 'adversarial', 'stillhunter'];
  const reports = [];
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1, toolCalls: {} };
  for (const [i, arm] of arms.entries()) {
    const id = `harvest-stats__hx1__${arm}__t1`;
    mkdirSync(path.join(results, 'trials', id), { recursive: true });
    writeFileSync(path.join(results, 'trials', id, 'meta.json'), JSON.stringify({ id, arm, feature: 'harvest-stats', bug: 'hx1', trial: 1, wallMs: 1000, usage }));
    writeFileSync(path.join(results, 'trials', id, 'findings.json'), JSON.stringify({ findings: [{ title: arm, status: 'observed' }] }));
    reports.push({ id: `F${i}`, key: `${id}#0`, planted: 'hx1', issue: 'hx1' });
    const dir = path.join(results, 'verify', 'harvest-stats', `planted-F${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: ['confirmed', 'not-reproduced', 'inconclusive'][i], findingKey: `${id}#0` }));
    const regression = path.join(results, 'regression', 'harvest-stats');
    mkdirSync(regression, { recursive: true });
    writeFileSync(path.join(regression, `planted-F${i}.json`), JSON.stringify({ findingKey: `${id}#0`, available: true, classification: ['valid', 'not-sensitive', 'inconclusive'][i] }));
  }
  mkdirSync(path.join(results, 'judge'), { recursive: true });
  writeFileSync(path.join(results, 'judge', 'harvest-stats.pass1.json'), JSON.stringify({ reports, issues: { hx1: 'A planted defect.' } }));
  const r = spawnSync(process.execPath, [path.join(REPO, 'benchmark', 'comparison', 'analyze.mjs')], {
    encoding: 'utf8', env: { ...process.env, BENCH_RESULTS: results, BENCH_ARMS: arms.join(','), BENCH_SET: 'heldout' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /playwright planted reproduction: 1\/1 confirmed; regression tests: 1\/1 valid, 1 available/);
  assert.match(r.stdout, /adversarial planted reproduction: 0\/1 confirmed; regression tests: 0\/1 valid, 1 available/);
  const summary = JSON.parse(readFileSync(path.join(results, 'summary.json'), 'utf8'));
  for (const arm of arms) {
    assert.equal(summary.per[arm].recall.found, 1);
    assert.equal(summary.per[arm].plantedReproduction.total, 1);
  }
  assert.equal(summary.per.playwright.plantedReproduction.confirmed, 1);
  assert.equal(summary.per.adversarial.plantedReproduction.notReproduced, 1);
  assert.equal(summary.per.stillhunter.plantedReproduction.inconclusive, 1);
  assert.deepEqual(Object.fromEntries(summary.rows.map((r) => [r.arm, r.reproduction])), { playwright: 'confirmed', adversarial: 'not-reproduced', stillhunter: 'inconclusive' });
  for (const arm of arms) {
    assert.equal(summary.per[arm].regressionTests.eligible, 1);
    assert.equal(summary.per[arm].regressionTests.available, 1);
  }
  assert.equal(summary.per.playwright.regressionTests.valid, 1);
  assert.equal(summary.per.adversarial.regressionTests.notSensitive, 1);
  assert.equal(summary.per.stillhunter.regressionTests.inconclusive, 1);
  assert.deepEqual(Object.fromEntries(summary.rows.map((r) => [r.arm, r.regression])), { playwright: 'valid', adversarial: 'not-sensitive', stillhunter: 'inconclusive' });
});
