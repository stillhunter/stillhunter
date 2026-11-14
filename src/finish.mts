// finish: checks the hunter's claims, makes it account for every failed check
// and for what it never covered, re-runs each claimed probe twice from scratch
// and reports what reproduced.
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimProblems, type Dismissal, type Finding, type FinishInput, parseFinishInput, unaccounted, type Unaccounted } from './accounting.mjs';
import { atOrAbove, block, brief, type Config, type Context, flag, FOLDER, loadRun, minutesAndSeconds, readConfig, readStdin, remaining, type Severity, severityOf } from './common.mjs';
import { coverage, coverageLines } from './coverage.mjs';
import { hiddenLine } from './flags.mjs';
import { KILL_GRACE_MS, PROBE_TIMEOUT_MS, runProbe, sessionPath } from './probe-host.mjs';
import { RESET_TIMEOUT_MS, resetAndSignIn, signedOut } from './reset.mjs';
import { allResults, type Before, latestResults, outcome, type ProbeResult, probesDir, signInProbe } from './results.mjs';
import { answers } from './target.mjs';

export const COVERAGE_REFUSAL_SECONDS = 180;
// The proof's own budget, and the most a finish call may take in all: the
// hunter's shell gives up on a command after 600 s and would then have no
// report at all. No claimed probe's proof starts after the budget; a proof
// started before it, retries and sign-ins included, is held to the wall limit.
export const PROOF_SECONDS = 420;
export const FINISH_WALL_SECONDS = 540;
// Lowers the wall limit, never raises it, so the tests can reach it in
// seconds. The hunter's shell runs only the runner and sets no variable.
export const WALL_ENV = 'STILLHUNTER_FINISH_WALL_SECONDS';
export const NOT_RERUN = 'Not re-run in time, not counted';
export const NOT_RERUNNABLE = 'Could not re-run, not counted';
const INTERMITTENT = 'Intermittent (1 of 2), not counted';
const RUN_MARGIN_MS = 10_000;
const MIN_RUN_MS = 15_000;

interface FinishState { accountingRefused: boolean; coverageRefused: boolean }

type Confirmed = Finding & { severity: Severity; runs: string[] };
type Unconfirmed = Finding & { severity: Severity; why: string };

function readState(dir: string): FinishState {
  try {
    return { accountingRefused: false, coverageRefused: false, ...(JSON.parse(readFileSync(path.join(dir, 'finish-state.json'), 'utf8')) as Partial<FinishState>) };
  } catch {
    return { accountingRefused: false, coverageRefused: false };
  }
}

function refuse(ctx: Context, lines: string[]): never {
  process.stdout.write(block([`stillhunter | finish refused | run ${ctx.runId}`, ...lines]));
  process.exit(2);
}

// How long one proof run may be given so that, with the browser's start, the
// kill grace and teardown, it ends before the wall deadline; null when no
// useful run fits.
export function runTimeout(now: number, wallDeadline: number): number | null {
  const left = wallDeadline - now - KILL_GRACE_MS - RUN_MARGIN_MS;
  return left < MIN_RUN_MS ? null : Math.min(PROBE_TIMEOUT_MS, left);
}

export function wallSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[WALL_ENV];
  const n = Number(value);
  return value !== undefined && /^\d+$/.test(value) && n >= 1 && n < FINISH_WALL_SECONDS ? n : FINISH_WALL_SECONDS;
}

// A file written whole or not at all: a finish stopped while writing leaves
// the previous version, never a truncated one.
export function writeWhole(file: string, text: string, rename: (from: string, to: string) => void = renameSync): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  // On Windows a rename onto a file another process has open (a reader, or a
  // virus scanner looking at it) fails for a moment with EPERM, EACCES or
  // EBUSY, so it is tried again for up to about 2 s.
  for (let wait = 10; ; wait *= 2) {
    try {
      return rename(temp, file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (wait > 1000 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

// Claimed probes in the order they are proved: by the most severe finding
// each one carries, then in the order they were claimed.
export function proofOrder(findings: Finding[]): string[] {
  const rank = new Map<string, number>();
  for (const f of findings) rank.set(f.probe, Math.min(rank.get(f.probe) ?? 3, ORDER[severityOf(f.severity)]));
  return [...rank.keys()].sort((a, b) => rank.get(a)! - rank.get(b)!);
}

interface Prover {
  dir: string;
  root: string;
  ctx: Context;
  config: Config;
  // The hunt's latest result of each probe, and the run's sign-in probe.
  latest: Map<string, ProbeResult>;
  signIn: string | null;
  notes: string[];
  wallDeadline: number;
}

// One re-run from scratch, or null when the wall deadline leaves no room for
// it (or cut it short), so the probe counts as not re-run in time.
async function proofRun(p: Prover, probe: string, label: string): Promise<ProbeResult | null> {
  const proofDir = path.join(p.dir, 'proof');
  const host = (name: string, timeoutMs: number) => runProbe({
    runDir: p.dir, probe: name, probeFile: path.join(probesDir(p.dir), `${name}.mjs`), target: p.ctx.target, browser: p.ctx.browser,
    signInVariables: p.ctx.signInVariables, shotsDir: path.join(proofDir, 'shots'), timeoutMs,
  });
  const save = (r: ProbeResult, file: string) => { writeFileSync(path.join(proofDir, file), JSON.stringify(r, null, 2) + '\n'); return r; };
  // App data and, with it, any session go back to the start, and the probe
  // that signed in before the claimed probe's hunt run signs in again (none,
  // if none did then), so the claimed probe starts as its hunt run did. A
  // hunt run with no record of that falls back to the run's sign-in probe.
  let before: Before | null = null;
  if (p.config.reset) {
    const resetMs = Math.min(RESET_TIMEOUT_MS, p.wallDeadline - Date.now() - KILL_GRACE_MS - RUN_MARGIN_MS - MIN_RUN_MS);
    if (resetMs <= 0) return null;
    const huntStart = p.latest.get(probe)?.before;
    before = await resetAndSignIn({
      root: p.root, config: p.config, probe, signIn: huntStart ? (huntStart.signIn?.probe ?? null) : p.signIn, sessionFile: sessionPath(p.dir), resetTimeoutMs: resetMs,
      signInTimeoutMs: () => runTimeout(Date.now(), p.wallDeadline),
      runSignIn: async (name, t) => save(await host(name, t), `${probe}.${label}.signin.result.json`),
    });
    if (!before) return null;
    const s = before.signIn;
    if (before.resetError) p.notes.push(`before ${probe} ${label}: ${before.resetError}`);
    if (s?.error) p.notes.push(`before ${probe} ${label}: ${s.savedSession ? `the sign-in probe "${s.probe}" saved a session, then failed` : `signing in again with "${s.probe}" failed`}: ${s.error}`);
  }
  const t = runTimeout(Date.now(), p.wallDeadline);
  if (t === null) return null;
  const r = await host(probe, t);
  if (before) r.before = before;
  save(r, `${probe}.${label}.result.json`);
  // A run the deadline shortened and that then timed out says nothing about the bug.
  if (r.hostError === 'timeout' && t < PROBE_TIMEOUT_MS) return null;
  return r;
}

async function prove(p: Prover, probe: string): Promise<ProbeResult[] | null> {
  const runs: ProbeResult[] = [];
  for (const k of [1, 2]) {
    let r = await proofRun(p, probe, String(k));
    if (!r) return null;
    if (r.hostError) {
      if ((await answers(p.ctx.target)) === null) {
        p.notes.push(`${probe} re-run ${k}: ${r.error}; the app no longer answers at ${p.ctx.target}, so it was not retried`);
      } else {
        p.notes.push(`${probe} re-run ${k}: ${r.error}; retried once`);
        r = await proofRun(p, probe, `${k}.retry`);
        if (!r) return null;
      }
    }
    runs.push(r);
  }
  return runs;
}

type Judged = { kind: 'confirmed'; f: Confirmed } | { kind: 'intermittent' | 'dropped' | 'notRerunnable'; f: Unconfirmed };
type Read = { state: 'failed'; detail: string } | { state: 'held' } | { state: 'none'; why: string };

// Confirmed when the check failed in both re-runs, intermittent when in one.
// Otherwise it did not reproduce only if the check ran and held both times. A
// re-run says nothing about the bug when it never got to the check (the probe
// threw or timed out first, or the check is not in its result), or when it
// did not start as the hunt run did (its reset or its sign-in failed, and the
// hunt run's had not): then the claim could not be re-run.
export function judge(f: Finding, runs: ProbeResult[], hunt?: ProbeResult): Judged {
  const severity = severityOf(f.severity);
  const reads = runs.map((r, i) => readRun(r, i + 1, f.check, hunt));
  const failed = reads.flatMap((o) => (o.state === 'failed' ? [o.detail] : []));
  if (failed.length === runs.length) return { kind: 'confirmed', f: { ...f, severity, runs: failed } };
  const why = reads.map((o, i) => (o.state === 'none' ? o.why : `${o.state} on re-run ${i + 1}`)).join('; ');
  const kind = failed.length ? 'intermittent' : reads.every((o) => o.state === 'held') ? 'dropped' : 'notRerunnable';
  return { kind, f: { ...f, severity, why } };
}

function readRun(r: ProbeResult, k: number, check: string, hunt: ProbeResult | undefined): Read {
  if (r.before?.resetError && !hunt?.before?.resetError) return { state: 'none', why: `re-run ${k} does not count: the reset before it failed, as it had not before the hunt run` };
  if (signedOut(r.before) && !signedOut(hunt?.before)) return { state: 'none', why: `re-run ${k} does not count: it ran signed out, as the sign-in after the reset failed, which it had not before the hunt run` };
  const o = outcome(r, check);
  return o.state === 'missing' ? { state: 'none', why: notReached(r, k) } : o;
}

function notReached(r: ProbeResult, k: number): string {
  const setup = [
    ...(r.before?.resetError ? ['the reset before it failed'] : []),
    ...(signedOut(r.before) ? ['it ran signed out: the sign-in after the reset failed'] : []),
  ];
  return `re-run ${k} never reached the check${setup.length ? ` (${setup.join('; ')})` : ''}: ${r.error ? brief(r.error) : 'the check is not in its result'}`;
}

// Said first among the claims that could not be re-run: when the sign-in
// after a reset failed with no session saved, the re-runs it came before ran
// signed out. Only the re-runs of the probes behind the listed claims count,
// so a list cut by severity, or a claim found signed out and re-run so, says
// nothing about it.
export function signInLine(byProbe: Map<string, ProbeResult[]>, probes: Iterable<string> = byProbe.keys()): string | null {
  const runs = [...new Set(probes)].flatMap((p) => byProbe.get(p) ?? []).filter((r) => r.before);
  const failed = runs.flatMap((r) => (signedOut(r.before) ? [r.before!.signIn!] : []));
  const first = failed[0];
  if (first) {
    return failed.length === runs.length
      ? `After reset, the sign-in probe "${first.probe}" failed: ${brief(first.error!)}. Each claimed probe then ran signed out.`
      : `After reset, the sign-in probe "${first.probe}" failed before ${failed.length} of ${runs.length} re-runs: ${brief(first.error!)}. Those re-runs ran signed out.`;
  }
  return null;
}

const ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

// --proof-seconds lowers the proof budget, never raises it.
export function proofSeconds(args: string[]): number | null {
  const value = flag(args, '--proof-seconds');
  if (value === null) return args.includes('--proof-seconds') ? null : PROOF_SECONDS;
  const n = Number(value);
  return /^\d+$/.test(value) && n >= 1 && n <= PROOF_SECONDS ? n : null;
}

export async function finish(args: string[]): Promise<void> {
  const startedAt = Date.now();
  const { ctx, dir, root } = loadRun(args);
  const budget = proofSeconds(args);
  if (budget === null) refuse(ctx, [`--proof-seconds is a whole number from 1 to ${PROOF_SECONDS}.`]);
  const parsed = parseFinishInput(readStdin());
  if (!parsed.ok) refuse(ctx, [parsed.message, 'Fix it and call finish again.']);
  const input = parsed.input;
  const latest = latestResults(dir);

  const problems = claimProblems(input, latest);
  if (problems.length) refuse(ctx, [...problems.map((p) => `- ${p}`), 'Fix these and call finish again. Nothing was re-run.']);

  const state = readState(dir);
  const missing = unaccounted(input, latest);
  const signIn = signInProbe(dir);
  const cov = coverage(allResults(dir), ctx.target);
  const left = remaining(ctx);
  const refusal: string[] = [];
  if (missing.length && !state.accountingRefused) {
    state.accountingRefused = true;
    refusal.push(
      `${missing.length} failed check${missing.length === 1 ? ' is' : 's are'} in neither findings nor dismissed:`,
      ...missing.map((m) => `- ${m.probe} / ${m.check}: ${m.detail}`),
      'Claim each as a finding, or dismiss it with {"probe", "check", "reason"}: probe-wrong, duplicate (with "duplicateOf": the finding\'s title), intended, not-this-change or resilience-gap.',
    );
  }
  if (left > COVERAGE_REFUSAL_SECONDS && (cov.neverFaulted.length || cov.neverNarrow.length) && !state.coverageRefused) {
    state.coverageRefused = true;
    refusal.push(
      `${left} s of the budget remain and the coverage has gaps:`,
      ...coverageLines(cov).slice(1),
      `Probe what belongs to ${ctx.mode === 'feature' ? 'this feature' : 'this change'}. What is outside it can stay: calling finish again accepts.`,
    );
  }
  if (refusal.length) {
    writeFileSync(path.join(dir, 'finish-state.json'), JSON.stringify(state, null, 2) + '\n');
    refuse(ctx, [...refusal, 'This is said once; the next finish accepts and records what is still open.']);
  }

  writeFileSync(path.join(dir, 'leads.json'), JSON.stringify(input.leads, null, 2) + '\n');
  const config = readConfig(root);
  mkdirSync(path.join(dir, 'proof'), { recursive: true });
  const proofDeadline = startedAt + budget * 1000;
  const prover: Prover = { dir, root, ctx, config, latest, signIn, notes: [], wallDeadline: startedAt + wallSeconds() * 1000 };
  const order = proofOrder(input.findings);
  const byProbe = new Map<string, ProbeResult[]>();
  const settle = (complete: boolean) => writeReport({ ctx, dir, input, missing, cov, latest, byProbe, notes: prover.notes, startedAt, budget, wall: wallSeconds(), order, complete });
  // Most severe first, and the report is written before the proof and again
  // after every proved probe, so a finish that is stopped part way still
  // leaves its findings.
  settle(false);
  for (const probe of order) {
    if (Date.now() >= proofDeadline) break;
    // Snapshot the exact script being proved, so keep saves the probe that was
    // confirmed even if it is later re-run under the same name.
    copyFileSync(path.join(probesDir(dir), `${probe}.mjs`), path.join(dir, 'proof', `${probe}.mjs`));
    const runs = await prove(prover, probe);
    if (runs) byProbe.set(probe, runs);
    settle(false);
  }
  process.stdout.write(block(settle(true)));
}

interface ReportInput {
  ctx: Context;
  dir: string;
  input: FinishInput;
  missing: Unaccounted[];
  cov: ReturnType<typeof coverage>;
  latest: Map<string, ProbeResult>;
  byProbe: Map<string, ProbeResult[]>;
  notes: string[];
  startedAt: number;
  budget: number;
  wall: number;
  order: string[];
  complete: boolean;
}

// Writes findings.json and report.txt from the probes proved so far and
// returns the printed report. A claim whose probe has no proof yet is listed
// as not re-run in time and not counted.
function writeReport(r: ReportInput): string[] {
  const { ctx, dir, input, missing, cov } = r;
  const confirmed: Confirmed[] = [];
  const intermittent: Unconfirmed[] = [];
  const dropped: Unconfirmed[] = [];
  const notRerunnable: Unconfirmed[] = [];
  const notRerun: Unconfirmed[] = [];
  for (const f of input.findings) {
    const runs = r.byProbe.get(f.probe);
    if (!runs) { notRerun.push({ ...f, severity: severityOf(f.severity), why: 'no time to re-run it before the proof budget or the wall limit ran out' }); continue; }
    const j = judge(f, runs, r.latest.get(f.probe));
    if (j.kind === 'confirmed') confirmed.push(j.f);
    else if (j.kind === 'intermittent') intermittent.push(j.f);
    else if (j.kind === 'notRerunnable') notRerunnable.push(j.f);
    else dropped.push(j.f);
  }
  const bySeverity = (a: { severity: Severity }, b: { severity: Severity }) => ORDER[a.severity] - ORDER[b.severity];
  confirmed.sort(bySeverity);
  notRerunnable.sort(bySeverity);
  notRerun.sort(bySeverity);
  const shown = confirmed.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const shownIntermittent = intermittent.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const shownNotRerunnable = notRerunnable.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const shownNotRerun = notRerun.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const erred = [...r.latest].filter(([, x]) => x.error).map(([name, x]) => `${name}: ${x.error}`);
  const finishSeconds = Math.round((Date.now() - r.startedAt) / 1000);
  const proof = { budgetSeconds: r.budget, wallLimitSeconds: r.wall, finishSeconds, complete: r.complete, order: r.order, proved: [...r.byProbe.keys()] };
  writeWhole(path.join(dir, 'findings.json'), JSON.stringify({ confirmed, intermittent, dropped, notRerunnable, notRerun, dismissed: input.dismissed, unaccounted: missing, coverage: cov, notes: r.notes, proof }, null, 2) + '\n');

  const reportPath = `${FOLDER}/runs/${ctx.runId}/report.txt`;
  const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
  const header = [
    `stillhunter | ${minutesAndSeconds(elapsed)} | run ${ctx.runId} | ${confirmed.length} confirmed, ${intermittent.length} intermittent, ${dropped.length} did not reproduce${notRerunnable.length ? `, ${notRerunnable.length} could not re-run` : ''}${notRerun.length ? `, ${notRerun.length} not re-run in time` : ''}`,
    `target: ${ctx.target} | asked: ${ctx.focus ?? 'the change'}${ctx.minSeverity === 'low' ? '' : ` | showing ${ctx.minSeverity} severity and above`}`,
  ];
  const findingLines = (list: Confirmed[]) => list.flatMap((f, i) => [
    `${i + 1}. ${f.severity.toUpperCase().padEnd(6)} ${f.title}`,
    ...(f.where ? [`   where: ${f.where}`] : []),
    ...(f.expected ? [`   expected: ${f.expected}`] : []),
    `   saw: ${f.runs[0] ?? f.actual ?? ''}`,
    `   repro: ${FOLDER}/runs/${ctx.runId}/probes/${f.probe}.mjs (expectation "${f.check}")`,
  ]);
  const listBlock = (title: string, list: Unconfirmed[], why = false) => (list.length
    ? ['', `${title}:`, ...list.map((f) => `- ${f.title} (probe ${f.probe}, expectation "${f.check}")${why ? `: ${f.why}` : ''}`)]
    : []);
  // The sign-in's failure comes first, as it is the likely reason for the rest.
  const rerunBlock = (list: Unconfirmed[]) => {
    if (!list.length) return [];
    const signInTrouble = signInLine(r.byProbe, list.map((f) => f.probe));
    return [
      '', `${NOT_RERUNNABLE}:`,
      ...(signInTrouble ? [signInTrouble] : []),
      ...list.map((f) => `- ${f.title} (probe ${f.probe}, expectation "${f.check}"): ${f.why}`),
    ];
  };
  const coverageSection = ['', 'Coverage', ...coverageLines(cov)];
  // Findings below the floor, of every kind, are hidden from the printed
  // report; report.txt lists all of them.
  const hidden = hiddenLine((confirmed.length - shown.length) + (intermittent.length - shownIntermittent.length) + (notRerunnable.length - shownNotRerunnable.length) + (notRerun.length - shownNotRerun.length), ctx.minSeverity, reportPath);

  const printed = [
    ...header,
    ...(shown.length ? ['', 'Findings (each reproduced twice from scratch)', ...findingLines(shown)] : ['', confirmed.length ? 'No finding at this severity reproduced.' : 'No finding reproduced.']),
    ...(hidden ? [hidden] : []),
    ...listBlock(INTERMITTENT, shownIntermittent, true),
    ...rerunBlock(shownNotRerunnable),
    ...listBlock(NOT_RERUN, shownNotRerun),
    ...coverageSection,
  ];
  const full = [
    ...header,
    ...(confirmed.length ? ['', 'Findings (each reproduced twice from scratch)', ...findingLines(confirmed)] : ['', 'No finding reproduced.']),
    ...listBlock(INTERMITTENT, intermittent, true),
    ...rerunBlock(notRerunnable),
    ...listBlock(NOT_RERUN, notRerun),
    ...(dropped.length ? ['', 'Did not reproduce:', ...dropped.map((f) => `- ${f.title}: ${f.why}`)] : []),
    ...(input.dismissed.length ? ['', 'Dismissed:', ...input.dismissed.map(dismissalLine)] : []),
    ...(missing.length ? ['', 'Unaccounted (failed, neither claimed nor dismissed):', ...missing.map(unaccountedLine)] : []),
    ...(erred.length ? ['', 'Probes whose latest run ended in an error:', ...erred.map((e) => `- ${e}`)] : []),
    ...(r.notes.length ? ['', 'Proof notes:', ...r.notes.map((n) => `- ${n}`)] : []),
    ...coverageSection,
    '',
    `Proof: ${r.byProbe.size} of ${r.order.length} claimed probes re-run in ${finishSeconds} s (budget ${r.budget} s)${r.complete ? '' : '; finish had not ended when this was written'}`,
    `Leads (not tested to proof): ${input.leads.length}, in ${FOLDER}/runs/${ctx.runId}/leads.json`,
  ];
  writeWhole(path.join(dir, 'report.txt'), full.join('\n') + '\n');
  return printed;
}

const dismissalLine = (d: Dismissal) => `- ${d.probe} / ${d.check}: ${d.reason}${d.duplicateOf ? ` of "${d.duplicateOf}"` : ''}${d.why ? `: ${d.why}` : ''}`;
const unaccountedLine = (u: Unaccounted) => `- ${u.probe} / ${u.check}: ${u.detail}`;
