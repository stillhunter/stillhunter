export const FOLDER = '.stillhunter';
export const HUNTER = 'stillhunter:hunter';

export const GUARDED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'Read', 'Grep', 'Glob'];
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// A shell line that names the folder in any spelling a shell would accept.
// Backslashes are stripped (a shell removes `\h` to `h`) as well as turned
// into '/', so `.still\hunter` and `.stillhunter/x` both read as the folder.
export function namesFolder(command) {
  const lower = command.toLowerCase();
  const stripped = lower.replace(/["'`\\]/g, '');
  const slashed = lower.replace(/\\/g, '/').replace(/["'`]/g, '');
  return stripped.includes(FOLDER) || slashed.includes(FOLDER) || /\.stillh[*?[]|\.st\*|stillhu~\d/.test(slashed);
}

export function needsGuard(event, agentType) {
  if (agentType === HUNTER) return true;
  if (READ_TOOLS.has(event.tool)) return false;
  if (event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'NotebookEdit') {
    const file = event.file_path ?? event.notebook_path;
    return typeof file === 'string' && file.toLowerCase().includes(FOLDER);
  }
  if (event.tool === 'Bash' || event.tool === 'PowerShell') {
    return typeof event.command === 'string' && namesFolder(event.command);
  }
  return true;
}
