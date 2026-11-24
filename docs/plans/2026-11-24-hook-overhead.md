# Hook Overhead Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove Node startup cost from irrelevant tool calls while preserving every existing Stillhunter guard decision.

**Architecture:** Replace process-based plugin hooks with an in-process `tool.call` hook. Irrelevant main-session and non-hunter calls continue directly. Hunter calls and paths or commands that may name `.stillhunter/` invoke the existing Node guard over stdin with the original hook metadata reconstructed from the session APIs. Require a Claude Code version that supports the necessary mod and session APIs.

**Tech Stack:** Claude Code mod hooks, JavaScript ES modules, Node's built-in test runner, existing `hooks/guard.mjs`.

---

### Task 1: Specify fast-path and fallback behavior

**Files:**
- Modify: `test/guard.test.mjs`
- Create: `hooks/register.mjs`
- Create: `hooks/fast-path.mjs`

**Steps:**
1. Add tests proving ordinary main-session Read, Grep, Glob, Edit, Write, Bash, and PowerShell calls do not start a process.
2. Add tests proving non-hunter subagent reads do not start a process.
3. Add tests proving hunter calls, unknown agents, mixed-case `.stillhunter/` paths, and every existing shell folder spelling invoke the fallback.
4. Add tests proving fallback input includes tool input, cwd, agent type, session id, and transcript path, and that a guard denial becomes `{ deny }`.
5. Run `node --test test/guard.test.mjs` and confirm failure because the in-process hook does not exist.

### Task 2: Implement the in-process hook and fallback transport

**Files:**
- Create: `hooks/fast-path.mjs`
- Create: `hooks/register.mjs`
- Modify: `hooks/guard.mjs`
- Modify: `hooks/hooks.json`

**Steps:**
1. Move the pure shell-folder check into `fast-path.mjs` and re-export it from `guard.mjs` for existing callers.
2. Register one in-process matcher for the eight guarded tools. Continue irrelevant calls without a mods API process call.
3. Resolve subagent types through `$.agent.list()`. Treat an unknown subagent as the hunter so identification fails closed.
4. For fallback calls, pass only the fields the guard reads to `node hooks/guard.mjs [read]` over stdin, so large edit and write content cannot exceed the mods filesystem limit and no temporary file needs cleanup. Deny a guarded call before transport if its remaining payload exceeds the process stdin limit.
5. Preserve the guard's existing stdin behavior for direct use and tests.
6. Replace command hooks with `modules: ["./register.mjs"]`.
7. Run `node --test test/guard.test.mjs` and confirm all guard and fast-path tests pass.

### Task 3: Version, package, and verify

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `README.md`
- Modify: `docs/guide.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `test/harness.test.mjs` if package assertions need the new shipped file

**Steps:**
1. Require Claude Code `>=2.1.326` and document the in-process guard behavior.
2. Run `claude plugin validate .` and confirm the module and its API calls are recognized.
3. Run `npm run build`, targeted guard/package tests, and the complete CI command sequence.
4. Exercise real Claude Code Read calls with the plugin loaded and confirm irrelevant calls do not invoke `guard.mjs`, while a protected `.stillhunter/` write is denied.
5. Check `git status` and remove diagnostic artifacts. Leave changes uncommitted unless the user requests a commit or merge.
