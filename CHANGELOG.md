# Changelog

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
