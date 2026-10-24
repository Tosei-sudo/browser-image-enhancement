/**
 * Takes a window of the viewer out of the tab: every dialog gets a ⧉ button
 * at its title that moves it, as it is, into a window of its own, which can go
 * beside the map or onto another screen. Shift+click opens it in a window that
 * stays in front of the others (Document Picture-in-Picture, where the browser
 * has it). By default nothing changes: the windows open in the tab as before.
 *
 * The dialog itself moves (not a copy), so what it shows, its inputs and what
 * its buttons do stay the same, run by the same page. It takes the page's
 * styles, also light or dark, along. ↩ in the window brings the dialog back
 * into the tab where it was; closing the window closes the dialog, as its ×
 * does (which closes the window too). Its title dragged onto the tab docks it
 * there (dock-dialogs.ts). A modal dialog does not hold the tab while it is
 * outside, so the map can be used next to it.
 */

/** The dialogs' titles, where the button goes (as in move-windows.ts). */
const TITLE = 'h2, .catalog-head';
const BUTTON = 'pop-out-button';
/** The drag data type of a popped-out dialog's title. */
const DRAG_TYPE = 'application/x-image-viewer-window';
/** Smallest size of a new window, in CSS pixels. */
const MIN_WIDTH = 280;
const MIN_HEIGHT = 160;

/** The window size and screen place for a dialog at `rect` in the tab's window `win`. */
export function windowFeatures(rect: { left: number; top: number; width: number; height: number }, win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number }): { left: number; top: number; width: number; height: number } {
  // The browser's frame and toolbars sit above the page: the page starts this far below the window's top.
  const chromeTop = Math.max(0, win.outerHeight - win.innerHeight);
  const chromeLeft = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  return {
    left: Math.round(win.screenX + chromeLeft + rect.left),
    top: Math.round(win.screenY + chromeTop + rect.top),
    width: Math.round(Math.max(MIN_WIDTH, rect.width)),
    height: Math.round(Math.max(MIN_HEIGHT, rect.height)),
  };
}

interface PoppedOut {
  win: Window;
  /** Where it goes back to. */
  place: Comment;
  modal: boolean;
  style: string | null;
  /** Undoes the listeners and the stand-ins set while it is out. */
  undo: Array<() => void>;
}

const popped = new Map<HTMLDialogElement, PoppedOut>();
/** The dialog whose title is being dragged out of its window, if any. */
let dragged: HTMLDialogElement | null = null;

/** The dialog whose title is being dragged out of its window (onto the tab, to dock it), or null. */
export function draggedOut(): HTMLDialogElement | null {
  return dragged && popped.has(dragged) ? dragged : null;
}

/** Whether `dialog` is in a window of its own now. */
export function isPoppedOut(dialog: HTMLDialogElement): boolean {
  return popped.has(dialog);
}

/** The text of a dialog's title, for its window's title. */
function titleOf(dialog: HTMLDialogElement): string {
  const title = dialog.querySelector(TITLE);
  const h2 = title?.matches('h2') ? title : title?.querySelector('h2');
  return (h2?.textContent ?? '').trim();
}

/** Copies the page's styles and the attributes of its <html> (the theme among them) into `target`, and keeps the attributes the same. */
function copyLook(doc: Document, target: Document, undo: Array<() => void>): void {
  for (const el of doc.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel=stylesheet], style')) {
    const copy = el.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
    // about:blank and Picture-in-Picture windows have no base of their own to resolve the page's links against.
    if (copy instanceof HTMLLinkElement || copy.localName === 'link') (copy as HTMLLinkElement).href = (el as HTMLLinkElement).href;
    target.head.append(copy);
  }
  const sync = (): void => {
    const from = doc.documentElement;
    const to = target.documentElement;
    for (const name of to.getAttributeNames()) if (!from.hasAttribute(name)) to.removeAttribute(name);
    for (const name of from.getAttributeNames()) {
      if (name === 'class') continue;
      to.setAttribute(name, from.getAttribute(name)!);
    }
    to.className = from.className;
    to.classList.add('pop-out-window');
    to.classList.remove('moving-window');
  };
  sync();
  target.body.className = doc.body.className;
  const watcher = new MutationObserver(sync);
  watcher.observe(doc.documentElement, { attributes: true });
  undo.push(() => watcher.disconnect());
}

/** Opens a window for `dialog`, or null when the browser does not let it (a blocked popup). */
async function openWindow(dialog: HTMLDialogElement, front: boolean, doc: Document): Promise<Window | null> {
  const view = doc.defaultView!;
  const rect = dialog.getBoundingClientRect();
  const at = windowFeatures(rect, view);
  const pip = (view as Window & { documentPictureInPicture?: { requestWindow(options: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
  if (front && pip) {
    try {
      return await pip.requestWindow({ width: at.width, height: at.height });
    } catch {
      // Not allowed now: an ordinary window instead.
    }
  }
  const win = view.open('', '', `popup,width=${at.width},height=${at.height},left=${at.left},top=${at.top}`);
  if (!win) return null;
  // A new about:blank window has an empty document; give it a proper one.
  if (!win.document.head) {
    win.document.open();
    win.document.write('<!doctype html><html><head></head><body></body></html>');
    win.document.close();
  }
  return win;
}

/** Briefly says, beside the button, that the window could not open. */
function sayBlocked(button: HTMLButtonElement): void {
  const doc = button.ownerDocument;
  let note = button.parentElement?.querySelector<HTMLElement>('.pop-out-note');
  if (!note) {
    note = doc.createElement('span');
    note.className = 'pop-out-note';
    note.setAttribute('role', 'status');
    button.after(note);
  }
  note.textContent = 'ポップアップがブロック済み。このサイトのポップアップを許可';
  setTimeout(() => note.remove(), 6000);
}

/**
 * Moves `dialog` into a window of its own (`front`: one that stays in front,
 * where the browser can). Resolves to whether it did.
 */
export async function popOut(dialog: HTMLDialogElement, front = false): Promise<boolean> {
  if (popped.has(dialog) || !dialog.open) return popped.has(dialog);
  const doc = dialog.ownerDocument;
  const win = await openWindow(dialog, front, doc);
  if (!win) return false;
  if (!dialog.open || !dialog.isConnected) {
    // Closed while the window was opening.
    win.close();
    return false;
  }
  const out: PoppedOut = { win, place: doc.createComment('pop-out'), modal: dialog.matches(':modal'), style: dialog.getAttribute('style'), undo: [] };
  popped.set(dialog, out);
  const target = win.document;
  target.title = [titleOf(dialog), doc.title].filter(Boolean).join(' — ');
  copyLook(doc, target, out.undo);

  dialog.before(out.place);
  for (const name of ['position', 'inset', 'left', 'top', 'right', 'bottom', 'margin', 'transform', 'width', 'height', 'max-height']) dialog.style.removeProperty(name);
  dialog.classList.add('popped-out');
  // Out of the tab's document a modal dialog is an ordinary open one: the tab can be used again.
  target.body.append(dialog);
  updateButton(dialog);

  // Opening it again (its menu item) shows its window rather than failing on an open dialog.
  const focus = (): void => win.focus();
  dialog.show = focus;
  dialog.showModal = focus;
  out.undo.push(() => {
    delete (dialog as Partial<HTMLDialogElement>).show;
    delete (dialog as Partial<HTMLDialogElement>).showModal;
  });

  // Closing the dialog closes its window.
  const closed = (): void => bringBack(dialog);
  dialog.addEventListener('close', closed);
  out.undo.push(() => dialog.removeEventListener('close', closed));
  // Closing the window closes the dialog: it goes back into the tab, closed.
  const gone = (): void => bringBack(dialog, true);
  win.addEventListener('pagehide', gone);
  out.undo.push(() => win.removeEventListener('pagehide', gone));
  // Esc closes a modal dialog there as it does in the tab (the browser's own handling stays in the tab).
  if (out.modal) {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    };
    target.addEventListener('keydown', key);
    out.undo.push(() => target.removeEventListener('keydown', key));
  }
  // The window size changed: the charts and lists that follow the page's size redraw.
  const resized = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };
  win.addEventListener('resize', resized);
  out.undo.push(() => win.removeEventListener('resize', resized));
  // Its title can be dragged onto the tab, which docks it there (dock-dialogs.ts listens on the tab).
  const title = dialog.querySelector<HTMLElement>(TITLE);
  if (title) {
    const draggable = title.getAttribute('draggable');
    title.draggable = true;
    const start = (e: DragEvent): void => {
      if ((e.target as Element | null)?.closest?.('button, input, select, textarea, a')) return;
      dragged = dialog;
      e.dataTransfer?.setData(DRAG_TYPE, titleOf(dialog));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    const end = (): void => {
      if (dragged === dialog) dragged = null;
    };
    title.addEventListener('dragstart', start);
    title.addEventListener('dragend', end);
    out.undo.push(() => {
      title.removeEventListener('dragstart', start);
      title.removeEventListener('dragend', end);
      if (draggable === null) title.removeAttribute('draggable');
      else title.setAttribute('draggable', draggable);
      end();
    });
  }
  win.focus();
  return true;
}

/** Brings a dialog back from its window into the tab, where it was; `close`: closed (its window was closed). */
export function bringBack(dialog: HTMLDialogElement, close = false): void {
  const out = popped.get(dialog);
  if (!out) return;
  popped.delete(dialog);
  for (const undo of out.undo) undo();
  dialog.classList.remove('popped-out');
  if (out.style === null) dialog.removeAttribute('style');
  else dialog.setAttribute('style', out.style);
  if (out.place.isConnected) out.place.replaceWith(dialog);
  else out.place.ownerDocument.body.append(dialog);
  if (close) {
    if (dialog.open) dialog.close();
  } else if (dialog.open && out.modal) {
    // Still open (↩): open as it was, modal again if it was.
    dialog.removeAttribute('open');
    dialog.showModal();
  }
  updateButton(dialog);
  // Let a click in the popped-out window finish before closing its page.
  if (!out.win.closed) setTimeout(() => {
    if (!out.win.closed) out.win.close();
  }, 0);
}

/** Brings every dialog back (the tab is going away, so its windows would stop working). */
export function bringAllBack(): void {
  for (const dialog of [...popped.keys()]) bringBack(dialog);
}

function updateButton(dialog: HTMLDialogElement): void {
  const button = dialog.querySelector<HTMLButtonElement>(`.${BUTTON}`);
  if (!button) return;
  const out = popped.has(dialog);
  button.textContent = out ? '↩' : '⧉';
  button.title = out ? 'タブに復帰' : '別ウィンドウで開く（Shift+クリックで常に手前に表示）';
  button.setAttribute('aria-label', out ? 'タブに復帰' : '別ウィンドウで開く');
}

/** Gives `dialog` its button, at its title (once; again after its content is replaced). */
export function addButton(dialog: HTMLDialogElement): void {
  if (dialog.querySelector(`.${BUTTON}`) || 'noPopOut' in dialog.dataset) return;
  const title = dialog.querySelector(TITLE);
  if (!title) return;
  const button = dialog.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = BUTTON;
  button.addEventListener('click', (e) => {
    if (popped.has(dialog)) bringBack(dialog);
    else void popOut(dialog, e.shiftKey).then((done) => {
      if (!done && dialog.open && !popped.has(dialog)) sayBlocked(button);
    });
  });
  // In a title bar with a × (the panels), beside the ×; else at the dialog's top right.
  const close = title.matches('.catalog-head') ? title.querySelector('.catalog-close') : null;
  if (close) close.before(button);
  else if (title.matches('.catalog-head')) title.append(button);
  else {
    button.classList.add('pop-out-corner');
    dialog.prepend(button);
  }
  updateButton(dialog);
}

/** Wires the buttons on every dialog of `doc` (once per page). */
export function enablePopOut(doc: Document = document): void {
  const scan = (): void => {
    for (const dialog of doc.querySelectorAll<HTMLDialogElement>('dialog[open]')) addButton(dialog);
  };
  // A dialog gets its button when it opens; its content may be built only then.
  new MutationObserver(scan).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  scan();
  doc.defaultView?.addEventListener('pagehide', bringAllBack);
}
