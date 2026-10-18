/**
 * The band math dialog (from the processing dialog): an index such as NDVI
 * picked by name, with the bands it needs guessed from the band names or the
 * usual band order, or any expression over the bands (`B1`, `B2`…) under
 * 詳細設定. The result is a new one-band 32-bit float layer, shown in a color
 * scale, that can be saved as a GeoTIFF.
 */
import type { ColorScaleStop } from 'browser-image-enhancement';
import type { EnhancedGeoTIFF, LayerColorScale, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { ExpressionError, FUNCTIONS, guessRoles, INDEX_PRESETS, onlyVariables, parseExpression, variablesOf, type IndexPreset } from './band-math.js';
import { markRow } from './colorize-dialog.js';
import { tiffOf } from './composite-dialog.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { planCalc, runCalc } from './raster-calc-run.js';
import { saveFile } from './save-folder.js';

/** Brown (bare) through yellow to green (dense vegetation), for vegetation indices. */
export const VEGETATION_SCALE: ColorScaleStop[] = [
  [0, [140, 81, 10]],
  [0.35, [223, 194, 125]],
  [0.5, [246, 232, 195]],
  [0.65, [166, 217, 106]],
  [1, [26, 152, 80]],
];

/** The color each index is shown in. */
function scaleOf(preset: IndexPreset | null): LayerColorScale {
  if (!preset) return { scale: 'viridis' };
  if (preset.id === 'ndwi') return { scale: 'blueWhiteRed', reverse: true };
  if (preset.id === 'ndbi') return { scale: 'inferno' };
  return { scale: VEGETATION_SCALE };
}

/** `expression` over role names, written over band names (`B4`…) for the chosen bands. */
export function bandExpression(preset: IndexPreset, bands: ReadonlyArray<number | null>): string | null {
  if (bands.some((b) => b === null)) return null;
  let out = preset.expression;
  preset.roles.forEach((role, i) => (out = out.replace(new RegExp(`\\b${role.name}\\b`, 'g'), `B${bands[i]! + 1}`)));
  return out;
}

export interface BandMathDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file (with its RSET); default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
}

export class BandMathDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly image_: HTMLSelectElement;
  private readonly preset_: HTMLSelectElement;
  private readonly roles_: HTMLElement;
  private readonly expression_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Blob>();
  private images_: ViewerImage[] = [];
  private names_: string[] = [];
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: BandMathDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog band-math-dialog';
    this.dialog.setAttribute('aria-labelledby', 'band-math-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="band-math-title">バンド演算・指標</h2>
        <label class="wide">画像<select name="image" aria-label="画像"></select></label>
        <label class="wide">指標<select name="preset" aria-label="指標">${INDEX_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}<option value="">自由式（詳細設定で入力）</option></select></label>
        <div class="wide service-form band-math-roles"></div>
        <p class="wide processing-hint band-math-hint"></p>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label class="wide">式<input name="expression" type="text" autocomplete="off" spellcheck="false" aria-label="式" placeholder="例: (B4 - B3) / (B4 + B3)" /></label>
            <p class="wide processing-hint band-math-help"></p>
            <label>再サンプリング<select name="resample" aria-label="再サンプリング"><option value="bilinear">バイリニア</option><option value="nearest">最近傍（値を変えない）</option></select></label>
          </div>
        </details>
        <p class="wide processing-hint composite-plan"></p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="save" hidden>選択中の結果を GeoTIFF 保存</button>
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const field = <T extends Element>(name: string) => this.form_.elements.namedItem(name) as unknown as T;
    this.image_ = field('image');
    this.preset_ = field('preset');
    this.expression_ = field('expression');
    this.roles_ = this.dialog.querySelector('.band-math-roles')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    this.image_.addEventListener('change', () => void this.imageChanged_());
    this.preset_.addEventListener('change', () => this.presetChanged_());
    // Typing an expression of one's own makes it 「自由式」.
    this.expression_.addEventListener('input', () => {
      this.preset_.value = '';
      this.roles_.replaceChildren();
      this.describe_();
    });
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog on the selected image (else the first that has several bands). */
  async open(preset = 'ndvi'): Promise<void> {
    this.images_ = [...this.images.list()].filter((i) => tiffOf(i));
    this.image_.replaceChildren(...this.images_.map((image, i) => new Option(`${image.name}（${image.source.getValueBandCount()} バンド）`, String(i))));
    const selected = this.images.selected();
    const start = selected && this.images_.includes(selected) && !this.made_.has(selected) ? selected : (this.images_.find((i) => i.source.getValueBandCount() >= 2) ?? this.images_[0]);
    if (start) this.image_.value = String(this.images_.indexOf(start));
    this.preset_.value = preset;
    this.note_.textContent = this.images_.length ? '' : '画像を開いてください';
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    this.dialog.showModal();
    await this.imageChanged_();
  }

  /** Whether `image` was made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves a result (default: the selected one) as a GeoTIFF. */
  async save(image = this.images.selected()): Promise<void> {
    const blob = image && this.made_.get(image);
    if (!image || !blob) return;
    await saveFile(`${baseName(image.name)}.tif`, blob, this.options.say);
  }

  private image(): ViewerImage | null {
    return this.images_[Number(this.image_.value)] ?? null;
  }

  private preset(): IndexPreset | null {
    return INDEX_PRESETS.find((p) => p.id === this.preset_.value) ?? null;
  }

  private bandCount(): number {
    return this.image()?.source.getValueBandCount() ?? 0;
  }

  private async imageChanged_(): Promise<void> {
    const image = this.image();
    this.names_ = image ? (await image.source.getBandNames().catch(() => [])).map((n) => n ?? '') : [];
    const n = this.bandCount();
    this.dialog.querySelector('.band-math-help')!.textContent =
      `バンドは B1〜B${n || 'n'}（${n} バンド）。演算子 + − × ÷（* /）・べき乗 ^・比較 < > など（1 か 0）、関数 ${Object.keys(FUNCTIONS).join('・')}。0 で割った所などは値なしになります。`;
    this.presetChanged_();
  }

  /** Shows a band choice for each band the index needs, with the guessed bands chosen. */
  private presetChanged_(): void {
    const preset = this.preset();
    const n = this.bandCount();
    const bandName = (b: number) => (this.names_[b] ? `バンド ${b + 1}（${this.names_[b]}）` : `バンド ${b + 1}`);
    if (!preset) {
      this.roles_.replaceChildren();
      if (!this.expression_.value) this.expression_.value = n >= 2 ? '(B2 - B1) / (B2 + B1)' : 'B1';
      (this.dialog.querySelector('.composite-more') as HTMLDetailsElement).open = true;
      this.describe_();
      return;
    }
    const guessed = guessRoles(
      preset.roles.map((r) => r.name),
      n,
      this.names_,
    );
    this.roles_.replaceChildren(
      ...preset.roles.map((role, i) => {
        const label = document.createElement('label');
        label.textContent = role.label;
        const select = document.createElement('select');
        select.name = `role-${role.name}`;
        select.setAttribute('aria-label', role.label);
        select.append(new Option('（選んでください）', ''), ...Array.from({ length: n }, (_, b) => new Option(bandName(b), String(b))));
        select.value = guessed[i] === null ? '' : String(guessed[i]);
        select.addEventListener('change', () => this.fillExpression_());
        label.append(select);
        return label;
      }),
    );
    this.fillExpression_();
  }

  /** The chosen bands of the index's roles. */
  private roleBands_(): Array<number | null> {
    return [...this.roles_.querySelectorAll('select')].map((s) => (s.value === '' ? null : Number(s.value)));
  }

  /** The expression of the index for the chosen bands. */
  private fillExpression_(): void {
    const preset = this.preset();
    if (preset) this.expression_.value = bandExpression(preset, this.roleBands_()) ?? '';
    this.describe_();
  }

  private bandNames(): string[] {
    return Array.from({ length: this.bandCount() }, (_, b) => `B${b + 1}`);
  }

  /** What will be made, or why it cannot. */
  private describe_(): void {
    const preset = this.preset();
    this.dialog.querySelector('.band-math-hint')!.textContent = preset
      ? `${preset.hint} 式: ${this.expression_.value || '（バンドを選んでください）'}`
      : `式: ${this.expression_.value}`;
    const out = this.dialog.querySelector<HTMLElement>('.composite-plan')!;
    const image = this.image();
    this.run_.disabled = true;
    if (!image) return void (out.textContent = '');
    if (preset && this.roleBands_().some((b) => b === null)) return void (out.textContent = `${this.bandCount()} バンドの画像です。使うバンドを選んでください`);
    try {
      parseExpression(this.expression_.value, this.bandNames());
      const { grid } = planCalc([{ image, band: 0 }], image);
      out.textContent = `結果は ${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px、1 バンド（32 bit 浮動小数）。`;
      this.run_.disabled = false;
    } catch (error) {
      out.textContent = error instanceof ExpressionError ? `式: ${error.message}（${error.at + 1} 文字目）` : error instanceof Error ? error.message : String(error);
    }
  }

  /** Makes the result; it opens as a new layer in the index's colors. */
  async run(): Promise<ViewerImage | null> {
    const image = this.image();
    if (!image) return null;
    const preset = this.preset();
    let expr;
    try {
      expr = parseExpression(this.expression_.value, this.bandNames());
    } catch (error) {
      this.note_.textContent = error instanceof Error ? error.message : String(error);
      return null;
    }
    // Every band is a variable (B1…Bn); only those the expression uses are read.
    const bands = variablesOf(expr);
    this.run_.disabled = true;
    const control = { cancelled: false };
    this.running_ = control;
    try {
      this.note_.textContent = '計算しています… 0%';
      const form = new FormData(this.form_);
      const { blob, plan, min, max } = await runCalc({
        inputs: bands.length ? bands.map((band) => ({ image, band })) : [{ image, band: 0 }],
        expr: onlyVariables(expr, bands),
        reference: image,
        resample: form.get('resample') === 'nearest' ? 'nearest' : 'bilinear',
        control,
        onProgress: (done) => {
          if (!control.cancelled) this.note_.textContent = `計算しています… ${Math.floor(done * 100)}%`;
        },
      });
      const name = `${baseName(image.name)}_${preset?.id ?? 'calc'}.tif`;
      this.note_.textContent = '結果を開いています…';
      const file = new File([blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const made = source && this.images.find(source);
      if (!made) return null;
      this.made_.set(made, blob);
      this.images.setBadge(made, preset ? preset.id.toUpperCase() : 'バンド演算');
      made.layer.setColorScale(scaleOf(preset));
      markRow(made);
      this.dialog.close();
      this.options.say(`${name} を作りました（${plan.grid.width.toLocaleString()} × ${plan.grid.height.toLocaleString()} px、値 ${round(min)}〜${round(max)}）`);
      return made;
    } catch (error) {
      if (control.cancelled) this.options.say('バンド演算を中止しました');
      else this.note_.textContent = `計算できませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      this.running_ = null;
      this.run_.disabled = false;
    }
  }
}

const round = (v: number) => Number(v.toPrecision(4)).toString();
