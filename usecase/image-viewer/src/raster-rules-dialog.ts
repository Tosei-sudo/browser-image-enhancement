/**
 * The "display rules" dialog of an Esri image service or map service layer.
 *
 * Image services: a rule from config.json's `serviceRules`, or a condition on
 * the catalog's attributes (written, or put together from an attribute, an
 * operator and one of its values), the attribute the images are stacked by,
 * and a raster function; folded under 「詳細」 the mosaic method, how
 * overlapping pixels merge, images fixed by id, the bands drawn and a
 * rendering rule in JSON. 「表示範囲を画像として開く」 brings the view in as
 * a GeoTIFF of the stored values, to correct like any other image.
 *
 * Map services: the layers drawn, each with a condition on its attributes.
 *
 * 適用 draws with the settings and keeps the dialog open; OK also closes it;
 * キャンセル goes back to what was drawn when the dialog opened.
 */
import type { ViewerService } from './images.js';
import type { EsriRaster } from './services/esri-raster.js';
import {
  andWhere,
  isDefault,
  mosaicMethods,
  mosaicOperations,
  renderingRuleOf,
  ruleSettings,
  sqlValue,
  type EsriRasterSettings,
} from './services/esri-rules.js';
import type OlMap from 'ol/Map.js';

export interface RasterRulesOptions {
  say: (message: string) => void;
  /** Called after the settings changed (to update the link). */
  onChange: (layer: ViewerService) => void;
  /** Opens a GeoTIFF exported from the view as an image layer. */
  openImage: (blob: Blob, name: string) => Promise<void>;
  map: OlMap;
}

const CUSTOM = '';
const DEFAULT = '\u0000default';

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const optionsHtml = (entries: Record<string, string>) => Object.entries(entries).map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('');

export class RasterRulesDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly title_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly count_: HTMLElement;
  private readonly sublayers_: HTMLElement;
  private readonly values_: HTMLDataListElement;
  private entry_: ViewerService | null = null;
  private raster_: EsriRaster | null = null;
  /** The settings when the dialog opened, for キャンセル. */
  private before_: EsriRasterSettings = {};
  private countTimer_ = 0;
  private countAsked_ = 0;

  constructor(private readonly options: RasterRulesOptions) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service style-dialog raster-rules';
    this.dialog.setAttribute('aria-labelledby', 'raster-rules-title');
    this.dialog.innerHTML = `
      <h2 id="raster-rules-title">表示ルール</h2>
      <form method="dialog" class="style-form">
        <fieldset class="rule-pick">
          <legend>ルール</legend>
          <label class="wide"><select name="rule" aria-label="ルール"></select></label>
        </fieldset>
        <fieldset data-for="image">
          <legend>表示する画像</legend>
          <label class="wide">条件（属性・SQL）<textarea name="where" rows="2" placeholder="例: CloudCover &lt;= 0.2 AND AcquisitionDate &gt;= DATE '2024-01-01'" aria-label="条件"></textarea></label>
          <label>属性<select name="field" aria-label="条件の属性"></select></label>
          <label>比べ方<select name="op" aria-label="比べ方">
            <option value="=">＝</option><option value="<>">≠</option><option value=">=">≧</option><option value="<=">≦</option><option value=">">＞</option><option value="<">＜</option><option value="like">を含む</option><option value="null">が空</option>
          </select></label>
          <label>値<input name="value" list="raster-rules-values" aria-label="条件の値" autocomplete="off" /></label>
          <button type="button" class="add-condition wide">条件に追加（AND）</button>
          <p class="raster-count wide" role="status"></p>
          <label class="wide-2">並び順（上に重ねる画像）<select name="sortField" aria-label="並び順の属性"></select></label>
          <label>向き<select name="ascending" aria-label="並び順の向き">
            <option value="false">大きい順（新しい順）</option><option value="true">小さい順（古い順）</option>
          </select></label>
          <label class="wide">ラスター関数<select name="rasterFunction" aria-label="ラスター関数"></select></label>
        </fieldset>
        <details class="style-scales raster-details" data-for="image">
          <summary>詳細</summary>
          <fieldset>
            <label class="wide-2">重ね方<select name="method" aria-label="重ね方"></select></label>
            <label>基準値<input name="sortValue" aria-label="並び順の基準値" placeholder="（なし）" /></label>
            <label class="wide-2">重なった画素<select name="operation" aria-label="重なった画素"><option value="">（サービスの既定）</option>${optionsHtml(mosaicOperations)}</select></label>
            <label>画像 ID<input name="lockRasterIds" aria-label="表示する画像 ID" placeholder="1, 5, 8" /></label>
            <label class="wide">バンド（R, G, B。1 から）<input name="bandIds" aria-label="バンド" placeholder="（サービスの既定）例: 4, 3, 2" /></label>
            <label class="wide">レンダリングルール（JSON。ラスター関数より優先）<textarea name="renderingRule" rows="3" aria-label="レンダリングルール" placeholder='{"rasterFunction":"Stretch","rasterFunctionArguments":{"StretchType":6}}'></textarea></label>
          </fieldset>
        </details>
        <fieldset data-for="map">
          <legend>表示するレイヤーと条件</legend>
          <div class="raster-sublayers wide"></div>
        </fieldset>
        <datalist id="raster-rules-values"></datalist>
      </form>
      <p class="service-status raster-status" role="status"></p>
      <div class="service-actions">
        <button type="button" value="export" class="raster-export" data-for="image" title="表示範囲を、保存されている画素値の GeoTIFF として開きます（補正・バンド割当・ストレッチがビューアでかけられます）">表示範囲を画像として開く</button>
        <span class="spacer"></span>
        <button type="button" value="reset">既定に戻す</button>
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="apply">適用</button>
        <button type="button" value="ok" class="primary">OK</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.title_ = this.dialog.querySelector('h2')!;
    this.status_ = this.dialog.querySelector('.raster-status')!;
    this.count_ = this.dialog.querySelector('.raster-count')!;
    this.sublayers_ = this.dialog.querySelector('.raster-sublayers')!;
    this.values_ = this.dialog.querySelector('datalist')!;

    const button = (value: string) => this.dialog.querySelector<HTMLButtonElement>(`button[value=${value}]`)!;
    button('cancel').addEventListener('click', () => this.cancel());
    button('apply').addEventListener('click', () => this.apply());
    button('ok').addEventListener('click', () => {
      if (this.apply()) this.close_();
    });
    button('reset').addEventListener('click', () => {
      this.fill_({});
      this.select_('rule').value = DEFAULT;
    });
    button('export').addEventListener('click', () => void this.exportView());
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.cancel();
    });
    this.select_('rule').addEventListener('change', () => {
      const raster = this.raster_;
      const value = this.select_('rule').value;
      if (!raster || value === CUSTOM) return;
      const rule = raster.rules.find((r) => r.label === value);
      this.fill_(rule ? ruleSettings(rule) : {});
    });
    // Any change of a field makes the settings the user's own.
    this.form_.addEventListener('input', (e) => {
      const name = (e.target as HTMLElement).getAttribute('name');
      if (name === 'rule' || name === 'field' || name === 'op' || name === 'value') return;
      this.select_('rule').value = CUSTOM;
      if (name === 'where') this.scheduleCount_();
    });
    this.select_('field').addEventListener('change', () => void this.loadValues_());
    this.dialog.querySelector('.add-condition')!.addEventListener('click', () => this.addCondition_());
  }

  /** Opens the dialog for an image or map service layer. */
  open(entry: ViewerService): void {
    const raster = entry.service.raster;
    if (!raster) return;
    this.entry_ = entry;
    this.raster_ = raster;
    this.before_ = { ...raster.get() };
    this.title_.textContent = `表示ルール: ${entry.name}`;
    this.status_.textContent = '';
    for (const el of this.dialog.querySelectorAll<HTMLElement>('[data-for]')) el.hidden = el.dataset.for !== raster.kind;

    const rule = this.select_('rule');
    rule.replaceChildren(new Option('サービスの既定', DEFAULT), ...raster.rules.map((r) => new Option(r.label, r.label)), new Option('カスタム', CUSTOM));
    this.dialog.querySelector<HTMLElement>('.rule-pick')!.hidden = raster.rules.length === 0;

    if (raster.kind === 'image') {
      const fieldOptions = raster.fields.filter((f) => f.type !== 'other').map((f) => new Option(f.alias === f.name ? f.name : `${f.alias}（${f.name}）`, f.name));
      this.select_('field').replaceChildren(...fieldOptions.map((o) => o.cloneNode(true) as HTMLOptionElement));
      this.select_('sortField').replaceChildren(new Option('（サービスの既定）', ''), ...fieldOptions);
      this.select_('rasterFunction').replaceChildren(
        new Option('（サービスの既定）', ''),
        new Option('なし（保存されている値）', 'None'),
        ...raster.rasterFunctions.filter((f) => f.name !== 'None').map((f) => {
          const o = new Option(f.name, f.name);
          if (f.description) o.title = f.description;
          return o;
        }),
      );
      const methods = raster.mosaicMethods.length ? raster.mosaicMethods : Object.keys(mosaicMethods);
      this.select_('method').replaceChildren(new Option('（並び順の指定どおり）', ''), ...methods.map((m) => new Option(mosaicMethods[m] ?? m, m)));
      this.dialog.querySelector<HTMLElement>('.add-condition')!.hidden = raster.fields.length === 0;
      for (const name of ['field', 'op', 'value']) this.form_.querySelector<HTMLElement>(`[name=${name}]`)!.closest('label')!.hidden = raster.fields.length === 0;
      void this.loadValues_();
    } else {
      this.buildSublayers_(raster);
    }
    this.fill_(raster.get());
    this.dialog.showModal();
  }

  /** Draws with the settings in the dialog; false when they cannot be used (the reason is shown). */
  apply(): boolean {
    const raster = this.raster_;
    const entry = this.entry_;
    if (!raster || !entry) return false;
    let settings: EsriRasterSettings;
    try {
      settings = this.collect_();
      raster.set(settings);
    } catch (error) {
      this.status_.textContent = error instanceof Error ? error.message : String(error);
      return false;
    }
    this.status_.textContent = isDefault(settings) ? 'サービスの既定で表示しています' : '適用しました';
    this.options.onChange(entry);
    return true;
  }

  /** Goes back to the settings the dialog opened with, and closes it. */
  cancel(): void {
    const raster = this.raster_;
    const entry = this.entry_;
    if (raster && entry && JSON.stringify(raster.get()) !== JSON.stringify(this.before_)) {
      raster.set(this.before_);
      this.options.onChange(entry);
    }
    this.close_();
  }

  /** Opens the view of the image service as a GeoTIFF of its stored values. */
  async exportView(): Promise<void> {
    const raster = this.raster_;
    if (!raster?.exportView) return;
    if (!this.apply()) return;
    this.status_.textContent = '表示範囲を読み込んでいます…';
    try {
      const { blob, name } = await raster.exportView(this.options.map);
      await this.options.openImage(blob, name);
      this.close_();
    } catch (error) {
      this.status_.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private close_(): void {
    window.clearTimeout(this.countTimer_);
    this.entry_ = null;
    this.raster_ = null;
    if (this.dialog.open) this.dialog.close();
  }

  private select_(name: string): HTMLSelectElement {
    return this.form_.elements.namedItem(name) as HTMLSelectElement;
  }

  private input_(name: string): HTMLInputElement | HTMLTextAreaElement {
    return this.form_.elements.namedItem(name) as HTMLInputElement;
  }

  /** Puts settings in the fields. */
  private fill_(s: EsriRasterSettings): void {
    const raster = this.raster_;
    if (!raster) return;
    const rule = this.select_('rule');
    rule.value = s.rule && raster.rules.some((r) => r.label === s.rule) ? s.rule : isDefault(s) ? DEFAULT : CUSTOM;
    if (raster.kind === 'image') {
      this.input_('where').value = s.where ?? '';
      this.setSelect_('sortField', s.sortField ?? '');
      this.select_('ascending').value = String(s.ascending ?? false);
      this.setSelect_('rasterFunction', s.rasterFunction ?? '');
      this.setSelect_('method', s.method ?? '');
      this.input_('sortValue').value = s.sortValue === undefined ? '' : String(s.sortValue);
      this.select_('operation').value = s.operation ?? '';
      this.input_('lockRasterIds').value = (s.lockRasterIds ?? []).join(', ');
      this.input_('bandIds').value = (s.bandIds ?? []).map((b) => b + 1).join(', ');
      this.input_('renderingRule').value = s.renderingRule ? JSON.stringify(JSON.parse(s.renderingRule), null, 1) : '';
      // The details open when they hold something.
      (this.dialog.querySelector('.raster-details') as HTMLDetailsElement).open = !!(s.method || s.sortValue !== undefined || s.operation || s.lockRasterIds?.length || s.bandIds?.length || s.renderingRule);
      this.scheduleCount_(0);
    } else {
      const shown = s.layers ? new Set(s.layers) : null;
      for (const row of this.sublayers_.querySelectorAll<HTMLElement>('.raster-sublayer')) {
        const id = Number(row.dataset.id);
        row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = shown ? shown.has(id) : row.dataset.default === 'true';
        row.querySelector<HTMLInputElement>('input[name^=def]')!.value = s.layerDefs?.[String(id)] ?? '';
      }
    }
  }

  /** Selects `value`, adding it when the service no longer lists it. */
  private setSelect_(name: string, value: string): void {
    const select = this.select_(name);
    if (value && ![...select.options].some((o) => o.value === value)) select.append(new Option(value, value));
    select.value = value;
  }

  /** The settings in the fields. */
  private collect_(): EsriRasterSettings {
    const raster = this.raster_!;
    const s: EsriRasterSettings = {};
    if (raster.kind === 'image') {
      const text = (name: string) => this.input_(name).value.trim();
      if (text('where')) s.where = text('where');
      if (this.select_('sortField').value) {
        s.sortField = this.select_('sortField').value;
        s.ascending = this.select_('ascending').value === 'true';
      }
      if (this.select_('rasterFunction').value) s.rasterFunction = this.select_('rasterFunction').value;
      if (this.select_('method').value) s.method = this.select_('method').value;
      if (text('sortValue')) s.sortValue = Number.isFinite(Number(text('sortValue'))) ? Number(text('sortValue')) : text('sortValue');
      if (this.select_('operation').value) s.operation = this.select_('operation').value;
      const numbers = (name: string, label: string, min: number) => {
        if (!text(name)) return undefined;
        const list = text(name).split(/[\s,、]+/).filter(Boolean).map(Number);
        if (!list.every((n) => Number.isInteger(n) && n >= min)) throw new Error(`${label}は ${min} 以上の整数をカンマで区切って入力してください`);
        return list;
      };
      const ids = numbers('lockRasterIds', '画像 ID ', 0);
      if (ids) s.lockRasterIds = ids;
      if (s.method === 'esriMosaicLockRaster' && !ids?.length) throw new Error('「画像を指定（ID）」では画像 ID を入力してください');
      const bands = numbers('bandIds', 'バンド', 1);
      if (bands) {
        if (raster.bandCount && bands.some((b) => b > raster.bandCount)) throw new Error(`バンドは 1〜${raster.bandCount} で指定してください`);
        if (bands.length !== 1 && bands.length !== 3) throw new Error('バンドは 1 つ（グレー）か 3 つ（R, G, B）で指定してください');
        s.bandIds = bands.map((b) => b - 1);
      }
      if (text('renderingRule')) {
        try {
          s.renderingRule = JSON.stringify(JSON.parse(text('renderingRule')));
        } catch {
          throw new Error('レンダリングルールが JSON として読めません');
        }
        renderingRuleOf(s);
      }
    } else {
      const rows = [...this.sublayers_.querySelectorAll<HTMLElement>('.raster-sublayer')];
      const checked = rows.filter((r) => r.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).map((r) => Number(r.dataset.id));
      const asDefault = rows.every((r) => r.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked === (r.dataset.default === 'true'));
      if (!asDefault) s.layers = checked;
      const defs = Object.fromEntries(
        rows.map((r) => [r.dataset.id!, r.querySelector<HTMLInputElement>('input[name^=def]')!.value.trim()] as const).filter(([, where]) => where),
      );
      if (Object.keys(defs).length) s.layerDefs = defs;
    }
    // Named after the chosen rule while it is left as the rule says.
    const label = this.select_('rule').value;
    const rule = raster.rules.find((r) => r.label === label);
    if (rule && JSON.stringify(normalize(rule.settings)) === JSON.stringify(normalize(s))) s.rule = rule.label;
    return s;
  }

  /** The map service's layers: groups as headings, each layer with its check box and condition. */
  private buildSublayers_(raster: EsriRaster): void {
    const byId = new Map(raster.sublayers.map((l) => [l.id, l]));
    // Shown by default when it and all its groups are.
    const shownByDefault = (id: number): boolean => {
      const l = byId.get(id);
      return !l || (l.defaultVisibility && (l.parentId < 0 || shownByDefault(l.parentId)));
    };
    const depth = (id: number): number => {
      const l = byId.get(id);
      return l && l.parentId >= 0 ? depth(l.parentId) + 1 : 0;
    };
    const rows = raster.sublayers.map((l) => {
      const row = document.createElement('div');
      row.style.paddingLeft = `${depth(l.id) * 14}px`;
      if (l.children.length) {
        row.className = 'raster-group';
        row.textContent = l.name;
        return row;
      }
      row.className = 'raster-sublayer';
      row.dataset.id = String(l.id);
      row.dataset.default = String(shownByDefault(l.id));
      const check = document.createElement('label');
      check.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', `${l.name} を表示`);
      check.append(box, l.name);
      const def = document.createElement('input');
      def.name = `def-${l.id}`;
      def.placeholder = '条件（例: TYPE = 1）';
      def.setAttribute('aria-label', `${l.name} の条件`);
      // Rasters and group layers have no attributes to filter.
      def.hidden = !l.geometryType;
      row.append(check, def);
      return row;
    });
    this.sublayers_.replaceChildren(...rows);
  }

  /** Appends `field op value` to the condition. */
  private addCondition_(): void {
    const raster = this.raster_;
    if (!raster) return;
    const field = raster.fields.find((f) => f.name === this.select_('field').value);
    if (!field) return;
    const op = this.select_('op').value;
    const value = this.input_('value').value;
    let condition: string;
    if (op === 'null') condition = `${field.name} IS NULL`;
    else if (op === 'like') condition = `${field.name} LIKE ${sqlValue(`%${value.trim()}%`, 'string')}`;
    else {
      if (!value.trim()) {
        this.status_.textContent = '値を入力してください';
        return;
      }
      condition = `${field.name} ${op} ${sqlValue(value, field.type)}`;
    }
    const where = this.input_('where');
    where.value = andWhere(where.value, condition);
    this.input_('value').value = '';
    this.status_.textContent = '';
    where.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** The values of the chosen attribute, offered in the value field. */
  private async loadValues_(): Promise<void> {
    const raster = this.raster_;
    const field = this.select_('field').value;
    this.values_.replaceChildren();
    if (!raster || !field) return;
    const values = await raster.values(field).catch(() => []);
    if (this.raster_ !== raster || this.select_('field').value !== field) return;
    const type = raster.fields.find((f) => f.name === field)?.type;
    this.values_.replaceChildren(...values.map((v) => new Option(type === 'date' && typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v))));
  }

  /** Counts the images meeting the condition, a moment after typing stops. */
  private scheduleCount_(delay = 500): void {
    window.clearTimeout(this.countTimer_);
    const raster = this.raster_;
    if (!raster || raster.kind !== 'image' || raster.fields.length === 0) {
      this.count_.textContent = '';
      return;
    }
    this.countTimer_ = window.setTimeout(() => {
      const asked = ++this.countAsked_;
      const where = this.input_('where').value;
      this.count_.textContent = '条件に合う画像を数えています…';
      void raster.count(where).then((n) => {
        if (asked !== this.countAsked_ || this.raster_ !== raster) return;
        this.count_.textContent = n === null ? '条件に合う画像の数を取得できませんでした（条件を確認してください）' : `条件に合う画像: ${n.toLocaleString()} 件`;
      });
    }, delay);
  }
}

/** Settings with their keys in one order and without the rule's name, to compare. */
function normalize(s: EsriRasterSettings): Record<string, unknown> {
  const rest = { ...s };
  delete rest.rule;
  if (rest.sortField && rest.ascending === undefined) rest.ascending = false;
  if (rest.renderingRule) rest.renderingRule = JSON.stringify(JSON.parse(rest.renderingRule));
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}
