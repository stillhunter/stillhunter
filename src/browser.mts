// Which browser a hunt drives: Chrome, then Edge, then the Chromium build that
// the pinned playwright-core bundles. A browser named in the config is used or
// the hunt stops; it is never swapped for another.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

export type BrowserName = 'chrome' | 'msedge' | 'chromium';
export const BROWSER_NAMES: readonly BrowserName[] = ['chrome', 'msedge', 'chromium'];

const TITLES: Record<BrowserName, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  chromium: 'Playwright Chromium',
};

const require = createRequire(import.meta.url);

export function playwrightCoreDir(): string {
  return path.dirname(require.resolve('playwright-core/package.json'));
}

export function bundledChromium(): { revision: string; version: string } {
  const file = path.join(playwrightCoreDir(), 'browsers.json');
  const entry = (JSON.parse(readFileSync(file, 'utf8')) as { browsers: { name: string; revision: string; browserVersion: string }[] })
    .browsers.find((b) => b.name === 'chromium');
  if (!entry) throw new Error('playwright-core lists no Chromium build');
  return { revision: entry.revision, version: entry.browserVersion };
}

// Windows variable names ignore case, but a copy of process.env doesn't.
function windowsVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  if (key === undefined || !Object.hasOwn(env, key)) return undefined;
  const value = env[key];
  return typeof value === 'string' ? value : undefined;
}

export function playwrightCacheDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(windowsVar(env, 'LOCALAPPDATA') ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'ms-playwright');
}

function channelPaths(name: 'chrome' | 'msedge', env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return name === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  if (platform === 'win32') {
    const roots = ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'].map((n) => windowsVar(env, n)).filter((r): r is string => !!r);
    const tail = name === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return roots.map((r) => path.join(r, ...tail));
  }
  return name === 'chrome' ? ['/opt/google/chrome/chrome'] : ['/opt/microsoft/msedge/msedge'];
}

export type Installed = (name: BrowserName) => boolean;

// Whether each browser is on this machine, without launching anything.
export function installedOnThisMachine(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Installed {
  return (name) => {
    if (name === 'chromium') {
      const dir = path.join(playwrightCacheDir(env, platform), `chromium-${bundledChromium().revision}`);
      return existsSync(path.join(dir, 'INSTALLATION_COMPLETE'));
    }
    return channelPaths(name, env, platform).some((p) => existsSync(p));
  };
}

export type BrowserChoice = { ok: true; name: BrowserName } | { ok: false; message: string };

export function chooseBrowser(pinned: BrowserName | null, installed: Installed, env: NodeJS.ProcessEnv = process.env): BrowserChoice {
  const { version } = bundledChromium();
  const download = `To download Chromium (about 200 MB) into ${playwrightCacheDir(env)}, run: node "${path.join(playwrightCoreDir(), 'cli.js')}" install --no-shell chromium`;
  if (pinned !== null) {
    if (installed(pinned)) return { ok: true, name: pinned };
    const what = pinned === 'chromium' ? `Playwright Chromium ${version}` : TITLES[pinned];
    return { ok: false, message: `"browser": "${pinned}" in .stillhunter/config.json names ${what}, which isn't installed. Install it, or change the setting.${pinned === 'chromium' ? ` ${download}` : ''}` };
  }
  for (const name of BROWSER_NAMES) if (installed(name)) return { ok: true, name };
  return { ok: false, message: `No browser found: no Google Chrome, no Microsoft Edge, no Playwright Chromium ${version}. ${download}` };
}
