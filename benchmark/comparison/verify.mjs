// node benchmark/comparison/verify.mjs <lanes>
// Checks every planted report separately and every distinct non-planted issue
// on a fresh copy of its feature. The verifier sees reports and variants, never
// arm names. A verdict is confirmed only when reproduction and defect validity
// both hold; an interrupted or unobserved attempt is inconclusive.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lanePorts, materializeVariant, mcpConfig, newSessionId, REPO, RESULTS, runClaude, scrubPaths, seed, startApp, FEATURES } from './lib.mjs';
import { scoredTrials } from './judge.mjs';

export function verifyPrompt(feature, sentence, samples, ports, out, scratch) {
  const request = readFileSync(path.join(REPO, 'benchmark/apps/garden-log/features', feature, 'request.md'), 'utf8').trim();
  return `Testers reported a problem with a change to this garden-log web app. Your job is to check, independently and sceptically, whether the problem is real.

The change (uncommitted, see \`git diff main\` and \`git status\`) implements this request:
${request}

The app is running: web http://localhost:${ports.web}, API http://localhost:${ports.api}/api. Sign in with DEMO_EMAIL / DEMO_PASSWORD from the environment. You have a Playwright browser (playwright MCP tools; \`browser_route\` can make requests fail, hang or return odd data). You may read the code. Do not edit files in this repository; scratch files go in ${scratch}.

The reported problem: ${sentence}

Sample reports (they may be wrong, exaggerated or right):
${JSON.stringify(samples, null, 1)}

Independently follow the steps from the start in a fresh browser context. Reproduction and correctness are separate questions: seeing the behavior does not prove the report's expectation is valid. Check that expectation against the request and ordinary user expectations.

Decide one verdict:
- "confirmed": you made the reported behavior happen and it is a defect a user or the request would not accept.
- "not-a-defect": it happens, but it is how the app is meant to work, what the request asks for, or a deliberate design choice.
- "not-reproduced": you completed the reported steps and reasonable variations without making it happen.
- "inconclusive": a crash, timeout, failed reset or sign-in, or an attempt that never reached the reported observation prevented a decision. Never turn an incomplete attempt into confirmed or not-reproduced.
Be strict: "confirmed" needs something you saw. Write JSON to ${out}: {"verdict": "...", "evidence": "what you did and saw", "severity": "high" | "medium" | "low" | null}.`;
}

export function verdictOrInconclusive(value) {
  if (value && ['confirmed', 'not-a-defect', 'not-reproduced', 'inconclusive'].includes(value.verdict)) return value;
  return { verdict: 'inconclusive', evidence: 'The verifier left no readable, recognized verdict.' };
}

const sampleFields = ({ title, where, steps, expected, actual, evidence }) => ({ title, where, steps, expected, actual, evidence });

export function verificationJobs(trials, judgments) {
  const findingOf = (key) => {
    const [tid, i] = key.split('#');
    return trials.find((t) => t.id === tid).findings[Number(i)];
  };
  const jobs = [];
  for (const [feature, j] of Object.entries(judgments)) {
    const byIssue = {};
    for (const r of j.reports) {
      const trial = trials.find((t) => t.id === r.key.split('#')[0]);
      if (r.planted) {
        jobs.push({ feature, bug: trial.meta.bug, key: `planted-${r.id}`, kind: 'planted', findingKey: r.key, sentence: j.issues[r.issue] ?? findingOf(r.key).title, samples: [sampleFields(findingOf(r.key))] });
      } else (byIssue[r.issue] ??= []).push(r.key);
    }
    for (const [key, keys] of Object.entries(byIssue)) {
      // Checked on the clean variant, unless every report came from one buggy variant.
      const variants = [...new Set(keys.map((k) => trials.find((t) => t.id === k.split('#')[0]).meta.bug))];
      const bug = variants.length === 1 ? variants[0] : 'clean';
      jobs.push({ feature, bug, key, kind: 'extra', findingKey: null, sentence: j.issues[key] ?? key, samples: keys.slice(0, 3).map(findingOf).map(sampleFields) });
    }
  }
  return jobs;
}

export function recordVerificationError(job, error, results = RESULTS) {
  const dest = path.join(results, 'verify', job.feature, job.key);
  mkdirSync(dest, { recursive: true });
  const file = path.join(dest, 'verdict.json');
  writeFileSync(file, scrubPaths(JSON.stringify({
    feature: job.feature, variant: job.bug, key: job.key, kind: job.kind, findingKey: job.findingKey, sentence: job.sentence,
    verdict: 'inconclusive', evidence: `Verifier infrastructure failed: ${error.message}`,
  }, null, 2)) + '\n');
  return file;
}

async function verifyOne(job, lane) {
  const { feature, bug, key, kind, findingKey, sentence, samples } = job;
  const dest = path.join(RESULTS, 'verify', feature, key);
  if (existsSync(path.join(dest, 'verdict.json'))) return;
  mkdirSync(dest, { recursive: true });
  const work = path.join(process.env.BENCH_WORK, `verify-${feature}-${key}`);
  const scratch = path.join(work, 'scratch'); const outDir = path.join(work, 'out');
  mkdirSync(scratch, { recursive: true }); mkdirSync(outDir, { recursive: true });
  const repo = materializeVariant({ feature, bug }, lane, path.join(work, 'variant'));
  const stop = await startApp(repo, lane, path.join(dest, 'app.log'));
  try {
    await seed(lane, feature);
    const ports = lanePorts(lane);
    const mcpFile = path.join(work, 'mcp.json');
    mcpConfig(mcpFile, path.join(scratch, 'playwright'));
    const out = path.join(outDir, 'verdict.json');
    const text = verifyPrompt(feature, sentence, samples, ports, out, scratch);
    writeFileSync(path.join(dest, 'prompt.txt'), scrubPaths(text) + '\n');
    const r = await runClaude({ cwd: repo, arm: 'playwright', text, sessionId: newSessionId(), outDir, mcpFile });
    writeFileSync(path.join(dest, 'claude.json'), r.stdout);
    let verdict = null;
    try { verdict = JSON.parse(readFileSync(out, 'utf8')); } catch {}
    const checked = verdictOrInconclusive(verdict);
    writeFileSync(path.join(dest, 'verdict.json'), scrubPaths(JSON.stringify({ feature, variant: bug, key, kind, findingKey, sentence, ...checked, wallMs: r.ms }, null, 2)) + '\n');
    console.log(`${feature}/${key}: ${checked.verdict}`);
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const lanes = Number(process.argv[2] ?? '2');
  const trials = scoredTrials();
  const judgments = {};
  for (const feature of FEATURES) {
    const file = path.join(RESULTS, 'judge', `${feature}.pass1.json`);
    if (existsSync(file)) judgments[feature] = JSON.parse(readFileSync(file, 'utf8'));
  }
  const jobs = verificationJobs(trials, judgments);
  console.log(`${jobs.length} reports or issues to verify (${jobs.filter((j) => j.kind === 'planted').length} planted reports)`);
  let next = 0;
  await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { await verifyOne(job, lane + Number(process.env.BENCH_LANE_OFFSET ?? 0)); }
      catch (e) {
        recordVerificationError(job, e);
        console.log(`${job.feature}/${job.key}: inconclusive (${e.message})`);
      }
    }
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
