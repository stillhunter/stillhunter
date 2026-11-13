import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimProblems, parseFinishInput, unaccounted } from '../dist/accounting.mjs';
import { outcome } from '../dist/results.mjs';

const result = (checks, notes = []) => ({ checks: checks.map(([name, pass, detail = '']) => ({ name, pass, detail })), notes });
const latest = new Map([
  ['form', result([['saves', false, 'no row'], ['keeps-text', false, 'text gone'], ['loads', true]], [{ label: 'seen', value: 1 }])],
  ['list', result([['sorted', false, 'b before a'], ['sorted', true]])],
  ['ok', result([['fine', true]])],
]);
const input = (o) => ({ findings: [], dismissed: [], leads: [], ...o });

test('a check fails in a run when any expectation of that name failed', () => {
  assert.deepEqual(outcome(latest.get('list'), 'sorted'), { state: 'failed', detail: 'b before a' });
  assert.deepEqual(outcome(latest.get('form'), 'loads'), { state: 'held' });
  assert.deepEqual(outcome(latest.get('form'), 'nope'), { state: 'missing' });
});

test('claims must name an existing probe and a check that failed in its latest run', () => {
  const problems = claimProblems(input({
    findings: [
      { title: 'Good', probe: 'form', check: 'saves', severity: 'high' },
      { title: 'Passed', probe: 'form', check: 'loads' },
      { title: 'Note', probe: 'form', check: 'seen' },
      { title: 'Missing', probe: 'form', check: 'absent' },
      { title: 'No probe', probe: 'ghost', check: 'x' },
      { title: '', probe: 'list', check: 'sorted', severity: 'urgent' },
    ],
  }), latest);
  assert.equal(problems.length, 6, problems.join('\n'));
  assert.match(problems[0], /finding 2 "Passed": check "loads" passed in the latest run of "form"/);
  assert.match(problems[1], /"seen" is a note in "form", not a check\. Record it with rr\.expect/);
  assert.match(problems[2], /has no check "absent"\. Failed checks there: saves, keeps-text/);
  assert.match(problems[3], /no probe named "ghost" with a result\. Probes in this run: form, list, ok/);
  assert.match(problems[4], /finding 6: give it a "title"/);
  assert.match(problems[5], /"severity" is high, medium or low/);
});

test('dismissals need a known reason, and a duplicate names its finding by title', () => {
  const findings = [{ title: 'Saving fails', probe: 'form', check: 'saves' }];
  assert.deepEqual(claimProblems(input({ findings, dismissed: [{ probe: 'form', check: 'keeps-text', reason: 'duplicate', duplicateOf: 'Saving fails' }] }), latest), []);
  const problems = claimProblems(input({
    findings,
    dismissed: [
      { probe: 'form', check: 'keeps-text', reason: 'duplicate', duplicateOf: 'Something else' },
      { probe: 'list', check: 'sorted', reason: 'meh' },
      { probe: 'ok', check: 'fine', reason: 'intended' },
    ],
  }), latest);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems[0], /a duplicate names the finding it repeats, by its exact title, in "duplicateOf"/);
  assert.match(problems[1], /"reason" is one of probe-wrong, duplicate, intended, not-this-change, resilience-gap/);
  assert.match(problems[2], /check "fine" passed/);
});

test('every failed check is claimed or dismissed, or it is unaccounted', () => {
  const all = unaccounted(input(), latest);
  assert.deepEqual(all.map((u) => `${u.probe}/${u.check}`), ['form/saves', 'form/keeps-text', 'list/sorted']);
  const some = unaccounted(input({ findings: [{ probe: 'form', check: 'saves' }], dismissed: [{ probe: 'list', check: 'sorted', reason: 'not-this-change' }] }), latest);
  assert.deepEqual(some, [{ probe: 'form', check: 'keeps-text', detail: 'text gone' }]);
});

test('finish input is a JSON object of lists', () => {
  assert.equal(parseFinishInput('nope').ok, false);
  assert.match(parseFinishInput('[]').message, /JSON object/);
  assert.match(parseFinishInput('{"findings": {}}').message, /"findings" must be a list/);
  assert.deepEqual(parseFinishInput('{}'), { ok: true, input: { findings: [], dismissed: [], leads: [] } });
});
