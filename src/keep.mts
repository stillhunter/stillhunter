// keep and replay: a confirmed finding becomes a test under .stillhunter/tests/
// that runs with no model. A kept test passes when its check holds, so it
// fails while the bug is there and guards against its return once fixed.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chooseBrowser, installedOnThisMachine } from './browser.mjs';
import { ensureRunsIgnored } from './change.mjs';
import { allowedUrl, block, type Context, credentialValues, fail, findTargetUrl, FOLDER, flag, loadRun, PROBE_NAME, readConfig, redact, repoRoot, runsDir, signInVariableNames, stamp, testsDir } from './common.mjs';
import { runProbe, sessionPath } from './probe-host.mjs';
import { resetAndSignIn, shouldReset } from './reset.mjs';
import { type Before, outcome, probesDir, type ProbeResult, signInProbe } from './results.mjs';
import { answers } from './target.mjs';

export const SIGNIN = '_signin';
const WATCH_SLOW_MO_MS = 250;
const WATCH_KEEP_OPEN_MS = 10_000;

export interface KeptTest {
  check: string;
  title: string;
  severity: string;
  keptFrom: { run: string; probe: string };
}

// A kept test is committed, so it must not carry a credential: a probe that
// typed a sign-in value literally instead of reading process.env is refused.
export function credentialIn(script: string, names: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const credentials = names.flatMap((name) => {
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    return typeof value === 'string' && value ? [{ name, value }] : [];
  }).sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of credentials) if (script.includes(value)) return name;
  return null;
}

export function keep(args: string[]): void {
  const { ctx, dir, root } = loadRun(args);
  const probe = flag(args, '--probe');
  const check = flag(args, '--check');
  const as = flag(args, '--as') ?? probe;
  if (!probe || !PROBE_NAME.test(probe)) fail('Give the probe of the finding with --probe.', root);
  if (!check) fail('Give the expectation of the finding with --check.', root);
  if (!as || !PROBE_NAME.test(as)) fail('--as is a name of lowercase letters, digits and dashes.', root);
  let saved: { confirmed?: { probe: string; check: string; title: string; severity: string }[]; proof?: { generation?: unknown } };
  try {
    saved = JSON.parse(readFileSync(path.join(dir, 'findings.json'), 'utf8')) as typeof saved;
  } catch {
    fail(`Run ${ctx.runId} has not finished, so it has no confirmed findings to keep.`, root);
  }
  const confirmed = saved.confirmed ?? [];
  const finding = confirmed.find((f) => f.probe === probe && f.check === check);
  if (!finding) {
    const list = confirmed.map((f) => `--probe ${JSON.stringify(f.probe)} --check ${JSON.stringify(f.check)}`).join('; ');
    fail(`Run ${ctx.runId} confirmed no finding with probe "${probe}" and expectation "${check}". Confirmed: ${list || 'none'}.`, root);
  }
  const signInVariables = [...new Set([...ctx.signInVariables, ...signInVariableNames(process.env, readConfig(root).auth?.env)])];
  // A generation's archived snapshot is immutable. Compatibility copies and
  // the live probe may have been replaced by another finish or probe run.
  const generation = saved.proof?.generation;
  let scriptFile: string;
  let archivedSignIn: { probe: string; script: string } | null | undefined;
  if (generation !== undefined) {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) fail(`Run ${ctx.runId} has an invalid proof generation in findings.json.`, root);
    const generationDir = path.join(dir, 'proof', 'generations', String(generation));
    scriptFile = path.join(generationDir, `${probe}.mjs`);
    if (!existsSync(scriptFile)) fail(`Run ${ctx.runId} is missing the exact proof snapshot for generation ${generation}, probe ${probe}.`, root);
    let setup: { signIn?: unknown };
    try {
      setup = JSON.parse(readFileSync(path.join(generationDir, `${probe}.setup.json`), 'utf8')) as { signIn?: unknown };
    } catch {
      fail(`Run ${ctx.runId} is missing the setup identity for generation ${generation}, probe ${probe}.`, root);
    }
    if (setup.signIn !== null && (typeof setup.signIn !== 'string' || !PROBE_NAME.test(setup.signIn))) fail(`Run ${ctx.runId} has an invalid setup identity for generation ${generation}, probe ${probe}.`, root);
    if (setup.signIn) {
      const setupFile = path.join(generationDir, `${probe}.signin.mjs`);
      if (!existsSync(setupFile)) fail(`Run ${ctx.runId} is missing the exact setup script for generation ${generation}, probe ${probe}.`, root);
      archivedSignIn = { probe: setup.signIn, script: readFileSync(setupFile, 'utf8') };
    } else {
      archivedSignIn = null;
    }
  } else {
    const legacyProof = path.join(dir, 'proof', `${probe}.mjs`);
    scriptFile = existsSync(legacyProof) ? legacyProof : path.join(probesDir(dir), `${probe}.mjs`);
  }
  const script = readFileSync(scriptFile, 'utf8');
  const leaked = credentialIn(script, signInVariables);
  if (leaked) fail(`The probe holds the value of ${leaked}. Kept tests never hold a credential; read it from process.env.${leaked} instead.`, root);
  const dest = path.join(testsDir(root), as);
  if (existsSync(dest)) fail(`A kept test named ${as} exists. Choose another name with --as.`, root);

  const secrets = credentialValues(signInVariables);
  const lines = [`stillhunter | kept | ${as}`];
  const signIn = archivedSignIn === undefined ? signInProbe(dir) : archivedSignIn?.probe ?? null;
  const signInDest = path.join(testsDir(root), `${SIGNIN}.mjs`);
  let signInScript: string | null = null;
  if (signIn && !existsSync(signInDest)) {
    signInScript = archivedSignIn?.script ?? readFileSync(path.join(probesDir(dir), `${signIn}.mjs`), 'utf8');
    const leakedSignIn = credentialIn(signInScript, signInVariables);
    if (leakedSignIn) fail(`The sign-in probe "${signIn}" holds the value of ${leakedSignIn}. Kept tests never hold a credential; read it from process.env.${leakedSignIn} instead.`, root);
  }
  if (existsSync(signInDest)) {
    const existingSignIn = readFileSync(signInDest, 'utf8');
    if (archivedSignIn !== undefined && (archivedSignIn === null || existingSignIn !== archivedSignIn.script)) {
      fail(`${FOLDER}/tests/${SIGNIN}.mjs differs from the setup that proved ${probe} in generation ${String(generation)}. Refusing to pair the finding with different sign-in code.`, root);
    }
    const leakedSignIn = credentialIn(existingSignIn, signInVariables);
    if (leakedSignIn) fail(`The kept sign-in probe holds the value of ${leakedSignIn}. Kept tests never hold a credential; read it from process.env.${leakedSignIn} instead.`, root);
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'test.mjs'), script);
  const meta: KeptTest = { check, title: finding.title, severity: finding.severity, keptFrom: { run: ctx.runId, probe } };
  writeFileSync(path.join(dest, 'test.json'), JSON.stringify(meta, null, 2) + '\n');
  lines.push(`${FOLDER}/tests/${as}/test.mjs: "${finding.title}" (expectation "${check}")`);
  if (signInScript !== null) {
    writeFileSync(signInDest, signInScript);
    lines.push(`${FOLDER}/tests/${SIGNIN}.mjs: the sign-in probe "${signIn}", run before each replay`);
  } else if (existsSync(signInDest)) {
    lines.push(`${FOLDER}/tests/${SIGNIN}.mjs: kept already, left as it is`);
  }
  lines.push('While the bug is there the test fails; once it is fixed the test passes.', `Run it with: npx stillhunter replay ${as}   (or /stillhunter:replay ${as})`);
  process.stdout.write(block(redact(lines, secrets)));
}

function keptTests(root: string): { name: string; meta: KeptTest }[] {
  const dir = testsDir(root);
  if (!existsSync(dir)) return [];
  const out: { name: string; meta: KeptTest }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!PROBE_NAME.test(name) || !existsSync(path.join(dir, name, 'test.mjs'))) continue;
    try {
      out.push({ name, meta: JSON.parse(readFileSync(path.join(dir, name, 'test.json'), 'utf8')) as KeptTest });
    } catch {
      // A test without readable metadata cannot say which check it guards.
    }
  }
  return out;
}

export async function replay(args: string[]): Promise<void> {
  const root = repoRoot();
  const watch = args.includes('--watch');
  const names = args.filter((a) => a !== '--watch');
  const unknownFlag = names.find((n) => n.startsWith('-'));
  if (unknownFlag) fail(`Unknown replay option ${unknownFlag}. replay takes test names and --watch.`, root);
  const all = keptTests(root);
  if (all.length === 0) fail(`No kept tests in ${FOLDER}/tests/. Keep a confirmed finding with /stillhunter:keep.`, root);
  const missing = names.filter((n) => !all.some((t) => t.name === n));
  if (missing.length) fail(`No kept test named ${missing.join(', ')}. Kept tests: ${all.map((t) => t.name).join(', ')}.`, root);
  const selected = names.length ? all.filter((t) => names.includes(t.name)) : all;
  if (watch && selected.length !== 1) fail(`--watch shows one test in a visible browser. Name one: ${selected.map((t) => t.name).join(', ')}.`, root);

  const config = readConfig(root);
  const signInVariables = signInVariableNames(process.env, config.auth?.env);
  const secrets = credentialValues(signInVariables);
  const signInSource = path.join(testsDir(root), `${SIGNIN}.mjs`);
  if (existsSync(signInSource)) {
    const leaked = credentialIn(readFileSync(signInSource, 'utf8'), signInVariables);
    if (leaked) fail(`The kept sign-in probe holds the value of ${leaked}. Kept tests never hold a credential; read it from process.env.${leaked} instead.`, root);
  }
  for (const t of selected) {
    const leaked = credentialIn(readFileSync(path.join(testsDir(root), t.name, 'test.mjs'), 'utf8'), signInVariables);
    if (leaked) fail(`The kept test "${t.name}" holds the value of ${leaked}. Kept tests never hold a credential; read it from process.env.${leaked} instead.`, root);
  }
  const allowedHosts = Object.freeze([...(config.hosts?.allow ?? [])]);
  const target = await findTargetUrl(root, config);
  if (!target) fail(`No running app found. Start your dev server, or set "target": { "url": ... } in ${FOLDER}/config.json.`, root);
  if (!allowedUrl(target, target, allowedHosts)) fail('The target must be loopback or an exact hosts.allow entry; external targets must use HTTPS.', root);
  if ((await answers(target)) === null) fail(redact(`Nothing answers at ${target}. Start your dev server first.`, secrets), root);
  const choice = chooseBrowser(config.browser ?? null, installedOnThisMachine());
  if (!choice.ok) fail(choice.message, root);

  const runId = `${stamp()}-replay-${randomBytes(3).toString('hex').slice(0, 4)}`;
  const dir = path.join(runsDir(root), runId);
  // A replay run folder holds a signed-in session too, so keep it out of git
  // even when replay is the first command run in a fresh clone.
  ensureRunsIgnored(path.join(root, FOLDER, '.gitignore'));
  mkdirSync(probesDir(dir), { recursive: true });
  const now = Date.now();
  const ctx: Context = {
    runId, root, target, browser: choice.name, base: '', startedAt: now, deadline: now, depth: 'replay', budgetMinutes: 0,
    minSeverity: 'low', focus: null, mode: 'replay', allowedHosts, signInVariables,
  };
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n');

  // The child may read only the run folder, so each test is copied into it.
  const stage = (name: string, from: string) => {
    const file = path.join(probesDir(dir), `${name}.mjs`);
    copyFileSync(from, file);
    return file;
  };
  const host = (name: string, file: string, watching = false) => runProbe({
    runDir: dir, probe: name, probeFile: file, target, browser: choice.name, allowedHosts, signInVariables: ctx.signInVariables, shotsDir: path.join(dir, 'shots'),
    ...(watching ? { headed: true, slowMo: WATCH_SLOW_MO_MS, keepOpenMs: WATCH_KEEP_OPEN_MS } : {}),
  }).then((r) => { writeFileSync(path.join(probesDir(dir), `${name}.result.json`), JSON.stringify(r, null, 2) + '\n'); return r; });

  const signInFile = existsSync(signInSource) ? stage(SIGNIN, signInSource) : null;
  const signInLines: string[] = [];
  const signInProblem = (r: ProbeResult | null | undefined) => r ? r.error ?? (r.savedSession ? null : 'it saved no session') : null;
  const signIn = async (): Promise<ProbeResult | null> => {
    if (!signInFile) return null;
    const r = await host(SIGNIN, signInFile);
    const problem = signInProblem(r);
    if (problem) signInLines.push(`sign-in failed: ${problem}`);
    return r;
  };
  const notes: string[] = [];
  const initialSignIn = shouldReset(config, 'replay') ? null : await signIn();
  const initialProblem = signInProblem(initialSignIn);

  const lines: string[] = [];
  let failed = 0;
  let inconclusive = 0;
  for (const t of selected) {
    let before: Before | null = null;
    if (shouldReset(config, 'replay')) {
      before = await resetAndSignIn({
        root, config, probe: t.name, signIn: signInFile ? SIGNIN : null, sessionFile: sessionPath(dir), signInVariables: ctx.signInVariables,
        runSignIn: async () => (await signIn())!,
      });
      if (before?.resetError) notes.push(`before ${t.name}: ${before.resetError}`);
    }
    const result: ProbeResult = await host(t.name, stage(t.name, path.join(testsDir(root), t.name, 'test.mjs')), watch);
    const setupProblem = before?.resetError
      ?? (before?.signIn?.error ? `sign-in failed: ${before.signIn.error}` : null)
      ?? (initialProblem ? `sign-in failed: ${initialProblem}` : null);
    const o = outcome(result, t.meta.check);
    if (setupProblem) {
      inconclusive += 1;
      lines.push(`INCONCLUSIVE  ${t.name}: ${t.meta.title} (${setupProblem})`);
    } else if (o.state === 'held') {
      lines.push(`PASS  ${t.name}: ${t.meta.title} (expectation "${t.meta.check}" holds)`);
    } else {
      failed += 1;
      lines.push(o.state === 'failed'
        ? `FAIL  ${t.name}: ${t.meta.title} (expectation "${t.meta.check}" fails: ${o.detail})`
        : `FAIL  ${t.name}: ${t.meta.title} (expectation "${t.meta.check}" not reached${result.error ? `: ${result.error}` : ''})`);
    }
  }
  process.stdout.write(block(redact([
    `stillhunter | replay | ${selected.length} test${selected.length === 1 ? '' : 's'} | ${selected.length - failed - inconclusive} passed, ${failed} failed, ${inconclusive} inconclusive`,
    `target: ${target}${signInFile ? '' : ` | no ${SIGNIN}.mjs kept, so tests start signed out`}`,
    ...[...new Set(signInLines)],
    ...notes,
    ...lines,
    `results: ${FOLDER}/runs/${runId}/`,
  ], secrets)));
  if (failed + inconclusive > 0) process.exitCode = 1;
}
