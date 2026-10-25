/**
 * 「分類体系の編集」: the classification of the observations' kinds
 * (taxonomy.ts) as a tree to edit in place — drag a class onto another to
 * put it below, onto the top or bottom edge of one to put it before or after
 * it; rename it where it stands (F2 or a double click), add a class below
 * (＋), delete one with its branch (two clicks). The chosen class's own
 * settings wait at the right: the names of its branch's levels, what an
 * individual is called, its known individuals, its specifications (諸元:
 * length, width, other names, country… — the fields are the user's, under
 * 「諸元の項目」) and reference photos (files kept in the browser, or URLs).
 * A class's specifications and photos stand for the classes below it until
 * one of them says otherwise.
 *
 * Every change goes through the 「観測記録」 panel, so renaming, moving or
 * deleting a class rewrites the kinds of the records under it, and is kept
 * where the panel keeps the classification.
 */
import type { ObservationPanel } from './observation-panel.js';
import { living } from './observations.js';
import { addPhoto, isLocalPhoto, photoThumb, removePhoto, showPhoto } from './taxon-photos.js';
import { childrenOf, find, kindOf, levelName, nameLabelOf, pathOf, photosAt, specsAt, specText, within, type SpecField, type Taxon } from './taxonomy.js';

type Zone = 'before' | 'after' | 'inside';

const split = (v: string) =>
  v
    .split(/[,、\n]/)
    .map((w) => w.trim())
    .filter(Boolean);

export class TaxonomyEditor {
  readonly dialog: HTMLDialogElement;
  private readonly tree_: HTMLElement;
  private readonly detail_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly query_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private readonly fields_: HTMLElement;
  /** The specification fields as being edited, until saved. */
  private fieldsDraft_: SpecField[] | null = null;
  /** The chosen class (by kind). */
  private selected_: string | null = null;
  /** The folded classes (by kind). */
  private readonly folded_ = new Set<string>();
  /** The class being renamed, or below which one is being added (by kind; '' adds a top class). */
  private editing_: { kind: string; mode: 'rename' | 'add' } | null = null;
  private dragged_: string[] | null = null;

  constructor(
    private readonly panel: ObservationPanel,
    button: HTMLButtonElement | null,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service taxed-dialog';
    this.dialog.setAttribute('aria-labelledby', 'taxed-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="taxed-title">分類体系の編集</h2>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <div class="taxed-bar">
        <input type="search" name="q" placeholder="分類・個体名の検索" aria-label="分類・個体名の検索" />
        <button type="button" value="add-root" title="大分類の追加（「船舶 > 支援船」で階層ごと）">＋ 大分類</button>
        <button type="button" value="expand" title="すべて展開">展開</button>
        <button type="button" value="fold" title="すべて折りたたみ">折りたたみ</button>
      </div>
      <div class="taxed-body">
        <div class="taxed-tree" role="tree" aria-label="分類体系" tabindex="0"></div>
        <section class="taxed-detail"></section>
      </div>
      <p class="service-status" role="status"></p>
      <details class="catalog-more taxed-fields">
        <summary>諸元の項目</summary>
        <div class="taxed-fields-body"></div>
      </details>
      <div class="taxed-foot">
        <span class="obs-note"></span>
        <button type="button" value="export" title="分類体系の JSON 保存（config.json の observationVocabulary.taxonomy に記載可）">JSON 保存</button>
        <button type="button" value="import" title="分類体系の JSON 読み込み（現在の分類と置き換え）">JSON 読み込み</button>
        <input type="file" name="file" accept=".json,application/json" hidden />
      </div>`;
    document.body.append(this.dialog);
    const $ = <T extends Element>(s: string) => this.dialog.querySelector<T>(s)!;
    this.tree_ = $('.taxed-tree');
    this.detail_ = $('.taxed-detail');
    this.status_ = $('.service-status');
    this.query_ = $('input[name=q]');
    this.note_ = $('.obs-note');
    this.fields_ = $('.taxed-fields-body');
    $('.taxed-fields').addEventListener('toggle', () => this.renderFields_());

    button?.addEventListener('click', () => void this.open());
    $('.catalog-close').addEventListener('click', () => this.dialog.close());
    this.query_.addEventListener('input', () => this.render());
    $('button[value=add-root]').addEventListener('click', () => this.startAdd(''));
    $('button[value=expand]').addEventListener('click', () => {
      this.folded_.clear();
      this.render();
    });
    $('button[value=fold]').addEventListener('click', () => {
      for (const t of this.panel.taxonomy()) if (childrenOf(this.panel.taxonomy(), t.path).length) this.folded_.add(kindOf(t.path));
      this.render();
    });
    $('button[value=export]').addEventListener('click', () => this.panel.saveTaxonomy());
    const file = $<HTMLInputElement>('input[name=file]');
    $('button[value=import]').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      try {
        const value = JSON.parse(await chosen.text()) as unknown;
        const list = Array.isArray(value) ? value : (value as { taxonomy?: unknown })?.taxonomy;
        if (!Array.isArray(list)) throw new Error('分類の配列なし');
        await this.panel.setTaxonomy(list);
      } catch (error) {
        this.say_(`分類の読み込み失敗: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.tree_.addEventListener('keydown', (e) => this.key_(e));
    // A drop on the tree's bare space puts a class at the top, last.
    this.tree_.addEventListener('dragover', (e) => {
      if (!this.dragged_ || (e.target as HTMLElement).closest('.taxed-row')) return;
      e.preventDefault();
      this.tree_.classList.add('drop-root');
    });
    this.tree_.addEventListener('dragleave', (e) => {
      if (e.target === this.tree_) this.tree_.classList.remove('drop-root');
    });
    this.tree_.addEventListener('drop', (e) => {
      this.tree_.classList.remove('drop-root');
      if (!this.dragged_ || (e.target as HTMLElement).closest('.taxed-row')) return;
      e.preventDefault();
      const path = this.dragged_;
      this.dragged_ = null;
      void this.move(path, [], null);
    });
    this.panel.dialog.addEventListener('obs-change', () => this.dialog.open && !this.editing_ && this.render());
    this.panel.dialog.addEventListener('obs-say', (e) => this.dialog.open && this.say_((e as CustomEvent<string>).detail));
  }

  /** Opens the editor, on a class when given. */
  async open(path: readonly string[] | null = null): Promise<void> {
    if (!this.dialog.open) this.dialog.show();
    if (path?.length) this.selected_ = kindOf(path);
    await this.panel.loaded();
    this.render();
  }

  /** Chooses a class (null: none). */
  select(path: readonly string[] | null): void {
    this.selected_ = path?.length ? kindOf(path) : null;
    this.render();
    this.tree_.querySelector<HTMLElement>('.taxed-row[aria-selected=true]')?.focus({ preventScroll: false });
  }

  /** Moves a class below `parent` ([] the top), before a sibling (null: last); the records under it follow. */
  async move(path: readonly string[], parent: readonly string[], before: readonly string[] | null): Promise<void> {
    if (within(kindOf(parent), path) && parent.length) return this.say_('自身の下位への移動は不可');
    this.selected_ = kindOf([...parent, path[path.length - 1]]);
    await this.panel.updateClass(path, { parent, before });
  }

  /** Starts adding a class below one ('' the top). */
  startAdd(kind: string): void {
    this.editing_ = { kind, mode: 'add' };
    if (kind) this.folded_.delete(kind);
    this.render();
  }

  /** Starts renaming a class where it stands. */
  startRename(kind: string): void {
    this.editing_ = { kind, mode: 'rename' };
    this.render();
  }

  // ---- inside ----

  private say_(message: string): void {
    this.status_.textContent = message;
  }

  /** The tree and the chosen class. */
  render(): void {
    const list = this.panel.taxonomy();
    if (this.selected_ && !find(list, pathOf(this.selected_))) this.selected_ = null;
    this.note_.textContent = `保存先: ${this.panel.taxonomyStoreLabel()}・${list.length} 分類`;
    const flows = this.panel.flows();
    const records = living(this.panel.records());
    const q = this.query_.value.trim().toLowerCase();
    // Searching (names, known individuals, specifications such as 別名・英名): the classes that match (by name or a known individual) and the classes above them.
    const matches = q ? list.filter((t) => [t.path[t.path.length - 1], ...(t.members ?? []), ...Object.values(t.specs ?? {})].some((v) => v.toLowerCase().includes(q))) : list;
    const shown = q ? new Set(list.filter((t) => matches.some((m) => within(kindOf(m.path), t.path))).map((t) => kindOf(t.path))) : null;
    const rows: HTMLElement[] = [];
    const walk = (parent: string[]) => {
      for (const t of childrenOf(list, parent)) {
        const kind = kindOf(t.path);
        if (shown && !shown.has(kind)) continue;
        const children = childrenOf(list, t.path).length;
        const folded = !q && this.folded_.has(kind);
        rows.push(this.row_(list, t, children > 0, folded, flows.filter((f) => within(f.kind, t.path)).length, records.filter((o) => within(o.kind, t.path)).length, !!q && matches.includes(t)));
        if (this.editing_?.mode === 'add' && this.editing_.kind === kind) rows.push(this.adder_(list, t.path));
        if (!folded) walk(t.path);
      }
    };
    walk([]);
    if (this.editing_?.mode === 'add' && this.editing_.kind === '') rows.push(this.adder_(list, []));
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'obs-note';
      empty.textContent = q ? '該当なし' : '分類なし（「＋ 大分類」から）';
      rows.push(empty);
    }
    this.tree_.replaceChildren(...rows);
    this.tree_.querySelector<HTMLInputElement>('.taxed-row input, .taxed-add input')?.focus();
    this.renderDetail_(list, flows.length);
    this.renderFields_();
  }

  /** One class in the tree. */
  private row_(list: Taxon[], t: Taxon, branch: boolean, folded: boolean, things: number, count: number, hit: boolean): HTMLElement {
    const kind = kindOf(t.path);
    const depth = t.path.length - 1;
    const row = document.createElement('div');
    row.className = `taxed-row${hit ? ' hit' : ''}`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(kind === this.selected_));
    if (branch) row.setAttribute('aria-expanded', String(!folded));
    row.dataset.kind = kind;
    row.tabIndex = kind === this.selected_ ? 0 : -1;
    row.draggable = !this.editing_;
    row.style.paddingInlineStart = `${depth * 1.2 + 0.2}em`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'taxed-toggle';
    toggle.textContent = branch ? (folded ? '▸' : '▾') : '';
    toggle.tabIndex = -1;
    toggle.disabled = !branch;
    toggle.setAttribute('aria-label', folded ? '展開' : '折りたたみ');
    toggle.addEventListener('click', () => {
      if (folded) this.folded_.delete(kind);
      else this.folded_.add(kind);
      this.render();
    });
    row.append(toggle);
    if (this.editing_?.mode === 'rename' && this.editing_.kind === kind) {
      const input = document.createElement('input');
      input.value = t.path[depth];
      input.setAttribute('aria-label', '分類名');
      const done = (save: boolean) => {
        if (!this.editing_) return;
        this.editing_ = null;
        const name = input.value.trim();
        if (save && name && name !== t.path[depth]) {
          this.selected_ = kindOf([...t.path.slice(0, -1), name]);
          void this.panel.updateClass(t.path, { name });
        } else this.render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        else if (e.key === 'Escape') {
          e.preventDefault();
          done(false);
        }
      });
      input.addEventListener('blur', () => done(true));
      row.append(input);
    } else {
      const name = document.createElement('span');
      name.className = 'taxed-name';
      name.textContent = t.path[depth];
      name.title = `${kind}（ダブルクリック・F2 で名前の変更）`;
      name.addEventListener('dblclick', () => this.startRename(kind));
      row.append(name);
    }
    const level = document.createElement('span');
    level.className = 'taxed-level';
    level.textContent = levelName(list, t.path, depth);
    const counts = document.createElement('span');
    counts.className = 'taxed-count';
    counts.textContent = things || count ? `モノ ${things}・記録 ${count}` : '';
    if (t.members?.length) counts.textContent += `${counts.textContent ? '・' : ''}個体 ${t.members.length}`;
    const actions = document.createElement('span');
    actions.className = 'taxed-actions';
    const action = (label: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.tabIndex = -1;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        run(b);
      });
      return b;
    };
    actions.append(
      action('＋', `${levelName(list, t.path, depth + 1) || '下位分類'}の追加`, () => this.startAdd(kind)),
      action('✎', '名前の変更（F2）', () => this.startRename(kind)),
      action('×', `削除（下位分類も。記録 ${count} 件の種別は上位の分類に）`, (b) => this.arm_(b, t.path)),
    );
    row.append(level, counts, actions);
    row.addEventListener('click', () => {
      if (this.selected_ !== kind) this.select(t.path);
    });
    // Drag: onto the middle of a class puts it below; onto the top or bottom edge, before or after it.
    row.addEventListener('dragstart', (e) => {
      this.dragged_ = t.path;
      e.dataTransfer?.setData('text/plain', kind);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragged_ = null;
      row.classList.remove('dragging');
      this.clearDrop_();
    });
    row.addEventListener('dragover', (e) => {
      const zone = this.zone_(row, e.clientY, t.path);
      if (!zone) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.clearDrop_();
      row.classList.add(`drop-${zone}`);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      const zone = this.zone_(row, e.clientY, t.path);
      const path = this.dragged_;
      this.clearDrop_();
      if (!zone || !path) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragged_ = null;
      void this.dropped_(path, t.path, zone);
    });
    return row;
  }

  /** Where a drag over a row would put the dragged class; null where it cannot go. */
  private zone_(row: HTMLElement, y: number, target: readonly string[]): Zone | null {
    const path = this.dragged_;
    if (!path || within(kindOf(target), path)) return null;
    const rect = row.getBoundingClientRect();
    const at = (y - rect.top) / Math.max(1, rect.height);
    return at < 0.25 ? 'before' : at > 0.75 ? 'after' : 'inside';
  }

  private clearDrop_(): void {
    for (const el of this.tree_.querySelectorAll('.drop-before, .drop-after, .drop-inside')) el.classList.remove('drop-before', 'drop-after', 'drop-inside');
    this.tree_.classList.remove('drop-root');
  }

  private async dropped_(path: string[], target: readonly string[], zone: Zone): Promise<void> {
    if (zone === 'inside') {
      this.folded_.delete(kindOf(target));
      return this.move(path, target, null);
    }
    const parent = target.slice(0, -1);
    if (zone === 'before') return this.move(path, parent, target);
    // After: before the next sibling other than itself, else last.
    const siblings = childrenOf(this.panel.taxonomy(), parent).filter((t) => kindOf(t.path) !== kindOf(path));
    const next = siblings[siblings.findIndex((t) => kindOf(t.path) === kindOf(target)) + 1];
    return this.move(path, parent, next ? next.path : null);
  }

  /** Two clicks delete: the first arms the button. */
  private arm_(button: HTMLButtonElement, path: readonly string[]): void {
    if (button.dataset.armed === '1') {
      void this.panel.removeClass(path);
      return;
    }
    button.dataset.armed = '1';
    button.textContent = '削除?';
    button.classList.add('armed');
    this.say_(`もう一度で「${kindOf(path)}」を削除`);
    setTimeout(() => {
      if (!button.isConnected) return;
      button.dataset.armed = '';
      button.textContent = '×';
      button.classList.remove('armed');
    }, 4000);
  }

  /** The row where a class's name is typed to add it below `parent`. */
  private adder_(list: Taxon[], parent: readonly string[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'taxed-add';
    row.style.paddingInlineStart = `${parent.length * 1.2 + 1.6}em`;
    const input = document.createElement('input');
    input.placeholder = `${levelName(list, parent, parent.length) || (parent.length ? '下位分類' : '大分類')}の名前（Enter で追加、「A > B」で階層ごと）`;
    input.setAttribute('aria-label', '追加する分類の名前');
    const done = (save: boolean) => {
      if (!this.editing_) return;
      this.editing_ = null;
      const names = pathOf(input.value);
      if (save && names.length) {
        this.selected_ = kindOf([...parent, ...names]);
        void this.panel.addClass([...parent, ...names]);
      } else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    });
    input.addEventListener('blur', () => done(true));
    row.append(input);
    return row;
  }

  /** Keys in the tree: ↑↓ choose, ←→ fold, Alt+↑↓ reorder, F2 rename, Insert add below, Delete delete. */
  private key_(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).matches('input')) return;
    const rows = [...this.tree_.querySelectorAll<HTMLElement>('.taxed-row')];
    const at = rows.findIndex((r) => r.dataset.kind === this.selected_);
    const current = at >= 0 ? pathOf(rows[at].dataset.kind!) : null;
    const go = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (row) this.select(pathOf(row.dataset.kind!));
    };
    if (e.key === 'ArrowDown' && !e.altKey) go(at + 1);
    else if (e.key === 'ArrowUp' && !e.altKey) go(at < 0 ? 0 : at - 1);
    else if (!current) return;
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      const parent = current.slice(0, -1);
      const siblings = childrenOf(this.panel.taxonomy(), parent);
      const i = siblings.findIndex((t) => kindOf(t.path) === kindOf(current));
      if (e.key === 'ArrowUp' && i > 0) void this.move(current, parent, siblings[i - 1].path);
      else if (e.key === 'ArrowDown' && i < siblings.length - 1) void this.move(current, parent, siblings[i + 2]?.path ?? null);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const kind = kindOf(current);
      if (e.key === 'ArrowLeft' && !this.folded_.has(kind) && rows[at].hasAttribute('aria-expanded')) this.folded_.add(kind);
      else if (e.key === 'ArrowLeft' && current.length > 1) this.selected_ = kindOf(current.slice(0, -1));
      else if (e.key === 'ArrowRight') this.folded_.delete(kind);
      this.render();
      this.tree_.querySelector<HTMLElement>('.taxed-row[aria-selected=true]')?.focus();
    } else if (e.key === 'F2') this.startRename(kindOf(current));
    else if (e.key === 'Insert') this.startAdd(kindOf(current));
    else if (e.key === 'Delete') {
      const button = rows[at].querySelector<HTMLButtonElement>('.taxed-actions button:last-child');
      if (button) this.arm_(button, current);
    } else return;
    e.preventDefault();
  }

  /** The chosen class's settings. */
  private renderDetail_(list: Taxon[], allThings: number): void {
    const path = this.selected_ ? pathOf(this.selected_) : null;
    const t = path ? find(list, path) : undefined;
    if (!t || !path) {
      const hint = document.createElement('p');
      hint.className = 'obs-note';
      hint.textContent = `分類の選択で詳細を表示（モノ ${allThings}）。ドラッグで移動（行の上端・下端で前後、中央で下位）、Alt+↑↓ で並べ替え、F2 で名前の変更、Insert で下位分類の追加`;
      this.detail_.replaceChildren(hint);
      return;
    }
    const depth = path.length - 1;
    // The branch's levels: down to this class, and further while they are named.
    const levels = Array.from({ length: path.length }, (_, i) => levelName(list, path, i) || '—');
    for (let i = path.length; levelName(list, path, i); i++) levels.push(levelName(list, path, i));
    this.detail_.innerHTML = `
      <h3></h3>
      <p class="obs-note taxed-levels"></p>
      <div class="service-form">
        <label>名前<input name="name" autocomplete="off" /></label>
        <label>上位<select name="parent"><option value="">（なし: 大分類）</option></select></label>
        <label class="wide" title="大分類から順に、読点区切り。この分類より下の枝はここが優先">この枝の階層名<input name="levels" autocomplete="off" placeholder="大分類、種別、級" /></label>
        <label class="wide" title="最下位の個体（実名）の呼び方">個体名の呼称<input name="label" autocomplete="off" placeholder="艦名・機番" /></label>
        <label class="wide" title="この分類の既知の個体（実名）。記録時にモノ欄へ入力で分類も自動入力">既知の個体（1 行に 1 つ、読点区切りも可）<textarea name="members" rows="4"></textarea></label>
        <fieldset class="wide taxed-specs"><legend>諸元</legend></fieldset>
        <fieldset class="wide taxed-photos"><legend>参考写真</legend>
          <div class="taxed-photo-list"></div>
          <div class="obs-inline">
            <input name="photo-url" type="url" autocomplete="off" placeholder="画像の URL（共有向け）" aria-label="参考写真の URL" />
            <button type="button" value="photo-url">URL 追加</button>
            <button type="button" value="photo-file" title="このコンピューターの画像（このブラウザのみに保存）">ファイル追加</button>
            <input type="file" name="photo-file" accept="image/*" multiple hidden />
          </div>
          <p class="obs-note taxed-photo-note"></p>
        </fieldset>
        <div class="service-actions wide">
          <button type="submit" class="primary">変更</button>
          <button type="button" value="things" title="この分類以下のモノを観測記録の一覧に表示">モノ一覧</button>
          <button type="button" value="add" title="下位分類の追加（Insert）">下位分類の追加</button>
        </div>
      </div>`;
    this.detail_.querySelector('h3')!.textContent = `${kindOf(path)}（${levelName(list, path, depth) || `第 ${depth + 1} 階層`}）`;
    this.detail_.querySelector('.taxed-levels')!.textContent = `階層: ${levels.join(' › ')}${nameLabelOf(list, path) ? ` › ${nameLabelOf(list, path)}` : ''}`;
    const input = (name: string) => this.detail_.querySelector<HTMLInputElement>(`[name=${name}]`)!;
    input('name').value = path[depth];
    input('levels').value = (t.levels ?? []).join('、');
    input('label').value = t.nameLabel ?? '';
    input('members').value = (t.members ?? []).join('\n');
    const parent = this.detail_.querySelector<HTMLSelectElement>('select[name=parent]')!;
    for (const x of list) if (!within(kindOf(x.path), path)) parent.add(new Option(kindOf(x.path), kindOf(x.path)));
    parent.value = kindOf(path.slice(0, -1));
    // Specifications: a field per row; what a class above says shows faintly until this class says otherwise.
    const specsBox = this.detail_.querySelector('.taxed-specs')!;
    const inherited = specsAt(list, path);
    const fields = this.panel.specFields();
    const extra = Object.keys(t.specs ?? {}).filter((k) => !fields.some((f) => f.name === k));
    const specInputs = new Map<string, HTMLInputElement>();
    for (const f of [...fields, ...extra.map((name): SpecField => ({ name, type: 'text' }))]) {
      const label = document.createElement('label');
      label.textContent = f.unit ? `${f.name}（${f.unit}）` : f.name;
      const box = document.createElement('input');
      box.name = `spec-${f.name}`;
      box.autocomplete = 'off';
      if (f.type === 'number') box.inputMode = 'decimal';
      if (f.type === 'url') box.type = 'url';
      box.value = t.specs?.[f.name] ?? '';
      const above = inherited.get(f.name);
      if (above && kindOf(above.from) !== kindOf(path)) {
        box.placeholder = `${specText(f, above.value)}（${above.from[above.from.length - 1]}）`;
        box.title = `上位の分類「${kindOf(above.from)}」の値。入力でこの分類以下を上書き`;
      } else if (f.type === 'list') box.placeholder = '読点区切り';
      label.append(box);
      specsBox.append(label);
      specInputs.set(f.name, box);
    }
    if (!specInputs.size) specsBox.append(Object.assign(document.createElement('p'), { className: 'obs-note', textContent: '項目なし（下の「諸元の項目」で追加）' }));
    const specsOfInputs = () => {
      const out: Record<string, string> = {};
      for (const [name, box] of specInputs) if (box.value.trim()) out[name] = box.value.trim();
      return out;
    };
    this.renderPhotos_(list, path, t);
    const apply = () =>
      void this.panel
        .updateClass(path, {
          name: input('name').value,
          parent: pathOf(parent.value),
          levels: split(input('levels').value),
          nameLabel: input('label').value.trim(),
          members: split(input('members').value),
          specs: specsOfInputs(),
        })
        .then(() => {
          const name = input('name').value.trim() || path[depth];
          this.selected_ = kindOf([...pathOf(parent.value), name]);
          this.render();
        });
    this.detail_.querySelector('button[type=submit]')!.addEventListener('click', apply);
    for (const box of [input('name'), input('levels'), input('label'), ...specInputs.values()]) box.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), apply()));
    this.detail_.querySelector('button[value=things]')!.addEventListener('click', () => {
      void this.panel.open().then(() => this.panel.filterClass(path));
    });
    this.detail_.querySelector('button[value=add]')!.addEventListener('click', () => this.startAdd(kindOf(path)));
  }

  /** The chosen class's photos: its own (× takes one away), or those of a class above, faintly; adding a URL or a file. */
  private renderPhotos_(list: Taxon[], path: string[], t: Taxon): void {
    const box = this.detail_.querySelector<HTMLElement>('.taxed-photo-list')!;
    const own = t.photos ?? [];
    const above = own.length ? null : photosAt(list, path);
    const save = async (photos: string[], done: string) => {
      await this.panel.updateClass(path, { photos });
      this.say_(done);
    };
    const thumbs = (above?.photos ?? own).map((ref, i) => {
      const item = document.createElement('span');
      item.className = `taxed-photo${above ? ' inherited' : ''}`;
      item.append(photoThumb(ref, `${kindOf(above?.from ?? path)} の参考写真 ${i + 1}${isLocalPhoto(ref) ? '（このブラウザのみ）' : ''}`, (url) => showPhoto(url, kindOf(above?.from ?? path))));
      if (!above) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'taxed-photo-remove';
        remove.textContent = '×';
        remove.title = '写真の削除';
        remove.setAttribute('aria-label', `参考写真 ${i + 1} の削除`);
        remove.addEventListener('click', () => {
          void save(
            own.filter((r) => r !== ref),
            '参考写真を削除',
          ).then(() => removePhoto(ref).catch(() => undefined));
        });
        item.append(remove);
      }
      return item;
    });
    box.replaceChildren(...thumbs);
    const note = this.detail_.querySelector('.taxed-photo-note')!;
    const shared = this.panel.taxonomyStoreLabel() !== 'このブラウザ';
    note.textContent = above?.photos.length
      ? `上位の分類「${kindOf(above.from)}」の写真（追加でこの分類のものに）`
      : !own.length
        ? '写真なし（クリックで拡大）'
        : shared && own.some(isLocalPhoto)
          ? 'ファイルの写真はこのブラウザのみ（共有には URL）'
          : 'クリックで拡大';
    const url = this.detail_.querySelector<HTMLInputElement>('input[name=photo-url]')!;
    const addUrl = () => {
      const value = url.value.trim();
      if (!/^https?:\/\//i.test(value)) return this.say_('写真の URL は http(s):// で指定');
      void save([...own, value], '参考写真を追加');
    };
    this.detail_.querySelector('button[value=photo-url]')!.addEventListener('click', addUrl);
    url.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), addUrl()));
    const file = this.detail_.querySelector<HTMLInputElement>('input[name=photo-file]')!;
    this.detail_.querySelector('button[value=photo-file]')!.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const files = [...(file.files ?? [])].filter((f) => f.type.startsWith('image/'));
      file.value = '';
      if (!files.length) return;
      try {
        const refs = await Promise.all(files.map((f) => addPhoto(f)));
        await save([...own, ...refs], `参考写真 ${refs.length} 枚を追加`);
      } catch (error) {
        this.say_(`写真の追加失敗: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** 「諸元の項目」: the fields' names, kinds and units, in order. */
  private renderFields_(): void {
    const details = this.fields_.closest('details');
    if (!details?.open) return;
    if (this.fields_.contains(document.activeElement)) return;
    const draft = (this.fieldsDraft_ ??= this.panel.specFields().map((f) => ({ ...f })));
    const table = document.createElement('table');
    table.className = 'catalog-table taxed-field-table';
    table.innerHTML = '<thead><tr><th>項目</th><th>種類</th><th>単位</th><th></th></tr></thead><tbody></tbody>';
    const rerender = () => {
      this.fields_.replaceChildren();
      this.renderFields_();
    };
    draft.forEach((f, i) => {
      const tr = document.createElement('tr');
      const name = Object.assign(document.createElement('input'), { value: f.name, autocomplete: 'off' });
      name.setAttribute('aria-label', '項目名');
      name.addEventListener('change', () => (f.name = name.value.trim() || f.name));
      const type = document.createElement('select');
      type.setAttribute('aria-label', '種類');
      for (const [v, label] of [
        ['text', '文字'],
        ['number', '数値'],
        ['list', '複数（読点区切り）'],
        ['url', 'URL'],
      ] as const)
        type.add(new Option(label, v, false, f.type === v));
      type.addEventListener('change', () => (f.type = type.value as SpecField['type']));
      const unit = Object.assign(document.createElement('input'), { value: f.unit ?? '', autocomplete: 'off', size: 4 });
      unit.setAttribute('aria-label', '単位');
      unit.addEventListener('change', () => (unit.value.trim() ? (f.unit = unit.value.trim()) : delete f.unit));
      const tools = document.createElement('span');
      tools.className = 'obs-row-actions';
      const tool = (label: string, title: string, run: () => void) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, title });
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => {
          run();
          rerender();
        });
        return b;
      };
      tools.append(
        tool('↑', '上へ', () => i > 0 && draft.splice(i - 1, 0, ...draft.splice(i, 1))),
        tool('↓', '下へ', () => i < draft.length - 1 && draft.splice(i + 1, 0, ...draft.splice(i, 1))),
        tool('×', '項目の削除（入力済みの値は分類に残存）', () => draft.splice(i, 1)),
      );
      for (const cell of [name, type, unit, tools]) {
        const td = document.createElement('td');
        td.append(cell);
        tr.append(td);
      }
      table.tBodies[0].append(tr);
    });
    const actions = document.createElement('div');
    actions.className = 'service-actions';
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '項目の追加' });
    add.addEventListener('click', () => {
      let n = draft.length + 1;
      while (draft.some((f) => f.name === `項目${n}`)) n++;
      draft.push({ name: `項目${n}`, type: 'text' });
      rerender();
      this.fields_.querySelector<HTMLInputElement>('tbody tr:last-child input')?.select();
    });
    const save = Object.assign(document.createElement('button'), { type: 'button', textContent: '項目の保存', className: 'primary' });
    save.addEventListener('click', () => {
      // Read what is typed but not yet changed (no blur).
      for (const input of this.fields_.querySelectorAll('input')) input.dispatchEvent(new Event('change'));
      const seen = new Set<string>();
      const fields = draft.filter((f) => f.name && !seen.has(f.name) && seen.add(f.name));
      this.fieldsDraft_ = null;
      void this.panel.setSpecFields(fields);
    });
    const reset = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消' });
    reset.addEventListener('click', () => {
      this.fieldsDraft_ = null;
      rerender();
    });
    actions.append(add, save, reset);
    this.fields_.replaceChildren(table, actions);
  }
}
