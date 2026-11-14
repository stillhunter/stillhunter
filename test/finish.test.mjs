// finish's time limits: the order it proves claims in, how long each proof run
// may take before the wall limit, and the --proof-seconds flag; how it labels
// each claim from its two re-runs; and which probe signs in again.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FINISH_WALL_SECONDS, judge, PROOF_SECONDS, proofOrder, proofSeconds, runTimeout, signInLine, WALL_ENV, wallSeconds, writeWhole } from '../dist/finish.mjs';
import { PROBE_TIMEOUT_MS } from '../dist/probe-host.mjs';
import { signInProbe } from '../dist/results.mjs';

test('claimed probes are proved by their most severe claim, then in the order claimed', () => {
  const f = (probe, severity) => ({ title: probe, probe, check: 'c', severity });
  assert.deepEqual(proofOrder([f('a', 'low'), f('b', 'medium'), f('c', 'high'), f('a', 'high'), f('d', 'medium'), f('e')]), ['a', 'c', 'b', 'd', 'e']);
  assert.deepEqual(proofOrder([]), []);
});

test('a proof run is held to the wall limit, and none starts when no useful run fits', () => {
  assert.equal(PROOF_SECONDS, 420);
  assert.equal(FINISH_WALL_SECONDS, 540);
  const start = 1_000_000;
  const wall = start + FINISH_WALL_SECONDS * 1000;
  assert.equal(runTimeout(start, wall), PROBE_TIMEOUT_MS);
  // Started at the end of the proof budget, a run is shortened so that it,
  // its kill grace and the browser's teardown end before the wall limit.
  const late = start + PROOF_SECONDS * 1000;
  const t = runTimeout(late, wall);
  assert.ok(t > 0 && t < PROBE_TIMEOUT_MS, String(t));
  assert.ok(late + t + 20_000 <= wall, 'the run and its kill grace end before the wall limit');
  assert.equal(runTimeout(wall - 30_000, wall), null);
  assert.equal(runTimeout(wall + 1, wall), null);
});

test('--proof-seconds lowers the budget and never raises it', () => {
  assert.equal(proofSeconds(['--run', 'x']), PROOF_SECONDS);
  assert.equal(proofSeconds(['--run', 'x', '--proof-seconds', '60']), 60);
  for (const bad of ['0', '421', '1.5', 'soon']) assert.equal(proofSeconds(['--proof-seconds', bad]), null, bad);
  assert.equal(proofSeconds(['--proof-seconds']), null);
});

test('the wall limit can be lowered for a test, never raised', () => {
  assert.equal(WALL_ENV, 'STILLHUNTER_FINISH_WALL_SECONDS');
  assert.equal(wallSeconds({}), FINISH_WALL_SECONDS);
  assert.equal(wallSeconds({ [WALL_ENV]: '90' }), 90);
  for (const bad of ['0', '540', '9999', '1.5', '', 'soon']) assert.equal(wallSeconds({ [WALL_ENV]: bad }), FINISH_WALL_SECONDS, bad);
});

const claim = { title: 'Saving clears the text', severity: 'high', probe: 'save', check: 'text-kept' };
const rerun = (checks, extra = {}) => ({ probe: 'save', checks, notes: [], error: null, hostError: null, savedSession: false, ...extra });
const failing = { name: 'text-kept', pass: false, detail: 'the field was empty' };
const holding = { name: 'text-kept', pass: true, detail: '' };

test('a claim is confirmed when its check fails in both re-runs, intermittent in one, and did not reproduce only when it held in both', () => {
  assert.equal(judge(claim, [rerun([failing]), rerun([failing])]).kind, 'confirmed');
  const once = judge(claim, [rerun([failing]), rerun([holding])]);
  assert.equal(once.kind, 'intermittent');
  assert.equal(once.f.why, 'failed on re-run 1; held on re-run 2');
  const held = judge(claim, [rerun([holding]), rerun([holding])]);
  assert.equal(held.kind, 'dropped');
  assert.equal(held.f.why, 'held on re-run 1; held on re-run 2');
});

test('a re-run that never evaluated the check makes the claim one that could not be re-run, not one that did not reproduce', () => {
  const threw = rerun([], { error: "TypeError: Cannot read properties of undefined (reading 'id') |     at Module.default (file:///x/save.mjs:4:20)" });
  const j = judge(claim, [threw, rerun([holding])]);
  assert.equal(j.kind, 'notRerunnable');
  assert.equal(j.f.why, "re-run 1 never reached the check: TypeError: Cannot read properties of undefined (reading 'id') | at Module.default (file:///x/save.mjs:4:20); held on re-run 2");
  // Timed out with no result, or ended without the check: the same.
  const timedOut = rerun([], { error: 'probe timed out after 120 s and was stopped', hostError: 'timeout' });
  const skipped = rerun([{ name: 'other-check', pass: false, detail: '' }]);
  const both = judge(claim, [timedOut, skipped]);
  assert.equal(both.kind, 'notRerunnable');
  assert.equal(both.f.why, 're-run 1 never reached the check: probe timed out after 120 s and was stopped; re-run 2 never reached the check: the check is not in its result');
  // Failed once, and never reached the check the other time: still not
  // counted, and the reason the other re-run says nothing is kept.
  const half = judge(claim, [rerun([failing]), threw]);
  assert.equal(half.kind, 'intermittent');
  assert.match(half.f.why, /^failed on re-run 1; re-run 2 never reached the check: TypeError: /);
});

const signedIn = { resetSeconds: 1, resetError: null, signIn: { probe: 'signin', seconds: 3, error: null, savedSession: true } };
const signInFailed = { resetSeconds: 1, resetError: null, signIn: { probe: 'signin', seconds: 3, error: 'Error: no form', savedSession: false } };
const hunted = (before) => rerun([failing], { before });

test('a re-run that did not start as the hunt run did says nothing about the claim, whatever its check did', () => {
  // Signed in in the hunt, signed out in both re-runs: a check that fails for
  // that other reason (a 401, say) is not a confirmation, and one that holds
  // signed out is not a failure to reproduce.
  const out = rerun([failing], { before: signInFailed });
  const failedOut = judge(claim, [out, out], hunted(signedIn));
  assert.equal(failedOut.kind, 'notRerunnable');
  assert.equal(failedOut.f.why, 're-run 1 does not count: it ran signed out, as the sign-in after the reset failed, which it had not before the hunt run; re-run 2 does not count: it ran signed out, as the sign-in after the reset failed, which it had not before the hunt run');
  const held = rerun([holding], { before: signInFailed });
  assert.equal(judge(claim, [held, held], hunted(signedIn)).kind, 'notRerunnable');
  // The same for a reset that failed before the re-run and not before the hunt run.
  const unreset = rerun([failing], { before: { ...signedIn, resetError: 'reset ("node reset.mjs") failed: exit 5' } });
  const j = judge(claim, [unreset, rerun([failing], { before: signedIn })], hunted(signedIn));
  assert.equal(j.kind, 'intermittent');
  assert.match(j.f.why, /^re-run 1 does not count: the reset before it failed, as it had not before the hunt run; failed on re-run 2$/);
  // With no hunt run to compare (no reset then), any failed setup does not count.
  assert.equal(judge(claim, [out, out]).kind, 'notRerunnable');

  // Started as the hunt run did, the re-runs count: signed out in both, or
  // signed in by a sign-in probe that saved its session and then failed.
  assert.equal(judge(claim, [out, out], hunted(signInFailed)).kind, 'confirmed');
  const late = rerun([failing], { before: { ...signedIn, signIn: { ...signedIn.signIn, error: 'TypeError: x.slice is not a function' } } });
  assert.equal(judge(claim, [late, late], hunted(signedIn)).kind, 'confirmed');
  // A re-run that never reached its check while signed out says why.
  const stuck = rerun([], { error: 'locator.click: Timeout 30000ms exceeded.', before: signInFailed });
  assert.match(judge(claim, [stuck, stuck], hunted(signInFailed)).f.why, /^re-run 1 never reached the check \(it ran signed out: the sign-in after the reset failed\): locator\.click: Timeout 30000ms exceeded\.; re-run 2 /);
  const unresetStuck = rerun([], { error: 'Error: no list', before: { ...signedIn, resetError: 'reset ("x") failed: exit 1' } });
  assert.match(judge(claim, [unresetStuck, unresetStuck], hunted({ ...signedIn, resetError: 'reset ("x") failed: exit 1' })).f.why, /^re-run 1 never reached the check \(the reset before it failed\): Error: no list; /);
});

test('a sign-in that failed after a reset is said in one line, for every re-run or for some', () => {
  const before = (error) => ({ resetSeconds: 1, resetError: null, signIn: { probe: 'signin', seconds: 3, error } });
  const r = (error) => rerun([], { before: before(error) });
  assert.equal(signInLine(new Map([['save', [r(null), r(null)]]])), null);
  assert.equal(signInLine(new Map([['save', [r('Error: no form'), r('Error: no form')]]])), 'After reset, the sign-in probe "signin" failed: Error: no form. Each claimed probe then ran signed out.');
  assert.equal(signInLine(new Map([['save', [r(null), r('Error: no form')]]])), 'After reset, the sign-in probe "signin" failed before 1 of 2 re-runs: Error: no form. Those re-runs ran signed out.');
  // A sign-in that saved its session and then failed left the re-run signed in.
  assert.equal(signInLine(new Map([['save', [r('Error: later'), r('Error: later')].map((x) => ({ ...x, before: { ...x.before, signIn: { ...x.before.signIn, savedSession: true } } }))]])), null);
  // A re-run with no sign-in before it, as its hunt run had none, is not one.
  const reset = rerun([], { before: { resetSeconds: 1, resetError: null, signIn: null } });
  assert.equal(signInLine(new Map([['save', [reset, reset]]])), null);
  // Without a reset nothing ran before the re-runs, so there is nothing to say.
  assert.equal(signInLine(new Map([['save', [rerun([]), rerun([])]]])), null);
  // Only the re-runs of the probes behind the listed claims count: a claim
  // hidden by severity, or one that is not listed, says nothing.
  const both = new Map([['save', [r(null), r(null)]], ['hidden', [r('Error: no form'), r('Error: no form')]]]);
  assert.equal(signInLine(both, ['save']), null);
  assert.equal(signInLine(both, ['hidden', 'hidden']), 'After reset, the sign-in probe "signin" failed: Error: no form. Each claimed probe then ran signed out.');
  assert.equal(signInLine(both, []), null);
});

test('the sign-in probe is the latest that saved a session and ended without an error, or else the latest that saved one', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-signin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'probes'));
  const result = (name, r) => {
    writeFileSync(path.join(dir, 'probes', `${name}.mjs`), 'export default async function () {}\n');
    writeFileSync(path.join(dir, 'probes', `${name}.result.json`), JSON.stringify({ probe: name, checks: [], notes: [], error: null, savedSession: false, ...r }));
  };
  assert.equal(signInProbe(dir), null);
  result('list', { finishedAt: 1 });
  assert.equal(signInProbe(dir), null);
  // Its session was saved before it failed, so it still signs in.
  result('login', { savedSession: true, error: 'TypeError: x.slice is not a function', finishedAt: 2 });
  assert.equal(signInProbe(dir), 'login');
  result('signin', { savedSession: true, finishedAt: 4 });
  assert.equal(signInProbe(dir), 'signin');
  // One that ended cleanly wins over a later one that failed after saving.
  result('relogin', { savedSession: true, error: 'Error: later', finishedAt: 5 });
  assert.equal(signInProbe(dir), 'signin');
});

test('a report is written whole, and a rename the system refuses for a moment is tried again', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-whole-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'findings.json');
  let refusals = 2;
  writeWhole(file, 'one', (from, to) => {
    if (refusals-- > 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    renameSync(from, to);
  });
  assert.equal(readFileSync(file, 'utf8'), 'one');
  assert.equal(refusals, -1);
  // Another error, or one that does not pass, is thrown.
  assert.throws(() => writeWhole(file, 'two', () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); }), /no space/);
  assert.throws(() => writeWhole(file, 'two', () => { throw Object.assign(new Error('still busy'), { code: 'EBUSY' }); }), /still busy/);
  assert.equal(readFileSync(file, 'utf8'), 'one');
});
