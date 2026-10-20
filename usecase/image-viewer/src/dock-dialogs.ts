/**
 * Dialogs in the docking layout (src/dock.ts): every dialog gets a ◧ button
 * at its title whose menu puts it in the left, right or bottom dock, where it
 * stays open beside the map as a panel (a tab when it shares a group), and
 * where it opens again the next time, also after a reload. 「ウィンドウに戻す」
 * (or dragging its title onto the map) makes it a dialog again.
 *
 * The dialog itself moves (as with ⧉, pop-out.ts), so what it shows and what
 * its buttons do stay the same. A modal dialog does not hold the page while
 * it is docked. Closing it (its × or buttons, or the × of its tab) closes the
 * panel; the dialog goes back where it was in the page, closed.
 */
import { ContextMenu } from './context-menu.js';
import type { DockLayout } from './dock.js';
import type { DockSide, DropTarget, FloatRect } from './dock-state.js';
import { bringBack, draggedOut, isPoppedOut } from './pop-out.js';

/** The dialogs' titles (as in move-windows.ts and pop-out.ts). */
const TITLE = 'h2, .catalog-head';
const BUTTON = 'dock-button';
/** Classes every dialog of a kind shares, or that come and go: no help in telling dialogs apart. */
const COMMON = new Set(['add-service', 'processing-dialog', 'docked', 'popped-out', 'moving']);
/** The inline styles a move sets (move-windows.ts), cleared while docked. */
const MOVED_STYLES = ['position', 'inset', 'left', 'top', 'right', 'bottom', 'margin', 'transform', 'width', 'height', 'max-height'];

interface Docked {
  id: string;
  /** Where it goes back to. */
  place: Comment;
  modal: boolean;
  style: string | null;
  undo: Array<() => void>;
}

const docked = new Map<HTMLDialogElement, Docked>();

/** The layout id of a dialog: its own class (`plan-dialog`), else its title. */
export function dockIdOf(dialog: HTMLDialogElement): string {
  if (dialog.dataset.dockId) return dialog.dataset.dockId;
  const own = [...dialog.classList].filter((c) => !COMMON.has(c));
  const name = own[own.length - 1] ?? (dialog.querySelector('h2')?.textContent ?? '').trim();
  return (dialog.dataset.dockId = `dialog:${name || 'dialog'}`);
}

/** Whether `dialog` is in the layout now. */
export function isDocked(dialog: HTMLDialogElement): boolean {
  return docked.has(dialog);
}

function titleElement(dialog: HTMLDialogElement): HTMLElement | null {
  return dialog.querySelector<HTMLElement>(TITLE);
}

function titleOf(dialog: HTMLDialogElement): string {
  const title = titleElement(dialog);
  const h2 = title?.matches('h2') ? title : title?.querySelector('h2');
  return (h2?.textContent ?? '').trim() || 'ウィンドウ';
}

/** Puts the dialog's ◧ button at its title (beside ⧉ and ×). */
function placeButton(dialog: HTMLDialogElement, button: HTMLElement): void {
  const title = titleElement(dialog);
  if (!title) return;
  if (title.matches('.catalog-head')) {
    const before = title.querySelector('.pop-out-button') ?? title.querySelector('.catalog-close');
    if (before) before.before(button);
    else title.append(button);
  } else {
    button.classList.add('dock-dialog-corner');
    dialog.prepend(button);
  }
}

/** Gives `dialog` its ◧ button (once; again after its content is replaced). */
function addButton(dialog: HTMLDialogElement, layout: DockLayout): void {
  if (dialog.querySelector(`:scope .${BUTTON}`) || 'noDock' in dialog.dataset || 'noPopOut' in dialog.dataset || dialog.matches('.dock-float')) return;
  if (!titleElement(dialog)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON;
  button.textContent = '◧';
  button.title = '画面の端に組み込む（ドッキング）';
  button.setAttribute('aria-label', '画面の端に組み込む');
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('click', () => {
    const id = dockIdOf(dialog);
    const r = button.getBoundingClientRect();
    if (docked.has(dialog)) layout.openMenu(id, r.left, r.bottom + 2);
    else openUndockedMenu(dialog, layout, r.left, r.bottom + 2);
  });
  placeButton(dialog, button);
}

let undockedMenu: ContextMenu | null = null;

/** The menu of a dialog not docked: which dock. */
function openUndockedMenu(dialog: HTMLDialogElement, layout: DockLayout, x: number, y: number): void {
  undockedMenu ??= new ContextMenu('ウィンドウの配置');
  // Inside the dialog, so that it shows (and takes clicks) above a modal one.
  undockedMenu.element.style.position = 'fixed';
  dialog.append(undockedMenu.element);
  const sides: Array<[DockSide, string]> = [['left', '左に置く'], ['right', '右に置く'], ['bottom', '下に置く']];
  undockedMenu.open(sides.map(([side, label]) => ({ label, run: () => dockDialog(dialog, layout, side) })), x, y);
}

/**
 * Puts an open dialog in the layout: at the end of the dock `where`, at the
 * drop target `where`, or where the layout keeps it. A dialog in a window of
 * its own comes back into the tab for it.
 */
export function dockDialog(dialog: HTMLDialogElement, layout: DockLayout, where?: DockSide | DropTarget): void {
  if (isPoppedOut(dialog)) bringBack(dialog);
  if (!dialog.open) return;
  const id = dockIdOf(dialog);
  const target: DropTarget | undefined = typeof where === 'string' ? { kind: 'split', side: where, index: layout.getState()[where].length } : where;
  if (target?.kind === 'float') {
    // Not docked: a dialog where it was dropped.
    if (docked.has(dialog)) layout.move(id, target);
    else placeAt(dialog, target.rect);
    return;
  }
  if (docked.has(dialog)) {
    if (target) layout.move(id, target);
    return;
  }
  const side = target?.side;
  const record: Docked = { id, place: document.createComment('dock'), modal: dialog.matches(':modal'), style: dialog.getAttribute('style'), undo: [] };
  docked.set(dialog, record);
  dialog.before(record.place);
  for (const name of MOVED_STYLES) dialog.style.removeProperty(name);
  delete dialog.dataset.moved;
  dialog.classList.add('docked');

  // Opening it again (its menu item) brings its tab to the front rather than failing on an open dialog.
  const front = (): void => layout.activate(id);
  dialog.show = front;
  dialog.showModal = front;
  record.undo.push(() => {
    delete (dialog as Partial<HTMLDialogElement>).show;
    delete (dialog as Partial<HTMLDialogElement>).showModal;
  });
  // Closed: out of the layout (its place kept for next time) and back where it was.
  const closed = (): void => undock(dialog, layout, false);
  dialog.addEventListener('close', closed);
  record.undo.push(() => dialog.removeEventListener('close', closed));

  layout.add(
    {
      id,
      title: () => titleOf(dialog),
      element: dialog,
      grip: titleElement(dialog),
      // The dialog's own ◧ opens the layout's menu; the layout's button is not needed.
      placeButton: () => undefined,
      close: () => dialog.close(),
      home: side ?? 'right',
      onFloat: (rect) => undock(dialog, layout, true, rect),
      onEvict: () => undock(dialog, layout, true),
    },
    target,
  );
  layout.activate(id);
}

/** Puts a dialog (not docked) at the page point of `rect`'s top left, as dragging its title would. */
function placeAt(dialog: HTMLDialogElement, rect: FloatRect): void {
  Object.assign(dialog.style, { position: 'fixed', inset: 'auto', margin: '0', transform: 'none', left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top)}px` });
  dialog.dataset.moved = '';
}

/** Takes a dialog out of the layout, back where it was in the page; `float`: open as a dialog again (at `rect`), and its place in the layout forgotten. */
function undock(dialog: HTMLDialogElement, layout: DockLayout, float: boolean, rect?: FloatRect | null): void {
  const record = docked.get(dialog);
  if (!record) return;
  docked.delete(dialog);
  for (const undo of record.undo) undo();
  layout.remove(record.id, float);
  dialog.classList.remove('docked', 'dock-panel', 'dock-inactive');
  if (record.style === null) dialog.removeAttribute('style');
  else dialog.setAttribute('style', record.style);
  if (record.place.isConnected) record.place.replaceWith(dialog);
  else document.body.append(dialog);
  if (!float || !dialog.open) return;
  // Open as it was, modal again if it was.
  if (record.modal) {
    dialog.removeAttribute('open');
    dialog.showModal();
  }
  if (rect) placeAt(dialog, rect);
}

/** Wires the ◧ buttons of every dialog of the page, and docks a dialog that opens where the layout keeps it (once per page). */
export function enableDialogDocking(layout: DockLayout): void {
  const scan = (): void => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
      if (dialog.matches('.dock-float') || 'noDock' in dialog.dataset) continue;
      addButton(dialog, layout);
      if (!docked.has(dialog) && !isPoppedOut(dialog) && layout.remembers(dockIdOf(dialog))) dockDialog(dialog, layout);
    }
  };
  // A dialog gets its button when it opens; its content may be built only then.
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
  scan();

  // A dialog's title dragged out of its own window (⧉) onto the tab: docked where it is dropped, as its tab would be.
  const targetOf = (dialog: HTMLDialogElement, e: DragEvent) => layout.dropTargetAt(dockIdOf(dialog), e.clientX, e.clientY);
  document.addEventListener('dragover', (e) => {
    const dialog = draggedOut();
    if (!dialog) return;
    const found = targetOf(dialog, e);
    layout.previewDrop(found?.rect ?? null);
    if (!found) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  document.addEventListener('dragleave', (e) => {
    // Out of the tab's window.
    if (!e.relatedTarget) layout.previewDrop(null);
  });
  document.addEventListener('drop', (e) => {
    const dialog = draggedOut();
    layout.previewDrop(null);
    if (!dialog) return;
    const found = targetOf(dialog, e);
    if (!found) return;
    e.preventDefault();
    dockDialog(dialog, layout, found.target);
    window.focus();
  });
  document.addEventListener('dragend', () => layout.previewDrop(null));
}
