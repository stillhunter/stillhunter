// Shared pieces of the comparison benchmark: variants, arms, the app's
// lifecycle, seeding, the claude call and transcript accounting.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, FEATURES, lanePorts, seed } from './seed.mjs';

// The app's features, its demo sign-in, the lane ports and the sample data
// live in seed.mjs, which a trial copies next to the variant.
export { DEMO, FEATURES, lanePorts, seed };

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
// BENCH_RESULTS keeps a later experiment's runs apart from the first comparison.
export const RESULTS = process.env.BENCH_RESULTS ? path.resolve(process.env.BENCH_RESULTS) : path.join(HERE, 'results');
export const MODEL = 'claude-opus-5-5';
export const MINUTES = 30; // stated to every arm
export const HARD_LIMIT_MS = 45 * 60 * 1000; // every arm is killed after this
export const PLAYWRIGHT_MCP = '0.0.83';
export const BUGS = {
  'harvest-stats': ['error-shown-as-empty', 'to-date-excluded'],
  'plant-journal': ['search-quote-crash', 'failed-save-clears-text'],
  'watering-log': ['water-now-twice', 'negative-litres'],
};
// BENCH_SET=heldout uses the sealed held-out bugs (ids hx1..hx6) instead.
const FEATURES_DIR = path.join(REPO, 'benchmark/apps/garden-log/features');
export const HELDOUT = Object.fromEntries(FEATURES.map((f) => [f, existsSync(path.join(FEATURES_DIR, f, 'bugs')) ? readdirSync(path.join(FEATURES_DIR, f, 'bugs')).filter((b) => /^hx\d+$/.test(b)).sort() : []]));
export const SET = process.env.BENCH_SET === 'heldout' ? HELDOUT : BUGS;
export const VARIANTS = FEATURES.flatMap((f) => [...SET[f], 'clean'].map((bug) => ({ feature: f, bug })));
export const ALL_ARMS = ['baseline', 'playwright', 'adversarial', 'stillhunter'];
export const usesPlaywrightMcp = (arm) => arm === 'playwright' || arm === 'adversarial';
// BENCH_ARMS picks which arms a schedule and its analysis cover.
export const ARMS = process.env.BENCH_ARMS ? process.env.BENCH_ARMS.split(',') : ['playwright', 'adversarial', 'stillhunter'];

export const trialId = (v, arm, n) => `${v.feature}__${v.bug}__${arm}__t${n}`;

// Committed result files name temporary folders as $TMPDIR/... and the home
// folder as ~, never this machine's absolute paths.
export function scrubPaths(text) {
  return String(text)
    .replace(/(?:\/private)?\/var\/folders\/[^/"\s]+\/[^/"\s]+\/T\/+/g, '$TMPDIR/')
    .split(homedir()).join('~');
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}

// A folder is outside the repository when no path from the repository to it
// stays inside. The stillhunter arm's plugin and every variant must be: run
// from inside, the hunter could read benchmark/apps, where each bug's patch
// and description are kept.
export function outsideRepo(dir) {
  const rel = path.relative(REPO, path.resolve(dir));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

// Throws unless the folder is a plugin the stillhunter arm may run: an
// unpacked package outside the repository, with no benchmark folder in it.
export function checkPluginDir(dir) {
  if (!outsideRepo(dir)) throw new Error(`the plugin folder ${dir} is inside the repository`);
  if (existsSync(path.join(dir, 'benchmark'))) throw new Error(`the plugin folder ${dir} holds a benchmark folder`);
  for (const f of ['.claude-plugin/plugin.json', 'dist/hunt.mjs', 'hooks/guard.mjs', 'node_modules/playwright-core/package.json']) {
    if (!existsSync(path.join(dir, f))) throw new Error(`the plugin folder ${dir} has no ${f}`);
  }
  return dir;
}

// Builds the package, packs it as npm would publish it and unpacks it with its
// production dependencies into a new folder outside the repository. Each
// schedule does this once and hands the folder to its trials.
export function preparePlugin(parent = process.env.BENCH_WORK ?? tmpdir()) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, 'stillhunter-plugin-'));
  sh('npm', ['run', 'build'], { cwd: REPO });
  const packed = JSON.parse(sh('node', [path.join(REPO, 'scripts', 'pack.mjs'), dir, '--json'], { cwd: REPO }).stdout);
  const tarball = packed.path;
  sh('tar', ['-xzf', tarball, '-C', dir]);
  rmSync(tarball);
  const plugin = path.join(dir, 'package');
  sh('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: plugin });
  return { dir: checkPluginDir(plugin), version: packed.version, shasum: packed.shasum, files: packed.files.length };
}

export function materializeVariant(v, lane, workDir) {
  mkdirSync(workDir, { recursive: true });
  const { web, api } = lanePorts(lane);
  const args = ['benchmark/bench/cli.mts', 'materialize', 'garden-log', v.feature];
  if (v.bug !== 'clean') args.push(v.bug);
  args.push('--work-dir', workDir, '--ports', `${web},${api}`);
  const r = sh('node', args, { cwd: REPO });
  return r.stdout.trim().split('\n').pop();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

// Starts `npm run dev` in its own process group; returns a stop function.
export async function startApp(dir, lane, logFile) {
  const { web, api } = lanePorts(lane);
  sh('npm', ['run', 'reset'], { cwd: dir });
  const out = [];
  const child = spawn('npm', ['run', 'dev'], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await sleep(1500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    writeFileSync(logFile, Buffer.concat(out));
  };
  const ok = (await waitFor(`http://127.0.0.1:${api}/api/auth/me`, 120000)) && (await waitFor(`http://localhost:${web}/login`, 240000));
  if (!ok) { await stop(); throw new Error(`app did not start on lane ${lane}; see ${logFile}`); }
  // Nuxt dev compiles each page on first visit; warm them so no arm pays for it.
  for (const p of ['/login', '/', '/plants', '/beds', '/stats', '/journal', '/waterings', '/harvests/new', '/tasks']) {
    await fetch(`http://localhost:${web}${p}`, { signal: AbortSignal.timeout(120000) }).catch(() => {});
  }
  return stop;
}

export function checklist() {
  const text = readFileSync(path.join(HERE, 'prompts/checklist.md'), 'utf8');
  return text.split('\n').filter((l) => /^\d+\. /.test(l)).join('\n');
}

export function prompt(arm, vars) {
  if (arm === 'stillhunter') return `/stillhunter:hunt ${MINUTES} minutes`;
  const tools = readFileSync(path.join(HERE, `prompts/tools-${arm}.md`), 'utf8').trim();
  let text = readFileSync(path.join(HERE, 'prompts/common.md'), 'utf8');
  for (const [k, v] of Object.entries({ ...vars, TOOLS: tools, CHECKLIST: checklist(), MINUTES: String(MINUTES) })) text = text.replaceAll(`{{${k}}}`, v);
  if (/\{\{/.test(text)) throw new Error('unfilled prompt variable');
  return text.trim();
}

// PW_MCP_DIR names a folder with @playwright/mcp at PLAYWRIGHT_MCP installed
// (npm install @playwright/mcp@<version> there); both Playwright arms and the
// verifier run it from there.
export function playwrightMcpCli(env = process.env) {
  const cli = env.PW_MCP_DIR ? path.join(env.PW_MCP_DIR, 'node_modules/@playwright/mcp/cli.js') : null;
  if (!cli || !existsSync(cli)) throw new Error(`PW_MCP_DIR must name a folder with @playwright/mcp@${PLAYWRIGHT_MCP} installed: ${env.PW_MCP_DIR ?? 'not set'}`);
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(path.join(path.dirname(cli), 'package.json'), 'utf8')).version ?? 'unknown'; } catch {}
  if (version !== PLAYWRIGHT_MCP) throw new Error(`PW_MCP_DIR has @playwright/mcp installed version ${version}, expected ${PLAYWRIGHT_MCP}`);
  return cli;
}

export function mcpConfig(file, outDir) {
  const cli = playwrightMcpCli();
  writeFileSync(file, JSON.stringify({ mcpServers: { playwright: {
    command: 'node',
    args: [cli, '--headless', '--isolated', '--browser', 'chrome', '--caps', 'network,storage', '--output-dir', outDir],
  } } }, null, 2));
}

// Runs one headless claude session; resolves with timing and exit details.
export function runClaude({ cwd, arm, text, sessionId, outDir, mcpFile, pluginDir }) {
  const args = ['-p', text, '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--session-id', sessionId, '--add-dir', outDir];
  if (usesPlaywrightMcp(arm)) args.push('--mcp-config', mcpFile);
  if (arm === 'stillhunter') args.push('--plugin-dir', checkPluginDir(pluginDir));
  // BENCH_MAX_BUDGET_USD stops a session once it has spent that much.
  if (process.env.BENCH_MAX_BUDGET_USD) args.push('--max-budget-usd', process.env.BENCH_MAX_BUDGET_USD);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...DEMO } });
    const out = []; const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, HARD_LIMIT_MS);
    let done = false;
    const finish = (code, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, killed, ms: Date.now() - started, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() + (error ? `\n${error}` : '') });
    };
    // A claude that cannot be started ends the trial at once, not at the hard limit.
    child.on('error', (e) => finish(null, `claude could not be started: ${e.message}`));
    child.on('close', (code) => finish(code));
  });
}

export function projectDirFor(cwd) {
  return path.join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

// Copies the session transcript and its subagents' transcripts.
export function copyTranscripts(cwd, sessionId, dest) {
  const src = projectDirFor(cwd);
  mkdirSync(dest, { recursive: true });
  const files = [];
  if (existsSync(path.join(src, `${sessionId}.jsonl`))) { cpSync(path.join(src, `${sessionId}.jsonl`), path.join(dest, 'main.jsonl')); files.push('main.jsonl'); }
  const sub = path.join(src, sessionId, 'subagents');
  if (existsSync(sub)) for (const f of readdirSync(sub)) { cpSync(path.join(sub, f), path.join(dest, f)); files.push(f); }
  return files;
}

// Token totals over every transcript, one count per API request.
export function transcriptUsage(dir) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, toolCalls: {} };
  if (!existsSync(dir)) return totals;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    // Each content block of a response is its own line; the last one of a
    // request carries its final usage.
    const byRequest = new Map();
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || !o.message) continue;
      for (const c of o.message.content ?? []) if (c.type === 'tool_use') totals.toolCalls[c.name] = (totals.toolCalls[c.name] ?? 0) + 1;
      if (o.message.usage) byRequest.set(o.requestId ?? o.message.id, o.message.usage);
    }
    for (const u of byRequest.values()) {
      totals.input += u.input_tokens ?? 0; totals.output += u.output_tokens ?? 0;
      totals.cacheRead += u.cache_read_input_tokens ?? 0; totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
      totals.requests += 1;
    }
  }
  return totals;
}

export const newSessionId = () => randomUUID();
