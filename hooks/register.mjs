import { GUARDED_TOOLS, HUNTER, needsGuard } from './fast-path.mjs';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

async function agentType($, event, info) {
  if (!event.agentId) return event.agentType ?? event.agent_type ?? event.customAgentType ?? info?.agentType ?? info?.customAgentType ?? null;
  try {
    const agents = await $.agent.list();
    return agents.find((agent) => agent.id === event.agentId)?.type ?? HUNTER;
  } catch {
    return HUNTER;
  }
}

async function runGuard($, event, type, info) {
  const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()]);
  const transcriptPath = info.transcriptPath;
  const toolInput = Object.fromEntries(
    ['file_path', 'notebook_path', 'path', 'pattern', 'glob', 'command']
      .filter((key) => key in event)
      .map((key) => [key, event[key]]),
  );
  const input = {
    tool_name: event.tool,
    tool_input: toolInput,
    cwd,
    ...(type ? { agent_type: type } : {}),
    session_id: sessionId,
    transcript_path: transcriptPath,
  };
  const stdin = JSON.stringify(input);
  if (stdin.length > 4 * 1024 * 1024) return 'The tool call is too large for the guard to check.';
  const result = await $.process.run([
    'node', `${$.plugin.root}/hooks/guard.mjs`,
    ...(READ_TOOLS.has(event.tool) ? ['read'] : []),
  ], { stdin, timeoutMs: 5000 });
  if (!result.stdout) return null;
  const output = JSON.parse(result.stdout);
  const decision = output?.hookSpecificOutput;
  return decision?.permissionDecision === 'deny' ? decision.permissionDecisionReason : null;
}

export function register(on) {
  on('tool.call', { tool: GUARDED_TOOLS }, async ($, event, next) => {
    try {
      let info = event.agentId ? null : await $.session.info();
      const type = await agentType($, event, info);
      if (!needsGuard(event, type)) return next(event);
      info ??= await $.session.info();
      const reason = await runGuard($, event, type, info);
      if (reason) return { deny: reason };
    } catch {
      // The command hook also allowed the call when its guard could not run.
    }
    return next(event);
  }).catch(async ($, event, next) => next(event));
}
