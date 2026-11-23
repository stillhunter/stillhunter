# Stillhunter guide

The [README](../README.md) covers installing and a first hunt. This guide has the details.

## Requirements

Claude Code (tested with 2.1.311 and 2.1.325), Node.js 22.22 or later, and Chrome, Edge or Chromium installed. In a container, run as a user listed in `/etc/passwd`: a probe gets no `HOME`, so Node looks up the home folder there, and a user ID with no entry makes every probe fail with `uv_os_homedir returned ENOENT`.

## A report

After about 10 minutes a hunt ends with a report like this one, from a hunt on a benchmark app:

```
stillhunter | 6m21s | run 20261114-100317-hunt-ea44 | 4 confirmed, 0 intermittent, 0 did not reproduce
target: http://localhost:3793 | asked: the change

Findings (each reproduced twice from scratch)
1. MEDIUM Record past watering accepts a negative amount and counts it in the totals
   where: /beds, Record past watering form; POST /api/waterings
   expected: A negative number of litres is refused with a visible reason (the form only rejects 0)
   saw: {"stored":[{"id":3,"bed_id":1,"bed_name":"North bed","watered_on":"2026-11-14","watered_at":null,"litres":-5}],"text":["Recorded -5 L on 14 Nov 2026."]}
   repro: .stillhunter/runs/20261114-100317-hunt-ea44/proof/generations/1/beds-water.mjs (expectation "negative-litres-refused")
```

If your app keeps data, add a `reset` command to the config. Choose the `always` strategy to give every hunt probe the same starting data, or `proof` to reset only proof re-runs and replayed tests; see [Configuration](#configuration). Probes run model-written code under the limits in [What a probe can and cannot do](#what-a-probe-can-and-cannot-do); read that section before you point a hunt at anything but a local dev server with test data.

## Commands

| In Claude Code | Runner | What it does |
|---|---|---|
| `/stillhunter:hunt [what you want]` | `start`, `probe`, `finish`, `diff` | Hunt for bugs |
| `/stillhunter:keep <finding>` | `keep` | Save a confirmed finding as a test under `.stillhunter/tests/` |
| `/stillhunter:replay [names] [--watch]` | `replay` (also `npx stillhunter replay`) | Run kept tests with no model; `--watch` shows one in a visible browser |

`hunt` takes free text, for example `/stillhunter:hunt quick look at the invite dialog, only serious problems`. The hunter turns it into runner flags, and the runner holds the hunt to them:

- `--depth quick|default|deep`: a budget of 4, 10 or 25 minutes. `--minutes N` sets it directly.
- `--min-severity high|medium|low`: the report shows findings at or above it and says how many it hid. Everything is in `report.txt` in the run folder.
- `--focus "<text>"`: what you asked to look at. With no change against the base branch, a focus makes the hunt test that feature as it stands.

## How a hunt works

1. `start` prints the whole change (the diff of tracked files and every untracked file, cut at 60 KB with the largest files left out first), the spec files under `.stillhunter/specs/`, and the budget. `diff` lists the changed files and prints one file's whole diff (up to 1 MB) for what the cap left out. Neither prints the body of a secret file such as `.env`, `.npmrc` or a key. With the `always` reset strategy, `start` runs the reset once and says how long it took; if it fails, `start` stops and shows the command and the end of its output, so a broken reset shows up before the hunt, not at `finish`. The `proof` strategy does not reset at start.
2. The hunter writes probes: small scripts that drive the app in a browser through `rr`, a probe API with request faults, an observation of what the page shows (including layout problems such as clipped values and content past the screen edge), screenshots and named expectations. Every run of a probe keeps its own result. With the `always` reset strategy, every probe starts the way `finish` will re-run it: the runner resets app data and drops the run's saved session, so nothing carries over from before the reset even when the app's sessions outlive it, then runs the hunt's sign-in probe again (the latest probe that saved a session and ended without an error, or, failing that, the latest that saved a session before it failed), unless the probe is the sign-in probe itself. The result says how long the reset and the sign-in took, and starts with a warning if either failed; the probe runs anyway. A sign-in probe that saves its session and then fails leaves that session in place, and the warning says so. This time counts against the budget. With `proof` or without `reset`, app data carries over from one hunt probe to the next. Ordinary hunt scratch also keeps its existing per-run persistence in both modes.
3. `finish` checks each claim against the probe's latest result, makes the hunter account for every failed expectation, and points out API endpoints it never faulted and pages it never saw at 375 px wide. Requests to the dev server's own paths (such as `/_nuxt/`, `/__nuxt_dev__/`, `/@vite/`, `/_next/static/` and `/favicon.ico`) are left out of that list, and so is what a probe saw while it signed in: the sign-in page and the requests made before the page it landed on, unless another probe saw them too. It then re-runs each claimed probe twice from scratch, most severe claims first. Every attempt has a fresh browser, scratch directory and screenshot directory under `proof/`; its scratch and screenshots are retained with the other evidence and cannot be carried over from the hunt, another attempt or an earlier `finish`. Each accepted `finish` gets a generation number. The latest results and exact script snapshots stay at their usual paths, while `proof/generations/N/` preserves that generation's probe and setup scripts, setup identities, results, findings and report. Report reproduction links and `keep` use the immutable generation snapshots, never a live probe or a later compatibility copy. Later attempts use generation-specific scratch and screenshot directories, so repeated `finish` calls cannot overwrite earlier evidence. When `reset` is configured, app data is reset before every attempt. Every hunt result records the sign-in probe selected for that attempt, even when no reset runs. Without a hunt reset this is the last probe that actually saved the scratch session, including one that failed afterward, rather than an older clean sign-in. The recorded probe signs in again for proof (none, if none was selected), including when there is no reset but the fresh scratch needs its saved session rebuilt; a later run-wide sign-in cannot replace that provenance. Sign-in setup shares the attempt's scratch and session but writes screenshots to a separate `signin-shots` directory. A finding is reported only if it fails both times; one that fails once and holds in the other re-run is listed as intermittent and not counted. If the other re-run never reached its expectation (the probe threw or timed out first), or did not start as its hunt run did (the reset or the sign-in before it failed, and the hunt run's had not), the claim is instead listed as could not re-run, not counted, with the reason; a failed attempt is not evidence of intermittency unless it evaluated the expectation. If the sign-in after a reset failed, the report says so first. The proof has its own budget: no claimed probe's proof starts after 7 minutes, and the whole `finish` call, retries included, ends within 9, writing `findings.json` and `report.txt` after every probe it proves. A claim it had no time for is listed as not re-run in time and not counted.

Reproduction and correctness are different questions: two failed re-runs prove that the probe's expectation failed twice, not that the expectation itself describes valid behavior. The hunter must judge it against the request and what a user would accept, and a reader should do the same before acting on a finding.

## Kept tests

`keep` copies a confirmed finding's exact generation probe to `.stillhunter/tests/<name>/test.mjs` with `test.json`, and the exact setup script that proved it to `.stillhunter/tests/_signin.mjs`. If a different global `_signin.mjs` is already kept, `keep` refuses rather than silently pairing the finding with different setup. A kept test passes when its expectation holds: it fails while the bug is there and passes once it is fixed. `keep` refuses a probe that contains the value of a sign-in variable `start` named; a test reads those values from the environment when it runs. Commit them with your code.

`replay` uses the same reset-and-sign-in sequence as a hunt with `always`, dropping the previous saved session with each reset. Both reset strategies reset before every replayed test. A reset or sign-in failure makes the test `INCONCLUSIVE`, not a pass or evidence that the bug remains, and replay exits nonzero. An expectation never reached because the test threw is a failure of the kept test, not proof of the original bug.

## Configuration

`.stillhunter/config.json`, all optional:

```json
{
  "target": { "url": "http://localhost:3000" },
  "browser": "chrome",
  "hosts": { "allow": ["localhost:3000", "staging.example.test:443"] },
  "auth": { "env": ["APP_EMAIL", "APP_PASSWORD"] },
  "reset": { "command": "npm run reset", "strategy": "always" },
  "verification": { "attempts": 3, "confirm": 2, "nonReproduce": 2 }
}
```

Without `target`, Stillhunter finds this repository's own Nuxt dev server. `browser` is `chrome`, `msedge` or `chromium`; without it, the first one installed is used.

`hosts.allow` contains exact, case-insensitive `host` or `host:port` entries as strings; a host without a port means HTTPS port 443, and an entry with a port matches only that port. Wildcards and domain-suffix matches are not supported. Loopback `http` and `https` URLs remain available without an entry. URLs containing username or password userinfo are rejected. Every non-loopback URL, including `target.url`, redirects, subresources, storage-state origins and `rr.request` URLs, must use HTTPS and match an entry; naming a target alone does not allow it. When `hosts` is absent, no additional hosts are listed. Allowlisting a host trusts its DNS answers, including private or loopback addresses they resolve to. `auth.env` contains environment-variable names, never their values. When present, this list replaces convention discovery, so an empty list selects no credentials; when `auth` is absent, sign-in variable discovery keeps its existing convention.

`reset` is a shell command run in the repository root. With `always`, it runs at `start`, before every hunt probe, before each proof re-run and before each replayed test. With `proof`, it runs only before proof re-runs and replayed tests, not at `start` or before hunt probes. The legacy string form, `"reset": "npm run reset"`, is equivalent to `{ "command": "npm run reset", "strategy": "always" }`; a legacy empty string disables reset. The object form requires a nonempty `command`, accepts `always` or `proof`, and defaults `strategy` to `always`. A reset should put back all the data a hunt starts from, sample data included. A reset still running after 2 minutes is stopped, with every process it started.

### PostgreSQL reset recipes

**Use these only with disposable test databases. Never point a reset at a production or shared database, and never use a production or shared database as the template or dump source. Terminating connections and dropping databases are destructive. The database names, administrator connection and test connection must belong to an isolated test instance.**

Both recipes need the PostgreSQL command-line tools. The connection URLs and passwords stay in the named environment variables; do not put their values in `.stillhunter/config.json`, the reset script or `auth.env`.

**Maintained template, a new database per reset.** Maintain `STILLHUNTER_PG_TEMPLATE_DB` with the schema and seed data the hunt needs. `STILLHUNTER_PG_ADMIN_URL` connects to a maintenance database on the test server, not to the template or a test database. The following reset creates a unique database from that template, records its name for the test app, and removes the previous test database after closing its connections:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${STILLHUNTER_PG_ADMIN_URL:?}"
: "${STILLHUNTER_PG_TEMPLATE_DB:?}"
state=.stillhunter/postgres-test-database
previous=
if [[ -f "$state" ]]; then
  candidate="$(<"$state")"
  if [[ "$candidate" =~ ^stillhunter_test_[0-9]+_[0-9]+$ ]]; then
    previous="$candidate"
  fi
fi
new="stillhunter_test_$(date +%s)_$$"

psql "$STILLHUNTER_PG_ADMIN_URL" --set=ON_ERROR_STOP=1 \
  --set=template="$STILLHUNTER_PG_TEMPLATE_DB" \
  --set=previous="$previous" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname IN (:'template', :'previous')
  AND pid <> pg_backend_pid();
SQL

createdb --maintenance-db="$STILLHUNTER_PG_ADMIN_URL" \
  --template="$STILLHUNTER_PG_TEMPLATE_DB" "$new"
printf '%s\n' "$new" > "$state"
# Restart or reconnect the disposable test app to "$new" here if needed.
if [[ -n "$previous" ]]; then
  dropdb --maintenance-db="$STILLHUNTER_PG_ADMIN_URL" --if-exists "$previous"
fi
```

The test app can read the nonsecret database name from `.stillhunter/postgres-test-database` when it opens its connections. If it keeps a connection pool open, the reset must restart the app or reconnect that pool to the new name before dropping the old database. Keep the template free of app connections; the cleanup also closes any that would prevent `CREATE DATABASE ... TEMPLATE` from running. Add the app-specific restart or reconnection before using this as the configured reset command.

**Dump and restore.** For a fixed disposable test database, create a custom-format dump once from a separate disposable, maintained source:

```bash
pg_dump --dbname="$STILLHUNTER_PG_SOURCE_URL" \
  --format=custom --file="$STILLHUNTER_PG_DUMP"
```

Then use this as the reset. `STILLHUNTER_PG_TEST_URL` connects to `STILLHUNTER_PG_TEST_DB`; both names must refer only to the disposable test instance. The reset closes existing test-database connections before recreating and restoring it:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${STILLHUNTER_PG_ADMIN_URL:?}"
: "${STILLHUNTER_PG_TEST_URL:?}"
: "${STILLHUNTER_PG_TEST_DB:?}"
: "${STILLHUNTER_PG_DUMP:?}"

psql "$STILLHUNTER_PG_ADMIN_URL" --set=ON_ERROR_STOP=1 \
  --set=test_db="$STILLHUNTER_PG_TEST_DB" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'test_db'
  AND pid <> pg_backend_pid();
SQL

dropdb --maintenance-db="$STILLHUNTER_PG_ADMIN_URL" \
  --if-exists "$STILLHUNTER_PG_TEST_DB"
createdb --maintenance-db="$STILLHUNTER_PG_ADMIN_URL" \
  "$STILLHUNTER_PG_TEST_DB"
pg_restore --dbname="$STILLHUNTER_PG_TEST_URL" \
  --no-owner --no-privileges "$STILLHUNTER_PG_DUMP"
```

The app can keep using its fixed test connection because the database name does not change. Use a dump made only from synthetic test data; a dump can otherwise contain credentials or personal data even though none appear in the command.

`verification.attempts` limits valid proof attempts (default `3`), while `verification.confirm` and `verification.nonReproduce` are the thresholds for consistent failed and held observations (both default `2`). Each verification setting can be omitted independently.

Unknown keys and malformed known fields stop the runner with `Invalid .stillhunter/config.json` and the exact field path. Unknown-key errors list the allowed keys. `hosts.allow` and `auth.env` must be arrays of strings, and each `auth.env` entry must be an environment-variable identifier matching `[A-Za-z_][A-Za-z0-9_]*`; verification settings must be positive integers. Keep credential values out of this file: `auth.env` names the variables to read from the environment.

Sign-in credentials otherwise come from environment variables whose names end in `EMAIL`, `USER`, `USERNAME`, `LOGIN`, `PASSWORD` or `PASS`. `start` prints their names, never their values.

## What a probe can and cannot do

A probe is code the model writes, so it runs contained. This is what is enforced:

- **Its own process.** Each probe runs in a child Node process started with Node's permission model. It can read its run folder and Stillhunter's own compiled code and `playwright-core` (not the package root, so a dev checkout's repository and `node_modules` stay unread), plus, on Linux, six system files `playwright-core` reads when it loads to tell whether it runs under WSL or in a container (`/proc/version`, `/proc/self/cgroup` and four marker files), write only a scratch folder and its screenshots, and cannot start processes or worker threads, load native addons, or signal another process (Node has no permission for signals, so the child removes `process.kill` before the probe loads). The runner's own files in the run folder (the context, the result files, the findings) are read-only to the probe, so a probe cannot lift the budget, erase a failed check or forge a confirmed finding. Its environment holds only `PATH` and the sign-in variables `start` named (on Windows also `SystemRoot`, without which a process cannot open a socket, and the variables Node's process library adds to every process it starts there: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR`).
- **A browser it did not launch, reached through a relay.** The runner launches the browser and the probe connects to it, but never to the browser's own endpoint: it connects to a relay in the runner that reads every protocol message the probe sends and forwards only the calls on an allow-list. The relay refuses CDP sessions, launching or connecting another browser, a context with its own proxy or video folder, a context whose base URL is not authorized, navigation (in any page or frame) to an unauthorized URL, a request from the runner's own process to an unauthorized host or one that follows redirects, files read from the runner's disk for an upload or a drop, temp files, tracing, saving a download to a path, and every other call it does not know. Authorized URLs are loopback `http` or `https`, plus exact `hosts.allow` authorities over HTTPS. This holds for raw access through Playwright's private channels too, since the relay sits outside the probe's process. The relay also checks every origin a storage state lists, since restoring one opens a page at each. Inside the probe, the factory that makes every page applies the authorized-hosts-only route, the request watchers and the saved session, and Playwright's public `newContext`, `newPage`, `launch`, `connect` and CDP-session entry points are refused.
- **Loopback and exact allowlisted hosts, in the browser.** Besides the relay's checks, a route on the factory's contexts aborts every unauthorized page request, and the browser's proxy accepts only authorized HTTP requests and loopback or exact allowlisted HTTPS CONNECT authorities, dropping everything else (including Chrome's otherwise-implicit loopback bypass) with WebRTC held to the proxy. `rr.request` applies the same policy and does not follow redirects. A probe can remove its own context's route, and through Playwright's raw channel it can open a context with no route and no watchers (the relay cannot tell that call from the factory's own); in both cases the browser-wide proxy and the relay still enforce the same boundary.
- **Not the network from Node.** Node's permission model cannot limit network access to loopback: Node 22 has no network permission at all, and later versions have one switch for all of it, which the probe needs to reach the browser. So a probe's own Node code can reach the network.

The `.stillhunter/` folder holds a signed-in session in each run folder; `start` and `replay` make sure `.stillhunter/.gitignore` ignores `/runs/`. A hook keeps agents from writing anywhere in `.stillhunter/`. It holds the hunter's Bash to the runner alone, typed exactly as the skill gives it (`start`, `probe`, `finish` and `diff`, which prints the change file by file), with nothing chained, piped, substituted or redirected. It also refuses the hunter's Read, Grep and Glob on secret paths, on any `benchmark/apps/` or `benchmark/comparison/` folder and on Claude Code's session transcripts (except the folder where Claude Code saves this session's own long tool results), and holds the hunter's Grep and Glob to the repository under test, with no `..` in a pattern. A probe must read its run's saved session to start signed in, so it can print it: the runner replaces each of the session's cookie and storage values and every nonempty raw value of the selected sign-in variables, whatever its length, in probe output, result files, reset errors, reports and controlled CLI errors with `[session value]`. `keep` also refuses a test that contains a selected raw credential literally. This is exact raw-value replacement, not detection of arbitrary transformed secrets: a value the probe or reset encodes, hashes or otherwise transforms first can still get through. Treat a run folder's contents as the hunter could see them.

## Where it stands

Stillhunter grew out of [rough-ride](https://github.com/rough-ride/rough-ride). Its engine's first test, on six bugs kept from its author until the engine was frozen, caught the planted bug in 15 of 18 runs with 0.4 false alarms per run. Claude Code with Playwright and a resilience checklist caught 18 of 18 with 3.3 ([report](https://github.com/rough-ride/rough-ride/blob/main/benchmark/comparison/REPORT-hunt.md)). This release closes the gaps that test found ([design](design-0.2.md)). On six new held-out bugs, 0.2.0 caught the planted bug in 17 of 18 runs with 0.41 false alarms per run, against 15 of 18 with 3.15 for Claude Code with Playwright ([report](../benchmark/comparison/REPORT-heldout-0.2.md)). With 18 paired runs the recall gap is not significant; the false-alarm gap is.

The latest evaluation, of 0.2.5, adds a third arm: Claude Code with the same Playwright tools, told to try to disprove each finding and to reproduce it from the start in a fresh browser context. Nine variants (the six held-out planted bugs and three clean features) ran three times in each arm, 81 trials in all, with `claude-opus-5-5` and the same stated 30-minute hunting budget ([report](../benchmark/comparison/REPORT-three-arm-0.2.md)):

| Arm | Planted bug found | Findings confirmed | False alarms per run | Valid regression tests | Median time | Median price |
|---|---:|---:|---:|---:|---:|---:|
| Claude Code with Playwright | 16 of 18 | 47% | 3.37 | 12 of 16 | 3.6 min | $0.62 |
| The same, told to verify each finding | 16 of 18 | 47% | 3.07 | 14 of 16 | 4.4 min | $0.64 |
| Stillhunter | 18 of 18 | 95% | 0.26 | 17 of 18 | 11.3 min | $1.55 |

- **Checked independently.** Two blind judge passes matched every finding to the planted bug or not, and a separate verifier tried to reproduce each planted report and each other issue they raised. Every planted report from every arm was confirmed. "Findings confirmed" is the share of all findings the verifier confirmed.
- **Regression tests.** Each arm left a test for every planted bug it found; for Stillhunter, the test `keep` saved. A test is valid when it fails twice on the buggy code and passes on the clean code.
- **What is significant.** The recall gap is not (exact McNemar p = 0.5 against either arm); the false-alarm gap is (permutation p about 0.0001). Telling Claude Code to verify each finding did not improve its recall or its precision.
- **Time and price.** Stillhunter's proof runs after its hunting budget, while the other arms verify inside theirs, so Stillhunter took about three times as long and cost about 2.5 times as much per run. Prices are API list-price equivalents.
- **Limits.** Three trials on one family of apps measure repeatability on this benchmark, not how the result carries over to other apps, models or kinds of bug. A one-trial [pilot](../benchmark/comparison/REPORT-three-arm-pilot.md) of the three arms came first and is reported separately.
