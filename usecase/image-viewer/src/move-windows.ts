/**
 * Lets the user drag the viewer's windows anywhere: every dialog by its
 * title, and the small panels over the map (click segmentation, a running
 * detection, building of RSET, the drawing and editing toolbars) by any
 * part that is not a control. One listener on the document covers them all,
 * so a new dialog is movable without code of its own.
 *
 * A moved window keeps its place while the page is open (also when it is
 * closed and opened again) and always stays inside the screen, or inside the
 * map for the panels over it. Double-clicking the title puts it back where
 * it first was.
 */

/** Windows dragged by their title. */
const DIALOG = 'dialog';
const TITLE = 'h2, .catalog-head';
/** Panels over the map, dragged by anything but a control. */
const PANEL = '.ai-segment-panel, .shadow-panel, .ai-progress, .rset-progress, .annotation-bar, .edit-bar, .guide';
/** Where a press starts what the element does, not a move. */
const CONTROL = 'input, select, textarea, button, a, summary, label, option, [contenteditable], [role=slider], canvas';
/** How far the pointer moves before the press is a drag, in pixels. */
const SLOP = 3;
/** The inline styles a move sets, cleared to put the window back. */
const MOVED_STYLES = ['position', 'inset', 'left', 'top', 'right', 'bottom', 'margin', 'transform'] as const;

/**
 * The window a press at `target` would move, if any. A dialog moves from its
 * title or its bare edge (`x`, `y` tell the edge from the backdrop around a
 * modal dialog, which gets the same events).
 */
export function movableOf(target: EventTarget | null, x?: number, y?: number): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(CONTROL)) return null;
  const panel = target.closest<HTMLElement>(PANEL);
  if (panel) return panel;
  const dialog = target.closest<HTMLElement>(DIALOG);
  if (!dialog) return null;
  // Docked (dock.ts): its title drags it to another place in the layout instead.
  if (dialog.classList.contains('docked')) return null;
  // A floating panel's window moves by its own title, not the panel's.
  const title = dialog.classList.contains('dock-float') ? target.closest('.dock-float-head') : target.closest(TITLE);
  if (title?.closest(DIALOG) === dialog) return dialog;
  if (target !== dialog || x === undefined || y === undefined) return null;
  const rect = dialog.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? dialog : null;
}

/** The area a window stays in: the screen for dialogs, its positioned parent for the panels. */
function boundsOf(el: HTMLElement): DOMRect {
  if (el instanceof HTMLDialogElement || getComputedStyle(el).position === 'fixed' || !el.offsetParent) {
    return new DOMRect(0, 0, document.documentElement.clientWidth, document.documentElement.clientHeight);
  }
  const parent = el.offsetParent as HTMLElement;
  const rect = parent.getBoundingClientRect();
  return new DOMRect(rect.left + parent.clientLeft, rect.top + parent.clientTop, parent.clientWidth, parent.clientHeight);
}

/**
 * Where a window of `size` goes when asked for (`left`, `top`) inside `bounds`
 * (all relative to the bounds): fully inside when it fits, else its top-left
 * corner, where the title is, stays in.
 */
export function clampPosition(left: number, top: number, size: { width: number; height: number }, bounds: { width: number; height: number }): [number, number] {
  const x = Math.max(0, Math.min(left, bounds.width - size.width));
  const y = Math.max(0, Math.min(top, bounds.height - size.height));
  return [Math.round(x), Math.round(y)];
}

/** Puts `el` at the screen point (`x`, `y`) of its top-left corner, kept inside its bounds. */
function place(el: HTMLElement, x: number, y: number): void {
  const bounds = boundsOf(el);
  const rect = el.getBoundingClientRect();
  const [left, top] = clampPosition(x - bounds.left, y - bounds.top, rect, bounds);
  if (el instanceof HTMLDialogElement) el.style.position = 'fixed';
  el.style.inset = 'auto';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.margin = '0';
  el.style.transform = 'none';
  el.dataset.moved = '';
}

/** Moves a moved window back inside its bounds (after the window or the map changed size). */
function keepInside(el: HTMLElement): void {
  if (!('moved' in el.dataset) || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return; // not shown
  place(el, rect.left, rect.top);
}

/** Puts a moved window back where its stylesheet places it. */
export function resetPosition(el: HTMLElement): void {
  for (const name of MOVED_STYLES) el.style.removeProperty(name);
  delete el.dataset.moved;
}

const watched = new WeakSet<HTMLElement>();
let shown: MutationObserver | null = null;
let sized: ResizeObserver | null = null;

/** Keeps a moved window inside its bounds also when it is shown again, or the map under a panel changes size. */
function watch(el: HTMLElement): void {
  if (watched.has(el)) return;
  watched.add(el);
  shown ??= new MutationObserver((records) => {
    for (const r of records) requestAnimationFrame(() => keepInside(r.target as HTMLElement));
  });
  shown.observe(el, { attributes: true, attributeFilter: ['open', 'hidden'] });
  const parent = el instanceof HTMLDialogElement ? null : el.offsetParent;
  if (parent && typeof ResizeObserver !== 'undefined') {
    sized ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        for (const child of entry.target.querySelectorAll<HTMLElement>(':scope > [data-moved]')) keepInside(child);
      }
    });
    sized.observe(parent);
  }
}

/** Wires the dragging of windows on `doc` (once per page). */
export function enableWindowMoving(doc: Document = document): void {
  // Capturing, as the map stops the events of the controls over it from going up.
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const el = movableOf(e.target, e.clientX, e.clientY);
    if (!el) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let start = el.getBoundingClientRect();
    let dragging = false;
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!dragging) {
        if (Math.hypot(dx, dy) < SLOP) return;
        dragging = true;
        // Where it is now: a centred dialog shifts when its text changes after the press.
        start = el.getBoundingClientRect();
        el.classList.add('moving');
        doc.documentElement.classList.add('moving-window');
        doc.getSelection()?.removeAllRanges();
        watch(el);
      }
      ev.preventDefault();
      place(el, start.left + dx, start.top + dy);
    };
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      doc.removeEventListener('pointermove', move, true);
      doc.removeEventListener('pointerup', end, true);
      doc.removeEventListener('pointercancel', end, true);
      el.classList.remove('moving');
      doc.documentElement.classList.remove('moving-window');
    };
    doc.addEventListener('pointermove', move, true);
    doc.addEventListener('pointerup', end, true);
    doc.addEventListener('pointercancel', end, true);
  }, true);
  doc.addEventListener('dblclick', (e) => {
    const el = movableOf(e.target, e.clientX, e.clientY);
    if (el && 'moved' in el.dataset) resetPosition(el);
  }, true);
  doc.defaultView?.addEventListener('resize', () => {
    for (const el of doc.querySelectorAll<HTMLElement>('[data-moved]')) keepInside(el);
  });
}
