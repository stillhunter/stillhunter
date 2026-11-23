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
   repro: .stillhunter/runs/20261114-100317-hunt-ea44/probes/beds-water.mjs (expectation "negative-litres-refused")
```

If your app keeps data, add a `reset` command to the config so every probe starts from the same data; see [Reset](#reset) for recipes, including a Postgres snapshot restore. Probes run model-written code under the limits in [What a probe can and cannot do](#what-a-probe-can-and-cannot-do); read that section before you point a hunt at anything but a local dev server with test data.

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
- `--url <address>`: where the app runs, when you name it, such as `http://localhost:5173`. It overrides the config and detection for this hunt, and takes only an address on this machine.

## How a hunt works

1. `start` finds the app (see [The app](#the-app)), then prints the whole change (the diff of tracked files and every untracked file, cut at 60 KB with the largest files left out first), the spec files under `.stillhunter/specs/`, and the budget. `diff` lists the changed files and prints one file's whole diff (up to 1 MB) for what the cap left out. Neither prints the body of a secret file such as `.env`, `.npmrc` or a key. When `reset` is configured, `start` runs it once and says how long it took; if it fails, `start` stops and shows the command and the end of its output, so a broken reset shows up before the hunt, not at `finish`.
2. The hunter writes probes: small scripts that drive the app in a browser through `rr`, a probe API with request faults, an observation of what the page shows (including layout problems such as clipped values and content past the screen edge), screenshots and named expectations. Every run of a probe keeps its own result. When `reset` is configured (and `resetBefore` is not `"re-runs"`), every probe starts the way `finish` will re-run it: the runner resets app data and drops the run's saved session, so nothing carries over from before the reset even when the app's sessions outlive it, then runs the hunt's sign-in probe again (the latest probe that saved a session and ended without an error, or, failing that, the latest that saved a session before it failed), unless the probe is the sign-in probe itself. The result says how long the reset and the sign-in took, and starts with a warning if either failed; the probe runs anyway. A sign-in probe that saves its session and then fails leaves that session in place, and the warning says so. This time counts against the budget. Without `reset`, or with `"resetBefore": "re-runs"`, app data carries over from one probe to the next.
3. `finish` checks each claim against the probe's latest result, makes the hunter account for every failed expectation, and points out API endpoints it never faulted and pages it never saw at 375 px wide. Requests to the dev server's own paths (such as `/_nuxt/`, `/__nuxt_dev__/`, `/@vite/`, `/_next/static/` and `/favicon.ico`) are left out of that list, and so is what a probe saw while it signed in: the sign-in page and the requests made before the page it landed on, unless another probe saw them too. It then re-runs each claimed probe twice from scratch, most severe claims first. When `reset` is configured, each re-run starts as the claimed probe's hunt run did: app data is reset, and the probe that signed in before that hunt run signs in again (none, if none did). A finding is reported only if it fails both times; one that fails once and holds in the other re-run is listed as intermittent and not counted. If the other re-run never reached its expectation (the probe threw or timed out first), or did not start as its hunt run did (the reset or the sign-in before it failed, and the hunt run's had not), the claim is instead listed as could not re-run, not counted, with the reason; a failed attempt is not evidence of intermittency unless it evaluated the expectation. If the sign-in after a reset failed, the report says so first. The proof has its own budget: no claimed probe's proof starts after 7 minutes, and the whole `finish` call, retries included, ends within 9, writing `findings.json` and `report.txt` after every probe it proves. A claim it had no time for is listed as not re-run in time and not counted.

Reproduction and correctness are different questions: two failed re-runs prove that the probe's expectation failed twice, not that the expectation itself describes valid behavior. The hunter must judge it against the request and what a user would accept, and a reader should do the same before acting on a finding.

## Kept tests

`keep` copies a confirmed finding's probe to `.stillhunter/tests/<name>/test.mjs` with `test.json`, and the run's sign-in probe to `.stillhunter/tests/_signin.mjs`. A kept test passes when its expectation holds: it fails while the bug is there and passes once it is fixed. `keep` refuses a probe that contains the value of a sign-in variable `start` named; a test reads those values from the environment when it runs. Commit them with your code.

`replay` uses the same reset-and-sign-in sequence as a hunt (before every test, whatever `resetBefore` says), dropping the previous saved session with each reset. A reset or sign-in failure makes the test `INCONCLUSIVE`, not a pass or evidence that the bug remains, and replay exits nonzero. An expectation never reached because the test threw is a failure of the kept test, not proof of the original bug.

## Configuration

`.stillhunter/config.json`, all optional:

```json
{
  "target": { "url": "http://localhost:3000" },
  "browser": "chrome",
  "reset": "npm run reset",
  "resetBefore": "every-probe",
  "resetTimeoutSeconds": 120,
  "signIn": { "variables": ["APP_EMAIL", "APP_PASSWORD"] },
  "network": { "allow": ["api.staging.example.com"], "allowForSignIn": ["*.auth0.com"] }
}
```

A setting with a wrong value stops the hunt and says what is wrong with it.

### The app

Without `target`, Stillhunter looks for a dev server that belongs to this repository: a Nuxt dev server, found by its lock file, or a Vite or Next dev server on its usual ports (Vite 5173 to 5180, Next 3000 to 3007). For Vite and Next it writes a file of random bytes for a moment (in the app's `node_modules/` for Vite, in `.next/static/` or `.next/dev/static/` for Next, folders neither dev server watches), asks each port for it, and removes it. A server counts only if it serves that file, so another app on the port, or another checkout of the same app, is never taken for this one. If more than one server answers, or none does, `start` stops and says how to name the URL. You can also name it for one hunt, for example `/stillhunter:hunt the checkout at http://localhost:5173`, which the hunter passes to `start` as `--url`; `start` then shows the line to put in the config so you can skip it next time. `--url` takes only an address on this machine.

`browser` is `chrome`, `msedge` or `chromium`; without it, the first one installed is used.

### Reset

`reset` is a shell command run in the repository root. It should put back all the data a hunt starts from, sample data included: every probe or re-run that follows starts from what it leaves.

- `resetBefore` says when it runs. `"every-probe"`, the default, runs it at `start`, before every probe, before each re-run and before each replayed test. `"re-runs"` runs it at `start` (to check that it works) and before each re-run and each replayed test, but not before hunt probes, so during the hunt probes share app data as they would with no reset. The proof is unchanged: each claimed probe is still re-run twice from the reset state. Use it when the reset takes long enough to eat into the hunt. The cost: a probe that only fails on data an earlier probe left behind is found in the hunt but does not reproduce, so it is listed as not reproduced rather than confirmed.
- `resetTimeoutSeconds` is how long a reset may run before it is stopped, with every process it started: from 1 to 300, 120 by default. A reset's time counts against the hunt's budget, and in `finish` against the proof's.

The command's output is not masked, so a reset should not print secrets. Some recipes follow; each is a script you keep in your repository and name in `reset`, for example `"reset": "sh .stillhunter/reset.sh"`.

**Postgres, from a snapshot database.** Restoring from a template is much faster than replaying a dump. Make the snapshot once, from a database holding the sample data, with no one connected to it:

```sh
createdb -T app_dev app_snapshot
```

Then the reset drops the dev database and copies the snapshot back (Postgres 13 or later, for `WITH (FORCE)`, which closes the app's open connections):

```sh
#!/bin/sh
set -e
psql "${ADMIN_DATABASE_URL:-postgres:///postgres}" -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS app_dev WITH (FORCE)' \
  -c 'CREATE DATABASE app_dev TEMPLATE app_snapshot'
```

The app's connection pool must reconnect after its connections are closed; most do on the next query. If yours does not, restart the API in the same script.

**Postgres in Docker Compose, with a dump.** When the database runs in a container and a template is not an option:

```sh
#!/bin/sh
set -e
docker compose exec -T db psql -U app -d postgres -v ON_ERROR_STOP=1 -q \
  -c 'DROP DATABASE IF EXISTS app_dev WITH (FORCE)' -c 'CREATE DATABASE app_dev'
docker compose exec -T db pg_restore -U app -d app_dev --no-owner < .stillhunter/sample.dump
```

Make the dump once with `docker compose exec -T db pg_dump -U app -Fc app_dev > .stillhunter/sample.dump`.

**Several services.** Reset each store the app keeps state in, in the order the app needs, and give the services a moment to settle:

```sh
#!/bin/sh
set -e
sh .stillhunter/reset-postgres.sh
docker compose exec -T redis redis-cli FLUSHDB
docker compose restart worker
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://localhost:8000/health > /dev/null
```

**SQLite.** Copy a saved file over the database while the app holds no write open, for example `cp .stillhunter/sample.sqlite3 data/dev.sqlite3`.

### Sign-in

Without `signIn`, a probe gets every environment variable whose name ends in `EMAIL`, `USER`, `USERNAME`, `LOGIN`, `PASSWORD` or `PASS`. With `signIn.variables`, it gets exactly the variables listed, whatever their names, and no others, so the config says what is passed and a reviewer can see it. A listed variable that is not set stops `start` and `replay`. Names that change how Node, its loader or the browser run (`PATH`, `HOME`, `NODE_*`, `LD_*`, `DYLD_*`, `UV_*`, `PLAYWRIGHT_*` and a few others) are refused. Either way, `start` prints the names, never the values.

### Network

A probe's browser reaches loopback hosts only, unless `network` lists more. The listed hosts are reached over https only, as host names (`api.staging.example.com`) or wildcards for their subdomains (`*.example.com`, which does not match `example.com` itself); a scheme, port or path is refused, and so is a wildcard as broad as `*.com`.

- `allow`: hosts every probe may reach, such as a staging API the dev frontend calls. Its requests count as the app's in coverage, so finish asks for them to be faulted like the rest. Its data is not reset by the `reset` command unless that command resets it.
- `allowForSignIn`: hosts only the sign-in probe may reach, and only until it calls `rr.saveSession()`, such as a hosted sign-in page. In a hunt, the sign-in probe is the run's sign-in probe, or, while the run has none yet, any probe. In a re-run and in replay, it is the probe that signs in before the others. Once the session is saved, the probe's route, the relay and the proxy all refuse those hosts for the rest of that probe, and the proxy closes any tunnel to them that was still open. The saved session keeps the app's storage, not the sign-in host's, and the sign-in host's cookies are kept as a browser keeps them.

`start` prints a `network:` line with what the browser can reach. Hosted sign-in pages often check for automated browsers, and some refuse them whatever the network allows. A test account that signs in with a password on the app's own page, or a sign-in the dev server offers only on this machine, is more reliable than a hosted page.

## What a probe can and cannot do

A probe is code the model writes, so it runs contained. This is what is enforced:

- **Its own process.** Each probe runs in a child Node process started with Node's permission model. It can read its run folder and Stillhunter's own compiled code and `playwright-core` (not the package root, so a dev checkout's repository and `node_modules` stay unread), plus, on Linux, six system files `playwright-core` reads when it loads to tell whether it runs under WSL or in a container (`/proc/version`, `/proc/self/cgroup` and four marker files), write only a scratch folder and its screenshots, and cannot start processes or worker threads, load native addons, or signal another process (Node has no permission for signals, so the child removes `process.kill` before the probe loads). The runner's own files in the run folder (the context, the result files, the findings) are read-only to the probe, so a probe cannot lift the budget, erase a failed check or forge a confirmed finding. Its environment holds only `PATH` and the sign-in variables `start` named, from `signIn.variables` when the config lists them (on Windows also `SystemRoot`, without which a process cannot open a socket, and the variables Node's process library adds to every process it starts there: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR`).
- **A browser it did not launch, reached through a relay.** The runner launches the browser and the probe connects to it, but never to the browser's own endpoint: it connects to a relay in the runner that reads every protocol message the probe sends and forwards only the calls on an allow-list. The relay refuses CDP sessions, launching or connecting another browser, a context with its own proxy or video folder, a context whose base URL is not a loopback `http` or `https` URL, navigation (in any page or frame) to anything but `http` or `https` on a loopback host or `https` on a host the config's [network](#network) settings allow (sign-in hosts only for the sign-in probe, until it saves its session), a request from the runner's own process to any other host (sign-in hosts never count here) or one that follows redirects, files read from the runner's disk for an upload or a drop, temp files, tracing, saving a download to a path, and every other call it does not know. This holds for raw access through Playwright's private channels too, since the relay sits outside the probe's process. The relay also checks every origin a storage state lists, since restoring one opens a page at each: loopback and `network.allow` hosts only. Inside the probe, the factory that makes every page applies the network route, the request watchers and the saved session, and Playwright's public `newContext`, `newPage`, `launch`, `connect` and CDP-session entry points are refused.
- **Loopback only in the browser, unless the config lists more.** Besides the relay's checks, every page request to a host other than `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`, or an `https` host the config's [network](#network) settings allow, is aborted by a route on the factory's contexts. The browser's proxy is a local port that drops every connection except an HTTPS tunnel (`CONNECT`) to a listed host (Chrome never sends loopback through a proxy), with WebRTC held to the proxy. Plain `http` through the proxy is never forwarded, and a tunnel whose first bytes are not a TLS handshake (a plain `ws://` WebSocket, for example) is cut before anything reaches the host, so a listed host is reached over TLS only, and the tunnel carries TLS end to end: the proxy sees the host name, not the traffic. A tunnel to an allowed host that cannot be reached is answered `502`, so the browser says the tunnel failed. The sign-in hosts close in the route, the relay and the proxy when the sign-in calls `rr.saveSession()`, and the runner waits for that before the probe goes on. `rr.request` refuses URLs other than loopback and `https` to `network.allow` hosts. A probe can remove its own context's route, and through Playwright's raw channel it can open a context with no route and no watchers (the relay cannot tell that call from the factory's own); in both cases the browser-wide proxy and the relay still hold it to loopback `http` and `https`, and `https` to the hosts it may reach. With no `network` setting, nothing but loopback is reachable, as before.
- **Not the network from Node.** Node's permission model cannot limit network access to loopback: Node 22 has no network permission at all, and later versions have one switch for all of it, which the probe needs to reach the browser. So a probe's own Node code can reach the network.

The `.stillhunter/` folder holds a signed-in session in each run folder; `start` and `replay` make sure `.stillhunter/.gitignore` ignores `/runs/`. A hook keeps agents from writing anywhere in `.stillhunter/`. It holds the hunter's Bash to the runner alone, typed exactly as the skill gives it (`start`, `probe`, `finish` and `diff`, which prints the change file by file), with nothing chained, piped, substituted or redirected. It also refuses the hunter's Read, Grep and Glob on secret paths, on any `benchmark/apps/` or `benchmark/comparison/` folder and on Claude Code's session transcripts (except the folder where Claude Code saves this session's own long tool results), and holds the hunter's Grep and Glob to the repository under test, with no `..` in a pattern. A probe must read its run's saved session to start signed in, so it can print it: the runner replaces each of the session's cookie and storage values, and each raw sign-in value of four characters or more, in what a probe prints and in its result files with `[session value]`. It cannot catch a value the probe encodes first, shorter sign-in values or secrets printed by the reset command. Treat a run folder's contents as the hunter could see them.

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
