import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { capSections, changeText, collectChange, ensureRunsIgnored, SECRET_BODY, sectionNames } from '../dist/change.mjs';
import { secretFile } from '../dist/common.mjs';
import { secretPath } from '../hooks/guard.mjs';

const section = (file, size) => ({ file, header: `diff --git a/${file} b/${file}`, body: `${'x'.repeat(size - 1)}\n` });

test('a change under the cap is printed whole', () => {
  const { text, cut } = capSections([section('a.css', 100), section('b.vue', 200)], 1000);
  assert.deepEqual(cut, []);
  assert.equal(text.length, 300 + 'diff --git a/a.css b/a.css\n'.length + 'diff --git a/b.vue b/b.vue\n'.length);
});

test('over the cap the largest bodies go first, and every file keeps its name', () => {
  const { text, cut } = capSections([section('small.css', 100), section('huge.lock', 5000), section('mid.vue', 900), section('big.py', 3000)], 2000);
  assert.deepEqual(cut.map((c) => c.file), ['huge.lock', 'big.py']);
  for (const f of ['small.css', 'huge.lock', 'mid.vue', 'big.py']) assert.match(text, new RegExp(`diff --git a/${f.replace('.', '\\.')}`));
  assert.match(text, /mid\.vue\nx{899}\n/);
  assert.ok(Buffer.byteLength(text) <= 2000 + 200);
});

test('changeText says what was cut and how to read it', () => {
  const lines = changeText({ files: [], sections: [section('a', 50 * 1024), section('b', 30 * 1024)], empty: false });
  assert.match(lines[0], /The change is 80 KB; to fit 60 KB the bodies of the largest files were left out: a \(50 KB\)\./);
  assert.match(lines[1], /the runner's `diff --file <file>`/);
});

test('the change is the diff of tracked files plus untracked files, without .stillhunter', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-change-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'app.css'), 'a { color: red; }\n');
  writeFileSync(path.join(dir, '.npmrc'), 'registry=x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  assert.equal(collectChange(dir, base).empty, true);
  writeFileSync(path.join(dir, 'app.css'), 'a { color: blue; }\n');
  writeFileSync(path.join(dir, '.npmrc'), '//registry/:_authToken=not-for-the-hunter\n');
  writeFileSync(path.join(dir, '.env.local'), 'TOKEN=not-for-the-hunter\n');
  writeFileSync(path.join(dir, 'new.vue'), '<template><p>Hi</p></template>\n');
  writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  const outside = mkdtempSync(path.join(tmpdir(), 'sh-change-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'secret.txt'), 'not for the hunter\n');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  mkdirSync(path.join(dir, '.stillhunter', 'specs'), { recursive: true });
  writeFileSync(path.join(dir, '.stillhunter', 'specs', 'request.txt'), 'spec');
  const c = collectChange(dir, base);
  assert.equal(c.empty, false);
  assert.deepEqual(c.files, ['M\t.npmrc', 'M\tapp.css', 'A (untracked)\t.env.local', 'A (untracked)\tlink.txt', 'A (untracked)\tlogo.bin', 'A (untracked)\tnew.vue']);
  const text = changeText(c).join('\n');
  assert.match(text, /\+a \{ color: blue; \}/);
  assert.match(text, /=== untracked file: new\.vue ===\n<template><p>Hi<\/p><\/template>/);
  assert.match(text, /=== untracked file: logo\.bin ===\n\(binary file, 4 bytes\)/);
  assert.doesNotMatch(text, /spec/);
  // A link is shown as a link, never the file it points to.
  assert.match(text, /=== untracked file: link\.txt ===\n\(symbolic link to .*secret\.txt\)/);
  assert.doesNotMatch(text, /not for the hunter/);
  // Secret files are named, and their bodies left out, tracked or not.
  assert.ok(text.includes(`diff --git a/.npmrc b/.npmrc\n${SECRET_BODY}`), text);
  assert.ok(text.includes(`=== untracked file: .env.local ===\n${SECRET_BODY}`), text);
  assert.doesNotMatch(text, /not-for-the-hunter/);
});

test('a secret file is left out whatever its name looks like, and a renamed one on either side', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-change-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  const key = (n) => Array.from({ length: 12 }, (_, i) => `KEY-BODY-${n}-${i}`).join('\n') + '\n';
  git('init', '-q');
  writeFileSync(path.join(dir, 'café.pem'), key(1));
  writeFileSync(path.join(dir, 'dev.key'), key(2));
  writeFileSync(path.join(dir, 'résumé.vue'), '<p>old</p>\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(path.join(dir, 'café.pem'), key(1).replace('-0\n', '-0 changed\n'));
  // A key renamed to an ordinary name, and changed: its old side is a secret.
  git('mv', 'dev.key', 'notes.txt');
  writeFileSync(path.join(dir, 'notes.txt'), key(2).replace('-0\n', '-0 changed\n'));
  git('add', '-A');
  writeFileSync(path.join(dir, 'résumé.vue'), '<p>new</p>\n');
  writeFileSync(path.join(dir, 'naïve.key'), key(3));
  const c = collectChange(dir, base);
  const text = changeText(c).join('\n');
  assert.doesNotMatch(text, /KEY-BODY/, text);
  assert.ok(text.includes(`diff --git a/café.pem b/café.pem\n${SECRET_BODY}`), text);
  assert.ok(text.includes(`=== untracked file: naïve.key ===\n${SECRET_BODY.trimEnd()}`), text);
  assert.match(text, /diff --git a\/dev\.key b\/notes\.txt\n\(left out/);
  // A name that is not ASCII is shown as typed, not quoted, and its diff read.
  assert.match(text, /diff --git a\/résumé\.vue b\/résumé\.vue\n[^]*\+<p>new<\/p>/);
  assert.ok(c.files.includes('M\trésumé.vue'), c.files.join('|'));
});

test('a diff section\'s names are read from every header line, quoted or not', () => {
  const names = (chunk) => sectionNames(chunk);
  assert.deepEqual(names('diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n'), { new: 'y', all: ['y', 'x', 'y', 'x', 'y'], unread: false });
  assert.deepEqual(names('diff --git "a/we\\"ird.key" "b/we\\"ird.key"\nindex 1..2 100644\n--- "a/we\\"ird.key"\n+++ "b/we\\"ird.key"\n@@ -1 +1 @@\n'), { new: 'we"ird.key', all: ['we"ird.key', 'we"ird.key', 'we"ird.key'], unread: false });
  assert.deepEqual(names('diff --git "a/tab\\there" "b/tab\\there"\n').new, 'tab\there');
  assert.equal(names('diff --git a/new.vue b/new.vue\nnew file mode 100644\n--- /dev/null\n+++ b/new.vue\n@@ -0,0 +1 @@\n+@@ not a header\n').all.length, 2);
  assert.equal(names('diff --git nonsense\n').unread, true);
});

test('the runner and the guard agree on which files are secret', () => {
  const cases = ['.env', 'web/.env.production', '.npmrc', 'a/.netrc', '.pgpass', 'x/session.json', 'certs/dev.pem', 'k/server.KEY', 'c.p12', 'c.pfx', '.ssh/config', 'home/.aws/credentials', '.gnupg/x', '.git/config',
    'src/app.ts', 'env.ts', 'docs/environment.md', 'keys.ts', 'pem.txt', 'web/sessions.json', '.github/workflows/ci.yml'];
  for (const f of cases) assert.equal(secretFile(f), secretPath(f, '/repo'), f);
  assert.equal(cases.filter((f) => secretFile(f)).length, 14);
});

test('.stillhunter/.gitignore always ignores /runs/', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-ignore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.gitignore');
  ensureRunsIgnored(file);
  assert.equal(readFileSync(file, 'utf8'), '/.env\n/.env.*\n/runs/\n');
  writeFileSync(file, '/.env');
  ensureRunsIgnored(file);
  assert.equal(readFileSync(file, 'utf8'), '/.env\n/runs/\n');
  ensureRunsIgnored(file);
  assert.equal(readFileSync(file, 'utf8'), '/.env\n/runs/\n');
  writeFileSync(file, 'runs/\n');
  ensureRunsIgnored(file);
  assert.equal(readFileSync(file, 'utf8'), 'runs/\n');
});
