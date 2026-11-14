// The result a probe run leaves behind, and the questions the runner asks of
// it: did a named check fail, which checks failed, which run is the latest.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Check { name: string; pass: boolean; detail: string }
export interface RequestRecord { method: string; url: string; status: number | null; fault: string | null; via: 'page' | 'rr.request'; page?: number; failure?: string }
export interface FaultRecord { method: string; url: string; fault: string }
export interface PageRecord { id: number; viewport: { width: number; height: number } | null; visited: { url: string; width: number | null }[] }

export type HostError = 'timeout' | 'crash' | 'no-result';

// What ran before a probe when the config has a reset: the reset, and the
// run's sign-in probe again (null when none ran: there was none yet, or this
// probe is the sign-in probe). A sign-in can fail after it saved a session.
export interface Before {
  resetSeconds: number;
  resetError: string | null;
  signIn: { probe: string; seconds: number; error: string | null; savedSession?: boolean } | null;
}

// What a probe saw while it signed in, up to the page it landed on: the
// number of requests made before that page, and the pages visited before it.
export interface SignInFlow { requests: number; pages: string[] }

export interface ProbeResult {
  probe: string;
  run?: number;
  startedAt?: number;
  finishedAt?: number;
  checks: Check[];
  notes: { label: string; value: unknown }[];
  error: string | null;
  hostError: HostError | null;
  blocked: string[];
  // Protocol calls the browser relay refused, each with its reason.
  refused?: string[];
  savedSession: boolean;
  shots: string[];
  requests: RequestRecord[];
  faults: FaultRecord[];
  pages: PageRecord[];
  final: unknown;
  output: string;
  before?: Before;
  // Set by the first rr.saveSession() of the run.
  signInFlow?: SignInFlow;
}

export function emptyResult(probe: string, error: string, hostError: HostError): ProbeResult {
  return { probe, checks: [], notes: [], error, hostError, blocked: [], savedSession: false, shots: [], requests: [], faults: [], pages: [], final: null, output: '' };
}

export type Outcome = { state: 'failed'; detail: string } | { state: 'held' } | { state: 'missing' };

// A check fails in a run when any expectation of that name failed.
export function outcome(result: ProbeResult, check: string): Outcome {
  const named = (result.checks ?? []).filter((c) => c.name === check);
  if (named.length === 0) return { state: 'missing' };
  const failed = named.find((c) => !c.pass);
  return failed ? { state: 'failed', detail: failed.detail } : { state: 'held' };
}

export function failedChecks(result: ProbeResult): string[] {
  return [...new Set((result.checks ?? []).filter((c) => !c.pass).map((c) => c.name))];
}

export const probesDir = (runDir: string) => path.join(runDir, 'probes');
export const latestFile = (runDir: string, name: string) => path.join(probesDir(runDir), `${name}.result.json`);
export const numberedFile = (runDir: string, name: string, n: number) => path.join(probesDir(runDir), `${name}.${n}.result.json`);

export function readResult(file: string): ProbeResult | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProbeResult;
  } catch {
    return null;
  }
}

export function probeNames(runDir: string): string[] {
  const dir = probesDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9-]*\.mjs$/.test(f)).map((f) => f.slice(0, -4)).sort();
}

export function latestResults(runDir: string): Map<string, ProbeResult> {
  const out = new Map<string, ProbeResult>();
  for (const name of probeNames(runDir)) {
    const r = readResult(latestFile(runDir, name));
    if (r) out.set(name, r);
  }
  return out;
}

export function nextRunNumber(runDir: string, name: string): number {
  const dir = probesDir(runDir);
  if (!existsSync(dir)) return 1;
  const pattern = new RegExp(`^${name}\\.(\\d+)\\.result\\.json$`);
  let max = 0;
  for (const f of readdirSync(dir)) {
    const m = pattern.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// Every run of every probe in the hunt, for coverage: a fault applied in an
// earlier run of a probe was still applied.
export function allResults(runDir: string): ProbeResult[] {
  const dir = probesDir(runDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9-]*\.\d+\.result\.json$/.test(f)).sort()
    .map((f) => readResult(path.join(dir, f))).filter((r): r is ProbeResult => r !== null);
}

// The probe that signed in: the latest one whose run saved the session.
export function signInProbe(runDir: string): string | null {
  // The latest probe whose run saved a session and ended without an error;
  // failing that, the latest that saved a session and failed after it. Its
  // session is still good, and every run of it says that it failed, so a
  // sign-in probe with a broken last step never leaves the hunt signed out.
  let clean: { name: string; at: number } | null = null;
  let saved: { name: string; at: number } | null = null;
  for (const [name, r] of latestResults(runDir)) {
    if (!r.savedSession) continue;
    const at = r.finishedAt ?? 0;
    if (!r.error) {
      if (!clean || at > clean.at) clean = { name, at };
    } else if (!saved || at > saved.at) saved = { name, at };
  }
  return (clean ?? saved)?.name ?? null;
}
