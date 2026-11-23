import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { credentialIn } from '../dist/keep.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { signInVariableNames } from '../dist/common.mjs';
import { childEnv, LINUX_PLATFORM_FILES, NODE_NET_PERMISSION, permissionArgs, redact, REDACTED, sessionValues } from '../dist/probe-host.mjs';

test('explicit auth.env replaces convention discovery, while omitted auth preserves it', () => {
  const env = { APP_EMAIL: 'a@b.c', APP_PASSWORD: 'pw', CUSTOM_TOKEN: 'token', OTHER_LOGIN: 'other', EMPTY_TOKEN: '' };
  assert.deepEqual(signInVariableNames(env), ['APP_EMAIL', 'APP_PASSWORD', 'OTHER_LOGIN']);
  assert.deepEqual(signInVariableNames(env, ['CUSTOM_TOKEN', 'APP_PASSWORD', 'MISSING', 'CUSTOM_TOKEN', 'EMPTY_TOKEN']), ['APP_PASSWORD', 'CUSTOM_TOKEN', 'EMPTY_TOKEN']);
  assert.deepEqual(signInVariableNames(env, []), []);
});

test('the child gets PATH and the named sign-in variables, nothing else', () => {
  const env = { PATH: '/bin', HOME: '/home/me', APP_EMAIL: 'a@b.c', APP_PASSWORD: 'pw', AWS_SECRET_ACCESS_KEY: 'k', OTHER_EMAIL: 'x' };
  assert.deepEqual(childEnv(['APP_EMAIL', 'APP_PASSWORD', 'UNSET_PASS'], env, 'linux'), Object.assign(Object.create(null), { PATH: '/bin', APP_EMAIL: 'a@b.c', APP_PASSWORD: 'pw' }));
  assert.deepEqual(childEnv([], { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\u' }, 'win32'), Object.assign(Object.create(null), { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' }));
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

test('on Linux the child may read the few system files playwright-core checks for WSL and containers, and nothing else of the system', () => {
  const runDir = path.resolve('/nonexistent/repo/.stillhunter/runs/r');
  const system = (platform) => permissionArgs(runDir, [], platform).filter((a) => /^--allow-fs-read=\/(proc|run|\.dockerenv)/.test(a)).map((a) => a.slice('--allow-fs-read='.length)).sort();
  assert.deepEqual(system('linux'), [...LINUX_PLATFORM_FILES].sort());
  for (const f of LINUX_PLATFORM_FILES) assert.ok(!/[*]/.test(f) && f.split('/').length > 2 || f === '/.dockerenv', f);
  assert.deepEqual(system('darwin'), []);
  assert.deepEqual(system('win32'), []);
});

test('a kept test holding a sign-in value is caught', () => {
  const env = { APP_PASSWORD: 'hunter22', APP_EMAIL: 'me@example.com', SHORT_PASS: 'ab' };
  assert.equal(credentialIn("fill('hunter22')", ['APP_EMAIL', 'APP_PASSWORD'], env), 'APP_PASSWORD');
  assert.equal(credentialIn('fill(process.env.APP_PASSWORD)', ['APP_EMAIL', 'APP_PASSWORD'], env), null);
  assert.equal(credentialIn("x = 'ab'", ['SHORT_PASS'], env), 'SHORT_PASS');
  assert.equal(credentialIn("x = ''", ['EMPTY_PASS'], { EMPTY_PASS: '' }), null);
  assert.equal(credentialIn("fill('[session value]')", ['MARKER_PASS'], { MARKER_PASS: '[session value]' }), 'MARKER_PASS');
  assert.equal(credentialIn("fill('abcdef')", ['SHORT_PASS', 'LONG_PASS'], { SHORT_PASS: 'abc', LONG_PASS: 'abcdef' }), 'LONG_PASS');
});

test('environment selection uses only own string properties, including prototype-like names', () => {
  const inherited = Object.create({ CUSTOM_TOKEN: 'inherited', APP_PASSWORD: 'inherited' });
  assert.deepEqual(signInVariableNames(inherited, ['CUSTOM_TOKEN', 'APP_PASSWORD', 'toString']), []);
  const env = Object.create(null);
  env.toString = 'string-value';
  env.constructor = 'ctor';
  Object.defineProperty(env, '__proto__', { value: 'proto', enumerable: true });
  const names = ['toString', 'constructor', '__proto__'];
  assert.deepEqual(signInVariableNames(env, names), ['__proto__', 'constructor', 'toString']);
  const child = childEnv(names, env, 'linux');
  assert.equal(Object.getPrototypeOf(child), null);
  assert.deepEqual({ ...child }, { toString: 'string-value', constructor: 'ctor', ['__proto__']: 'proto' });
  assert.equal(credentialIn('string-value ctor proto', names, env), 'toString');
});

test('redaction masks arbitrary keys and preserves every colliding entry deterministically', () => {
  const out = redact({ abc: 'first', abcdef: { abc: 'nested' }, '[session value]': 'existing' }, ['abc', 'abcdef']);
  assert.deepEqual(out, {
    '[session value]': 'first',
    '[session value] #2': { '[session value]': 'nested' },
    '[session value] #3': 'existing',
  });
  assert.deepEqual(redact(out, ['[', '[session']), out);
});

test('schema redaction preserves fixed result and findings fields but not arbitrary map keys', () => {
  const result = redact({ requests: [], checks: [], error: null, notes: [{ label: 'n', value: { requests: 'x' } }], final: { checks: 'y' } }, ['requests', 'checks', 'error'], 'result');
  assert.deepEqual(result, { requests: [], checks: [], error: null, notes: [{ label: 'n', value: { '[session value]': 'x' } }], final: { '[session value]': 'y' } });
  const findings = redact({ confirmed: [{ title: 'safe', arbitrary: 'redact' }] }, ['confirmed', 'title', 'arbitrary'], 'findings');
  assert.deepEqual(findings, { confirmed: [{ title: 'safe', '[session value]': 'redact' }] });
});

test('redaction ignores empty values, masks every nonempty length, and applies longest first recursively', () => {
  const input = { output: 'abcdef abc Z', nested: ['abcdef', { empty: '' }] };
  const out = redact(input, ['', 'abc', 'abcdef', 'Z']);
  assert.deepEqual(out, { output: `${REDACTED} ${REDACTED} ${REDACTED}`, nested: [REDACTED, { empty: '' }] });
});

test('literal redaction handles giant values and marker prefixes without regex errors', () => {
  for (const length of [32_768, 1_000_000]) {
    const secret = 'x'.repeat(length);
    const out = redact(`before ${secret} after`, [secret]);
    assert.equal(out, `before ${REDACTED} after`);
  }
  const secrets = ['[', '[session'];
  const once = redact(`[ [session ${REDACTED}`, secrets);
  assert.equal(once, `${REDACTED} ${REDACTED} ${REDACTED}`);
  assert.equal(redact(once, secrets), once);
});

test('redaction matches secrets containing the complete marker and remains idempotent', () => {
  const secrets = ['[', '[session', '[session value]xyz', 'abc[session value]xyz'];
  const input = `before [session value]xyz abc[session value]xyz ${REDACTED} after`;
  const once = redact(input, secrets);
  assert.equal(once, `before ${REDACTED} ${REDACTED} ${REDACTED} after`);
  assert.equal(redact(once, secrets), once);
});

test('redaction represents cycles and bounds extreme depth without throwing', () => {
  const cyclic = { secret: 'abc' };
  cyclic.self = cyclic;
  assert.deepEqual(redact(cyclic, ['abc']), { secret: REDACTED, self: '[circular]' });
  let deep = {};
  const root = deep;
  for (let i = 0; i < 10_000; i++) {
    deep.next = {};
    deep = deep.next;
  }
  const out = redact(root, ['abc']);
  assert.ok(JSON.stringify(out).includes('[depth exceeded]'));
});

test('redaction does not reprocess replacement markers with shorter secrets', () => {
  const secrets = ['a', 'abcdef'];
  const once = redact('abcdef a', secrets);
  assert.equal(once, `${REDACTED} ${REDACTED}`);
  assert.equal(redact(once, secrets), once);
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
