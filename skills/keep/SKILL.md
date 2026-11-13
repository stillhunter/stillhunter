---
name: keep
description: Saves a finding Stillhunter confirmed as a test under .stillhunter/tests/, so it can be replayed with no model. Name the finding after it, by its number or title in the last hunt report.
argument-hint: "<finding number or title> [as <test name>]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" keep *)
  - Read
  - Glob
---
Keep this Stillhunter finding as a test: $ARGUMENTS

1. Find the finding in the most recent Stillhunter hunt report in this conversation. The run id is on the line that starts `stillhunter |` (`run <id>`), and each finding's `repro:` line names its probe (`probes/<probe>.mjs`) and its check (`expectation "<check>"`). Match what the person wrote by the finding's number or title. If the report ends with a `hidden:` line, or the person names a finding you cannot see in it, Read that run's `findings.json` (`.stillhunter/runs/<id>/findings.json`) and match against its full `confirmed` list, since the printed report shows only the findings at or above the severity floor. With no report in this conversation, use Glob for `.stillhunter/runs/*-hunt-*/findings.json`, Read the newest one and match a finding in its `confirmed` list (each has `probe`, `check` and `title`; the run id is the folder name).
2. If more than one finding matches, or none does, list the confirmed findings and ask which one. Do not guess.
3. Run, typed exactly with the values filled in:

       node "${CLAUDE_PLUGIN_ROOT}/dist/hunt.mjs" keep --run <id> --probe "<probe>" --check "<check>"

   Quote `<probe>` and `<check>`: a check name can hold spaces. Escape any double quote inside the name with a backslash. Add `--as <name>` (lowercase letters, digits and dashes) when the person gave a name for the test.
4. Reply with the block it prints, copied unchanged. Do not edit or write files under `.stillhunter/` yourself.
