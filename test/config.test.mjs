import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from '../dist/common.mjs';

const COMMON = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'common.mjs')).href;
const DEFAULT_VERIFICATION = { attempts: 3, confirm: 2, nonReproduce: 2 };

function configRoot(t, value, raw = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'sh-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.stillhunter'));
  writeFileSync(path.join(root, '.stillhunter', 'config.json'), raw ? value : JSON.stringify(value));
  return root;
}

function readError(root, env = {}) {
  return spawnSync(process.execPath, [
    '--input-type=module', '--eval',
    `import { readConfig } from ${JSON.stringify(COMMON)}; readConfig(process.argv[1]);`,
    root,
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('an absent config preserves the verification defaults', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sh-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readConfig(root), { verification: DEFAULT_VERIFICATION });
});

test('a valid legacy config keeps its target and browser and normalizes reset', (t) => {
  const root = configRoot(t, {
    target: { url: 'http://localhost:3000' },
    browser: 'chrome',
    reset: 'npm run reset',
  });
  assert.deepEqual(readConfig(root), {
    target: { url: 'http://localhost:3000' },
    browser: 'chrome',
    reset: { command: 'npm run reset', strategy: 'always' },
    verification: DEFAULT_VERIFICATION,
  });
});

test('a legacy empty reset remains a no-op', (t) => {
  const root = configRoot(t, { reset: '' });
  assert.deepEqual(readConfig(root), { verification: DEFAULT_VERIFICATION });
});

test('all additive sections are parsed and a reset object defaults to always', (t) => {
  const root = configRoot(t, {
    hosts: { allow: ['localhost:3000', 'staging.example.test:443'] },
    auth: { env: ['SHFIX_EMAIL', 'SHFIX_PASSWORD'] },
    reset: { command: 'npm run reset', strategy: 'proof' },
    verification: { attempts: 5, confirm: 3, nonReproduce: 2 },
  });
  assert.deepEqual(readConfig(root), {
    hosts: { allow: ['localhost:3000', 'staging.example.test:443'] },
    auth: { env: ['SHFIX_EMAIL', 'SHFIX_PASSWORD'] },
    reset: { command: 'npm run reset', strategy: 'proof' },
    verification: { attempts: 5, confirm: 3, nonReproduce: 2 },
  });

  const defaultStrategy = configRoot(t, { reset: { command: 'npm run reset' } });
  assert.deepEqual(readConfig(defaultStrategy).reset, { command: 'npm run reset', strategy: 'always' });
});

test('individual verification settings retain their defaults', (t) => {
  const root = configRoot(t, { verification: { attempts: 4 } });
  assert.deepEqual(readConfig(root).verification, { attempts: 4, confirm: 2, nonReproduce: 2 });
});

const malformed = [
  [(secret) => [secret], 'config', 'must be an object'],
  [(secret) => ({ target: [secret] }), 'target', 'must be an object'],
  [(secret) => ({ target: { url: { secret } } }), 'target.url', 'must be a string'],
  [(secret) => ({ browser: secret }), 'browser', 'chrome, msedge, chromium'],
  [(secret) => ({ hosts: { allow: secret } }), 'hosts.allow', 'must be an array of strings'],
  [(secret) => ({ hosts: { allow: ['localhost', [secret]] } }), 'hosts.allow[1]', 'must be a string'],
  [(secret) => ({ hosts: {}, auth: { env: [secret] } }), 'hosts.allow', 'must be an array of strings'],
  [(secret) => ({ auth: { env: [[secret]] } }), 'auth.env[0]', 'must be a string'],
  [() => ({ auth: { env: ['BAD-NAME'] } }), 'auth.env[0]', 'environment variable identifier'],
  [() => ({ auth: { env: ['1BAD'] } }), 'auth.env[0]', 'environment variable identifier'],
  [() => ({ auth: { env: [''] } }), 'auth.env[0]', 'environment variable identifier'],
  [(secret) => ({ auth: {}, hosts: { allow: [secret] } }), 'auth.env', 'must be an array of strings'],
  [(secret) => ({ reset: [secret] }), 'reset', 'must be a shell command string or an object'],
  [() => ({ reset: {}, auth: { env: ['VALID_TOKEN'] } }), 'reset.command', 'must be a string'],
  [() => ({ reset: { command: '' }, auth: { env: ['VALID_TOKEN'] } }), 'reset.command', 'must not be empty'],
  [() => ({ reset: { command: ' \t ' }, auth: { env: ['VALID_TOKEN'] } }), 'reset.command', 'must not be empty'],
  [(secret) => ({ reset: { command: 'npm run reset', strategy: secret } }), 'reset.strategy', 'always, proof'],
  [(secret) => ({ verification: [secret] }), 'verification', 'must be an object'],
  [(secret) => ({ verification: { attempts: secret } }), 'verification.attempts', 'positive integer'],
  [(secret) => ({ verification: { confirm: { secret } } }), 'verification.confirm', 'positive integer'],
  [(secret) => ({ verification: { nonReproduce: [secret] } }), 'verification.nonReproduce', 'positive integer'],
];

for (const [index, [makeValue, field, expected]] of malformed.entries()) {
  test(`malformed ${field} stops with an actionable field error`, (t) => {
    const sentinel = `semantic-sentinel-${index}`;
    const root = configRoot(t, makeValue(sentinel));
    const r = readError(root);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /stillhunter \| stopped/);
    assert.ok(r.stdout.includes(`Invalid .stillhunter/config.json: "${field}"`), r.stdout);
    assert.ok(r.stdout.includes(expected), r.stdout);
    assert.ok(!r.stdout.includes(sentinel), r.stdout);
  });
}

const unknown = [
  [(secret) => ({ host: { allow: [secret] } }), 'host', 'target, browser, hosts, auth, reset, verification'],
  [(secret) => ({ target: { host: secret } }), 'target.host', 'url'],
  [(secret) => ({ hosts: { allowed: [secret] } }), 'hosts.allowed', 'allow'],
  [(secret) => ({ auth: { variables: [secret] } }), 'auth.variables', 'env'],
  [(secret) => ({ reset: { command: 'npm run reset', mode: secret } }), 'reset.mode', 'command, strategy'],
  [(secret) => ({ verification: { retries: secret } }), 'verification.retries', 'attempts, confirm, nonReproduce'],
];

test('semantic config errors redact configured credential values in unknown keys', (t) => {
  const secret = 'semantic-config-secret-77';
  const root = configRoot(t, { auth: { env: ['CUSTOM_TOKEN'] }, [secret]: true });
  const r = readError(root, { CUSTOM_TOKEN: secret });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.includes('Invalid .stillhunter/config.json: unknown key "[session value]".'), r.stdout);
  assert.ok(!r.stdout.includes(secret), r.stdout);
});

for (const [index, [makeValue, field, allowed]] of unknown.entries()) {
  test(`unknown key ${field} is rejected with the allowed keys`, (t) => {
    const sentinel = `unknown-sentinel-${index}`;
    const root = configRoot(t, makeValue(sentinel));
    const r = readError(root);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, '');
    assert.ok(r.stdout.includes(`Invalid .stillhunter/config.json: unknown key "${field}".`), r.stdout);
    assert.ok(r.stdout.includes(`Allowed keys: ${allowed}.`), r.stdout);
    assert.ok(!r.stdout.includes(sentinel), r.stdout);
  });
}

test('invalid JSON retains a controlled parse error', (t) => {
  const root = configRoot(t, '{ "reset": ', true);
  const r = readError(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /stillhunter \| stopped/);
  assert.match(r.stdout, /\.stillhunter\/config\.json is not valid JSON:/);
});

test('invalid JSON errors do not echo config values', (t) => {
  const secret = 'sh-secret';
  const root = configRoot(t, `{ "password": ${secret} }`, true);
  const r = readError(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /\.stillhunter\/config\.json is not valid JSON:/);
  assert.ok(!r.stdout.includes(secret), r.stdout);
});

test('an unreadable config gets separate actionable read guidance', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sh-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.stillhunter', 'config.json'), { recursive: true });
  const r = readError(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /stillhunter \| stopped/);
  assert.match(r.stdout, /\.stillhunter\/config\.json cannot be read: check that it is a readable file\./);
  assert.doesNotMatch(r.stdout, /is not valid JSON/);
});
