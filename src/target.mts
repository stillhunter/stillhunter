// Finding the app to hunt: target.url from .stillhunter/config.json, or a Nuxt,
// Vite or Next dev server proven to be this repository's own. For Nuxt the
// proof is that the server that answers for localhost:<port> serves the bytes
// of this checkout's .nuxt/nuxt.lock. Vite and Next leave no such file, so the
// runner writes one for a moment, a file of random bytes in a folder the dev
// server serves and does not watch, and asks each usual port for it. Either
// way another app on the same port, or another checkout of this one, can't
// pass for it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function dependsOn(dir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies'].some((key) => pkg[key]?.[name] !== undefined);
  } catch {
    return false;
  }
}

function dependsOnNuxt(dir: string): boolean {
  return dependsOn(dir, 'nuxt');
}

export type DevKind = 'Vite' | 'Next';
export interface DevCandidate { dir: string; kind: DevKind }

// Folders with a package.json git can see that depend on vite or next (and
// not on nuxt, found by its lock instead).
export function devCandidates(root: string): DevCandidate[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/package.json'], { cwd: root, encoding: 'utf8' });
  const found: DevCandidate[] = [];
  for (const file of (listed.stdout ?? '').split('\0').filter(Boolean)) {
    const segments = file.split('/');
    if (segments.at(-1) !== 'package.json' || segments.slice(0, -1).some((s) => DROPPED.has(s))) continue;
    const dir = path.join(root, ...segments.slice(0, -1));
    if (dependsOnNuxt(dir)) continue;
    if (dependsOn(dir, 'next')) found.push({ dir, kind: 'Next' });
    else if (dependsOn(dir, 'vite')) found.push({ dir, kind: 'Vite' });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

// The ports each dev server starts on, and the next ones it moves to when a
// port is taken.
export const DEV_PORTS: Record<DevKind, number[]> = {
  Vite: [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180],
  Next: [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007],
};

// Where the marker goes and the URL path it is served at. Vite serves any
// file under its root at /@fs<absolute path> and does not watch node_modules;
// Next serves .next/static (.next/dev/static from Next 16) at /_next/static/.
export function markerPlaces(candidate: DevCandidate, name: string): { file: string; urlPath: string }[] {
  if (candidate.kind === 'Next') {
    return [path.join('.next', 'dev', 'static'), path.join('.next', 'static')]
      .filter((d) => existsSync(path.join(candidate.dir, d)))
      .map((d) => ({ file: path.join(candidate.dir, d, name), urlPath: `/_next/static/${name}` }));
  }
  const folder = existsSync(path.join(candidate.dir, 'node_modules')) ? path.join(candidate.dir, 'node_modules') : candidate.dir;
  const file = path.join(folder, name);
  return [{ file, urlPath: fsUrlPath(file) }];
}

// `/@fs<absolute path>`; a Windows drive path gains the leading slash Vite expects.
export function fsUrlPath(file: string): string {
  const forward = file.replace(/\\/g, '/');
  return `/@fs${forward.startsWith('/') ? '' : '/'}${encodeURI(forward)}`;
}

export interface DevFound { url: string; kind: DevKind; dir: string }

// Every dev server on a usual port that serves a marker written into one of
// this repository's Vite or Next folders. Each marker is removed before this
// returns.
export async function devServerUrl(root: string, candidates = devCandidates(root), ports = DEV_PORTS): Promise<{ found: DevFound[] }> {
  const found: DevFound[] = [];
  const addresses = await lookup('localhost', { all: true }).catch(() => [{ address: '::1' }, { address: '127.0.0.1' }]);
  for (const candidate of candidates) {
    const name = `stillhunter-target-${randomBytes(12).toString('hex')}.txt`;
    const bytes = randomBytes(32);
    const places = markerPlaces(candidate, name);
    const written: string[] = [];
    try {
      for (const place of places) {
        try {
          writeFileSync(place.file, bytes, { flag: 'wx' });
          written.push(place.file);
        } catch {}
      }
      if (!written.length) continue;
      const served = new Set<number>();
      for (const port of ports[candidate.kind]) {
        for (const { address } of addresses) {
          if (served.has(port)) break;
          for (const place of places.filter((p) => written.includes(p.file))) {
            const got = await fetchBytes(address, port, place.urlPath);
            if (got !== null && got.equals(bytes)) { served.add(port); break; }
          }
        }
      }
      for (const port of served) found.push({ url: `http://localhost:${port}`, kind: candidate.kind, dir: candidate.dir });
    } finally {
      for (const file of written) rmSync(file, { force: true });
    }
  }
  return { found };
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
