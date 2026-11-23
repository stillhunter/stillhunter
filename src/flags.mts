// The flags `start` takes. The hunter turns what the person asked for into
// these; the runner then holds the hunt to them.
import { SEVERITIES, type Severity } from './common.mjs';
import { loopbackUrl } from './hosts.mjs';

export const DEPTHS = { quick: 4, default: 10, deep: 25 } as const;
export type Depth = keyof typeof DEPTHS;
const MAX_MINUTES = 120;

export interface StartFlags {
  depth: Depth;
  minutes: number;
  minSeverity: Severity;
  focus: string | null;
  // The app's URL for this hunt, when the person named it.
  url: string | null;
}

export type Parsed = { ok: true; flags: StartFlags } | { ok: false; message: string };

export function parseStartFlags(args: string[]): Parsed {
  let depth: Depth = 'default';
  let minutes: number | null = null;
  let minSeverity: Severity = 'low';
  let focus: string | null = null;
  let url: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const value = args[i + 1];
    if (name !== '--depth' && name !== '--minutes' && name !== '--min-severity' && name !== '--focus' && name !== '--url') {
      return { ok: false, message: `Unknown start option ${name}. start takes --depth, --minutes, --min-severity, --focus and --url.` };
    }
    if (value === undefined) return { ok: false, message: `${name} needs a value.` };
    i += 1;
    if (name === '--depth') {
      if (!(value in DEPTHS)) return { ok: false, message: `--depth is quick, default or deep, not "${value}".` };
      depth = value as Depth;
    } else if (name === '--minutes') {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n < 1 || n > MAX_MINUTES) return { ok: false, message: `--minutes is a whole number from 1 to ${MAX_MINUTES}, not "${value}".` };
      minutes = n;
    } else if (name === '--min-severity') {
      if (!SEVERITIES.includes(value as Severity)) return { ok: false, message: `--min-severity is high, medium or low, not "${value}".` };
      minSeverity = value as Severity;
    } else if (name === '--url') {
      // The app runs on this machine: http or https on a loopback host, as a
      // dev server does. Only the origin is kept.
      if (!loopbackUrl(value)) return { ok: false, message: `--url is the app's address on this machine, such as http://localhost:5173, not "${value}".` };
      url = new URL(value).origin;
    } else {
      const text = value.trim().replace(/\s+/g, ' ');
      focus = text === '' ? null : text.slice(0, 500);
    }
  }
  return { ok: true, flags: { depth, minutes: minutes ?? DEPTHS[depth], minSeverity, focus, url } };
}

// The line that ends a report when the severity floor hid some findings.
export function hiddenLine(hidden: number, minSeverity: Severity, reportPath: string): string | null {
  if (hidden === 0) return null;
  const below = SEVERITIES.slice(SEVERITIES.indexOf(minSeverity) + 1).join('/');
  return `${hidden} ${below} finding${hidden === 1 ? '' : 's'} hidden: ${reportPath}`;
}
