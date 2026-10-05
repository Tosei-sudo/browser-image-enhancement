/**
 * The "style" dialog of a vector layer: its symbol (one for every feature, a
 * color per value of an attribute, a color per range of a number, or the
 * service's own), labels from an attribute, and the scales the layer and its
 * labels are shown at (folded away until wanted). The map follows every
 * change; OK keeps the style for the next time the layer is opened, Cancel
 * goes back to what it was.
 */
import type { ViewerService } from './images.js';
import {
  categoriesFor,
  categoryColor,
  classesFor,
  classMethods,
  colorRamps,
  formatBound,
  lineDashes,
  MAX_CATEGORIES,
  MAX_CLASSES,
  numberValue,
  pointShapes,
  recolorClasses,
  scaleOfResolution,
  valuesOf,
  classIndex,
  type Category,
  type ClassMethod,
  type GradClass,
  type RampName,
  type LayerStyle,
  type LineDash,
  type PointShape,
  type VectorStyleSpec,
} from './vector-style.js';

const rampNames = Object.fromEntries(Object.entries(colorRamps).map(([k, r]) => [k, r.name]));

/** A scale denominator in an input: digits only, grouped. */
const scaleText = (scale: number) => Math.round(scale).toLocaleString('ja-JP');

const optionsHtml = (entries: Record<string, string>) => Object.entries(entries).map(([value, text]) => `<option value="${value}">${text}</option>`).join('');

export class StyleDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly title_: HTMLElement;
  private readonly categories_: HTMLElement;
  private readonly classes_: HTMLElement;
  private readonly scales_: HTMLDetailsElement;
  private readonly note_: HTMLElement;
  private entry_: ViewerService | null = null;
  private style_: LayerStyle | null = null;
  /** The style when the dialog opened, for Cancel. */
  private before_: VectorStyleSpec | null = null;
  private committed_ = false;
  private categoryList_: Category[] = [];
  private counts_ = new Map<string, number>();
  private othersVisible_ = true;
  private classList_: GradClass[] = [];
  /** What the ranges were made of (attribute, method, count), so they are made again only when it changes. */
  private madeOf_ = '';
  private classRows_: Array<{ min: HTMLElement; visible: HTMLInputElement; color: HTMLInputElement; count: HTMLElement }> = [];
  private othersCount_: HTMLElement | null = null;

  /**
   * @param options.resolution The map's resolution now, for 「いまの縮尺」.
   */
  constructor(private readonly options: { say: (message: string) => void; resolution?: () => number | undefined }) {
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
            <option value="graduated">数値で段階に色分け</option>
          </select></label>
          <label data-for="categorized">色分けする属性<select name="field" aria-label="色分けする属性"></select></label>
          <label data-for="graduated">段階に分ける属性<select name="gradField" aria-label="段階に分ける属性"></select></label>
          <label data-for="graduated">分け方<select name="method" aria-label="分け方">${optionsHtml(classMethods)}</select></label>
          <label data-for="graduated">段階の数<input type="number" name="classCount" min="1" max="${MAX_CLASSES}" step="1" aria-label="段階の数" /></label>
          <label data-for="graduated">色<select name="ramp" aria-label="色">${optionsHtml(rampNames)}</select></label>
          <label class="check" data-for="graduated"><input type="checkbox" name="reversed" /><span>色を逆順にする</span></label>
          <div class="style-categories wide" data-for="categorized" role="group" aria-label="分類"></div>
          <div class="style-categories style-classes wide" data-for="graduated" role="group" aria-label="段階"></div>
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
          <label class="wide-2" data-for="label">これより縮小したらラベルを隠す<span class="style-scale">1 : <input type="number" name="labelMaxScale" min="1" step="any" placeholder="制限なし" aria-label="ラベルを隠す縮尺" /><button type="button" data-now="labelMaxScale">いまの縮尺</button></span></label>
        </fieldset>
        <details class="style-scales">
          <summary>縮尺で表示を切り替える</summary>
          <div class="style-scale-fields">
            <p class="style-now"></p>
            <label>これより縮小したら隠す<span class="style-scale">1 : <input type="number" name="minScale" min="1" step="any" placeholder="制限なし" aria-label="縮小したら隠す縮尺" /><button type="button" data-now="minScale">いまの縮尺</button></span></label>
            <label>これより拡大したら隠す<span class="style-scale">1 : <input type="number" name="maxScale" min="1" step="any" placeholder="制限なし" aria-label="拡大したら隠す縮尺" /><button type="button" data-now="maxScale">いまの縮尺</button></span></label>
          </div>
        </details>
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
    this.categories_ = this.dialog.querySelector('.style-categories[data-for=categorized]')!;
    this.classes_ = this.dialog.querySelector('.style-classes')!;
    this.scales_ = this.dialog.querySelector('.style-scales')!;
    for (const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-now]')) {
      button.addEventListener('click', () => {
        const now = this.scaleNow_();
        if (!now) return;
        this.input_(button.dataset.now!).value = String(Math.round(now));
        this.preview_();
      });
    }
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
    this.form_.addEventListener('input', (e) => {
      // The ranges follow the number of them as it is typed.
      if ((e.target as HTMLElement).getAttribute('name') === 'classCount') this.remakeClasses_();
      this.preview_();
    });
    this.form_.addEventListener('change', (e) => {
      const name = (e.target as HTMLElement).getAttribute('name');
      if (name === 'field') this.loadCategories_();
      if (name === 'gradField' || name === 'method' || name === 'classCount') this.remakeClasses_();
      if (name === 'ramp' || name === 'reversed') {
        this.classList_ = recolorClasses(this.classList_, this.select_('ramp').value as RampName, this.input_('reversed').checked);
        this.loadClasses_(false);
      }
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
    // Numbers, and text that holds numbers (WFS values are text).
    const sample = vector.source.getFeatures().slice(0, 500);
    const numeric = vector.fields
      .filter((f) => {
        if (f.type === 'integer' || f.type === 'double') return true;
        if (f.type !== 'string' || f.codes) return false;
        const values = sample.map((x) => x.get(f.name)).filter((v) => v !== null && v !== undefined && v !== '');
        return values.length > 0 && values.every((v) => numberValue(v) !== null);
      })
      .map((f) => f.name);
    this.select_('gradField').replaceChildren(...fieldOptions.filter((o) => numeric.includes(o.value)).map((o) => o.cloneNode(true)));
    this.select_('labelField').replaceChildren(new Option('なし', ''), ...fieldOptions);
    this.select_('mode').querySelector<HTMLOptionElement>('option[value=own]')!.hidden = !style.hasOwn();
    this.select_('mode').querySelector<HTMLOptionElement>('option[value=graduated]')!.hidden = !numeric.length;
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
    const numeric = [...this.select_('gradField').options].map((o) => o.value);
    this.select_('mode').value = (spec.mode === 'own' && !this.style_?.hasOwn()) || (spec.mode === 'graduated' && !numeric.length) ? 'single' : spec.mode;
    this.select_('field').value = spec.mode !== 'graduated' && spec.field && fields.includes(spec.field) ? spec.field : (fields[0] ?? '');
    const gradField = spec.mode === 'graduated' && spec.field && numeric.includes(spec.field) ? spec.field : (numeric[0] ?? '');
    this.select_('gradField').value = gradField;
    this.select_('method').value = spec.method;
    this.input_('classCount').value = String(spec.classCount);
    this.select_('ramp').value = spec.ramp;
    this.input_('reversed').checked = spec.reversed;
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
    this.input_('labelMaxScale').value = l.maxScale ? String(l.maxScale) : '';
    this.input_('minScale').value = spec.minScale ? String(spec.minScale) : '';
    this.input_('maxScale').value = spec.maxScale ? String(spec.maxScale) : '';
    this.scales_.open = !!(spec.minScale || spec.maxScale);
    const now = this.scaleNow_();
    this.scales_.querySelector('.style-now')!.textContent = now ? `いまの縮尺はおよそ 1 : ${scaleText(now)} です` : '';
    this.categoryList_ = spec.categories.map((c) => ({ ...c }));
    this.classList_ = spec.mode === 'graduated' && spec.field === gradField ? spec.classes.map((c) => ({ ...c })) : [];
    this.othersVisible_ = spec.othersVisible;
    this.loadCategories_();
    this.loadClasses_(!this.classList_.length);
  }

  /** The scale denominator of the map now, measured where the layer is. */
  private scaleNow_(): number | null {
    const resolution = this.options.resolution?.();
    if (!resolution || !this.style_) return null;
    return scaleOfResolution(resolution, this.style_.latitude() ?? 0);
  }

  /** Makes the ranges again when what they are made of changed (edited bounds stay otherwise). */
  private remakeClasses_(): void {
    if (this.classesKey_() !== this.madeOf_) this.loadClasses_(true);
  }

  private classesKey_(): string {
    return [this.select_('gradField').value, this.select_('method').value, this.classCountValue_()].join('\n');
  }

  private classCountValue_(): number {
    return Math.max(1, Math.min(MAX_CLASSES, Math.round(Number(this.input_('classCount').value) || 5)));
  }

  /** The ranges of the chosen number as rows (made again from the values when `remake`). */
  private loadClasses_(remake: boolean): void {
    const field = this.select_('gradField').value;
    const features = this.entry_?.service.vector?.source.getFeatures() ?? [];
    this.classRows_ = [];
    if (!field) {
      this.classes_.replaceChildren();
      return;
    }
    const ramp = this.select_('ramp').value as RampName;
    const reversed = this.input_('reversed').checked;
    if (remake) this.classList_ = classesFor(features, field, this.select_('method').value as ClassMethod, this.classCountValue_(), ramp, reversed);
    this.madeOf_ = this.classesKey_();
    const rows = this.classList_.map((c, i) => this.classRow_(c, i));
    const other = document.createElement('label');
    other.className = 'style-category';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = this.othersVisible_;
    check.setAttribute('aria-label', '値なし・範囲外を表示');
    check.addEventListener('change', () => (this.othersVisible_ = check.checked));
    const swatch = document.createElement('span');
    swatch.className = 'style-swatch';
    swatch.title = '塗りの色で描きます';
    const text = document.createElement('span');
    text.className = 'style-value';
    text.textContent = '値なし・範囲外';
    this.othersCount_ = document.createElement('span');
    this.othersCount_.className = 'style-count';
    other.append(check, swatch, text, this.othersCount_);
    this.classes_.replaceChildren(...rows, other);
    this.updateClassRows_();
    this.note_.textContent = this.classList_.length ? '' : 'この属性には数値がありません';
  }

  /** The rows' bounds, names and counts, after a bound moved (the rows stay, and so does the focus). */
  private updateClassRows_(): void {
    const field = this.select_('gradField').value;
    const features = this.entry_?.service.vector?.source.getFeatures() ?? [];
    const counts = new Array<number>(this.classList_.length).fill(0);
    let others = 0;
    for (const f of features) {
      const v = numberValue(f.get(field));
      const i = v === null ? -1 : classIndex(this.classList_, v);
      if (i < 0) others++;
      else counts[i]++;
    }
    this.classRows_.forEach((row, i) => {
      const c = this.classList_[i];
      const name = `${formatBound(c.min)} – ${formatBound(c.max)}`;
      row.min.textContent = `${formatBound(c.min)} – `;
      row.visible.setAttribute('aria-label', `${name} を表示`);
      row.color.setAttribute('aria-label', `${name} の色`);
      row.count.textContent = counts[i].toLocaleString();
    });
    if (this.othersCount_) this.othersCount_.textContent = others.toLocaleString();
  }

  private classRow_(range: GradClass, index: number): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = 'style-category';
    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = range.visible;
    visible.addEventListener('change', () => (this.classList_[index].visible = visible.checked));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = range.color;
    color.addEventListener('input', () => (this.classList_[index].color = color.value));
    const bounds = document.createElement('span');
    bounds.className = 'style-value style-bounds';
    const min = document.createElement('span');
    bounds.append(min);
    if (index < this.classList_.length - 1) {
      // The upper bound can be moved (the next range starts there); the last range ends at the largest value.
      const upper = document.createElement('input');
      upper.type = 'number';
      upper.step = 'any';
      upper.value = String(range.max);
      upper.setAttribute('aria-label', `${index + 1} 段目の上限`);
      upper.addEventListener('change', () => {
        const next = this.classList_[index + 1];
        const v = Number(upper.value);
        if (upper.value !== '' && Number.isFinite(v) && v > this.classList_[index].min && v < next.max) this.classList_[index].max = next.min = v;
        else upper.value = String(this.classList_[index].max);
        this.updateClassRows_();
        this.preview_();
      });
      bounds.append(upper);
    } else {
      bounds.append(formatBound(range.max));
    }
    const count = document.createElement('span');
    count.className = 'style-count';
    row.append(visible, color, bounds, count);
    this.classRows_.push({ min, visible, color, count });
    return row;
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
    const scale = (name: string) => {
      const v = Number(this.input_(name).value);
      return this.input_(name).value !== '' && Number.isFinite(v) && v > 0 ? v : null;
    };
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
      field: (mode === 'graduated' ? this.select_('gradField').value : this.select_('field').value) || null,
      categories: this.categoryList_.map((c) => ({ ...c })),
      classes: this.classList_.map((c) => ({ ...c })),
      method: this.select_('method').value as ClassMethod,
      classCount: Math.max(1, Math.min(MAX_CLASSES, Math.round(num('classCount', 5)))),
      ramp: this.select_('ramp').value as RampName,
      reversed: this.input_('reversed').checked,
      othersVisible: this.othersVisible_,
      label: {
        field: this.select_('labelField').value || null,
        size: Math.max(6, num('labelSize', 13)),
        color: this.input_('labelColor').value,
        bold: this.input_('bold').checked,
        halo: this.input_('halo').value,
        haloWidth: Math.max(0, num('haloWidth', 3)),
        overlap: this.input_('overlap').checked,
        maxScale: scale('labelMaxScale'),
      },
      minScale: scale('minScale'),
      maxScale: scale('maxScale'),
    };
  }

  /** Shows what the form says, on the map and in the form (the parts of the chosen mode). */
  private preview_(): void {
    const spec = this.read_();
    for (const el of this.dialog.querySelectorAll<HTMLElement>('[data-for]')) {
      const part = el.dataset.for;
      el.hidden =
        part === 'categorized' || part === 'graduated' ? spec.mode !== part : part === 'symbol' ? spec.mode === 'own' : part === 'label' ? !spec.label.field : false;
    }
    this.dialog.querySelector('[data-text=fill]')!.textContent =
      spec.mode === 'categorized' ? '塗りの色（その他）' : spec.mode === 'graduated' ? '塗りの色（値なし・範囲外）' : '塗りの色';
    if (spec.mode === 'single' || spec.mode === 'own') this.note_.textContent = '';
    if (spec.minScale && spec.maxScale && spec.maxScale >= spec.minScale) this.note_.textContent = '「拡大したら隠す」縮尺は「縮小したら隠す」縮尺より大きく（分母を小さく）してください';
    this.style_?.set(spec, false);
  }
}
