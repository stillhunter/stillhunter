# Stillhunter 0.2.0: engine design

What the first release builds, and why. The evidence is rough-ride's held-out test of the same engine ([REPORT-hunt.md](https://github.com/rough-ride/rough-ride/blob/main/benchmark/comparison/REPORT-hunt.md)) and the review of its 54 run transcripts that followed. The frozen engine that test ran is the starting point: `src/hunt.mts`, `src/probe-host.mts`, `agents/hunter.md`, `skills/hunt/SKILL.md`.

Scope rule: Stillhunter does three things a prompt cannot: it **reproduces before reporting**, it **injects faults**, and it **keeps each finding as a test**. Anything else needs a reason.

## What the test showed (the problems this release fixes)

1. **It stops early.** Median 540 of 720 s left when it finished; plans were short and almost all of each was probed. Breadth is limited by the plan, not by time.
2. **It drops failures it saw.** 115 of 206 failed checks in its own probes were never reported or explained.
3. **It cannot see.** No screenshots (0 of 54 runs; Playwright read one in 8 of 27). `observe()` reports page-level sideways scroll only. The CSS diff reached its context in 8 of 27 runs. It never opened the hx5 form at 375 px in 2 of 3 runs, and tested long-text layout with short data.
4. **The finish gate cost 29% of wall time and dropped no false alarm.** It re-ran once per claim, overwrote result files, read only stdout's last line, and shared app data between runs.
5. **Containment is weaker than claimed.** Probes are imported into the runner's process: any Node API, any host, a second browser context.
6. **`hunter.md` named the six dev bugs almost word for word**, and its example probe reproduced one of them.

## Commands

| In Claude Code | Runner | What it does |
|---|---|---|
| `/stillhunter:hunt [what you want]` | `start`, `probe`, `finish`, `diff` | Hunt for bugs |
| `/stillhunter:keep <finding>` | `keep` | Save a confirmed finding as a test under `.stillhunter/tests/` |
| `/stillhunter:replay [names] [--watch]` | `replay` (also `npx stillhunter replay`) | Run kept tests with no model; `--watch` shows one in a visible browser |

`hunt` takes free text. The hunter turns it into runner flags; the runner enforces them:
- `--depth quick|default|deep`: budgets 4, 10 and 25 minutes. `--minutes N` overrides.
- `--min-severity high|medium|low`: the report shows only findings at or above it and ends with one line, for example `4 medium/low findings hidden: .stillhunter/runs/<id>/report.txt`. Testing and proof are unchanged.
- `--focus "<text>"`: what the person asked to look at, stored in `context.json` and printed by `start`.
- **Feature mode**: when there is no change against the base and a focus is given, the hunt tests that feature as it stands; `start` says so. With no change and no focus, `start` stops: `No change found. Name a feature to hunt, for example: /stillhunter:hunt the checkout flow`.

## The hunt

### start
- Prints the run id, target, browser, budget, depth, focus, the names of sign-in variables (as now), and **the text of each spec file**, so the hunter never needs a shell command that names `.stillhunter` (the guard refuses those; in the scaffold's smoke run the hunter's `cat .stillhunter/specs/request.txt` was refused).
- **Prints the whole change**: `git diff <base>` of tracked files plus the content of untracked files, CSS and templates included, capped at 60 KB with a line saying what was cut (largest files cut first, never a changed file's name) and pointing to `diff --file <file>` for each one cut.
- A secret file the guard keeps from the hunter (`.env*`, `.npmrc`, `.netrc`, `.pgpass`, `session.json`, keys, anything under `.ssh`, `.aws`, `.gnupg` or `.git`) is named, but its body is left out.

### diff
- `diff` lists every changed and untracked file with the size of its diff. `diff --file <path>` prints one file's whole diff against the base, or its content when untracked, up to 1 MB with a line saying what was cut. It refuses a path outside the repository (a symbolic link is followed first), anything under `.stillhunter`, a secret file and a file not in the change. It is how the hunter reads what `start` cut, since its shell runs nothing but the runner.
- Makes sure `.stillhunter/.gitignore` ignores `/runs/` (append the rule if a `.gitignore` exists without it), because run folders hold a signed-in session.

### probe
- Each run of a probe keeps its own numbered result: `probes/<name>.<n>.result.json`, plus `<name>.result.json` for the latest.
- Results keep **every** XHR and fetch request (not the last 30), and each page's viewport.

### Probe API additions (`rr`)
- `rr.screenshot(name, { page?, fullPage?, locator? })` writes `shots/<name>.png` in the run folder and returns its path. The hunter must look at it with the Read tool.
- `observe()` adds `layout`: up to 10 candidates, each `{ kind, selector, text, detail }`:
  - `value-clipped`: an input, select or textarea whose value or placeholder does not fit its box (scrollWidth > clientWidth + 1, or measured text width > content width).
  - `text-clipped`: an element with `overflow: hidden | clip` or `text-overflow: ellipsis` whose content is wider or taller than its box.
  - `off-screen`: a visible element whose right edge is past the viewport, unless it is inside a container that scrolls sideways on purpose (`overflow-x: auto | scroll`).
  - No pixel thresholds tuned to any benchmark bug.
- `rr.newPage({ width, height, timezoneId?, locale? })`: every page and context a probe makes comes from one guarded factory (loopback route, watchers, session).
- `rr.request(method, url, body?, { raw?, headers? })`: `raw` sends the string as is (for example `1e309` or a NUL), every status is recorded in the result.

### Containment
- The probe runs in a **child Node process** started with Node's permission model: file reads limited to the run folder and the package's compiled code and `playwright-core`, file writes to its scratch and screenshot folders, no child processes, no workers, no addons. The permission model has no rule for signals, so the child replaces `process.kill` and `process._kill` with non-writable functions that throw before the probe loads. The host owns the browser (`launchServer`), so the child never launches a browser.
- **The browser relay.** The child never sees the browser server's endpoint. It connects to a WebSocket the host serves on loopback, at a random path, and the host relays to the server while checking every message the child sends (`{id, guid, method, params}`; each guid's type comes from the server's own `__create__` messages). Methods are allowed by name per type, from playwright-core 1.64.1's protocol; anything else is answered with an error and never forwarded, and the refusals go into the result as `refused`. Refused: CDP sessions at any level, launching or connecting a browser, a context with its own proxy, video folder or client certificates, a context whose `baseURL` is not a loopback `http` or `https` URL, navigation in any page or frame (and a route's redirect or continue URL) to anything but `http` or `https` on a loopback host, a storage state listing any other origin (restoring one opens a page at each), a request from the host's process to another host or one that follows redirects, upload or drop files given as host paths or streams, temp files, tracing, saving an artifact to a path, and permissions that reach the host (clipboard, camera, microphone).
- **Further layers.** The factory behind `rr.newPage()` gives each context a loopback-only route and the watchers; Playwright's public `newContext`, `newPage`, `launch`, `connect` and CDP-session entry points are replaced in the child. The browser's proxy is a local port that drops every connection, with WebRTC held to it, so a page reaches no other host whatever context it is in. A probe can remove its own route, and through the raw channel it can open a context with no route or watchers (the relay cannot tell that call from the factory's); the proxy and the relay still hold it.
- **The saved session.** The child must read the run's `session.json` to start signed in, so a probe can print it. The host replaces each of the session's cookie and storage values (8 characters or more) in the result, the printed output and the notes with `[session value]`; a value the probe encodes first gets through.
- Network: if the Node versions we support can restrict network access through the permission model, use it to allow loopback only; if not, say plainly in the docs that a probe's own Node code can reach the network, and keep the browser's loopback-only route.
- The child inherits only the sign-in variables `start` named and `PATH`; nothing else from the environment.
- **The hunter's tools.** A PreToolUse hook (`hooks/guard.mjs`) holds the hunter's Bash to one shape: `node "<plugin root>/dist/hunt.mjs" start|probe|finish|diff` with plain or quoted arguments and at most one heredoc with a quoted delimiter, nothing chained, piped, substituted or redirected. The plugin root must be typed as one of the plugin's own roots, or a symlinked spelling of one, with no `$`, backtick, doubled backslash, `!`, `.` or `..` in it, since the shell expands those before node starts. The hook also refuses the hunter's Read, Grep and Glob on secret paths, on `benchmark/apps/`, `benchmark/comparison/` and Claude Code's session transcripts (the benchmark's answer key), except the session's own `tool-results` folder where Claude Code saves a long tool output for the agent to Read. The hunter's Grep and Glob stay inside the repository under test (the nearest folder holding `.git`): the search folder and an absolute pattern's literal start must be inside it, and no pattern may hold `..`. No agent may write in `.stillhunter/`.
- Docs state only what is enforced.

### finish
Input: `{ "findings": [...], "dismissed": [...], "leads": [...] }`.
- **Claim-time checks**: a claim must name a probe that exists and a check that failed in that probe's latest result. A check that passed, a note, or a missing check is refused at once with a message saying how to fix it (not silently dropped).
- **Accounting**: every check that failed in any probe's latest result must appear in `findings` or in `dismissed`, each dismissal with a reason: `probe-wrong`, `duplicate` (with the finding's title), `intended` (the spec or the app asks for it), `not-this-change` or `resilience-gap`. If any failed check is unaccounted for, finish refuses once and lists them; a second finish accepts and records them as unaccounted.
- **Coverage**: the runner aggregates, over all probes, every API endpoint seen (method and path with ids folded), the faults applied to each, the viewports used and the pages visited. finish prints `seen but never faulted` and `pages never seen at 375 px`. If more than 180 s of budget remain and either list is not empty, finish refuses once and says what is left.
- **Proof**: each distinct claimed probe is re-run **twice from scratch**, all its claimed checks evaluated on each run. Before each re-run, app data is reset when the config has `reset` (run in the repository root), and the sign-in probe runs again. A finding is confirmed when its check fails in both re-runs. One that fails in one of two is listed as `Intermittent (1 of 2), not counted`. A re-run whose probe host crashed, timed out or gave no result is retried once after checking the app still answers.
- **Proof budget and wall limit**: the hunter's shell gives up on a command after 600 s, so finish has its own clock, counted from the start of the call. Claimed probes are proved in severity order (high, medium, low; claim order within each). No claimed probe's proof starts after the proof budget (420 s; `--proof-seconds N` lowers it), and every run, reset, sign-in and retry is held to the wall limit (540 s): a run is given only the time left before it, and none starts with less than 15 s. A probe the budget never reached, or whose run or sign-in the wall limit cut short, is listed as `Not re-run in time, not counted`, never as not reproducing. `findings.json` and `report.txt` are written (whole, through a rename) before the proof and after every proved probe, so a finish stopped part way still leaves a report; `findings.json` keeps the proof record (`budgetSeconds`, `wallLimitSeconds`, `finishSeconds`, `order`, `proved`, `complete`).
- **Leads**: `leads` (suspicions it could not make happen) go to `leads.json` in the run folder and are not shown in the report.
- **Report**: confirmed findings at or above `--min-severity`, the hidden-count line, intermittent findings and those not re-run in time, coverage. `report.txt` holds everything, including dismissals, unaccounted checks, proof notes and the proof's duration.

## keep and replay
- `keep --run <id> --probe <name> --check <check> [--as <name>]` copies the probe into `.stillhunter/tests/<as>/test.mjs` with `test.json` (`{ check, title, severity, keptFrom }`). It also keeps the run's sign-in probe (the one that called `rr.saveSession()`) as `.stillhunter/tests/_signin.mjs` if there is none yet. Kept tests never contain a session or a credential.
- A kept test passes when its check **holds**. While the bug is there it fails; once fixed it passes and guards against the bug coming back.
- `replay [names] [--watch]` runs `_signin`, then each test in a fresh, contained probe host, resetting app data before each when configured. It prints a block with each test's result and exits 1 if any fails. `--watch` runs headed with slow motion and keeps the page open for 10 s at the end.

## hunter.md
- Read the whole change (every changed file; drop "about 2 minutes").
- Plan in three parts as now, but "a confirmed finding is not a reason to stop": work until the coverage report is clean or the budget is nearly spent.
- Open every page, form, dialog and expanded state the change adds at 375 px with maximum-length text, take a screenshot and look at it; turn anything wrong into a named geometric or text expectation the gate can re-run.
- Account for every failed check at finish.
- No wording or example that matches a benchmark bug; a neutral example probe.
- Map the person's request to `start` flags; report in the person's terms.

## Tests
- Unit: guard, target, browser, accounting, coverage folding, claim-time checks, the depth and severity flags.
- Integration, no model: a small local app with known defects (a layout bug at 375 px, a failure shown as empty, a flaky check) driven through `start`, `probe`, `finish`, `keep` and `replay`, asserting what is confirmed, refused, intermittent and replayed.
- Containment: probes that try to read `~/.ssh`, spawn a process, write outside the run folder or open a second unguarded context all fail. Through Playwright's raw channel: a browser or context CDP session (`Target.createTarget` at a `file:` URL), a context with its own proxy, `file:` and non-loopback navigation, host-path uploads, a host fetch to another host, launching a browser and storage states with other origins are all refused by the relay; a raw context with no route still reaches no other host and no `file:` page. A probe that prints the saved session leaves no session value in its result.
- Proof limits: a re-run that hangs is cut short by the wall limit, finish ends before it and lists the claim as not re-run, and the report on disk holds each probe proved so far while finish runs.
- Guard: the hunter's one shell shape, including roots that carry `$(...)`, backticks or variables balanced with `..`; answer-key reads and searches rooted above them.
- Benchmark harness, offline: the plugin folder check, the packed file list, the plugin folder passed to claude, reading each run's `findings.json` and analyze's failed-run and finish-duration report.

## Not in 0.2.0
Server-side fault injection (pages rendered on the server), a quick or thorough choice beyond the three depths, any engine other than this one.
