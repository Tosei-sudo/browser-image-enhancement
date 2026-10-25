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
 * inputs and unsaved values are marked. Values that are URLs or file paths
 * are links (cell-links.ts).
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import { unByKey } from 'ol/Observable.js';
import { listen, type EventsKey } from 'ol/events.js';
import type Target from 'ol/events/Target.js';
import { createEmpty, extend } from 'ol/extent.js';
import type { CellLink } from './cell-links.js';
import { ContextMenu, type MenuItem } from './context-menu.js';
import { ALIAS_EVENT, fieldHeading, fieldLabel, originalAlias, setFieldAlias } from './field-alias.js';
import type { EditSession } from './edit-session.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';
import { compareValues, display, localInput, toCsv, toTsv } from './table-text.js';

const ROW_HEIGHT = 28;
/** Where the table keeps whether headings show attribute names instead of aliases. */
const RAW_NAMES_KEY = 'image-viewer.table-raw-names';

function storedRawNames(): boolean {
  try {
    return localStorage.getItem(RAW_NAMES_KEY) === '1';
  } catch {
    return false;
  }
}


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
  /** The layer's definition query, when it has one (the 「条件」 button is marked). */
  definition?: string;
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
  /** Headings show the attribute names, not the aliases. */
  private rawNames_ = storedRawNames();
  private readonly onAlias_ = (e: Event) => {
    if (this.data_?.fields.includes((e as CustomEvent<Field>).detail)) this.buildHead_();
  };
  private rows_: Feature[] = [];
  private session_: EditSession | null = null;
  private keys_: EventsKey[] = [];
  private selectionKey_: EventsKey | EventsKey[] = [];
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
  private pin_: HTMLButtonElement | null = null;
  private queryButton_: HTMLButtonElement | null = null;
  private readonly scroller_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly empty_: HTMLElement;

  constructor(
    readonly element: HTMLElement,
    private readonly map: OlMap,
    private readonly selection: Selection,
    private readonly options: {
      say: (message: string) => void;
      /** A link to the viewer showing `features` (`?geom=`), or null when they are too many for a link. */
      shapeLink?: (features: Feature[]) => string | null;
      /** More commands for the selected features (copying them as GeoJSON or WKT), after the copy ones. */
      menuItems?: (features: Feature[]) => MenuItem[];
      /** Opens the attribute query dialog on the layer shown (「条件」: selecting by attributes, the definition query); absent: no such button. */
      onQuery?: () => void;
      /** Opens another table for the layer shown, kept on it (「固定」); absent: no such button. */
      onPin?: () => void;
      /** The table's own name, before the layer's (default 「属性テーブル」). */
      heading?: string;
      /** Makes URL and path values links, and opens them (cell-links.ts); absent: plain text. */
      links?: { linkOf(value: unknown): CellLink | null; open(link: CellLink, tab?: boolean): Promise<void> };
    },
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
    this.title_.textContent = options.heading ?? '属性テーブル';
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
    window.addEventListener(ALIAS_EVENT, this.onAlias_);

    this.csv_ = document.createElement('button');
    this.csv_.type = 'button';
    this.csv_.textContent = 'CSV 保存';
    this.csv_.addEventListener('click', () => this.downloadCsv());

    bar.append(toggle, this.title_, this.count_, modes, this.search_);
    if (options.onQuery) {
      this.queryButton_ = document.createElement('button');
      this.queryButton_.type = 'button';
      this.queryButton_.className = 'table-query';
      this.queryButton_.textContent = '条件';
      this.queryButton_.title = '属性条件・SQL による選択、既定クエリ（地図とテーブルの絞り込み）';
      this.queryButton_.addEventListener('click', () => options.onQuery!());
      bar.append(this.queryButton_);
    }
    bar.append(this.columns_, this.csv_);
    if (options.onPin) {
      this.pin_ = document.createElement('button');
      this.pin_.type = 'button';
      this.pin_.className = 'table-pin';
      this.pin_.textContent = '固定';
      this.pin_.title = 'このレイヤーの属性テーブルをもう1つ表示。別のレイヤーを選んでも残るため、複数並べて比較可能';
      this.pin_.addEventListener('click', () => options.onPin!());
      bar.append(this.pin_);
    }

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

    element.append(bar, this.scroller_);
    this.selectionKey_ = selection.on('change', () => {
      if (this.mode_ === 'selected') this.rebuild_();
      else this.renderRows_();
      this.updateCount_();
    });
    this.setMode('all');
    this.show(null, 'WFS・Esri のレイヤーを選ぶと属性を表示');
  }

  /** The table's title (「属性テーブル: レイヤー名」), which also drags it to another place (dock.ts). */
  get heading(): HTMLElement {
    return this.title_;
  }

  /** The title of what it shows (the layer's name), or null. */
  dataTitle(): string | null {
    return this.data_?.title ?? null;
  }

  /** Stops following the selection and the layer (the table is closed for good). */
  dispose(): void {
    unByKey(this.keys_);
    unByKey(this.selectionKey_);
    window.removeEventListener(ALIAS_EVENT, this.onAlias_);
    cancelAnimationFrame(this.frame_);
    this.menu_.close();
    this.menu_.element.remove();
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
    const heading = this.options.heading ?? '属性テーブル';
    this.title_.textContent = data ? `${heading}: ${data.title}` : heading;
    if (this.pin_) this.pin_.disabled = !data;
    if (this.queryButton_) {
      this.queryButton_.disabled = !data;
      this.queryButton_.classList.toggle('filtered', !!data?.definition);
      this.queryButton_.title = data?.definition ? `既定クエリで絞り込み中: ${data.definition}` : '属性条件・SQL による選択、既定クエリ（地図とテーブルの絞り込み）';
    }
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

  /** Copies a link that shows `features` in the viewer (as a temporary layer), for mail or chat. */
  async copyShapeLink(features: Feature[]): Promise<void> {
    const link = this.options.shapeLink?.(features);
    if (!link) {
      this.options.say('図形が大きすぎてリンク化不可（頂点の削減か、ファイルへの書き出しが必要）');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      this.options.say(`図形 ${features.length.toLocaleString()} 個を表示するリンクをコピー`);
    } catch {
      this.options.say(`リンクのコピーに失敗: ${link.length > 200 ? `${link.slice(0, 200)}…` : link}`);
    }
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
        this.options.say('コピー失敗');
        return;
      }
    }
    this.options.say(`${features.length} 行をコピー（タブ区切り）`);
  }

  /** Opens the row menu for `feature` at the page point (`x`, `y`); a row not selected becomes the selection first. `link`: of the cell clicked. */
  openMenu(feature: Feature, x: number, y: number, link: CellLink | null = null): void {
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
    if (this.options.shapeLink) items.splice(2, 0, { label: several ? `${several}の図形のリンクをコピー` : '図形のリンクをコピー', run: () => void this.copyShapeLink(features) });
    if (this.options.menuItems) items.splice(items.length - 1, 0, ...this.options.menuItems(features));
    const links = this.options.links;
    if (link && links) {
      const target = link.kind === 'url' ? link.url : link.path;
      items.unshift(
        { label: link.viewer ? 'リンク先を地図に表示' : 'リンク先を開く', run: () => void links.open(link) },
        ...(link.viewer ? [{ label: 'リンク先を新しいタブで開く', run: () => void links.open(link, true) }] : []),
        { label: link.kind === 'url' ? 'URL をコピー' : 'パスをコピー', run: () => void this.copyText_(target, link.kind === 'url' ? 'URL をコピー' : 'パスをコピー') },
      );
    }
    const remove = this.data_?.onDelete;
    if (remove) items.push({ label: several ? `${several}を削除…` : '削除…', danger: true, run: () => remove(features) });
    this.menu_.open(items, x, y);
  }

  private async copyText_(text: string, done: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.options.say(done);
    } catch {
      this.options.say(`コピー失敗: ${text}`);
    }
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
    this.options.say(`${this.rows_.length} 行を CSV に保存`);
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

  /** Shows attribute names (true) or aliases in the headings. */
  setRawNames(raw: boolean): void {
    this.rawNames_ = raw;
    try {
      localStorage.setItem(RAW_NAMES_KEY, raw ? '1' : '0');
    } catch {
      // kept for this page only
    }
    this.buildHead_();
  }

  /** Opens the 「列」 list with the alias of `field` being typed. */
  editAlias(field: Field): void {
    this.columns_.open = true;
    this.buildHead_(field);
  }

  private buildHead_(editing: Field | null = null): void {
    const head = this.table_.tHead!;
    const list = this.columns_.querySelector('div')!;
    list.replaceChildren();
    const hidden = this.hiddenFields_();
    if (this.data_?.fields.length) {
      const raw = document.createElement('label');
      raw.className = 'table-raw-names';
      raw.title = 'エイリアス（表示名）ではなく属性名を見出しに表示';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.rawNames_;
      box.addEventListener('change', () => this.setRawNames(box.checked));
      raw.append(box, '属性名で表示');
      list.append(raw);
    }
    for (const field of this.data_?.fields ?? []) {
      const row = document.createElement('div');
      row.className = 'table-column';
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
      label.append(box);
      label.title = fieldLabel(field);
      if (field === editing) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'table-alias';
        input.value = fieldHeading(field);
        input.placeholder = originalAlias(field) || field.name;
        input.setAttribute('aria-label', `${field.name} のエイリアス`);
        let done = false;
        const finish = (save: boolean) => {
          if (done) return;
          done = true;
          if (save && setFieldAlias(field, input.value)) this.options.say(`${field.name} のエイリアスを「${fieldHeading(field)}」に変更`);
          this.buildHead_();
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
          else return;
          e.preventDefault();
          e.stopPropagation();
        });
        input.addEventListener('blur', () => finish(true));
        row.append(label, input);
        list.append(row);
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
        continue;
      }
      label.append(this.rawNames_ ? field.name : fieldHeading(field));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'table-alias-edit';
      edit.textContent = '✎';
      edit.title = `エイリアスの変更（属性名 ${field.name}）`;
      edit.setAttribute('aria-label', `${field.name} のエイリアスを変更`);
      edit.addEventListener('click', () => this.buildHead_(field));
      row.append(label, edit);
      list.append(row);
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
      button.textContent = this.rawNames_ ? field.name : fieldHeading(field);
      button.title = this.rawNames_ && fieldHeading(field) !== field.name ? `${field.name}（${fieldHeading(field)}）` : fieldLabel(field);
      const sorted = this.sort_?.field === field.name ? this.sort_.dir : 0;
      th.setAttribute('aria-sort', sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : 'none');
      button.addEventListener('click', () => {
        // Ascending, descending, then as read.
        this.sort_ = sorted === 0 ? { field: field.name, dir: 1 } : sorted === 1 ? { field: field.name, dir: -1 } : null;
        this.buildHead_();
        this.rebuild_();
      });
      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const hide = () => {
          this.hiddenFields_().add(field.name);
          this.buildHead_();
          this.renderRows_(true);
        };
        this.menu_.open(
          [
            { label: 'エイリアスの変更…', run: () => this.editAlias(field) },
            { label: this.rawNames_ ? 'エイリアスで表示' : '属性名で表示', run: () => this.setRawNames(!this.rawNames_) },
            { label: 'この列を非表示', run: hide },
          ],
          e.clientX,
          e.clientY,
        );
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
    const empty = !data ? this.message_ : this.rows_.length === 0 ? (this.mode_ === 'selected' ? '選択中の地物なし。地図か「全件」の行をクリックして選択' : '該当する地物なし') : '';
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
      tr.title = `保存失敗: ${error}`;
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
      if ((e.target as HTMLElement).closest('input, select, .cell-link')) return;
      this.zoomTo([feature]);
    });
    tr.addEventListener('contextmenu', (e) => {
      // Inputs keep the browser's own menu (paste and so on).
      if ((e.target as HTMLElement).closest('input:not([type="checkbox"]), select')) return;
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cell-link');
      this.openMenu(feature, e.clientX, e.clientY, cell ? this.options.links?.linkOf(cell.dataset.value) ?? null : null);
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
        const link = field.codes ? null : this.options.links?.linkOf(value);
        if (link) td.append(this.link_(link, display(field, value), value as string));
        else td.textContent = display(field, value);
        if (value === null || value === undefined) td.classList.add('null');
        if (field.type === 'integer' || field.type === 'double' || field.type === 'oid') td.classList.add('number');
      }
      tr.append(td);
    }
    return tr;
  }

  /**
   * A link in a cell: a click opens it (on the map when the viewer shows it,
   * otherwise in a new tab); with Ctrl, Shift or the middle button, a URL
   * opens in a new tab as links do. It does not select the row.
   */
  private link_(link: CellLink, text: string, value: string): HTMLElement {
    const links = this.options.links!;
    const a = document.createElement('a');
    a.className = 'cell-link';
    a.textContent = text;
    a.dataset.value = value;
    if (link.kind === 'url') {
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = link.viewer ? `${link.url}\nクリックで地図に表示、Ctrl+クリックで新しいタブ` : link.url;
    } else {
      // A browser does not open a local path itself: pathMappings and the folders allowed for them do.
      a.href = '#';
      a.title = `${link.path}\n${link.viewer ? 'クリックで地図に表示' : 'クリックで新しいタブに表示'}（config.json の pathMappings で対応付け）`;
    }
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = e.ctrlKey || e.metaKey || e.shiftKey;
      if (link.kind === 'url' && (!link.viewer || tab)) return; // the browser opens it
      e.preventDefault();
      void links.open(link, tab);
    });
    a.addEventListener('auxclick', (e) => {
      if (link.kind !== 'path' || e.button !== 1) return;
      e.preventDefault();
      void links.open(link, true);
    });
    return a;
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
    const label = fieldHeading(field);
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
