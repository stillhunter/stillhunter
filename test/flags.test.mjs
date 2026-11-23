import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLine, parseStartFlags } from '../dist/flags.mjs';

const flags = (...args) => parseStartFlags(args);

test('depth sets the budget: quick 4, default 10, deep 25 minutes; --minutes overrides it', () => {
  assert.deepEqual(flags(), { ok: true, flags: { depth: 'default', minutes: 10, minSeverity: 'low', focus: null, url: null } });
  assert.equal(flags('--depth', 'quick').flags.minutes, 4);
  assert.equal(flags('--depth', 'deep').flags.minutes, 25);
  assert.deepEqual(flags('--depth', 'deep', '--minutes', '7').flags, { depth: 'deep', minutes: 7, minSeverity: 'low', focus: null, url: null });
});

test('bad values are refused with what is allowed', () => {
  assert.match(flags('--depth', 'thorough').message, /quick, default or deep/);
  for (const m of ['0', '-3', '2.5', 'ten', '121']) assert.match(flags('--minutes', m).message, /whole number from 1 to 120/, m);
  assert.match(flags('--min-severity', 'critical').message, /high, medium or low/);
  assert.match(flags('--focus').message, /--focus needs a value/);
  assert.match(flags('--quick').message, /Unknown start option --quick/);
});

test('the focus is kept as one line, and an empty focus is none', () => {
  assert.equal(flags('--focus', '  the   checkout\nflow ').flags.focus, 'the checkout flow');
  assert.equal(flags('--focus', '   ').flags.focus, null);
  assert.equal(flags('--min-severity', 'medium').flags.minSeverity, 'medium');
});

test('the hidden-count line names the severities below the floor', () => {
  assert.equal(hiddenLine(4, 'high', '.stillhunter/runs/r/report.txt'), '4 medium/low findings hidden: .stillhunter/runs/r/report.txt');
  assert.equal(hiddenLine(1, 'medium', 'x'), '1 low finding hidden: x');
  assert.equal(hiddenLine(0, 'high', 'x'), null);
});
