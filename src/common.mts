// What every runner command shares: the run folder, its context, the config,
// the output block and the small helpers around git and the command line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserName } from './browser.mjs';
import { nuxtCandidates, proveLock } from './target.mjs';

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
}

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
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch (e) {
    fail(`${FOLDER}/config.json is not valid JSON: ${(e as Error).message}`);
  }
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

export async function findTargetUrl(root: string, config: Config): Promise<string | null> {
  if (config.target?.url) return config.target.url;
  for (const candidate of nuxtCandidates(root)) {
    const url = await proveLock(candidate);
    if (url) return url;
  }
  return null;
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

// Names only: the values never leave the environment they came from.
export function signInVariableNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => /(EMAIL|USER(NAME)?|LOGIN|PASSWORD|PASS)$/.test(k) && !/^(npm_|HOMEBREW|LOGNAME$|USER$)/.test(k))
    .sort();
}

export const severityOf = (s: unknown): Severity => (SEVERITIES.includes(String(s ?? '').toLowerCase() as Severity) ? (String(s).toLowerCase() as Severity) : 'medium');
export const atOrAbove = (s: Severity, min: Severity) => SEVERITIES.indexOf(s) <= SEVERITIES.indexOf(min);

export function minutesAndSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
