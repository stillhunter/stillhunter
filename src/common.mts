// What every runner command shares: the run folder, its context, the config,
// the output block and the small helpers around git and the command line.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER_NAMES, type BrowserName } from './browser.mjs';
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
  allowedHosts: readonly string[];
  signInVariables: string[];
}

export interface Config {
  target?: { url?: string };
  browser?: BrowserName;
  hosts?: { allow: string[] };
  auth?: { env: string[] };
  reset?: { command: string; strategy: 'always' | 'proof' };
  verification: { attempts: number; confirm: number; nonReproduce: number };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function allowedUrl(url: unknown, target: string, allowedHosts: readonly string[] = []): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost')) return true;
    if (u.protocol !== 'https:') return false;
    return allowedHosts.some((entry) => {
      try {
        const allowed = new URL(`https://${entry}`);
        if (allowed.username || allowed.password || allowed.pathname !== '/' || allowed.search || allowed.hash) return false;
        return u.hostname.toLowerCase() === allowed.hostname.toLowerCase() && (u.port || '443') === (allowed.port || '443');
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
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

function commandCredentialValues(root?: string): string[] {
  const names = signInVariableNames();
  if (root) {
    try {
      const value = JSON.parse(readFileSync(path.join(root, FOLDER, 'config.json'), 'utf8')) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const auth = (value as Record<string, unknown>).auth;
        if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
          const configured = (auth as Record<string, unknown>).env;
          if (Array.isArray(configured)) names.push(...signInVariableNames(process.env, configured.filter((x): x is string => typeof x === 'string')));
        }
      }
    } catch {}
  }
  return credentialValues(names);
}

export function fail(message: string, root?: string): never {
  process.stdout.write(block(redact(['stillhunter | stopped', message], commandCredentialValues(root))));
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

function configError(message: string, root: string): never {
  fail(`Invalid ${FOLDER}/config.json: ${message}`, root);
}

function configObject(value: unknown, name: string, allowed: readonly string[], root: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) configError(`"${name}" must be an object.`, root);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      const field = name === 'config' ? key : `${name}.${key}`;
      configError(`unknown key "${field}". Allowed keys: ${allowed.join(', ')}.`, root);
    }
  }
  return object;
}

function configString(value: unknown, name: string, root: string): string {
  if (typeof value !== 'string') configError(`"${name}" must be a string.`, root);
  return value;
}

function configStrings(value: unknown, name: string, root: string): string[] {
  if (!Array.isArray(value)) configError(`"${name}" must be an array of strings.`, root);
  return value.map((entry, i) => configString(entry, `${name}[${i}]`, root));
}

function configCount(value: unknown, name: string, root: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) configError(`"${name}" must be a positive integer.`, root);
  return value as number;
}

function parseConfig(value: unknown, root: string): Config {
  const input = configObject(value, 'config', ['target', 'browser', 'hosts', 'auth', 'reset', 'verification'], root);
  const config: Config = { verification: { attempts: 3, confirm: 2, nonReproduce: 2 } };
  if ('target' in input) {
    const target = configObject(input.target, 'target', ['url'], root);
    config.target = {};
    if ('url' in target) config.target.url = configString(target.url, 'target.url', root);
  }
  if ('browser' in input) {
    const browser = configString(input.browser, 'browser', root);
    if (!BROWSER_NAMES.includes(browser as BrowserName)) configError(`"browser" must be one of: ${BROWSER_NAMES.join(', ')}.`, root);
    config.browser = browser as BrowserName;
  }
  if ('hosts' in input) {
    const hosts = configObject(input.hosts, 'hosts', ['allow'], root);
    config.hosts = { allow: configStrings(hosts.allow, 'hosts.allow', root) };
  }
  if ('auth' in input) {
    const auth = configObject(input.auth, 'auth', ['env'], root);
    const env = configStrings(auth.env, 'auth.env', root);
    for (const [i, name] of env.entries()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) configError(`"auth.env[${i}]" must be an environment variable identifier.`, root);
    }
    config.auth = { env };
  }
  if ('reset' in input) {
    if (typeof input.reset === 'string') {
      if (input.reset) config.reset = { command: input.reset, strategy: 'always' };
    } else {
      if (input.reset === null || typeof input.reset !== 'object' || Array.isArray(input.reset)) configError('"reset" must be a shell command string or an object.', root);
      const reset = configObject(input.reset, 'reset', ['command', 'strategy'], root);
      const strategy = 'strategy' in reset ? configString(reset.strategy, 'reset.strategy', root) : 'always';
      if (strategy !== 'always' && strategy !== 'proof') configError('"reset.strategy" must be one of: always, proof.', root);
      const command = configString(reset.command, 'reset.command', root);
      if (!command.trim()) configError('"reset.command" must not be empty.', root);
      config.reset = { command, strategy };
    }
  }
  if ('verification' in input) {
    const verification = configObject(input.verification, 'verification', ['attempts', 'confirm', 'nonReproduce'], root);
    if ('attempts' in verification) config.verification.attempts = configCount(verification.attempts, 'verification.attempts', root);
    if ('confirm' in verification) config.verification.confirm = configCount(verification.confirm, 'verification.confirm', root);
    if ('nonReproduce' in verification) config.verification.nonReproduce = configCount(verification.nonReproduce, 'verification.nonReproduce', root);
  }
  return config;
}

export function readConfig(root: string): Config {
  const file = path.join(root, FOLDER, 'config.json');
  if (!existsSync(file)) return parseConfig({}, root);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    fail(`${FOLDER}/config.json cannot be read: check that it is a readable file.`, root);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`${FOLDER}/config.json is not valid JSON: check the syntax and try again.`, root);
  }
  return parseConfig(value, root);
}

export function loadRun(args: string[]): { ctx: Context; dir: string; root: string } {
  const root = repoRoot();
  const id = flag(args, '--run');
  if (!id || !HUNT_ID.test(id)) fail('Give the run id from `start` with --run.', root);
  const dir = path.join(runsDir(root), id);
  if (!existsSync(path.join(dir, 'context.json'))) fail(`No hunt run ${id}.`, root);
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
export function signInVariableNames(env: NodeJS.ProcessEnv = process.env, configured?: readonly string[]): string[] {
  if (configured) return [...new Set(configured)].filter((name) => Object.hasOwn(env, name) && typeof env[name] === 'string').sort();
  return Object.keys(env)
    .filter((k) => /(EMAIL|USER(NAME)?|LOGIN|PASSWORD|PASS)$/.test(k) && !/^(npm_|HOMEBREW|LOGNAME$|USER(NAME)?$)/.test(k))
    .sort();
}

export const REDACTED = '[session value]';

export function credentialValues(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(names.flatMap((name) => {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    return typeof value === 'string' && value ? [value] : [];
  }))].sort((a, b) => b.length - a.length);
}

type RedactSchema = 'arbitrary' | 'result' | 'findings';
const RUNNER_KEYS = new Set([
  'actual', 'before', 'blocked', 'budgetSeconds', 'check', 'checks', 'complete', 'confirmed', 'coverage', 'detail', 'dismissed', 'dropped',
  'endpoint', 'endpoints', 'error', 'expected', 'fault', 'faults', 'final', 'finishSeconds', 'finishedAt', 'generation', 'hostError', 'id', 'intermittent',
  'label', 'method', 'name', 'neverFaulted', 'neverNarrow', 'notRerun', 'notRerunnable', 'notes', 'order', 'output', 'page', 'pages', 'pass',
  'probe', 'proof', 'proved', 'reason', 'requests', 'resetError', 'resetSeconds', 'run', 'runs', 'savedSession', 'seconds', 'severity', 'shots',
  'signIn', 'signInFlow', 'startedAt', 'status', 'title', 'unaccounted', 'url', 'value', 'via', 'viewport', 'visited', 'wallLimitSeconds', 'where',
  'width', 'widths', 'why', 'duplicateOf', 'failure', 'refused', 'viewports',
]);
const MAX_REDACT_DEPTH = 100;

function redactText(text: string, secrets: readonly string[]): string {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const markerAt = text.indexOf(REDACTED, cursor);
    let at = -1;
    let match = '';
    for (const secret of secrets) {
      const found = text.indexOf(secret, cursor);
      if (found !== -1 && (at === -1 || found < at)) { at = found; match = secret; }
    }
    const longerMarkerSecret = match.includes(REDACTED) && match.length > REDACTED.length;
    if (markerAt !== -1 && (at === -1 || markerAt < at || (markerAt === at && !longerMarkerSecret))) {
      out.push(text.slice(cursor, markerAt), REDACTED);
      cursor = markerAt + REDACTED.length;
    } else if (at === -1) {
      out.push(text.slice(cursor));
      break;
    } else {
      out.push(text.slice(cursor, at), REDACTED);
      cursor = at + match.length;
    }
  }
  return out.join('');
}

export function redact<T>(value: T, secrets: readonly string[], schema: RedactSchema = 'arbitrary'): T {
  const ordered = [...new Set(secrets.filter((x) => typeof x === 'string' && x))].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return value;
  const active = new WeakSet<object>();
  const walk = (v: unknown, arbitrary: boolean, depth: number): unknown => {
    if (typeof v === 'string') return redactText(v, ordered);
    if (!v || typeof v !== 'object') return v;
    if (depth >= MAX_REDACT_DEPTH) return '[depth exceeded]';
    if (active.has(v)) return '[circular]';
    active.add(v);
    if (Array.isArray(v)) {
      const out = v.map((x) => walk(x, arbitrary, depth + 1));
      active.delete(v);
      return out;
    }
    const used = new Set<string>();
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => {
      const fixed = !arbitrary && RUNNER_KEYS.has(k);
      const base = fixed ? k : redactText(k, ordered);
      let key = base;
      for (let n = 2; used.has(key); n++) key = `${base} #${n}`;
      used.add(key);
      const childArbitrary = arbitrary || !fixed || (schema === 'result' && (k === 'final' || k === 'value'));
      return [key, walk(x, childArbitrary, depth + 1)];
    }));
    active.delete(v);
    return out;
  };
  return walk(value, schema === 'arbitrary', 0) as T;
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
