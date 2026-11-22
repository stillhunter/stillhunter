import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { judgmentCoverage, judgeWithRetry } from '../benchmark/comparison/judge.mjs';
import { recordVerificationError, verdictOrInconclusive, verificationJobs, verifyPrompt } from '../benchmark/comparison/verify.mjs';

test('blind judging rejects missing, duplicate and unknown report ids', () => {
  const items = [{ id: 'F1' }, { id: 'F2' }];
  const answer = { reports: [{ id: 'F1', planted: null, issue: 'one' }], issues: { one: 'One.' } };
  assert.deepEqual(judgmentCoverage(items, answer), { missing: ['F2'], duplicates: [], unknown: [] });

  answer.reports.push({ id: 'F1', planted: null, issue: 'one' }, { id: 'F2', planted: null, issue: 'two' }, { id: 'outside', planted: null, issue: 'two' });
  assert.deepEqual(judgmentCoverage(items, answer), { missing: [], duplicates: ['F1'], unknown: ['outside'] });
});

test('blind judging retries an incomplete pass once and keeps a complete answer', async () => {
  const items = [{ id: 'F1' }, { id: 'F2' }];
  const answers = [
    { reports: [{ id: 'F1' }], issues: {} },
    { reports: [{ id: 'F2' }, { id: 'F1' }], issues: {} },
  ];
  const calls = [];
  const answer = await judgeWithRetry(items, async () => { calls.push(true); return answers.shift(); });
  assert.equal(calls.length, 2);
  assert.deepEqual(answer.reports.map((r) => r.id), ['F1', 'F2']);
});

test('blind judging retries a response with no reports array', async () => {
  const items = [{ id: 'F1' }];
  let calls = 0;
  const answer = await judgeWithRetry(items, async () => {
    calls++;
    return calls === 1 ? { issues: {} } : { reports: [{ id: 'F1' }], issues: {} };
  });
  assert.equal(calls, 2);
  assert.deepEqual(judgmentCoverage(items, answer), { missing: [], duplicates: [], unknown: [] });
});

test('blind judging returns the last incomplete answer after its bounded retry', async () => {
  const items = [{ id: 'F1' }, { id: 'F2' }];
  let calls = 0;
  const answer = await judgeWithRetry(items, async () => { calls++; return { reports: [], issues: {} }; });
  assert.equal(calls, 2);
  assert.deepEqual(judgmentCoverage(items, answer).missing, ['F1', 'F2']);
});


test('verification checks every planted report separately and groups other reports by issue', () => {
  const finding = (title) => ({ title, where: '', steps: `steps for ${title}`, expected: '', actual: '', evidence: '' });
  const trials = [
    { id: 'a', meta: { feature: 'harvest-stats', bug: 'hx1' }, findings: [finding('planted'), finding('extra one')] },
    { id: 'b', meta: { feature: 'harvest-stats', bug: 'clean' }, findings: [finding('extra two')] },
  ];
  const judgments = { 'harvest-stats': {
    reports: [
      { id: 'FP1', key: 'a#0', planted: 'hx1', issue: 'hx1' },
      { id: 'FE1', key: 'a#1', planted: null, issue: 'extra' },
      { id: 'FE2', key: 'b#0', planted: null, issue: 'extra' },
    ],
    issues: { hx1: 'The planted defect.', extra: 'The extra defect.' },
  } };
  const jobs = verificationJobs(trials, judgments);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    feature: 'harvest-stats', bug: 'hx1', key: 'planted-FP1', kind: 'planted', findingKey: 'a#0',
    sentence: 'The planted defect.', samples: [trials[0].findings[0]],
  });
  assert.equal(jobs[1].kind, 'extra');
  assert.equal(jobs[1].bug, 'clean');
  assert.deepEqual(jobs[1].samples.map((f) => f.title), ['extra one', 'extra two']);
});

test('verification treats missing and unrecognized answers as inconclusive', () => {
  assert.equal(verdictOrInconclusive({ verdict: 'confirmed', evidence: 'seen' }).verdict, 'confirmed');
  assert.equal(verdictOrInconclusive({ verdict: 'not-reproduced', evidence: 'tried' }).verdict, 'not-reproduced');
  assert.equal(verdictOrInconclusive(null).verdict, 'inconclusive');
  assert.equal(verdictOrInconclusive({ verdict: 'no-answer' }).verdict, 'inconclusive');
  const text = verifyPrompt('harvest-stats', 'A defect.', [], { web: 3791, api: 8791 }, '/tmp/out', '/tmp/scratch');
  assert.match(text, /"inconclusive"/);
  assert.match(text, /reset|sign-in/i);
});


test('blind judging retries a malformed or failed model call', async () => {
  const items = [{ id: 'F1' }];
  let calls = 0;
  const answer = await judgeWithRetry(items, async () => {
    calls++;
    if (calls === 1) throw new Error('unreadable model response');
    return { reports: [{ id: 'F1' }], issues: {} };
  });
  assert.equal(calls, 2);
  assert.deepEqual(judgmentCoverage(items, answer).missing, []);
});

test('blind judging leaves an explicitly incomplete answer when both calls fail', async () => {
  const items = [{ id: 'F1' }];
  let calls = 0;
  const answer = await judgeWithRetry(items, async () => { calls++; throw new Error('model unavailable'); });
  assert.equal(calls, 2);
  assert.deepEqual(judgmentCoverage(items, answer).missing, ['F1']);
  assert.match(answer.error, /model unavailable/);
});

test('verification infrastructure failures leave an inconclusive verdict artifact', (t) => {
  const results = mkdtempSync(path.join(tmpdir(), 'sh-verification-error-'));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const job = { feature: 'harvest-stats', bug: 'hx1', key: 'planted-F1', kind: 'planted', findingKey: 'a#0', sentence: 'A defect.' };
  const file = recordVerificationError(job, new Error('app did not start'), results);
  const verdict = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(verdict.verdict, 'inconclusive');
  assert.equal(verdict.findingKey, 'a#0');
  assert.equal(verdict.variant, 'hx1');
  assert.match(verdict.evidence, /app did not start/);
});
