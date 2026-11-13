// finish's time limits: the order it proves claims in, how long each proof run
// may take before the wall limit, and the --proof-seconds flag.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINISH_WALL_SECONDS, PROOF_SECONDS, proofOrder, proofSeconds, runTimeout, WALL_ENV, wallSeconds } from '../dist/finish.mjs';
import { PROBE_TIMEOUT_MS } from '../dist/probe-host.mjs';

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
