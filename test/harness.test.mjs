// The comparison harness runs the stillhunter arm from a packed copy of the
// plugin outside the repository, so the hunter has no path to the benchmark's
// answer key, and it counts a run that left no report as failed. These check
// the folder it is handed, what it packs, the claude call it makes and how it
// reads and reports each run, all offline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_ARMS, checkPluginDir, outsideRepo, REPO, runClaude, seed, VARIANTS } from '../benchmark/comparison/lib.mjs';
import { findingsFileState, huntFindings, huntFinishes, prepareTrial, SEED } from '../benchmark/comparison/trial.mjs';
import { baseRef, collectChange } from '../dist/change.mjs';

const PLUGIN_FILES = ['.claude-plugin/plugin.json', 'dist/hunt.mjs', 'hooks/guard.mjs', 'node_modules/playwright-core/package.json'];

function fakePlugin(dir) {
  for (const f of PLUGIN_FILES) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), '{}');
  }
  return dir;
}

test('the stillhunter arm runs only from a plugin folder outside the repository with no benchmark folder', (t) => {
  assert.ok(!outsideRepo(REPO));
  assert.ok(!outsideRepo(path.join(REPO, 'benchmark', 'comparison')));
  assert.throws(() => checkPluginDir(REPO), /inside the repository/);

  const dir = mkdtempSync(path.join(tmpdir(), 'sh-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.ok(outsideRepo(dir));
  assert.throws(() => checkPluginDir(dir), /has no \.claude-plugin\/plugin\.json/);
  fakePlugin(dir);
  assert.equal(checkPluginDir(dir), dir);
  mkdirSync(path.join(dir, 'benchmark', 'apps'), { recursive: true });
  assert.throws(() => checkPluginDir(dir), /holds a benchmark folder/);
});

test('the package the harness packs holds no benchmark, test or source folder', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  assert.ok(files.includes('dist/hunt.mjs') && files.includes('hooks/guard.mjs') && files.includes('agents/hunter.md'), files.join(', '));
  assert.deepEqual(files.filter((f) => /^(benchmark|test|src|docs)\//.test(f)), []);
});

test('the claude call gets the checked plugin folder, never the repository', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = fakePlugin(path.join(dir, 'plugin'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // Stands in for claude: it records its arguments and answers at once.
  writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log('{}');\n`);
  chmodSync(path.join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const call = { cwd: dir, arm: 'stillhunter', text: '/stillhunter:hunt', sessionId: 's', outDir: dir, mcpFile: null };
  const r = await runClaude({ ...call, pluginDir: plugin });
  assert.equal(r.code, 0, r.stderr);
  const args = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--plugin-dir') + 1], plugin);
  assert.throws(() => runClaude({ ...call, pluginDir: REPO }), /inside the repository/);
});

test('each hunt run\'s findings.json is read for its findings and its finish, and a missing or broken one is a failed run', (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'sh-trial-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const runs = path.join(repo, '.stillhunter', 'runs');
  const write = (run, text) => { mkdirSync(path.join(runs, run), { recursive: true }); if (text !== null) writeFileSync(path.join(runs, run, 'findings.json'), text); };
  assert.equal(findingsFileState(repo), 'missing');
  write('20261101-000000-hunt-aaaa', null);
  assert.equal(findingsFileState(repo), 'missing');
  // A finish killed mid-write by an older engine left half a file.
  write('20261101-000001-hunt-bbbb', '{"confirmed": [');
  assert.match(findingsFileState(repo), /^unreadable: /);
  assert.deepEqual(huntFindings(repo), []);
  assert.deepEqual(huntFinishes(repo), []);
  write('20261101-000002-hunt-cccc', JSON.stringify({
    confirmed: [{ title: 'A failed load is shown as an empty list', probe: 'empty', check: 'shown', severity: 'high', runs: ['saw a', 'saw b'] }],
    proof: { finishSeconds: 312, complete: false, order: ['empty', 'layout'], proved: ['empty'] },
  }));
  write('20261101-000003-replay-dddd', '{"confirmed": [{"title": "not a hunt"}]}');
  assert.equal(findingsFileState(repo), 'ok');
  assert.deepEqual(huntFinishes(repo), [{ run: '20261101-000002-hunt-cccc', finishSeconds: 312, complete: false, proved: 1, claimedProbes: 2 }]);
  const found = huntFindings(repo);
  assert.equal(found.length, 1);
  assert.equal(found[0].evidence, 'saw a | saw b');
  assert.deepEqual(found[0].tool, { run: '20261101-000002-hunt-cccc', probe: 'empty', state: 'confirmed' });
});

test('analyze lists failed runs by name and reports how long finish took', (t) => {
  const results = mkdtempSync(path.join(tmpdir(), 'sh-results-'));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1, toolCalls: {} };
  const trial = (id, meta) => {
    mkdirSync(path.join(results, 'trials', id), { recursive: true });
    writeFileSync(path.join(results, 'trials', id, 'meta.json'), JSON.stringify({ id, feature: 'harvest-stats', bug: 'error-shown-as-empty', trial: 1, wallMs: 600_000, usage, ...meta }));
    writeFileSync(path.join(results, 'trials', id, 'findings.json'), JSON.stringify({ findings: [] }));
  };
  trial('a__stillhunter__t1', { arm: 'stillhunter', findingsFile: 'missing', finishSeconds: null, proofComplete: null });
  trial('b__stillhunter__t1', { arm: 'stillhunter', findingsFile: 'ok', finishSeconds: 300, proofComplete: false });
  trial('c__stillhunter__t1', { arm: 'stillhunter', findingsFile: 'unreadable: Unexpected end of JSON input', finishSeconds: null, proofComplete: null });
  trial('d__playwright__t1', { arm: 'playwright', findingsFile: 'ok' });
  const r = spawnSync(process.execPath, [path.join(REPO, 'benchmark', 'comparison', 'analyze.mjs')], {
    encoding: 'utf8', env: { ...process.env, BENCH_RESULTS: results, BENCH_ARMS: 'playwright,stillhunter', BENCH_SET: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^stillhunter a__stillhunter__t1, c__stillhunter__t1$/m);
  assert.match(r.stdout, /^playwright none$/m);
  assert.match(r.stdout, /^stillhunter finish: median 300 s, longest 300 s; proof cut short in b__stillhunter__t1$/m);
  assert.match(r.stdout, /^\| stillhunter \| 3 \| 2 \| 0\/3 \|/m);
  const summary = JSON.parse(readFileSync(path.join(results, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.per.stillhunter.failedRuns, ['a__stillhunter__t1', 'c__stillhunter__t1']);
  assert.equal(summary.per.stillhunter.maxFinishSeconds, 300);
});

// Stands in for materialize: a variant committed with its base config, and a
// change to the app on top.
function fakeMaterialize(v, lane, variantDir) {
  const repo = path.join(variantDir, 'x1y2z3', 'garden-log');
  mkdirSync(path.join(repo, '.stillhunter'), { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.stillhunter', 'config.json'), JSON.stringify({ reset: 'npm run reset', browser: 'chrome' }));
  writeFileSync(path.join(repo, 'app.js'), 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(path.join(repo, 'app.js'), 'export const changed = true;\n');
  return repo;
}

test('a trial works in a folder named at random, and only the stillhunter arm\'s reset seeds the sample data again, from a copy outside the repository', (t) => {
  // Not resolved: a real BENCH_WORK can sit under a symbolic link, as $TMPDIR
  // does on macOS, and the seed copy must run from that spelling too.
  const parent = mkdtempSync(path.join(tmpdir(), 'sh-bench-work-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  assert.throws(() => prepareTrial('stillhunter', VARIANTS[0], 4, path.join(REPO, 'work'), fakeMaterialize), /outside the repository/);
  assert.throws(() => prepareTrial('stillhunter', VARIANTS[0], 4, undefined, fakeMaterialize), /BENCH_WORK must be set/);

  const v = VARIANTS.find((x) => x.feature === 'watering-log' && x.bug !== 'clean');
  for (const arm of ALL_ARMS) {
    const trial = prepareTrial(arm, v, 4, parent, fakeMaterialize);
    // Every path the arm is given or works in says nothing of the variant.
    for (const p of [trial.work, trial.scratch, trial.outDir, trial.repo]) {
      assert.ok(existsSync(p) && outsideRepo(p), p);
      for (const name of [v.feature, v.bug]) assert.ok(!p.includes(name), `${p} names ${name}`);
    }
    assert.match(path.basename(trial.work), /^trial-\w{6}$/);
    const config = JSON.parse(readFileSync(path.join(trial.repo, '.stillhunter', 'config.json'), 'utf8'));
    if (arm !== 'stillhunter') {
      assert.equal(trial.reset, null);
      assert.deepEqual(config, { reset: 'npm run reset', browser: 'chrome' }, arm);
      assert.ok(!existsSync(path.join(trial.work, 'seed.mjs')));
      continue;
    }
    // The reset runs the app's own reset, then a copy of seed.mjs in the
    // trial's folder: the hunter can read the config, and it names no path
    // into this repository. Other keys are kept.
    const copy = path.join(trial.work, 'seed.mjs');
    assert.equal(trial.reset, `npm run reset && node "${copy}" 4 watering-log`);
    assert.deepEqual(config, { reset: trial.reset, browser: 'chrome' });
    assert.ok(!trial.reset.includes(REPO), trial.reset);
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(SEED, 'utf8'));
    // The copy runs on its own, with nothing to import from the repository.
    const usage = spawnSync(process.execPath, [copy], { encoding: 'utf8' });
    assert.equal(usage.status, 64, usage.stderr);
    // The config changed, but the change start prints is the app's alone.
    const git = (...a) => spawnSync('git', a, { cwd: trial.repo, encoding: 'utf8' });
    assert.match(git('status', '--porcelain').stdout, /^ M \.stillhunter\/config\.json$/m);
    const change = collectChange(trial.repo, baseRef(trial.repo));
    assert.deepEqual(change.files, ['M\tapp.js']);
    assert.ok(change.sections.every((sec) => !sec.file.includes('.stillhunter')));
  }
});

test('seed.mjs imports nothing, takes a lane and a feature, and says how to call it otherwise', () => {
  assert.doesNotMatch(readFileSync(SEED, 'utf8'), /^\s*import\b|\bimport\(/m);
  for (const args of [[], ['4'], ['x', 'watering-log'], ['4', 'no-such-feature']]) {
    const r = spawnSync(process.execPath, [SEED, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 64, args.join(' '));
    assert.match(r.stderr, /^usage: seed\.mjs <lane 0-9> <harvest-stats\|plant-journal\|watering-log>/);
  }
});

test('the seed signs in as the demo user and posts the feature\'s sample data', async (t) => {
  const posts = [];
  let id = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/api/auth/login') {
        assert.deepEqual(JSON.parse(body), { email: 'demo@example.com', password: 'demo-password' });
        res.writeHead(200, { 'set-cookie': 'session=abc; Path=/; HttpOnly' });
        return res.end('{}');
      }
      assert.equal(req.headers.cookie, 'session=abc');
      posts.push([req.url, JSON.parse(body)]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: ++id }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  await seed(4, 'watering-log', base);
  const count = (p) => posts.filter(([u]) => u === p).length;
  assert.deepEqual([count('/api/beds'), count('/api/plants'), count('/api/harvests'), count('/api/journal'), count('/api/waterings')], [2, 3, 6, 0, 2]);
  assert.deepEqual(posts.at(-1), ['/api/waterings', { bed_id: 2, watered_on: '2026-11-05', litres: 4 }]);
  posts.length = 0;
  await seed(4, 'plant-journal', base);
  assert.deepEqual([count('/api/journal'), count('/api/waterings')], [3, 0]);
});
