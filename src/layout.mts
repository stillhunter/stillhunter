// Layout candidates for observe(): places where a person cannot see what the
// page holds. It runs inside the page, so it must not use anything from the
// module around it. Only a 1 px rounding allowance is used: no threshold is
// tuned to a particular app.

export interface LayoutCandidate {
  kind: 'value-clipped' | 'text-clipped' | 'off-screen';
  selector: string;
  text: string;
  detail: string;
}

export function layoutCandidates(limit: number): LayoutCandidate[] {
  const SKIP_INPUT = new Set(['hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button', 'reset', 'image']);
  const SKIP_TAG = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'OPTION']);
  const short = (s: string, n = 80) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (check) return check.call(el, { checkOpacity: true, visibilityProperty: true });
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    for (let depth = 0; e && e !== document.body && depth < 4; depth++) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      let s = e.tagName.toLowerCase();
      const classes = [...e.classList].slice(0, 2);
      if (classes.length) s += `.${classes.map((c) => CSS.escape(c)).join('.')}`;
      const parent: Element | null = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === e!.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(s);
      e = parent;
    }
    return parts.join(' > ');
  };
  const fieldName = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) =>
    short(el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.getAttribute('name') || el.id || el.tagName.toLowerCase(), 40);

  const canvas = document.createElement('canvas').getContext('2d');
  const textWidth = (text: string, s: CSSStyleDeclaration) => {
    if (!canvas) return 0;
    canvas.font = s.font || `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const spacing = Number.parseFloat(s.letterSpacing) || 0;
    return canvas.measureText(text).width + spacing * text.length;
  };

  const valueClipped: LayoutCandidate[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
    if (el instanceof HTMLInputElement && SKIP_INPUT.has(el.type)) continue;
    if (!shown(el)) continue;
    const s = getComputedStyle(el);
    const content = el.clientWidth - (Number.parseFloat(s.paddingLeft) || 0) - (Number.parseFloat(s.paddingRight) || 0);
    const text = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? '') : (el.value || el.getAttribute('placeholder') || '');
    const scrolls = el.scrollWidth > el.clientWidth + 1;
    // A textarea wraps its text, so only a sideways scroll means it is cut.
    const needed = el instanceof HTMLTextAreaElement || text === '' ? 0 : textWidth(text, s);
    if (scrolls || needed > content + 1) {
      valueClipped.push({
        kind: 'value-clipped',
        selector: selectorOf(el),
        text: `${fieldName(el)}: "${short(text, 60)}"`,
        detail: needed > content + 1 ? `text needs ${Math.ceil(needed)} px, the box shows ${Math.floor(content)} px` : `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`,
      });
    }
  }

  const all = [...document.body.querySelectorAll('*')].filter((el) => !SKIP_TAG.has(el.tagName));
  const textClipped: LayoutCandidate[] = [];
  for (const el of all) {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) continue;
    const s = getComputedStyle(el);
    const clipX = s.overflowX === 'hidden' || s.overflowX === 'clip' || s.textOverflow === 'ellipsis';
    const clipY = s.overflowY === 'hidden' || s.overflowY === 'clip';
    if (!clipX && !clipY) continue;
    const r = el.getBoundingClientRect();
    // 1 px boxes are the usual visually-hidden pattern for screen readers.
    if (r.width <= 1 || r.height <= 1 || !shown(el)) continue;
    const text = (el as HTMLElement).innerText ?? '';
    if (!text.trim()) continue;
    const wide = clipX && el.scrollWidth > el.clientWidth + 1;
    const tall = clipY && el.scrollHeight > el.clientHeight + 1;
    if (!wide && !tall) continue;
    textClipped.push({
      kind: 'text-clipped',
      selector: selectorOf(el),
      text: short(text),
      detail: [wide ? `content ${el.scrollWidth} px wide in a ${el.clientWidth} px box` : '', tall ? `content ${el.scrollHeight} px tall in a ${el.clientHeight} px box` : ''].filter(Boolean).join('; '),
    });
  }

  const viewport = document.documentElement.clientWidth || window.innerWidth;
  const offScreen: LayoutCandidate[] = [];
  const reported = new Set<Element>();
  const scrollsSideways = (el: Element) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (a === document.body) break;
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  for (const el of all) {
    const r = el.getBoundingClientRect();
    // Off-screen is any visible element whose right edge is past the viewport,
    // including one pushed entirely past it, unless it scrolls sideways on
    // purpose. An element wholly off the left (right edge at or before 0) is
    // left out by the first test.
    if (r.right <= viewport + 1 || r.width <= 0 || r.height <= 0) continue;
    if (!shown(el) || scrollsSideways(el)) continue;
    let inner = false;
    for (let a = el.parentElement; a; a = a.parentElement) if (reported.has(a)) { inner = true; break; }
    if (inner) continue;
    reported.add(el);
    offScreen.push({
      kind: 'off-screen',
      selector: selectorOf(el),
      text: short((el as HTMLElement).innerText ?? ''),
      detail: `right edge at ${Math.round(r.right)} px, the viewport is ${viewport} px wide`,
    });
  }
  return [...valueClipped, ...textClipped, ...offScreen].slice(0, limit);
}
