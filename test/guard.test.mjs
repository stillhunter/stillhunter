import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { answerKeyPath, guard, hunterBashAllowed, namesFolder, pluginRoots, repoRoot, searchInRepo, secretPath } from '../hooks/guard.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'guard.mjs');
const cwd = '/repo';
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';

test('no agent writes in .stillhunter, whatever the spelling of the path', () => {
  for (const file_path of ['/repo/.stillhunter/specs/a.txt', '.stillhunter/runs/x/findings.json', '/repo/sub/.STILLHUNTER/tests/t.mjs']) {
    assert.ok(denied(guard({ tool_name: 'Write', tool_input: { file_path }, cwd })), file_path);
    assert.ok(denied(guard({ tool_name: 'Edit', tool_input: { file_path }, cwd, agent_type: 'stillhunter:hunter' })), file_path);
  }
  assert.equal(guard({ tool_name: 'Write', tool_input: { file_path: '/repo/src/app.ts' }, cwd }), null);
});

test('shell commands that name the folder are refused, others pass', () => {
  for (const command of ['cat .stillhunter/runs/x/findings.json', "echo '{}' > \".stillhunter/runs/a/findings.json\"", 'ls .stillh*', 'ls .STILLHUNTER', 'cat .still\\hunter/runs/x/session.json']) {
    assert.ok(namesFolder(command), command);
    assert.ok(denied(guard({ tool_name: 'Bash', tool_input: { command }, cwd })), command);
  }
  assert.equal(guard({ tool_name: 'Bash', tool_input: { command: 'git diff main -- src' }, cwd }), null);
});

test('the hunter runs only the runner, typed exactly, with at most a quoted heredoc', () => {
  const root = pluginRoots()[0];
  const runner = `node "${root}/dist/hunt.mjs"`;
  const asHunter = (command) => guard({ tool_name: 'Bash', tool_input: { command }, cwd, agent_type: 'stillhunter:hunter' });
  // The guard knows the plugin root from its own place on disk.
  assert.equal(root, path.resolve(path.dirname(GUARD), '..'));
  const allowed = [
    `${runner} start --depth quick`,
    `${runner} start --focus "the user's invite dialog" --min-severity high`,
    `node '${root}/dist/hunt.mjs' finish --run 20260101-000000-hunt-abcd`,
    `${runner} finish --run 20260101-000000-hunt-abcd <<'EOF'\n{"findings": [], "note": "$(not run) \`nor this\`"}\nEOF`,
    `${runner} probe --run 20260101-000000-hunt-abcd --name signin <<"EOF"\nexport default async function (rr) {}\nEOF\n`,
    `${runner} diff`,
    `${runner} diff --file web/items.vue`,
  ];
  for (const command of allowed) {
    assert.ok(hunterBashAllowed(command), command);
    assert.equal(asHunter(command), null, command);
  }
  const refused = [
    // What the old, unanchored allow-list let through.
    `${runner} start; cat ~/.ssh/id_ed25519`,
    `cat ~/.ssh/id_ed25519 # node ${root}/dist/hunt.mjs`,
    `cd /tmp && ${runner} start`,
    `x=1 ${runner} start`,
    'node /tmp/elsewhere/dist/hunt.mjs start',
    'git diff --no-index /etc/hosts /dev/null',
    'git diff --output=/tmp/anywhere main',
    'git diff main -- src',
    // Chains, pipes, substitution and redirection, in any spelling.
    `${runner} start && cat ~/.ssh/id_ed25519`,
    `${runner} start || cat x`,
    `${runner} start | tee /tmp/x`,
    `${runner} start > /tmp/x`,
    `${runner} start 2>&1`,
    `${runner} start $(cat /etc/hosts)`,
    `${runner} start \`id\``,
    `${runner} start --focus "$(id)"`,
    `${runner} start --focus "\`id\`"`,
    `${runner} start ~/.ssh`,
    `${runner} start *`,
    `${runner} start\ncat ~/.ssh/id_ed25519`,
    `${runner}start`,
    `${runner} keep --run 20260101-000000-hunt-abcd --probe p --check c`,
    `${runner} replay`,
    `${runner}`,
    // Heredocs that expand, or that end early with a command after them.
    `${runner} probe --run r --name p <<EOF\n$(cat ~/.ssh/id_ed25519)\nEOF`,
    `${runner} probe --run r --name p <<'EOF'\nx\nEOF\ncat ~/.ssh/id_ed25519`,
    `${runner} probe --run r --name p <<'EOF' > /tmp/out\nx\nEOF`,
    `${runner} probe --run r --name p <<'EOF'\nx`,
    `${runner} probe --run r --name p <<'EOF'`,
    'find . -name session.json -exec cat {} +',
    'd=.still; cat ${d}hunter/config.json',
    // A quoted root that the shell expands before node starts, balanced with
    // `..` so that, resolved as a path, it is the plugin root again.
    `node "${root}/$(touch /tmp/sh-pwned)/../../../dist/../dist/hunt.mjs" diff`,
    `node "${root}/$(id)/../dist/hunt.mjs" start`,
    `node "${root}/\`id\`/../dist/hunt.mjs" start`,
    `node "${root}/\${HOME}/../dist/hunt.mjs" start`,
    `node "${root}/$HOME/../dist/hunt.mjs" start`,
    `node "${root}/$(cat \${HOME}\${IFS:0:1}x)/../dist/hunt.mjs" start`,
    // Paths the system resolves differently from the text, or a shell unescapes.
    `node "${root}/../${path.basename(root)}/dist/hunt.mjs" start`,
    `node "${root}/./dist/hunt.mjs" start`,
    `node "${root}/dist/../dist/hunt.mjs" start`,
    `node "${root.replace(/[\\/]/g, '\\\\')}/dist/hunt.mjs" start`,
    `node "!!/dist/hunt.mjs" start`,
    'node "dist/hunt.mjs" start',
  ];
  for (const command of refused) {
    assert.ok(!hunterBashAllowed(command), command);
    assert.ok(denied(asHunter(command)), command);
  }
  // Another spelling of the same folder (a symlink, as /tmp is on macOS) is
  // the same runner; a different folder with a runner in it is not.
  const links = mkdtempSync(path.join(tmpdir(), 'sh-guard-link-'));
  try {
    symlinkSync(root, path.join(links, 'plugin'));
    mkdirSync(path.join(links, 'other', 'dist'), { recursive: true });
    assert.ok(hunterBashAllowed(`node "${path.join(links, 'plugin')}/dist/hunt.mjs" diff`));
    assert.ok(!hunterBashAllowed(`node "${path.join(links, 'other')}/dist/hunt.mjs" diff`));
  } finally {
    rmSync(links, { recursive: true, force: true });
  }
});

test('the hunter reads nothing under benchmark/apps, the answer key', () => {
  const asHunter = (tool_name, tool_input, at = cwd) => guard({ tool_name, tool_input, cwd: at, agent_type: 'stillhunter:hunter' }, 'read');
  for (const file_path of ['/plugin/benchmark/apps/garden-log/features/x/bugs/b1/manifest.yaml', '/plugin/Benchmark/Apps/a/request.md', '../plugin/benchmark/apps/']) {
    assert.ok(answerKeyPath(file_path, cwd), file_path);
    assert.ok(denied(asHunter('Read', { file_path })), file_path);
  }
  assert.ok(denied(asHunter('Grep', { pattern: 'symptom', path: '/plugin/benchmark' })));
  assert.ok(denied(asHunter('Glob', { pattern: 'apps/*/features/*/bugs/**', path: '/plugin/benchmark' })));
  assert.ok(denied(asHunter('Glob', { pattern: 'benchmark/apps/**/manifest.yaml', path: '/plugin' })));
  // A search from a folder that holds benchmark/apps would sweep it too.
  const plugin = mkdtempSync(path.join(tmpdir(), 'sh-guard-'));
  try {
    mkdirSync(path.join(plugin, 'benchmark', 'apps'), { recursive: true });
    assert.ok(denied(asHunter('Grep', { pattern: 'symptom', path: plugin })));
    assert.ok(denied(asHunter('Grep', { pattern: 'symptom' }, plugin)));
    assert.equal(asHunter('Grep', { pattern: 'symptom', path: path.join(plugin, 'src') }, plugin), null);
  } finally {
    rmSync(plugin, { recursive: true, force: true });
  }
  // Copies of the answer key outside benchmark/apps: the comparison's bug
  // reproductions and results, and earlier sessions' transcripts.
  for (const file_path of ['/plugin/benchmark/comparison/heldout-reference.mjs', '/plugin/benchmark/comparison/results/trials/t/findings.json', path.join(homedir(), '.claude', 'projects', '-x', 's.jsonl')]) {
    assert.ok(denied(asHunter('Read', { file_path })), file_path);
  }
  // A search rooted above a checkout that holds the benchmark sweeps it, as
  // does one rooted above the transcripts.
  const checkout = pluginRoots()[0];
  assert.ok(existsSync(path.join(checkout, 'benchmark', 'apps')), 'the tests run from a checkout');
  for (const root of [path.dirname(checkout), path.dirname(path.dirname(checkout)), homedir(), '/']) {
    assert.ok(denied(asHunter('Grep', { pattern: 'symptom', path: root })), root);
    assert.ok(denied(asHunter('Glob', { pattern: '**/bugs/*/manifest.yaml', path: root })), root);
    assert.ok(denied(asHunter('Grep', { pattern: 'symptom', glob: '**/manifest.yaml' }, root)), root);
  }
  assert.equal(asHunter('Grep', { pattern: 'symptom', path: path.join(checkout, 'src') }, checkout), null);
  assert.equal(asHunter('Glob', { pattern: '**/*.vue', path: '/repo' }), null);
  assert.equal(asHunter('Read', { file_path: '/repo/benchmark-notes.md' }), null);
  assert.equal(asHunter('Read', { file_path: '/repo/src/apps/view.vue' }), null);
  // The main session is not the hunter, and may read it.
  assert.equal(guard({ tool_name: 'Read', tool_input: { file_path: '/plugin/benchmark/apps/a/request.md' }, cwd }, 'read'), null);
});

test('the hunter searches only inside the repository it tests', (t) => {
  // The benchmark's layout: a variant repository in a temp folder, a plugin
  // copy with no benchmark folder, and the checkouts elsewhere on disk.
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'sh-guard-repo-')));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'variant');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  mkdirSync(path.join(repo, 'web', 'pages'), { recursive: true });
  const at = path.join(repo, 'web');
  const asHunter = (tool_name, tool_input) => guard({ tool_name, tool_input, cwd: at, agent_type: 'stillhunter:hunter' }, 'read');
  assert.equal(repoRoot(at), repo);
  for (const [tool, input] of [
    ['Grep', { pattern: 'symptom' }],
    ['Grep', { pattern: 'symptom', path: repo }],
    ['Grep', { pattern: 'symptom', path: '..' }],
    ['Grep', { pattern: 'x', path: '../web/pages', glob: '*.vue' }],
    ['Glob', { pattern: '**/*.vue' }],
    ['Glob', { pattern: `${repo}/web/**/*.vue` }],
    ['Glob', { pattern: 'pages/*.vue', path: at }],
  ]) {
    assert.equal(searchInRepo(tool, input, at), true, JSON.stringify(input));
    assert.equal(asHunter(tool, input), null, JSON.stringify(input));
  }
  const checkouts = path.dirname(pluginRoots()[0]);
  for (const [tool, input] of [
    ['Grep', { pattern: 'symptom', path: work }],
    ['Grep', { pattern: 'symptom', path: '../..' }],
    ['Grep', { pattern: 'symptom', path: homedir() }],
    ['Grep', { pattern: 'symptom', path: '/' }],
    ['Grep', { pattern: 'symptom', glob: '../../**/manifest.yaml' }],
    ['Glob', { pattern: '**/features/*/bugs/*', path: checkouts }],
    ['Glob', { pattern: `${checkouts}/**/features/*/bugs/*` }],
    ['Glob', { pattern: '/Users/*/workspace/**/manifest.yaml' }],
    ['Glob', { pattern: '../../**/bug.patch' }],
    ['Glob', { pattern: '**/../../../**/bug.patch' }],
    ['Glob', { pattern: 'pages/../../../x' }],
  ]) {
    assert.equal(searchInRepo(tool, input, at), false, JSON.stringify(input));
    assert.ok(denied(asHunter(tool, input)), JSON.stringify(input));
  }
  // Reading one file is not a search; the main session searches anywhere.
  assert.equal(asHunter('Read', { file_path: path.join(work, 'notes.md') }), null);
  assert.equal(guard({ tool_name: 'Grep', tool_input: { pattern: 'x', path: '/' }, cwd: repo }, 'read'), null);
});

test('the hunter may read a long tool result Claude Code saved for its own session, and no other', () => {
  const projects = path.join(homedir(), '.claude', 'projects', '-tmp-variant');
  const input = (file_path, session_id = 'abc-123') => ({ tool_name: 'Read', tool_input: { file_path }, cwd, agent_type: 'stillhunter:hunter', session_id, transcript_path: path.join(projects, 'abc-123.jsonl') });
  const own = path.join(projects, 'abc-123', 'tool-results', 'toolu_01.txt');
  assert.equal(guard(input(own), 'read'), null);
  for (const file_path of [
    path.join(projects, 'abc-123.jsonl'),
    path.join(projects, 'other-456', 'tool-results', 'toolu_01.txt'),
    path.join(projects, 'abc-123', 'subagents', 'agent-1.jsonl'),
    `${projects}/abc-123/tool-results/../../other-456/tool-results/toolu_01.txt`,
  ]) assert.ok(denied(guard(input(file_path), 'read')), file_path);
  assert.ok(denied(guard(input(own, '../other-456'), 'read')));
  assert.ok(denied(guard({ ...input(own), transcript_path: undefined }, 'read')));
});

test('the hunter cannot sweep the runs folder with Grep or Glob, but may Read one file', () => {
  const asHunter = (tool_name, tool_input) => guard({ tool_name, tool_input, cwd, agent_type: 'stillhunter:hunter' }, 'read');
  assert.ok(denied(asHunter('Grep', { pattern: 'value', path: '/repo/.stillhunter/runs' })));
  assert.ok(denied(asHunter('Glob', { pattern: '**/session.json', path: '/repo/.stillhunter/runs' })));
  assert.equal(asHunter('Read', { file_path: '/repo/.stillhunter/runs/r/probes/p.result.json' }), null);
});

test('the hunter never reads secrets or a saved session; the main session may', () => {
  for (const file_path of ['/repo/.env', '/repo/.env.local', '/home/u/.ssh/id_ed25519', '/repo/.stillhunter/runs/r/session.json', '/repo/certs/server.key', '/repo/.npmrc', '/repo/.git/config']) {
    assert.ok(secretPath(file_path, cwd), file_path);
    assert.ok(denied(guard({ tool_name: 'Read', tool_input: { file_path }, cwd, agent_type: 'stillhunter:hunter' }, 'read')), file_path);
    assert.equal(guard({ tool_name: 'Read', tool_input: { file_path }, cwd }, 'read'), null, file_path);
  }
  assert.ok(denied(guard({ tool_name: 'Glob', tool_input: { pattern: '**/.env*' }, cwd, agent_type: 'stillhunter:hunter' }, 'read')));
  assert.equal(guard({ tool_name: 'Read', tool_input: { file_path: '/repo/.stillhunter/specs/request.txt' }, cwd, agent_type: 'stillhunter:hunter' }, 'read'), null);
});

test('the hook prints a deny decision on stdout and always exits 0', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -r .stillhunter' }, cwd }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const bad = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

async function modCall(event, { agents = [], stdout = '', processError = null } = {}) {
  const { register } = await import('../hooks/register.mjs').catch(() => ({}));
  assert.equal(typeof register, 'function', 'the plugin registers an in-process tool hook');
  let handler;
  register((name, matcher, fn) => {
    assert.equal(name, 'tool.call');
    assert.ok(matcher.tool.includes(event.tool));
    handler = fn;
    return { catch() {} };
  });
  const files = new Map();
  const processes = [];
  const inputs = [];
  const agentLists = [];
  const $ = {
    plugin: { root: '/plugin' },
    agent: { list: async () => { agentLists.push(true); return agents; } },
    session: {
      cwd: async () => '/repo',
      id: async () => 'session-1',
      info: async () => ({ transcriptPath: '/transcript/session-1.jsonl' }),
    },
    fs: { write: async (file, text) => {
      if (text.length > 4 * 1024 * 1024) throw new Error('file is over the 4194304-byte limit');
      files.set(file, text);
    } },
    process: { run: async (argv, options) => {
      processes.push(argv);
      inputs.push(options?.stdin);
      if (options?.stdin?.length > 4 * 1024 * 1024) throw new Error('stdin is over the 4194304-character limit');
      if (processError) throw processError;
      return { stdout };
    } },
  };
  let nextCalls = 0;
  const result = await handler($, event, async () => { nextCalls += 1; return { result: 'ok' }; });
  return { result, files, processes, inputs, agentLists, nextCalls };
}

test('irrelevant main-session and non-hunter calls stay in process', async () => {
  for (const event of [
    { tool: 'Read', file_path: '/repo/src/app.ts' },
    { tool: 'Grep', pattern: 'value', path: '/repo/src' },
    { tool: 'Glob', pattern: '**/*.ts', path: '/repo/src' },
    { tool: 'Edit', file_path: '/repo/src/app.ts' },
    { tool: 'Write', file_path: '/repo/src/app.ts' },
    { tool: 'Bash', command: 'git diff main -- src' },
    { tool: 'PowerShell', command: 'git diff main -- src' },
  ]) {
    const r = await modCall(event);
    assert.deepEqual(r.processes, [], event.tool);
    assert.deepEqual(r.agentLists, [], event.tool);
    assert.equal(r.nextCalls, 1, event.tool);
  }
  const r = await modCall(
    { tool: 'Read', file_path: '/repo/src/app.ts', agentId: 'agent-1' },
    { agents: [{ id: 'agent-1', type: 'general-purpose' }] },
  );
  assert.deepEqual(r.processes, []);
  assert.equal(r.agentLists.length, 1);
  assert.equal(r.nextCalls, 1);
});

test('the in-process hook preserves guard metadata and maps denials', async () => {
  const reason = 'The hunter does not read secrets.';
  const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } });
  const r = await modCall(
    { tool: 'Read', file_path: '/repo/.env', tool_use_id: 'tool-1', agentId: 'hunter-1' },
    { agents: [{ id: 'hunter-1', type: 'stillhunter:hunter' }], stdout },
  );
  assert.deepEqual(r.result, { deny: reason });
  assert.equal(r.nextCalls, 0);
  assert.equal(r.processes.length, 1);
  assert.deepEqual(r.processes[0], ['node', '/plugin/hooks/guard.mjs', 'read']);
  const input = JSON.parse(r.inputs[0]);
  assert.deepEqual(input, {
    tool_name: 'Read',
    tool_input: { file_path: '/repo/.env' },
    cwd: '/repo',
    agent_type: 'stillhunter:hunter',
    session_id: 'session-1',
    transcript_path: '/transcript/session-1.jsonl',
  });
});

test('oversized tool content cannot bypass a protected write denial', async () => {
  const reason = "Agents can't write in .stillhunter/.";
  const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } });
  const r = await modCall(
    { tool: 'Write', file_path: '/repo/.stillhunter/specs/a.txt', content: 'x'.repeat(4 * 1024 * 1024 + 1) },
    { stdout },
  );
  assert.deepEqual(r.result, { deny: reason });
  assert.equal(r.nextCalls, 0);
  const input = JSON.parse(r.inputs[0]);
  assert.deepEqual(input.tool_input, { file_path: '/repo/.stillhunter/specs/a.txt' });
});

test('oversized guarded calls fail closed before the fallback transport', async () => {
  const padding = 'x'.repeat(4 * 1024 * 1024);
  for (const event of [
    { tool: 'Bash', command: `cat .stillhunter/${padding}` },
    { tool: 'PowerShell', command: `cat .stillhunter/${padding}` },
    { tool: 'Read', file_path: `/repo/${padding}`, agentId: 'hunter-1' },
  ]) {
    const r = await modCall(event, { agents: [{ id: 'hunter-1', type: 'stillhunter:hunter' }] });
    assert.equal(typeof r.result.deny, 'string', event.tool);
    assert.equal(r.nextCalls, 0, event.tool);
    assert.deepEqual(r.processes, [], event.tool);
  }
});

test('protected paths, shell spellings, and unknown agents always use the full guard', async () => {
  for (const event of [
    { tool: 'Write', file_path: '/repo/sub/.STILLHUNTER/tests/t.mjs' },
    { tool: 'NotebookEdit', notebook_path: '/repo/.stillhunter/specs/a.ipynb' },
    { tool: 'Bash', command: 'cat .still\\hunter/runs/x/session.json' },
    { tool: 'Bash', command: 'ls .st*' },
    { tool: 'PowerShell', command: 'cat stillhu~1/config.json' },
    { tool: 'Read', file_path: '/repo/src/app.ts', agentId: 'missing' },
  ]) {
    const r = await modCall(event);
    assert.equal(r.processes.length, 1, JSON.stringify(event));
    assert.equal(r.nextCalls, 1, 'an empty guard result lets the tool continue');
  }
});

test('a fallback failure keeps the hook fail-open without leaving an event file', async () => {
  const r = await modCall({ tool: 'Write', file_path: '/repo/.stillhunter/specs/a.txt' }, { processError: new Error('no node') });
  assert.deepEqual(r.result, { result: 'ok' });
  assert.equal(r.nextCalls, 1);
  assert.equal(r.files.size, 0);
});

test('the plugin loads only the in-process hook on supported Claude Code versions', () => {
  const hooks = JSON.parse(readFileSync(path.join(path.dirname(GUARD), 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.modules, ['./register.mjs']);
  assert.equal(hooks.hooks, undefined);
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(GUARD), '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.engines['claude-code'], '>=2.1.326');
});
