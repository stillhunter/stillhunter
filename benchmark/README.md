# Benchmark

The planted-bug benchmark for Stillhunter. It is never published to npm.

## Commands

```sh
npm run bench -- materialize <app> <feature> [<bug>] [--work-dir <dir>] [--no-install] [--ports <web>,<api>]
npm run bench -- materialize-base <app> [--work-dir <dir>] [--no-install]
npm run bench -- lint [<app> ...]
```

`materialize` turns committed patches into a fresh repository: base as one "Initial commit" on `main`, the feature (and the bug, for a buggy variant) as uncommitted changes, and the feature's `request.md` as an untracked `.stillhunter/specs/request.txt`. `lint` runs the portability rules and the hint lint. `--ports` moves the app to other ports, rewriting the app's own web and API port numbers in the materialised copy (lockfiles are left alone), so several copies can run at once.

`comparison/` runs three arms on these apps, judges their findings blind and verifies non-planted issues independently:

- `playwright`: Claude Code with Playwright MCP.
- `adversarial`: the same tools, model, context and budget, plus instructions to falsify each candidate and reproduce it independently from the start in a fresh browser context. Findings without two completed observations remain `suspected`.
- `stillhunter`: the packed plugin, with its deterministic two-rerun proof.

The Stillhunter arm never runs from this checkout: each schedule packs the plugin with `npm pack`, unpacks it with its production dependencies into a folder outside the repository and points `--plugin-dir` there, and a trial refuses a plugin folder inside the repository or holding a `benchmark/` folder, so the plugin the hunter runs from holds no answer key. Its guard also refuses the hunter's Read, Grep and Glob in `benchmark/apps/`, `benchmark/comparison/` and Claude Code's session transcripts, and holds its Grep and Glob to the variant repository, so no search reaches the checkouts; a file elsewhere on the machine whose path the hunter guesses, such as a copy of a bug outside those folders, is not covered.

Set `BENCH_WORK` to a folder outside the repository; `BENCH_PLUGIN_DIR` reuses a copy already unpacked. Both Playwright arms and the verifier need `PW_MCP_DIR`: a folder with `@playwright/mcp` at the exact version `comparison/lib.mjs` pins (`PLAYWRIGHT_MCP`) installed in it, for example with `npm install @playwright/mcp@0.0.83` there. A schedule with either Playwright arm stops before the first trial when it is missing or has another version.

A run that leaves no `findings.json` is reported as failed and counted as not finding its bug; `finish`'s duration is kept in each trial's `meta.json`. Its first use, when the engine was rough-ride's `/rough-ride:hunt`, is reported in [rough-ride's REPORT-hunt.md](https://github.com/rough-ride/rough-ride/blob/main/benchmark/comparison/REPORT-hunt.md).

## Three-arm evaluation

Use a fresh results folder so resume, judging and verification artifacts cannot mix experiments. This is a paid model evaluation; set an explicit cost cap and choose the trial and lane counts deliberately.

```sh
export BENCH_WORK=/path/outside/this/checkout
export BENCH_RESULTS=/path/to/fresh/results
export PW_MCP_DIR=/path/with/pinned/playwright-mcp
export BENCH_SET=heldout
export BENCH_MAX_BUDGET_USD=5
node benchmark/comparison/schedule.mjs 3 3
node benchmark/comparison/judge.mjs 1
node benchmark/comparison/judge.mjs 2
node benchmark/comparison/verify.mjs 3
node benchmark/comparison/analyze.mjs
```

Every arm uses `claude-opus-5-5`, the same feature request and application context, clean and buggy variants, seeded sample data, the same optional dollar cap and a 45-minute hard limit. All three prompts state a 30-minute hunting budget. Stillhunter's deterministic proof runs after that hunting budget; adversarial validation is inside the other arms' 30 minutes, so total wall time is reported rather than claimed to be identical. `BENCH_ARMS` can select a subset for a focused run.

Analysis reports recall with Wilson 95% intervals, precision, false alarms overall and on clean runs, time, token use and estimated cost. Paired recall uses an exact McNemar test and false-alarm counts a seeded permutation test. Source-modifying and incomplete runs remain visible. Precision excludes unjudged and unverified findings; `byClass` retains those counts, so do not read conditional precision as complete evaluation. The current harness does not produce a numerical score for kept-test quality or independent verification of planted-match steps; those evaluations remain pending rather than implied by detection recall.

The existing held-out report is a two-arm historical measurement. The adversarial arm has harness-level deterministic tests but no measured model-evaluation results yet.

## Port registry

Web is `37NN` and API is `87NN`, where NN is the app number. These stay clear of 3000, 3731, 5173, 8000, 8080 and 8731.

| NN | App | Web | API |
|---|---|---|---|
| 00 | fixture (the bench script's own tests; never scored) | 3700 | 8700 |
| 01 | garden-log (dev split, Nuxt 4 + FastAPI; the three-OS CI app) | 3701 | 8701 |
| 02 | dev-split Next.js | 3702 | 8702 |
| 03 | dev-split Vite + React + Express | 3703 | 8703 |
| 04 to 19 | test-split apps, assigned when admitted | 37NN | 87NN |
| 90 to 99 | comparison lanes (`comparison/lib.mjs` `lanePorts`), copies of an app moved with `--ports` | 3790 to 3799 | 8790 to 8799 |
