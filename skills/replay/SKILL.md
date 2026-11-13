---
name: replay
description: Runs the tests kept under .stillhunter/tests/ against the running app, with no model. A test passes when the bug it was kept for is gone. Name tests to run only those; add --watch to watch one in a visible browser.
argument-hint: "[test names] [--watch]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" replay*)
---
Replay Stillhunter's kept tests. The person asked for: $ARGUMENTS

Run, typed exactly, with the test names and `--watch` from the request after `replay` (nothing after it runs every kept test):

    node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" replay

Use the Bash tool with timeout 600000. Reply with the block it prints, copied unchanged, then one sentence: which tests failed, if any. A failing kept test means the bug it was kept for is there.
