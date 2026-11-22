// node benchmark/comparison/analyze.mjs
// Joins trials, judge pass 1 (pass 2 for agreement) and verifier verdicts into
// per-arm measures. Writes results/summary.json and prints markdown tables.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARMS, FEATURES, RESULTS, SET as BUGS } from './lib.mjs';
import { findingKey, scoredTrials } from './judge.mjs';

const INSIDE = new Set(['error-shown-as-empty', 'search-quote-crash', 'failed-save-clears-text', 'water-now-twice', 'negative-litres']);

const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function binom2sided(b, c) {
  const n = b + c; if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0, coef = 1;
  for (let i = 0; i <= k; i++) { if (i > 0) coef = coef * (n - i + 1) / i; p += coef; }
  return Math.min(1, 2 * p / 2 ** n);
}

function permutation(a, b, iters = 10000) {
  let s = 20261112 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const mean = (x) => x.reduce((p, q) => p + q, 0) / (x.length || 1);
  const obs = Math.abs(mean(a) - mean(b));
  const all = [...a, ...b];
  let hits = 0;
  for (let i = 0; i < iters; i++) {
    for (let j = all.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [all[j], all[k]] = [all[k], all[j]]; }
    if (Math.abs(mean(all.slice(0, a.length)) - mean(all.slice(a.length))) >= obs - 1e-12) hits++;
  }
  return (hits + 1) / (iters + 1);
}

// Price every transcript token at the run's own effective rate, taken from the
// main session's reported cost (Opus ratios: output 5x, cache read 0.1x, cache write 1.25x input).
const weighted = (u) => u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheWrite;
function costOf(meta) {
  const mu = Object.values(meta.modelUsage ?? {})[0];
  if (!mu || !meta.reportedCostUsd) return null;
  const main = weighted({ input: mu.inputTokens, output: mu.outputTokens, cacheRead: mu.cacheReadInputTokens, cacheWrite: mu.cacheCreationInputTokens });
  return main > 0 ? meta.reportedCostUsd * (weighted(meta.usage) / main) : null;
}

const trials = scoredTrials();
const judged = {}; const judged2 = {}; const issues = {};
for (const f of FEATURES) {
  const j1 = readJson(path.join(RESULTS, 'judge', `${f}.pass1.json`));
  const j2 = readJson(path.join(RESULTS, 'judge', `${f}.pass2.json`));
  for (const r of j1?.reports ?? []) judged[r.key] = r;
  for (const r of j2?.reports ?? []) judged2[r.key] = r;
  Object.assign(issues, Object.fromEntries(Object.entries(j1?.issues ?? {}).map(([k, v]) => [`${f}/${k}`, v])));
}
const verdicts = {};
for (const f of FEATURES) {
  const dir = path.join(RESULTS, 'verify', f);
  if (!existsSync(dir)) continue;
  for (const k of readdirSync(dir)) { const v = readJson(path.join(dir, k, 'verdict.json')); if (v) verdicts[`${f}/${k}`] = v; }
}

const regressions = {};
for (const f of FEATURES) {
  const dir = path.join(RESULTS, 'regression', f);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const r = readJson(path.join(dir, file));
    if (r?.findingKey) regressions[r.findingKey] = r;
  }
}

const reproductionOf = Object.fromEntries(Object.values(verdicts).filter((v) => v.findingKey).map((v) => [v.findingKey, v.verdict]));
const rows = [];
let agree = 0, compared = 0;
for (const t of trials) {
  t.findings.forEach((f, i) => {
    const key = findingKey(t.id, i);
    const j = judged[key];
    if (judged2[key] && j) { compared++; if ((judged2[key].planted ?? null) === (j.planted ?? null)) agree++; }
    let cls = 'unjudged';
    if (j?.planted) cls = f.status === 'observed' ? 'planted-observed' : 'planted-suspected';
    else if (j) {
      const v = verdicts[`${t.meta.feature}/${j.issue}`]?.verdict;
      cls = v === 'confirmed' ? 'extra-confirmed' : v === 'not-a-defect' || v === 'not-reproduced' ? `false-${v}` : 'unverified';
    }
    rows.push({ trial: t.id, arm: t.meta.arm, feature: t.meta.feature, bug: t.meta.bug, n: t.meta.trial, status: f.status, state: f.tool?.state ?? null, cls, issue: j ? `${t.meta.feature}/${j.issue}` : null, reproduction: j?.planted ? reproductionOf[key] ?? 'unverified' : null, regression: cls === 'planted-observed' ? regressions[key]?.classification ?? 'unevaluated' : null });
  });
}

const per = {};
for (const arm of ARMS) {
  const ts = trials.filter((t) => t.meta.arm === arm);
  const fr = rows.filter((r) => r.arm === arm);
  const buggy = ts.filter((t) => t.meta.bug !== 'clean');
  const found = (t, kind) => rows.some((r) => r.trial === t.id && r.cls === kind);
  const outcomes = buggy.map((t) => ({ bug: t.meta.bug, n: t.meta.trial, found: found(t, 'planted-observed'), mentioned: !found(t, 'planted-observed') && found(t, 'planted-suspected') }));
  const k = outcomes.filter((o) => o.found).length;
  const inside = outcomes.filter((o) => INSIDE.has(o.bug));
  const outside = outcomes.filter((o) => !INSIDE.has(o.bug));
  const fa = (t) => rows.filter((r) => r.trial === t.id && r.cls.startsWith('false-')).length;
  const real = fr.filter((r) => r.cls.startsWith('planted') || r.cls === 'extra-confirmed').length;
  const decided = fr.filter((r) => !['unverified', 'unjudged'].includes(r.cls)).length;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
  const costs = ts.map((t) => costOf(t.meta)).filter((c) => c !== null);
  const planted = fr.filter((r) => r.cls.startsWith('planted'));
  const reproductionCount = (state) => planted.filter((r) => r.reproduction === state).length;
  const regressionRows = fr.filter((r) => r.cls === 'planted-observed');
  const regressionCount = (state) => regressionRows.filter((r) => r.regression === state).length;
  per[arm] = {
    runs: ts.length,
    recall: { found: k, chances: outcomes.length, wilson95: wilson(k, outcomes.length), mentionedOnly: outcomes.filter((o) => o.mentioned).length,
      inside: [inside.filter((o) => o.found).length, inside.length], outside: [outside.filter((o) => o.found).length, outside.length] },
    perBug: Object.fromEntries(Object.values(BUGS).flat().map((b) => [b, outcomes.filter((o) => o.bug === b && o.found).length + '/' + outcomes.filter((o) => o.bug === b).length])),
    plantedReproduction: { total: planted.length, confirmed: reproductionCount('confirmed'), wilson95: wilson(reproductionCount('confirmed'), planted.length), notReproduced: reproductionCount('not-reproduced'), notADefect: reproductionCount('not-a-defect'), inconclusive: reproductionCount('inconclusive'), unverified: reproductionCount('unverified') },
    regressionTests: {
      eligible: regressionRows.length,
      available: regressionRows.filter((r) => !['missing', 'unevaluated'].includes(r.regression)).length,
      valid: regressionCount('valid'), wilson95: wilson(regressionCount('valid'), regressionRows.length), notSensitive: regressionCount('not-sensitive'), wrongExpectation: regressionCount('wrong-expectation'),
      unstable: regressionCount('unstable'), inconclusive: regressionCount('inconclusive'), missing: regressionCount('missing'), unevaluated: regressionCount('unevaluated'),
    },
    findings: fr.length,
    byClass: fr.reduce((m, r) => ((m[r.cls] = (m[r.cls] ?? 0) + 1), m), {}),
    precision: decided ? real / decided : null,
    precisionWilson95: wilson(real, decided),
    falseAlarmsPerRun: ts.length ? sum(ts.map(fa)) / ts.length : null,
    falseAlarmsPerCleanRun: (() => { const c = ts.filter((t) => t.meta.bug === 'clean'); return c.length ? sum(c.map(fa)) / c.length : null; })(),
    falseAlarmList: ts.map(fa),
    distinctConfirmedExtras: [...new Set(fr.filter((r) => r.cls === 'extra-confirmed').map((r) => r.issue))],
    medianWallMin: median(ts.map((t) => t.meta.wallMs / 60000)),
    totalTokens: sum(ts.map((t) => t.meta.usage.input + t.meta.usage.output + t.meta.usage.cacheRead + t.meta.usage.cacheWrite)),
    medianOutputTokens: median(ts.map((t) => t.meta.usage.output)),
    medianCostUsd: median(costs), totalCostUsd: sum(costs),
    killedAtLimit: ts.filter((t) => t.meta.killedAtLimit).length,
    sourceChanged: ts.filter((t) => t.meta.sourceChanged).length,
    // A run that left no findings.json failed: its arm never reported. It still
    // counts as a chance at its planted bug, and it is listed by name.
    failedRuns: ts.filter((t) => t.meta.findingsFile !== 'ok').map((t) => t.id),
    noFindingsFile: ts.filter((t) => t.meta.findingsFile !== 'ok').length,
    medianFinishSeconds: median(ts.map((t) => t.meta.finishSeconds).filter((x) => typeof x === 'number')),
    maxFinishSeconds: (() => { const xs = ts.map((t) => t.meta.finishSeconds).filter((x) => typeof x === 'number'); return xs.length ? Math.max(...xs) : null; })(),
    proofCutShort: ts.filter((t) => t.meta.proofComplete === false).map((t) => t.id),
    outcomes,
  };
}

const pairs = {};
const PAIRS = [
  ['stillhunter', 'playwright'], ['stillhunter', 'adversarial'], ['stillhunter', 'baseline'],
  ['adversarial', 'playwright'], ['adversarial', 'baseline'], ['playwright', 'baseline'],
].filter(([a, b]) => ARMS.includes(a) && ARMS.includes(b));
for (const [a, b] of PAIRS) {
  const oa = Object.fromEntries(per[a].outcomes.map((o) => [`${o.bug}#${o.n}`, o.found]));
  const ob = Object.fromEntries(per[b].outcomes.map((o) => [`${o.bug}#${o.n}`, o.found]));
  const keys = Object.keys(oa).filter((k) => k in ob);
  const onlyA = keys.filter((k) => oa[k] && !ob[k]).length, onlyB = keys.filter((k) => !oa[k] && ob[k]).length;
  pairs[`${a} vs ${b}`] = { pairs: keys.length, onlyFirst: onlyA, onlySecond: onlyB, mcnemarExactP: binom2sided(onlyA, onlyB),
    falseAlarmPermutationP: permutation(per[a].falseAlarmList, per[b].falseAlarmList) };
}

const summary = { generatedAt: new Date().toISOString(), judgeAgreementOnPlanted: compared ? { agree, compared } : null, per, pairs, issues, verdicts, rows };
writeFileSync(path.join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
console.log('| Arm | Runs | Failed runs | Planted bugs found | 95% CI | Inside / outside catalogue | Findings | Precision | False alarms per run | Median time | Median cost |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const arm of ARMS) {
  const p = per[arm];
  console.log(`| ${arm} | ${p.runs} | ${p.failedRuns.length} | ${p.recall.found}/${p.recall.chances} | ${pct(p.recall.wilson95[0])} to ${pct(p.recall.wilson95[1])} | ${p.recall.inside.join('/')} , ${p.recall.outside.join('/')} | ${p.findings} | ${pct(p.precision)} | ${p.falseAlarmsPerRun?.toFixed(2)} | ${p.medianWallMin?.toFixed(1)} min | ${p.medianCostUsd == null ? 'n/a' : `$${p.medianCostUsd.toFixed(2)}`} |`);
  console.log(`${arm} planted reproduction: ${p.plantedReproduction.confirmed}/${p.plantedReproduction.total} confirmed; regression tests: ${p.regressionTests.valid}/${p.regressionTests.eligible} valid, ${p.regressionTests.available} available`);
}
console.log('\nFailed runs (no findings.json, counted as not found):');
for (const arm of ARMS) console.log(arm, per[arm].failedRuns.length ? per[arm].failedRuns.join(', ') : 'none');
if (ARMS.includes('stillhunter')) {
  const p = per.stillhunter;
  console.log(`\nstillhunter finish: median ${p.medianFinishSeconds ?? 'n/a'} s, longest ${p.maxFinishSeconds ?? 'n/a'} s; proof cut short in ${p.proofCutShort.length ? p.proofCutShort.join(', ') : 'no run'}`);
}
console.log('\nPer bug (found / runs):');
for (const arm of ARMS) console.log(arm, JSON.stringify(per[arm].perBug));
console.log('\nClasses:'); for (const arm of ARMS) console.log(arm, JSON.stringify(per[arm].byClass), 'distinct confirmed extras:', per[arm].distinctConfirmedExtras.length);
console.log('\nPairs:', JSON.stringify(pairs, null, 1));
console.log('\nJudge agreement on planted matches:', JSON.stringify(summary.judgeAgreementOnPlanted));
