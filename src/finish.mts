// finish: checks the hunter's claims, makes it account for every failed check
// and for what it never covered, re-runs each claimed probe twice from scratch
// and reports what reproduced.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimProblems, type Dismissal, type Finding, type FinishInput, parseFinishInput, unaccounted, type Unaccounted } from './accounting.mjs';
import { atOrAbove, block, type Config, type Context, flag, FOLDER, loadRun, minutesAndSeconds, readConfig, readStdin, remaining, type Severity, severityOf } from './common.mjs';
import { coverage, coverageLines } from './coverage.mjs';
import { hiddenLine } from './flags.mjs';
import { KILL_GRACE_MS, PROBE_TIMEOUT_MS, runProbe } from './probe-host.mjs';
import { allResults, latestResults, outcome, type ProbeResult, probesDir, signInProbe } from './results.mjs';
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
const RESET_TIMEOUT_MS = 120_000;
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

// Runs the configured reset in the repository root. Its failure does not stop
// the proof; it is noted in the report.
export function resetApp(root: string, config: Config, timeoutMs = RESET_TIMEOUT_MS): string | null {
  if (!config.reset) return null;
  const r = spawnSync(config.reset, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs });
  if (r.status === 0) return null;
  const why = r.error ? r.error.message : `exit ${r.status ?? r.signal}`;
  return `reset ("${config.reset}") failed: ${why}${r.stderr ? `: ${r.stderr.trim().slice(-300)}` : ''}`;
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
function writeWhole(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
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
  signIn: string | null;
  notes: string[];
  wallDeadline: number;
}

// One re-run from scratch, or null when the wall deadline leaves no room for
// it (or cut it short), so the probe counts as not re-run in time.
async function proofRun(p: Prover, probe: string, label: string): Promise<ProbeResult | null> {
  const proofDir = path.join(p.dir, 'proof');
  const host = (name: string, file: string, timeoutMs: number) => runProbe({
    runDir: p.dir, probe: name, probeFile: path.join(probesDir(p.dir), `${name}.mjs`), target: p.ctx.target, browser: p.ctx.browser,
    signInVariables: p.ctx.signInVariables, shotsDir: path.join(proofDir, 'shots'), timeoutMs,
  }).then((r) => { writeFileSync(path.join(proofDir, file), JSON.stringify(r, null, 2) + '\n'); return r; });
  // App data and, with it, any session go back to the start; the sign-in probe
  // then signs in again so the claimed probe starts as it did in the hunt.
  if (p.config.reset) {
    const resetMs = Math.min(RESET_TIMEOUT_MS, p.wallDeadline - Date.now() - KILL_GRACE_MS - RUN_MARGIN_MS - MIN_RUN_MS);
    if (resetMs <= 0) return null;
    const failed = resetApp(p.root, p.config, resetMs);
    if (failed) p.notes.push(`before ${probe} ${label}: ${failed}`);
    if (p.signIn && p.signIn !== probe) {
      const t = runTimeout(Date.now(), p.wallDeadline);
      if (t === null) return null;
      const s = await host(p.signIn, `${probe}.${label}.signin.result.json`, t);
      // Cut short by the deadline, it says nothing, and the claimed probe
      // would run signed out.
      if (s.hostError === 'timeout' && t < PROBE_TIMEOUT_MS) return null;
      if (s.error || !s.savedSession) p.notes.push(`before ${probe} ${label}: signing in again with "${p.signIn}" failed: ${s.error ?? 'no session saved'}`);
    }
  }
  const t = runTimeout(Date.now(), p.wallDeadline);
  if (t === null) return null;
  const r = await host(probe, `${probe}.${label}.result.json`, t);
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

function judge(f: Finding, runs: ProbeResult[]): { kind: 'confirmed'; f: Confirmed } | { kind: 'intermittent' | 'dropped'; f: Unconfirmed } {
  const severity = severityOf(f.severity);
  const outcomes = runs.map((r) => outcome(r, f.check));
  const failed = outcomes.flatMap((o) => (o.state === 'failed' ? [o.detail] : []));
  if (failed.length === runs.length) return { kind: 'confirmed', f: { ...f, severity, runs: failed } };
  if (failed.length > 0) return { kind: 'intermittent', f: { ...f, severity, why: `failed in ${failed.length} of ${runs.length} re-runs` } };
  const why = outcomes.map((o, i) => (o.state === 'held' ? `held on re-run ${i + 1}` : `not reached on re-run ${i + 1}${runs[i]?.error ? `: ${runs[i]!.error}` : ''}`)).join('; ');
  return { kind: 'dropped', f: { ...f, severity, why } };
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
  const prover: Prover = { dir, root, ctx, config, signIn: signInProbe(dir), notes: [], wallDeadline: startedAt + wallSeconds() * 1000 };
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
  const notRerun: Unconfirmed[] = [];
  for (const f of input.findings) {
    const runs = r.byProbe.get(f.probe);
    if (!runs) { notRerun.push({ ...f, severity: severityOf(f.severity), why: 'no time to re-run it before the proof budget or the wall limit ran out' }); continue; }
    const j = judge(f, runs);
    if (j.kind === 'confirmed') confirmed.push(j.f);
    else if (j.kind === 'intermittent') intermittent.push(j.f);
    else dropped.push(j.f);
  }
  const bySeverity = (a: { severity: Severity }, b: { severity: Severity }) => ORDER[a.severity] - ORDER[b.severity];
  confirmed.sort(bySeverity);
  notRerun.sort(bySeverity);
  const shown = confirmed.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const shownIntermittent = intermittent.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const shownNotRerun = notRerun.filter((f) => atOrAbove(f.severity, ctx.minSeverity));
  const erred = [...r.latest].filter(([, x]) => x.error).map(([name, x]) => `${name}: ${x.error}`);
  const finishSeconds = Math.round((Date.now() - r.startedAt) / 1000);
  const proof = { budgetSeconds: r.budget, wallLimitSeconds: r.wall, finishSeconds, complete: r.complete, order: r.order, proved: [...r.byProbe.keys()] };
  writeWhole(path.join(dir, 'findings.json'), JSON.stringify({ confirmed, intermittent, dropped, notRerun, dismissed: input.dismissed, unaccounted: missing, coverage: cov, notes: r.notes, proof }, null, 2) + '\n');

  const reportPath = `${FOLDER}/runs/${ctx.runId}/report.txt`;
  const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
  const header = [
    `stillhunter | ${minutesAndSeconds(elapsed)} | run ${ctx.runId} | ${confirmed.length} confirmed, ${intermittent.length} intermittent, ${dropped.length} did not reproduce${notRerun.length ? `, ${notRerun.length} not re-run in time` : ''}`,
    `target: ${ctx.target} | asked: ${ctx.focus ?? 'the change'}${ctx.minSeverity === 'low' ? '' : ` | showing ${ctx.minSeverity} severity and above`}`,
  ];
  const findingLines = (list: Confirmed[]) => list.flatMap((f, i) => [
    `${i + 1}. ${f.severity.toUpperCase().padEnd(6)} ${f.title}`,
    ...(f.where ? [`   where: ${f.where}`] : []),
    ...(f.expected ? [`   expected: ${f.expected}`] : []),
    `   saw: ${f.runs[0] ?? f.actual ?? ''}`,
    `   repro: ${FOLDER}/runs/${ctx.runId}/probes/${f.probe}.mjs (expectation "${f.check}")`,
  ]);
  const listBlock = (title: string, list: Unconfirmed[]) => (list.length
    ? ['', `${title}:`, ...list.map((f) => `- ${f.title} (probe ${f.probe}, expectation "${f.check}")`)]
    : []);
  const coverageSection = ['', 'Coverage', ...coverageLines(cov)];
  // Findings below the floor, of every kind, are hidden from the printed
  // report; report.txt lists all of them.
  const hidden = hiddenLine((confirmed.length - shown.length) + (intermittent.length - shownIntermittent.length) + (notRerun.length - shownNotRerun.length), ctx.minSeverity, reportPath);

  const printed = [
    ...header,
    ...(shown.length ? ['', 'Findings (each reproduced twice from scratch)', ...findingLines(shown)] : ['', confirmed.length ? 'No finding at this severity reproduced.' : 'No finding reproduced.']),
    ...(hidden ? [hidden] : []),
    ...listBlock('Intermittent (1 of 2), not counted', shownIntermittent),
    ...listBlock(NOT_RERUN, shownNotRerun),
    ...coverageSection,
  ];
  const full = [
    ...header,
    ...(confirmed.length ? ['', 'Findings (each reproduced twice from scratch)', ...findingLines(confirmed)] : ['', 'No finding reproduced.']),
    ...listBlock('Intermittent (1 of 2), not counted', intermittent),
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
