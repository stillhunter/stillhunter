// Which hosts a probe's browser may reach. Loopback always, over http or
// https. Beyond that, only the hosts the config lists under "network", and
// only over https: "allow" for every probe, "allowForSignIn" only for the
// probe that signs in, and only until it saves its session.
//   "network": { "allow": ["api.staging.example.com"], "allowForSignIn": ["*.auth0.com"] }
// A pattern is a host name ("api.example.com") or a wildcard for its
// subdomains ("*.example.com", which does not match example.com itself).

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface HostPolicy {
  // Hosts every probe may reach over https.
  allow: string[];
  // Hosts the probe may reach over https while it signs in. Empty for a probe
  // that is not the sign-in probe, and emptied once the sign-in saves a session.
  signIn: string[];
}

export const LOOPBACK_ONLY: HostPolicy = { allow: [], signIn: [] };

export const isLoopbackHost = (host: string) => LOOPBACK.has(host) || host.endsWith('.localhost');

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// Why a pattern is not accepted, or null. A wildcard needs at least two labels
// after it, so "*.com" and "*" are refused; so is anything with a scheme, a
// port, a path or a loopback name.
export function patternProblem(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern === '') return 'each host must be a non-empty string';
  const p = pattern.toLowerCase();
  if (/[/:@?#\s]/.test(p)) return `"${pattern}" must be a host name only, with no scheme, port or path (https is assumed)`;
  const wild = p.startsWith('*.');
  const labels = (wild ? p.slice(2) : p).split('.');
  if (!labels.every((l) => LABEL.test(l))) return `"${pattern}" is not a host name`;
  if (labels.length < 2) return `"${pattern}" needs at least two labels, such as example.com`;
  if (isLoopbackHost(wild ? p.slice(2) : p)) return `"${pattern}" is a loopback host, which is always allowed`;
  return null;
}

export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

const parse = (url: unknown, base?: string): URL | null => {
  if (typeof url !== 'string') return null;
  try {
    return base === undefined ? new URL(url) : new URL(url, base);
  } catch {
    return null;
  }
};

// An http or https URL on a loopback host.
export function loopbackUrl(url: unknown, base?: string): boolean {
  const u = parse(url, base);
  return Boolean(u && (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname));
}

// A loopback http or https URL, or an https URL on a listed host. With
// signIn false only "allow" counts; with it true the sign-in hosts do too.
export function allowedUrl(url: unknown, policy: HostPolicy, { base, signIn = true }: { base?: string; signIn?: boolean } = {}): boolean {
  const u = parse(url, base);
  if (!u) return false;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname)) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return hostMatches(u.hostname, policy.allow) || (signIn && hostMatches(u.hostname, policy.signIn));
}

// A saved session keeps only the origins a later probe may restore: loopback
// and the "allow" hosts. A sign-in provider's own storage is left out; its
// cookies stay, as a browser keeps them.
export function keptOrigins<T extends { origins?: { origin?: unknown }[] }>(state: T, policy: HostPolicy): T {
  if (!Array.isArray(state.origins)) return state;
  return { ...state, origins: state.origins.filter((o) => allowedUrl(o?.origin, policy, { signIn: false })) };
}

// A CONNECT target the proxy may open: a listed host, on any port.
export function allowedTunnel(host: string, policy: HostPolicy): boolean {
  if (isLoopbackHost(host)) return false;
  return hostMatches(host, policy.allow) || hostMatches(host, policy.signIn);
}

// One line for start: what the browser can reach.
export function networkLine(allow: readonly string[], signIn: readonly string[]): string {
  if (!allow.length && !signIn.length) return 'network: loopback only';
  return [
    'network: loopback',
    ...(allow.length ? [`plus https to ${allow.join(', ')} for every probe`] : []),
    ...(signIn.length ? [`plus https to ${signIn.join(', ')} for the sign-in probe until it calls rr.saveSession()`] : []),
  ].join(', ');
}
