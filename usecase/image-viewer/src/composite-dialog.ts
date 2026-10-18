/**
 * The RGB composite dialog (from the processing dialog): a band of an open
 * image for each of red, green and blue, typically one-band images of two or
 * three dates (SAR, panchromatic), so what changed shows in color. The
 * images are lined up on one grid (see composite.ts) and the result opens as
 * a new 3-band layer that can be saved as a GeoTIFF. The grid, the extent
 * and the resampling wait under 詳細設定.
 */
import type { GeoTIFFImage } from 'geotiff';
import type { Projection } from 'ol/proj.js';
import { equivalent, get as getProjection, getTransform, type TransformFunction } from 'ol/proj.js';
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { optionFor, type DataSources } from './data-sources.js';
import { ascii, gdalStatistics, geoEntries } from './overviews.js';
import { combine, commonSampleType, fillOf, gridOver, meshOf, meshWindow, samplesOf, type Box, type ChannelRead, type PixelLookup, type Resampling, type SampleType } from './composite.js';
import type { CompositeBlock, CompositeReply, CompositeTask } from './composite-worker.js';
import type { Grid } from './pansharpen.js';
import { getShift } from './shift.js';
import { TiledTiffWriter, type TiffEntry } from './tiff-stream.js';

/** Tile size of the result. */
const TILE = 256;
/** Output pixels of a block, across and down: a whole number of tiles. */
const BLOCK = 1024;
/** Results larger than this many pixels are refused (a mistake, such as images far apart joined into one). */
const MAX_PIXELS = 2_000_000_000;
const CHANNELS = ['R', 'G', 'B'] as const;
const channelNames = { R: '赤（R）', G: '緑（G）', B: '青（B）' };

export interface CompositeDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file (with its RSET); default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
  /** Files as inputs, without adding them to the map (📂). */
  sources?: DataSources;
  /** When an image was taken, to put the earliest in red; default: the order of the list (lowest first). */
  timeOf?: (image: ViewerImage) => Promise<number | null>;
}

/** A band of an image, for one of red, green and blue. */
export interface Channel {
  image: ViewerImage;
  /** 0-based. */
  band: number;
}

/** Where an open image's full-resolution pixels lie in its source's projection. */
export interface Placed {
  image: ViewerImage;
  tiff: GeoTIFFImage;
  projection: Projection;
  origin: [number, number];
  resolution: [number, number];
  /** A move made with the shift tool, in the projection's units. */
  shift: [number, number];
}

/** The plan of a composite: the output grid in `projection`, and how each image's pixels are found. */
export interface CompositePlan {
  grid: Grid;
  projection: Projection;
  /** Whether the grid is the reference image's own (its georeferencing is copied). */
  ownGrid: boolean;
  reference: Placed;
  type: SampleType;
  /** One per image used, by image. */
  lookups: Map<ViewerImage, { placed: Placed; lookup: PixelLookup }>;
}

/** The full-resolution image of an open layer, as geotiff.js read it. */
export function tiffOf(image: ViewerImage): GeoTIFFImage | null {
  return (image.source.getTiffImages()[0]?.[0] as GeoTIFFImage | undefined) ?? null;
}

/** Where `image`'s full-resolution pixels lie (throws while it is loading, or for a rotated image). */
export function place(image: ViewerImage): Placed {
  const tiff = tiffOf(image);
  const projection = image.source.getProjection();
  if (!tiff || !projection) throw new Error(`${image.name} を読み込み中です`);
  let origin: number[];
  let resolution: number[];
  try {
    origin = tiff.getOrigin();
    resolution = tiff.getResolution();
  } catch {
    throw new Error(`${image.name} は回転した画像なので使えません`);
  }
  return { image, tiff, projection, origin: [origin[0], origin[1]], resolution: [resolution[0], resolution[1]], shift: getShift(image.source) };
}

/** Coordinates from `from` to `to`, through WGS 84 when OpenLayers knows no direct way. */
export function transformer(from: Projection, to: Projection): TransformFunction {
  if (equivalent(from, to)) return (input, output = input.slice()) => {
    for (let i = 0; i < input.length; i++) output[i] = input[i];
    return output;
  };
  const direct = getTransform(from, to) as TransformFunction | null;
  if (direct) return direct;
  const toWgs84 = getTransform(from, 'EPSG:4326');
  const fromWgs84 = getTransform('EPSG:4326', to);
  return (input, output, dimension) => fromWgs84(toWgs84(input, output, dimension), output, dimension);
}

/** Pixel positions of `p` (pairs, in place) to coordinates of its projection. */
function pixelsToCoordinates(p: Placed, xy: Float64Array | number[]): void {
  for (let k = 0; k < xy.length; k += 2) {
    xy[k] = p.origin[0] + xy[k] * p.resolution[0] + p.shift[0];
    xy[k + 1] = p.origin[1] + xy[k + 1] * p.resolution[1] + p.shift[1];
  }
}

/** The extent of an image in `to`, from points along its edges. */
export function footprint(p: Placed, to: Projection): Box | null {
  const w = p.tiff.getWidth();
  const h = p.tiff.getHeight();
  const n = 16;
  const xy: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    xy.push(t * w, 0, t * w, h, 0, t * h, w, t * h);
  }
  pixelsToCoordinates(p, xy);
  transformer(p.projection, to)(xy, xy, 2);
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < xy.length; k += 2) {
    if (!Number.isFinite(xy[k]) || !Number.isFinite(xy[k + 1])) continue;
    box[0] = Math.min(box[0], xy[k]);
    box[1] = Math.min(box[1], xy[k + 1]);
    box[2] = Math.max(box[2], xy[k]);
    box[3] = Math.max(box[3], xy[k + 1]);
  }
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/**
 * Output pixel positions (pairs, in place) to `p`'s pixel positions;
 * `correct` moves the output coordinates (in `projection`) first, to where
 * the image shows them (an alignment, see align.ts).
 */
export function lookupFor(grid: Grid, projection: Projection, p: Placed, correct?: (xy: Float64Array) => void): PixelLookup {
  const toImage = transformer(projection, p.projection);
  return (xy) => {
    for (let k = 0; k < xy.length; k += 2) {
      xy[k] = grid.origin[0] + xy[k] * grid.resolution[0];
      xy[k + 1] = grid.origin[1] + xy[k + 1] * grid.resolution[1];
    }
    correct?.(xy);
    toImage(xy as unknown as number[], xy as unknown as number[], 2);
    for (let k = 0; k < xy.length; k += 2) {
      xy[k] = (xy[k] - p.shift[0] - p.origin[0]) / p.resolution[0];
      xy[k + 1] = (xy[k + 1] - p.shift[1] - p.origin[1]) / p.resolution[1];
    }
  };
}

/** Whether an image is placed by a projection of its own pixels (a sensor model), not by a map CRS. */
const sensorPlaced = (p: Placed) => p.image.kind !== 'geotiff' || !/^(EPSG|urn|http)/i.test(p.projection.getCode()) || p.projection.getUnits() === 'pixels';

/**
 * Plans a composite of `channels` on the grid of `reference` (or, for an
 * image placed by its sensor model, on Web Mercator at about its pixel
 * size), over the images' common extent or all of them.
 */
export function planComposite(channels: ReadonlyArray<Channel | null>, reference: ViewerImage, extent: 'intersection' | 'union'): CompositePlan {
  const used = [...new Set(channels.flatMap((c) => (c ? [c.image] : [])))];
  if (!used.length) throw new Error('赤・緑・青のどれかに画像を選んでください');
  const placed = new Map(used.map((image) => [image, place(image)]));
  const ref = placed.get(reference) ?? place(reference);
  let projection: Projection;
  let origin: [number, number];
  let size: [number, number];
  const ownGrid = !sensorPlaced(ref);
  if (ownGrid) {
    projection = ref.projection;
    origin = [ref.origin[0] + ref.shift[0], ref.origin[1] + ref.shift[1]];
    size = [ref.resolution[0], ref.resolution[1]];
  } else {
    // About the reference's pixel size at its centre, on Web Mercator.
    projection = getProjection('EPSG:3857')!;
    const cx = ref.tiff.getWidth() / 2;
    const cy = ref.tiff.getHeight() / 2;
    const xy = [cx, cy, cx + 1, cy, cx, cy + 1];
    pixelsToCoordinates(ref, xy);
    transformer(ref.projection, projection)(xy, xy, 2);
    const across = Math.hypot(xy[2] - xy[0], xy[3] - xy[1]);
    const down = Math.hypot(xy[4] - xy[0], xy[5] - xy[1]);
    const pixel = Math.sqrt(across * down);
    if (!(pixel > 0) || !Number.isFinite(pixel)) throw new Error(`${ref.image.name} の位置を求められません`);
    origin = [0, 0];
    size = [pixel, -pixel];
  }
  const boxes = used.map((image) => {
    const box = footprint(placed.get(image)!, projection);
    if (!box) throw new Error(`${image.name} の位置を求められません`);
    return box;
  });
  const box = combine(boxes, extent);
  if (!box) throw new Error('画像が重なっていません。詳細設定の「範囲」を「すべてを含む範囲」にすると、重ならない所も含めて作れます');
  const grid = gridOver(box, origin, size);
  if (grid.width * grid.height > MAX_PIXELS) throw new Error(`結果が大きすぎます（${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px）。離れた画像を選んでいないか確かめてください`);
  const types = used.map((image) => {
    const tiff = placed.get(image)!.tiff;
    return { format: tiff.getSampleFormat(), bits: tiff.getBitsPerSample() };
  });
  const lookups = new Map(used.map((image) => [image, { placed: placed.get(image)!, lookup: lookupFor(grid, projection, placed.get(image)!) }]));
  return { grid, projection, ownGrid, reference: ref, type: commonSampleType(types), lookups };
}

/** The blocks of the output, as pixel windows `[x0, y0, x1, y1]`, row by row. */
export function blocksOf(grid: Grid): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let y = 0; y < grid.height; y += BLOCK) for (let x = 0; x < grid.width; x += BLOCK) out.push([x, y, Math.min(grid.width, x + BLOCK), Math.min(grid.height, y + BLOCK)]);
  return out;
}

/** What each made composite was made of, and its file. */
interface Made {
  blob: Blob;
}

export class CompositeDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly selects_: HTMLSelectElement[];
  private readonly reference_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Made>();
  private images_: ViewerImage[] = [];
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: CompositeDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog composite-dialog';
    this.dialog.setAttribute('aria-labelledby', 'composite-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="composite-title">RGB 合成</h2>
        <p class="wide processing-hint">単バンドの画像（白黒・SAR など）を赤・緑・青に割り当てて、1 枚のカラー画像にします。時期の違う画像を使うと、変化した所が色で分かります。</p>
        ${CHANNELS.map((c) => `<label class="wide composite-channel composite-${c}">${channelNames[c]}<select name="${c}" aria-label="${channelNames[c]}"></select></label>`).join('')}
        <p class="wide processing-hint composite-legend"></p>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label class="wide">基準の画像（位置とピクセルの大きさ）<select name="reference" aria-label="基準の画像"></select></label>
            <label>範囲<select name="extent" aria-label="範囲"><option value="intersection">重なる範囲</option><option value="union">すべてを含む範囲</option></select></label>
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
    this.selects_ = CHANNELS.map((c) => this.form_.elements.namedItem(c) as HTMLSelectElement);
    this.reference_ = this.form_.elements.namedItem('reference') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    for (const s of [...this.selects_, this.reference_]) s.addEventListener('change', () => this.describe_(s !== this.reference_));
    for (const name of ['extent', 'resample']) (this.form_.elements.namedItem(name) as HTMLSelectElement).addEventListener('change', () => this.describe_(false));
    for (const s of this.selects_)
      options.sources?.attach(s, { dialog: this.dialog, kind: 'image', refill: () => this.open(), valueOf: (l) => optionFor(s, this.images_.indexOf(l as ViewerImage)) });
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /**
   * Opens the dialog with the one-band images in red, green and blue, the
   * earliest in red: two images give red and cyan (the later one in green
   * and blue). `preset`: the images for red, green and blue instead (their
   * first band), such as the band assets of a STAC item.
   */
  async open(preset?: ReadonlyArray<ViewerImage | null>): Promise<void> {
    this.images_ = this.images.inputImages().filter((i) => tiffOf(i));
    const options = this.images_.flatMap((image, i) => {
      const bands = image.source.getValueBandCount();
      const label = (text: string) => this.options.sources?.label(image, text) ?? text;
      if (bands <= 1) return [new Option(label(image.name), `${i}:0`)];
      return Array.from({ length: bands }, (_, b) => new Option(label(`${image.name} ・ バンド ${b + 1}`), `${i}:${b}`));
    });
    for (const s of this.selects_) s.replaceChildren(new Option('（なし）', ''), ...options.map((o) => new Option(o.text, o.value)));
    this.note_.textContent = this.images_.length ? '' : '画像を開いてください';
    const selected = this.images.selected();
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    if (!this.dialog.open) this.dialog.showModal();

    // One-band images, earliest first (else lowest in the list first).
    const single = this.images_.filter((i) => i.source.getValueBandCount() === 1 && !this.made_.has(i));
    const order = new Map(single.map((image) => [image, -this.images_.indexOf(image)]));
    if (this.options.timeOf) {
      const times = await Promise.all(single.map((image) => this.options.timeOf!(image).catch(() => null)));
      if (times.every((t) => t !== null)) single.forEach((image, k) => order.set(image, times[k]!));
    }
    const chosen = [...single].sort((a, b) => order.get(a)! - order.get(b)!).slice(0, 3);
    const value = (image: ViewerImage | undefined) => (image ? `${this.images_.indexOf(image)}:0` : '');
    if (chosen.length >= 2) {
      this.selects_[0].value = value(chosen[0]);
      this.selects_[1].value = value(chosen[1]);
      this.selects_[2].value = value(chosen[2] ?? chosen[1]);
    } else if (chosen.length === 0 && this.images_.length === 1 && this.images_[0].source.getValueBandCount() >= 3) {
      this.selects_.forEach((s, b) => (s.value = `0:${b}`));
    }
    if (preset) {
      this.selects_.forEach((s, c) => {
        const image = preset[c];
        s.value = image && this.images_.includes(image) ? value(image) : '';
      });
    }
    this.describe_(true);
  }

  /** Whether `image` is a composite made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves a composite (default: the selected one) as a GeoTIFF. */
  save(image = this.images.selected()): void {
    const made = image && this.made_.get(image);
    if (!image || !made) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(made.blob);
    a.download = `${baseName(image.name)}.tif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    this.options.say(`${a.download} を保存しました`);
  }

  /** The chosen band for each of red, green and blue. */
  private channels_(): Array<Channel | null> {
    return this.selects_.map((s) => {
      if (!s.value) return null;
      const [i, b] = s.value.split(':').map(Number);
      const image = this.images_[i];
      return image ? { image, band: b } : null;
    });
  }

  /** Makes the composite; it opens as a new layer. */
  async run(): Promise<ViewerImage | null> {
    const channels = this.channels_();
    const form = new FormData(this.form_);
    const reference = this.images_[Number(form.get('reference'))];
    if (!reference || channels.every((c) => !c)) {
      this.note_.textContent = '赤・緑・青のどれかに画像を選んでください';
      return null;
    }
    this.run_.disabled = true;
    const running = { cancelled: false };
    this.running_ = running;
    const workers: Worker[] = [];
    try {
      const plan = planComposite(channels, reference, form.get('extent') === 'union' ? 'union' : 'intersection');
      const resample = form.get('resample') === 'nearest' ? 'nearest' : 'bilinear';
      const { grid, type } = plan;
      const blocks = blocksOf(grid);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const writer = new TiledTiffWriter({ width: grid.width, height: grid.height, bands: 3, sample: samplesOf(type, 0), tileSize: TILE, photometric: 2 });
      let covered = 0;
      let next = 0;
      let done = 0;
      let failed = false;
      const stop = () => {
        if (running.cancelled) throw new Error('中止しました');
        if (failed) throw new Error('ほかのブロックで失敗しました');
      };
      const note = this.note_;
      const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < threads; i++) workers.push(new Worker(new URL('./composite-worker.ts', import.meta.url), { type: 'module' }));
      const lane = async (worker: Worker) => {
        while (next < blocks.length) {
          stop();
          const window = blocks[next++];
          const task = await readBlock(plan, channels, window, type, resample);
          stop();
          const buffers = [...new Set(task.channels.flatMap((c) => (c ? [(c.data as unknown as { buffer: ArrayBuffer }).buffer] : [])))];
          const block = await call(worker, task, buffers);
          writer.add(block.tiles);
          for (let b = 0; b < 3; b++) {
            min[b] = Math.min(min[b], block.min[b]);
            max[b] = Math.max(max[b], block.max[b]);
          }
          covered += block.covered;
          done++;
          if (!running.cancelled) note.textContent = `合成しています… ${Math.floor((100 * done) / blocks.length)}%`;
        }
      };
      note.textContent = '合成しています… 0%';
      await Promise.all(
        workers.map(async (worker) => {
          try {
            await lane(worker);
          } catch (error) {
            failed = true;
            throw error;
          }
        }),
      );
      stop();
      if (!covered) throw new Error('選んだ画像に重なる所がありませんでした');
      const blob = writer.finish(await tagsOf(plan, min, max));

      const name = `${compositeName(channels)}_rgb.tif`;
      this.note_.textContent = '結果を開いています…';
      const file = new File([blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const image = source && this.images.find(source);
      if (!source || !image) return null;
      this.made_.set(image, { blob });
      this.images.setBadge(image, 'RGB 合成');
      this.dialog.close();
      this.options.say(`${name} を作りました（${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px）`);
      return image;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (running.cancelled) this.options.say('RGB 合成を中止しました');
      else this.note_.textContent = `RGB 合成できませんでした: ${message}`;
      return null;
    } finally {
      for (const w of workers) w.terminate();
      this.running_ = null;
      this.run_.disabled = false;
    }
  }

  /** Says what will be made (and which color means what), or why it cannot; `channels` also picks the finest chosen image as the reference. */
  private describe_(channels: boolean): void {
    const chosen = this.channels_();
    const used = [...new Set(chosen.flatMap((c) => (c ? [c.image] : [])))];
    if (channels) {
      this.reference_.replaceChildren(...used.map((image) => new Option(image.name, String(this.images_.indexOf(image)))));
      const finest = [...used].sort((a, b) => pixelSize(a) - pixelSize(b))[0];
      if (finest) this.reference_.value = String(this.images_.indexOf(finest));
    }
    const legend = this.dialog.querySelector<HTMLElement>('.composite-legend')!;
    legend.textContent = legendOf(chosen);
    const out = this.dialog.querySelector<HTMLElement>('.composite-plan')!;
    const reference = this.images_[Number(this.reference_.value)];
    this.run_.disabled = !reference || !used.length;
    if (!reference || !used.length) {
      out.textContent = '';
      return;
    }
    try {
      const form = new FormData(this.form_);
      const plan = planComposite(chosen, reference, form.get('extent') === 'union' ? 'union' : 'intersection');
      const { grid, type } = plan;
      const bytes = grid.width * grid.height * 3 * (type.bits / 8);
      const kind = type.format === 3 ? `${type.bits} bit 浮動小数` : `${type.bits} bit`;
      out.textContent =
        `結果は ${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px、3 バンド（${kind}）、${plan.ownGrid ? `${reference.name} と同じ格子` : 'Web メルカトル'}` +
        (bytes >= 2 ** 30 ? `（約 ${(bytes / 2 ** 30).toFixed(1)} GB、少し時間がかかります）` : '') +
        '。';
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
      this.run_.disabled = true;
    }
  }
}

/** What the colors of the result mean, for the chosen bands. */
export function legendOf(channels: ReadonlyArray<Channel | null>): string {
  const key = (c: Channel | null) => (c ? `${c.image.name}:${c.band}` : '');
  const [r, g, b] = channels.map(key);
  if (r && g && r !== g && g === b) return '明るさの変わらない所は白黒、赤のほうだけ明るい所は赤、緑・青のほうだけ明るい所はシアン（水色）になります。';
  if (r && g && b && r !== g && g !== b && r !== b) return '3 つとも同じ明るさの所は白黒、どれか 1 つだけ明るい所はその色（赤・緑・青）になります。';
  return '';
}

/** A name for the result from its images' names. */
function compositeName(channels: ReadonlyArray<Channel | null>): string {
  const names = [...new Set(channels.flatMap((c) => (c ? [baseName(c.image.name)] : [])))];
  const text = names.join('_');
  return text.length > 80 ? `${text.slice(0, 80)}` : text;
}

/** Pixel size along x in the image's own units, for picking the finest image. */
export function pixelSize(image: ViewerImage): number {
  try {
    const p = place(image);
    const box = footprint(p, getProjection('EPSG:3857')!);
    return box ? Math.sqrt(((box[2] - box[0]) * (box[3] - box[1])) / (p.tiff.getWidth() * p.tiff.getHeight())) : Infinity;
  } catch {
    return Infinity;
  }
}

/** Reads what a block needs of each chosen band: the window its mesh falls in, at full resolution unless that is far more than the block. */
export async function readBlock(
  plan: CompositePlan,
  channels: ReadonlyArray<Channel | null>,
  window: readonly [number, number, number, number],
  type: SampleType,
  resample: Resampling,
): Promise<CompositeTask> {
  const [x0, y0, x1, y1] = window;
  const width = x1 - x0;
  const height = y1 - y0;
  const meshes = new Map<ViewerImage, ReturnType<typeof meshOf>>();
  const reads = new Map<string, Promise<ChannelRead | null>>();
  const readOf = (c: Channel): Promise<ChannelRead | null> => {
    // The same band in two colors (red and cyan from two images) is read once.
    const key = `${channels.findIndex((o) => o?.image === c.image)}:${c.band}`;
    let read = reads.get(key);
    if (read) return read;
    const { placed, lookup } = plan.lookups.get(c.image)!;
    let mesh = meshes.get(c.image);
    if (!mesh) {
      mesh = meshOf(lookup, x0, y0, width, height);
      meshes.set(c.image, mesh);
    }
    const m = mesh;
    const tiff = placed.tiff;
    const area = meshWindow(m.mesh, tiff.getWidth(), tiff.getHeight());
    read = (async () => {
      if (!area) return null;
      const [wx0, wy0, wx1, wy1] = area;
      // A window far larger than the block (a much finer image) is read reduced, to about twice the block's pixels.
      const factor = Math.max(1, Math.sqrt(((wx1 - wx0) * (wy1 - wy0)) / (2 * width * height)));
      const rw = Math.max(1, Math.round((wx1 - wx0) / factor));
      const rh = Math.max(1, Math.round((wy1 - wy0) / factor));
      const data = (await tiff.readRasters({ window: [wx0, wy0, wx1, wy1], width: rw, height: rh, samples: [c.band], interleave: true })) as unknown as ArrayLike<number>;
      return { data, width: rw, height: rh, window: area, noData: tiff.getGDALNoData(), mesh: m.mesh, cols: m.cols, rows: m.rows };
    })();
    reads.set(key, read);
    return read;
  };
  const read = await Promise.all(channels.map((c) => (c ? readOf(c) : Promise.resolve(null))));
  return { width, height, channels: read, type, resample, tileSize: TILE, tx0: x0 / TILE, ty0: y0 / TILE };
}

/** Sends `task` to `worker` and waits for its block. */
function call(worker: Worker, task: CompositeTask, transfer: Transferable[]): Promise<CompositeBlock> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<CompositeReply>) => (e.data.ok ? resolve(e.data.block) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || 'RGB 合成の処理が止まりました'));
    worker.postMessage(task, transfer);
  });
}

/** The result's georeferencing, no-data value and each band's range. */
export async function tagsOf(plan: CompositePlan, min: number[], max: number[]): Promise<TiffEntry[]> {
  const { grid } = plan;
  const g = {
    modelPixelScale: [grid.resolution[0], -grid.resolution[1], 0],
    modelTiepoint: [0, 0, 0, grid.origin[0], grid.origin[1], 0],
  };
  const fd = plan.reference.tiff.fileDirectory;
  let keys: Parameters<typeof geoEntries>[0];
  if (plan.ownGrid && fd.hasTag(34735)) {
    const tag = async (id: number) => (fd.hasTag(id) ? await fd.loadValue(id) : undefined);
    const numbers = (v: unknown) => (v === undefined ? undefined : Array.from(v as ArrayLike<number>, Number));
    const text = await tag(34737);
    keys = { ...g, geoKeyDirectory: numbers(await tag(34735)), geoDoubleParams: numbers(await tag(34736)), geoAsciiParams: typeof text === 'string' ? text : undefined };
  } else {
    keys = { ...g, geoKeyDirectory: geoKeysOf(plan.projection) };
  }
  const entries: TiffEntry[] = geoEntries(keys);
  const statistics = gdalStatistics(min, max);
  if (statistics) entries.push({ tag: 42112, type: 2, values: ascii(statistics) }); // GDAL_METADATA
  entries.push({ tag: 42113, type: 2, values: ascii(String(fillOf(plan.type))) }); // GDAL_NODATA
  return entries;
}

/** A GeoKeyDirectory naming an EPSG CRS (projected, or geographic in degrees). */
function geoKeysOf(projection: Projection): number[] {
  const code = Number(/(\d+)$/.exec(projection.getCode())?.[1]);
  if (!Number.isInteger(code)) throw new Error(`座標系 ${projection.getCode()} を GeoTIFF に書けません`);
  const geographic = projection.getUnits() === 'degrees';
  return [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, 1, geographic ? 2048 : 3072, 0, 1, code];
}
