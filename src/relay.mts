// The browser relay. A probe's child process can reach Playwright's raw
// protocol (`browser._channel`, `_connection`) and so ask the browser server
// for anything the protocol offers: a CDP session, a context with its own
// proxy, a file: page, a browser launched without the closed proxy, a fetch
// made from the host's own process. None of that can be stopped inside the
// child, so the child never sees the browser server's endpoint: it connects
// here, and every message it sends is checked before it reaches the server.
// The protocol is JSON, one {id, guid, method, params} message per frame; the
// type of each guid comes from the server's own __create__ messages. Methods
// are allowed by name per type, a few only with checked parameters, and
// anything else is answered with an error and never forwarded.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';

export const REFUSED = 'refused by the browser relay';
const MAX_PAYLOAD = 256 * 1024 * 1024;
const MAX_KEPT = 20;

type Params = Record<string, unknown>;
export interface ClientMessage { id?: unknown; guid?: unknown; method?: unknown; params?: unknown }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// An http or https URL on a loopback host. A relative URL resolves against the
// target, as the server resolves it against the context's baseURL, which is
// itself held to a loopback http or https URL below.
export function allowedUrl(url: unknown, target: string): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url, target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

// Context options that change only what happens inside the browser. Left out
// on purpose: proxy (its own way out), recordVideo (the server writes files on
// the host) and clientCertificates.
const CONTEXT_OPTIONS = new Set([
  'noDefaultViewport', 'viewport', 'screen', 'ignoreHTTPSErrors', 'javaScriptEnabled', 'bypassCSP', 'userAgent', 'locale', 'timezoneId',
  'geolocation', 'permissions', 'extraHTTPHeaders', 'offline', 'httpCredentials', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'colorScheme',
  'reducedMotion', 'forcedColors', 'acceptDownloads', 'contrast', 'baseURL', 'strictSelectors', 'serviceWorkers', 'selectorEngines',
  'testIdAttributeName', 'storageState',
]);

// Permissions that reach nothing on the host: no clipboard, camera or microphone.
const PERMISSIONS = new Set([
  'geolocation', 'notifications', 'background-sync', 'background-fetch', 'payment-handler', 'accelerometer', 'gyroscope', 'magnetometer',
  'ambient-light-sensor', 'accessibility-events', 'storage-access', 'screen-wake-lock',
]);

// Files for an input or a drop come from the probe as bytes, never as paths
// or streams the server would read from the host's disk.
const FILE_KEYS = new Set(['selector', 'strict', 'payloads', 'position', 'data', 'timeout']);

type Check = (params: Params, target: string) => string | null;

const keysOutside = (params: Params, allowed: Set<string>) => Object.keys(params).filter((k) => params[k] !== undefined && !allowed.has(k));

// The server opens a page at each origin a storage state lists to restore
// its storage, so every origin is held to the same rule as a navigation.
const storageState = (state: unknown, target: string): string | null => {
  if (state === undefined || state === null) return null;
  const origins = typeof state === 'object' ? (state as { origins?: unknown }).origins : undefined;
  if (origins === undefined) return null;
  if (!Array.isArray(origins)) return 'a storage state\'s origins must be a list';
  const bad = origins.map((o) => (o && typeof o === 'object' ? (o as { origin?: unknown }).origin : o)).filter((o) => !allowedUrl(o, target));
  return bad.length ? `a storage state may hold only loopback http or https origins, not ${bad.map((o) => String(o).slice(0, 120)).join(', ')}` : null;
};

const contextOptions: Check = (p, target) => {
  const extra = keysOutside(p, CONTEXT_OPTIONS);
  if (extra.length) return `a context may not set ${extra.join(', ')}; pages come from rr.newPage()`;
  if (!allowedUrl(p.baseURL, target)) return 'a context needs a loopback http or https baseURL';
  return storageState(p.storageState, target) ?? permissions(p, target);
};
const permissions: Check = (p) => {
  const list = Array.isArray(p.permissions) ? p.permissions : [];
  const bad = list.filter((x) => !PERMISSIONS.has(String(x)));
  return bad.length ? `the permission ${bad.join(', ')} reaches the host` : null;
};
const files: Check = (p) => {
  const extra = keysOutside(p, FILE_KEYS);
  return extra.length ? `files must be given as bytes, not as ${extra.join(', ')} on the host` : null;
};
const url = (key: string, optional: boolean): Check => (p, target) => {
  if (optional && p[key] === undefined) return null;
  return allowedUrl(p[key], target) ? null : `${String(p[key]).slice(0, 120)} is not an http or https URL on a loopback host`;
};
const fetchCheck: Check = (p, target) => url('url', false)(p, target) ?? (p.maxRedirects === 0 ? null : 'a request from the host follows no redirects: use rr.request');

const ALL = null;
type Rules = Record<string, Check | typeof ALL>;
const names = (list: string, rules: Rules = {}): Rules => ({ ...Object.fromEntries(list.trim().split(/\s+/).map((m) => [m, ALL])), ...rules });

const JS_HANDLE = 'dispose evaluateExpression evaluateExpressionHandle getProperty getPropertyList jsonValue';

// Everything the child may ask of each type, from playwright-core 1.64.1's
// protocol. A type or method missing here is refused: the browser type and
// its launch and connect calls, CDP sessions, tracing, local utils, Android,
// Electron, the debug controller, the recorder, temp files on the host and
// saving an artifact to a host path.
export const ALLOWED: Record<string, Rules> = {
  Root: names('initialize'),
  Browser: names('close', { newContext: contextOptions }),
  BrowserContext: names(`addCookies addInitScript clearCookies clearPermissions clockFastForward clockInstall clockPauseAt clockResume
    clockRunFor clockSetFixedTime clockSetSystemTime close cookies exposeBinding newPage registerSelectorEngine setExtraHTTPHeaders
    setGeolocation setHTTPCredentials setNetworkInterceptionPatterns setOffline setTestIdAttributeName
    setWebSocketInterceptionPatterns storageState updateSubscription`, { grantPermissions: permissions, setStorageState: (p, target) => storageState(p.storageState, target) }),
  Page: names(`addInitScript bringToFront clearConsoleMessages clearPageErrors close consoleMessages emulateMedia expectScreenshot
    exposeBinding goBack goForward keyboardDown keyboardInsertText keyboardPress keyboardType keyboardUp mouseClick mouseDown mouseMove
    mouseUp mouseWheel pageErrors pdf registerLocatorHandler reload requestGC requests resolveLocatorHandlerNoReply runBeforeUnload
    screenshot setExtraHTTPHeaders setNetworkInterceptionPatterns setViewportSize setWebSocketInterceptionPatterns startCSSCoverage
    startJSCoverage stopCSSCoverage stopJSCoverage touchscreenTap unregisterLocatorHandler updateSubscription webStorageClear
    webStorageGetItem webStorageItems webStorageRemoveItem webStorageSetItem`),
  Frame: names(`ariaSnapshot ariaSnapshotJSON blur check click content dblclick dispatchEvent dragAndDrop
    evalOnSelector evalOnSelectorAll evaluateExpression evaluateExpressionHandle expect fill focus frameElement getAttribute hover innerHTML
    innerText inputValue isChecked isDisabled isEditable isEnabled isHidden isVisible press queryCount querySelector querySelectorAll
    resolveSelector selectOption setContent tap textContent title type uncheck waitForFunction waitForSelector waitForTimeout`,
  { goto: url('url', false), addScriptTag: url('url', true), addStyleTag: url('url', true), setInputFiles: files, drop: files }),
  ElementHandle: names(`${JS_HANDLE} boundingBox check click contentFrame dblclick dispatchEvent evalOnSelector evalOnSelectorAll fill
    focus getAttribute hover innerHTML innerText inputValue isChecked isDisabled isEditable isEnabled isHidden isVisible ownerFrame press
    querySelector querySelectorAll screenshot scrollIntoViewIfNeeded selectOption selectText tap textContent type uncheck
    waitForElementState waitForSelector`, { setInputFiles: files }),
  JSHandle: names(JS_HANDLE),
  Worker: names('evaluateExpression evaluateExpressionHandle updateSubscription'),
  Request: names('rawRequestHeaders response'),
  Response: names('body httpVersion rawResponseHeaders securityDetails serverAddr sizes'),
  Route: names('abort fulfill', { continue: url('url', true), redirectNavigationRequest: url('url', false) }),
  WebSocketRoute: names('closePage closeServer connect ensureOpened sendToPage sendToServer'),
  APIRequestContext: names('addCookies clearCookies cookies dispose disposeAPIResponse fetchLog fetchResponseBody storageState', { fetch: fetchCheck }),
  Dialog: names('accept dismiss'),
  BindingCall: names('reject resolve'),
  Artifact: names('cancel delete failure saveAsStream stream'),
  Stream: names('close read'),
  Disposable: names('dispose'),
};

const CONNECTION_METHODS = new Set(['__waitInfo__', '__abort__']);
const unanswered = (method: string) => method.endsWith('NoReply') || CONNECTION_METHODS.has(method);

// Why a message from the child is refused, or null when it may go on.
export function refusal(type: string | undefined, message: ClientMessage, target: string): string | null {
  const method = String(message.method);
  if (type === undefined) return `${method} on an object the server never created`;
  // The connection's own bookkeeping, sent for any object: what a pending call
  // waits for, and cancelling one. Neither is answered.
  if (CONNECTION_METHODS.has(method)) return null;
  const rules = Object.hasOwn(ALLOWED, type) ? ALLOWED[type]! : null;
  if (!rules || !Object.hasOwn(rules, method)) return `${type}.${method} is not available to a probe`;
  const check = rules[method];
  const params = message.params && typeof message.params === 'object' ? (message.params as Params) : {};
  const why = check ? check(params, target) : null;
  return why ? `${type}.${method}: ${why}` : null;
}

interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'open' | 'close', listener: () => void): void;
  on(event: 'error', listener: (e: Error) => void): void;
}
interface SocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (ws: Socket) => void): void;
  close(): void;
}
const require = createRequire(import.meta.url);
const { ws: WebSocket, wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle') as {
  ws: { new (url: string, options: object): Socket; OPEN: number };
  wsServer: new (options: object) => SocketServer;
};

export interface Relay {
  endpoint: string;
  refused: string[];
  close(): Promise<void>;
}

// Serves a WebSocket on loopback, at a path only the child is told, and relays
// each connection to the browser server's endpoint, checking every message.
export async function startRelay(upstream: string, target: string): Promise<Relay> {
  const path = `/${randomBytes(16).toString('hex')}`;
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  const http = createServer((_, res) => { res.statusCode = 404; res.end(); });

  const relay = (client: Socket, req: IncomingMessage) => {
    // Only the user agent goes on: the server checks the client's version in
    // it. Proxy and launch-option headers never do.
    const ua = req.headers['user-agent'];
    const server = new WebSocket(upstream, { headers: typeof ua === 'string' ? { 'user-agent': ua } : {}, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
    sockets.add(client).add(server);
    const types = new Map<string, string>([['', 'Root']]);
    const queue: string[] = [];
    const end = () => { client.terminate(); server.terminate(); };
    server.on('open', () => { for (const m of queue.splice(0)) server.send(m); });
    server.on('message', (data) => {
      const text = data.toString('utf8');
      if (text.includes('__create__') || text.includes('__dispose__')) {
        try {
          const m = JSON.parse(text) as { method?: string; guid?: string; params?: { type?: string; guid?: string } };
          if (m.method === '__create__' && typeof m.params?.guid === 'string' && typeof m.params.type === 'string') types.set(m.params.guid, m.params.type);
          if (m.method === '__dispose__' && typeof m.guid === 'string') types.delete(m.guid);
        } catch {}
      }
      client.send(text);
    });
    client.on('message', (data) => {
      const text = data.toString('utf8');
      let m: ClientMessage;
      try {
        m = JSON.parse(text) as ClientMessage;
      } catch {
        return end();
      }
      if (!m || typeof m !== 'object' || typeof m.guid !== 'string' || typeof m.method !== 'string') return end();
      const why = refusal(types.get(m.guid), m, target);
      if (!why) {
        if (server.readyState === WebSocket.OPEN) server.send(text);
        else queue.push(text);
        return;
      }
      if (refused.length < MAX_KEPT) refused.push(why);
      if ((typeof m.id === 'number' || typeof m.id === 'string') && !unanswered(m.method)) {
        client.send(JSON.stringify({ id: m.id, error: { error: { name: 'Error', message: `${why} (${REFUSED})`, stack: '' } } }));
      }
    });
    server.on('close', end);
    client.on('close', end);
    server.on('error', end);
    client.on('error', end);
  };

  http.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== path) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => relay(ws, req));
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = http.address() as { port: number };
  return {
    endpoint: `ws://127.0.0.1:${port}${path}`,
    refused,
    close: async () => {
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
