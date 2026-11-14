// What the hunt has covered, from every probe run: each API endpoint the app's
// pages called (method and path, ids folded), the faults applied to each, and
// each page visited with the widths it was seen at.
import type { ProbeResult } from './results.mjs';

export const NARROW_WIDTH = 375;

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(?=.*\d)[0-9a-f]{12,}$/i,
  /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9_-]{20,}$/,
];
const ASSET = /\.(m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|wasm|txt)$/i;
// The dev server's own requests (bundles, error overlays, devtools, hot reload
// and its sockets, the icon): no person's action makes them, and faulting
// them tests the dev server, not the app. Framework paths that carry the
// app's data, such as /_next/data/, /_next/image and /__nuxt_island/, count.
const DEV_PATH = /^\/(?:_nuxt\/|__nuxt_dev__\/|__nuxt_devtools__\/|_next\/static\/|_next\/webpack-hmr|__nextjs|__vite|@vite\/|@fs\/|@id\/|__webpack|sockjs-node|favicon\.ico|node_modules\/)/;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parse(url: string, target: string): URL | null {
  try {
    return new URL(url, target);
  } catch {
    return null;
  }
}

// A request the loopback-only route let through, so it reached the app (the
// target origin or another loopback port). A page call to a tracker or
// analytics host was aborted before it reached anything, so it is not coverage
// of the app and must not feed "seen but never faulted".
function reachesApp(url: string, target: string): boolean {
  const u = parse(url, target);
  return Boolean(u && (LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost')));
}

export function foldPath(pathname: string): string {
  const segments = pathname.split('/').map((s) => {
    let decoded = s;
    try { decoded = decodeURIComponent(s); } catch {}
    return ID_SEGMENT.some((p) => p.test(decoded)) ? ':id' : s;
  });
  const folded = segments.join('/');
  return folded.length > 1 && folded.endsWith('/') ? folded.slice(0, -1) : folded || '/';
}

// The folded "METHOD /path" of an API request, or null for assets and the dev
// server's own requests. Another loopback origin keeps its host and port.
export function endpointOf(method: string, url: string, target: string): string | null {
  const u = parse(url, target);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  if (ASSET.test(u.pathname) || DEV_PATH.test(u.pathname)) return null;
  const t = parse(target, target);
  const origin = t && u.host === t.host ? '' : u.host;
  return `${method.toUpperCase()} ${origin}${foldPath(u.pathname)}`;
}

export function pageOf(url: string, target: string): string | null {
  const u = parse(url, target);
  const t = parse(target, target);
  if (!u || !t || !/^https?:$/.test(u.protocol) || u.host !== t.host || DEV_PATH.test(u.pathname)) return null;
  return foldPath(u.pathname);
}

export interface Coverage {
  endpoints: { endpoint: string; faults: string[] }[];
  neverFaulted: string[];
  pages: { page: string; widths: number[] }[];
  neverNarrow: string[];
  viewports: string[];
}

// Signing in is how a hunt gets started, not what it tests: what a probe saw
// while it signed in (the sign-in page and the requests made before the page
// it landed on) is left out, unless another probe saw it too. The page it
// landed on, and everything after, counts.
export function coverage(results: ProbeResult[], target: string): Coverage {
  const endpoints = new Map<string, Set<string>>();
  const pages = new Map<string, Set<number>>();
  const viewports = new Set<string>();
  for (const r of results) {
    const flow = r.signInFlow;
    (r.requests ?? []).forEach((req, i) => {
      if ((flow && i < flow.requests) || req.via !== 'page' || !reachesApp(req.url, target)) return;
      const e = endpointOf(req.method, req.url, target);
      if (e && !endpoints.has(e)) endpoints.set(e, new Set());
    });
    for (const f of r.faults ?? []) {
      if (!reachesApp(f.url, target)) continue;
      const e = endpointOf(f.method, f.url, target);
      if (!e) continue;
      const set = endpoints.get(e) ?? new Set<string>();
      set.add(f.fault);
      endpoints.set(e, set);
    }
    for (const p of r.pages ?? []) {
      if (p.viewport && (p.visited ?? []).length) viewports.add(`${p.viewport.width}x${p.viewport.height}`);
      for (const v of p.visited ?? []) {
        const page = flow?.pages.includes(v.url) ? null : pageOf(v.url, target);
        if (!page) continue;
        const set = pages.get(page) ?? new Set<number>();
        if (typeof v.width === 'number') set.add(v.width);
        pages.set(page, set);
      }
    }
  }
  const endpointList = [...endpoints].map(([endpoint, faults]) => ({ endpoint, faults: [...faults].sort() })).sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const pageList = [...pages].map(([page, widths]) => ({ page, widths: [...widths].sort((a, b) => a - b) })).sort((a, b) => a.page.localeCompare(b.page));
  return {
    endpoints: endpointList,
    neverFaulted: endpointList.filter((e) => e.faults.length === 0).map((e) => e.endpoint),
    pages: pageList,
    neverNarrow: pageList.filter((p) => !p.widths.some((w) => w <= NARROW_WIDTH)).map((p) => p.page),
    viewports: [...viewports].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
  };
}

export function coverageLines(c: Coverage): string[] {
  return [
    `endpoints seen: ${c.endpoints.length} (${c.endpoints.length - c.neverFaulted.length} faulted); pages visited: ${c.pages.length} (${c.pages.length - c.neverNarrow.length} at ${NARROW_WIDTH} px); viewports: ${c.viewports.length ? c.viewports.join(', ') : 'none'}`,
    `seen but never faulted: ${c.neverFaulted.length ? c.neverFaulted.join(', ') : 'none'}`,
    `pages never seen at ${NARROW_WIDTH} px: ${c.neverNarrow.length ? c.neverNarrow.join(', ') : 'none'}`,
  ];
}
