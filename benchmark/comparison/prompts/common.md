You are reviewing an uncommitted change in this repository before it is merged. The change implements the request in `.stillhunter/specs/request.txt`. `git diff main` and `git status` show it (new files are untracked).

The app is already running: web {{WEB}}, API {{API}}. Sign in with the email in the DEMO_EMAIL environment variable and the password in DEMO_PASSWORD. The app has some sample data.

Your job: find bugs in this change that a real user would hit. Report any kind of bug, including a feature that does not do what the request asks. Pay special attention to resilience, because that is where changes like this most often break:

{{CHECKLIST}}

{{TOOLS}}

Rules:
- Do not edit, create or delete files in this repository. Put any scratch files in {{SCRATCH}}. Do not stop or restart the app. You may change the app's data through the app or its API.
- For each finding, say whether you observed it in the running app ("observed") or only suspect it from reading the code ("suspected").
- For every observed finding, leave one standalone regression test in {{SCRATCH}}/tests/. Write {{SCRATCH}}/tests.json as {"tests": [{"title": "the finding's exact title", "file": "tests/<name>.mjs"}]}. Each test imports `assert` and `chromium` from `./runtime.mjs` and exports a default async function taking `{ web, api, email, password }`. It launches its own Chrome browser, creates any state it needs, and closes the browser in `finally`. Assert correct behavior: the test fails while the bug is present and passes once fixed. Do not merely assert that the bug occurs.
- When you are done, write your findings to {{OUT}} as JSON: {"findings": [{"title": "...", "where": "page or endpoint", "steps": "how to reproduce", "expected": "...", "actual": "...", "evidence": "what you saw", "status": "observed" or "suspected", "severity": "high", "medium" or "low"}]}. An empty list is a valid answer.
- You have about {{MINUTES}} minutes. Write the findings and retained tests before you run out of time.
