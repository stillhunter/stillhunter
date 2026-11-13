// The browser relay's policy, message by message: what a probe's raw protocol
// calls may ask of the browser server. The containment tests drive the same
// calls through a real browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedUrl, refusal } from '../dist/relay.mjs';

const target = 'http://127.0.0.1:3000';
const ask = (type, method, params = {}) => refusal(type, { id: 'a@1', guid: 'x', method, params }, target);
const allowed = (type, method, params) => assert.equal(ask(type, method, params), null, `${type}.${method} ${JSON.stringify(params)}`);
const refused = (type, method, params, pattern = /./) => assert.match(String(ask(type, method, params)), pattern, `${type}.${method} ${JSON.stringify(params)}`);

test('only http and https URLs on loopback hosts are allowed, relative ones against the target', () => {
  for (const u of ['/login', 'login?x=1', 'http://localhost:5173/a', 'https://127.0.0.1/', 'http://[::1]:8000/', 'http://app.localhost/']) assert.ok(allowedUrl(u, target), u);
  for (const u of ['file:///etc/hosts', ' file:///etc/hosts', 'data:text/html,hi', 'about:blank', 'chrome://version', 'view-source:http://127.0.0.1/', 'ws://127.0.0.1/', 'http://192.0.2.1/', '//example.com/x', '\\\\example.com\\x', 'http://127.0.0.1.example.com/', 'http://localhost.example.com/', 42, undefined]) {
    assert.ok(!allowedUrl(u, target), String(u));
  }
});

test('CDP sessions, launching, connecting and the other ways out are refused', () => {
  refused('Browser', 'newBrowserCDPSession', {}, /not available to a probe/);
  refused('BrowserContext', 'newCDPSession', { page: { guid: 'page@1' } });
  refused('CDPSession', 'send', { method: 'Target.createTarget', params: { url: 'file:///' } });
  for (const m of ['launch', 'launchPersistentContext', 'connectOverCDP', 'connectToWorker']) refused('BrowserType', m, {});
  for (const m of ['startServer', 'startTracing', 'newContextForReuse', 'killForTests']) refused('Browser', m, {});
  for (const m of ['createTempFiles', 'pause', 'showRecorder', 'startRecording']) refused('BrowserContext', m, {});
  refused('Playwright', 'newRequest', { proxy: { server: 'http://192.0.2.1' } });
  refused('LocalUtils', 'connect', { wsEndpoint: 'ws://192.0.2.1/' });
  refused('Artifact', 'saveAs', { path: '/tmp/anywhere' });
  refused('Tracing', 'tracingStart', {});
  refused('ElectronApplication', 'evaluateExpression', {});
  refused(undefined, 'goto', { url: '/' }, /never created/);
  refused('Frame', 'nonsense', {});
  refused('Frame', '__proto__', {});
});

test('a context needs a loopback base URL and may not set its own proxy, video or host-reaching permissions', () => {
  allowed('Browser', 'newContext', { noDefaultViewport: false, viewport: { width: 375, height: 800 }, baseURL: target, selectorEngines: [], timezoneId: 'Pacific/Auckland', locale: 'fr-FR', storageState: { cookies: [] } });
  refused('Browser', 'newContext', { baseURL: target, proxy: { server: 'http://127.0.0.1:1' } }, /proxy/);
  refused('Browser', 'newContext', { baseURL: target, recordVideo: { dir: '/tmp' } }, /recordVideo/);
  refused('Browser', 'newContext', { selectorEngines: [] }, /baseURL/);
  refused('Browser', 'newContext', { baseURL: 'file:///' }, /baseURL/);
  refused('Browser', 'newContext', { baseURL: target, permissions: ['clipboard-read'] }, /clipboard-read/);
  allowed('BrowserContext', 'grantPermissions', { permissions: ['geolocation'] });
  // Restoring a storage state opens a page at each origin it lists.
  const state = (origin) => ({ cookies: [], origins: [{ origin, localStorage: [{ name: 'k', value: 'v' }] }] });
  allowed('Browser', 'newContext', { baseURL: target, storageState: state('http://127.0.0.1:3000') });
  allowed('BrowserContext', 'setStorageState', { storageState: state('http://localhost:5173') });
  allowed('BrowserContext', 'setStorageState', { storageState: { cookies: [] } });
  for (const origin of ['file:///Users/me/.ssh', 'http://192.0.2.1', 'chrome://settings', undefined]) {
    refused('Browser', 'newContext', { baseURL: target, storageState: state(origin) }, /loopback http or https origins/);
    refused('BrowserContext', 'setStorageState', { storageState: state(origin) }, /loopback http or https origins/);
  }
  refused('BrowserContext', 'setStorageState', { storageState: { origins: 'file:///' } }, /must be a list/);
  refused('BrowserContext', 'grantPermissions', { permissions: ['camera'] });
});

test('navigation, route changes and host-side requests stay on loopback http', () => {
  allowed('Frame', 'goto', { url: '/settings', waitUntil: 'load' });
  refused('Frame', 'goto', { url: 'file:///Users/me/.ssh/id_ed25519' }, /not an http or https URL/);
  refused('Frame', 'goto', { url: 'http://192.0.2.1/' });
  // A script or style tag may be inline or loaded from the app, nowhere else.
  for (const method of ['addScriptTag', 'addStyleTag']) {
    allowed('Frame', method, { content: 'window.x = 1' });
    allowed('Frame', method, { url: '/app.js' });
    refused('Frame', method, { url: 'file:///Users/me/.ssh/id_ed25519' }, /not an http or https URL/);
    refused('Frame', method, { url: 'http://192.0.2.1/x.js' });
  }
  allowed('Route', 'continue', { isFallback: true });
  refused('Route', 'continue', { url: 'http://192.0.2.1/', isFallback: false });
  refused('Route', 'redirectNavigationRequest', { url: 'file:///etc/hosts' });
  allowed('APIRequestContext', 'fetch', { url: `${target}/api/x`, method: 'GET', maxRedirects: 0 });
  refused('APIRequestContext', 'fetch', { url: 'http://192.0.2.1/', maxRedirects: 0 });
  refused('APIRequestContext', 'fetch', { url: `${target}/api/x` }, /redirects/);
});

test('files reach a page as bytes from the probe, never as host paths or streams', () => {
  allowed('Frame', 'setInputFiles', { selector: 'input', payloads: [{ name: 'a.txt', buffer: 'aGk=' }], timeout: 1000 });
  allowed('ElementHandle', 'setInputFiles', { payloads: [] });
  refused('Frame', 'setInputFiles', { selector: 'input', localPaths: ['/etc/hosts'] }, /localPaths/);
  refused('ElementHandle', 'setInputFiles', { localDirectory: '/Users' }, /localDirectory/);
  refused('Frame', 'drop', { selector: 'div', streams: [{ guid: 'writable-stream@1' }] }, /streams/);
});

test('the calls a probe makes every day pass', () => {
  allowed('Root', 'initialize', { sdkLanguage: 'javascript' });
  allowed('BrowserContext', 'newPage', {});
  allowed('BrowserContext', 'setNetworkInterceptionPatterns', { patterns: [{ glob: '**/*' }] });
  allowed('BrowserContext', 'storageState', {});
  allowed('Page', 'screenshot', { type: 'png' });
  allowed('Page', 'setViewportSize', { viewportSize: { width: 375, height: 800 } });
  allowed('Frame', 'click', { selector: 'button' });
  allowed('Frame', 'waitForFunction', { expression: '() => true' });
  allowed('ElementHandle', 'screenshot', {});
  allowed('Route', 'fulfill', { status: 500 });
  allowed('Page', '__waitInfo__', { waitId: 'x', phase: 'before' });
  allowed('Frame', '__abort__', { id: 'a@1' });
});
