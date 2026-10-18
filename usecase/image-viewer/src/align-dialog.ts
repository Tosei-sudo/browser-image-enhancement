/**
 * The automatic alignment dialog (from the processing dialog): an image is
 * lined up with a reference image without picking points by hand. How far
 * it is off is found by phase correlation (align.ts), over the whole overlap
 * at a coarse scale, then in a grid of patches at the reference's own
 * resolution; the patches' tie points give a shift or an affine
 * transformation. The aligned copy opens as a new layer on the reference's
 * grid, every band kept, and can be saved as a GeoTIFF.
 */
import type { Projection } from 'ol/proj.js';
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { applyAffine, invertAffine, phaseCorrelate, robustFit, type Affine, type TiePoint } from './align.js';
import { gridOver, meshOf, meshWindow, resampleMesh, type Box } from './composite.js';
import { footprint, lookupFor, pixelSize, place, planComposite, tiffOf, type Channel, type CompositePlan, type Placed } from './composite-dialog.js';
import { colorOf } from './mosaic-dialog.js';
import type { Grid } from './pansharpen.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { runResample } from './raster-calc-run.js';
import { saveFile } from './save-folder.js';

/** Pixels across the coarse look at the whole overlap. */
const COARSE = 512;
/** Pixels across a patch. */
const PATCH = 128;
/** A match is kept when its peak stands this far above the rest. */
const MIN_STRENGTH = 1.3;

/** How the image is corrected. */
export type AlignHow = 'shift' | 'affine';

/** What the alignment found. */
export interface Alignment {
  /** From where a point is (in the reference's grid CRS) to where the image to align shows it. */
  transform: Affine;
  projection: Projection;
  /** The patches matched, and how many were tried. */
  tiePoints: TiePoint[];
  tried: number;
  /** RMS residual of the tie points, in reference pixels. */
  rmsPixels: number;
  /** The reference's pixel size, in the CRS's units. */
  pixel: number;
}

/** `placed`'s band sampled on `grid` (bilinear, NaN outside or on no data), moved by `correct` first. */
export async function sampleOnGrid(placed: Placed, band: number, grid: Grid, projection: Projection, correct?: (xy: Float64Array) => void): Promise<Float32Array> {
  const out = new Float32Array(grid.width * grid.height).fill(NaN);
  const lookup = lookupFor(grid, projection, placed, correct);
  const m = meshOf(lookup, 0, 0, grid.width, grid.height);
  const tiff = placed.tiff;
  const area = meshWindow(m.mesh, tiff.getWidth(), tiff.getHeight());
  if (!area) return out;
  const [x0, y0, x1, y1] = area;
  // A window far larger than the grid is read reduced.
  const factor = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / (2 * grid.width * grid.height)));
  const rw = Math.max(1, Math.round((x1 - x0) / factor));
  const rh = Math.max(1, Math.round((y1 - y0) / factor));
  const data = (await tiff.readRasters({ window: area, width: rw, height: rh, samples: [band], interleave: true })) as unknown as ArrayLike<number>;
  resampleMesh({ data, width: rw, height: rh, window: area, noData: tiff.getGDALNoData(), mesh: m.mesh, cols: m.cols, rows: m.rows }, out, grid.width, grid.height, 0, 1, 'bilinear', NaN);
  return out;
}

const largestPowerOfTwo = (v: number) => 2 ** Math.floor(Math.log2(Math.max(1, v)));

/** Moves coordinates (pairs, in place) by `t`. */
const affineMover = (t: Affine) => (xy: Float64Array) => {
  for (let k = 0; k < xy.length; k += 2) {
    const [u, v] = applyAffine(t, xy[k], xy[k + 1]);
    xy[k] = u;
    xy[k + 1] = v;
  }
};

/**
 * How far `target` is off `reference` (a band of each): a coarse shift over
 * the whole overlap, then tie points in `patches` × `patches` patches, fitted
 * as `how`.
 */
export async function findAlignment(reference: Channel, target: Channel, how: AlignHow, patches = 4, onProgress?: (done: number) => void): Promise<Alignment> {
  const plan = planComposite([reference, target], reference.image, 'intersection');
  const { grid, projection } = plan;
  const ref = plan.lookups.get(reference.image)!.placed;
  const tgt = plan.lookups.get(target.image)!.placed;
  const [rx, ry] = grid.resolution;
  const pixel = Math.abs(rx);

  // 1. The whole overlap (its middle square), coarsely.
  const side = Math.min(grid.width, grid.height);
  const n = Math.min(COARSE, largestPowerOfTwo(side));
  if (n < 16) throw new Error('重なる範囲が小さすぎます');
  const f = side / n;
  const coarse: Grid = {
    width: n,
    height: n,
    origin: [grid.origin[0] + ((grid.width - side) / 2) * rx, grid.origin[1] + ((grid.height - side) / 2) * ry],
    resolution: [rx * f, ry * f],
  };
  const [a, b] = await Promise.all([sampleOnGrid(ref, reference.band, coarse, projection), sampleOnGrid(tgt, target.band, coarse, projection)]);
  const first = phaseCorrelate(a, b, n);
  const shift: [number, number] = first && first.strength >= MIN_STRENGTH ? [first.dx * coarse.resolution[0], first.dy * coarse.resolution[1]] : [0, 0];
  onProgress?.(0.2);

  // 2. Patches at the reference's resolution, the image moved by the coarse shift: what is left over.
  const m = Math.min(PATCH, largestPowerOfTwo(side / 2));
  const ties: TiePoint[] = [];
  const centers: Array<[number, number]> = [];
  for (let j = 0; j < patches; j++) {
    for (let i = 0; i < patches; i++) {
      const cx = ((i + 0.5) / patches) * grid.width;
      const cy = ((j + 0.5) / patches) * grid.height;
      if (cx - m / 2 < 0 || cy - m / 2 < 0 || cx + m / 2 > grid.width || cy + m / 2 > grid.height) continue;
      centers.push([cx, cy]);
    }
  }
  const moved = affineMover([shift[0], 1, 0, shift[1], 0, 1]);
  let k = 0;
  for (const [cx, cy] of centers) {
    const patch: Grid = { width: m, height: m, origin: [grid.origin[0] + (cx - m / 2) * rx, grid.origin[1] + (cy - m / 2) * ry], resolution: [rx, ry] };
    const [pa, pb] = await Promise.all([sampleOnGrid(ref, reference.band, patch, projection), sampleOnGrid(tgt, target.band, patch, projection, moved)]);
    const c = phaseCorrelate(pa, pb, m);
    onProgress?.(0.2 + (0.8 * ++k) / centers.length);
    // A residual of more than a quarter patch is no match of the same place.
    if (!c || c.strength < MIN_STRENGTH || Math.abs(c.dx) > m / 4 || Math.abs(c.dy) > m / 4) continue;
    const x = grid.origin[0] + cx * rx;
    const y = grid.origin[1] + cy * ry;
    ties.push({ x, y, u: x + shift[0] + c.dx * rx, v: y + shift[1] + c.dy * ry });
  }
  const fit = ties.length ? robustFit(ties, how === 'affine' && ties.length >= 6 ? 'affine' : 'shift', pixel / 2) : null;
  if (!fit) {
    if (!first || first.strength < MIN_STRENGTH) throw new Error('一致する模様が見つかりませんでした（重なりが少ないか、模様の少ない画像です）');
    return { transform: [shift[0], 1, 0, shift[1], 0, 1], projection, tiePoints: [], tried: centers.length, rmsPixels: NaN, pixel };
  }
  return { transform: fit.transform, projection, tiePoints: fit.kept, tried: centers.length, rmsPixels: fit.rms / pixel, pixel };
}

/** The plan of the aligned copy: every band of `target` on `reference`'s grid lattice, over where it lands once moved. */
export function alignedPlan(target: ViewerImage, reference: ViewerImage, alignment: Alignment): { plan: CompositePlan; channels: Channel[] } {
  const bands = target.source.getValueBandCount();
  const channels = Array.from({ length: bands }, (_, band) => ({ image: target, band }));
  const plan = planComposite(channels, reference, 'intersection');
  const back = invertAffine(alignment.transform);
  if (!back) throw new Error('求めた変換が正しくありません');
  const placed: Placed = place(target);
  const box = footprint(placed, plan.projection);
  if (!box) throw new Error(`${target.name} の位置を求められません`);
  // Where the image's footprint goes once corrected.
  const corners = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ].map(([x, y]) => applyAffine(back, x, y));
  const moved: Box = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
  const grid = gridOver(moved, plan.grid.origin, plan.grid.resolution);
  const lookup = lookupFor(grid, plan.projection, placed, affineMover(alignment.transform));
  return { plan: { ...plan, grid, lookups: new Map([[target, { placed, lookup }]]) }, channels };
}

export interface AlignDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file; default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
}

export class AlignDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly reference_: HTMLSelectElement;
  private readonly target_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Blob>();
  private images_: ViewerImage[] = [];
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: AlignDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog align-dialog';
    this.dialog.setAttribute('aria-labelledby', 'align-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="align-title">自動位置合わせ</h2>
        <p class="wide processing-hint">画像の模様を照合して、基準の画像とのずれを自動で求め、ずれを直した画像を新しいレイヤーとして作ります。</p>
        <label class="wide">基準の画像<select name="reference" aria-label="基準の画像"></select></label>
        <label class="wide">合わせる画像<select name="target" aria-label="合わせる画像"></select></label>
        <label class="wide">直し方<select name="how" aria-label="直し方"><option value="shift">平行移動（ずらすだけ）</option><option value="affine">アフィン（回転・伸縮も）</option></select></label>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label>照合する所（縦横）<select name="patches" aria-label="照合する所"><option value="3">3 × 3</option><option value="4" selected>4 × 4</option><option value="6">6 × 6</option></select></label>
            <label>再サンプリング<select name="resample" aria-label="再サンプリング"><option value="bilinear">バイリニア</option><option value="nearest">最近傍（値を変えない）</option></select></label>
            <p class="wide processing-hint">照合には各画像の選んだバンドを使い、結果にはすべてのバンドを残します。アフィンは照合できた所が 6 か所以上のときだけで、少なければ平行移動にします。</p>
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
    this.reference_ = this.form_.elements.namedItem('reference') as HTMLSelectElement;
    this.target_ = this.form_.elements.namedItem('target') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    for (const s of [this.reference_, this.target_]) s.addEventListener('change', () => this.describe_());
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog: the selected image to align, the finest other image as the reference. */
  open(): void {
    this.images_ = [...this.images.list()].filter((i) => tiffOf(i));
    const options = this.images_.flatMap((image, i) => {
      const bands = image.source.getValueBandCount();
      if (bands <= 1) return [new Option(image.name, `${i}:0`)];
      return Array.from({ length: bands }, (_, b) => new Option(`${image.name} ・ バンド ${b + 1}`, `${i}:${b}`));
    });
    for (const s of [this.reference_, this.target_]) s.replaceChildren(...options.map((o) => new Option(o.text, o.value)));
    this.note_.textContent = this.images_.length >= 2 ? '' : '画像を 2 枚開いてください';
    const selected = this.images.selected();
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    const target = selected && this.images_.includes(selected) && !this.made_.has(selected) ? selected : this.images_[0];
    const reference = [...this.images_].filter((i) => i !== target && !this.made_.has(i)).sort((p, q) => pixelSize(p) - pixelSize(q))[0];
    if (target) this.target_.value = `${this.images_.indexOf(target)}:0`;
    if (reference) this.reference_.value = `${this.images_.indexOf(reference)}:0`;
    this.dialog.showModal();
    this.describe_();
  }

  /** Whether `image` is an aligned copy made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves an aligned copy (default: the selected one) as a GeoTIFF. */
  async save(image = this.images.selected()): Promise<void> {
    const blob = image && this.made_.get(image);
    if (!image || !blob) return;
    await saveFile(`${baseName(image.name)}.tif`, blob, this.options.say);
  }

  private channel_(select: HTMLSelectElement): Channel | null {
    if (!select.value) return null;
    const [i, band] = select.value.split(':').map(Number);
    const image = this.images_[i];
    return image ? { image, band } : null;
  }

  private describe_(): void {
    const out = this.dialog.querySelector<HTMLElement>('.composite-plan')!;
    const reference = this.channel_(this.reference_);
    const target = this.channel_(this.target_);
    this.run_.disabled = true;
    if (!reference || !target) return void (out.textContent = '');
    if (reference.image === target.image) return void (out.textContent = '基準と違う画像を選んでください');
    try {
      const { grid } = planComposite([reference, target], reference.image, 'intersection');
      out.textContent = `重なる範囲 ${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px で照合します。`;
      this.run_.disabled = false;
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  /** Finds the misalignment and makes the aligned copy, which opens as a new layer. */
  async run(): Promise<ViewerImage | null> {
    const reference = this.channel_(this.reference_);
    const target = this.channel_(this.target_);
    if (!reference || !target || reference.image === target.image) return null;
    const form = new FormData(this.form_);
    const how: AlignHow = form.get('how') === 'affine' ? 'affine' : 'shift';
    this.run_.disabled = true;
    const control = { cancelled: false };
    this.running_ = control;
    try {
      this.note_.textContent = 'ずれを調べています…';
      const alignment = await findAlignment(reference, target, how, Number(form.get('patches')) || 4, (done) => {
        if (!control.cancelled) this.note_.textContent = `ずれを調べています… ${Math.floor(done * 100)}%`;
      });
      if (control.cancelled) throw new Error('中止しました');
      const { plan, channels } = alignedPlan(target.image, reference.image, alignment);
      const blob = await runResample(plan, channels, colorOf(plan, [target.image], channels.length), {
        resample: form.get('resample') === 'nearest' ? 'nearest' : 'bilinear',
        control,
        onProgress: (done) => {
          if (!control.cancelled) this.note_.textContent = `位置を合わせた画像を作っています… ${Math.floor(done * 100)}%`;
        },
      });
      const name = `${baseName(target.image.name)}_aligned.tif`;
      this.note_.textContent = '結果を開いています…';
      const file = new File([blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const made = source && this.images.find(source);
      if (!made) return null;
      this.made_.set(made, blob);
      this.images.setBadge(made, '位置合わせ');
      this.dialog.close();
      this.options.say(`${name} を作りました（${describeAlignment(alignment, plan.projection)}）`);
      return made;
    } catch (error) {
      if (control.cancelled) this.options.say('自動位置合わせを中止しました');
      else this.note_.textContent = `位置を合わせられませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      this.running_ = null;
      this.run_.disabled = false;
    }
  }
}

/** The correction in words: the shift (at the middle of the tie points), rotation and scale for an affine, the residual. */
export function describeAlignment(a: Alignment, projection: Projection): string {
  const t = a.transform;
  const units = projection.getUnits() === 'm' ? ' m' : projection.getUnits() === 'degrees' ? '°' : '';
  const n = (v: number) => (units === '°' ? v.toFixed(6) : v.toFixed(1));
  const parts = [`ずれ 東 ${n(t[0] + (t[1] - 1) * centerX(a) + t[2] * centerY(a))}${units}・北 ${n(t[3] + t[4] * centerX(a) + (t[5] - 1) * centerY(a))}${units}`];
  if (t[1] !== 1 || t[2] !== 0 || t[4] !== 0 || t[5] !== 1) {
    const rotation = (Math.atan2(t[4], t[1]) * 180) / Math.PI;
    const scale = Math.sqrt(Math.abs(t[1] * t[5] - t[2] * t[4]));
    parts.push(`回転 ${rotation.toFixed(3)}°・倍率 ${scale.toFixed(5)}`);
  }
  parts.push(a.tiePoints.length ? `照合 ${a.tiePoints.length}/${a.tried} か所、残差 ${a.rmsPixels.toFixed(2)} px` : '全体の照合のみ');
  return parts.join('、');
}

const centerX = (a: Alignment) => (a.tiePoints.length ? a.tiePoints.reduce((s, p) => s + p.x, 0) / a.tiePoints.length : 0);
const centerY = (a: Alignment) => (a.tiePoints.length ? a.tiePoints.reduce((s, p) => s + p.y, 0) / a.tiePoints.length : 0);
