// node benchmark/comparison/judge.mjs <pass> [feature ...]
// Blind matching: per feature, every scored finding (trials 1 and up), shuffled
// under opaque ids with the variant it came from but never the arm, goes to a
// fresh claude session that marks planted-bug matches and groups the rest
// into distinct issues. Writes results/judge/<feature>.pass<N>.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { FEATURES, MODEL, REPO, RESULTS, SET as BUGS } from './lib.mjs';

const SHAPE = ['title', 'where', 'steps', 'expected', 'actual', 'evidence', 'status'];

export function scoredTrials() {
  const dir = path.join(RESULTS, 'trials');
  return readdirSync(dir).filter((d) => existsSync(path.join(dir, d, 'meta.json')))
    .map((d) => ({ id: d, meta: JSON.parse(readFileSync(path.join(dir, d, 'meta.json'), 'utf8')), findings: JSON.parse(readFileSync(path.join(dir, d, 'findings.json'), 'utf8')).findings }))
    .filter((t) => t.meta.trial >= (process.env.BENCH_INCLUDE_PILOT ? 0 : 1));
}

export const findingKey = (trial, i) => `${trial}#${i}`;
const opaque = (key, pass) => 'F' + createHash('sha256').update(`${pass}:${key}`).digest('hex').slice(0, 8);

function bugText(feature, bug) {
  const m = parse(readFileSync(path.join(REPO, 'benchmark/apps/garden-log/features', feature, 'bugs', bug, 'manifest.yaml'), 'utf8'));
  return `- ${bug}: ${m.symptom}`;
}

function judgePrompt(feature, items) {
  const request = readFileSync(path.join(REPO, 'benchmark/apps/garden-log/features', feature, 'request.md'), 'utf8').trim();
  return `You are judging bug reports from several independent testers about one change to a garden-log web app. You do not know which tester or tool wrote which report, and it does not matter.

The change implements this request:
${request}

Variants: the same change was tested in three variants. "clean" is the change as written. Each other variant has exactly one known defect planted in it:
${BUGS[feature].map((b) => bugText(feature, b)).join('\n')}

For every report below:
1. "planted": the id of the planted defect it describes, only if the report comes from that defect's own variant and describes that same defect (same broken behaviour, any wording, any level of detail). A report that describes a planted defect from another variant is not a match. Otherwise null.
2. "issue": for reports that are not a match, a short kebab-case key naming the distinct problem it describes, so that reports about the same problem share one key across variants (for example "stats-no-retry-after-error"). Use the same key for the same underlying problem even when the wording or the trigger differs a little; use different keys for different problems. For a match, use the planted id.

Then describe every issue key in one neutral sentence: the claimed behaviour, where, and how to trigger it.

Answer with JSON only, no prose: {"reports": [{"id": "...", "planted": null or "<bug id>", "issue": "<key>"}], "issues": {"<key>": "<one sentence>"}}

Reports:
${JSON.stringify(items, null, 1)}`;
}

function shuffled(items, seed) {
  return [...items].sort((a, b) => opaque(a.id, seed).localeCompare(opaque(b.id, seed)));
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1));
}

export function judgmentCoverage(items, answer) {
  const counts = new Map();
  const reports = Array.isArray(answer?.reports) ? answer.reports : [];
  for (const r of reports) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const expected = new Set(items.map((item) => item.id));
  return {
    missing: items.map((item) => item.id).filter((id) => !counts.has(id)),
    duplicates: items.map((item) => item.id).filter((id) => counts.get(id) > 1),
    unknown: [...new Set([...counts.keys()].filter((id) => !expected.has(id)))],
  };
}

export async function judgeWithRetry(items, call) {
  let answer;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { answer = await call(); lastError = null; }
    catch (e) { lastError = e; continue; }
    const coverage = judgmentCoverage(items, answer);
    if (!coverage.missing.length && !coverage.duplicates.length && !coverage.unknown.length) {
      const byId = new Map((Array.isArray(answer?.reports) ? answer.reports : []).map((r) => [r.id, r]));
      return { ...answer, reports: items.map((item) => byId.get(item.id)) };
    }
  }
  return lastError ? { reports: [], issues: {}, error: lastError.message } : answer;
}

async function main([passText = '1', ...features]) {
  const pass = Number(passText);
  const trials = scoredTrials();
  mkdirSync(path.join(RESULTS, 'judge'), { recursive: true });
  for (const feature of features.length ? features : FEATURES) {
    const keyOf = {};
    const items = [];
    for (const t of trials.filter((x) => x.meta.feature === feature)) {
      t.findings.forEach((f, i) => {
        const key = findingKey(t.id, i);
        const id = opaque(key, pass);
        keyOf[id] = key;
        const shown = Object.fromEntries(SHAPE.map((k) => [k, typeof f[k] === 'string' ? f[k].slice(0, 1200) : f[k] ?? '']));
        items.push({ id, variant: t.meta.bug, ...shown });
      });
    }
    const text = judgePrompt(feature, shuffled(items, pass));
    const costs = [];
    const answer = await judgeWithRetry(items, async () => {
      const r = spawnSync('claude', ['-p', '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config', '--tools', '', '--output-format', 'json', '--no-session-persistence'],
        { input: text, encoding: 'utf8', cwd: path.join(RESULTS, 'judge'), maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
      const outer = JSON.parse(r.stdout);
      costs.push(outer.total_cost_usd ?? 0);
      return extractJson(outer.result);
    });
    const coverage = judgmentCoverage(items, answer);
    const issues = answer?.issues && typeof answer.issues === 'object' ? answer.issues : {};
    const reports = (Array.isArray(answer?.reports) ? answer.reports : []).filter((x) => keyOf[x.id]).map((x) => ({ ...x, key: keyOf[x.id] }));
    writeFileSync(path.join(RESULTS, 'judge', `${feature}.pass${pass}.json`), JSON.stringify({ feature, pass, count: items.length, ...coverage, costUsd: costs.reduce((a, b) => a + b, 0), reports, issues }, null, 2) + '\n');
    console.log(`${feature} pass ${pass}: ${items.length} reports, ${Object.keys(issues).length} issues, ${coverage.missing.length} missing, ${coverage.duplicates.length} duplicate, ${coverage.unknown.length} unknown`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
