// The comparison harness runs the stillhunter arm from a packed copy of the
// plugin outside the repository, so the hunter has no path to the benchmark's
// answer key, and it counts a run that left no report as failed. These check
// the folder it is handed, what it packs, the claude call it makes and how it
// reads and reports each run, all offline.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPluginDir, outsideRepo, REPO, runClaude } from '../benchmark/comparison/lib.mjs';
import { findingsFileState, huntFindings, huntFinishes } from '../benchmark/comparison/trial.mjs';

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
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO, encoding: 'utf8' });
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
