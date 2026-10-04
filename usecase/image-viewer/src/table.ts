/**
 * The attribute table under the map: the features of the selected vector
 * layer, all of them or only the selected ones. Columns sort, a search box
 * filters, columns can be hidden, and the rows shown can be saved as CSV.
 * Only the rows in view are drawn, so tens of thousands of features stay
 * fast. Clicking a row selects its feature on the map (Ctrl / Shift add to
 * the selection), double-clicking zooms to it. While an Esri layer is being
 * edited, its editable cells are inputs and unsaved values are marked.
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import { listen, type EventsKey } from 'ol/events.js';
import type Target from 'ol/events/Target.js';
import type { EditSession } from './edit-session.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';

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
    private readonly element: HTMLElement,
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

    // Drag the top edge to change the height.
    const handle = document.createElement('div');
    handle.className = 'table-resize';
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('pointerdown', (e) => {
      const start = e.clientY;
      const height = this.scroller_.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => element.style.setProperty('--table-height', `${Math.max(80, height + start - m.clientY)}px`);
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', move), { once: true });
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
    this.data_ = data;
    this.message_ = message;
    this.sort_ = null;
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

  /** Saves the rows shown (filtered, sorted, visible columns) as CSV. */
  downloadCsv(): void {
    const data = this.data_;
    if (!data) return;
    const fields = this.visibleFields_();
    const quote = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [fields.map((f) => quote(f.alias)), ...this.rows_.map((r) => fields.map((f) => quote(display(f, r.get(f.name)))))];
    const blob = new Blob(['\uFEFF', lines.map((l) => l.join(',')).join('\r\n')], { type: 'text/csv' });
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
      this.rebuild_();
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

  /** Filters and sorts the rows again, then draws them. */
  private rebuild_(): void {
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
        rows = rows.slice().sort((a, b) => dir * compare(a.get(field), b.get(field), def));
      }
    }
    this.rows_ = rows;
    this.updateCount_();
    this.renderRows_(true);
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
    }
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
    tr.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) this.selection.toggle(feature);
      else this.selection.set([feature]);
    });
    tr.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('input, select')) return;
      const extent = feature.getGeometry()?.getExtent();
      if (extent) this.map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 18, duration: 250 });
    });
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

/** A value as the table shows it: domain names, local dates, empty for null. */
export function display(field: Field, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.codes) {
    const code = field.codes.find((c) => String(c.code) === String(value));
    if (code) return code.name;
  }
  if (field.type === 'date' && typeof value === 'number') return new Date(value).toLocaleString('ja-JP');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function compare(a: unknown, b: unknown, field?: Field): number {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1; // empty last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = field ? display(field, a) : String(a);
  const y = field ? display(field, b) : String(b);
  return x.localeCompare(y, 'ja', { numeric: true });
}

/** `yyyy-MM-ddTHH:mm` in local time, for a datetime-local input. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
