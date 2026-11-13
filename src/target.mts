// Finding the app to hunt: target.url from .stillhunter/config.json, or a Nuxt
// dev server proven to be this repository's own. The proof: the server that
// answers for localhost:<port> serves the bytes of this checkout's
// .nuxt/nuxt.lock, so another app on the same port can't pass for it.
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';

const DROPPED = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.nuxt', '.output', '.next', '.svelte-kit', 'dist', 'build',
  'coverage', '.turbo', '.vercel', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.stillhunter',
]);

export interface NuxtCandidate {
  // Absolute path of the folder holding nuxt.config.*.
  dir: string;
}

interface NuxtLock {
  raw: Buffer;
  cwd: string;
  port: number | null;
}

// nuxt.config.* files git can see, whose folder's package.json depends on nuxt.
export function nuxtCandidates(root: string): NuxtCandidate[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/nuxt.config.*'], { cwd: root, encoding: 'utf8' });
  const found: NuxtCandidate[] = [];
  for (const file of (listed.stdout ?? '').split('\0').filter(Boolean)) {
    const segments = file.split('/');
    if (!/^nuxt\.config\.[a-z]+$/.test(segments.at(-1) ?? '')) continue;
    if (segments.slice(0, -1).some((s) => DROPPED.has(s))) continue;
    const dir = path.join(root, ...segments.slice(0, -1));
    if (dependsOnNuxt(dir) && !found.some((c) => c.dir === dir)) found.push({ dir });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

function dependsOnNuxt(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies'].some((key) => pkg[key]?.nuxt !== undefined);
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A lock left by a dev server that was killed hard counts as no lock.
function readLock(candidate: NuxtCandidate): NuxtLock | null {
  try {
    const raw = readFileSync(path.join(candidate.dir, '.nuxt', 'nuxt.lock'));
    const parsed = JSON.parse(raw.toString('utf8')) as { pid?: number; cwd?: string; port?: number };
    if (typeof parsed.cwd !== 'string') return null;
    if (typeof parsed.pid === 'number' && parsed.pid > 0 && !processAlive(parsed.pid)) return null;
    return { raw, cwd: parsed.cwd, port: typeof parsed.port === 'number' ? parsed.port : null };
  } catch {
    return null;
  }
}

export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// `/_nuxt/@fs<cwd>/.nuxt/nuxt.lock`; a Windows drive path gains the leading slash Vite expects.
export function lockUrlPath(cwd: string): string {
  const forward = cwd.replace(/\\/g, '/');
  return `/_nuxt/@fs${forward.startsWith('/') ? '' : '/'}${encodeURI(forward)}/.nuxt/nuxt.lock`;
}

function fetchBytes(address: string, port: number, urlPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = request({ host: address, port, path: urlPath, headers: { host: `localhost:${port}` }, timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Nuxt dev may bind ::1 only while 127.0.0.1 is another process, so every
// address localhost resolves to is tried.
export async function proveLock(candidate: NuxtCandidate): Promise<string | null> {
  const lock = readLock(candidate);
  if (lock === null || lock.port === null || !samePath(lock.cwd, candidate.dir)) return null;
  const addresses = await lookup('localhost', { all: true }).catch(() => [{ address: '::1' }, { address: '127.0.0.1' }]);
  for (const { address } of addresses) {
    const served = await fetchBytes(address, lock.port, lockUrlPath(lock.cwd));
    if (served !== null && served.equals(lock.raw)) return `http://localhost:${lock.port}`;
  }
  return null;
}

// The status of any HTTP response at all, or null when nothing answers.
export function answers(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    let req;
    try {
      req = request(url, { method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      });
    } catch {
      resolve(null);
      return;
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
