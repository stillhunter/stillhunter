import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { credentialIn } from '../dist/keep.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { childEnv, NODE_NET_PERMISSION, permissionArgs, redact, REDACTED, sessionValues } from '../dist/probe-host.mjs';

test('the child gets PATH and the named sign-in variables, nothing else', () => {
  const env = { PATH: '/bin', HOME: '/home/me', APP_EMAIL: 'a@b.c', APP_PASSWORD: 'pw', AWS_SECRET_ACCESS_KEY: 'k', OTHER_EMAIL: 'x' };
  assert.deepEqual(childEnv(['APP_EMAIL', 'APP_PASSWORD', 'UNSET_PASS'], env, 'linux'), { PATH: '/bin', APP_EMAIL: 'a@b.c', APP_PASSWORD: 'pw' });
  assert.deepEqual(childEnv([], { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\u' }, 'win32'), { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
});

test('the permission flags allow reading the run folder, and writing only the scratch and shots folders', () => {
  const runDir = path.resolve('/nonexistent/repo/.stillhunter/runs/r');
  const scratch = path.join(runDir, 'scratch');
  const shots = path.join(runDir, 'shots');
  const args = permissionArgs(runDir, [scratch, shots]);
  assert.equal(args[0], '--permission');
  assert.ok(args.includes(`--allow-fs-read=${runDir}`));
  // The run folder itself is readable but not writable: the runner's own files
  // (context.json, the result files, findings.json) stay out of the child's reach.
  assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write=')).sort(), [`--allow-fs-write=${scratch}`, `--allow-fs-write=${shots}`].sort());
  assert.ok(!args.includes(`--allow-fs-write=${runDir}`));
  for (const a of ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi']) assert.ok(!args.includes(a), a);
  assert.equal(args.includes('--allow-net'), NODE_NET_PERMISSION);
});

test('a kept test holding a sign-in value is caught', () => {
  const env = { APP_PASSWORD: 'hunter22', APP_EMAIL: 'me@example.com', SHORT_PASS: 'ab' };
  assert.equal(credentialIn("fill('hunter22')", ['APP_EMAIL', 'APP_PASSWORD'], env), 'APP_PASSWORD');
  assert.equal(credentialIn('fill(process.env.APP_PASSWORD)', ['APP_EMAIL', 'APP_PASSWORD'], env), null);
  assert.equal(credentialIn("x = 'ab'", ['SHORT_PASS'], env), null);
});

test('the saved session\'s values are replaced wherever a result holds them', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.json');
  assert.deepEqual(sessionValues(file), []);
  writeFileSync(file, JSON.stringify({
    cookies: [{ name: 'sid', value: 'a1b2c3d4e5f6a7b8' }, { name: 'lang', value: 'en' }],
    origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'token', value: 'tok-0123456789-long' }] }],
  }));
  const values = sessionValues(file);
  assert.deepEqual(values, ['tok-0123456789-long', 'a1b2c3d4e5f6a7b8']);
  const result = { output: 'sid=a1b2c3d4e5f6a7b8; lang=en', checks: [{ name: 'c', pass: false, detail: '{"value":"tok-0123456789-long"}' }], notes: [{ label: 'n', value: { nested: ['a1b2c3d4e5f6a7b8'] } }], run: 3, savedSession: true, final: null };
  const out = redact(result, values);
  assert.equal(out.output, `sid=${REDACTED}; lang=en`);
  assert.equal(out.checks[0].detail, `{"value":"${REDACTED}"}`);
  assert.deepEqual(out.notes[0].value, { nested: [REDACTED] });
  assert.equal(out.run, 3);
  assert.equal(out.final, null);
  assert.equal(redact(result, []), result);
  writeFileSync(file, 'not json');
  assert.deepEqual(sessionValues(file), []);
});
