# Changelog

## Unreleased

- The README's benchmark link points to the three-trial, three-arm evaluation instead of the earlier two-arm report, and summarizes its confirmed findings, kept-test validity, time and price. The guide's "Where it stands" adds the evaluation's full results table.

- A claim with one failed proof re-run and another that never reached its check, or started after a failed reset or sign-in, is now could not re-run rather than intermittent.
- Replay drops stale sessions with each reset and reports reset or sign-in failures as inconclusive, with a nonzero exit, instead of passing the test.
- Probe output and result files mask raw sign-in values as well as saved-session values; encoded values and reset-command output remain outside that protection.
- The comparison benchmark adds an explicit adversarial-verification Playwright arm, gives every arm the same stated 30-minute hunting budget, enforces the pinned MCP version and analyzes all three pairwise comparisons. A [three-trial held-out evaluation](benchmark/comparison/REPORT-three-arm-0.2.md) reports measured detection, independent verification, retained-test validity, time and cost; the [one-trial pilot](benchmark/comparison/REPORT-three-arm-pilot.md) remains separate and exploratory.
- Blind judging validates report coverage and retries an incomplete answer once. Verification now covers each planted report as well as non-planted issues, with inconclusive attempts kept separate. Retained tests for planted findings are replayed twice on the bug and once on clean code to measure validity and stability.

## 0.2.5 (2026-11-15)

- The README is short: what Stillhunter does, how to install it and four steps to a first hunt. The details it held (commands and flags, configuration, how a hunt works, kept tests, how probes are contained, an example report and the benchmark history) moved unchanged to `docs/guide.md`, and `SECURITY.md` links there.

## 0.2.4 (2026-11-15)

- The README hero is sharper: it renders at 1664x832, which matches its 830 px width on a 2x screen, with twice the texture detail in the app's panes and a sharper WebP encoding. The design is unchanged.
- Fixed a frame in the dark hero, about 1 s in, that flashed almost entirely black. A glass pane seen edge-on produced an infinite value in its shader.

## 0.2.3 (2026-11-15)

- The README opens with an animated hero, in light and dark versions, that shows a hunt from the change to the kept test. Its three.js source and the script that renders it are in `docs/media/hero/`. The images are not in the npm package.
- `package.json` names the homepage and the issue tracker.

## 0.2.2 (2026-11-14)

- A marketplace install now installs only `playwright-core`, about 13 MB, instead of 46 MB with the build tools. The published `package.json` and `npm-shrinkwrap.json` leave out the devDependencies; `scripts/pack.mjs` builds that package, and the release and the benchmark use it.
- Hunted for real outside Nuxt and macOS: a Vite app with an API, configured with `target.url`, found its planted bug and confirmed it on macOS and on Linux (arm64, Playwright Chromium).
- The README says that in a container the hunt must run as a user listed in `/etc/passwd`.

## 0.2.1 (2026-11-14)

- The package now ships `npm-shrinkwrap.json`, so Claude Code installs `playwright-core` when it installs the plugin from the marketplace. 0.2.0 shipped without a lockfile, and an install from the marketplace failed at its first command with `Cannot find module 'playwright-core/lib/utilsBundle'`.
- The release workflow installs the tarball through Claude Code on Linux, macOS and Windows and runs it before staging it.

## 0.2.0 (2026-11-14)

The first release of Stillhunter as a Claude Code plugin. The engine grew out of [rough-ride](https://github.com/rough-ride/rough-ride)'s hunt engine; [docs/design-0.2.md](docs/design-0.2.md) lists what its first test found and how this release answers each point.

- `/stillhunter:hunt`, `/stillhunter:keep` and `/stillhunter:replay`, with free-text requests turned into `--depth`, `--min-severity` and `--focus`. With no change against the base branch, a named feature is hunted as it stands.
- `start` prints the whole change, the spec files and the budget, and leaves out the bodies of secret files. `diff` prints whatever the 60 KB cap cut.
- Probes run in a child Node process under Node's permission model and reach the browser only through a relay with an allow-list. Pages are held to loopback hosts.
- With `reset` configured, app data is reset before every probe and every re-run, the run's saved session is dropped, and the sign-in probe signs in again. The hunt and the proof then start from the same state.
- `finish` checks each claim against the probe's latest result and makes the hunter account for every failed expectation. It also points out endpoints never faulted and pages never seen at 375 px. It then re-runs each claimed probe twice from scratch, with its own time limits.
- Screenshots, layout checks for clipped values and content past the screen edge, and raw requests in the probe API.
- Kept tests replay with no model, signing in first and resetting app data when configured.
- Tested on Linux, macOS and Windows in CI.

Held-out result: the planted bug in 17 of 18 runs with 0.41 false alarms per run, against 15 of 18 with 3.15 for Claude Code with Playwright ([report](benchmark/comparison/REPORT-heldout-0.2.md)).
