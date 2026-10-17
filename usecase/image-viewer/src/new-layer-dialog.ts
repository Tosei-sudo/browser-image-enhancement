/**
 * "New layer": a temporary layer designed by the person, like QGIS's "New
 * Temporary Scratch Layer". They name it, choose what it holds (points,
 * lines, polygons, their multi forms, or any) and define its attributes
 * (name and type; under "詳細" a heading, a default, a length limit, a
 * range and allowed values). Attributes can be copied from an open vector
 * layer. The layer opens empty, kept in the browser like the other
 * temporary layers, and editing starts with the draw tool, so the first
 * click on the map adds a feature.
 */
import type { DrawableType } from './edit-session.js';
import type { ViewerService } from './images.js';
import { crsPresets, targetCrs } from './processing/reproject.js';
import type { Field } from './services/index.js';
import { designRecord, geometryNames, geometryTypeOf, type DesignType, type FieldDesign, type LayerDesign, type TempRecord } from './temp-layers.js';
import { wgs84 } from './vector-write.js';

export interface NewLayerOptions {
  /** The open layers (vector ones offer their attributes for copying). */
  layers: () => ViewerService[];
  say: (message: string) => void;
  /** Adds the made layer; `draw`: start editing with the draw tool. */
  onCreate: (record: TempRecord, draw: boolean) => void | Promise<void>;
}

const typeNames: Record<DesignType, string> = { string: '文字列', integer: '整数', double: '小数', date: '日付' };

/** The design type of a field of another layer (ids become integers, the rest text). */
function designTypeOf(field: Field): DesignType {
  if (field.type === 'oid') return 'integer';
  return field.type === 'other' ? 'string' : field.type;
}

/** The design of an existing field, for copying. */
export function fieldDesignOf(field: Field): FieldDesign {
  const type = designTypeOf(field);
  return {
    name: field.name,
    type,
    alias: field.alias !== field.name ? field.alias : '',
    required: !field.nullable && field.type !== 'oid',
    length: type === 'string' ? (field.length ?? null) : null,
    min: field.range && Number.isFinite(field.range[0]) ? field.range[0] : null,
    max: field.range && Number.isFinite(field.range[1]) ? field.range[1] : null,
    codes: field.codes?.map((c) => (String(c.code) === c.name ? c.name : `${c.code}=${c.name}`)).join(', ') ?? '',
  };
}

/** One attribute's row in the dialog. */
class FieldRow {
  readonly element: HTMLElement;
  private readonly name_: HTMLInputElement;
  private readonly type_: HTMLSelectElement;
  private readonly required_: HTMLInputElement;
  private readonly more_: HTMLButtonElement;
  private readonly details_: HTMLElement;
  private readonly alias_: HTMLInputElement;
  private readonly default_: HTMLInputElement;
  private readonly length_: HTMLInputElement;
  private readonly min_: HTMLInputElement;
  private readonly max_: HTMLInputElement;
  private readonly codes_: HTMLInputElement;

  constructor(design: FieldDesign, onRemove: (row: FieldRow) => void) {
    this.element = document.createElement('li');
    this.element.className = 'new-layer-field';
    const input = (label: string, type = 'text') => {
      const i = document.createElement('input');
      i.type = type;
      i.setAttribute('aria-label', label);
      return i;
    };
    const labelled = (text: string, control: HTMLElement) => {
      const l = document.createElement('label');
      l.append(text, control);
      return l;
    };
    this.name_ = input('属性名');
    this.name_.placeholder = '属性名';
    this.name_.value = design.name;
    this.type_ = document.createElement('select');
    this.type_.setAttribute('aria-label', '型');
    for (const [value, text] of Object.entries(typeNames)) this.type_.append(new Option(text, value));
    this.type_.value = design.type;
    this.required_ = input('必須', 'checkbox');
    this.required_.checked = !!design.required;
    const required = document.createElement('label');
    required.className = 'check';
    required.append(this.required_, '必須');
    required.title = '値を空にできない属性にします';
    this.more_ = document.createElement('button');
    this.more_.type = 'button';
    this.more_.className = 'new-layer-more';
    this.more_.textContent = '詳細';
    this.more_.title = '表示名・既定値・文字数・範囲・候補値';
    this.more_.setAttribute('aria-expanded', 'false');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'new-layer-remove';
    remove.textContent = '×';
    remove.title = 'この属性を削除';
    remove.setAttribute('aria-label', 'この属性を削除');
    remove.addEventListener('click', () => onRemove(this));

    this.alias_ = input('表示名');
    this.alias_.placeholder = '属性名と同じ';
    this.alias_.value = design.alias ?? '';
    this.default_ = input('既定値');
    this.default_.placeholder = 'なし';
    this.default_.value = design.defaultValue ?? '';
    this.length_ = input('文字数の上限', 'number');
    this.length_.min = '1';
    this.length_.step = '1';
    this.length_.placeholder = 'なし';
    this.length_.value = design.length != null ? String(design.length) : '';
    this.min_ = input('最小', 'number');
    this.min_.step = 'any';
    this.min_.value = design.min != null ? String(design.min) : '';
    this.max_ = input('最大', 'number');
    this.max_.step = 'any';
    this.max_.value = design.max != null ? String(design.max) : '';
    this.codes_ = input('候補値');
    this.codes_.placeholder = '例: 1=住宅, 2=店舗（値だけでも可）';
    this.codes_.value = design.codes ?? '';
    this.details_ = document.createElement('div');
    this.details_.className = 'new-layer-details';
    this.details_.hidden = true;
    const codes = labelled('候補値（表で選べる値）', this.codes_);
    codes.className = 'wide';
    this.details_.append(labelled('表示名', this.alias_), labelled('既定値', this.default_), labelled('文字数の上限', this.length_), labelled('最小', this.min_), labelled('最大', this.max_), codes);
    this.more_.addEventListener('click', () => this.showDetails(this.details_.hidden));
    this.type_.addEventListener('change', () => this.update_());

    const main = document.createElement('div');
    main.className = 'new-layer-field-main';
    main.append(this.name_, this.type_, required, this.more_, remove);
    this.element.append(main, this.details_);
    this.update_();
    // Copied fields with more than a name and a type show what they carry.
    if (design.alias || design.length != null || design.min != null || design.max != null || design.codes || design.defaultValue) this.showDetails(true);
  }

  showDetails(show: boolean): void {
    this.details_.hidden = !show;
    this.more_.setAttribute('aria-expanded', String(show));
  }

  focus(): void {
    this.name_.focus();
  }

  design(): FieldDesign {
    const number = (i: HTMLInputElement) => (i.value.trim() === '' ? null : Number(i.value));
    const type = this.type_.value as DesignType;
    return {
      name: this.name_.value,
      type,
      alias: this.alias_.value,
      required: this.required_.checked,
      length: type === 'string' ? number(this.length_) : null,
      min: type === 'integer' || type === 'double' ? number(this.min_) : null,
      max: type === 'integer' || type === 'double' ? number(this.max_) : null,
      codes: type === 'date' ? '' : this.codes_.value,
      defaultValue: this.default_.value,
    };
  }

  private update_(): void {
    const type = this.type_.value as DesignType;
    const numeric = type === 'integer' || type === 'double';
    this.length_.closest('label')!.hidden = type !== 'string';
    this.min_.closest('label')!.hidden = !numeric;
    this.max_.closest('label')!.hidden = !numeric;
    this.codes_.closest('label')!.hidden = type === 'date';
    this.default_.placeholder = type === 'date' ? '例: 2026-10-17' : 'なし';
  }
}

export class NewLayerDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly title_: HTMLInputElement;
  private readonly geometry_: HTMLSelectElement;
  private readonly list_: HTMLOListElement;
  private readonly copy_: HTMLSelectElement;
  private readonly crs_: HTMLSelectElement;
  private readonly code_: HTMLInputElement;
  private readonly draw_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private rows_: FieldRow[] = [];
  private layers_: ViewerService[] = [];

  constructor(
    button: HTMLButtonElement,
    private readonly options: NewLayerOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service new-layer-dialog';
    this.dialog.setAttribute('aria-labelledby', 'new-layer-title');
    const geometry = (Object.entries(geometryNames) as Array<[DrawableType, string]>).map(([value, name]) => `<option value="${value}">${name}</option>`).join('');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="new-layer-title">新規レイヤー</h2>
        <label>名前<input name="title" type="text" value="新規レイヤー" aria-label="レイヤーの名前" /></label>
        <label>ジオメトリ<select name="geometry" aria-label="ジオメトリ">${geometry}<option value="">指定しない（描くたびに選ぶ）</option></select></label>
        <fieldset class="wide new-layer-fields">
          <legend>属性</legend>
          <ol class="new-layer-list"></ol>
          <p class="new-layer-empty">属性はまだありません（なくても作れます）</p>
          <div class="new-layer-field-actions">
            <button type="button" value="add-field">＋ 属性を追加</button>
            <select name="copy" aria-label="ほかのレイヤーの属性をコピー"></select>
          </div>
        </fieldset>
        <details class="wide new-layer-more-settings">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label class="wide">座標系（書き出しの既定）<select name="crs" aria-label="座標系">${crsPresets
              .map((p) => `<option value="${p.code}">${p.name}</option>`)
              .join('')}<option value="">その他（EPSG コードを入力）</option></select></label>
            <label class="wide" hidden>EPSG コード<input name="code" type="text" placeholder="例: 6677" aria-label="EPSG コード" /></label>
          </div>
        </details>
        <label class="wide check"><input name="draw" type="checkbox" checked /><span>作成したらすぐ地図に描き始める</span></label>
      </form>
      <p class="service-status new-layer-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="create" class="primary">作成</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const el = <T extends Element>(name: string) => this.form_.elements.namedItem(name) as unknown as T;
    this.title_ = el('title');
    this.geometry_ = el('geometry');
    this.copy_ = el('copy');
    this.crs_ = el('crs');
    this.code_ = el('code');
    this.draw_ = el('draw');
    this.list_ = this.dialog.querySelector('.new-layer-list')!;
    this.note_ = this.dialog.querySelector('.new-layer-note')!;
    this.dialog.querySelector('button[value=add-field]')!.addEventListener('click', () => this.addField({ name: '', type: 'string' }).focus());
    this.copy_.addEventListener('change', () => this.copyFrom_());
    this.crs_.addEventListener('change', () => (this.code_.closest('label')!.hidden = this.crs_.value !== ''));
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=create]')!.addEventListener('click', () => void this.create());
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.create();
    });
    button.addEventListener('click', () => this.open());
  }

  /** Opens the dialog with a fresh design: one text attribute "name" to start from. */
  open(): void {
    this.title_.value = '新規レイヤー';
    this.geometry_.value = 'Point';
    this.crs_.value = wgs84.projection;
    this.code_.value = '';
    this.code_.closest('label')!.hidden = true;
    this.rows_ = [];
    this.list_.replaceChildren();
    this.addField({ name: 'name', type: 'string' });
    this.layers_ = this.options.layers().filter((l) => l.service.vector && l.service.vector.fields.length > 0);
    this.copy_.replaceChildren(new Option('ほかのレイヤーの属性をコピー…', ''), ...this.layers_.map((l, i) => new Option(l.name, String(i))));
    this.copy_.hidden = this.layers_.length === 0;
    this.note_.textContent = '';
    this.update_();
    this.dialog.showModal();
    this.title_.select();
  }

  /** Adds an attribute row. */
  addField(design: FieldDesign): FieldRow {
    const row = new FieldRow(design, (r) => {
      this.rows_ = this.rows_.filter((x) => x !== r);
      r.element.remove();
      this.update_();
    });
    this.rows_.push(row);
    this.list_.append(row.element);
    this.update_();
    return row;
  }

  /** The design as filled in (the CRS is resolved on creation). */
  design(): Omit<LayerDesign, 'crs'> {
    return { title: this.title_.value, geometryType: (this.geometry_.value || null) as DrawableType | null, fields: this.rows_.map((r) => r.design()) };
  }

  /** Makes the layer and hands it over; keeps the dialog open to show what is wrong. */
  async create(): Promise<void> {
    let record: TempRecord;
    try {
      const code = (this.crs_.value || this.code_.value).trim();
      if (!code) throw new Error('EPSG コードを入れてください');
      const crs = code === wgs84.projection ? wgs84 : await targetCrs(code);
      const design = { ...this.design(), crs };
      const kind = design.geometryType ? geometryNames[design.geometryType] : 'ジオメトリ指定なし';
      record = designRecord(design, `新規作成（${kind}・属性 ${design.fields.length} 個）`);
    } catch (error) {
      this.note_.textContent = error instanceof Error ? error.message : String(error);
      this.note_.classList.add('error');
      return;
    }
    this.dialog.close();
    await this.options.onCreate(record, this.draw_.checked);
  }

  /** Replaces the attributes with those of the layer chosen in "copy", and takes its geometry type and CRS. */
  private copyFrom_(): void {
    const layer = this.layers_[Number(this.copy_.value)];
    this.copy_.value = '';
    const vector = layer?.service.vector;
    if (!layer || !vector) return;
    this.rows_ = [];
    this.list_.replaceChildren();
    // Ids and geometry columns belong to the source; the new layer gets its own.
    const fields = vector.fields.filter((f) => f.type !== 'oid' && !/^(fid|geom|geometry|shape)$/i.test(f.name) && f.name !== vector.idField);
    for (const field of fields) this.addField(fieldDesignOf(field));
    const type = layer.service.editTarget?.geometryType ?? geometryTypeOf(vector.source.getFeatures());
    if (type) this.geometry_.value = type;
    const crs = layer.service.exportCrs ?? layer.service.fileCrs;
    if (crs && crsPresets.some((p) => p.code === crs.projection)) this.crs_.value = crs.projection;
    this.note_.classList.remove('error');
    this.note_.textContent = `「${layer.name}」の属性 ${fields.length} 個をコピーしました（地物はコピーしません）`;
  }

  private update_(): void {
    (this.dialog.querySelector('.new-layer-empty') as HTMLElement).hidden = this.rows_.length > 0;
    this.note_.classList.remove('error');
  }
}
