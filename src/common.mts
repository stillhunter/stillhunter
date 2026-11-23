// What every runner command shares: the run folder, its context, the config,
// the output block and the small helpers around git and the command line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserName } from './browser.mjs';
import { type HostPolicy, patternProblem } from './hosts.mjs';
import { devServerUrl, nuxtCandidates, proveLock } from './target.mjs';

export const FOLDER = '.stillhunter';
export const HUNT_ID = /^\d{8}-\d{6}-hunt-[a-z0-9]{4}$/;
export const PROBE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const START = '--- stillhunter (copy this block unchanged) ---';
export const END = '--- end of stillhunter ---';

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Context {
  runId: string;
  root: string;
  target: string;
  browser: string;
  base: string;
  startedAt: number;
  deadline: number;
  depth: string;
  budgetMinutes: number;
  minSeverity: Severity;
  focus: string | null;
  mode: 'change' | 'feature' | 'replay';
  signInVariables: string[];
}

export interface Config {
  target?: { url?: string };
  browser?: BrowserName;
  reset?: string;
  // "every-probe" (the default): before every probe, every proof re-run and
  // every replayed test. "re-runs": only before proof re-runs and replayed
  // tests, so hunt probes share app data, as with no reset.
  resetBefore?: ResetBefore;
  resetTimeoutSeconds?: number;
  // The sign-in variables a probe gets, by name. Without it, every variable
  // whose name ends in EMAIL, USER, USERNAME, LOGIN, PASSWORD or PASS.
  signIn?: { variables?: string[] };
  network?: { allow?: string[]; allowForSignIn?: string[] };
}

export const RESET_BEFORE = ['every-probe', 're-runs'] as const;
export type ResetBefore = (typeof RESET_BEFORE)[number];
export const DEFAULT_RESET_SECONDS = 120;
export const MAX_RESET_SECONDS = 300;

// Names a probe's environment never takes from the config: they change how
// Node, the loader or the browser behave, not what the app is signed in with.
const RESERVED_VARIABLE = /^(PATH|PATHEXT|SYSTEMROOT|HOME|USERPROFILE|NODE_.*|NPM_.*|LD_.*|DYLD_.*|UV_.*|PLAYWRIGHT_.*|STILLHUNTER_.*)$/i;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const runsDir = (root: string) => path.join(root, FOLDER, 'runs');
export const testsDir = (root: string) => path.join(root, FOLDER, 'tests');

// Paths come back as typed, not quoted with octal escapes, so a name that is
// not ASCII (`café.pem`) is matched like any other.
export const GIT_FLAGS = ['-c', 'core.quotePath=false'];

export function git(args: string[], cwd: string): string | null {
  const r = spawnSync('git', [...GIT_FLAGS, ...args], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function block(lines: string[]): string {
  return [START, ...lines, END].join('\n') + '\n';
}

export function fail(message: string): never {
  process.stdout.write(block(['stillhunter | stopped', message]));
  process.exit(1);
}

export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function repoRoot(): string {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!root) fail('Not inside a git repository.');
  return root;
}

export function readConfig(root: string): Config {
  const file = path.join(root, FOLDER, 'config.json');
  if (!existsSync(file)) return {};
  let config: Config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch (e) {
    fail(`${FOLDER}/config.json is not valid JSON: ${(e as Error).message}`);
  }
  const problems = configProblems(config);
  if (problems.length) fail(`${FOLDER}/config.json has ${problems.length === 1 ? 'a problem' : 'problems'}:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return config;
}

const isList = (v: unknown): v is unknown[] => Array.isArray(v);

// What is wrong with the settings this version reads; other keys are left alone.
export function configProblems(config: unknown): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['it must be a JSON object'];
  const c = config as Record<string, unknown>;
  const out: string[] = [];
  if (c.reset !== undefined && (typeof c.reset !== 'string' || c.reset.trim() === '')) out.push('"reset" is a shell command, as a string');
  if (c.resetBefore !== undefined) {
    if (!RESET_BEFORE.includes(c.resetBefore as ResetBefore)) out.push(`"resetBefore" is "every-probe" or "re-runs", not ${JSON.stringify(c.resetBefore)}`);
    else if (c.reset === undefined) out.push('"resetBefore" needs a "reset" command');
  }
  if (c.resetTimeoutSeconds !== undefined) {
    const n = c.resetTimeoutSeconds;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_RESET_SECONDS) out.push(`"resetTimeoutSeconds" is a whole number from 1 to ${MAX_RESET_SECONDS}`);
  }
  if (c.signIn !== undefined) {
    const s = c.signIn as { variables?: unknown } | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) out.push('"signIn" is an object, such as { "variables": ["APP_EMAIL", "APP_PASSWORD"] }');
    else if (s.variables !== undefined) {
      if (!isList(s.variables)) out.push('"signIn.variables" is a list of environment variable names');
      else for (const v of s.variables) {
        if (typeof v !== 'string' || !VARIABLE_NAME.test(v)) out.push(`"signIn.variables": ${JSON.stringify(v)} is not an environment variable name`);
        else if (RESERVED_VARIABLE.test(v)) out.push(`"signIn.variables": ${v} changes how Node or the browser runs, so a probe never gets it`);
      }
    }
  }
  if (c.network !== undefined) {
    const n = c.network as Record<string, unknown> | null;
    if (!n || typeof n !== 'object' || Array.isArray(n)) out.push('"network" is an object, such as { "allow": ["api.staging.example.com"] }');
    else for (const key of ['allow', 'allowForSignIn']) {
      if (n[key] === undefined) continue;
      if (!isList(n[key])) { out.push(`"network.${key}" is a list of host names`); continue; }
      for (const h of n[key]) {
        const why = patternProblem(h);
        if (why) out.push(`"network.${key}": ${why}`);
      }
    }
  }
  return out;
}

export const resetBefore = (config: Config): ResetBefore => config.resetBefore ?? 'every-probe';
// Whether hunt probes reset first; proof re-runs and replay always do when there is a reset.
export const resetsEveryProbe = (config: Config) => Boolean(config.reset) && resetBefore(config) === 'every-probe';
export const resetTimeoutMs = (config: Config) => (config.resetTimeoutSeconds ?? DEFAULT_RESET_SECONDS) * 1000;

// The hosts a probe may reach besides loopback. The sign-in hosts go only to
// a probe that may sign in.
export function hostPolicy(config: Config, signingIn: boolean): HostPolicy {
  const lower = (l: string[] | undefined) => (l ?? []).map((h) => h.toLowerCase());
  return { allow: lower(config.network?.allow), signIn: signingIn ? lower(config.network?.allowForSignIn) : [] };
}

export function loadRun(args: string[]): { ctx: Context; dir: string; root: string } {
  const root = repoRoot();
  const id = flag(args, '--run');
  if (!id || !HUNT_ID.test(id)) fail('Give the run id from `start` with --run.');
  const dir = path.join(runsDir(root), id);
  if (!existsSync(path.join(dir, 'context.json'))) fail(`No hunt run ${id}.`);
  return { ctx: JSON.parse(readFileSync(path.join(dir, 'context.json'), 'utf8')) as Context, dir, root };
}

export const remaining = (ctx: Context, now = Date.now()) => Math.max(0, Math.round((ctx.deadline - now) / 1000));

export type TargetFound = { url: string; how: string } | { url: null; why: string };

// The app to hunt: the config's target.url, or a Nuxt, Vite or Next dev
// server proven to be this repository's own. A dev server that two candidate
// folders answer for, or two servers for one folder, is not guessed between.
export async function findTarget(root: string, config: Config): Promise<TargetFound> {
  if (config.target?.url) return { url: config.target.url, how: 'target.url in the config' };
  for (const candidate of nuxtCandidates(root)) {
    const url = await proveLock(candidate);
    if (url) return { url, how: `the Nuxt dev server for ${path.relative(root, candidate.dir) || '.'}` };
  }
  const dev = await devServerUrl(root);
  if (dev.found.length === 1) return { url: dev.found[0]!.url, how: `the ${dev.found[0]!.kind} dev server for ${path.relative(root, dev.found[0]!.dir) || '.'}` };
  if (dev.found.length > 1) {
    return { url: null, why: `More than one dev server here belongs to this repository (${dev.found.map((f) => `${f.kind} at ${f.url}`).join(', ')}), so none was picked.` };
  }
  return { url: null, why: 'No running Nuxt, Vite or Next dev server of this repository was found on its usual ports.' };
}

export async function findTargetUrl(root: string, config: Config): Promise<string | null> {
  return (await findTarget(root, config)).url;
}

// What to do when no app was found: say where it runs, once.
export function noTargetMessage(why: string): string {
  return [
    `No running app found. ${why}`,
    'Start your dev server, then tell Stillhunter its URL once by creating',
    `${FOLDER}/config.json with, for example: { "target": { "url": "http://localhost:5173" } }`,
    'For a single hunt you can also name the URL, for example: /stillhunter:hunt the checkout at http://localhost:5173',
  ].join('\n');
}

// A path the hunter never reads: the same rule as secretPath() in
// hooks/guard.mjs (a test holds the two to the same answers), applied by the
// runner to what it prints of the change.
const SECRET_FOLDERS = new Set(['.ssh', '.aws', '.gnupg', '.git']);
const SECRET_FILES = new Set(['.npmrc', '.netrc', '.pgpass', 'session.json']);
export function secretFile(file: string): boolean {
  const segments = file.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  if (segments.some((s) => SECRET_FOLDERS.has(s)) || SECRET_FILES.has(name) || name.startsWith('.env')) return true;
  return /\.(pem|key|p12|pfx)$/.test(name);
}

// Names only: the values never leave the environment they came from. The
// config's signIn.variables, when it is set, names them exactly; otherwise
// every variable whose name ends like a sign-in value.
export function signInVariableNames(env: NodeJS.ProcessEnv = process.env, config: Config = {}): string[] {
  const named = config.signIn?.variables;
  if (named) return [...new Set(named)].sort();
  return Object.keys(env)
    .filter((k) => /(EMAIL|USER(NAME)?|LOGIN|PASSWORD|PASS)$/.test(k) && !/^(npm_|HOMEBREW|LOGNAME$|USER$)/.test(k))
    .sort();
}

// The variables the config names that the environment does not hold.
export function unsetSignInVariables(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  return (config.signIn?.variables ?? []).filter((name) => env[name] === undefined);
}

// The line start prints about sign-in variables, names only.
export function signInVariablesLine(names: string[], config: Config): string {
  const where = config.signIn?.variables ? 'named in the config' : 'set in the environment';
  return `sign-in variables ${where} (names only): ${names.length ? names.join(', ') : 'none'}`;
}

export const severityOf = (s: unknown): Severity => (SEVERITIES.includes(String(s ?? '').toLowerCase() as Severity) ? (String(s).toLowerCase() as Severity) : 'medium');
export const atOrAbove = (s: Severity, min: Severity) => SEVERITIES.indexOf(s) <= SEVERITIES.indexOf(min);

// An error on one line, short enough to read in a report.
export function brief(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function minutesAndSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
