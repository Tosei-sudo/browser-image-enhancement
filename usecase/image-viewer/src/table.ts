/**
 * The attribute table under the map: the features of the selected vector
 * layer, all of them or only the selected ones. Columns sort, a search box
 * filters, columns can be hidden, and the rows shown can be saved as CSV.
 * Only the rows in view are drawn, so tens of thousands of features stay
 * fast. Clicking a row selects its feature on the map; Ctrl adds to the
 * selection or takes out, Shift selects the rows in between, and the check
 * boxes do the same (the one in the header: every row shown). Double-clicking
 * zooms to the feature, and right-clicking opens a menu that zooms to the
 * selected features, copies their rows and, for a layer that allows it,
 * deletes them. While an Esri layer is being edited, its editable cells are
 * inputs and unsaved values are marked.
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import { listen, type EventsKey } from 'ol/events.js';
import type Target from 'ol/events/Target.js';
import { createEmpty, extend } from 'ol/extent.js';
import { ContextMenu, type MenuItem } from './context-menu.js';
import type { EditSession } from './edit-session.js';
import { makeResizer } from './resize.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';
import { compareValues, display, localInput, toCsv, toTsv } from './table-text.js';

const ROW_HEIGHT = 28;

/** What the table shows. */
export interface TableData {
  title: string;
  fields: Field[];
  /** The features, as they are now. */
  features: () => Feature[];
  /** Note shown after the count (for example that only the first features were read). */
  note?: string;
  /** Things that change the features (a vector source, an edit session): the table redraws on their events. */
  watch?: Target[];
  /** Deletes features (asking first); only for layers that allow deleting. */
  onDelete?: (features: Feature[]) => void;
}

export type TableMode = 'all' | 'selected';

export class AttributeTable {
  private data_: TableData | null = null;
  private message_ = '';
  private mode_: TableMode = 'all';
  private sort_: { field: string; dir: 1 | -1 } | null = null;
  private query_ = '';
  private readonly hidden_ = new Map<string, Set<string>>();
  private rows_: Feature[] = [];
  private session_: EditSession | null = null;
  private keys_: EventsKey[] = [];
  private frame_ = 0;
  /** The row a Shift click selects from. */
  private anchor_: Feature | null = null;
  private readonly menu_ = new ContextMenu('選択した地物');
  private readonly all_: HTMLInputElement;

  private readonly title_: HTMLElement;
  private readonly count_: HTMLElement;
  private readonly modes_: Record<TableMode, HTMLButtonElement>;
  private readonly search_: HTMLInputElement;
  private readonly columns_: HTMLDetailsElement;
  private readonly csv_: HTMLButtonElement;
  private readonly scroller_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly empty_: HTMLElement;

  constructor(
    readonly element: HTMLElement,
    private readonly map: OlMap,
    private readonly selection: Selection,
    private readonly options: { say: (message: string) => void },
  ) {
    element.classList.add('table-panel');
    const bar = document.createElement('div');
    bar.className = 'table-bar';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'table-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', '属性テーブルを開閉');
    toggle.textContent = '▾';
    toggle.addEventListener('click', () => this.setCollapsed(!this.isCollapsed()));

    this.title_ = document.createElement('h2');
    this.title_.textContent = '属性テーブル';
    this.count_ = document.createElement('span');
    this.count_.className = 'table-count';

    const modes = document.createElement('div');
    modes.className = 'table-modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '表示する地物');
    const mode = (m: TableMode, text: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => this.setMode(m));
      modes.append(b);
      return b;
    };
    this.modes_ = { all: mode('all', '全件'), selected: mode('selected', '選択中のみ') };

    this.search_ = document.createElement('input');
    this.search_.type = 'search';
    this.search_.placeholder = '検索';
    this.search_.setAttribute('aria-label', '属性を検索');
    this.search_.addEventListener('input', () => {
      this.query_ = this.search_.value.trim().toLowerCase();
      this.rebuild_();
    });

    this.columns_ = document.createElement('details');
    this.columns_.className = 'table-columns';
    this.columns_.innerHTML = '<summary>列</summary><div></div>';

    this.csv_ = document.createElement('button');
    this.csv_.type = 'button';
    this.csv_.textContent = 'CSV 保存';
    this.csv_.addEventListener('click', () => this.downloadCsv());

    bar.append(toggle, this.title_, this.count_, modes, this.search_, this.columns_, this.csv_);

    this.scroller_ = document.createElement('div');
    this.scroller_.className = 'table-scroll';
    this.table_ = document.createElement('table');
    this.table_.className = 'attributes';
    this.table_.append(document.createElement('thead'), document.createElement('tbody'));
    this.empty_ = document.createElement('p');
    this.empty_.className = 'table-empty';
    this.scroller_.append(this.table_, this.empty_);
    this.scroller_.addEventListener('scroll', () => this.renderRows_());
    this.scroller_.tabIndex = 0;
    this.scroller_.setAttribute('aria-label', '属性テーブルの行');
    this.scroller_.addEventListener('keydown', (e) => this.keydown_(e));

    this.all_ = document.createElement('input');
    this.all_.type = 'checkbox';
    this.all_.setAttribute('aria-label', '表示中の行をすべて選択');
    this.all_.addEventListener('change', () => {
      if (this.all_.checked) this.selection.add(this.rows_);
      else this.selection.remove(this.rows_);
    });

    // Drag the top edge to change the height.
    const handle = document.createElement('div');
    handle.className = 'table-resize';
    makeResizer({
      handle,
      target: element,
      property: '--table-height',
      axis: 'y',
      size: () => this.scroller_.getBoundingClientRect().height,
      min: () => 80,
      max: () => Math.max(80, window.innerHeight - 200),
      key: 'image-viewer.table-height',
      label: '属性テーブルの高さ',
      onResize: () => map.updateSize(),
    });

    element.append(handle, bar, this.scroller_);
    selection.on('change', () => {
      if (this.mode_ === 'selected') this.rebuild_();
      else this.renderRows_();
      this.updateCount_();
    });
    this.setMode('all');
    this.show(null, 'WFS・Esri のレイヤーを選ぶと属性を表示します');
  }

  /** Shows `data` (null: nothing, with `message`). */
  show(data: TableData | null, message = ''): void {
    unByKey(this.keys_);
    this.keys_ = [];
    // The same layer again (its editing started or ended): keep the sorting.
    if (data?.title !== this.data_?.title || data?.fields !== this.data_?.fields) {
      this.sort_ = null;
      this.anchor_ = null;
    }
    this.data_ = data;
    this.message_ = message;
    this.menu_.close();
    this.title_.textContent = data ? `属性テーブル: ${data.title}` : '属性テーブル';
    for (const w of data?.watch ?? []) {
      for (const type of ['change', 'addfeature', 'removefeature', 'changefeature', 'clear']) {
        this.keys_.push(listen(w, type, () => this.schedule_()));
      }
    }
    this.buildHead_();
    this.rebuild_();
  }

  /** Makes editable cells inputs for the features of this edit session (null: no editing). */
  setSession(session: EditSession | null): void {
    this.session_ = session;
    this.element.classList.toggle('editing', !!session);
    this.renderRows_();
  }

  getMode(): TableMode {
    return this.mode_;
  }

  setMode(mode: TableMode): void {
    this.mode_ = mode;
    for (const [m, b] of Object.entries(this.modes_)) b.setAttribute('aria-pressed', String(m === mode));
    this.rebuild_();
  }

  isCollapsed(): boolean {
    return this.element.classList.contains('collapsed');
  }

  setCollapsed(collapsed: boolean): void {
    this.element.classList.toggle('collapsed', collapsed);
    this.element.querySelector('.table-toggle')!.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) this.renderRows_();
    this.map.updateSize();
  }

  /** The features in the rows now, in row order. */
  rows(): readonly Feature[] {
    return this.rows_;
  }

  /** Scrolls the row of `feature` into view. */
  scrollTo(feature: Feature): void {
    const i = this.rows_.indexOf(feature);
    if (i < 0) return;
    const top = i * ROW_HEIGHT;
    const view = this.scroller_.clientHeight - ROW_HEIGHT; // under the sticky header
    if (top < this.scroller_.scrollTop || top > this.scroller_.scrollTop + view - ROW_HEIGHT) this.scroller_.scrollTop = Math.max(0, top - view / 2);
    this.renderRows_();
  }

  /** Puts the first editable cell of `feature` in focus. */
  focusRow(feature: Feature): void {
    this.scrollTo(feature);
    const i = this.rows_.indexOf(feature);
    requestAnimationFrame(() => this.table_.querySelector<HTMLElement>(`tr[data-index="${i}"] :is(input, select)`)?.focus());
  }

  /** Zooms the map to `features`. */
  zoomTo(features: Feature[]): void {
    const extent = createEmpty();
    for (const f of features) {
      const e = f.getGeometry()?.getExtent();
      if (e) extend(extent, e);
    }
    if (!Number.isFinite(extent[0])) return;
    // A single point has an empty extent: fit still centers it, at zoom 18.
    this.map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 18, duration: 250 });
  }

  /** Copies the rows of `features` (visible columns, with a header) as tab-separated text, for a spreadsheet. */
  async copyRows(features: Feature[]): Promise<void> {
    const text = toTsv(this.visibleFields_(), features);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) {
        this.options.say('コピーできませんでした');
        return;
      }
    }
    this.options.say(`${features.length} 行をコピーしました（タブ区切り）`);
  }

  /** Opens the row menu for `feature` at the page point (`x`, `y`); a row not selected becomes the selection first. */
  openMenu(feature: Feature, x: number, y: number): void {
    if (!this.selection.has(feature)) {
      this.selection.set([feature]);
      this.anchor_ = feature;
    }
    const features = this.selectedRows_();
    const n = features.length;
    const several = n > 1 ? `選択中の ${n.toLocaleString()} 件` : '';
    const items: MenuItem[] = [
      { label: several ? `${several}にズーム` : '地物にズーム', run: () => this.zoomTo(features) },
      { label: several ? `${several}の行をコピー` : '行をコピー', run: () => void this.copyRows(features) },
      { label: '選択を解除', run: () => this.selection.clear() },
    ];
    const remove = this.data_?.onDelete;
    if (remove) items.push({ label: several ? `${several}を削除…` : '削除…', danger: true, run: () => remove(features) });
    this.menu_.open(items, x, y);
  }

  /** The selected features of this table, in row order (those filtered out by the search included, at the end). */
  private selectedRows_(): Feature[] {
    const shown = this.rows_.filter((f) => this.selection.has(f));
    const seen = new Set(shown);
    const all = new Set(this.data_?.features() ?? []);
    return [...shown, ...this.selection.list().filter((f) => !seen.has(f) && all.has(f))];
  }

  /** A click on a row (or its check box): plain selects it, Ctrl adds or takes out, Shift selects from the last clicked row. */
  private pick_(feature: Feature, e: MouseEvent, checkbox = false): void {
    const add = e.ctrlKey || e.metaKey || checkbox;
    const from = this.anchor_ ? this.rows_.indexOf(this.anchor_) : -1;
    const to = this.rows_.indexOf(feature);
    if (e.shiftKey && from >= 0 && to >= 0) {
      const range = this.rows_.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (add) this.selection.add(range);
      else this.selection.set(range);
      return; // the anchor stays, so the range can be changed
    }
    if (add) this.selection.toggle(feature);
    else this.selection.set([feature]);
    this.anchor_ = feature;
  }

  /** Keys on the table: Ctrl+A selects the rows shown, Escape clears, Delete deletes, the menu key opens the menu. */
  private keydown_(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input:not([type="checkbox"]), select') || !this.data_) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') this.selection.add(this.rows_);
    else if (e.key === 'Escape' && !this.menu_.isOpen()) this.selection.clear();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.data_.onDelete && this.selectedRows_().length) this.data_.onDelete(this.selectedRows_());
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const feature = this.selectedRows_()[0];
      if (!feature) return;
      this.scrollTo(feature);
      const box = (this.table_.querySelector(`tr[data-index="${this.rows_.indexOf(feature)}"]`) ?? this.scroller_).getBoundingClientRect();
      this.openMenu(feature, box.left + 24, box.bottom);
    } else return;
    e.preventDefault();
  }

  /** Saves the rows shown (filtered, sorted, visible columns) as CSV. */
  downloadCsv(): void {
    const data = this.data_;
    if (!data) return;
    const blob = new Blob(['\uFEFF', toCsv(this.visibleFields_(), this.rows_)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.title.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    this.options.say(`${this.rows_.length} 行を CSV に保存しました`);
  }

  private hiddenFields_(): Set<string> {
    const key = this.data_?.title ?? '';
    if (!this.hidden_.has(key)) this.hidden_.set(key, new Set());
    return this.hidden_.get(key)!;
  }

  private visibleFields_(): Field[] {
    const hidden = this.hiddenFields_();
    return (this.data_?.fields ?? []).filter((f) => !hidden.has(f.name));
  }

  private schedule_(): void {
    if (this.frame_) return;
    this.frame_ = requestAnimationFrame(() => {
      this.frame_ = 0;
      // A cell being typed in stays (its row is redrawn once the rows shown change).
      this.rebuild_(!this.typing_());
    });
  }

  private buildHead_(): void {
    const head = this.table_.tHead!;
    const list = this.columns_.querySelector('div')!;
    list.replaceChildren();
    const hidden = this.hiddenFields_();
    for (const field of this.data_?.fields ?? []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !hidden.has(field.name);
      box.addEventListener('change', () => {
        if (box.checked) hidden.delete(field.name);
        else hidden.add(field.name);
        this.buildHead_();
        this.renderRows_(true);
      });
      label.append(box, field.alias);
      list.append(label);
    }
    const tr = document.createElement('tr');
    const check = document.createElement('th');
    check.className = 'check';
    check.scope = 'col';
    check.append(this.all_);
    tr.append(check);
    for (const field of this.visibleFields_()) {
      const th = document.createElement('th');
      th.scope = 'col';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = field.alias;
      button.title = field.alias === field.name ? field.name : `${field.alias}（${field.name}）`;
      const sorted = this.sort_?.field === field.name ? this.sort_.dir : 0;
      th.setAttribute('aria-sort', sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : 'none');
      button.addEventListener('click', () => {
        // Ascending, descending, then as read.
        this.sort_ = sorted === 0 ? { field: field.name, dir: 1 } : sorted === 1 ? { field: field.name, dir: -1 } : null;
        this.buildHead_();
        this.rebuild_();
      });
      th.append(button);
      tr.append(th);
    }
    head.replaceChildren(tr);
    this.csv_.disabled = !this.data_;
    this.search_.disabled = !this.data_;
  }

  /** Whether an input or select in the rows has the focus. */
  private typing_(): boolean {
    const active = document.activeElement;
    return !!active && this.table_.tBodies[0].contains(active) && active.matches('input:not([type="checkbox"]), select');
  }

  /** Filters and sorts the rows again, then draws them (`force`: even when the same rows are in view). */
  private rebuild_(force = true): void {
    const data = this.data_;
    let rows: Feature[] = [];
    if (data) {
      const all = data.features();
      rows = this.mode_ === 'selected' ? all.filter((f) => this.selection.has(f)) : all;
      if (this.query_) {
        const fields = this.visibleFields_();
        rows = rows.filter((f) => fields.some((field) => display(field, f.get(field.name)).toLowerCase().includes(this.query_)));
      }
      if (this.sort_) {
        const { field, dir } = this.sort_;
        const def = data.fields.find((f) => f.name === field);
        rows = rows.slice().sort((a, b) => dir * compareValues(a.get(field), b.get(field), def));
      }
    }
    this.rows_ = rows;
    this.updateCount_();
    this.renderRows_(force);
  }

  private updateCount_(): void {
    const data = this.data_;
    if (!data) {
      this.count_.textContent = '';
      return;
    }
    const total = data.features().length;
    const selected = this.selection.list().length;
    const unsaved = this.session_ ? `・未保存 ${this.session_.count()} 件` : '';
    this.count_.textContent = `全 ${total.toLocaleString()} 件・選択 ${selected.toLocaleString()} 件${unsaved}${data.note ? `（${data.note}）` : ''}`;
  }

  private drawn_ = '';

  /** Draws the rows in view (and a few around them); `force` redraws them even when the same. */
  private renderRows_(force = false): void {
    const body = this.table_.tBodies[0];
    const data = this.data_;
    const empty = !data ? this.message_ : this.rows_.length === 0 ? (this.mode_ === 'selected' ? '選択中の地物はありません。地図か「全件」の行をクリックして選んでください' : '該当する地物はありません') : '';
    this.empty_.textContent = empty;
    this.empty_.hidden = !empty;
    if (!data || this.isCollapsed()) {
      body.replaceChildren();
      this.drawn_ = '';
      return;
    }
    const top = this.scroller_.scrollTop;
    const height = this.scroller_.clientHeight || 300;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 5);
    const last = Math.min(this.rows_.length, Math.ceil((top + height) / ROW_HEIGHT) + 5);
    const key = `${first}:${last}:${this.rows_.length}`;
    // Keep the rows (and a cell being typed in) when only the selection changed.
    if (!force && key === this.drawn_ && body.contains(document.activeElement)) {
      this.markSelected_();
      return;
    }
    this.drawn_ = key;
    const fields = this.visibleFields_();
    const spacer = (h: number) => {
      const tr = document.createElement('tr');
      tr.className = 'spacer';
      tr.style.height = `${h}px`;
      return tr;
    };
    const rows: HTMLTableRowElement[] = [spacer(first * ROW_HEIGHT)];
    for (let i = first; i < last; i++) rows.push(this.row_(this.rows_[i], i, fields));
    rows.push(spacer((this.rows_.length - last) * ROW_HEIGHT));
    body.replaceChildren(...rows);
    this.markSelected_();
  }

  private markSelected_(): void {
    for (const tr of this.table_.tBodies[0].querySelectorAll<HTMLTableRowElement>('tr[data-index]')) {
      const f = this.rows_[Number(tr.dataset.index)];
      const selected = !!f && this.selection.has(f);
      tr.classList.toggle('selected', selected);
      tr.setAttribute('aria-selected', String(selected));
      const box = tr.querySelector<HTMLInputElement>('td.check input');
      if (box) box.checked = selected;
    }
    let count = 0;
    for (const f of this.rows_) if (this.selection.has(f)) count++;
    this.all_.checked = count > 0 && count === this.rows_.length;
    this.all_.indeterminate = count > 0 && count < this.rows_.length;
    this.all_.disabled = this.rows_.length === 0;
  }

  private row_(feature: Feature, index: number, fields: Field[]): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.index = String(index);
    const session = this.session_;
    if (session?.isAdded(feature)) tr.classList.add('added');
    const error = session?.errorOf(feature);
    if (error) {
      tr.classList.add('failed');
      tr.title = `保存できませんでした: ${error}`;
    }
    tr.addEventListener('mousedown', (e) => {
      // Shift click selects rows, not text.
      if (e.shiftKey && !(e.target as HTMLElement).closest('input, select')) e.preventDefault();
    });
    tr.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      this.pick_(feature, e);
    });
    tr.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      this.zoomTo([feature]);
    });
    tr.addEventListener('contextmenu', (e) => {
      // Inputs keep the browser's own menu (paste and so on).
      if ((e.target as HTMLElement).closest('input:not([type="checkbox"]), select')) return;
      e.preventDefault();
      this.openMenu(feature, e.clientX, e.clientY);
    });
    const check = document.createElement('td');
    check.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('aria-label', '選択');
    box.addEventListener('click', (e) => this.pick_(feature, e, true));
    check.append(box);
    tr.append(check);
    for (const field of fields) {
      const td = document.createElement('td');
      const value = feature.get(field.name);
      if (session?.isDirty(feature, field.name)) td.classList.add('dirty');
      if (session && this.session_ && session.canEdit(feature, field)) td.append(this.input_(feature, field, value));
      else {
        td.textContent = display(field, value);
        if (value === null || value === undefined) td.classList.add('null');
        if (field.type === 'integer' || field.type === 'double' || field.type === 'oid') td.classList.add('number');
      }
      tr.append(td);
    }
    return tr;
  }

  /** An input for an editable cell, shaped by the field's type and domain. */
  private input_(feature: Feature, field: Field, value: unknown): HTMLInputElement | HTMLSelectElement {
    const commit = (text: string, control: HTMLInputElement | HTMLSelectElement) => {
      const error = this.session_?.setAttribute(feature, field, text) ?? null;
      control.setCustomValidity(error ?? '');
      if (error) {
        control.reportValidity();
        this.options.say(error);
      } else {
        control.closest('td')?.classList.add('dirty');
        this.updateCount_();
      }
    };
    const label = `${field.alias}`;
    if (field.codes) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', label);
      if (field.nullable) select.append(new Option('', ''));
      for (const c of field.codes) select.append(new Option(c.name, String(c.code)));
      select.value = value === null || value === undefined ? '' : String(value);
      select.addEventListener('change', () => commit(select.value, select));
      return select;
    }
    const input = document.createElement('input');
    input.setAttribute('aria-label', label);
    if (field.type === 'integer' || field.type === 'double') {
      input.type = 'number';
      input.step = field.type === 'integer' ? '1' : 'any';
      if (field.range) [input.min, input.max] = field.range.map(String);
      input.value = value === null || value === undefined ? '' : String(value);
    } else if (field.type === 'date') {
      input.type = 'datetime-local';
      input.value = typeof value === 'number' ? localInput(value) : '';
    } else {
      input.type = 'text';
      if (field.length) input.maxLength = field.length;
      input.value = value === null || value === undefined ? '' : String(value);
    }
    input.addEventListener('change', () => commit(input.value, input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    return input;
  }
}
