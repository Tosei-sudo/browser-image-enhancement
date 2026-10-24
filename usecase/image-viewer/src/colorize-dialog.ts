/**
 * The coloring dialog (from the processing dialog): a one-band image (SAR,
 * panchromatic, one band of a multispectral image) shown in a color scale,
 * red from black for example, and laid over the layers under it in a blend
 * mode. Two dates in red and cyan, the upper one screened over the lower one,
 * show white where nothing changed and their own color where only one is
 * bright: the same colors as an RGB composite, without making a new image.
 *
 * The image can also be shown in classes of its values (QGIS's discrete
 * and exact ramps): equal intervals, quantiles (classes of equal area),
 * bounds typed in, or one color per value for a classified image (land
 * cover codes). The classes are listed as a legend, with their colors,
 * names and shares of the image, and shown on the map (see `class-legend.ts`).
 *
 * Nothing is computed: the layer colors the map as it draws it (see
 * `GpuCorrectedTileLayer.setColorScale`), so every choice shows at once, the
 * correction panel still works, and the coloring is saved in projects.
 */
import {
  classColors,
  classShares,
  colorClasses,
  colorScales,
  formatClassValue,
  rangeLabels,
  type ClassMethod,
  type ColorClass,
  type ColorClasses,
  type ColorScaleName,
  type ColorScaleStop,
  type RasterHistogram,
} from 'browser-image-enhancement';
import type { LayerBlendMode, LayerColorScale } from 'browser-image-enhancement/openlayers';
import type { ImageList, ViewerImage } from './images.js';

/** The scales offered, in order: one color from black, then ramps. */
export const scaleChoices: Array<[ColorScaleName, string]> = [
  ['red', '赤'],
  ['green', '緑'],
  ['blue', '青'],
  ['cyan', 'シアン（水色）'],
  ['magenta', 'マゼンタ'],
  ['yellow', '黄'],
  ['orange', 'オレンジ'],
  ['inferno', '熱（黒→赤→黄）'],
  ['viridis', 'ビリディス（紫→緑→黄）'],
  ['turbo', '虹（青→赤）'],
  ['blueWhiteRed', '青→白→赤'],
];

export const blendChoices: Array<[LayerBlendMode, string]> = [
  ['normal', '通常'],
  ['screen', 'スクリーン（明るさを足す・時期の比較に）'],
  ['difference', '差（変化箇所のみ明るく）'],
  ['lighten', '比較（明）'],
  ['darken', '比較（暗）'],
  ['multiply', '乗算'],
];

/** A color as `#rrggbb`. */
const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** The stops of a scale chosen here: a preset, or black to a color (`#rrggbb`). */
export function stopsOf(scale: LayerColorScale['scale']): readonly ColorScaleStop[] {
  return typeof scale === 'string' ? colorScales[scale] : scale;
}

/** A CSS gradient of a color scale, left (dark) to right (bright); of classes, a band per class. */
export function gradientOf(c: LayerColorScale): string {
  if (c.classes?.classes.length) {
    const list = [...c.classes.classes].sort((a, b) => a.value - b.value);
    const w = 100 / list.length;
    return `linear-gradient(to right, ${list.map((k, i) => `${cssColor(k.color)} ${(i * w).toFixed(1)}% ${((i + 1) * w).toFixed(1)}%`).join(', ')})`;
  }
  const stops = stopsOf(c.scale).map(([p, color]) => [c.reverse ? 1 - p : p, color] as const).sort((a, b) => a[0] - b[0]);
  const parts = stops.map(([p, color]) => `${c.fade ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${p.toFixed(2)})` : hex(color)} ${(p * 100).toFixed(0)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** A class color as CSS (`#rrggbb`, or `rgba()` when not opaque). */
export function cssColor(c: readonly number[]): string {
  const a = c[3] ?? 255;
  return a >= 255 ? hex(c) : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(a / 255).toFixed(2)})`;
}

/** The name a class is listed with: its label, else its value or range. */
export function classLabel(classes: ColorClasses, index: number): string {
  const c = classes.classes[index];
  if (c.label) return c.label;
  if (classes.kind === 'exact') return String(c.value);
  const list = [...classes.classes].sort((a, b) => a.value - b.value);
  const k = list.indexOf(c);
  return rangeLabels(classes.min ?? list[0].value, list.map((x) => x.value))[k];
}

/** How classes are made in the dialog. */
export type ClassMode = '' | 'classes' | 'unique';

/**
 * Classes for `image` from its value histogram: `method` classes along
 * `scale` (`unique`: a class per value). Null when the image has no values
 * to class (nothing read yet), or too many distinct values for `unique`.
 */
export async function imageClassesFor(
  image: ViewerImage,
  options: { method: ClassMethod; count: number; scale: LayerColorScale['scale']; reverse?: boolean },
): Promise<ColorClasses | null> {
  const hist = await image.source.getValueHistogram();
  return hist ? colorClasses(hist, options) : null;
}

/** `classes` colored again along `scale`, in order of their values (bounds and names kept). */
export function recolor(classes: ColorClasses, scale: LayerColorScale['scale'], reverse = false): ColorClasses {
  const order = classes.classes.map((c, i) => [c.value, i] as const).sort((a, b) => a[0] - b[0]);
  const colors = classColors(scale, order.length, reverse);
  const out = classes.classes.map((c) => ({ ...c }));
  order.forEach(([, i], k) => (out[i].color = colors[k]));
  return { ...classes, classes: out };
}

/** Black to `color` (`#rrggbb`). */
export function oneColor(color: string): ColorScaleStop[] {
  return [
    [0, [0, 0, 0]],
    [1, [1, 3, 5].map((k) => parseInt(color.slice(k, k + 2), 16))],
  ];
}

/** Shows the image's scale on its row (a small gradient), or removes it. */
export function markRow(image: ViewerImage): void {
  const scale = image.layer.getColorScale();
  let swatch = image.row.querySelector<HTMLSpanElement>('.color-swatch');
  if (!scale) {
    swatch?.remove();
    return;
  }
  if (!swatch) {
    swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    image.row.querySelector('.name')?.prepend(swatch);
  }
  swatch.style.background = gradientOf(scale);
  const blend = image.layer.getBlendMode();
  swatch.title = `${scale.classes ? (scale.classes.kind === 'exact' ? '値ごとの色分け' : `${scale.classes.classes.length} 区分の色分け`) : 'カラースケール'}${blend === 'normal' ? '' : `・重ね方: ${blendChoices.find(([b]) => b === blend)?.[1] ?? blend}`}`;
}

export interface ColorizeDialogOptions {
  say: (message: string) => void;
  /** Called after a layer's coloring changed (for a project's unsaved mark). */
  onChange?: (image: ViewerImage) => void;
  /** When an image was taken, to color the earlier one red; default: the order of the list (lowest first). */
  timeOf?: (image: ViewerImage) => Promise<number | null>;
}

export class ColorizeDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly image_: HTMLSelectElement;
  private readonly scale_: HTMLSelectElement;
  private readonly color_: HTMLInputElement;
  private readonly before_: HTMLSelectElement;
  private readonly after_: HTMLSelectElement;
  private readonly mode_: HTMLSelectElement;
  private readonly method_: HTMLSelectElement;
  private readonly count_: HTMLInputElement;
  private images_: ViewerImage[] = [];
  /** The classes the form shows (null: a smooth scale). */
  private classes_: ColorClasses | null = null;
  /** The value histogram of the chosen image, for the classes' shares. */
  private hist_: { image: ViewerImage; hist: RasterHistogram | null } | null = null;
  /** Counts class rebuilds, so that a slow histogram read does not overwrite a newer choice. */
  private request_ = 0;

  constructor(
    private readonly images: ImageList,
    private readonly options: ColorizeDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog colorize-dialog';
    this.dialog.setAttribute('aria-labelledby', 'colorize-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="colorize-title">単バンド画像の着色</h2>
        <label class="wide">画像<select name="image" aria-label="画像"></select></label>
        <label>カラースケール<select name="scale" aria-label="カラースケール">
          <option value="">なし（白黒）</option>
          ${scaleChoices.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          <option value="custom">好きな色…</option>
        </select></label>
        <label class="colorize-custom" hidden>色<input name="color" type="color" value="#ff8800" aria-label="色" /></label>
        <label>表示方法<select name="mode" aria-label="表示方法">
          <option value="">連続（なめらかに）</option>
          <option value="classes">区分（値の範囲ごとに色分け）</option>
          <option value="unique">値ごとに色分け（分類画像）</option>
        </select></label>
        <div class="wide colorize-preview" aria-hidden="true"></div>
        <div class="wide colorize-classes" hidden>
          <div class="service-form">
            <label class="class-range-only">分け方<select name="method" aria-label="分け方">
              <option value="equal">等間隔</option>
              <option value="quantile">分位数（面積が同じ）</option>
              <option value="manual">手動（境界の値を入力）</option>
            </select></label>
            <label class="class-range-only">クラス数<input name="count" type="number" min="2" max="32" step="1" value="5" aria-label="クラス数" /></label>
          </div>
          <table class="class-legend" aria-label="凡例">
            <thead><tr><th>色</th><th>値</th><th>名前</th><th>面積</th></tr></thead>
            <tbody></tbody>
          </table>
          <p class="processing-hint class-hint"></p>
        </div>
        <label class="check"><input name="reverse" type="checkbox" /><span>反転（暗い所を明るい色に）</span></label>
        <label class="check colorize-fade"><input name="fade" type="checkbox" /><span>暗い所を透明に</span></label>
        <label class="wide">下のレイヤーとの重ね方<select name="blend" aria-label="重ね方">${blendChoices.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <details class="wide colorize-pair">
          <summary>2 時期の色分け重ね合わせ</summary>
          <div class="service-form">
            <label>前の画像<select name="before" aria-label="前の画像"></select></label>
            <label>後の画像<select name="after" aria-label="後の画像"></select></label>
            <p class="wide processing-hint">前を赤、後をシアンとし、後をスクリーンで重ね合わせ。変化なしの所は白黒、後で明るくなった所はシアン、暗くなった所は赤。</p>
            <button type="button" value="pair" class="wide">赤とシアンで重ね合わせ</button>
          </div>
        </details>
        <p class="wide processing-hint colorize-scale-hint">選ぶとすぐ地図に反映。補正パネルの明るさ・コントラストは着色前に適用。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="clear">着色の解除</button>
        <button type="button" value="cancel" class="primary">閉じる</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const field = <T extends Element>(name: string) => this.form_.elements.namedItem(name) as unknown as T;
    this.image_ = field('image');
    this.scale_ = field('scale');
    this.color_ = field('color');
    this.before_ = field('before');
    this.after_ = field('after');
    this.mode_ = field('mode');
    this.method_ = field('method');
    this.count_ = field('count');
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=clear]')!.addEventListener('click', () => {
      this.scale_.value = '';
      this.mode_.value = '';
      this.classes_ = null;
      field<HTMLSelectElement>('blend').value = 'normal';
      this.apply_();
      this.legend_();
    });
    this.dialog.querySelector('button[value=pair]')!.addEventListener('click', () => this.pair_());
    this.image_.addEventListener('change', () => this.show_());
    for (const name of ['scale', 'color', 'reverse']) field<HTMLElement>(name).addEventListener(name === 'color' ? 'input' : 'change', () => this.recolor_());
    for (const name of ['fade', 'blend']) field<HTMLElement>(name).addEventListener('change', () => this.apply_());
    this.mode_.addEventListener('change', () => {
      if (this.mode_.value && !this.scale_.value) this.scale_.value = 'turbo';
      void this.rebuild_();
    });
    this.method_.addEventListener('change', () => void this.rebuild_());
    this.count_.addEventListener('change', () => void this.rebuild_());
  }

  /** Opens the dialog on `image` (default: the selected image, else the first one-band image). */
  async open(image = this.images.selected()): Promise<void> {
    this.images_ = [...this.images.list()];
    const label = (i: ViewerImage) => `${i.name}${i.source.getValueBandCount() > 1 && !i.source.getSelect()?.every((b, _, all) => b === all[0]) ? '（カラー：明るさで着色）' : ''}`;
    this.image_.replaceChildren(...this.images_.map((i, n) => new Option(label(i), String(n))));
    const single = this.images_.filter((i) => i.source.getValueBandCount() === 1);
    const chosen = image && this.images_.includes(image) ? image : (single[0] ?? this.images_[0]);
    if (chosen) this.image_.value = String(this.images_.indexOf(chosen));
    // The two dates: the earliest two one-band images (else the lowest two in the list).
    const order = new Map(this.images_.map((i, n) => [i, -n]));
    if (this.options.timeOf) {
      const times = await Promise.all(single.map((i) => this.options.timeOf!(i).catch(() => null)));
      if (times.every((t) => t !== null)) single.forEach((i, k) => order.set(i, times[k]!));
    }
    const pair = (single.length >= 2 ? single : this.images_).slice().sort((a, b) => order.get(a)! - order.get(b)!);
    for (const s of [this.before_, this.after_]) s.replaceChildren(...this.images_.map((i, n) => new Option(i.name, String(n))));
    if (pair[0]) this.before_.value = String(this.images_.indexOf(pair[0]));
    if (pair[1]) this.after_.value = String(this.images_.indexOf(pair[1]));
    (this.dialog.querySelector('.colorize-pair') as HTMLDetailsElement).hidden = this.images_.length < 2;
    this.dialog.querySelector('.processing-note')!.textContent = this.images_.length ? '' : '画像なし（先に画像を開く）';
    this.show_();
    this.dialog.showModal();
  }

  /** Colors `image` with `scale` and lays it over the layers under it with `blend`. */
  set(image: ViewerImage, scale: LayerColorScale | null, blend: LayerBlendMode): void {
    image.layer.setColorScale(scale);
    image.layer.setBlendMode(blend);
    markRow(image);
    this.options.onChange?.(image);
  }

  /** The form shows the chosen image's coloring. */
  private show_(): void {
    const image = this.images_[Number(this.image_.value)];
    const scale = image?.layer.getColorScale() ?? null;
    const field = (name: string) => this.form_.elements.namedItem(name) as HTMLInputElement;
    if (!scale) this.scale_.value = '';
    else if (typeof scale.scale === 'string') this.scale_.value = scale.scale;
    else {
      this.scale_.value = 'custom';
      this.color_.value = hex(scale.scale[scale.scale.length - 1][1]);
    }
    field('reverse').checked = !!scale?.reverse;
    field('fade').checked = !!scale?.fade;
    (this.form_.elements.namedItem('blend') as HTMLSelectElement).value = image?.layer.getBlendMode() ?? 'normal';
    this.classes_ = scale?.classes ? { ...scale.classes, classes: scale.classes.classes.map((c) => ({ ...c })) } : null;
    this.mode_.value = !this.classes_ ? '' : this.classes_.kind === 'exact' ? 'unique' : 'classes';
    if (this.classes_?.kind === 'range') {
      this.method_.value = this.classes_.method === 'quantile' || this.classes_.method === 'manual' ? this.classes_.method : 'equal';
      this.count_.value = String(this.classes_.classes.length);
    }
    this.request_++;
    this.preview_();
    this.legend_();
  }

  /** The form's coloring, on the chosen image. */
  private apply_(): void {
    const image = this.images_[Number(this.image_.value)];
    if (!image) return;
    this.set(image, this.scale(), (this.form_.elements.namedItem('blend') as HTMLSelectElement).value as LayerBlendMode);
    this.preview_();
  }

  /** The scale the form sets, or null for none. */
  scale(): LayerColorScale | null {
    const value = this.scale_.value;
    if (!value) return null;
    const field = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).checked;
    const scale = this.scaleValue_();
    const classes = this.mode_.value && this.classes_ ? this.classes_ : null;
    if (classes) return { scale, ...(field('reverse') ? { reverse: true } : {}), classes };
    return { scale, ...(field('reverse') ? { reverse: true } : {}), ...(field('fade') ? { fade: true } : {}) };
  }

  /** The scale chosen in the form (turbo when none is, for classes). */
  private scaleValue_(): LayerColorScale['scale'] {
    const value = this.scale_.value;
    return value === 'custom' ? oneColor(this.color_.value) : ((value || 'turbo') as ColorScaleName);
  }

  /** A new scale or its direction: classes take their colors from it again. */
  private recolor_(): void {
    if (this.mode_.value && !this.scale_.value) this.mode_.value = '';
    if (this.mode_.value && this.classes_) {
      const reverse = (this.form_.elements.namedItem('reverse') as HTMLInputElement).checked;
      this.classes_ = recolor(this.classes_, this.scaleValue_(), reverse);
    }
    this.apply_();
    if (this.mode_.value && !this.classes_) void this.rebuild_();
    else this.legend_();
  }

  /** Makes the classes again from the image's values (a new mode, method or count), then colors the image with them. */
  private async rebuild_(): Promise<void> {
    const image = this.images_[Number(this.image_.value)];
    const mode = this.mode_.value as ClassMode;
    const request = ++this.request_;
    const hint = this.dialog.querySelector<HTMLElement>('.class-hint')!;
    if (!image || !mode) {
      this.classes_ = null;
      this.apply_();
      this.legend_();
      return;
    }
    const count = Math.min(32, Math.max(2, Math.round(Number(this.count_.value) || 5)));
    this.count_.value = String(count);
    const reverse = (this.form_.elements.namedItem('reverse') as HTMLInputElement).checked;
    const scale = this.scaleValue_();
    if (mode === 'classes' && this.method_.value === 'manual' && this.classes_?.kind === 'range') {
      // By hand: the bounds stay; a new count adds or removes classes at the top.
      this.classes_ = recolor(resize(this.classes_, count), scale, reverse);
      this.apply_();
      this.legend_();
      return;
    }
    this.preview_(true);
    hint.textContent = '画像の値を読み込み中…';
    const method: ClassMethod = mode === 'unique' ? 'unique' : this.method_.value === 'quantile' ? 'quantile' : 'equal';
    const classes = await imageClassesFor(image, { method, count, scale, reverse }).catch(() => null);
    if (request !== this.request_) return;
    if (!classes) {
      hint.textContent = mode === 'unique' ? '値の種類が多すぎ（64 種類まで）。「区分」で色分け' : '画像の値の読み込みに失敗';
      return;
    }
    this.classes_ = classes;
    this.apply_();
    this.legend_();
  }

  private preview_(waiting = false): void {
    const scale = this.scale();
    (this.dialog.querySelector('.colorize-custom') as HTMLElement).hidden = this.scale_.value !== 'custom';
    const mode = this.mode_.value as ClassMode;
    (this.dialog.querySelector('.colorize-classes') as HTMLElement).hidden = !mode;
    (this.dialog.querySelector('.colorize-fade') as HTMLElement).hidden = !!mode;
    (this.dialog.querySelector('.colorize-scale-hint') as HTMLElement).hidden = !!mode;
    for (const el of this.dialog.querySelectorAll<HTMLElement>('.class-range-only')) el.hidden = mode !== 'classes';
    const preview = this.dialog.querySelector<HTMLElement>('.colorize-preview')!;
    preview.style.background = gradientOf(scale ?? { scale: 'gray' });
    if (waiting) preview.style.background = gradientOf({ scale: this.scaleValue_() });
  }

  /** The legend of the classes: a row per class with its color, bound or value, name and share of the image. */
  private legend_(): void {
    const body = this.dialog.querySelector<HTMLElement>('.class-legend tbody')!;
    const hint = this.dialog.querySelector<HTMLElement>('.class-hint')!;
    const classes = this.mode_.value ? this.classes_ : null;
    if (!classes) {
      body.replaceChildren();
      hint.textContent = '';
      return;
    }
    const image = this.images_[Number(this.image_.value)];
    if (image && this.hist_?.image !== image) {
      const read = { image, hist: null as RasterHistogram | null };
      this.hist_ = read;
      void image.source.getValueHistogram().then((hist) => {
        if (this.hist_ !== read || !hist) return;
        read.hist = hist;
        this.shares_();
      });
    }
    const order = classes.classes.map((c, i) => [c.value, i] as const).sort((a, b) => a[0] - b[0]);
    const width = order.length > 1 ? (order[order.length - 1][0] - (classes.min ?? order[0][0])) / order.length : 1;
    body.replaceChildren(
      ...order.map(([, i], k) => {
        const c = classes.classes[i];
        const row = document.createElement('tr');
        const color = Object.assign(document.createElement('input'), { type: 'color', value: hex(c.color) });
        color.setAttribute('aria-label', `クラス ${k + 1} の色`);
        color.addEventListener('input', () => {
          this.classes_!.classes = this.classes_!.classes.map((x, j) => (j === i ? { ...x, color: [1, 3, 5].map((p) => parseInt(color.value.slice(p, p + 2), 16)) } : x));
          this.apply_();
        });
        const value = document.createElement('td');
        if (classes.kind === 'exact') value.textContent = formatClassValue(c.value, width);
        else {
          const lower = k === 0 ? (classes.min ?? c.value) : order[k - 1][0];
          const bound = Object.assign(document.createElement('input'), { type: 'number', step: 'any', value: String(Number(c.value.toPrecision(12))) });
          bound.setAttribute('aria-label', `クラス ${k + 1} の上限`);
          bound.addEventListener('change', () => this.setBound_(i, Number(bound.value)));
          value.append(`${formatClassValue(lower, width)} – `, bound);
        }
        const name = Object.assign(document.createElement('input'), { type: 'text', value: c.label ?? '' });
        name.setAttribute('aria-label', `クラス ${k + 1} の名前`);
        name.addEventListener('change', () => {
          this.classes_!.classes = this.classes_!.classes.map((x, j) => (j === i ? { ...x, label: name.value.trim() || autoLabel(this.classes_!, j) } : x));
          this.apply_();
        });
        const share = document.createElement('td');
        share.className = 'class-share';
        share.dataset.index = String(i);
        const cell = (el: Node) => {
          const td = document.createElement('td');
          td.append(el);
          return td;
        };
        row.append(cell(color), value, cell(name), share);
        return row;
      }),
    );
    this.shares_();
    hint.textContent =
      classes.kind === 'exact'
        ? '選ぶとすぐ地図に反映。画像の値ごとに着色、名前の入力で凡例に表示。'
        : '色分けは画像の値で決定、補正パネルの明るさ・コントラストは適用外。上限の書き換えで手動に切り替え。';
  }

  /** Fills in the share of the image each class gets, once the image's values are read. */
  private shares_(): void {
    const image = this.images_[Number(this.image_.value)];
    const classes = this.mode_.value ? this.classes_ : null;
    const shares = classes && this.hist_?.image === image && this.hist_.hist ? classShares(this.hist_.hist, classes) : null;
    for (const cell of this.dialog.querySelectorAll<HTMLElement>('.class-share')) {
      const share = shares?.[Number(cell.dataset.index)];
      cell.textContent = share === undefined ? '' : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
    }
  }

  /** Sets the upper bound of class `index` (by hand): the classes are sorted again and named after their new ranges. */
  private setBound_(index: number, value: number): void {
    const classes = this.classes_;
    if (!classes || !Number.isFinite(value)) return;
    const auto = classes.classes.map((c, j) => c.label === autoLabel(classes, j));
    const list = classes.classes.map((c, j) => ({ ...c, value: j === index ? value : c.value }));
    const next: ColorClasses = { ...classes, method: 'manual', classes: list };
    if (next.min !== undefined && value < next.min) next.min = value;
    next.classes = list.map((c, j) => (auto[j] ? { ...c, label: autoLabel(next, j) } : c));
    this.classes_ = next;
    this.method_.value = 'manual';
    this.apply_();
    this.legend_();
  }

  /** The earlier image in red, the later one in cyan screened over it, both shown. */
  private pair_(): void {
    const before = this.images_[Number(this.before_.value)];
    const after = this.images_[Number(this.after_.value)];
    const note = this.dialog.querySelector('.processing-note')!;
    if (!before || !after || before === after) {
      note.textContent = '別々の画像を選択';
      return;
    }
    // The later image goes right above the earlier one.
    const layers = [...this.images.layers()];
    layers.splice(layers.indexOf(after), 1);
    layers.splice(layers.indexOf(before), 0, after);
    this.images.arrange(layers);
    this.set(before, { scale: 'red' }, 'normal');
    this.set(after, { scale: 'cyan' }, 'screen');
    for (const image of [before, after]) {
      this.images.setVisible(image, true);
      this.images.setOpacity(image, 1);
    }
    this.image_.value = String(this.images_.indexOf(after));
    this.show_();
    note.textContent = '';
    this.options.say(`${before.name} を赤、${after.name} をシアンで重ね合わせ`);
  }
}

/** The name a range class gets from its bounds (or an exact class from its value). */
function autoLabel(classes: ColorClasses, index: number): string {
  return classLabel({ ...classes, classes: classes.classes.map((c, j) => (j === index ? { ...c, label: undefined } : c)) }, index);
}

/** Range classes made `count` long: the top class split in two, or the top classes merged. */
function resize(classes: ColorClasses, count: number): ColorClasses {
  const list: ColorClass[] = [...classes.classes].sort((a, b) => a.value - b.value).map((c) => ({ ...c }));
  while (list.length > count && list.length > 1) {
    const top = list.pop()!;
    list[list.length - 1].value = top.value;
  }
  while (list.length < count) {
    const top = list[list.length - 1];
    const lower = list.length > 1 ? list[list.length - 2].value : (classes.min ?? top.value - 1);
    list.splice(list.length - 1, 0, { ...top, value: (lower + top.value) / 2 });
  }
  const out: ColorClasses = { ...classes, classes: list };
  out.classes = list.map((c, j) => ({ ...c, label: autoLabel(out, j) }));
  return out;
}
