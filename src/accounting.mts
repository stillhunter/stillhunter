// What finish asks of the hunter's claims before anything is re-run: each
// finding names a check that failed in its probe's latest run, and every
// failed check is either claimed or dismissed with a reason.
import { SEVERITIES } from './common.mjs';
import { failedChecks, outcome, type ProbeResult } from './results.mjs';

export const REASONS = ['probe-wrong', 'duplicate', 'intended', 'not-this-change', 'resilience-gap'] as const;
export type Reason = (typeof REASONS)[number];

export interface Finding {
  title: string;
  severity?: string;
  probe: string;
  check: string;
  where?: string;
  expected?: string;
  actual?: string;
}

export interface Dismissal {
  probe: string;
  check: string;
  reason: Reason;
  duplicateOf?: string;
  why?: string;
}

export interface FinishInput {
  findings: Finding[];
  dismissed: Dismissal[];
  leads: unknown[];
}

export function parseFinishInput(raw: string): { ok: true; input: FinishInput } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, message: `The input on stdin is not JSON: ${(e as Error).message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, message: 'The input is a JSON object: {"findings": [...], "dismissed": [...], "leads": [...]}.' };
  const o = data as Record<string, unknown>;
  for (const key of ['findings', 'dismissed', 'leads']) {
    if (o[key] !== undefined && !Array.isArray(o[key])) return { ok: false, message: `"${key}" must be a list.` };
  }
  return { ok: true, input: { findings: (o.findings as Finding[]) ?? [], dismissed: (o.dismissed as Dismissal[]) ?? [], leads: (o.leads as unknown[]) ?? [] } };
}

const label = (kind: string, i: number, title?: unknown) => `${kind} ${i + 1}${typeof title === 'string' && title ? ` "${title}"` : ''}`;
const listOf = (names: string[]) => (names.length ? names.join(', ') : 'none');

// Refusals the hunter can fix at once, each saying how.
export function claimProblems(input: FinishInput, latest: Map<string, ProbeResult>): string[] {
  const problems: string[] = [];
  const probes = [...latest.keys()];
  const checkAt = (where: string, probe: unknown, check: unknown): boolean => {
    if (typeof probe !== 'string' || !probe) { problems.push(`${where}: give "probe", the name of the probe that shows it.`); return false; }
    const r = latest.get(probe);
    if (!r) { problems.push(`${where}: there is no probe named "${probe}" with a result. Probes in this run: ${listOf(probes)}.`); return false; }
    if (typeof check !== 'string' || !check) { problems.push(`${where}: give "check", the name of the expectation that fails. Failed in "${probe}": ${listOf(failedChecks(r))}.`); return false; }
    const o = outcome(r, check);
    if (o.state === 'held') { problems.push(`${where}: check "${check}" passed in the latest run of "${probe}". A claim needs a check that fails; rerun the probe, or take it out.`); return false; }
    if (o.state === 'missing') {
      const isNote = (r.notes ?? []).some((n) => n.label === check);
      problems.push(isNote
        ? `${where}: "${check}" is a note in "${probe}", not a check. Record it with rr.expect, rerun the probe, then claim it.`
        : `${where}: the latest run of "${probe}" has no check "${check}". Failed checks there: ${listOf(failedChecks(r))}.`);
      return false;
    }
    return true;
  };
  input.findings.forEach((f, i) => {
    const where = label('finding', i, f?.title);
    if (!f || typeof f !== 'object') { problems.push(`${where}: each finding is an object.`); return; }
    if (typeof f.title !== 'string' || !f.title.trim()) problems.push(`${where}: give it a "title".`);
    if (f.severity !== undefined && !SEVERITIES.includes(String(f.severity).toLowerCase() as never)) problems.push(`${where}: "severity" is high, medium or low.`);
    checkAt(where, f.probe, f.check);
  });
  const titles = new Set(input.findings.map((f) => f?.title).filter((t): t is string => typeof t === 'string'));
  input.dismissed.forEach((d, i) => {
    const where = label('dismissal', i);
    if (!d || typeof d !== 'object') { problems.push(`${where}: each dismissal is an object.`); return; }
    if (!REASONS.includes(d.reason)) problems.push(`${where} (${d.probe}/${d.check}): "reason" is one of ${REASONS.join(', ')}.`);
    if (d.reason === 'duplicate' && (typeof d.duplicateOf !== 'string' || !titles.has(d.duplicateOf))) {
      problems.push(`${where} (${d.probe}/${d.check}): a duplicate names the finding it repeats, by its exact title, in "duplicateOf".`);
    }
    checkAt(where, d.probe, d.check);
  });
  return problems;
}

export interface Unaccounted { probe: string; check: string; detail: string }

// Failed checks in the latest runs that no finding claims and no dismissal explains.
export function unaccounted(input: FinishInput, latest: Map<string, ProbeResult>): Unaccounted[] {
  const covered = new Set([...input.findings, ...input.dismissed].map((x) => `${x?.probe}\u0000${x?.check}`));
  const out: Unaccounted[] = [];
  for (const [probe, r] of latest) {
    for (const check of failedChecks(r)) {
      if (covered.has(`${probe}\u0000${check}`)) continue;
      const o = outcome(r, check);
      out.push({ probe, check, detail: o.state === 'failed' ? o.detail : '' });
    }
  }
  return out;
}
