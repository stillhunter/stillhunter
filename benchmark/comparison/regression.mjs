// Independent retained-test evaluation for planted findings. Tests must assert
// correct behavior: two failures on the buggy variant and a pass on clean code
// show a stable, sensitive test with the right expectation.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginDir, DEMO, FEATURES, lanePorts, materializeVariant, preparePlugin, RESULTS, scrubPaths, seed, sh, startApp, writeTestRuntime } from './lib.mjs';
import { scoredTrials } from './judge.mjs';
import { writeResetConfig } from './trial.mjs';

const DRIVER = fileURLToPath(new URL('./regression-driver.mjs', import.meta.url));

function mcpTest(trialDir, title) {
  const root = path.join(trialDir, 'scratch');
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'tests.json'), 'utf8'));
    const matches = (manifest.tests ?? []).filter((t) => t.title === title);
    if (matches.length !== 1) return { test: null, reason: matches.length ? 'ambiguous retained test title' : 'no retained test for this finding' };
    const source = path.resolve(root, matches[0].file ?? '');
    const rel = path.relative(root, source);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.mjs') || !existsSync(source)) return { test: null, reason: 'unsafe or missing retained test file' };
    return { test: { kind: 'mcp', source }, reason: null };
  } catch {
    return { test: null, reason: 'missing or unreadable tests.json' };
  }
}

function stillhunterTest(trialDir, title) {
  const root = path.join(trialDir, 'stillhunter', 'tests');
  if (!existsSync(root)) return { test: null, reason: 'no kept tests' };
  const matches = [];
  for (const name of readdirSync(root)) {
    try {
      const meta = JSON.parse(readFileSync(path.join(root, name, 'test.json'), 'utf8'));
      if (meta.title === title && existsSync(path.join(root, name, 'test.mjs'))) matches.push(name);
    } catch {}
  }
  return matches.length === 1
    ? { test: { kind: 'stillhunter', name: matches[0] }, reason: null }
    : { test: null, reason: matches.length ? 'ambiguous kept test title' : 'no kept test for this finding' };
}

export function regressionJobs(trials, judgments, results = RESULTS) {
  const jobs = [];
  for (const [feature, judgment] of Object.entries(judgments)) {
    for (const report of judgment.reports) {
      if (!report.planted) continue;
      const [id, index] = report.key.split('#');
      const trial = trials.find((t) => t.id === id);
      const finding = trial?.findings[Number(index)];
      if (!trial || !finding || finding.status !== 'observed') continue;
      const trialDir = path.join(results, 'trials', id);
      const retained = trial.meta.arm === 'stillhunter' ? stillhunterTest(trialDir, finding.title) : mcpTest(trialDir, finding.title);
      jobs.push({ feature, bug: trial.meta.bug, arm: trial.meta.arm, lane: trial.meta.lane, findingKey: report.key, key: `planted-${report.id}`, title: finding.title, ...retained });
    }
  }
  return jobs;
}

export function classifyRegressionRuns(buggyRuns, cleanRuns) {
  if ([...buggyRuns, ...cleanRuns].includes('inconclusive')) return 'inconclusive';
  if (cleanRuns.some((r) => r !== 'passed')) return 'wrong-expectation';
  if (buggyRuns.every((r) => r === 'passed')) return 'not-sensitive';
  if (new Set(buggyRuns).size !== 1) return 'unstable';
  return buggyRuns.length === 2 && buggyRuns.every((r) => r === 'failed') && cleanRuns.length === 1 ? 'valid' : 'unstable';
}

export function replayOutcome(code, output) {
  if (/\bINCONCLUSIVE\b/.test(output) || /\bnot reached\b/.test(output)) return 'inconclusive';
  if (code === 1 && /\bFAIL\b/.test(output)) return 'failed';
  if (code === 0 && /\bPASS\b/.test(output)) return 'passed';
  return 'inconclusive';
}

export function processOutcome(result) {
  if (result.status === 0) return 'passed';
  if (result.status === 1 && /ERR_ASSERTION|AssertionError/.test(result.stderr ?? '')) return 'failed';
  return 'inconclusive';
}


export async function evaluateRegressionJob(job, run) {
  if (!job.test) return { ...job, available: false, classification: 'missing', buggyRuns: [], cleanRuns: [] };
  const attempt = async (bug) => {
    try { return await run(bug); }
    catch (e) { return { outcome: 'inconclusive', error: e.message }; }
  };
  const buggyRuns = [await attempt(job.bug), await attempt(job.bug)];
  const cleanRuns = [await attempt('clean')];
  return {
    ...job,
    available: true,
    buggyRuns,
    cleanRuns,
    classification: classifyRegressionRuns(buggyRuns.map((r) => r.outcome), cleanRuns.map((r) => r.outcome)),
  };
}


function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const finish = (status, signal = null, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, error, stdout, stderr, wallMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      finish(null, 'SIGKILL', { code: 'ETIMEDOUT' });
    }, options.timeoutMs ?? 120_000);
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function seedFresh(repo, lane, feature) {
  sh('npm', ['run', 'reset'], { cwd: repo });
  try { await seed(lane, feature); }
  catch {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    sh('npm', ['run', 'reset'], { cwd: repo });
    await seed(lane, feature);
  }
}

export function copyMcpTestSuite(source, dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(path.dirname(source), dest, { recursive: true });
  cpSync(source, path.join(dest, 'test.mjs'));
}

async function openVariant(job, bug, lane, pluginDir, dest) {
  const work = path.join(process.env.BENCH_WORK, `regression-${job.feature}-${job.key}-${bug}`);
  rmSync(work, { recursive: true, force: true });
  const repo = materializeVariant({ feature: job.feature, bug }, lane, path.join(work, 'variant'));
  if (job.test.kind === 'stillhunter') {
    cpSync(path.join(RESULTS, 'trials', job.findingKey.split('#')[0], 'stillhunter'), path.join(repo, '.stillhunter'), { recursive: true });
    writeResetConfig(repo, lane, job.feature, work);
  } else {
    copyMcpTestSuite(job.test.source, path.join(work, 'tests'));
    writeTestRuntime(work);
  }
  const stop = await startApp(repo, lane, path.join(dest, `app-${bug}.log`));
  const ports = lanePorts(lane);
  const run = async () => {
    if (job.test.kind === 'mcp') await seedFresh(repo, lane, job.feature);
    const args = job.test.kind === 'stillhunter'
      ? [path.join(pluginDir, 'dist', 'hunt.mjs'), 'replay', job.test.name]
      : [DRIVER, path.join(work, 'tests', 'test.mjs')];
    const r = await runProcess(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...DEMO, BENCH_TEST_WEB: `http://localhost:${ports.web}`, BENCH_TEST_API: `http://localhost:${ports.api}/api` },
      timeoutMs: 180_000,
    });
    return {
      outcome: job.test.kind === 'stillhunter' ? replayOutcome(r.status, r.stdout + r.stderr) : processOutcome(r),
      wallMs: r.wallMs,
      output: scrubPaths((r.stdout + r.stderr).slice(-4000)),
    };
  };
  return { run, close: async () => { await stop(); rmSync(work, { recursive: true, force: true }); } };
}

export async function evaluateWithVariants(job, open) {
  let activeBug = null;
  let active = null;
  try {
    return await evaluateRegressionJob(job, async (bug) => {
      if (activeBug !== bug) {
        await active?.close();
        active = await open(bug);
        activeBug = bug;
      }
      return active.run();
    });
  } finally {
    await active?.close();
  }
}

async function evaluateOne(job, lane, pluginDir) {
  const dest = path.join(RESULTS, 'regression', job.feature);
  mkdirSync(dest, { recursive: true });
  const started = Date.now();
  const result = await evaluateWithVariants(job, (bug) => openVariant(job, bug, lane, pluginDir, dest));
  return { ...result, wallMs: Date.now() - started };
}

export function assignRegressionLanes(jobs, lanes, offset = 0) {
  const mcpLanes = Array.from({ length: lanes }, (_, i) => i + offset);
  const shLanes = jobs.filter((job) => job.test?.kind === 'stillhunter').map((job) => job.lane);
  const assigned = new Map([...new Set([...mcpLanes, ...shLanes])].map((lane) => [lane, []]));
  let next = 0;
  for (const job of jobs) {
    const lane = job.test?.kind === 'stillhunter' ? job.lane : mcpLanes[next++ % mcpLanes.length];
    assigned.get(lane).push(job);
  }
  return assigned;
}

async function main() {
  const lanes = Number(process.argv[2] ?? '2');
  const trials = scoredTrials();
  const judgments = {};
  for (const feature of FEATURES) {
    const file = path.join(RESULTS, 'judge', `${feature}.pass1.json`);
    if (existsSync(file)) judgments[feature] = JSON.parse(readFileSync(file, 'utf8'));
  }
  const jobs = regressionJobs(trials, judgments);
  const needsPlugin = jobs.some((j) => j.test?.kind === 'stillhunter');
  const pluginDir = needsPlugin ? (process.env.BENCH_PLUGIN_DIR ? checkPluginDir(process.env.BENCH_PLUGIN_DIR) : preparePlugin().dir) : null;
  console.log(`${jobs.length} planted regression tests to evaluate (${jobs.filter((j) => !j.test).length} missing)`);
  const assigned = assignRegressionLanes(jobs, lanes, Number(process.env.BENCH_LANE_OFFSET ?? 0));
  await Promise.all([...assigned].map(async ([lane, laneJobs]) => {
    for (const job of laneJobs) {
      const file = path.join(RESULTS, 'regression', job.feature, `${job.key}.json`);
      if (existsSync(file)) continue;
      let result;
      try { result = await evaluateOne(job, lane, pluginDir); }
      catch (e) { result = { ...job, available: Boolean(job.test), classification: job.test ? 'inconclusive' : 'missing', error: e.message, buggyRuns: [], cleanRuns: [] }; }
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, scrubPaths(JSON.stringify(result, null, 2)) + '\n');
      console.log(`${job.feature}/${job.key}: ${result.classification}`);
    }
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
