// One trial: node benchmark/comparison/trial.mjs <feature> <bug|clean> <arm> <n> <lane>
// Builds a fresh variant on the lane's ports, starts and seeds the app, runs
// one arm headless, then keeps everything the run left behind.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import {
  ALL_ARMS, checkPluginDir, copyTranscripts, lanePorts, materializeVariant, mcpConfig, MODEL, newSessionId, outsideRepo, preparePlugin, prompt, RESULTS,
  runClaude, scrubPaths, seed, sh, startApp, transcriptUsage, trialId, VARIANTS,
} from './lib.mjs';

// Each hunt run's findings.json, parsed, or null when it is missing or cannot
// be read (a finish killed while writing an older engine's report, say).
export function huntRuns(repo) {
  const runs = path.join(repo, '.stillhunter', 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((r) => r.includes('-hunt-')).sort().map((run) => {
    const file = path.join(runs, run, 'findings.json');
    if (!existsSync(file)) return { run, state: 'missing', findings: null };
    try {
      return { run, state: 'ok', findings: JSON.parse(readFileSync(file, 'utf8')) };
    } catch (e) {
      return { run, state: `unreadable: ${e.message}`, findings: null };
    }
  });
}

// 'ok' when some hunt run left a findings.json that reads; otherwise why not.
// No finished hunt run (for example the skill is missing) is not the same as
// no findings, and analyze counts it as a failed run.
export function findingsFileState(repo) {
  const runs = huntRuns(repo);
  if (runs.some((r) => r.state === 'ok')) return 'ok';
  return runs.find((r) => r.state.startsWith('unreadable'))?.state ?? 'missing';
}

// How each finished hunt's finish call went: its duration and whether its
// proof ran to the end, from the proof record findings.json keeps.
export function huntFinishes(repo) {
  return huntRuns(repo).filter((r) => r.findings).map(({ run, findings }) => {
    const proof = findings.proof ?? {};
    return { run, finishSeconds: proof.finishSeconds ?? null, complete: proof.complete ?? null, proved: proof.proved?.length ?? null, claimedProbes: proof.order?.length ?? null };
  });
}

// Stillhunter reports only findings that reproduced twice; dropped ones are
// kept apart in its findings.json and not scored.
export function huntFindings(repo) {
  return huntRuns(repo).filter((r) => r.findings).flatMap(({ run, findings }) => (findings.confirmed ?? []).map((f) => (
    { title: f.title, where: f.where ?? '', steps: `Probe ${f.probe}, expectation ${f.check}`, expected: f.expected ?? '', actual: f.actual ?? '', evidence: (f.runs ?? []).join(' | '), status: 'observed', severity: f.severity ?? null, tool: { run, probe: f.probe, state: 'confirmed' } }
  )));
}

async function main([feature, bug, arm, n, laneText]) {
  const v = VARIANTS.find((x) => x.feature === feature && x.bug === bug);
  if (!v || !ALL_ARMS.includes(arm) || !/^\d+$/.test(n) || !/^\d$/.test(laneText)) {
    console.error('usage: trial.mjs <feature> <bug|clean> <arm> <n> <lane>');
    return 64;
  }
  const lane = Number(laneText);
  const id = trialId(v, arm, n);
  const dest = path.join(RESULTS, 'trials', id);
  if (existsSync(path.join(dest, 'meta.json'))) { console.log(`${id}: already done`); return 0; }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const work = path.join(process.env.BENCH_WORK, id);
  // The variant and the plugin live outside the repository, where nothing
  // the arm can read leads back to benchmark/apps.
  if (!outsideRepo(work)) throw new Error(`BENCH_WORK must be outside the repository: ${work}`);
  const scratch = path.join(work, 'scratch');
  const outDir = path.join(work, 'out');
  mkdirSync(scratch, { recursive: true }); mkdirSync(outDir, { recursive: true });

  const meta = { id, ...v, arm, trial: Number(n), lane, ports: lanePorts(lane), model: MODEL, startedAt: new Date().toISOString() };
  const t0 = Date.now();
  const repo = materializeVariant(v, lane, path.join(work, 'variant'));
  meta.materializeMs = Date.now() - t0;
  meta.repo = repo;
  const stopApp = await startApp(repo, lane, path.join(dest, 'app.log'));
  try {
    await seed(lane, v.feature);
    meta.diffBefore = sh('git', ['status', '--porcelain'], { cwd: repo }).stdout;
    const sessionId = newSessionId();
    const { web, api } = lanePorts(lane);
    const text = prompt(arm, {
      WEB: `http://localhost:${web}`, API: `http://localhost:${api}/api`, SCRATCH: scratch, OUT: path.join(outDir, 'findings.json'),
    });
    writeFileSync(path.join(dest, 'prompt.txt'), scrubPaths(text) + '\n');
    const mcpFile = path.join(work, 'mcp.json');
    if (arm === 'playwright') mcpConfig(mcpFile, path.join(scratch, 'playwright'));
    meta.sessionId = sessionId;
    // A schedule packs the plugin once; a trial run on its own packs its own.
    let pluginDir = null;
    if (arm === 'stillhunter') {
      pluginDir = checkPluginDir(process.env.BENCH_PLUGIN_DIR ?? preparePlugin(work).dir);
      meta.pluginDir = pluginDir;
    }
    meta.loadBefore = loadavg();
    const result = await runClaude({ cwd: repo, arm, text, sessionId, outDir, mcpFile, pluginDir });
    meta.loadAfter = loadavg();
    meta.claudeExit = result.code;
    meta.killedAtLimit = result.killed;
    meta.wallMs = result.ms;
    writeFileSync(path.join(dest, 'claude.json'), result.stdout);
    writeFileSync(path.join(dest, 'claude.stderr'), result.stderr);
    try {
      const j = JSON.parse(result.stdout);
      meta.reportedCostUsd = j.total_cost_usd; meta.modelUsage = j.modelUsage; meta.numTurns = j.num_turns;
      meta.permissionDenials = (j.permission_denials ?? []).length; meta.isError = j.is_error; meta.resultText = j.result;
    } catch { meta.claudeJsonUnreadable = true; }
    meta.transcripts = copyTranscripts(repo, sessionId, path.join(dest, 'transcripts'));
    meta.usage = transcriptUsage(path.join(dest, 'transcripts'));

    let findings = [];
    if (arm === 'stillhunter') {
      findings = huntFindings(repo);
      meta.findingsFile = findingsFileState(repo);
      meta.finishes = huntFinishes(repo);
      meta.finishSeconds = meta.finishes.length ? Math.max(...meta.finishes.map((f) => f.finishSeconds ?? 0)) : null;
      meta.proofComplete = meta.finishes.length ? meta.finishes.every((f) => f.complete !== false) : null;
      if (existsSync(path.join(repo, '.stillhunter'))) cpSync(path.join(repo, '.stillhunter'), path.join(dest, 'stillhunter'), { recursive: true });
    } else if (existsSync(path.join(outDir, 'findings.json'))) {
      try { findings = JSON.parse(readFileSync(path.join(outDir, 'findings.json'), 'utf8')).findings ?? []; meta.findingsFile = 'ok'; }
      catch (e) { meta.findingsFile = `unreadable: ${e.message}`; cpSync(path.join(outDir, 'findings.json'), path.join(dest, 'findings.raw.json')); }
    } else meta.findingsFile = 'missing';
    writeFileSync(path.join(dest, 'findings.json'), scrubPaths(JSON.stringify({ findings }, null, 2)) + '\n');
    meta.findingCount = findings.length;

    // Did the arm change the code under test? (Stillhunter's own folder is expected.)
    const after = sh('git', ['status', '--porcelain'], { cwd: repo }).stdout;
    meta.sourceChanged = after.split('\n').filter((l) => l && !l.includes('.stillhunter/')).join('\n') !== meta.diffBefore.split('\n').filter((l) => l && !l.includes('.stillhunter/')).join('\n');
    meta.sourceDiff = sh('git', ['diff', '--stat'], { cwd: repo }).stdout;
  } finally {
    await stopApp();
  }
  // Keep what the arm wrote to its scratch folder, then free the disk.
  cpSync(scratch, path.join(dest, 'scratch'), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  rmSync(work, { recursive: true, force: true });
  meta.finishedAt = new Date().toISOString();
  writeFileSync(path.join(dest, 'meta.json'), scrubPaths(JSON.stringify(meta, null, 2)) + '\n');
  console.log(`${id}: ${meta.findingCount} findings, ${Math.round(meta.wallMs / 1000)}s, exit ${meta.claudeExit}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
