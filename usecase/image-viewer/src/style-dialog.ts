/**
 * The "style" dialog of a vector layer: its symbol (one for every feature, a
 * color per value of an attribute, or the service's own), and labels from an
 * attribute. The map follows every change; OK keeps the style for the next
 * time the layer is opened, Cancel goes back to what it was.
 */
import type { ViewerService } from './images.js';
import {
  categoriesFor,
  categoryColor,
  lineDashes,
  MAX_CATEGORIES,
  pointShapes,
  valuesOf,
  type Category,
  type LayerStyle,
  type LineDash,
  type PointShape,
  type VectorStyleSpec,
} from './vector-style.js';

const optionsHtml = (entries: Record<string, string>) => Object.entries(entries).map(([value, text]) => `<option value="${value}">${text}</option>`).join('');

export class StyleDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly title_: HTMLElement;
  private readonly categories_: HTMLElement;
  private readonly note_: HTMLElement;
  private entry_: ViewerService | null = null;
  private style_: LayerStyle | null = null;
  /** The style when the dialog opened, for Cancel. */
  private before_: VectorStyleSpec | null = null;
  private committed_ = false;
  private categoryList_: Category[] = [];
  private counts_ = new Map<string, number>();
  private othersVisible_ = true;

  constructor(private readonly options: { say: (message: string) => void }) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service style-dialog';
    this.dialog.setAttribute('aria-labelledby', 'style-title');
    this.dialog.innerHTML = `
      <h2 id="style-title">スタイル</h2>
      <form method="dialog" class="style-form">
        <fieldset>
          <legend>シンボル</legend>
          <label class="wide-2">表示方法<select name="mode" aria-label="表示方法">
            <option value="own">サービスの表示のまま</option>
            <option value="single">単一シンボル</option>
            <option value="categorized">属性で色分け</option>
          </select></label>
          <label data-for="categorized">色分けする属性<select name="field" aria-label="色分けする属性"></select></label>
          <div class="style-categories wide" data-for="categorized" role="group" aria-label="分類"></div>
          <label data-for="symbol"><span data-text="fill">塗りの色</span><input type="color" name="fill" aria-label="塗りの色" /></label>
          <label data-for="symbol">塗りの不透明度<input type="range" name="fillOpacity" min="0" max="1" step="0.05" aria-label="塗りの不透明度" /></label>
          <label data-for="symbol">点の形<select name="shape" aria-label="点の形">${optionsHtml(pointShapes)}</select></label>
          <label data-for="symbol">線の色<input type="color" name="stroke" aria-label="線の色" /></label>
          <label data-for="symbol">線の幅（px）<input type="number" name="strokeWidth" min="0" max="20" step="0.5" aria-label="線の幅" /></label>
          <label data-for="symbol">点の大きさ（px）<input type="number" name="size" min="2" max="64" step="1" aria-label="点の大きさ" /></label>
          <label data-for="symbol">線の不透明度<input type="range" name="strokeOpacity" min="0" max="1" step="0.05" aria-label="線の不透明度" /></label>
          <label data-for="symbol">線種<select name="dash" aria-label="線種">${optionsHtml(lineDashes)}</select></label>
        </fieldset>
        <fieldset>
          <legend>ラベル</legend>
          <label class="wide-2">ラベルにする属性<select name="labelField" aria-label="ラベルにする属性"></select></label>
          <label data-for="label">文字の大きさ（px）<input type="number" name="labelSize" min="6" max="64" step="1" aria-label="文字の大きさ" /></label>
          <label data-for="label">文字の色<input type="color" name="labelColor" aria-label="文字の色" /></label>
          <label data-for="label">縁取りの色<input type="color" name="halo" aria-label="縁取りの色" /></label>
          <label data-for="label">縁取りの幅（px）<input type="number" name="haloWidth" min="0" max="12" step="0.5" aria-label="縁取りの幅" /></label>
          <label class="check" data-for="label"><input type="checkbox" name="bold" /><span>太字</span></label>
          <label class="check wide-2" data-for="label"><input type="checkbox" name="overlap" /><span>重なるラベルも全部表示する</span></label>
        </fieldset>
      </form>
      <p class="service-status style-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="reset" class="style-reset">初期設定に戻す</button>
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="ok" class="primary">OK</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.title_ = this.dialog.querySelector('#style-title')!;
    this.categories_ = this.dialog.querySelector('.style-categories')!;
    this.note_ = this.dialog.querySelector('.style-note')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.cancel());
    this.dialog.querySelector('button[value=ok]')!.addEventListener('click', () => this.commit());
    this.dialog.querySelector('button[value=reset]')!.addEventListener('click', () => {
      if (!this.style_) return;
      this.fill_(this.style_.initial);
      this.preview_();
    });
    // Escape too: back to the style the layer had.
    this.dialog.addEventListener('close', () => this.end_());
    this.form_.addEventListener('input', () => this.preview_());
    this.form_.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).getAttribute('name') === 'field') this.loadCategories_();
      this.preview_();
    });
  }

  /** Opens the dialog for a vector layer. */
  open(entry: ViewerService): void {
    const style = entry.service.style;
    const vector = entry.service.vector;
    if (!style || !vector) return;
    this.entry_ = entry;
    this.style_ = style;
    this.committed_ = false;
    this.before_ = style.get();
    this.title_.textContent = `スタイル: ${entry.name}`;
    const fieldOptions = vector.fields.map((f) => new Option(f.alias && f.alias !== f.name ? `${f.alias}（${f.name}）` : f.name, f.name));
    this.select_('field').replaceChildren(...fieldOptions.map((o) => o.cloneNode(true)));
    this.select_('labelField').replaceChildren(new Option('なし', ''), ...fieldOptions);
    this.select_('mode').querySelector<HTMLOptionElement>('option[value=own]')!.hidden = !style.hasOwn();
    this.fill_(this.before_);
    this.preview_();
    this.dialog.showModal();
  }

  /** Goes back to the style the layer had and closes. */
  cancel(): void {
    this.end_();
    this.dialog.close();
  }

  /** Puts back the style the layer had unless OK kept the new one, and forgets the layer. */
  private end_(): void {
    if (!this.committed_ && this.style_ && this.before_) this.style_.set(this.before_, false);
    this.entry_ = this.style_ = this.before_ = null;
  }

  /** Keeps the style shown and closes. */
  commit(): void {
    const entry = this.entry_;
    if (!this.style_ || !entry) return;
    this.style_.set(this.read_());
    this.committed_ = true;
    this.end_();
    this.dialog.close();
    this.options.say(`${entry.name} のスタイルを変更しました`);
  }

  private select_(name: string): HTMLSelectElement {
    return this.form_.elements.namedItem(name) as HTMLSelectElement;
  }

  private input_(name: string): HTMLInputElement {
    return this.form_.elements.namedItem(name) as HTMLInputElement;
  }

  /** Puts a spec in the form. */
  private fill_(spec: VectorStyleSpec): void {
    const fields = [...this.select_('field').options].map((o) => o.value);
    this.select_('mode').value = spec.mode === 'own' && !this.style_?.hasOwn() ? 'single' : spec.mode;
    this.select_('field').value = spec.field && fields.includes(spec.field) ? spec.field : (fields[0] ?? '');
    const s = spec.symbol;
    this.input_('fill').value = s.fill;
    this.input_('fillOpacity').value = String(s.fillOpacity);
    this.input_('stroke').value = s.stroke;
    this.input_('strokeWidth').value = String(s.strokeWidth);
    this.input_('strokeOpacity').value = String(s.strokeOpacity);
    this.select_('dash').value = s.dash;
    this.select_('shape').value = s.shape;
    this.input_('size').value = String(s.size);
    const l = spec.label;
    this.select_('labelField').value = l.field && fields.includes(l.field) ? l.field : '';
    this.input_('labelSize').value = String(l.size);
    this.input_('labelColor').value = l.color;
    this.input_('halo').value = l.halo;
    this.input_('haloWidth').value = String(l.haloWidth);
    this.input_('bold').checked = l.bold;
    this.input_('overlap').checked = l.overlap;
    this.categoryList_ = spec.categories.map((c) => ({ ...c }));
    this.othersVisible_ = spec.othersVisible;
    this.loadCategories_();
  }

  /** The values of the chosen attribute, as rows with a color each. */
  private loadCategories_(): void {
    const field = this.select_('field').value;
    const features = this.entry_?.service.vector?.source.getFeatures() ?? [];
    if (!field) {
      this.categories_.replaceChildren();
      return;
    }
    this.counts_ = new Map(valuesOf(features, field).map((v) => [v.value, v.count]));
    this.categoryList_ = categoriesFor(features, field, this.categoryList_);
    const others = this.counts_.size - this.categoryList_.length;
    const rows = this.categoryList_.map((c, i) => this.categoryRow_(c, i));
    const other = document.createElement('label');
    other.className = 'style-category';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = this.othersVisible_;
    check.setAttribute('aria-label', 'その他を表示');
    check.addEventListener('change', () => (this.othersVisible_ = check.checked));
    const swatch = document.createElement('span');
    swatch.className = 'style-swatch';
    swatch.title = '塗りの色で描きます';
    other.append(check, swatch, `その他${others > 0 ? `（${others.toLocaleString()} 種類）` : ''}`);
    const recolor = document.createElement('button');
    recolor.type = 'button';
    recolor.textContent = '色を振り直す';
    recolor.addEventListener('click', () => {
      this.categoryList_ = this.categoryList_.map((c, i) => ({ ...c, color: categoryColor(i) }));
      this.loadCategories_();
      this.preview_();
    });
    this.categories_.replaceChildren(...rows, other, recolor);
    this.note_.textContent = others > 0 ? `値が ${MAX_CATEGORIES} 種類を超えるため、多い順に ${MAX_CATEGORIES} 種類を色分けし、残りは「その他」として描きます` : '';
  }

  private categoryRow_(category: Category, index: number): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'style-category';
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = category.visible;
    visible.setAttribute('aria-label', `${category.value || '（空）'} を表示`);
    visible.addEventListener('change', () => (this.categoryList_[index].visible = visible.checked));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = category.color;
    color.setAttribute('aria-label', `${category.value || '（空）'} の色`);
    color.addEventListener('input', () => (this.categoryList_[index].color = color.value));
    const text = document.createElement('span');
    text.className = 'style-value';
    text.textContent = category.value || '（空）';
    const count = document.createElement('span');
    count.className = 'style-count';
    count.textContent = (this.counts_.get(category.value) ?? 0).toLocaleString();
    row.append(visible, color, text, count);
    return row;
  }

  /** The spec in the form. */
  private read_(): VectorStyleSpec {
    const num = (name: string, fallback: number) => {
      const v = Number(this.input_(name).value);
      return Number.isFinite(v) ? v : fallback;
    };
    const mode = this.select_('mode').value as VectorStyleSpec['mode'];
    return {
      mode,
      symbol: {
        fill: this.input_('fill').value,
        fillOpacity: num('fillOpacity', 0.25),
        stroke: this.input_('stroke').value,
        strokeWidth: Math.max(0, num('strokeWidth', 2)),
        strokeOpacity: num('strokeOpacity', 1),
        dash: this.select_('dash').value as LineDash,
        shape: this.select_('shape').value as PointShape,
        size: Math.max(2, num('size', 10)),
      },
      field: this.select_('field').value || null,
      categories: this.categoryList_.map((c) => ({ ...c })),
      othersVisible: this.othersVisible_,
      label: {
        field: this.select_('labelField').value || null,
        size: Math.max(6, num('labelSize', 13)),
        color: this.input_('labelColor').value,
        bold: this.input_('bold').checked,
        halo: this.input_('halo').value,
        haloWidth: Math.max(0, num('haloWidth', 3)),
        overlap: this.input_('overlap').checked,
      },
    };
  }

  /** Shows what the form says, on the map and in the form (the parts of the chosen mode). */
  private preview_(): void {
    const spec = this.read_();
    for (const el of this.dialog.querySelectorAll<HTMLElement>('[data-for]')) {
      const part = el.dataset.for;
      el.hidden = part === 'categorized' ? spec.mode !== 'categorized' : part === 'symbol' ? spec.mode === 'own' : part === 'label' ? !spec.label.field : false;
    }
    this.dialog.querySelector('[data-text=fill]')!.textContent = spec.mode === 'categorized' ? '塗りの色（その他）' : '塗りの色';
    if (spec.mode !== 'categorized') this.note_.textContent = '';
    this.style_?.set(spec, false);
  }
}
