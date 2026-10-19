/**
 * The panels around the map as a docking layout: the layer panel, the
 * attribute tables, the dashboard and any dialog docked by its ◧ button sit
 * in three docks (left, right and below the map). A dock holds groups (one
 * under another on the sides, side by side below) and a group holds panels
 * as tabs. A panel moves by dragging its tab, or its title when it is alone
 * in its group, onto another group (a tab there, or above / below / beside
 * it), onto an edge of the map (that dock) or onto the map (floating over
 * it, in a window that moves by its title and sizes by its corner); the ◧
 * button and the right-click menu of a tab do the same by name. The layout
 * is kept for the next visit and in project files, and 「レイアウトを元に戻す」
 * puts it back as it first was.
 *
 * By default nothing looks different: the layers on the left, the table
 * below, the dashboard on the right (when open), each alone in its group,
 * so with no tabs shown.
 */
import { ContextMenu, type MenuItem } from './context-menu.js';
import {
  activatePanel,
  defaultDockState,
  DOCK_SIDES,
  findPanel,
  movePanel,
  normalizeDockState,
  placeAtHome,
  removePanel,
  type DockSide,
  type DockState,
  type DropTarget,
  type FloatRect,
} from './dock-state.js';
import { makeResizer } from './resize.js';

/** A panel the layout places. */
export interface DockPanel {
  id: string;
  /** The text of its tab and of its window when floating. */
  title: () => string;
  element: HTMLElement;
  /** Its own title: dragged (and right-clicked) like its tab when the group shows no tabs. */
  grip?: HTMLElement | null;
  /** Where its ◧ button goes (in its own title bar); absent: the group's corner. */
  placeButton?: (button: HTMLButtonElement) => void;
  /** Closes it (its tab gets a ×); absent: it cannot be closed from the layout. */
  close?: () => void;
  /** The dock it goes to when the layout has no place for it. */
  home: DockSide;
  /** …as a tab beside this panel, when that one is docked. */
  homeWith?: string;
  /** Floats it in a way of its own (a dialog goes back to being a dialog) instead of in a window of the layout. */
  onFloat?: (rect: FloatRect | null) => void;
  /** Called instead of placing it at home when a new layout has no place for it (a docked dialog goes back to being a dialog). */
  onEvict?: () => void;
}

export interface DockOptions {
  /** localStorage key of the layout. */
  key?: string;
  /** Called after the docks change size (the map needs updateSize). */
  onResize: () => void;
}

interface GroupView {
  side: DockSide;
  index: number;
  element: HTMLElement;
}

const KEY = 'image-viewer.dock';
const SIDE_NAMES: Record<DockSide, string> = { left: '左', right: '右', bottom: '下' };
/** How far the pointer moves before a press on a tab is a drag, in pixels. */
const SLOP = 5;
/** Where a press is a control's, not a drag of the panel. */
const CONTROL = 'input, select, textarea, button, a, summary, label, [contenteditable]';
const DEFAULT_FLOAT = { width: 440, height: 320 };

export class DockLayout {
  private state_: DockState;
  private readonly panels_ = new Map<string, DockPanel>();
  /** Per panel: its ◧ button and the listeners on its grip. */
  private readonly extras_ = new Map<string, { button: HTMLButtonElement; abort: AbortController }>();
  private readonly docks_: Record<DockSide, HTMLElement>;
  private readonly handles_: Partial<Record<DockSide, HTMLElement>> = {};
  /** Group shells, reused while their group stays, so the panels in them do not move. */
  private readonly shells_ = new WeakMap<object, HTMLElement>();
  private readonly floats_ = new Map<string, HTMLDialogElement>();
  private groups_: GroupView[] = [];
  private readonly menu_ = new ContextMenu('パネルの配置');
  private readonly watcher_: MutationObserver;
  private readonly key_: string;
  private frame_ = 0;
  /** Inside render(): the panel elements' own changes are the layout's. */
  private rendering_ = false;
  /** Listeners of layout changes (to keep it in a project, say). */
  private readonly listeners_ = new Set<() => void>();

  constructor(
    readonly app: HTMLElement,
    private readonly options: DockOptions,
  ) {
    this.key_ = options.key ?? KEY;
    const dock = (side: DockSide): HTMLElement => {
      let el = app.querySelector<HTMLElement>(`.dock[data-dock=${side}]`);
      if (!el) {
        el = document.createElement('div');
        el.className = `dock dock-${side}`;
        el.dataset.dock = side;
        app.append(el);
      }
      el.setAttribute('aria-label', `${SIDE_NAMES[side]}のパネル`);
      return el;
    };
    this.docks_ = { left: dock('left'), right: dock('right'), bottom: dock('bottom') };
    this.state_ = this.load_() ?? defaultDockState();
    // A panel hidden or shown (the dashboard), or folded (the table), changes what its group shows.
    this.watcher_ = new MutationObserver(() => {
      if (!this.rendering_) this.schedule_();
    });
  }

  /** Wires the handles that size the docks (the left one's width, the right one's, the bottom one's height). */
  sizeHandles(handles: Partial<Record<DockSide, HTMLElement>>): void {
    const app = this.app;
    const dock = this.docks_;
    const resize = () => this.options.onResize();
    const left = handles.left;
    if (left) {
      makeResizer({
        handle: left,
        target: app,
        property: '--side-width',
        axis: 'x',
        size: () => dock.left.getBoundingClientRect().width,
        min: () => 160,
        max: () => Math.max(160, window.innerWidth * 0.6),
        key: 'image-viewer.side-width',
        label: '左のパネルの幅',
        onResize: resize,
      });
    }
    const right = handles.right;
    if (right) {
      makeResizer({
        handle: right,
        target: app,
        property: '--dash-width',
        axis: 'x',
        reverse: true,
        size: () => dock.right.getBoundingClientRect().width,
        min: () => 220,
        max: () => Math.max(220, window.innerWidth * 0.6),
        key: 'image-viewer.dash-width',
        label: '右のパネルの幅',
        onResize: resize,
      });
    }
    const bottom = handles.bottom;
    if (bottom) {
      makeResizer({
        handle: bottom,
        target: app,
        property: '--table-height',
        axis: 'y',
        size: () => dock.bottom.getBoundingClientRect().height,
        min: () => 80,
        max: () => Math.max(80, window.innerHeight - 160),
        key: 'image-viewer.table-height',
        label: '下のパネルの高さ',
        onResize: resize,
      });
    }
    Object.assign(this.handles_, handles);
    this.render();
  }

  /** Adds a panel at its place in the layout (or at `target`). */
  add(panel: DockPanel, target?: DropTarget): void {
    this.panels_.set(panel.id, panel);
    this.wire_(panel);
    this.watcher_.observe(panel.element, { attributes: true, attributeFilter: ['hidden', 'class'] });
    if (target) this.state_ = movePanel(this.state_, panel.id, target);
    else this.state_ = placeAtHome(this.state_, panel.id, panel.home, panel.homeWith);
    this.changed_();
  }

  /** Takes a panel out of the layout; `forget`: its place too (else it opens there again). The element is left where it is. */
  remove(id: string, forget = false): void {
    const panel = this.panels_.get(id);
    if (!panel) return;
    this.panels_.delete(id);
    const extra = this.extras_.get(id);
    extra?.abort.abort();
    extra?.button.remove();
    this.extras_.delete(id);
    panel.element.classList.remove('dock-panel', 'dock-inactive');
    panel.grip?.classList.remove('dock-grip');
    const float = this.floats_.get(id);
    if (float) {
      this.floats_.delete(id);
      if (float.contains(panel.element)) float.after(panel.element);
      float.remove();
    }
    if (forget) this.state_ = removePanel(this.state_, id);
    this.changed_();
  }

  has(id: string): boolean {
    return this.panels_.has(id);
  }

  /** Whether the layout keeps a place for `id` (open or not). */
  remembers(id: string): boolean {
    return findPanel(this.state_, id) !== null;
  }

  /** Where the panel is: a dock, 'float', or null. */
  placeOf(id: string): DockSide | 'float' | null {
    return findPanel(this.state_, id)?.side ?? null;
  }

  /** Brings the panel's tab to the front (and its floating window). */
  activate(id: string): void {
    this.state_ = activatePanel(this.state_, id);
    this.changed_();
    this.floats_.get(id)?.focus();
  }

  /** Moves a panel to `target`. */
  move(id: string, target: DropTarget): void {
    const panel = this.panels_.get(id);
    if (!panel) return;
    if (target.kind === 'float' && panel.onFloat) {
      panel.onFloat(target.rect);
      return;
    }
    this.state_ = movePanel(this.state_, id, target);
    this.changed_();
  }

  /** Moves a panel to the end of the dock `side`, as a group of its own. */
  dockTo(id: string, side: DockSide): void {
    this.move(id, { kind: 'split', side, index: this.state_[side].length });
  }

  /** Floats a panel over the map. */
  float(id: string, rect?: FloatRect): void {
    this.move(id, { kind: 'float', rect: rect ?? this.defaultFloat_(id) });
  }

  getState(): DockState {
    return normalizeDockState(this.state_)!;
  }

  /** Puts a layout (null: the first one); the panels it has no place for go to their usual place. */
  setState(state: DockState | null): void {
    this.state_ = (state && normalizeDockState(state)) ?? defaultDockState();
    for (const panel of [...this.panels_.values()]) {
      if (findPanel(this.state_, panel.id)) continue;
      if (panel.onEvict) panel.onEvict();
      else this.state_ = placeAtHome(this.state_, panel.id, panel.home, panel.homeWith);
    }
    this.changed_();
  }

  /** The layout as it first was, the sizes of the docks too. */
  reset(): void {
    for (const property of ['--side-width', '--dash-width', '--table-height']) this.app.style.removeProperty(property);
    try {
      for (const key of ['image-viewer.side-width', 'image-viewer.dash-width', 'image-viewer.table-height']) localStorage.removeItem(key);
    } catch {
      // No storage.
    }
    this.setState(null);
  }

  /** Calls `listener` after each change of the layout. */
  onChange(listener: () => void): () => void {
    this.listeners_.add(listener);
    return () => this.listeners_.delete(listener);
  }

  /** Redraws the tab titles (a layer renamed) and what the groups show. */
  refresh(): void {
    this.render();
  }

  /** Opens the menu of the panel `id` at the page point (`x`, `y`). */
  openMenu(id: string, x: number, y: number): void {
    const panel = this.panels_.get(id);
    if (!panel) return;
    const at = this.placeOf(id);
    const items: MenuItem[] = DOCK_SIDES.map((side) => ({
      label: `${SIDE_NAMES[side]}に置く${at === side ? '（今ここ）' : ''}`,
      disabled: at === side && this.state_[side].length === 1 && this.state_[side][0].panels.length === 1,
      run: () => this.dockTo(id, side),
    }));
    items.push({ label: panel.onFloat ? 'ウィンドウに戻す' : '浮かせる', disabled: at === 'float', run: () => this.float(id) });
    if (panel.close) items.push({ label: '閉じる', run: () => panel.close!() });
    items.push({ label: 'レイアウトを元に戻す', run: () => this.reset() });
    this.menu_.open(items, x, y);
  }

  /** Draws the layout: the docks, their groups and tabs, and the floating windows. */
  render(): void {
    cancelAnimationFrame(this.frame_);
    this.frame_ = 0;
    this.rendering_ = true;
    try {
      this.render_();
    } finally {
      // The observer's records of the layout's own changes are dropped.
      this.watcher_.takeRecords();
      this.rendering_ = false;
    }
    this.options.onResize();
  }

  private render_(): void {
    this.groups_ = [];
    const shown = (p: DockPanel): boolean => !p.element.hidden;
    for (const side of DOCK_SIDES) {
      const dock = this.docks_[side];
      const children: HTMLElement[] = [];
      let last: HTMLElement | null = null;
      this.state_[side].forEach((group, index) => {
        const panels = group.panels.map((id) => this.panels_.get(id)).filter((p): p is DockPanel => p !== undefined);
        if (!panels.length) return;
        // A group whose panels are all hidden (the dashboard closed) stays, hidden, so its panels stay in the page.
        const shell = this.shell_(group);
        const visible = panels.filter(shown);
        const active = visible.find((p) => p.id === group.active) ?? visible[0] ?? panels[0];
        this.fillGroup_(shell, visible.length ? visible : panels, active, panels);
        shell.hidden = visible.length === 0;
        shell.style.flexGrow = String(group.weight ?? 1);
        if (!shell.hidden) {
          if (last) children.push(this.splitter_(side, last, shell));
          last = shell;
          this.groups_.push({ side, index, element: shell });
        }
        children.push(shell);
      });
      syncChildren(dock, children);
      const groups = children.filter((c) => c.matches('.dock-group') && !c.hidden);
      dock.hidden = groups.length === 0;
      dock.classList.toggle('dock-folded', groups.length > 0 && groups.every((c) => c.classList.contains('dock-folded')));
      const handle = this.handles_[side];
      if (handle) handle.hidden = dock.hidden;
      this.app.classList.toggle(`dock-${side}-empty`, dock.hidden);
    }
    // Floating panels.
    for (const [id, rect] of Object.entries(this.state_.float)) {
      const panel = this.panels_.get(id);
      if (panel) this.floatWindow_(panel, rect).hidden = !shown(panel);
    }
    for (const [id, win] of this.floats_) {
      if (this.state_.float[id] && this.panels_.has(id)) continue;
      win.close();
      win.remove();
      this.floats_.delete(id);
    }
    for (const panel of this.panels_.values()) panel.element.classList.add('dock-panel');
  }

  /** The shell of a group (made once per group). */
  private shell_(group: object): HTMLElement {
    let shell = this.shells_.get(group);
    if (shell) return shell;
    shell = document.createElement('section');
    shell.className = 'dock-group';
    const tabs = document.createElement('div');
    tabs.className = 'dock-tabs';
    tabs.setAttribute('role', 'tablist');
    const body = document.createElement('div');
    body.className = 'dock-body';
    shell.append(tabs, body);
    this.shells_.set(group, shell);
    return shell;
  }

  /** The tabs (of the `shown` panels) and the panels of a group, `active` in front. */
  private fillGroup_(shell: HTMLElement, shown: DockPanel[], active: DockPanel, all: DockPanel[]): void {
    const tabs = shell.querySelector<HTMLElement>(':scope > .dock-tabs')!;
    const body = shell.querySelector<HTMLElement>(':scope > .dock-body')!;
    // Alone and with a title of its own: no tab strip, the title is the grip.
    const single = shown.length === 1 && !!active.grip;
    shell.classList.toggle('dock-single', single);
    tabs.hidden = single;
    const tabEls = single ? [] : shown.map((p) => this.tab_(p, p === active));
    // The ◧ of a panel with no place of its own for it: only the front one's, at the end of the tabs or in the corner.
    for (const p of all) if (p !== active && !p.placeButton) this.extras_.get(p.id)?.button.remove();
    const button = active.placeButton ? undefined : this.extras_.get(active.id)?.button;
    syncChildren(tabs, button && !single ? [...tabEls, button] : tabEls);
    if (button) {
      button.classList.toggle('dock-corner', single);
      if (single && button.parentElement !== shell) shell.append(button);
    }
    for (const p of all) {
      if (p.element.parentElement !== body) body.append(p.element);
      p.element.classList.toggle('dock-inactive', p !== active);
    }
    shell.classList.toggle('dock-folded', active.element.classList.contains('collapsed'));
  }

  /** A tab of a group. */
  private tab_(panel: DockPanel, active: boolean): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'dock-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.dataset.panel = panel.id;
    const label = document.createElement('span');
    label.textContent = panel.title();
    tab.title = label.textContent;
    tab.append(label);
    if (panel.close) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'dock-tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `${label.textContent}を閉じる`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.close!();
      });
      tab.append(close);
    }
    tab.addEventListener('click', () => this.activate(panel.id));
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1 && panel.close) panel.close();
    });
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') this.activate(panel.id);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = (e.key === 'ArrowRight' ? tab.nextElementSibling : tab.previousElementSibling) as HTMLElement | null;
        if (next?.matches('.dock-tab')) {
          this.activate(next.dataset.panel!);
          tab.parentElement?.querySelector<HTMLElement>(`.dock-tab[data-panel="${CSS.escape(next.dataset.panel!)}"]`)?.focus();
        }
      } else return;
      e.preventDefault();
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openMenu(panel.id, e.clientX, e.clientY);
    });
    tab.addEventListener('pointerdown', (e) => {
      if (!(e.target as Element).closest('button')) this.press_(panel.id, e);
    });
    return tab;
  }

  /** The handle between two groups of a dock, dragged to share its length between them. */
  private splitter_(side: DockSide, before: HTMLElement, after: HTMLElement): HTMLElement {
    const split = document.createElement('div');
    split.className = 'dock-split';
    split.setAttribute('role', 'separator');
    split.setAttribute('aria-orientation', side === 'bottom' ? 'vertical' : 'horizontal');
    split.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x = side === 'bottom';
      const size = (el: HTMLElement) => (x ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
      const a0 = size(before);
      const b0 = size(after);
      const start = x ? e.clientX : e.clientY;
      const groups = this.groups_;
      const ga = groups.find((g) => g.element === before);
      const gb = groups.find((g) => g.element === after);
      if (!ga || !gb) return;
      const stateA = this.state_[side][ga.index];
      const stateB = this.state_[side][gb.index];
      const total = (stateA.weight ?? 1) + (stateB.weight ?? 1);
      split.setPointerCapture(e.pointerId);
      document.body.classList.add(x ? 'resizing-x' : 'resizing-y');
      const move = (m: PointerEvent) => {
        const d = (x ? m.clientX : m.clientY) - start;
        const a = Math.max(40, Math.min(a0 + b0 - 40, a0 + d));
        stateA.weight = (total * a) / (a0 + b0);
        stateB.weight = total - stateA.weight;
        before.style.flexGrow = String(stateA.weight);
        after.style.flexGrow = String(stateB.weight);
        this.options.onResize();
      };
      const end = () => {
        split.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing-x', 'resizing-y');
        this.save_();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', end, { once: true });
      split.addEventListener('pointercancel', end, { once: true });
    });
    split.addEventListener('dblclick', () => {
      for (const g of this.state_[side]) delete g.weight;
      this.changed_();
    });
    return split;
  }

  /** The ◧ button and the grip of a panel. */
  private wire_(panel: DockPanel): void {
    this.extras_.get(panel.id)?.abort.abort();
    this.extras_.get(panel.id)?.button.remove();
    const abort = new AbortController();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock-button';
    button.textContent = '◧';
    button.title = '配置（左・右・下に置く、浮かせる）。タブや見出しをドラッグしても動かせます';
    button.setAttribute('aria-label', `${panel.title()}の配置`);
    button.setAttribute('aria-haspopup', 'menu');
    button.addEventListener('click', () => {
      const r = button.getBoundingClientRect();
      this.openMenu(panel.id, r.left, r.bottom + 2);
    });
    panel.placeButton?.(button);
    this.extras_.set(panel.id, { button, abort });
    const grip = panel.grip;
    if (grip) {
      grip.classList.add('dock-grip');
      grip.addEventListener('pointerdown', (e) => {
        if (!(e.target as Element).closest(CONTROL)) this.press_(panel.id, e);
      }, { signal: abort.signal });
      grip.addEventListener('contextmenu', (e) => {
        if ((e.target as Element).closest(CONTROL)) return;
        e.preventDefault();
        this.openMenu(panel.id, e.clientX, e.clientY);
      }, { signal: abort.signal });
    }
  }

  /** A press on a tab or grip: past the slop, a drag of the panel to a new place. */
  private press_(id: string, e: PointerEvent): void {
    if (e.button !== 0 || !this.panels_.has(id)) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let drop: HTMLElement | null = null;
    let target: DropTarget | null = null;
    const move = (m: PointerEvent): void => {
      if (m.pointerId !== e.pointerId) return;
      if (!ghost) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) < SLOP) return;
        ghost = document.createElement('div');
        ghost.className = 'dock-ghost';
        ghost.textContent = this.panels_.get(id)?.title() ?? '';
        drop = document.createElement('div');
        drop.className = 'dock-drop';
        document.body.append(drop, ghost);
        document.documentElement.classList.add('dock-dragging');
        document.getSelection()?.removeAllRanges();
      }
      m.preventDefault();
      ghost.style.left = `${m.clientX + 12}px`;
      ghost.style.top = `${m.clientY + 12}px`;
      const found = this.targetAt_(id, m.clientX, m.clientY);
      target = found?.target ?? null;
      drop!.hidden = !found;
      if (found) {
        const r = found.rect;
        Object.assign(drop!.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      }
    };
    const end = (u: PointerEvent): void => {
      if (u.pointerId !== e.pointerId) return;
      stop();
      if (ghost && target && u.type === 'pointerup') this.move(id, target);
    };
    const key = (k: KeyboardEvent): void => {
      if (k.key !== 'Escape') return;
      target = null;
      stop();
    };
    const stop = (): void => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      document.removeEventListener('keydown', key, true);
      ghost?.remove();
      drop?.remove();
      document.documentElement.classList.remove('dock-dragging');
      // The click that ends a drag is not a click on the tab.
      if (ghost) {
        const swallow = (c: MouseEvent): void => c.stopPropagation();
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, true), 0);
      }
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    document.addEventListener('keydown', key, true);
  }

  /** Where dropping the panel `id` at (`x`, `y`) puts it, and the area to show. */
  private targetAt_(id: string, x: number, y: number): { target: DropTarget; rect: DOMRect } | null {
    const at = findPanel(this.state_, id);
    for (const g of this.groups_) {
      const r = g.element.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const across = g.side === 'bottom';
      const f = across ? (x - r.left) / r.width : (y - r.top) / r.height;
      const alone = at && at.side === g.side && at.group === g.index && this.state_[g.side][g.index].panels.length === 1;
      if (f < 0.25 || f > 0.75) {
        if (alone) return null;
        const after = f > 0.75;
        const half = across
          ? new DOMRect(after ? r.left + r.width / 2 : r.left, r.top, r.width / 2, r.height)
          : new DOMRect(r.left, after ? r.top + r.height / 2 : r.top, r.width, r.height / 2);
        return { target: { kind: 'split', side: g.side, index: g.index + (after ? 1 : 0) }, rect: half };
      }
      if (alone) return null;
      return { target: { kind: 'tab', side: g.side, group: g.index }, rect: r };
    }
    const map = this.app.querySelector<HTMLElement>('.map');
    if (!map) return null;
    const m = map.getBoundingClientRect();
    if (x < m.left || x > m.right || y < m.top || y > m.bottom) return null;
    const edge = Math.min(80, m.width * 0.15);
    const edgeY = Math.min(80, m.height * 0.2);
    const end = (side: DockSide): DropTarget => ({ kind: 'split', side, index: this.state_[side].length });
    if (x < m.left + edge) return { target: end('left'), rect: new DOMRect(m.left, m.top, Math.min(280, m.width / 3), m.height) };
    if (x > m.right - edge) {
      const w = Math.min(320, m.width / 3);
      return { target: end('right'), rect: new DOMRect(m.right - w, m.top, w, m.height) };
    }
    if (y > m.bottom - edgeY) {
      const h = Math.min(260, m.height / 3);
      return { target: end('bottom'), rect: new DOMRect(m.left, m.bottom - h, m.width, h) };
    }
    const size = at?.side === 'float' ? at.rect : DEFAULT_FLOAT;
    const rect = clampRect({ left: x - 40, top: y - 12, width: size.width, height: size.height });
    return { target: { kind: 'float', rect }, rect: new DOMRect(rect.left, rect.top, rect.width, rect.height) };
  }

  /** A floating place for a panel: over the middle of the map. */
  private defaultFloat_(id: string): FloatRect {
    const el = this.panels_.get(id)?.element;
    const map = this.app.querySelector<HTMLElement>('.map')?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
    const width = Math.min(Math.max(DEFAULT_FLOAT.width, el?.getBoundingClientRect().width ?? 0), map.width - 32);
    const height = Math.min(Math.max(DEFAULT_FLOAT.height, Math.min(480, el?.getBoundingClientRect().height ?? 0)), map.height - 32);
    return clampRect({ left: map.left + (map.width - width) / 2, top: map.top + (map.height - height) / 2, width, height });
  }

  /** The window of a floating panel (made once), at `rect`. */
  private floatWindow_(panel: DockPanel, rect: FloatRect): HTMLDialogElement {
    let win = this.floats_.get(panel.id);
    if (!win) {
      win = document.createElement('dialog');
      win.className = 'dock-float';
      win.dataset.panel = panel.id;
      // Its panel belongs to the layout: not into a window of its own (pop-out.ts).
      win.dataset.noPopOut = '';
      const head = document.createElement('div');
      head.className = 'catalog-head dock-float-head';
      const title = document.createElement('h2');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'catalog-close';
      close.textContent = '×';
      const back = panel.close ? '閉じる' : '元の場所に戻す';
      close.title = back;
      close.setAttribute('aria-label', back);
      close.addEventListener('click', () => {
        if (panel.close) panel.close();
        else this.move(panel.id, { kind: 'split', side: panel.home, index: this.state_[panel.home].length });
      });
      head.append(title, close);
      const body = document.createElement('div');
      body.className = 'dock-body';
      win.append(head, body);
      document.body.append(win);
      this.floats_.set(panel.id, win);
      // Moved by its title (move-windows.ts) or sized by its corner: kept.
      const keep = (): void => {
        const r = this.state_.float[panel.id];
        if (!r || win!.hidden || !win!.open) return;
        const b = win!.getBoundingClientRect();
        if (!b.width) return;
        const now = { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) };
        if (now.left === r.left && now.top === r.top && now.width === r.width && now.height === r.height) return;
        this.state_.float[panel.id] = now;
        this.save_();
      };
      win.addEventListener('pointerup', () => requestAnimationFrame(keep));
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => keep()).observe(win);
    }
    win.querySelector('h2')!.textContent = panel.title();
    const body = win.querySelector<HTMLElement>(':scope > .dock-body')!;
    if (panel.element.parentElement !== body) body.append(panel.element);
    panel.element.classList.remove('dock-inactive');
    const extra = this.extras_.get(panel.id);
    if (extra && !panel.placeButton && extra.button.parentElement !== win.firstElementChild) win.querySelector('.catalog-close')!.before(extra.button);
    extra?.button.classList.remove('dock-corner');
    win.hidden = false;
    const r = clampRect(rect);
    Object.assign(win.style, { position: 'fixed', inset: 'auto', margin: '0', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (!win.open) win.show();
    return win;
  }

  private schedule_(): void {
    if (!this.frame_) this.frame_ = requestAnimationFrame(() => this.render());
  }

  private changed_(): void {
    this.save_();
    this.render();
  }

  private save_(): void {
    try {
      localStorage.setItem(this.key_, JSON.stringify(this.state_));
    } catch {
      // No storage: the layout lasts until the page closes.
    }
    for (const listener of this.listeners_) listener();
  }

  private load_(): DockState | null {
    try {
      const text = localStorage.getItem(this.key_);
      return text ? normalizeDockState(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }
}

/** A floating window's place kept on the screen (its title at least). */
function clampRect(r: FloatRect): FloatRect {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  const width = Math.round(Math.max(200, Math.min(r.width, w)));
  const height = Math.round(Math.max(120, Math.min(r.height, h)));
  return { left: Math.round(Math.max(0, Math.min(r.left, w - Math.min(width, 120)))), top: Math.round(Math.max(0, Math.min(r.top, h - 40))), width, height };
}

/** Makes `parent`'s children exactly `children`, moving only those out of place (a moved element loses its scroll position). */
function syncChildren(parent: HTMLElement, children: HTMLElement[]): void {
  children.forEach((child, i) => {
    const now = parent.children[i];
    if (now !== child) parent.insertBefore(child, now ?? null);
  });
  while (parent.children.length > children.length) parent.lastElementChild!.remove();
}
