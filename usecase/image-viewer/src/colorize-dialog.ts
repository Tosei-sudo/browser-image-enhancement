/**
 * The coloring dialog (from the processing dialog): a one-band image (SAR,
 * panchromatic, one band of a multispectral image) shown in a color scale,
 * red from black for example, and laid over the layers under it in a blend
 * mode. Two dates in red and cyan, the upper one screened over the lower one,
 * show white where nothing changed and their own color where only one is
 * bright: the same colors as an RGB composite, without making a new image.
 *
 * Nothing is computed: the layer colors the map as it draws it (see
 * `GpuCorrectedTileLayer.setColorScale`), so every choice shows at once, the
 * correction panel still works, and the coloring is saved in projects.
 */
import { colorScales, type ColorScaleName, type ColorScaleStop } from 'browser-image-enhancement';
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
  ['difference', '差（変わった所だけ明るく）'],
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

/** A CSS gradient of a color scale, left (dark) to right (bright). */
export function gradientOf(c: LayerColorScale): string {
  const stops = stopsOf(c.scale).map(([p, color]) => [c.reverse ? 1 - p : p, color] as const).sort((a, b) => a[0] - b[0]);
  const parts = stops.map(([p, color]) => `${c.fade ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${p.toFixed(2)})` : hex(color)} ${(p * 100).toFixed(0)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
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
  swatch.title = `カラースケール${blend === 'normal' ? '' : `・重ね方: ${blendChoices.find(([b]) => b === blend)?.[1] ?? blend}`}`;
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
  private images_: ViewerImage[] = [];

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
        <div class="wide colorize-preview" aria-hidden="true"></div>
        <label class="check"><input name="reverse" type="checkbox" /><span>反転（暗い所を明るい色に）</span></label>
        <label class="check"><input name="fade" type="checkbox" /><span>暗い所を透明に</span></label>
        <label class="wide">下のレイヤーとの重ね方<select name="blend" aria-label="重ね方">${blendChoices.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <details class="wide colorize-pair">
          <summary>2 時期を色分けして重ねる</summary>
          <div class="service-form">
            <label>前の画像<select name="before" aria-label="前の画像"></select></label>
            <label>後の画像<select name="after" aria-label="後の画像"></select></label>
            <p class="wide processing-hint">前を赤、後をシアンにして、後をスクリーンで重ねます。変わらない所は白黒、後で明るくなった所はシアン、暗くなった所は赤になります。</p>
            <button type="button" value="pair" class="wide">赤とシアンで重ねる</button>
          </div>
        </details>
        <p class="wide processing-hint">選ぶとすぐ地図に反映されます。補正パネルの明るさ・コントラストは色を付ける前に効きます。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="clear">着色をやめる</button>
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
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=clear]')!.addEventListener('click', () => {
      this.scale_.value = '';
      field<HTMLSelectElement>('blend').value = 'normal';
      this.apply_();
    });
    this.dialog.querySelector('button[value=pair]')!.addEventListener('click', () => this.pair_());
    this.image_.addEventListener('change', () => this.show_());
    for (const name of ['scale', 'color', 'reverse', 'fade', 'blend']) field<HTMLElement>(name).addEventListener(name === 'color' ? 'input' : 'change', () => this.apply_());
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
    this.dialog.querySelector('.processing-note')!.textContent = this.images_.length ? '' : '画像を開いてください';
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
    this.preview_();
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
    const scale = value === 'custom' ? oneColor(this.color_.value) : (value as ColorScaleName);
    return { scale, ...(field('reverse') ? { reverse: true } : {}), ...(field('fade') ? { fade: true } : {}) };
  }

  private preview_(): void {
    const scale = this.scale();
    (this.dialog.querySelector('.colorize-custom') as HTMLElement).hidden = this.scale_.value !== 'custom';
    const preview = this.dialog.querySelector<HTMLElement>('.colorize-preview')!;
    preview.style.background = gradientOf(scale ?? { scale: 'gray' });
  }

  /** The earlier image in red, the later one in cyan screened over it, both shown. */
  private pair_(): void {
    const before = this.images_[Number(this.before_.value)];
    const after = this.images_[Number(this.after_.value)];
    const note = this.dialog.querySelector('.processing-note')!;
    if (!before || !after || before === after) {
      note.textContent = '別々の画像を選んでください';
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
    this.options.say(`${before.name} を赤、${after.name} をシアンで重ねました`);
  }
}
