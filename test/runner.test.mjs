import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUNT = path.join(ROOT, 'dist', 'hunt.mjs');
const run = (args, opts = {}) => spawnSync(process.execPath, [HUNT, ...args], { encoding: 'utf8', ...opts });

test('outside a git repository, start stops with a block saying why', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run(['start'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^--- stillhunter \(copy this block unchanged\) ---\nstillhunter \| stopped\nNot inside a git repository\.\n--- end of stillhunter ---\n$/);
});

test('with no app running and no target, start says to start the dev server', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-noapp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, 'page.html'), '<p>new</p>\n');
  const r = run(['start'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No running app found/);
});

test('start and replay redact selected values in early target errors', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-target-redaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, 'page.html'), '<p>new</p>\n');
  const testDir = path.join(dir, '.stillhunter', 'tests', 'example');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, 'test.mjs'), 'export default async function (rr) { rr.expect("check", true); }\n');
  writeFileSync(path.join(testDir, 'test.json'), JSON.stringify({ check: 'check', title: 'Example', severity: 'low', keptFrom: { run: 'x', probe: 'x' } }));
  const secret = 'target-secret-77';
  const env = { ...process.env, TARGET_PASSWORD: secret };
  const configFile = path.join(dir, '.stillhunter', 'config.json');
  const writeTarget = (url) => writeFileSync(configFile, JSON.stringify({ target: { url }, auth: { env: ['TARGET_PASSWORD'] } }));

  writeTarget(`http://127.0.0.1:1/${secret}`);
  for (const command of ['start', 'replay']) {
    const r = run([command], { cwd: dir, env });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /Nothing answers at http:\/\/127\.0\.0\.1:1\/\[session value\]\./);
    assert.ok(!r.stdout.includes(secret), r.stdout);
  }

  writeTarget(`http://${secret}@127.0.0.1:1/`);
  for (const command of ['start', 'replay']) {
    const r = run([command], { cwd: dir, env });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /target must be loopback or an exact hosts\.allow entry/);
    assert.ok(!r.stdout.includes(secret), r.stdout);
  }
});

test('with no change and no focus, start asks for a feature to hunt', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-nochange-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = run(['start'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No change found\. Name a feature to hunt, for example: \/stillhunter:hunt the checkout flow/);
  assert.match(run(['start', '--depth', 'forever'], { cwd: dir }).stdout, /--depth is quick, default or deep/);
});

test('start and replay argument errors redact configured and discovered credentials without masking flag validation', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-argument-redaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const testDir = path.join(dir, '.stillhunter', 'tests', 'example');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, 'test.mjs'), 'export default async function (rr) { rr.expect("check", true); }\n');
  writeFileSync(path.join(testDir, 'test.json'), JSON.stringify({ check: 'check', title: 'Example', severity: 'low', keptFrom: { run: 'x', probe: 'x' } }));
  const configured = 'configured-arg-secret-77';
  const discovered = 'discovered-arg-secret-88';
  const env = { ...process.env, CONFIGURED_TOKEN: configured, EARLY_PASSWORD: discovered };
  const configFile = path.join(dir, '.stillhunter', 'config.json');
  writeFileSync(configFile, JSON.stringify({ auth: { env: ['CONFIGURED_TOKEN'] } }));

  for (const [args, message] of [
    [['start', '--minutes', configured], '--minutes is a whole number from 1 to 120, not "[session value]".'],
    [['start', '--depth', discovered], '--depth is quick, default or deep, not "[session value]".'],
    [['replay', `--${configured}`], 'Unknown replay option --[session value].'],
    [['replay', discovered], 'No kept test named [session value].'],
  ]) {
    const r = run(args, { cwd: dir, env });
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stdout.includes(message), r.stdout);
    assert.ok(!r.stdout.includes(configured), r.stdout);
    assert.ok(!r.stdout.includes(discovered), r.stdout);
  }

  writeFileSync(configFile, '{ invalid JSON');
  const original = run(['start', '--minutes', discovered], { cwd: dir, env });
  assert.equal(original.status, 1, original.stdout);
  assert.match(original.stdout, /--minutes is a whole number from 1 to 120, not "\[session value\]"/);
  assert.doesNotMatch(original.stdout, /Invalid \.stillhunter\/config\.json/);
  assert.ok(!original.stdout.includes(discovered), original.stdout);
});

test('keep unknown-finding errors redact the requested check and confirmed checks', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-keep-error-redaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const runId = '20260101-000000-hunt-abcd';
  const runDir = path.join(dir, '.stillhunter', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const configured = 'configured-check-secret-77';
  const discovered = 'discovered-check-secret-88';
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ auth: { env: ['CONFIGURED_TOKEN'] } }));
  writeFileSync(path.join(runDir, 'context.json'), JSON.stringify({ runId, signInVariables: ['CONFIGURED_TOKEN', 'EARLY_PASSWORD'] }));
  writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify({ confirmed: [{ probe: 'example', check: discovered, title: 'Example', severity: 'low' }] }));
  const env = { ...process.env, CONFIGURED_TOKEN: configured, EARLY_PASSWORD: discovered };
  const r = run(['keep', '--run', runId, '--probe', 'example', '--check', configured], { cwd: dir, env });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /expectation "\[session value\]"\. Confirmed: --probe "example" --check "\[session value\]"/);
  assert.ok(!r.stdout.includes(configured), r.stdout);
  assert.ok(!r.stdout.includes(discovered), r.stdout);
});

test('controlled CLI errors redact giant credentials without throwing', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-giant-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.stillhunter'));
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ auth: { env: ['GIANT_TOKEN'] } }));
  const secret = 'x'.repeat(40_000);
  const r = run(['start', '--minutes', secret], { cwd: dir, env: { ...process.env, GIANT_TOKEN: secret } });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /--minutes is a whole number from 1 to 120, not "\[session value\]"/);
  assert.ok(!r.stdout.includes(secret));
});

test('controlled CLI errors redact credentials containing the complete marker', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-marker-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.stillhunter'));
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ auth: { env: ['MARKER_TOKEN'] } }));
  const secret = 'abc[session value]xyz';
  const r = run(['start', '--minutes', secret], { cwd: dir, env: { ...process.env, MARKER_TOKEN: secret } });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /--minutes is a whole number from 1 to 120, not "\[session value\]"/);
  assert.ok(!r.stdout.includes(secret), r.stdout);
});

test('keep and replay reject a legacy kept sign-in after auth.env expands', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-legacy-signin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const runId = '20260101-000000-hunt-abcd';
  const runDir = path.join(dir, '.stillhunter', 'runs', runId);
  const probes = path.join(runDir, 'probes');
  const tests = path.join(dir, '.stillhunter', 'tests');
  mkdirSync(probes, { recursive: true });
  mkdirSync(path.join(tests, 'example'), { recursive: true });
  const secret = 'expanded-signin-secret-77';
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: 'http://127.0.0.1:1' }, auth: { env: ['NEW_TOKEN'] } }));
  writeFileSync(path.join(runDir, 'context.json'), JSON.stringify({ runId, signInVariables: [] }));
  writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify({ confirmed: [{ probe: 'example', check: 'check', title: 'Example', severity: 'low' }] }));
  writeFileSync(path.join(probes, 'example.mjs'), 'export default async function (rr) { rr.expect("check", true); }\n');
  writeFileSync(path.join(probes, 'signin.mjs'), 'export default async function (rr) {}\n');
  writeFileSync(path.join(probes, 'signin.result.json'), JSON.stringify({ savedSession: true, finishedAt: 1, error: null }));
  writeFileSync(path.join(tests, '_signin.mjs'), `const credential = '${secret}';\nexport default async function (rr) {}\n`);
  writeFileSync(path.join(tests, 'example', 'test.mjs'), 'export default async function (rr) { rr.expect("check", true); }\n');
  writeFileSync(path.join(tests, 'example', 'test.json'), JSON.stringify({ check: 'check', title: 'Example', severity: 'low', keptFrom: { run: runId, probe: 'example' } }));
  const env = { ...process.env, NEW_TOKEN: secret };
  const replay = run(['replay'], { cwd: dir, env });
  const kept = run(['keep', '--run', runId, '--probe', 'example', '--check', 'check', '--as', 'kept'], { cwd: dir, env });
  for (const r of [replay, kept]) {
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /sign-in.*NEW_TOKEN/);
    assert.ok(!r.stdout.includes(secret), r.stdout);
  }
});

test('keep and replay reject legacy ordinary scripts after auth.env expands', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-legacy-ordinary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const runId = '20260101-000000-hunt-abcd';
  const runDir = path.join(dir, '.stillhunter', 'runs', runId);
  const probes = path.join(runDir, 'probes');
  const testDir = path.join(dir, '.stillhunter', 'tests', 'example');
  mkdirSync(probes, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  const secret = 'expanded-ordinary-secret-77';
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ target: { url: 'http://127.0.0.1:1' }, auth: { env: ['NEW_TOKEN'] } }));
  writeFileSync(path.join(runDir, 'context.json'), JSON.stringify({ runId, signInVariables: [] }));
  writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify({ confirmed: [{ probe: 'example', check: 'check', title: 'Example', severity: 'low' }] }));
  const script = `const credential = '${secret}';\nexport default async function (rr) { rr.expect("check", true); }\n`;
  writeFileSync(path.join(probes, 'example.mjs'), script);
  writeFileSync(path.join(testDir, 'test.mjs'), script);
  writeFileSync(path.join(testDir, 'test.json'), JSON.stringify({ check: 'check', title: 'Example', severity: 'low', keptFrom: { run: runId, probe: 'example' } }));
  const env = { ...process.env, NEW_TOKEN: secret };
  const replay = run(['replay'], { cwd: dir, env });
  const kept = run(['keep', '--run', runId, '--probe', 'example', '--check', 'check', '--as', 'kept'], { cwd: dir, env });
  for (const r of [replay, kept]) {
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /NEW_TOKEN/);
    assert.ok(!r.stdout.includes(secret), r.stdout);
  }
  assert.equal(existsSync(path.join(dir, '.stillhunter', 'tests', 'kept', 'test.mjs')), false);
});

test('keep success output redacts finding metadata', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-keep-success-redaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const runId = '20260101-000000-hunt-abcd';
  const runDir = path.join(dir, '.stillhunter', 'runs', runId);
  mkdirSync(path.join(runDir, 'probes'), { recursive: true });
  const secret = 'keep-title-secret-77';
  writeFileSync(path.join(dir, '.stillhunter', 'config.json'), JSON.stringify({ auth: { env: ['CUSTOM_TOKEN'] } }));
  writeFileSync(path.join(runDir, 'context.json'), JSON.stringify({ runId, signInVariables: ['CUSTOM_TOKEN'] }));
  writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify({ confirmed: [{ probe: 'example', check: 'check', title: `Finding ${secret}`, severity: 'low' }] }));
  writeFileSync(path.join(runDir, 'probes', 'example.mjs'), 'export default async function (rr) { rr.expect("check", true); }\n');
  const r = run(['keep', '--run', runId, '--probe', 'example', '--check', 'check', '--as', 'kept'], { cwd: dir, env: { ...process.env, CUSTOM_TOKEN: secret } });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Finding \[session value\]/);
  assert.ok(!r.stdout.includes(secret), r.stdout);
});

test('probe and finish refuse a missing or malformed run id', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-ids-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.match(run(['probe', '--run', 'nope', '--name', 'p'], { cwd: dir, input: 'export default async () => {}' }).stdout, /Give the run id/);
  assert.match(run(['finish', '--run', '20260101-000000-hunt-abcd'], { cwd: dir, input: '{}' }).stdout, /No hunt run 20260101-000000-hunt-abcd/);
  assert.match(run(['keep', '--run', '20260101-000000-hunt-abcd', '--probe', 'p', '--check', 'c'], { cwd: dir }).stdout, /No hunt run/);
  assert.match(run(['replay'], { cwd: dir }).stdout, /No kept tests in \.stillhunter\/tests\//);
  assert.match(run(['bogus'], { cwd: dir }).stdout, /Usage:/);
});

test('diff lists the change, prints one file whole, and refuses paths outside it', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-diff-')));
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-diff-outside-')));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'big.css'), '.a { color: red; }\n');
    writeFileSync(path.join(dir, 'same.js'), 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // Larger than start's 60 KB cap, so only diff shows the whole of it.
    const big = Array.from({ length: 3000 }, (_, i) => `.rule-${i} { color: blue; }`).join('\n') + '\n';
    writeFileSync(path.join(dir, 'big.css'), big);
    writeFileSync(path.join(dir, 'new.vue'), '<template><p>Hi</p></template>\n');
    writeFileSync(path.join(outside, 'secret.txt'), 'not for the hunter\n');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
    mkdirSync(path.join(dir, '.stillhunter', 'runs', 'r'), { recursive: true });
    writeFileSync(path.join(dir, '.stillhunter', 'runs', 'r', 'session.json'), '{}');
    // Secret files the guard keeps from the hunter's Read: untracked and not
    // ignored, or tracked and changed. Only their names are printed.
    writeFileSync(path.join(dir, '.env'), 'SECRET_VALUE=not-for-the-hunter\n');
    mkdirSync(path.join(dir, 'certs'));
    writeFileSync(path.join(dir, 'certs', 'dev.pem'), 'not-for-the-hunter\n');
    // Larger than diff's own 1 MB cap.
    writeFileSync(path.join(dir, 'huge.txt'), 'y'.repeat(1024 * 1024 + 5000) + '\n');

    const list = run(['diff'], { cwd: dir });
    assert.equal(list.status, 0, list.stdout);
    assert.match(list.stdout, /^M +big\.css \(\d+ KB\)$/m);
    assert.match(list.stdout, /^A \(untracked\) +new\.vue \(1 KB\)$/m);
    assert.doesNotMatch(list.stdout, /same\.js|session\.json/);
    assert.match(list.stdout, /^A \(untracked\) +\.env \(1 KB\)$/m);

    const whole = run(['diff', '--file', 'big.css'], { cwd: dir });
    assert.equal(whole.status, 0, whole.stdout);
    assert.match(whole.stdout, /\+\.rule-0 \{ color: blue; \}/);
    assert.match(whole.stdout, /\+\.rule-2999 \{ color: blue; \}/);
    assert.ok(whole.stdout.length > 60 * 1024);
    assert.match(run(['diff', '--file', path.join(dir, 'new.vue')], { cwd: dir }).stdout, /=== untracked file: new\.vue ===\n<template><p>Hi<\/p><\/template>/);
    const huge = run(['diff', '--file', 'huge.txt'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(huge.status, 0);
    assert.match(huge.stdout, /\ny{1000}/);
    assert.match(huge.stdout, /\(cut at 1024 KB of 1029 KB\)/);
    assert.ok(huge.stdout.length < 1024 * 1024 + 1000, String(huge.stdout.length));

    for (const [file, why] of [
      [path.join(outside, 'secret.txt'), /outside the repository/],
      ['../' + path.basename(outside) + '/secret.txt', /outside the repository/],
      ['link.txt', /outside the repository/],
      ['.stillhunter/runs/r/session.json', /runner's own folder/],
      ['.STILLHUNTER/runs/r/session.json', /runner's own folder|outside the repository|not in the change/],
      ['same.js', /not in the change/],
      ['.env', /secret file/],
      ['certs/dev.pem', /secret file/],
      ['missing/nothing.js', /not in the change/],
    ]) {
      const r = run(['diff', '--file', file], { cwd: dir });
      assert.equal(r.status, 1, `${file}: ${r.stdout}`);
      assert.match(r.stdout, why, file);
      assert.doesNotMatch(r.stdout, /not for the hunter|not-for-the-hunter|\{\}/, file);
    }
    assert.match(run(['diff', '--file'], { cwd: dir }).stdout, /Usage: diff \[--file <path>\]/);
    assert.match(run(['diff', 'big.css'], { cwd: dir }).stdout, /Usage: diff \[--file <path>\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the plugin ships the hunt, keep and replay skills and one agent, and names them consistently', () => {
  assert.deepEqual(readdirSync(path.join(ROOT, 'skills')).sort(), ['hunt', 'keep', 'replay']);
  const skill = (name) => readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  const hunt = skill('hunt');
  assert.match(hunt, /^agent: stillhunter:hunter$/m);
  // The hunt skill pre-approves only start, probe, finish and diff (not keep
  // or replay, which the person asks for), and no other command.
  for (const sub of ['start', 'probe', 'finish', 'diff']) assert.match(hunt, new RegExp(`Bash\\(node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/dist/hunt\\.mjs" ${sub} \\*\\)`), sub);
  assert.doesNotMatch(hunt, /dist\/hunt\.mjs" \*\)/);
  assert.deepEqual([...hunt.matchAll(/^  - Bash\((.*)\)$/gm)].map((m) => m[1].replace(/ \*$/, '').split(' ').at(-1)), ['start', 'probe', 'finish', 'diff', 'diff']);
  assert.doesNotMatch(hunt + readFileSync(path.join(ROOT, 'agents', 'hunter.md'), 'utf8'), /git diff/);
  for (const name of ['hunt', 'keep', 'replay']) {
    assert.match(skill(name), new RegExp(`^name: ${name}$`, 'm'));
    assert.match(skill(name), /\$ARGUMENTS/, `${name} passes on what the person typed`);
  }
  assert.match(skill('keep'), /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hunt\.mjs" keep \*\)/);
  assert.match(skill('replay'), /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hunt\.mjs" replay\b/);
  const agent = readFileSync(path.join(ROOT, 'agents', 'hunter.md'), 'utf8');
  assert.match(agent, /^name: hunter$/m);
  assert.doesNotMatch(hunt + skill('keep') + skill('replay') + agent, /rough-ride|\u2014/);
  const plugin = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(plugin.name, 'stillhunter');
  assert.equal(plugin.version, pkg.version);
});

// The hunter is measured on bugs planted in benchmark/apps; its instructions
// must not describe any of them.
test('the hunter\'s instructions name no planted bug', () => {
  const text = ['agents/hunter.md', 'skills/hunt/SKILL.md'].map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const apps = path.join(ROOT, 'benchmark', 'apps');
  const manifests = readdirSync(apps).flatMap((app) => {
    const features = path.join(apps, app, 'features');
    return readdirSync(features).flatMap((f) => readdirSync(path.join(features, f, 'bugs')).map((b) => readFileSync(path.join(features, f, 'bugs', b, 'manifest.yaml'), 'utf8')));
  });
  assert.ok(manifests.length >= 10);
  for (const m of manifests) {
    const id = /^id: (.+)$/m.exec(m)[1].trim();
    assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`, 'i'), id);
    for (const [, quoted] of (/^symptom: "(.*)"$/m.exec(m)?.[1] ?? '').matchAll(/'([^']{4,})'/g)) assert.ok(!text.toLowerCase().includes(quoted.toLowerCase()), quoted);
  }
  const shapes = /apostrophe|o'brien|double-click|out of order|negative|reload|back button|query param|inclusive|end date|a total|harvest|journal|water|litre|tomato|\bbeds?\b|\bstats\b|columns|spaces only|presented as an empty|shown as empty|values stay|newest one wins/i;
  assert.doesNotMatch(text, shapes);
});
