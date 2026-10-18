/**
 * The change detection dialog (from the processing dialog): an image before
 * and one after (a band of each), compared pixel by pixel on one grid (see
 * raster-calc-run.ts). The comparison opens as a new layer, blue where the
 * value fell and red where it rose; the pixels that changed more than a
 * threshold (by default the mean ± 2 standard deviations) are outlined as a
 * temporary polygon layer, each with its direction, area and pixels.
 */
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import { getTransform } from 'ol/proj.js';
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { parseExpression } from './band-math.js';
import { CHANGE_METHODS, changeMask, spreadOf, thresholdsOf, type ChangeDirection, type ChangeMethod, type ChangeThresholds } from './change.js';
import { markRow } from './colorize-dialog.js';
import { pixelSize, tiffOf, type Channel } from './composite-dialog.js';
import { formatArea, geodesicArea } from './geodesic.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { optionFor, type DataSources } from './data-sources.js';
import { polygonize } from './mask-polygons.js';
import { field, type ProcessingResult } from './processing/common.js';
import { planCalc, runCalc, type CalcResult } from './raster-calc-run.js';
import type { LonLat } from './coordinates.js';

/** Most pixels the outlines are traced over (the change image is read reduced to this). */
const MAX_TRACE_PIXELS = 4_000_000;
/** Most polygons kept (the largest). */
const MAX_POLYGONS = 20_000;

export interface ChangeDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file; default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
  /** Files as inputs, without adding them to the map (📂). */
  sources?: DataSources;
  /** When an image was taken, to put the earlier one first. */
  timeOf?: (image: ViewerImage) => Promise<number | null>;
  /** Adds the outlines of what changed as a temporary layer. */
  onPolygons?: (result: ProcessingResult, made: string) => Promise<void>;
}

/** The changed areas as features in `EPSG:3857`, with their direction, area and pixel count. */
export function changeFeatures(
  values: ArrayLike<number>,
  width: number,
  height: number,
  thresholds: ChangeThresholds,
  direction: ChangeDirection,
  toMap: (x: number, y: number) => [number, number],
  toLonLat: (xy: [number, number]) => LonLat,
  minPixels: number,
  /** Original pixels per traced pixel. */
  scale: number,
): { features: Feature[]; truncated: boolean } {
  const ways: Array<Exclude<ChangeDirection, 'both'>> = direction === 'both' ? ['increase', 'decrease'] : [direction];
  const features: Feature[] = [];
  let truncated = false;
  for (const way of ways) {
    const polygons = polygonize(changeMask(values, thresholds, way), width, height, { minPixels, maxPolygons: MAX_POLYGONS + 1 });
    if (polygons.length > MAX_POLYGONS) {
      truncated = true;
      polygons.length = MAX_POLYGONS;
    }
    for (const p of polygons) {
      const rings = p.rings.map((ring) => {
        const out = ring.map(([x, y]) => toMap(x, y));
        out.push(out[0]);
        return out;
      });
      let area = geodesicArea(rings[0].slice(0, -1).map(toLonLat)).area;
      for (const hole of rings.slice(1)) area -= geodesicArea(hole.slice(0, -1).map(toLonLat)).area;
      features.push(new Feature({ geometry: new Polygon(rings), 方向: way === 'increase' ? '増加' : '減少', 面積_m2: Math.round(area * 10) / 10, 画素数: Math.round(p.pixels * scale) }));
    }
  }
  return { features, truncated };
}

export class ChangeDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly before_: HTMLSelectElement;
  private readonly after_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Blob>();
  private images_: ViewerImage[] = [];
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: ChangeDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog change-dialog';
    this.dialog.setAttribute('aria-labelledby', 'change-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="change-title">変化抽出（2 時期）</h2>
        <p class="wide processing-hint">同じ場所の 2 枚を比べ、値が下がった所を青、上がった所を赤で表示し、大きく変わった所をポリゴンにします。</p>
        <label class="wide">前<select name="before" aria-label="前の画像"></select></label>
        <label class="wide">後<select name="after" aria-label="後の画像"></select></label>
        <label class="wide">比べ方<select name="method" aria-label="比べ方">${CHANGE_METHODS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}</select></label>
        <label class="wide check"><input name="outline" type="checkbox" checked /><span>変化した所をポリゴンにする</span></label>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label>しきい値<input name="threshold" type="number" min="0" step="any" placeholder="自動（平均 ± 2σ）" aria-label="しきい値" /></label>
            <label>向き<select name="direction" aria-label="向き"><option value="both">増加と減少</option><option value="increase">増加だけ</option><option value="decrease">減少だけ</option></select></label>
            <label>最小の大きさ（画素）<input name="minPixels" type="number" min="1" step="1" value="9" aria-label="最小の大きさ" /></label>
            <label>再サンプリング<select name="resample" aria-label="再サンプリング"><option value="bilinear">バイリニア</option><option value="nearest">最近傍（値を変えない）</option></select></label>
            <p class="wide processing-hint">しきい値は「変化なし」（差は 0、比は 1）からの隔たりです。空欄なら、変化の平均 ± 標準偏差の 2 倍を超えた所を変化とします。</p>
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
    this.before_ = this.form_.elements.namedItem('before') as HTMLSelectElement;
    this.after_ = this.form_.elements.namedItem('after') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    for (const s of [this.before_, this.after_]) s.addEventListener('change', () => this.describe_());
    for (const s of [this.before_, this.after_])
      options.sources?.attach(s, { dialog: this.dialog, kind: 'image', refill: () => this.open(), valueOf: (l) => optionFor(s, this.images_.indexOf(l as ViewerImage)) });
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog with the two earliest one-band images (else the lowest two in the list), the earlier as before. */
  async open(): Promise<void> {
    this.images_ = this.images.inputImages().filter((i) => tiffOf(i) && !this.made_.has(i));
    const options = this.images_.flatMap((image, i) => {
      const bands = image.source.getValueBandCount();
      const label = (text: string) => this.options.sources?.label(image, text) ?? text;
      if (bands <= 1) return [new Option(label(image.name), `${i}:0`)];
      return Array.from({ length: bands }, (_, b) => new Option(label(`${image.name} ・ バンド ${b + 1}`), `${i}:${b}`));
    });
    for (const s of [this.before_, this.after_]) s.replaceChildren(...options.map((o) => new Option(o.text, o.value)));
    this.note_.textContent = this.images_.length >= 2 ? '' : '比べる画像を 2 枚開いてください';
    const selected = this.images.selected();
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    if (!this.dialog.open) this.dialog.showModal();

    // Lowest in the list first, else by time when every image has one.
    const order = new Map(this.images_.map((image, i) => [image, -i]));
    if (this.options.timeOf) {
      const times = await Promise.all(this.images_.map((image) => this.options.timeOf!(image).catch(() => null)));
      if (times.every((t) => t !== null)) this.images_.forEach((image, k) => order.set(image, times[k]!));
    }
    const [first, second] = [...this.images_].sort((a, b) => order.get(a)! - order.get(b)!);
    if (first) this.before_.value = `${this.images_.indexOf(first)}:0`;
    if (second) this.after_.value = `${this.images_.indexOf(second)}:0`;
    this.describe_();
  }

  /** Whether `image` is a change image made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves a change image (default: the selected one) as a GeoTIFF. */
  save(image = this.images.selected()): void {
    const blob = image && this.made_.get(image);
    if (!image || !blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName(image.name)}.tif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    this.options.say(`${a.download} を保存しました`);
  }

  private channel_(select: HTMLSelectElement): Channel | null {
    if (!select.value) return null;
    const [i, band] = select.value.split(':').map(Number);
    const image = this.images_[i];
    return image ? { image, band } : null;
  }

  private method_(): ChangeMethod {
    const id = new FormData(this.form_).get('method');
    return CHANGE_METHODS.find((m) => m.id === id) ?? CHANGE_METHODS[0];
  }

  /** The finer of the two images, whose grid the result takes. */
  private reference_(before: Channel, after: Channel): ViewerImage {
    return pixelSize(after.image) < pixelSize(before.image) ? after.image : before.image;
  }

  private describe_(): void {
    const out = this.dialog.querySelector<HTMLElement>('.composite-plan')!;
    const before = this.channel_(this.before_);
    const after = this.channel_(this.after_);
    this.run_.disabled = true;
    if (!before || !after) return void (out.textContent = '');
    if (before.image === after.image && before.band === after.band) return void (out.textContent = '前と後に違う画像（バンド）を選んでください');
    try {
      const { grid } = planCalc([before, after], this.reference_(before, after));
      out.textContent = `重なる範囲 ${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px を比べます。`;
      this.run_.disabled = false;
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  /** Compares the two images; the change image opens as a layer, the outlines as a temporary layer. */
  async run(): Promise<ViewerImage | null> {
    const before = this.channel_(this.before_);
    const after = this.channel_(this.after_);
    if (!before || !after) return null;
    const method = this.method_();
    const form = new FormData(this.form_);
    this.run_.disabled = true;
    const control = { cancelled: false };
    this.running_ = control;
    try {
      this.note_.textContent = '比べています… 0%';
      const result = await runCalc({
        inputs: [before, after],
        expr: parseExpression(method.expression, ['A', 'B']),
        reference: this.reference_(before, after),
        resample: form.get('resample') === 'nearest' ? 'nearest' : 'bilinear',
        control,
        onProgress: (done) => {
          if (!control.cancelled) this.note_.textContent = `比べています… ${Math.floor(done * 100)}%`;
        },
      });
      const name = `${baseName(before.image.name)}_${baseName(after.image.name)}_${method.id}.tif`.slice(-120);
      this.note_.textContent = '結果を開いています…';
      const file = new File([result.blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const made = source && this.images.find(source);
      if (!made) return null;
      this.made_.set(made, result.blob);
      this.images.setBadge(made, '変化');

      // The change image, read reduced: for the symmetric colors and the outlines.
      const tiff = tiffOf(made)!;
      const scale = Math.max(1, Math.sqrt((result.plan.grid.width * result.plan.grid.height) / MAX_TRACE_PIXELS));
      const width = Math.max(1, Math.round(result.plan.grid.width / scale));
      const height = Math.max(1, Math.round(result.plan.grid.height / scale));
      const [values] = (await tiff.readRasters({ width, height, samples: [0], resampleMethod: 'nearest' })) as unknown as Float32Array[];
      // No change in white, the middle of blue (fell) to red (rose).
      const spread = spreadOf(values, method.center);
      made.source.setRawStretch({ black: method.center - spread, white: method.center + spread });
      made.layer.setColorScale({ scale: 'blueWhiteRed' });
      markRow(made);

      let summary = '';
      if (form.has('outline')) {
        const typed = Number(form.get('threshold'));
        const thresholds = thresholdsOf(values, method.center, form.get('threshold') && typed > 0 ? typed : null);
        const outlined = await this.outline_(result, values, width, height, thresholds, form, made.name);
        summary = `、変化 ${outlined} か所（${describeThresholds(thresholds, form.get('direction') as ChangeDirection, method)}）`;
      }
      this.dialog.close();
      this.options.say(`${name} を作りました${summary}`);
      return made;
    } catch (error) {
      if (control.cancelled) this.options.say('変化抽出を中止しました');
      else this.note_.textContent = `比べられませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      this.running_ = null;
      this.run_.disabled = false;
    }
  }

  /** Outlines what changed as a temporary layer; resolves to how many areas. */
  private async outline_(result: CalcResult, values: Float32Array, width: number, height: number, thresholds: ChangeThresholds, form: FormData, title: string): Promise<number> {
    const { grid, projection } = result.plan;
    const sx = grid.width / width;
    const sy = grid.height / height;
    const toMap3857 = getTransform(projection, 'EPSG:3857');
    const toWgs84 = getTransform('EPSG:3857', 'EPSG:4326');
    const toMap = (x: number, y: number): [number, number] => toMap3857([grid.origin[0] + x * sx * grid.resolution[0], grid.origin[1] + y * sy * grid.resolution[1]]) as [number, number];
    const toLonLat = (xy: [number, number]) => toWgs84(xy) as LonLat;
    const direction = (form.get('direction') as ChangeDirection) || 'both';
    const minPixels = Math.max(1, Math.round(Number(form.get('minPixels')) || 1));
    const { features, truncated } = changeFeatures(values, width, height, thresholds, direction, toMap, toLonLat, Math.max(1, Math.round(minPixels / (sx * sy))), sx * sy);
    const total = features.reduce((sum, f) => sum + (f.get('面積_m2') as number), 0);
    await this.options.onPolygons?.(
      {
        title: `${baseName(title)} の変化域`,
        features,
        fields: [field('方向', 'string'), field('面積_m2', 'double', '面積（m²）'), field('画素数', 'integer')],
        notes: truncated ? [`大きい順に ${MAX_POLYGONS.toLocaleString()} か所まで`] : [],
      },
      `変化域 ${features.length} か所、計 ${formatArea(total)}`,
    );
    return features.length;
  }
}

function describeThresholds(t: ChangeThresholds, direction: ChangeDirection | null, method: ChangeMethod): string {
  const n = (v: number) => `${Number(v.toPrecision(3))}${method.unit}`;
  if (direction === 'increase') return `${n(t.high)} 以上`;
  if (direction === 'decrease') return `${n(t.low)} 以下`;
  return `${n(t.low)} 以下・${n(t.high)} 以上`;
}
