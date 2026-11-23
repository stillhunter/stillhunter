// Reset, then sign in again unless the probe about to run is the sign-in
// probe. The always strategy uses this at start and before every hunt probe,
// proof and replay; proof uses it only for proof and replay. A proof with a
// fresh scratch can also use it to rebuild its session when no reset exists.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { type Config, credentialValues, redact } from './common.mjs';
import { PROBE_TIMEOUT_MS } from './probe-host.mjs';
import type { Before, ProbeResult } from './results.mjs';

export const RESET_TIMEOUT_MS = 120_000;
// How long a reset stopped at its time limit may take to close its output.
const STOP_GRACE_MS = 5_000;

export const seconds = (ms: number) => Math.round(ms / 100) / 10;

export type ResetPhase = 'start' | 'hunt' | 'proof' | 'replay';

export function shouldReset(config: Config, phase: ResetPhase): boolean {
  const reset = config.reset as Config['reset'] | string | undefined;
  if (!reset) return false;
  const strategy = typeof reset === 'string' ? 'always' : reset.strategy;
  return strategy === 'always' || phase === 'proof' || phase === 'replay';
}

// Stops a process and everything it started. On POSIX the reset leads its own
// process group; on Windows, taskkill follows the tree.
function stopAll(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

// Runs the configured reset in the repository root: null when it worked,
// otherwise the command, how it ended and the end of what it printed. A reset
// that runs past its time is stopped with every process it started, so none
// of them goes on changing app data once the next probe has begun.
export function resetApp(root: string, config: Config, timeoutMs = RESET_TIMEOUT_MS, secrets: readonly string[] = []): Promise<string | null> {
  const reset = config.reset as Config['reset'] | string | undefined;
  const command = typeof reset === 'string' ? reset : reset?.command;
  if (!command) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout = (stdout + d.toString('utf8')).slice(-4000); });
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const done = (why: string | null) => {
      clearTimeout(timer);
      clearTimeout(grace);
      if (why === null) return resolve(null);
      const printed = stderr.trim() || stdout.trim();
      resolve(redact(`reset ("${command}") failed: ${why}${printed ? `: ${printed.slice(-300)}` : ''}`, secrets));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopAll(child.pid);
      // A process that left the group may still hold the output open.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done(`timed out after ${seconds(timeoutMs)} s`);
      }, STOP_GRACE_MS);
    }, timeoutMs);
    child.on('error', (e) => done(e.message));
    child.on('close', (code, signal) => done(timedOut ? `timed out after ${seconds(timeoutMs)} s` : code === 0 ? null : `exit ${code ?? signal}`));
  });
}

export interface ResetJob {
  root: string;
  config: Config;
  // The probe about to run, and the probe that signs in before it (null: none).
  probe: string;
  signIn: string | null;
  // The run's saved session. It is removed after the reset, so a probe with
  // no sign-in before it, or whose sign-in saved nothing, starts signed out
  // even when the app's sessions outlive its reset.
  sessionFile: string;
  resetTimeoutMs?: number;
  signInVariables?: readonly string[];
  // How long the sign-in may take; null when there is no time for it.
  signInTimeoutMs?: () => number | null;
  runSignIn: (name: string, timeoutMs: number) => Promise<ProbeResult>;
}

// Resets app data, then signs in again. A failed reset or sign-in is
// reported, not fatal: the probe still runs, and its result says so. null
// when a time limit left no room for the sign-in or cut it short, so the probe
// would start signed out for no reason of the app's.
export async function resetAndSignIn(job: ResetJob): Promise<Before | null> {
  const t0 = Date.now();
  const resetError = await resetApp(job.root, job.config, job.resetTimeoutMs, credentialValues(job.signInVariables ?? []));
  const resetSeconds = seconds(Date.now() - t0);
  rmSync(job.sessionFile, { force: true });
  if (!job.signIn || job.signIn === job.probe) return { resetSeconds, resetError, signIn: null };
  const timeoutMs = job.signInTimeoutMs ? job.signInTimeoutMs() : PROBE_TIMEOUT_MS;
  if (timeoutMs === null) return null;
  const t1 = Date.now();
  const s = await job.runSignIn(job.signIn, timeoutMs);
  if (s.hostError === 'timeout' && timeoutMs < PROBE_TIMEOUT_MS) return null;
  const error = s.error ?? (s.savedSession ? null : 'it saved no session');
  return { resetSeconds, resetError, signIn: { probe: job.signIn, seconds: seconds(Date.now() - t1), error, savedSession: s.savedSession } };
}

// A probe ran signed out when the sign-in before it failed without saving a
// session. One that saved a session and then failed left that session in place.
export const signedOut = (b: Before | undefined | null): boolean => Boolean(b?.signIn?.error && !b.signIn.savedSession);
