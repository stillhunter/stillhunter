// Stillhunter's PreToolUse guard. Stillhunter's evidence lives in .stillhunter/:
// run folders the runner writes, kept tests, and the spec files a person writes.
// No agent may write there, so a finding, a kept test or a spec is never made up
// by the model it judges. The hunter also never reads secrets, the signed-in
// session a run saves, or the benchmark's answer key.
//   node guard.mjs          (Edit, Write, NotebookEdit, Bash, PowerShell)
//   node guard.mjs read     (Read, Grep, Glob)
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUNTER = 'stillhunter:hunter';
const FOLDER = '.stillhunter';

const WRITE_REASON = `Agents can't write in ${FOLDER}/: runs and kept tests come from the runner, and specs from you. Write the spec file yourself.`;
const SHELL_REASON = `Shell commands can't name ${FOLDER}. Read files there with the Read tool; the runner writes them.`;
const READ_REASON = 'The hunter does not read secrets, credentials or saved sign-in sessions.';
const SCRAPE_REASON = `The hunter reads a run folder's result files one at a time with the Read tool, not Grep or Glob across ${FOLDER}/runs.`;
const HUNTER_BASH_REASON = 'The hunter runs only the stillhunter runner, typed exactly as `node "<plugin root>/dist/hunt.mjs" start|probe|finish|diff ...` with at most a quoted heredoc, and nothing chained or redirected. Read the change with `diff --file <file>` and other files with the Read tool.';
const ANSWERS_REASON = 'The hunter does not read the benchmark\'s apps or comparison results, or earlier sessions\' transcripts, and does not search a folder that holds them: they are the answer key. Search inside the repository.';
const SEARCH_REASON = 'The hunter searches only inside the repository it is testing, with no `..` in a pattern. Read a file elsewhere with the Read tool.';

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const segmentsOf = (p, cwd) => path.resolve(cwd, p).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
const inFolder = (p, cwd) => segmentsOf(p, cwd).includes(FOLDER);

// A shell line that names the folder in any spelling a shell would accept.
// Backslashes are stripped (a shell removes `\h` to `h`) as well as turned into
// '/', so `.still\hunter` and `.stillhunter/x` both read as the folder.
export function namesFolder(command) {
  const lower = command.toLowerCase();
  const stripped = lower.replace(/["'`\\]/g, '');
  const slashed = lower.replace(/\\/g, '/').replace(/["'`]/g, '');
  return stripped.includes(FOLDER) || slashed.includes(FOLDER) || /\.stillh[*?[]|\.st\*|stillhu~\d/.test(slashed);
}

// This file lives in <plugin root>/hooks/, and the hunter's runner is
// <plugin root>/dist/hunt.mjs, spelled as the skill gave it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export function pluginRoots(env = process.env) {
  const roots = new Set([path.resolve(HERE, '..')]);
  if (env.CLAUDE_PLUGIN_ROOT) roots.add(path.resolve(env.CLAUDE_PLUGIN_ROOT));
  for (const r of [...roots]) {
    try { roots.add(realpathSync(r)); } catch {}
  }
  return [...roots];
}

const SUBCOMMANDS = new Set(['start', 'probe', 'finish', 'diff']);
// An argument is a plain word, or a quoted string with nothing a shell would
// expand inside it.
const ARG = /^(?:[A-Za-z0-9_.,:/=@+%-]+|"[^"\\$`!\n]*"|'[^'\n]*')$/;
const ARGS = /(?:[A-Za-z0-9_.,:/=@+%-]+|"[^"\\$`!\n]*"|'[^'\n]*')/g;
const HEREDOC = /\s<<(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*$/;

// The hunter's whole Bash: the runner, exactly as the skill spelled it, with
// one of its hunt subcommands, plain or quoted arguments and at most a quoted
// heredoc for stdin. Nothing chains, pipes, substitutes or redirects, so no
// prefix that looks like the runner can carry another command. It does not
// parse the shell: it is a strict allow-list of one shape.
export function hunterBashAllowed(command, roots = pluginRoots()) {
  if (typeof command !== 'string') return false;
  const text = command.replace(/\s+$/, '');
  const newline = text.indexOf('\n');
  let line = newline === -1 ? text : text.slice(0, newline);
  if (newline !== -1) {
    // Only a heredoc may span lines: its quoted delimiter ends the first line,
    // the body holds no line equal to it, and the delimiter alone ends it all.
    const m = HEREDOC.exec(line);
    if (!m) return false;
    const lines = text.slice(newline + 1).split('\n');
    const end = lines.indexOf(m[2]);
    if (end === -1 || end !== lines.length - 1) return false;
    line = line.slice(0, m.index);
  } else if (HEREDOC.test(line)) {
    return false;
  }
  const m = /^node (["'])([^"'\n]+)\/dist\/hunt\.mjs\1 (.*)$/.exec(line);
  if (!m || !sameRoot(m[2], roots)) return false;
  const rest = m[3].trim();
  const words = rest.match(ARGS) ?? [];
  // Every character of the rest must belong to an argument or to the single
  // spaces between them.
  if (words.join(' ') !== rest.replace(/[ \t]+/g, ' ') || !words.every((w) => ARG.test(w))) return false;
  return SUBCOMMANDS.has(words[0] ?? '');
}

// The runner's root as typed: one of the plugin's roots, or another spelling
// of one (a symlinked temp folder, for example). The text is judged before any
// path is resolved, because the shell expands it before node starts and path
// resolution would hide that: `<root>/$(cmd)/..` resolves back to the root, but
// the shell runs cmd first. So a root must be absolute and literal, with
// nothing a shell expands or unescapes inside quotes ($, a backtick, a doubled
// backslash, !) and no `.` or `..` segment, which the system resolves after
// symlinks and path.resolve before them.
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/;
export function literalRoot(typed) {
  if (!ABSOLUTE.test(typed) || /[$`!\n]|\\\\/.test(typed)) return false;
  return !typed.split(/[\\/]/).some((s) => s === '.' || s === '..');
}

function sameRoot(typed, roots) {
  if (!literalRoot(typed)) return false;
  if (roots.includes(typed)) return true;
  try {
    const real = realpathSync(typed);
    return roots.some((r) => { try { return realpathSync(r) === real; } catch { return false; } });
  } catch {
    return false;
  }
}

function inRunsFolder(p, cwd) {
  const segments = segmentsOf(p, cwd);
  const i = segments.indexOf(FOLDER);
  return i !== -1 && segments[i + 1] === 'runs';
}

const SECRET_FOLDERS = new Set(['.ssh', '.aws', '.gnupg', '.git']);
const SECRET_FILES = new Set(['.npmrc', '.netrc', '.pgpass', 'session.json']);

export function secretPath(p, cwd) {
  const segments = segmentsOf(p, cwd);
  const name = segments.at(-1) ?? '';
  if (segments.some((s) => SECRET_FOLDERS.has(s))) return true;
  if (SECRET_FILES.has(name)) return true;
  if (name.startsWith('.env')) return true;
  return /\.(pem|key|p12|pfx)$/.test(name);
}

// The benchmark's answer key: its apps hold each planted bug's patch and
// description, and its comparison folder holds a reproduction of each bug and
// earlier trials' results. Claude Code's own session transcripts hold earlier
// runs' findings. A plugin run from a checkout has the benchmark on disk beside
// it. The hunter reads none of these, and searches no folder that holds them:
// a Grep or Glob rooted above one sweeps it.
const ANSWER_FOLDERS = ['/benchmark/apps/', '/benchmark/comparison/'];
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const within = (p, place) => p === place || p.startsWith(`${place}/`);

export function answerPlaces(env = process.env) {
  const transcripts = [path.join(homedir(), '.claude', 'projects')];
  if (env.CLAUDE_CONFIG_DIR) transcripts.push(path.join(path.resolve(env.CLAUDE_CONFIG_DIR), 'projects'));
  const checkouts = pluginRoots(env).map((r) => path.join(r, 'benchmark')).filter((b) => existsSync(b));
  return { read: transcripts.map(norm), search: [...transcripts, ...checkouts].map(norm) };
}

export function answerKeyPath(p, cwd, search = false, places = answerPlaces()) {
  const resolved = path.resolve(cwd, p);
  const full = norm(resolved);
  if (ANSWER_FOLDERS.some((f) => `${full}/`.includes(f)) || places.read.some((k) => within(full, k))) return true;
  if (!search) return false;
  if (full.endsWith('/benchmark') || existsSync(path.join(resolved, 'benchmark', 'apps'))) return true;
  return places.search.some((k) => within(k, full) || within(full, k));
}

// The repository the hunter tests: the nearest folder at or above cwd that
// holds .git, or cwd itself.
export function repoRoot(cwd) {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const inside = (p, root) => within(norm(p), norm(root)) || within(norm(real(p)), norm(real(root)));
const WILD = /[*?[\]{}!]/;

// A Grep or Glob by the hunter stays in the repository: its folder, and the
// literal folder an absolute pattern starts from, are inside it, and no
// pattern climbs with `..`. Searching anywhere else is how an answer key or
// another project's files would be found.
export function searchInRepo(tool, toolInput, cwd) {
  const root = repoRoot(cwd);
  const from = path.resolve(cwd, typeof toolInput.path === 'string' && toolInput.path !== '' ? toolInput.path : '.');
  if (!inside(from, root)) return false;
  const pattern = tool === 'Glob' ? toolInput.pattern : toolInput.glob;
  if (typeof pattern !== 'string' || pattern === '') return true;
  const segments = pattern.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) return false;
  const literal = [];
  for (const s of segments) {
    if (WILD.test(s)) break;
    literal.push(s);
  }
  return inside(path.resolve(from, literal.join('/') || '.'), root);
}

// Claude Code saves a tool result too long to show in the session's own
// tool-results folder and has the agent Read it there; that one folder of
// the transcripts is the hunter's own output.
function ownToolResult(p, input) {
  if (typeof input.transcript_path !== 'string' || typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return false;
  const folder = path.join(path.dirname(input.transcript_path), input.session_id, 'tool-results');
  return !p.replace(/\\/g, '/').split('/').includes('..') && within(norm(path.resolve(p)), norm(folder));
}

export function guard(input, mode) {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  if (mode === 'read') {
    if (input.agent_type !== HUNTER) return null;
    const paths = [];
    if (typeof toolInput.file_path === 'string') paths.push(toolInput.file_path);
    if (typeof toolInput.path === 'string' && toolInput.path !== '') paths.push(toolInput.path);
    const pattern = tool === 'Glob' ? toolInput.pattern : toolInput.glob;
    if (typeof pattern === 'string' && pattern !== '') paths.push(path.join(typeof toolInput.path === 'string' ? toolInput.path : '.', pattern));
    if (paths.some((p) => secretPath(p, cwd))) return deny(READ_REASON);
    const searchRoots = tool === 'Read' ? [] : [typeof toolInput.path === 'string' && toolInput.path !== '' ? toolInput.path : '.'];
    const ownResult = tool === 'Read' && paths.length === 1 && path.isAbsolute(paths[0]) && ownToolResult(paths[0], input);
    if (!ownResult && (paths.some((p) => answerKeyPath(p, cwd)) || searchRoots.some((p) => answerKeyPath(p, cwd, true)))) return deny(ANSWERS_REASON);
    if ((tool === 'Grep' || tool === 'Glob') && !searchInRepo(tool, toolInput, cwd)) return deny(SEARCH_REASON);
    // Reading one result file is fine; sweeping the runs folder with Grep or
    // Glob would scrape every run's saved session and sign-in values.
    if ((tool === 'Grep' || tool === 'Glob') && paths.some((p) => inRunsFolder(p, cwd))) return deny(SCRAPE_REASON);
    return null;
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const p = toolInput.file_path ?? toolInput.notebook_path;
    return typeof p === 'string' && inFolder(p, cwd) ? deny(WRITE_REASON) : null;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    // The hunter is held to a strict allow-list, so no spelling of the folder
    // and no secret path can slip through a shell line it writes.
    if (input.agent_type === HUNTER) return hunterBashAllowed(command) ? null : deny(HUNTER_BASH_REASON);
    return namesFolder(command) ? deny(SHELL_REASON) : null;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('guard.mjs')) {
  try {
    const out = guard(readStdin(), process.argv[2] ?? null);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  } catch {
    // A hook never fails the session.
  }
  process.exitCode = 0;
}
