# Stillhunter Production Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Stillhunter safer and easier to run across common development stacks while preserving independent reproduction, adding explainable verification and human review, and making benchmark costs and validity measurable.

**Architecture:** Extend the existing typed runner and containment seams rather than adding a parallel framework. Keep deterministic reproduction evidence separate from human review, retain legacy configuration and findings compatibility, and generalize the current benchmark drivers without mixing case answers into shipped code.

**Tech Stack:** Node 22.22+, strict TypeScript, Node test runner, Playwright Core 1.64.1, existing Claude Code benchmark drivers, React/Vite benchmark fixture, YAML case manifests.

---

### Task 1: Validate additive project configuration

**Files:**
- Modify: `src/common.mts`
- Create: `test/config.test.mjs`
- Modify: `test/helpers.mjs`
- Modify: `docs/guide.md`

**Steps:**
1. Write failing tests for valid legacy config, all new sections, malformed known fields, unknown keys, and actionable error paths.
2. Build and run `node --test test/config.test.mjs`; confirm the new assertions fail.
3. Add runtime parsing that returns a typed config with `hosts.allow`, `auth.env`, `reset.command`, `reset.strategy`, and `verification` settings. Accept the legacy reset string as `{ command, strategy: "always" }`; preserve defaults when sections are absent.
4. Rebuild and rerun the config and existing change tests; confirm valid legacy fixtures still pass.
5. Document defaults and validation errors without adding environment-variable values to examples.

### Task 2: Enforce explicit non-loopback host allowlisting

**Files:**
- Modify: `src/common.mts`
- Modify: `src/relay.mts`
- Modify: `src/probe-host.mts`
- Modify: `src/probe-child.mts`
- Modify: `src/target.mts`
- Modify: `src/hunt.mts`
- Test: `test/relay.test.mjs`, `test/containment.test.mjs`, `test/integration.test.mjs`

**Steps:**
1. Add failing unit and real-browser cases for an exact allowed HTTPS host, wrong host, wrong port, redirect to an unlisted host, non-HTTPS external target, and a non-loopback target omitted from the allowlist.
2. Run the focused tests and confirm they fail on current loopback-only behavior.
3. Centralize URL authorization as loopback OR exact configured `host[:port]`, requiring HTTP(S), loopback semantics for local URLs, and HTTPS for external URLs. Pass the frozen allowlist through run context, relay, browser route, storage-state checks, and host-side requests.
4. Extend the closed browser proxy so only loopback and exact allowlisted authorities can connect; retain fail-closed behavior for bypass attempts and redirects.
5. Align startup reachability with URL policy and support HTTPS rather than probing every target with `node:http`.
6. Rebuild and run relay, containment, and integration tests. Document that direct Node networking and DNS answers from explicitly trusted hosts remain outside a stronger network sandbox.

### Task 3: Configure credential names and close redaction gaps

**Files:**
- Modify: `src/common.mts`
- Modify: `src/hunt.mts`
- Modify: `src/probe-host.mts`
- Modify: `src/reset.mts`
- Modify: `src/keep.mts`
- Test: `test/host.test.mjs`, `test/reset.test.mjs`, `test/containment.test.mjs`, `test/integration.test.mjs`

**Steps:**
1. Write failing tests proving explicit `auth.env` replaces convention discovery, omitted config preserves discovery, short configured values are masked, and reset stdout/stderr cannot leak selected values.
2. Thread selected names through start context and replay without storing values in config or context.
3. Use one redaction helper for probe results, reset output, reports, and literal credential checks. Ignore empty values, mask every nonempty configured value, and apply longest-first replacement recursively.
4. Rebuild and run credential, reset, containment, and keep/replay tests. Verify fixtures contain no raw credential after every command.

### Task 4: Add reset strategies and independent proof scratch

**Files:**
- Modify: `src/reset.mts`
- Modify: `src/hunt.mts`
- Modify: `src/finish.mts`
- Modify: `src/keep.mts`
- Modify: `src/probe-host.mts`
- Test: `test/reset.test.mjs`, `test/proof.test.mjs`, `test/integration.test.mjs`

**Steps:**
1. Add failing tests for `always` versus `proof`: proof mode skips start/hunt resets and resets before every proof and replay; always mode retains current call order.
2. Add failing tests showing scratch counters and screenshots cannot leak between proof attempts while the exact sign-in flow is rerun when required.
3. Centralize strategy decisions in the shared reset pipeline. Give each proof attempt a unique scratch directory and pass its location through the existing host options; do not change hunt scratch semantics.
4. Preserve setup-equivalence evidence and classify failed/invalid setup as inconclusive rather than proof of either outcome.
5. Rebuild and run reset, proof, and integration tests. Add PostgreSQL template-database and dump/restore recipes with isolated database names, credential-safe commands, and warnings against shared production databases.

### Task 5: Discover Vite and Next.js targets with a safe fallback

**Files:**
- Modify: `src/target.mts`
- Modify: `src/common.mts`
- Modify: `src/hunt.mts`
- Test: `test/target.test.mjs`, `test/integration.test.mjs`
- Modify: `docs/guide.md`, `README.md`, `agents/hunter.md`

**Steps:**
1. Add failing fixtures for Vite and Next.js discovery, ambiguous candidates, stale process metadata, non-interactive fallback, and TTY-selected URL persistence.
2. Extend candidate enumeration using tracked/non-ignored framework config and package dependencies. Prove candidate servers with framework-specific evidence and loopback URLs; do not generic-port-scan.
3. Add a TTY-only URL prompt when discovery is absent or ambiguous. Validate and persist only the explicitly selected URL. In non-interactive runs, fail with the exact config example instead.
4. Update agent guidance without adding a new hunter command shape. Rebuild and run target, guard, and integration tests.

### Task 6: Implement configurable evidence-backed verification

**Files:**
- Modify: `src/finish.mts`
- Modify: `src/results.mts`
- Modify: `src/probe-host.mts`
- Modify: `src/probe-child.mts`
- Test: `test/finish.test.mjs`, `test/proof.test.mjs`, `test/integration.test.mjs`

**Steps:**
1. Extend the classifier truth table with deterministic failure, deterministic pass, mixed evidence, missing checks, setup failures, retries, timing-dependent mixed sequences, and false-negative regressions.
2. Implement the approved policy: at most three valid attempts by default; two valid failures confirm, two valid passes do not reproduce, mixed valid outcomes are intermittent, and insufficient/invalid evidence is inconclusive. Retry only host/infrastructure or incomplete attempts within configured caps and wall budgets.
3. Retain per-attempt scripts, results, setup metadata, error/failure patterns, and unique screenshot paths. Point report reproduction paths to exact proof snapshots and preserve prior finish generations.
4. Emit versioned findings with the four classifications and consistent legacy aliases. Keep original evidence intact across reruns.
5. Rebuild and run the full unit/browser suites; do not count skipped browser tests as passes.

### Task 7: Add append-only human review

**Files:**
- Modify: `src/hunt.mts`
- Create: `src/review.mts`
- Modify: `src/finish.mts`
- Modify: `src/keep.mts`
- Create: `test/review.test.mjs`
- Modify: `test/guard.test.mjs`, `docs/guide.md`, `README.md`

**Steps:**
1. Write failing tests for stable finding IDs, required rationale, append-only reviewer/timestamp records, invalid IDs, effective report labels, and preservation of original classifications.
2. Implement a main-user `review` command that records effective classification separately. Never expose it to the hunter hook or skill and never rewrite attempt evidence.
3. Automatically flag intermittent, inconclusive, and borderline evidence for optional review. Keep `keep` restricted to deterministic Confirmed findings.
4. Rebuild and run review, finish, keep, guard, and packaging tests; update CLI help and docs.

### Task 8: Add verifiable local installation and artifact comparison

**Files:**
- Create: `scripts/verify-pack.mjs`
- Modify: `package.json`
- Modify: `test/harness.test.mjs`
- Modify: `README.md`, `docs/guide.md`, `SECURITY.md`
- Modify: `.github/workflows/release.yml`

**Steps:**
1. Add a failing packaging test for comparing repository-built and published tarballs by normalized file bytes and expected metadata differences.
2. Implement a local verification command that accepts a published tarball or package spec, builds/packs source, compares SHA-512 and per-file hashes, and reports differences without hiding legitimate package-metadata normalization.
3. Document project-local `npm install --save-exact stillhunter` and plugin installation, trusted release provenance, and reproducible comparison commands.
4. Add release validation for marketplace version agreement and the artifact comparison where registry availability permits. Run packaging tests and inspect the actual tarball.

### Task 9: Add a controlled React/Vite benchmark application

**Files:**
- Create: `benchmark/apps/react-log/**`
- Modify: `benchmark/README.md`
- Modify: `benchmark/comparison/lib.mjs`
- Modify: `benchmark/comparison/trial.mjs`
- Modify: `benchmark/comparison/reference.mjs`
- Test: `benchmark/bench/test/bench.test.mts`, `test/harness.test.mjs`

**Steps:**
1. Define a small React/Vite frontend and local API with deterministic seeded data, independent feature requests, clean variants, tuning bugs, and held-out bugs. Do not derive cases from Stillhunter implementation details.
2. Add materialization, byte-equivalence, hint-lint, reference-check, and port-isolation tests before integrating paid drivers.
3. Generalize hardcoded Garden Log app names, readiness paths, credentials, seeding, and verification paths into per-app benchmark configuration.
4. Run offline materialization/reference checks and browser smoke tests. Do not report detection, false-positive, runtime, token, or cost values unless real trials complete.

### Task 10: Improve benchmark fairness, metrics, and environment capture

**Files:**
- Modify: `benchmark/comparison/trial.mjs`
- Modify: `benchmark/comparison/lib.mjs`
- Modify: `benchmark/comparison/schedule.mjs`
- Modify: `benchmark/comparison/analyze.mjs`
- Create: `benchmark/comparison/metrics.mjs`
- Test: `test/benchmark-analysis.test.mjs`, `test/harness.test.mjs`

**Steps:**
1. Write failing tests for missing metrics, measured versus estimated costs, token deduplication, total-budget enforcement, environment schema, and incomplete trials.
2. Record wall time for model session, proof/retention, setup, judging, verification, and regression separately; include all arms under equivalent total model/run budgets.
3. Capture OS/architecture, CPU/memory, Node/npm/Python/uv, Claude Code, browser, MCP, repository commit, plugin hash, requested/reported model, config, and execution parameters. Use null plus an unavailable reason rather than invented values.
4. Report detection, confirmed/intermittent/inconclusive/missed findings, false alarms, runtime, tokens, and cost side by side with per-run observations, medians/ranges, paired comparisons where valid, and explicit small-sample limitations.
5. Preserve existing reports and make schedules resumable without treating inconclusive artifacts as successful completed measurements.

### Task 11: Add an independently pinned historical OSS corpus

**Files:**
- Create: `benchmark/historical/selection.md`
- Create: `benchmark/historical/cases/**`
- Create: `benchmark/comparison/historical.mjs`
- Create: `test/benchmark-historical.test.mjs`
- Modify: `benchmark/README.md`

**Steps:**
1. Freeze selection query, cutoff, eligibility, exclusion, and deterministic ordering rules before inspecting trial outcomes. Select six previously fixed bugs across at least three unfamiliar repositories, or document an incomplete corpus honestly.
2. For each case record repository, immutable parent/fix commits, expected behavior, issue/PR evidence, setup, clean control, lockfile/archive hash, and license attribution. Vendor only Stillhunter-authored harness patches.
3. Add integrity tests that reject mutable refs, missing expected behavior, hash mismatch, answer-key leakage, and cases coupled to runner source.
4. Automate materialization, equivalent three-arm execution, classification scoring, metric collection, and reporting. Keep this corpus separate from the synthetic React/Vite results.

### Task 12: Final documentation, paid execution, and verification

**Files:**
- Modify: `README.md`, `docs/guide.md`, `docs/design-0.2.md`, `SECURITY.md`, `CHANGELOG.md`, `benchmark/README.md`, `CLAUDE.md`
- Create only when actual results exist: `benchmark/comparison/REPORT-production-ready.md`

**Steps:**
1. Update all configuration examples, reset recipes, verification explanations, review workflow, security limitations, benchmark commands, and supply-chain steps. Remove statements describing superseded two-run-only behavior.
2. Run `npm run build`, `npm test`, `npm run bench:check`, `npm run bench:test`, `npm run bench -- lint`, packaging verification, and real end-to-end hunts against local and explicitly allowed external fixtures.
3. Check browser tests actually executed rather than skipped. Run paid benchmarks only with available credentials and within the approved $150 total cap, starting with a pilot and stopping rather than exceeding it.
4. Commit sanitized aggregate metrics and environment records; publish raw artifacts separately if possible. Do not create a results report for unexecuted benchmarks.
5. Review `git status` and the complete diff for secret leakage, answer-key leakage, overwritten evidence, backward compatibility, and generated files that should not remain.

**Final report:** Include only implemented improvements, actual checks/benchmark results and explicit non-executions, and remaining limitations or risks. Do not claim statistical significance or verification unsupported by executed evidence.
