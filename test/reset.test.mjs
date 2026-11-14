// The configured reset, run before every probe and every re-run: what it says
// when it fails, and that a reset stopped at its time limit stops everything
// it started, so nothing goes on changing app data after it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetAndSignIn, resetApp } from '../dist/reset.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a reset that works says nothing, and no reset runs nothing', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'ok.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran', 'x');\n");
  assert.equal(await resetApp(dir, {}), null);
  assert.equal(await resetApp(dir, { reset: 'node ok.mjs' }), null);
  assert.ok(existsSync(path.join(dir, 'ran')), 'the reset ran in the repository root');
});

test('a failed reset shows the command, how it ended and the end of what it printed, stderr first', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'both.mjs'), "process.stdout.write('resetting\\n');\nprocess.stderr.write('database is locked\\n');\nprocess.exit(3);\n");
  writeFileSync(path.join(dir, 'stdout.mjs'), "process.stdout.write('> app@1.0.0 reset\\n' + 'x'.repeat(400) + '\\nno such table: users\\n');\nprocess.exit(2);\n");
  assert.equal(await resetApp(dir, { reset: 'node both.mjs' }), 'reset ("node both.mjs") failed: exit 3: database is locked');
  // With nothing on stderr, as npm scripts often print, the end of stdout.
  const quiet = await resetApp(dir, { reset: 'node stdout.mjs' });
  assert.match(quiet, /^reset \("node stdout\.mjs"\) failed: exit 2: x+\nno such table: users$/);
  assert.ok(quiet.length < 400, quiet);
});

// On POSIX the reset leads its own process group; on Windows, taskkill stops
// its process tree.
test('a reset past its time limit is stopped with every process it started', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A process the reset's shell starts and waits for: it would write after
  // the time limit, as a seed still posting data would.
  writeFileSync(path.join(dir, 'slow.mjs'), "import { writeFileSync } from 'node:fs';\nsetTimeout(() => writeFileSync('late', 'x'), 1500);\n");
  const started = Date.now();
  const r = await resetApp(dir, { reset: 'node slow.mjs && echo done' }, 300);
  assert.match(r, /^reset \("node slow\.mjs && echo done"\) failed: timed out after 0\.3 s$/);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  await sleep(2500);
  assert.ok(!existsSync(path.join(dir, 'late')), 'a process the reset started went on after it was stopped');
});

test('the run\'s saved session goes with the reset, so a probe with no sign-in, or a failed one, starts signed out', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, 'session.json');
  const config = { reset: 'node -e ""' };
  // No sign-in probe yet, or the probe is the sign-in probe: nothing signs in.
  for (const [probe, signIn] of [['anon', null], ['signin', 'signin']]) {
    writeFileSync(sessionFile, '{"cookies":[]}');
    const before = await resetAndSignIn({ root: dir, config, probe, signIn, sessionFile, runSignIn: () => assert.fail('no sign-in runs') });
    assert.equal(before.signIn, null);
    assert.equal(before.resetError, null);
    assert.ok(!existsSync(sessionFile), `${probe}: the old session is gone`);
  }
  // The sign-in runs after the session is removed, and saves the one the probe uses.
  writeFileSync(sessionFile, '{"cookies":[]}');
  const seen = [];
  const before = await resetAndSignIn({
    root: dir, config, probe: 'needs', signIn: 'signin', sessionFile,
    runSignIn: async (name) => { seen.push(existsSync(sessionFile)); writeFileSync(sessionFile, '{}'); return { probe: name, error: null, savedSession: true }; },
  });
  assert.deepEqual(seen, [false]);
  assert.deepEqual(before.signIn, { probe: 'signin', seconds: before.signIn.seconds, error: null, savedSession: true });
  assert.ok(existsSync(sessionFile));
});
