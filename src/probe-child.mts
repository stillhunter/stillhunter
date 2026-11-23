// Runs one probe inside the contained child process. The host starts this file
// under Node's permission model and sends the job over IPC; the child connects
// to the browser the host launched, through the host's relay, and gives the
// probe `rr`: guarded pages, faults on requests, an observation of what the
// page shows, screenshots and named expectations. The result goes back to the
// host over IPC.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Locator, Page, Request, Route } from 'playwright-core';
import { allowedUrl } from './common.mjs';
import { layoutCandidates } from './layout.mjs';
import type { Check, FaultRecord, PageRecord, ProbeResult, RequestRecord, SignInFlow } from './results.mjs';

export interface ChildJob {
  nonce: string;
  wsEndpoint: string;
  probe: string;
  probeFile: string;
  target: string;
  allowedHosts: readonly string[];
  ignoreHTTPSErrors?: boolean;
  sessionFile: string;
  shotsDir: string;
  timeoutMs: number;
  slowMo: number;
  keepOpenMs: number;
}

type FaultSpec = number | 'malformed' | 'empty' | 'empty-list' | 'empty-object' | 'hang' | 'reset' | { delay: number } | { status: number; body?: string } | { json: unknown };
interface PageOptions { width?: number; height?: number; timezoneId?: string; locale?: string }

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const SHOT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function allowedRequest(url: string, target: string, allowedHosts: readonly string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  } catch {
    return false;
  }
  return allowedUrl(url, target, allowedHosts);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isApi = (req: Request) => ['xhr', 'fetch'].includes(req.resourceType());

const NOT_IN_A_PROBE = 'is not available in a probe: every page and context comes from rr.newPage(), which keeps the authorized-hosts-only route, the watchers and the session';

// The probe gets Playwright objects, and through them the browser and its
// type. Their constructors are shared, so the methods that would make an
// unguarded context or another browser are replaced on the prototypes; the
// factory alone may call the originals.
function lockDown(browser: Browser): (options: Parameters<Browser['newContext']>[0]) => Promise<BrowserContext> {
  const proto = Object.getPrototypeOf(browser) as Record<string, unknown>;
  const realNewContext = proto.newContext as Browser['newContext'];
  let allowed = false;
  for (const method of ['newContext', 'newPage', 'newBrowserCDPSession', '_newContextForReuse', '_innerNewContext']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      if (!allowed) throw new Error(`browser.${method}() ${NOT_IN_A_PROBE}`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  const typeProto = Object.getPrototypeOf(browser.browserType()) as Record<string, unknown>;
  for (const method of ['launch', 'launchPersistentContext', 'launchServer', 'connect', 'connectOverCDP']) {
    if (typeof typeProto[method] === 'function') typeProto[method] = () => { throw new Error(`browserType.${method}() ${NOT_IN_A_PROBE}`); };
  }
  return (options) => {
    allowed = true;
    try {
      return realNewContext.call(browser, options);
    } finally {
      allowed = false;
    }
  };
}

async function run(job: ChildJob): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connect(job.wsEndpoint, { slowMo: job.slowMo || undefined, timeout: 30_000 });
  const guardedContext = lockDown(browser);

  const checks: Check[] = [];
  const notes: { label: string; value: unknown }[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requests: RequestRecord[] = [];
  const records = new Map<Request, RequestRecord>();
  const faulted = new WeakMap<Request, string>();
  const faults: FaultRecord[] = [];
  const blocked: string[] = [];
  const shots: string[] = [];
  const pageIds = new Map<Page, PageRecord>();
  const contexts: BrowserContext[] = [];
  const activeFaults: { pattern: string | RegExp; handler: (route: Route) => Promise<void> }[] = [];
  let offline = false;
  let savedSession = false;
  let signInFlow: SignInFlow | null = null;
  // Where in `requests` each page's latest navigation began, so a sign-in can
  // be told apart from the page it lands on.
  const navigatedAt = new Map<Page, number>();

  // The page the probe last worked with is the one `final` observes.
  let lastPage: Page | null = null;
  const visit = (p: Page) => {
    const rec = pageIds.get(p);
    if (!rec) return;
    if (p.url() && p.url() !== 'about:blank') lastPage = p;
    const vp = p.viewportSize();
    rec.viewport = vp;
    const url = p.url();
    if (!url || url === 'about:blank') return;
    if (!rec.visited.some((v) => v.url === url && v.width === (vp?.width ?? null))) rec.visited.push({ url, width: vp?.width ?? null });
  };
  const watch = (p: Page) => {
    if (pageIds.has(p)) return;
    pageIds.set(p, { id: pageIds.size + 1, viewport: p.viewportSize(), visited: [] });
    const id = pageIds.get(p)!.id;
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(clip(m.text(), 300)); });
    p.on('pageerror', (e) => pageErrors.push(clip(String(e?.message ?? e), 300)));
    p.on('framenavigated', (f) => {
      if (f !== p.mainFrame()) return;
      navigatedAt.set(p, requests.length);
      visit(p);
    });
    p.on('request', (req) => {
      if (!isApi(req)) return;
      const rec: RequestRecord = { method: req.method(), url: req.url(), status: null, fault: null, via: 'page', page: id };
      records.set(req, rec);
      requests.push(rec);
    });
    p.on('response', (r) => {
      const rec = records.get(r.request());
      if (rec) { rec.status = r.status(); rec.fault = faulted.get(r.request()) ?? null; }
    });
    p.on('requestfailed', (req) => {
      const rec = records.get(req);
      if (rec) { rec.fault = faulted.get(req) ?? null; rec.failure = req.failure()?.errorText ?? 'failed'; }
    });
  };
  const authorizedOnly = (route: Route) => {
    if (allowedRequest(route.request().url(), job.target, job.allowedHosts)) return route.fallback();
    if (blocked.length < 20) blocked.push(clip(route.request().url(), 200));
    return route.abort('blockedbyclient');
  };

  // The one place pages and contexts come from.
  const makeContext = async (opts: PageOptions) => {
    const ctx = await guardedContext({
      baseURL: job.target,
      ignoreHTTPSErrors: job.ignoreHTTPSErrors ?? false,
      viewport: { width: opts.width ?? DEFAULT_VIEWPORT.width, height: opts.height ?? DEFAULT_VIEWPORT.height },
      ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
      ...(existsSync(job.sessionFile) ? { storageState: job.sessionFile } : {}),
    });
    ctx.on('page', watch);
    await ctx.route('**/*', authorizedOnly);
    for (const f of activeFaults) await ctx.route(f.pattern, f.handler);
    if (offline) await ctx.setOffline(true);
    contexts.push(ctx);
    return ctx;
  };
  const mainContext = await makeContext({});
  const page = await mainContext.newPage();
  watch(page);
  // A context- or page-level CDP session is another way to reach an unguarded
  // target (Target.createTarget in the default context, a file: URL), so it is
  // refused like the browser-level one. The factory never needs it.
  for (const obj of [mainContext as object, page as object]) {
    const proto = Object.getPrototypeOf(obj) as Record<string, unknown>;
    if (typeof proto.newCDPSession === 'function') proto.newCDPSession = () => { throw new Error(`newCDPSession() ${NOT_IN_A_PROBE}`); };
  }

  const observe = async (p: Page = page) => {
    visit(p);
    const view = await p.evaluate(() => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const name = (el: Element) => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ');
      const lines = (document.body?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
      return {
        url: location.pathname + location.search,
        title: document.title,
        headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((h) => (h as HTMLElement).innerText.trim()),
        alerts: [...document.querySelectorAll('[role=alert],[role=status],[aria-live]')].filter(visible).map((a) => (a as HTMLElement).innerText.trim()).filter(Boolean),
        text: lines.slice(0, 150),
        disabled: [...document.querySelectorAll('button:disabled,input:disabled,select:disabled,textarea:disabled,[aria-disabled=true]')]
          .filter(visible).map((el) => ({ name: name(el), reason: el.getAttribute('title') || el.getAttribute('aria-describedby') || null })),
        fields: [...document.querySelectorAll('input,textarea,select')].filter(visible).map((el) => ({ label: (el as HTMLInputElement).labels?.[0]?.innerText?.trim() ?? el.getAttribute('name'), value: (el as HTMLInputElement).value })),
        overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const layout = await p.evaluate(layoutCandidates, 10).catch((e: Error) => [{ kind: 'error', selector: '', text: '', detail: clip(String(e.message), 200) }]);
    return {
      ...view,
      viewport: p.viewportSize(),
      text: view.text.map((l: string) => clip(l, 200)),
      layout,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      requests: requests.slice(-30).map(({ method, url, status, fault }) => ({ method, url, status, fault })),
    };
  };

  const rr = {
    web: job.target,
    page,
    context: mainContext,
    // A page in the main context, or in a fresh guarded context when it needs
    // its own time zone or locale.
    async newPage(opts: PageOptions = {}) {
      const viewport = { width: opts.width ?? DEFAULT_VIEWPORT.width, height: opts.height ?? DEFAULT_VIEWPORT.height };
      if (opts.timezoneId || opts.locale) {
        const ctx = await makeContext(opts);
        const p = await ctx.newPage();
        watch(p);
        return p;
      }
      const p = await mainContext.newPage();
      watch(p);
      await p.setViewportSize(viewport);
      pageIds.get(p)!.viewport = viewport;
      return p;
    },
    // Load settled: the load event, a quiet network (at most 5 s), and a Nuxt or
    // other client app mounted, when the page has one.
    async ready(p: Page = page) {
      await p.waitForLoadState('load').catch(() => {});
      await p.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await p.waitForFunction(() => {
        const nuxt = document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null;
        return nuxt ? Boolean(nuxt.__vue_app__) : true;
      }, undefined, { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(300);
    },
    async goto(url: string, p: Page = page) {
      await p.goto(url);
      await rr.ready(p);
      return p;
    },
    async saveSession() {
      await mainContext.storageState({ path: job.sessionFile });
      // The first save ends the sign-in: the pages before the one it landed
      // on, and the requests made before that page, are how it signed in.
      if (!savedSession) {
        const landed = lastPage ?? page;
        const landing = landed.url();
        const seen = [...pageIds.values()].flatMap((r) => r.visited.map((v) => v.url));
        signInFlow = { requests: navigatedAt.get(landed) ?? requests.length, pages: [...new Set(seen)].filter((u) => u !== landing) };
      }
      savedSession = true;
    },
    // Makes matching requests fail, hang, slow down or answer with other data,
    // in every context the probe has or makes. `times` limits how many requests
    // it hits (default: all), `method` filters.
    async fault(pattern: string | RegExp, spec: FaultSpec, opts: { method?: string; times?: number } = {}) {
      let hits = 0;
      const label = typeof spec === 'object' ? JSON.stringify(spec) : String(spec);
      const handler = async (route: Route) => {
        const req = route.request();
        if (opts.method && req.method() !== opts.method.toUpperCase()) return route.fallback();
        if (opts.times !== undefined && hits >= opts.times) return route.fallback();
        hits += 1;
        faulted.set(req, label);
        faults.push({ method: req.method(), url: req.url(), fault: label });
        if (spec === 'hang') return; // never answered
        if (spec === 'reset') return route.abort('connectionreset');
        if (typeof spec === 'number') return route.fulfill({ status: spec, contentType: 'application/json', body: JSON.stringify({ detail: `Injected ${spec}` }) });
        if (spec === 'malformed') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"oops": [1, 2' });
        if (spec === 'empty') return route.fulfill({ status: 200, contentType: 'application/json', body: '' });
        if (spec === 'empty-list') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        if (spec === 'empty-object') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        if ('delay' in spec) { await new Promise((r) => setTimeout(r, spec.delay)); return route.fallback(); }
        if ('json' in spec) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(spec.json) });
        return route.fulfill({ status: spec.status, contentType: 'application/json', body: spec.body ?? JSON.stringify({ detail: `Injected ${spec.status}` }) });
      };
      const entry = { pattern, handler };
      activeFaults.push(entry);
      for (const ctx of contexts) await ctx.route(pattern, handler);
      return {
        hits: () => hits,
        clear: async () => {
          activeFaults.splice(activeFaults.indexOf(entry), 1);
          for (const ctx of contexts) await ctx.unroute(pattern, handler).catch(() => {});
        },
      };
    },
    async offline(on: boolean) {
      offline = on;
      for (const ctx of contexts) await ctx.setOffline(on);
    },
    // What a person sees: headings, alerts, visible text lines, disabled
    // controls (with any reason given), fields, layout candidates and sideways
    // overflow, plus the errors and API requests seen so far.
    observe,
    async screenshot(name: string, opts: { page?: Page; fullPage?: boolean; locator?: Locator | string } = {}) {
      const base = name.replace(/\.png$/i, '');
      if (!SHOT_NAME.test(base)) throw new Error('rr.screenshot needs a name of letters, digits, dashes and underscores');
      const file = path.join(job.shotsDir, `${base}.png`);
      const p = opts.page ?? page;
      visit(p);
      if (opts.locator) {
        const locator = typeof opts.locator === 'string' ? p.locator(opts.locator) : opts.locator;
        await locator.screenshot({ path: file });
      } else {
        await p.screenshot({ path: file, fullPage: Boolean(opts.fullPage) });
      }
      if (!shots.includes(file)) shots.push(file);
      return file;
    },
    // A named expectation. A finding names the probe and the expectation that
    // fails; confirmation re-runs the probe and needs the same one to fail.
    expect(name: string, ok: unknown, detail: unknown = '') {
      checks.push({ name: String(name), pass: Boolean(ok), detail: clip(typeof detail === 'string' ? detail : JSON.stringify(detail) ?? '', 600) });
      return Boolean(ok);
    },
    note(label: string, value: unknown) {
      notes.push({ label: String(label), value: typeof value === 'string' ? clip(value, 2000) : value });
    },
    // A request with the browser's cookies; a path is relative to the web
    // origin. A body is sent as JSON unless `raw` is set, when the string goes
    // as it is (as JSON unless a content-type header says otherwise).
    async request(method: string, url: string, body?: unknown, opts: { raw?: boolean; headers?: Record<string, string> } = {}) {
      const absolute = new URL(url, job.target).toString();
      if (!allowedUrl(absolute, job.target, job.allowedHosts)) throw new Error('rr.request reaches loopback and exact allowlisted HTTPS hosts only');
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const hasType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      // A Buffer, because Playwright re-encodes a string that is not valid JSON.
      let data: Buffer | undefined;
      if (body !== undefined) {
        if (opts.raw && typeof body !== 'string') throw new Error('rr.request with raw: true needs the body as a string');
        data = Buffer.from(opts.raw ? (body as string) : JSON.stringify(body), 'utf8');
        if (!hasType) headers['content-type'] = 'application/json';
      }
      const rec: RequestRecord = { method: method.toUpperCase(), url: absolute, status: null, fault: null, via: 'rr.request' };
      requests.push(rec);
      try {
        const res = await mainContext.request.fetch(absolute, { method, headers, ...(data === undefined ? {} : { data }), failOnStatusCode: false, maxRedirects: 0 });
        rec.status = res.status();
        const text = await res.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status(), headers: res.headers(), json, text: clip(text, 4000) };
      } catch (e) {
        rec.failure = clip(String((e as Error).message), 200);
        throw e;
      }
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };

  let error: string | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  // A stray rejected promise or a throw from a detached callback (an un-awaited
  // click that times out, a route handler that throws) would otherwise kill the
  // child and lose every check, note and request already recorded. Catch it,
  // record it once as the probe's error, and let the probe run on so its
  // partial result still reaches the host.
  const onStray = (kind: string) => (e: unknown) => {
    error ??= clip(`${kind}: ${String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`, 800);
  };
  process.on('unhandledRejection', onStray('unhandled rejection'));
  process.on('uncaughtException', onStray('uncaught exception'));
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => { timedOut = true; error = `probe timed out after ${Math.round(job.timeoutMs / 1000)} s`; resolve(); }, job.timeoutMs);
  });
  // Node's permission model has no rule for signals, so a probe could end the
  // runner, the app or any process the user owns. Take the means away, for
  // good, before the probe's code loads; the child itself never signals.
  for (const name of ['kill', '_kill']) {
    Object.defineProperty(process, name, {
      value: () => { throw new Error('A probe may not signal other processes.'); },
      writable: false,
      configurable: false,
    });
  }
  const body = (async () => {
    const mod = await import(pathToFileURL(job.probeFile).href);
    if (typeof mod.default !== 'function') throw new Error('a probe must `export default async function (rr) { ... }`');
    await mod.default(rr);
  })().catch((e) => {
    error ??= clip(String((e as Error)?.stack ?? e).split('\n').slice(0, 4).join(' | '), 800);
  });
  await Promise.race([body, deadline]);
  clearTimeout(timer);

  let final: unknown = null;
  try {
    const current: Page = lastPage && !(lastPage as Page).isClosed() ? lastPage : page;
    final = await Promise.race([observe(current), new Promise((_, reject) => setTimeout(() => reject(new Error('observe timed out')), 5000))]);
  } catch {}
  for (const [req, rec] of records) rec.fault ??= faulted.get(req) ?? null;
  for (const p of pageIds.keys()) if (!p.isClosed()) visit(p);
  if (job.keepOpenMs > 0) await new Promise((r) => setTimeout(r, job.keepOpenMs));
  return {
    probe: job.probe,
    startedAt,
    finishedAt: Date.now(),
    checks,
    notes,
    error,
    hostError: timedOut ? 'timeout' : null,
    blocked,
    savedSession,
    ...(signInFlow ? { signInFlow } : {}),
    shots,
    requests,
    faults,
    pages: [...pageIds.values()],
    final,
    output: '',
  };
}

// A failure before the probe ran: its message, the path the permission model
// refused when that is the cause (Node's message leaves it out), and where.
export function fatalText(e: unknown): string {
  const err = e as (Error & { code?: string; resource?: string }) | undefined;
  const refused = err?.resource ? `(${err.code ?? 'refused'}: ${err.resource})` : '';
  const where = String(err?.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim()).join(' | ');
  return [String(err?.message ?? e), refused, where].filter(Boolean).join(' ');
}

process.once('message', (job: ChildJob) => {
  run(job).then(
    (result) => process.send?.({ nonce: job.nonce, result }, () => process.exit(0)),
    (e) => process.send?.({ nonce: job.nonce, fatal: clip(fatalText(e), 800) }, () => process.exit(0)),
  );
});
