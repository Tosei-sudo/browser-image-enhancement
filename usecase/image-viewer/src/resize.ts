/**
 * Drag handles that let the user size the panels around the map: the
 * width of the layer panel on the left and the height of the attribute
 * table underneath. The size is a CSS variable on the panel, kept in
 * localStorage so it comes back next time. Double-clicking the handle goes
 * back to the default size, and when the handle has the focus the arrow
 * keys change the size in steps (Home: the default).
 */

export interface ResizerOptions {
  /** The element dragged. It becomes a focusable separator. */
  handle: HTMLElement;
  /** The element the CSS variable is set on. */
  target: HTMLElement;
  /** The CSS variable, like `--side-width`. */
  property: string;
  /** 'x': dragging right grows the panel; 'y': dragging up grows it. */
  axis: 'x' | 'y';
  /** The panel is on the other side of its handle: dragging left (or down) grows it. */
  reverse?: boolean;
  /** The size now, in pixels. */
  size: () => number;
  /** The smallest and largest sizes, in pixels, asked when needed. */
  min: () => number;
  max: () => number;
  /** localStorage key of the size. */
  key: string;
  /** Label read out for the handle. */
  label: string;
  /** Called after each change of size (the map needs updateSize). */
  onResize?: () => void;
}

const STEP = 16;

/** Wires `options.handle`; returns a function that restores the default size. */
export function makeResizer(options: ResizerOptions): () => void {
  const { handle, target, property, axis, key } = options;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-label', options.label);
  handle.title = `${options.label}（ドラッグで変更、ダブルクリックで元のサイズ）`;

  const clamp = (size: number) => Math.round(Math.max(options.min(), Math.min(options.max(), size)));
  const apply = (size: number | null, save: boolean) => {
    if (size === null) target.style.removeProperty(property);
    else target.style.setProperty(property, `${size}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(options.size())));
    if (save) {
      try {
        if (size === null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(size));
      } catch {
        // No storage (private window): the size lasts until the page closes.
      }
    }
    options.onResize?.();
  };
  const reset = () => apply(null, true);

  let saved: number | null = null;
  try {
    const value = Number(localStorage.getItem(key));
    if (value > 0) saved = value;
  } catch {
    // As above.
  }
  if (saved !== null) apply(clamp(saved), false);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const size = options.size();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    let last = size;
    let frame = 0;
    const move = (m: PointerEvent) => {
      const moved = axis === 'x' ? m.clientX - start : start - m.clientY;
      last = clamp(size + (options.reverse ? -moved : moved));
      // One layout (and one map redraw) per frame, however fast the pointer moves.
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        apply(last, false);
      });
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing-x', 'resizing-y');
      cancelAnimationFrame(frame);
      frame = 0;
      if (last !== size) apply(last, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end, { once: true });
    handle.addEventListener('pointercancel', end, { once: true });
  });
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (e) => {
    const grow = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowUp: 1, ArrowDown: -1 };
    const sign = (grow[e.key as keyof typeof grow] ?? 0) * (options.reverse ? -1 : 1);
    if (sign) apply(clamp(options.size() + sign * (e.shiftKey ? STEP * 4 : STEP)), true);
    else if (e.key === 'Home') reset();
    else return;
    e.preventDefault();
  });
  return reset;
}
