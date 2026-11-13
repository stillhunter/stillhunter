#!/usr/bin/env node
// Stillhunter's runner: the model reads the change, forms hypotheses and tests
// them with probe scripts; the runner keeps the scripts, runs them in a
// contained child process against a loopback-only browser and, at the end,
// re-runs every claimed finding from scratch so only reproducible ones are
// reported. Findings worth keeping become tests that replay with no model.
//   stillhunter start [--depth quick|default|deep] [--minutes N] [--min-severity high|medium|low] [--focus "<text>"]
//   stillhunter probe --run <id> --name <name>     (script on stdin)
//   stillhunter finish --run <id> [--proof-seconds N]  (findings JSON on stdin)
//   stillhunter diff [--file <path>]               (the change, or one file's whole diff)
//   stillhunter keep --run <id> --probe <name> --check <check> [--as <name>]
//   stillhunter replay [names] [--watch]
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chooseBrowser, installedOnThisMachine } from './browser.mjs';
import { baseRef, changeList, changeText, collectChange, ensureRunsIgnored, fileDiff, readSpecs } from './change.mjs';
import { block, type Context, fail, FOLDER, flag, loadRun, PROBE_NAME, readConfig, readStdin, remaining, repoRoot, runsDir, signInVariableNames, stamp, findTargetUrl } from './common.mjs';
import { finish } from './finish.mjs';
import { parseStartFlags } from './flags.mjs';
import { keep, replay } from './keep.mjs';
import { runProbe } from './probe-host.mjs';
import { latestFile, nextRunNumber, numberedFile, probesDir } from './results.mjs';
import { answers } from './target.mjs';

const NO_CHANGE = 'No change found. Name a feature to hunt, for example: /stillhunter:hunt the checkout flow';

async function start(args: string[]): Promise<void> {
  const root = repoRoot();
  const parsed = parseStartFlags(args);
  if (!parsed.ok) fail(parsed.message);
  const { depth, minutes, minSeverity, focus } = parsed.flags;
  const base = baseRef(root);
  const change = collectChange(root, base);
  if (change.empty && !focus) fail(NO_CHANGE);
  const config = readConfig(root);
  const target = await findTargetUrl(root, config);
  if (!target) fail(`No running app found. Start your dev server, or set "target": { "url": ... } in ${FOLDER}/config.json.`);
  if ((await answers(target)) === null) fail(`Nothing answers at ${target}. Start your dev server first.`);
  const choice = chooseBrowser(config.browser ?? null, installedOnThisMachine());
  if (!choice.ok) fail(choice.message);

  const runId = `${stamp()}-hunt-${randomBytes(3).toString('hex').slice(0, 4)}`;
  const dir = path.join(runsDir(root), runId);
  mkdirSync(probesDir(dir), { recursive: true });
  ensureRunsIgnored(path.join(root, FOLDER, '.gitignore'));

  const mode = change.empty ? 'feature' : 'change';
  const signInVariables = signInVariableNames();
  const now = Date.now();
  const ctx: Context = {
    runId, root, target, browser: choice.name, base, startedAt: now, deadline: now + minutes * 60_000,
    depth, budgetMinutes: minutes, minSeverity, focus, mode, signInVariables,
  };
  writeFileSync(path.join(dir, 'context.json'), JSON.stringify(ctx, null, 2) + '\n');

  const specs = readSpecs(root);
  const lines = [
    `stillhunter | run ${runId}`,
    `target: ${target} | browser: ${choice.name} | budget: ${minutes} min (depth ${depth}) | report: ${minSeverity === 'low' ? 'every severity' : `${minSeverity} severity and above`}`,
    `focus: ${focus ?? 'none (the whole change)'}`,
    mode === 'feature'
      ? `mode: feature. There is no change against the base, so this hunt tests "${focus}" as it stands.`
      : `mode: change. diff base: ${base.slice(0, 12)} (one file's whole diff: diff --file <file>)`,
    `sign-in variables set in the environment (names only): ${signInVariables.length ? signInVariables.join(', ') : 'none'}`,
    'changed files:',
    ...(change.files.length ? change.files.map((l) => `  ${l}`) : ['  none']),
    `specs: ${specs.length ? specs.map((s) => s.file).join(', ') : 'none'}`,
    ...specs.flatMap((s) => ['', `=== spec: ${s.file} ===`, s.text.replace(/\n$/, '')]),
    '',
    `=== the change: git diff ${base.slice(0, 12)} of tracked files, then every untracked file ===`,
    ...changeText(change),
  ];
  process.stdout.write(block(lines));
}

async function probe(args: string[]): Promise<void> {
  const { ctx, dir } = loadRun(args);
  const name = flag(args, '--name');
  if (!name || !PROBE_NAME.test(name)) fail('Give the probe a --name of lowercase letters, digits and dashes.');
  if (remaining(ctx) === 0) {
    process.stdout.write(block([`stillhunter | probe refused | run ${ctx.runId}`, 'The budget is spent. Call finish now, accounting for every failed check.']));
    process.exit(2);
  }
  const script = readStdin();
  if (!/export\s+default/.test(script)) fail('The probe script on stdin needs `export default async function (rr) { ... }`.');
  const probeFile = path.join(probesDir(dir), `${name}.mjs`);
  writeFileSync(probeFile, script);
  const n = nextRunNumber(dir, name);
  const result = await runProbe({ runDir: dir, probe: name, probeFile, target: ctx.target, browser: ctx.browser, signInVariables: ctx.signInVariables, shotsDir: path.join(dir, 'shots') });
  result.run = n;
  const json = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(numberedFile(dir, name, n), json);
  writeFileSync(latestFile(dir, name), json);
  const shown = {
    probe: name,
    run: n,
    remainingSeconds: remaining(ctx),
    resultFile: numberedFile(dir, name, n),
    checks: result.checks,
    notes: result.notes,
    error: result.error,
    shots: result.shots,
    blocked: result.blocked,
    refused: result.refused ?? [],
    requests: { total: result.requests.length, last: result.requests.slice(-30).map(({ method, url, status, fault, via }) => ({ method, url, status, fault, via })) },
    pages: result.pages,
    final: result.final,
  };
  process.stdout.write(`${JSON.stringify(shown, null, 1)}\n`);
}

// The change, read without a shell: the list of changed files, or one file's
// whole diff against the base. The hunter's only Bash is this runner, so this
// is how it reads what start had to leave out.
function diff(args: string[]): void {
  const root = repoRoot();
  const file = flag(args, '--file');
  if (args.length !== 0 && !(args.length === 2 && file)) fail('Usage: diff [--file <path>]');
  const base = baseRef(root);
  if (file === null) {
    const change = collectChange(root, base);
    process.stdout.write(block([`stillhunter | diff | base ${base.slice(0, 12)} | changed and untracked files, with the size of each file's diff`, ...changeList(change)]));
    return;
  }
  const r = fileDiff(root, base, file);
  if (!r.ok) fail(r.message);
  process.stdout.write(block([`stillhunter | diff | base ${base.slice(0, 12)} | ${file}`, r.text.replace(/\n$/, '') || '(no difference)']));
}

const USAGE = 'Usage: stillhunter start [--depth quick|default|deep] [--minutes N] [--min-severity high|medium|low] [--focus "<text>"] | probe --run <id> --name <name> | finish --run <id> [--proof-seconds N] | diff [--file <path>] | keep --run <id> --probe <name> --check <check> [--as <name>] | replay [names] [--watch]';

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'start') await start(rest);
else if (sub === 'probe') await probe(rest);
else if (sub === 'finish') await finish(rest);
else if (sub === 'diff') diff(rest);
else if (sub === 'keep') keep(rest);
else if (sub === 'replay') await replay(rest);
else fail(USAGE);
