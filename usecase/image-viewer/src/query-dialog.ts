/**
 * The dialog of attribute queries on a vector layer, for selecting
 * (「属性条件で選択」) and for the definition query (「既定クエリ」). The
 * condition is built from rows of field, operator and value joined by
 * かつ (AND) / または (OR), with the values the layer holds offered; or, on
 * the SQL tab, written as a `WHERE` (the builder's conditions start it), with
 * the fields a click away and a check of the text. How many features meet it
 * is counted as it is typed.
 */
import type { ViewerLayer, ViewerService } from './images.js';
import { onServer, queryFields, selectModes, type LayerQueries, type SelectMode } from './layer-query.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';
import { conditionOps, conditionsSql, sqlName, takesValue, type Condition, type ConditionOp } from './sql-where.js';

export type QueryPurpose = 'select' | 'definition';

export interface QueryDialogOptions {
  /** The open vector layers (and tables). */
  layers: () => ViewerService[];
  /** The layer selected in the list. */
  selected: () => ViewerLayer | null;
  queries: LayerQueries;
  selection: Selection;
  /** Makes `layer` the selected layer (the selection belongs to it). */
  select: (layer: ViewerService) => void;
  /** Whether `layer` is being edited (its definition query cannot change then). */
  editing: (layer: ViewerService) => boolean;
  say: (message: string) => void;
}

/** What the dialog shows for a layer the next time (per purpose). */
interface Kept {
  conditions: Condition[];
  sql: string;
  tab: 'build' | 'sql';
}

const MAX_VALUES = 200;

/** One condition row of the builder. */
class ConditionRow {
  readonly element = document.createElement('li');
  private readonly join_ = document.createElement('select');
  private readonly field_ = document.createElement('select');
  private readonly op_ = document.createElement('select');
  private readonly value_ = document.createElement('input');
  private readonly codes_ = document.createElement('select');
  private readonly list_ = document.createElement('datalist');
  private static count_ = 0;

  constructor(
    private readonly fields: Field[],
    private readonly values: (field: string) => string[],
    condition: Condition,
    onChange: () => void,
    onRemove: (row: ConditionRow) => void,
  ) {
    this.element.className = 'query-condition';
    this.join_.setAttribute('aria-label', '前の条件とのつなぎ');
    this.join_.append(new Option('かつ', 'AND'), new Option('または', 'OR'));
    this.join_.title = 'かつ（AND）: 両方を満たす／または（OR）: どちらかを満たす';
    this.field_.setAttribute('aria-label', 'フィールド');
    for (const f of fields) this.field_.append(new Option(f.alias && f.alias !== f.name ? `${f.alias}（${f.name}）` : f.name, f.name));
    this.op_.setAttribute('aria-label', '演算子');
    for (const [op, text] of conditionOps) this.op_.append(new Option(text, op));
    this.value_.type = 'text';
    this.value_.setAttribute('aria-label', '値');
    const id = `query-values-${++ConditionRow.count_}`;
    this.list_.id = id;
    this.value_.setAttribute('list', id);
    this.codes_.setAttribute('aria-label', '値');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'query-remove';
    remove.textContent = '×';
    remove.title = 'この条件を削除';
    remove.setAttribute('aria-label', 'この条件を削除');
    remove.addEventListener('click', () => onRemove(this));
    this.element.append(this.join_, this.field_, this.op_, this.value_, this.codes_, this.list_, remove);

    this.join_.value = condition.join;
    this.field_.value = condition.field || fields[0]?.name || '';
    this.op_.value = condition.op;
    this.value_.value = condition.value;
    this.fieldChanged_();
    if (this.codes_.options.length && !this.codes_.hidden) this.codes_.value = condition.value;
    this.field_.addEventListener('change', () => {
      this.fieldChanged_();
      onChange();
    });
    for (const el of [this.join_, this.op_, this.codes_]) el.addEventListener('change', () => (this.update_(), onChange()));
    this.value_.addEventListener('input', onChange);
    this.value_.addEventListener('focus', () => this.fillValues_(), { once: false });
  }

  /** Hides the join of the first row (nothing to join to). */
  setFirst(first: boolean): void {
    this.join_.style.visibility = first ? 'hidden' : '';
  }

  focus(): void {
    this.value_.focus();
  }

  condition(): Condition {
    const coded = !this.codes_.hidden && this.op_.value !== 'in';
    return { join: this.join_.value as 'AND' | 'OR', field: this.field_.value, op: this.op_.value as ConditionOp, value: coded ? this.codes_.value : this.value_.value };
  }

  private field(): Field | undefined {
    return this.fields.find((f) => f.name === this.field_.value);
  }

  private fieldChanged_(): void {
    const field = this.field();
    this.codes_.replaceChildren(...(field?.codes ?? []).map((c) => new Option(c.name === String(c.code) ? c.name : `${c.name}（${c.code}）`, String(c.code))));
    this.list_.replaceChildren();
    this.value_.placeholder = field?.type === 'date' ? '例: 2026-10-01' : field?.type === 'integer' || field?.type === 'double' ? '数値' : '値';
    this.update_();
  }

  private update_(): void {
    const op = this.op_.value as ConditionOp;
    const coded = !!this.field()?.codes?.length && op !== 'in' && !['contains', 'not-contains', 'starts', 'ends'].includes(op);
    this.codes_.hidden = !takesValue(op) || !coded;
    this.value_.hidden = !takesValue(op) || coded;
    if (op === 'in') this.value_.placeholder = '値1, 値2, …';
    else if (!this.value_.hidden && this.value_.placeholder.startsWith('値1')) this.fieldChanged_();
  }

  /** The values the layer holds for the field, offered as the value is typed. */
  private fillValues_(): void {
    if (this.list_.childElementCount) return;
    for (const v of this.values(this.field_.value)) this.list_.append(new Option(v));
  }
}

export class QueryDialog {
  readonly dialog: HTMLDialogElement;
  private readonly title_: HTMLElement;
  private readonly layer_: HTMLSelectElement;
  private readonly mode_: HTMLSelectElement;
  private readonly modeLabel_: HTMLElement;
  private readonly note_: HTMLElement;
  private readonly tabs_: Record<'build' | 'sql', HTMLButtonElement>;
  private readonly build_: HTMLElement;
  private readonly sqlPanel_: HTMLElement;
  private readonly list_: HTMLOListElement;
  private readonly sql_: HTMLTextAreaElement;
  private readonly fields_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly clear_: HTMLButtonElement;
  private purpose_: QueryPurpose = 'select';
  private tab_: 'build' | 'sql' = 'build';
  private rows_: ConditionRow[] = [];
  private layers_: ViewerService[] = [];
  /** The SQL tab's text was written from the builder (not typed): the builder may write it again. */
  private sqlFromBuilder_ = true;
  private readonly kept_ = new WeakMap<ViewerService, Partial<Record<QueryPurpose, Kept>>>();
  private countTimer_ = 0;

  constructor(private readonly options: QueryDialogOptions) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service query-dialog';
    this.dialog.setAttribute('aria-labelledby', 'query-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="query-title">属性条件で選択</h2>
        <label>レイヤー<select name="layer" aria-label="レイヤー"></select></label>
        <label class="query-mode">選択方法<select name="mode" aria-label="選択方法">${selectModes.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <p class="wide query-note"></p>
        <div class="wide query-tabs" role="tablist" aria-label="条件の指定方法">
          <button type="button" role="tab" value="build">条件</button>
          <button type="button" role="tab" value="sql" title="SQL の WHERE 句で直接指定（関数・括弧・BETWEEN なども可）">SQL</button>
        </div>
        <div class="wide query-build" role="tabpanel" aria-label="条件">
          <ol class="query-conditions"></ol>
          <button type="button" value="add-condition">＋ 条件を追加</button>
        </div>
        <div class="wide query-sql" role="tabpanel" aria-label="SQL" hidden>
          <textarea name="sql" rows="4" spellcheck="false" aria-label="SQL（WHERE 句）" placeholder="例: POP >= 1000 AND NAME LIKE '東%'"></textarea>
          <div class="query-sql-tools">
            <span class="query-fields-label">フィールド（クリックで挿入）</span>
            <div class="query-fields"></div>
            <button type="button" value="check">構文チェック</button>
          </div>
        </div>
      </form>
      <p class="service-status query-status" role="status"></p>
      <div class="service-actions">
        <button type="button" value="close">閉じる</button>
        <button type="button" value="clear" hidden>既定クエリの解除</button>
        <button type="button" value="run" class="primary">選択</button>
      </div>`;
    document.body.append(this.dialog);
    const q = <T extends Element>(s: string) => this.dialog.querySelector<T & Element>(s)!;
    this.title_ = q('#query-title');
    this.layer_ = q('select[name=layer]');
    this.mode_ = q('select[name=mode]');
    this.modeLabel_ = q('.query-mode');
    this.note_ = q('.query-note');
    this.tabs_ = { build: q('button[role=tab][value=build]'), sql: q('button[role=tab][value=sql]') };
    this.build_ = q('.query-build');
    this.sqlPanel_ = q('.query-sql');
    this.list_ = q('.query-conditions');
    this.sql_ = q('textarea[name=sql]');
    this.fields_ = q('.query-fields');
    this.status_ = q('.query-status');
    this.run_ = q('button[value=run]');
    this.clear_ = q('button[value=clear]');

    this.layer_.addEventListener('focus', () => this.keep_());
    this.layer_.addEventListener('change', () => this.load_());
    this.tabs_.build.addEventListener('click', () => this.setTab('build'));
    this.tabs_.sql.addEventListener('click', () => this.setTab('sql'));
    q<HTMLButtonElement>('button[value=add-condition]').addEventListener('click', () => this.addRow_({ join: 'AND', field: '', op: '=', value: '' }).focus());
    q<HTMLButtonElement>('button[value=check]').addEventListener('click', () => this.check_());
    this.sql_.addEventListener('input', () => {
      this.sqlFromBuilder_ = false;
      this.changed_();
    });
    this.sql_.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.run();
      }
    });
    q<HTMLButtonElement>('button[value=close]').addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.clear_.addEventListener('click', () => void this.clearDefinition());
    this.dialog.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run();
    });
    this.dialog.addEventListener('close', () => this.keep_());
  }

  /** Opens the dialog for `purpose`, on `layer` (by default the selected layer, else the first vector layer). */
  open(purpose: QueryPurpose, layer?: ViewerService): void {
    if (this.dialog.open) this.keep_();
    this.purpose_ = purpose;
    this.layers_ = this.options.layers().filter((l) => l.service.vector);
    if (!this.layers_.length) {
      this.options.say('属性のあるベクターレイヤーなし（先にファイル・WFS・Esri のレイヤーを開く）');
      return;
    }
    const selected = this.options.selected();
    const start = layer ?? this.layers_.find((l) => l === selected) ?? this.layers_[0];
    this.layer_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    this.layer_.value = String(Math.max(0, this.layers_.indexOf(start)));
    const select = purpose === 'select';
    this.title_.textContent = select ? '属性条件で選択' : '既定クエリ';
    this.modeLabel_.hidden = !select;
    this.run_.textContent = select ? '選択' : '適用';
    this.load_();
    if (!this.dialog.open) this.dialog.show();
    (this.tab_ === 'sql' ? this.sql_ : (this.list_.querySelector<HTMLElement>('input:not([hidden]), select:not([hidden])') ?? this.run_)).focus();
  }

  /** The layer the dialog works on. */
  layer(): ViewerService | null {
    return this.layers_[Number(this.layer_.value)] ?? null;
  }

  /** The condition as SQL: the builder's, or the SQL tab's. */
  where(): string {
    if (this.tab_ === 'sql') return this.sql_.value.trim();
    const layer = this.layer();
    return layer ? conditionsSql(this.conditions_(), queryFields(layer.service)) : '';
  }

  /** Shows the builder or the SQL text; going to SQL writes the builder's conditions there (unless typed over). */
  setTab(tab: 'build' | 'sql'): void {
    if (tab === 'sql' && (this.sqlFromBuilder_ || !this.sql_.value.trim())) {
      const layer = this.layer();
      this.sql_.value = layer ? conditionsSql(this.conditions_(), queryFields(layer.service)) : '';
      this.sqlFromBuilder_ = true;
    }
    this.tab_ = tab;
    for (const [name, button] of Object.entries(this.tabs_)) button.setAttribute('aria-selected', String(name === tab));
    this.build_.hidden = tab !== 'build';
    this.sqlPanel_.hidden = tab !== 'sql';
    this.changed_();
    if (tab === 'sql') this.sql_.focus();
  }

  /** Selects the features meeting the condition, or sets it as the layer's definition query. */
  async run(): Promise<void> {
    const layer = this.layer();
    if (!layer) return;
    // The count waiting to be shown would cover the outcome.
    clearTimeout(this.countTimer_);
    const where = this.where();
    if (this.purpose_ === 'definition') return this.applyDefinition_(layer, where);
    if (!where) return this.status('条件を入力', true);
    if (this.options.selected() !== layer) this.options.select(layer);
    this.status('検索中…');
    try {
      const mode = this.mode_.value as SelectMode;
      const { found, selected } = await this.options.queries.select(layer.service, where, mode, this.options.selection);
      const text = found ? `該当 ${found.toLocaleString()} 件・選択 ${selected.toLocaleString()} 件` : `該当なし・選択 ${selected.toLocaleString()} 件`;
      this.status(text);
      this.options.say(`${layer.name}: ${text}`);
    } catch (error) {
      this.status(`検索失敗: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  /** Takes the definition query off the layer. */
  async clearDefinition(): Promise<void> {
    const layer = this.layer();
    if (layer) await this.applyDefinition_(layer, '');
  }

  status(text: string, error = false): void {
    this.status_.textContent = text;
    this.status_.classList.toggle('error', error);
  }

  private async applyDefinition_(layer: ViewerService, where: string): Promise<void> {
    if (this.options.editing(layer)) return this.status('編集中は変更不可（編集の保存・終了後に設定）', true);
    this.status(where ? '絞り込み中…' : '解除中…');
    try {
      const n = await this.options.queries.set(layer.service, where || null);
      const text = where ? `既定クエリを適用（${n.toLocaleString()} 件を表示）` : `既定クエリを解除（${n.toLocaleString()} 件を表示）`;
      this.status(text);
      this.options.say(`${layer.name}: ${text}`);
      this.clear_.hidden = !where;
      this.note_.textContent = this.noteOf_(layer);
    } catch (error) {
      this.status(`既定クエリの設定に失敗: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private noteOf_(layer: ViewerService): string {
    const server = onServer(layer.service);
    if (this.purpose_ === 'select') return server ? 'サーバーで検索（既定クエリで表示中の地物から選択）' : '';
    const now = this.options.queries.get(layer.service);
    const how = server ? '地図・属性テーブルに条件に合う地物のみ表示（サーバーで絞り込み）' : '地図・属性テーブルに条件に合う地物のみ表示';
    return now ? `${how}。現在: ${now}` : how;
  }

  /** Shows the layer's conditions (kept from the last time, or its definition query). */
  private load_(): void {
    const layer = this.layer();
    if (!layer) return;
    const kept = this.kept_.get(layer)?.[this.purpose_];
    const definition = this.purpose_ === 'definition' ? this.options.queries.get(layer.service) : null;
    this.rows_ = [];
    this.list_.replaceChildren();
    const fields = layer.service.vector?.fields.filter((f) => f.type !== 'other' || f.codes) ?? [];
    this.fieldList_ = fields.length ? fields : (queryFields(layer.service).map((f) => ({ name: f.name, alias: f.name, type: 'string', editable: false, nullable: true })) as Field[]);
    for (const c of kept?.conditions ?? [{ join: 'AND', field: '', op: '=', value: '' } as Condition]) this.addRow_(c);
    // A definition query set another way (a project, the SQL tab): shown as SQL.
    const sql = definition ?? kept?.sql ?? '';
    this.sql_.value = sql;
    this.sqlFromBuilder_ = !sql || (kept?.tab === 'build' && sql === conditionsSql(kept.conditions, queryFields(layer.service)));
    this.fields_.replaceChildren(
      ...queryFields(layer.service).map((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = f.name;
        b.addEventListener('click', () => this.insert_(sqlName(f.name)));
        return b;
      }),
    );
    this.clear_.hidden = this.purpose_ !== 'definition' || !definition;
    this.note_.textContent = this.noteOf_(layer);
    this.note_.hidden = !this.note_.textContent;
    this.status('');
    this.setTab(definition && definition !== (kept ? conditionsSql(kept.conditions, queryFields(layer.service)) : '') ? 'sql' : (kept?.tab ?? 'build'));
  }

  private fieldList_: Field[] = [];

  private addRow_(condition: Condition): ConditionRow {
    const layer = this.layer();
    const row = new ConditionRow(
      this.fieldList_,
      (field) => (layer ? this.valuesOf_(layer, field) : []),
      condition,
      () => this.builderChanged_(),
      (r) => {
        this.rows_ = this.rows_.filter((x) => x !== r);
        r.element.remove();
        if (!this.rows_.length) this.addRow_({ join: 'AND', field: '', op: '=', value: '' });
        this.rows_[0]?.setFirst(true);
        this.builderChanged_();
      },
    );
    this.rows_.push(row);
    row.setFirst(this.rows_.length === 1);
    this.list_.append(row.element);
    return row;
  }

  /** The values `field` holds among the shown features (most frequent first, up to {@link MAX_VALUES}). */
  private valuesOf_(layer: ViewerService, name: string): string[] {
    const field = layer.service.vector?.fields.find((f) => f.name === name);
    const counts = new Map<string, number>();
    for (const f of this.options.queries.features(layer.service)) {
      const raw = f.get(name);
      if (raw === null || raw === undefined || raw === '') continue;
      const v = field?.type === 'date' && typeof raw === 'number' ? new Date(raw).toISOString().slice(0, 10) : String(raw);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_VALUES).map(([v]) => v);
  }

  private conditions_(): Condition[] {
    return this.rows_.map((r) => r.condition());
  }

  private builderChanged_(): void {
    if (this.sqlFromBuilder_) {
      const layer = this.layer();
      this.sql_.value = layer ? conditionsSql(this.conditions_(), queryFields(layer.service)) : '';
    }
    this.changed_();
  }

  /** Counts the features meeting the condition (in the browser), a moment after the last change. */
  private changed_(): void {
    clearTimeout(this.countTimer_);
    this.countTimer_ = window.setTimeout(() => this.count_(), 150);
  }

  private count_(): void {
    const layer = this.layer();
    const where = this.where();
    if (!layer || !where) return this.status('');
    try {
      const n = this.options.queries.count(layer.service, where);
      const of = this.options.queries.features(layer.service).length;
      this.status(`該当 ${n.toLocaleString()} 件／${of.toLocaleString()} 件${onServer(layer.service) ? '（読み込み済みの地物で計算）' : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status(onServer(layer.service) ? `ブラウザでは判定不可（実行時にサーバーで判定）: ${message}` : message, !onServer(layer.service));
    }
  }

  /** Checks the SQL tab's text and says what is wrong, or that it reads. */
  private check_(): void {
    const layer = this.layer();
    if (!layer) return;
    const where = this.sql_.value.trim();
    try {
      const n = this.options.queries.count(layer.service, where);
      this.status(`構文 OK（該当 ${n.toLocaleString()} 件）`);
    } catch (error) {
      const at = (error as { at?: number }).at;
      if (typeof at === 'number') {
        this.sql_.focus();
        this.sql_.setSelectionRange(at, Math.min(where.length, at + 1));
      }
      this.status(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** Puts `text` into the SQL at the cursor. */
  private insert_(text: string): void {
    const { selectionStart: a, selectionEnd: b, value } = this.sql_;
    const before = value.slice(0, a);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    this.sql_.value = `${before}${pad}${text} ${value.slice(b)}`;
    const at = a + pad.length + text.length + 1;
    this.sql_.focus();
    this.sql_.setSelectionRange(at, at);
    this.sqlFromBuilder_ = false;
    this.changed_();
  }

  /** Remembers the conditions for the layer, for the next time the dialog opens on it. */
  private keep_(): void {
    const layer = this.layer();
    if (!layer) return;
    const kept = this.kept_.get(layer) ?? {};
    kept[this.purpose_] = { conditions: this.conditions_(), sql: this.sql_.value, tab: this.tab_ };
    this.kept_.set(layer, kept);
  }
}
