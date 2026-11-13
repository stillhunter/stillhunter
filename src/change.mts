// The change a hunt tests, printed whole by `start`: the diff of tracked files
// against the base plus the content of untracked files, CSS and templates
// included, so the hunter reads the same thing a reviewer would.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FOLDER, git, GIT_FLAGS, secretFile } from './common.mjs';

export const CHANGE_CAP = 60 * 1024;
const UNTRACKED_READ_LIMIT = CHANGE_CAP + 1;
// diff --file prints a file whole, up to this.
export const FILE_CAP = 1024 * 1024;
export const SECRET_BODY = '(left out: a secret file, such as .env or a key, which the hunter does not read)\n';

export interface Section {
  file: string;
  header: string;
  body: string;
}

export interface Change {
  files: string[];
  sections: Section[];
  empty: boolean;
}

function diffSections(root: string, base: string): Section[] {
  const r = spawnSync('git', [...GIT_FLAGS, 'diff', '--no-color', '--no-ext-diff', base, '--', '.', `:(exclude)${FOLDER}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const sections: Section[] = [];
  for (const chunk of r.stdout.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '))) {
    const first = chunk.split('\n', 1)[0] ?? '';
    const names = sectionNames(chunk);
    const file = names.new ?? first;
    // A section whose names cannot all be read, or that names a secret file on
    // either side (a key renamed to notes.txt), keeps its header only.
    const hidden = names.unread || names.all.some(secretFile);
    sections.push({ file, header: first, body: hidden ? SECRET_BODY : chunk.slice(first.length + 1) });
  }
  return sections;
}

// git quotes a name holding a quote, a backslash or a control character, in C
// style, even with core.quotePath off.
const ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const unquote = (s: string) => s.replace(/\\([0-7]{3}|.)/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : ESCAPES[e] ?? e));
const QUOTED = '"((?:[^"\\\\]|\\\\.)*)"';

// Every path a diff section's header lines name: the new side, the old side,
// and a rename's or copy's source and destination.
export function sectionNames(chunk: string): { new: string | null; all: string[]; unread: boolean } {
  const head = chunk.split('\n');
  const end = head.findIndex((l) => l.startsWith('@@'));
  const lines = end === -1 ? head : head.slice(0, end);
  const all: string[] = [];
  let unread = false;
  let newName: string | null = null;
  const take = (quoted: string | undefined, plain: string | undefined) => {
    const name = quoted !== undefined ? unquote(quoted) : plain;
    if (name === undefined) unread = true;
    else all.push(name);
    return name ?? null;
  };
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^diff --git .* (?:${QUOTED.replace('"(', '"b/(')}|b/(.+))$`).exec(line))) newName = take(m[1], m[2]);
    else if (line.startsWith('diff --git ')) unread = true;
    else if ((m = new RegExp(`^(?:---|\\+\\+\\+) (?:${QUOTED.replace('"(', '"[ab]/(')}|[ab]/(.*?))\t?$`).exec(line))) take(m[1], m[2]);
    else if ((m = new RegExp(`^(?:rename|copy) (?:from|to) (?:${QUOTED}|(.+))$`).exec(line))) take(m[1], m[2]);
  }
  return { new: newName, all, unread };
}

function readHead(file: string, limit: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(limit);
    const n = readSync(fd, buf, 0, limit, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function untrackedSection(root: string, file: string): Section {
  const header = `=== untracked file: ${file} ===`;
  if (secretFile(file)) return { file, header, body: SECRET_BODY };
  const full = path.join(root, file);
  let size = 0;
  try {
    // A link is shown as a link: its target may be outside the repository.
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return { file, header, body: `(symbolic link to ${readlinkSync(full)})\n` };
    size = st.size;
  } catch {
    return { file, header, body: '(could not be read)\n' };
  }
  const head = readHead(full, Math.min(size, UNTRACKED_READ_LIMIT));
  if (head.subarray(0, 8000).includes(0)) return { file, header, body: `(binary file, ${size} bytes)\n` };
  // Too large to print whole: the cap cuts it anyway, so its size is what counts.
  const body = size > UNTRACKED_READ_LIMIT ? 'x'.repeat(UNTRACKED_READ_LIMIT) : head.toString('utf8');
  return { file, header, body: body.endsWith('\n') ? body : `${body}\n` };
}

// The commit the change is measured from: where HEAD left the main branch.
export function baseRef(root: string): string {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    const mb = git(['merge-base', 'HEAD', ref], root);
    if (mb) return mb;
  }
  return 'HEAD';
}

export function collectChange(root: string, base: string): Change {
  const files = (git(['diff', '--name-status', base, '--', '.', `:(exclude)${FOLDER}`], root) ?? '').split('\n').filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], root) ?? '').split('\n').filter((f) => f && !f.startsWith(`${FOLDER}/`));
  const sections = [...diffSections(root, base), ...untracked.map((f) => untrackedSection(root, f))];
  return { files: [...files, ...untracked.map((f) => `A (untracked)\t${f}`)], sections, empty: files.length === 0 && untracked.length === 0 };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

// Fits the change under the cap by leaving out the bodies of the largest files
// first. A file's header always stays, so no changed file goes unnamed.
export function capSections(sections: Section[], cap = CHANGE_CAP): { text: string; cut: { file: string; size: number }[]; total: number } {
  const total = sections.reduce((n, s) => n + bytes(s.header) + 1 + bytes(s.body), 0);
  const kept = sections.map((s) => ({ ...s, size: bytes(s.body), cut: false }));
  let size = total;
  const byLargest = [...kept].sort((a, b) => b.size - a.size);
  for (const s of byLargest) {
    if (size <= cap) break;
    s.cut = true;
    size -= s.size;
  }
  const cut = kept.filter((s) => s.cut).map((s) => ({ file: s.file, size: s.size }));
  const text = kept.map((s) => (s.cut ? `${s.header}\n(left out: ${kb(s.size)}, see the note above)\n` : `${s.header}\n${s.body}`)).join('');
  return { text, cut, total };
}

export function changeText(change: Change, cap = CHANGE_CAP): string[] {
  if (change.sections.length === 0) return ['(no change)'];
  const { text, cut, total } = capSections(change.sections, cap);
  const note = cut.length === 0 ? [] : [
    `The change is ${kb(total)}; to fit ${kb(cap)} the bodies of the largest files were left out: ${cut.map((c) => `${c.file} (${kb(c.size)})`).join(', ')}.`,
    'Read each with the runner\'s `diff --file <file>`.',
  ];
  return [...note, text.replace(/\n$/, '')];
}

// Run folders hold a signed-in session, so they must never be committed.
export function ensureRunsIgnored(file: string): void {
  if (!existsSync(file)) {
    writeFileSync(file, '/.env\n/.env.*\n/runs/\n');
    return;
  }
  const text = readFileSync(file, 'utf8');
  const rules = text.split(/\r?\n/).map((l) => l.trim());
  if (rules.some((r) => ['/runs/', '/runs', 'runs/', 'runs', '/runs/*', 'runs/*', '/runs/**'].includes(r))) return;
  appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}/runs/\n`);
}

export function readSpecs(root: string): { file: string; text: string }[] {
  const dir = path.join(root, FOLDER, 'specs');
  if (!existsSync(dir)) return [];
  const limit = 20 * 1024;
  return readdirSync(dir).filter((f) => /\.(txt|md)$/.test(f)).sort().map((name) => {
    const raw = readFileSync(path.join(dir, name), 'utf8');
    return { file: `${FOLDER}/specs/${name}`, text: raw.length > limit ? `${raw.slice(0, limit)}\n(cut at 20 KB)` : raw };
  });
}

// What `diff` lists with no file: every changed and untracked file, with the
// size of what `diff --file` would print for it.
export function changeList(change: Change): string[] {
  if (change.sections.length === 0) return ['(no change)'];
  const status = new Map(change.files.map((l) => { const [s, ...rest] = l.split('\t'); return [rest.at(-1) ?? '', s ?? ''] as const; }));
  return change.sections.map((s) => `${(status.get(s.file) ?? '?').padEnd(13)} ${s.file} (${kb(bytes(s.header) + 1 + bytes(s.body))})`);
}

// One file's whole diff against the base, or its whole content when it is
// untracked. Only a file the change holds, inside the repository and outside
// the runner's own folder, is printed; anything else is read with the Read
// tool, which the guard watches.
export function fileDiff(root: string, base: string, file: string, cwd = process.cwd()): { ok: true; text: string } | { ok: false; message: string } {
  const outside = { ok: false as const, message: `${file} is outside the repository.` };
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
    const full = path.resolve(cwd, file);
    real = existsSync(full) ? realpathSync.native(full) : path.join(realpathSync.native(path.dirname(full)), path.basename(full));
  } catch {
    return { ok: false, message: `${file} is not in the change.` };
  }
  const rel = path.relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return outside;
  const posix = rel.split(path.sep).join('/');
  if (posix.split('/').some((seg) => seg.toLowerCase() === FOLDER)) return { ok: false, message: `${FOLDER}/ is the runner's own folder; read its files with the Read tool.` };
  if (secretFile(posix)) return { ok: false, message: `${posix} is a secret file (such as .env or a key), which the hunter does not read.` };
  const changed = (git(['diff', '--name-only', base, '--', '.', `:(exclude)${FOLDER}`], root) ?? '').split('\n').filter(Boolean);
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], root) ?? '').split('\n').filter(Boolean);
  if (changed.includes(posix)) {
    const r = spawnSync('git', [...GIT_FLAGS, 'diff', '--no-color', '--no-ext-diff', base, '--', `:(literal)${posix}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? { ok: true, text: capFile(r.stdout) } : { ok: false, message: `git diff failed for ${posix}: ${r.stderr.trim()}` };
  }
  if (untracked.includes(posix)) {
    const header = `=== untracked file: ${posix} ===`;
    const size = lstatSync(real).size;
    const head = readHead(real, Math.min(size, FILE_CAP + 1));
    if (head.subarray(0, 8000).includes(0)) return { ok: true, text: `${header}\n(binary file, ${size} bytes)\n` };
    return { ok: true, text: `${header}\n${capFile(head.toString('utf8'), size)}` };
  }
  return { ok: false, message: `${posix} is not in the change. Run diff with no --file to list the changed files, or read it with the Read tool.` };
}

// Up to FILE_CAP of a file's diff or content, with a line saying what was cut.
function capFile(text: string, size = bytes(text)): string {
  const body = size > FILE_CAP ? Buffer.from(text, 'utf8').subarray(0, FILE_CAP).toString('utf8') : text;
  const ended = body.endsWith('\n') ? body : `${body}\n`;
  return size > FILE_CAP ? `${ended}(cut at ${kb(FILE_CAP)} of ${kb(size)})\n` : ended;
}
