import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import { layoutCandidates } from '../dist/layout.mjs';
import { browserChoice, noBrowser } from './helpers.mjs';

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; font: 16px sans-serif; } .row { display: flex; }</style>
<label>Squeezed <input id="squeezed" style="width: 30px" value="2026-11-13 long value"></label>
<label>Roomy <input id="roomy" style="width: 300px" value="fits"></label>
<label>Hint <input id="hint" style="width: 40px" placeholder="A placeholder that is long"></label>
<select id="pick" style="width: 40px"><option>An option with a long label</option></select>
<textarea id="notes" style="width: 120px">Text that wraps over several lines and is fine</textarea>
<div id="cut" style="width: 80px; white-space: nowrap; overflow: hidden">A line far too long for its box</div>
<div id="dots" style="width: 80px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">Another line far too long</div>
<div id="short" style="width: 300px; overflow: hidden">Short</div>
<span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">Screen reader text that is long</span>
<div id="wide" style="width: 520px"><span>Wide block</span></div>
<div style="overflow-x: auto; width: 300px"><div id="scroller" style="width: 900px">Scrolls on purpose</div></div>
<div id="drawer" style="position: fixed; left: 400px; top: 0; width: 200px">Parked off screen</div>`;

describe('layout candidates', { skip: noBrowser, timeout: 60_000 }, () => {
  let browser;
  let page;
  before(async () => {
    browser = await chromium.launch({ channel: browserChoice.name, headless: true });
    page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    await page.setContent(PAGE);
  });
  after(() => browser?.close());

  test('finds clipped values, clipped text and elements past the right edge', async () => {
    const found = await page.evaluate(layoutCandidates, 50);
    const at = (kind) => found.filter((c) => c.kind === kind).map((c) => c.selector);
    assert.deepEqual(at('value-clipped'), ['#squeezed', '#hint', '#pick']);
    assert.deepEqual(at('text-clipped'), ['#cut', '#dots']);
    // #wide spills past the right edge; #drawer is pushed entirely past it.
    assert.deepEqual(at('off-screen'), ['#wide', '#drawer']);
    const squeezed = found.find((c) => c.selector === '#squeezed');
    assert.match(squeezed.text, /^Squeezed: "2026-11-13 long value"$/);
    assert.match(squeezed.detail, /text needs \d+ px, the box shows \d+ px/);
    assert.match(found.find((c) => c.selector === '#wide').detail, /right edge at 520 px, the viewport is 375 px wide/);
    assert.match(found.find((c) => c.selector === '#drawer').detail, /right edge at 600 px, the viewport is 375 px wide/);
  });

  test('keeps to the limit, value-clipped first', async () => {
    const found = await page.evaluate(layoutCandidates, 2);
    assert.deepEqual(found.map((c) => c.selector), ['#squeezed', '#hint']);
  });

  test('a page that fits has none', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.setContent('<h1>Fine</h1><input value="ok"><p style="overflow:hidden">Short text</p>');
    assert.deepEqual(await p.evaluate(layoutCandidates, 10), []);
    await p.close();
  });
});
