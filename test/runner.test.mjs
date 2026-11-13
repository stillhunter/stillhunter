import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('with no change and no focus, start asks for a feature to hunt', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-nochange-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = run(['start'], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No change found\. Name a feature to hunt, for example: \/stillhunter:hunt the checkout flow/);
  assert.match(run(['start', '--depth', 'forever'], { cwd: dir }).stdout, /--depth is quick, default or deep/);
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
