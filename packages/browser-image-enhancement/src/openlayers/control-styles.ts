/**
 * Default look of the controls, added to the document once. It follows the
 * colors of `ol/ol.css` (its custom properties), so the controls match the
 * zoom buttons. It comes after the page's style sheets (and `ol.css`), so a
 * page rule overrides it with a more specific selector, such as
 * `#map .ol-enhance`. Pass `css: false` to a control to style it yourself.
 */
const CSS = `
.ol-enhance { top: .5em; right: .5em; max-height: calc(100% - 1em); display: flex; flex-direction: column; align-items: flex-end; }
.ol-control.ol-enhance { background: transparent; }
.ol-enhance-panel { display: grid; gap: 6px; box-sizing: border-box; width: 18em; max-width: calc(100vw - 2em); max-height: calc(100% - 2em); overflow-y: auto; margin-top: 2px;
  padding: 8px 10px; border-radius: 4px; background: var(--ol-background-color, #fff); color: var(--ol-subtle-foreground-color, #666);
  font: 12px/1.3 system-ui, sans-serif; }
.ol-enhance-panel[hidden] { display: none; }
.ol-enhance-panel fieldset { display: grid; gap: 6px; min-width: 0; margin: 0; padding: 6px 0 0; border: 0; border-top: 1px solid var(--ol-subtle-background-color, #8884); }
.ol-enhance-panel fieldset[hidden] { display: none; }
.ol-enhance-panel legend { padding: 0 4px 0 0; font-weight: 600; }
.ol-enhance-row { display: grid; grid-template-columns: 6.5em minmax(0, 1fr) 3em; align-items: center; gap: 6px; }
.ol-enhance-row[hidden] { display: none; }
.ol-enhance-row input[type=range] { width: 100%; min-width: 0; margin: 0; }
.ol-enhance-row output { text-align: right; font-variant-numeric: tabular-nums; }
.ol-enhance-row select { grid-column: 2 / 4; min-width: 0; font: inherit; }
.ol-enhance-row input[type=checkbox] { justify-self: start; margin: 0; }
.ol-enhance-head { display: flex; align-items: center; gap: 8px; }
.ol-enhance-head label { display: flex; align-items: center; gap: 4px; margin-right: auto; }
.ol-control .ol-enhance-panel button { display: inline-block; width: auto; height: auto; margin: 0; padding: 2px 8px; font: inherit; }
.ol-load-image { top: 4.25em; left: .5em; }
.ol-touch .ol-load-image { top: 5.5em; }
.ol-load-image form { display: flex; gap: 2px; margin-top: 2px; }
.ol-load-image form[hidden] { display: none; }
.ol-load-image input[type=url] { width: 16em; max-width: calc(100vw - 6em); font: 12px system-ui, sans-serif; }
.ol-control.ol-load-image form button { width: auto; padding: 0 8px; font-size: 12px; }
.ol-load-image-drop { outline: 3px dashed var(--ol-subtle-foreground-color, #666); outline-offset: -6px; }
`;

let added = false;

/** A control button with a stroked 20×20 SVG icon and `title` as its name. */
export function iconButton(title: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '1em');
  svg.setAttribute('height', '1em');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', icon);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  b.append(svg);
  return b;
}

/** Adds the default styles to the document, once. */
export function addControlStyles(): void {
  if (added || typeof document === 'undefined') return;
  added = true;
  // A constructed sheet keeps working under a CSP that blocks inline <style>.
  if ('adoptedStyleSheets' in document && typeof CSSStyleSheet !== 'undefined' && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
}
