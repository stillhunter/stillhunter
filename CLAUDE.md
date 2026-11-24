# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Stillhunter is a Claude Code plugin (published to npm, installed through `.claude-plugin/marketplace.json`) that hunts bugs in a web app change in a real browser and reports only bugs it reproduced twice. The model (the `hunter` agent) writes probe scripts; a deterministic Node runner executes them contained, then re-runs every claimed finding from scratch. User docs: `README.md` (short) and `docs/guide.md` (commands, config, how a hunt works, containment). Design rationale: `docs/design-0.2.md`.

## Commands

Node 22.22+ is required. Tests import the compiled runner from `dist/`, so build before testing.

```sh
npm ci
npm run build                      # tsc: src/*.mts -> dist/*.mjs (dist/ is gitignored)
npm test                           # node --test "test/*.test.mjs"
node --test test/guard.test.mjs    # one test file
node --test --test-name-pattern="<regex>" test/integration.test.mjs   # one test by name
npm run bench:check                # typecheck benchmark/bench
npm run bench:test                 # benchmark harness tests (offline)
npm run bench -- lint              # benchmark portability and hint lint
node scripts/pack.mjs <dir>        # build the publishable tarball (after build)
```

CI (`.github/workflows/ci.yml`) runs exactly: build, test, bench:check, bench:test, `bench -- lint`, on Linux, macOS and Windows. Browser-driven suites (integration, containment, proof, reset) skip with `noBrowser` when no Chrome, Edge or Chromium is installed; a skip is not a pass. There is no linter or formatter; the compiler is strict (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`).

## Architecture

Three layers, each holding the next to its contract:

1. **Plugin surface** (Markdown + hooks, shipped as-is):
   - `skills/hunt|keep|replay/SKILL.md`: slash commands. `hunt` forks into the `stillhunter:hunter` agent (`agents/hunter.md`, `omitClaudeMd: true`), which turns the request into `start` flags and drives the runner. Each skill's `allowed-tools` pins the exact runner command lines.
   - `hooks/guard.mjs` (PreToolUse, wired in `hooks/hooks.json`): no agent writes in `.stillhunter/`; the hunter's Bash may only be `node "<plugin root>/dist/hunt.mjs" start|probe|finish|diff` with at most one quoted heredoc; the hunter may not read secrets, saved sessions, `benchmark/apps/`, `benchmark/comparison/` or session transcripts, and Grep/Glob stay inside the repo under test. Changing a command shape in a skill or `agents/hunter.md` usually requires a matching change here and in `test/guard.test.mjs`.

2. **Runner** (`src/hunt.mts` is the CLI entry and `bin`): `start` (collect change via `change.mts`, find target via `target.mts`, choose browser, run reset, create `.stillhunter/runs/<id>/`), `probe` (script on stdin), `finish` (`finish.mts`: claim checks against latest results, accounting for failed expectations via `accounting.mts`, coverage gaps via `coverage.mts`, then two from-scratch proof re-runs per claim under a 7/9 minute budget), `diff`, `keep` and `replay` (`keep.mts`). `reset.mts` implements the reset-then-sign-in-again sequence: the `always` strategy uses it at start and before every hunt probe, proof re-run and replayed test, while `proof` uses it only for proof re-runs and replayed tests. `results.mts` owns per-run result files and which probe counts as the sign-in probe.

3. **Containment** (the security boundary; treat changes here as security-sensitive):
   - `probe-host.mts` launches the browser and spawns `probe-child.mts` under Node's permission model (read: run folder, `dist/`, `playwright-core` only; write: scratch and shots; no child processes, workers, addons, signals; env limited to `PATH` plus sign-in variables).
   - `relay.mts` sits between the probe and the browser and forwards only allow-listed Playwright protocol calls (no CDP sessions, no unauthorized navigation, no host file uploads, etc.).
   - `probe-child.mts` exposes the `rr` probe API and wraps page creation with the authorized-hosts-only route, request watchers and saved session. Output is masked for session and sign-in values.
   - `docs/guide.md` "What a probe can and cannot do" documents exactly what is enforced; keep it accurate when behavior changes. `SECURITY.md` points there.

Run outcomes are deliberately distinct: confirmed (failed both re-runs), intermittent (failed one, held in the other), could not re-run (re-run never reached its expectation, or its reset/sign-in failed when the hunt run's had not), not re-run in time. Replay has PASS / FAIL / INCONCLUSIVE (reset or sign-in failure, nonzero exit). Do not collapse these categories.

## Tests

`test/helpers.mjs` drives the built runner (`dist/hunt.mjs`) as a subprocess against `test/fixtures/app/server.mjs`, a local app with known defects, inside temp git repos (`makeRepo`). Tests set fixture sign-in variables (`SHFIX_EMAIL`, `SHFIX_PASSWORD`) and a decoy secret that must never reach a probe. Tests compare bytes, so text files are LF everywhere (`.gitattributes`).

## Benchmark

`benchmark/` is never published. `benchmark/bench/*.mts` runs directly under Node (type stripping) and never imports the runner. `benchmark/apps/<app>/` holds a base app plus feature and planted-bug patches; `npm run bench -- materialize <app> <feature> [<bug>]` builds a variant repo. Bug patches, manifests and `comparison/` results are the answer key: the guard hides them from the hunter, so never leak them into skills, `agents/hunter.md` wording or examples. `benchmark/comparison/*.mjs` runs real paid Claude trials (see `benchmark/README.md`); run those only locally and only when asked. Port scheme: web `37NN`, API `87NN` (registry in `benchmark/README.md`).

## Packaging and releases

- The package ships `skills/`, `agents/`, `hooks/`, `dist/`, `.claude-plugin/plugin.json`, `README.md` and `npm-shrinkwrap.json`. `scripts/pack.mjs` strips devDependencies and scripts from the published `package.json` and shrinkwrap, because Claude Code installs a plugin's packages from that lockfile. The only runtime dependency is `playwright-core`; keep it that way unless asked.
- Dependencies are pinned exactly (`.npmrc`: `save-exact=true`, `min-release-age=7`).
- A version bump touches `package.json`, `npm-shrinkwrap.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and the tagged hero image URLs in `README.md`; the release workflow fails if the tag, `package.json` and `plugin.json` disagree. Add entries under `## Unreleased` in `CHANGELOG.md`.

## Writing style

Docs, skills and the agent prompt use plain, short, literal sentences and no em dashes. Skills and `agents/hunter.md` are prompts to a model whose Bash is held to exact command shapes by the guard: keep commands in them typed exactly.
