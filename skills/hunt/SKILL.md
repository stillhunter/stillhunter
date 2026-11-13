---
name: hunt
description: Hunts for bugs in what you just changed in this web app, or in a feature you name. Tests each idea in a real browser with failing, slow and malformed requests and bad input, and reports only bugs that reproduce twice. Say what you want after it, for example "quick look at the invite dialog" or "the export, only serious problems, 20 minutes". About 10 minutes by default.
argument-hint: "[what you want hunted, how long, how serious]"
context: fork
agent: stillhunter:hunter
background: false
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" start *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" probe *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" finish *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" diff)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" diff *)
---
Hunt for bugs in this repository, following your instructions.

What the person asked for, in their words (empty means: the current change, default settings):

    $ARGUMENTS

Your runner prefix `<HUNT>` is, typed exactly:

    node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs"

Turn the request into `start` flags as your instructions say, then start with `<HUNT> start`.
