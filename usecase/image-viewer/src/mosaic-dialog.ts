/**
 * The mosaic dialog (from the processing dialog): open images joined into
 * one, such as neighbouring scenes or tiles, or a newer image patched over
 * an older one. Overlaps go to the image first in priority order (the layer
 * order, or the newest or oldest first); where it has no data the next one
 * shows through; seams can be feathered. The images are lined up on one
 * grid (see composite.ts) and the result opens as a new layer that can be
 * saved as a GeoTIFF. The grid, the extent, averaging and the resampling
 * wait under 詳細設定.
 */
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { meshOf, meshWindow, samplesOf, type CompositeBlock, type Resampling, type SampleType } from './composite.js';
import { blocksOf, pixelSize, planComposite, tagsOf, tiffOf, type CompositePlan } from './composite-dialog.js';
import type { MosaicRead, MosaicTask, Overlap } from './mosaic.js';
import type { MosaicReply } from './mosaic-worker.js';
import { TiledTiffWriter } from './tiff-stream.js';

/** Tile size of the result. */
const TILE = 256;
/** The widest feather, in output pixels. */
const MAX_FEATHER = 256;

export interface MosaicDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file (with its RSET); default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
  /** When an image was taken, for "newest first"; null when unknown. */
  timeOf?: (image: ViewerImage) => Promise<number | null>;
}

/** The priority orders offered. */
export type MosaicOrder = 'layers' | 'newest' | 'oldest';

/**
 * Sorts images (given top first) into priority order: the layer order, or
 * by when they were taken, the ones of unknown time after, in layer order.
 */
export function priorityOrder(images: readonly ViewerImage[], order: MosaicOrder, times: ReadonlyMap<ViewerImage, number | null>): ViewerImage[] {
  if (order === 'layers') return [...images];
  const sign = order === 'newest' ? -1 : 1;
  const time = (image: ViewerImage) => times.get(image) ?? null;
  return [...images].sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === null || tb === null) return (ta === null ? 1 : 0) - (tb === null ? 1 : 0) || images.indexOf(a) - images.indexOf(b);
    return sign * (ta - tb) || images.indexOf(a) - images.indexOf(b);
  });
}

export interface MosaicSettings {
  overlap: Overlap;
  /** Fade width in output pixels; 0: hard edges. */
  feather: number;
  resample: Resampling;
  zeroIsEmpty: boolean;
}

/** PhotometricInterpretation and ExtraSamples of the result: RGB when every image is (YCbCr is read as RGB), else gray, and the rest extra. */
export function colorOf(plan: CompositePlan, images: readonly ViewerImage[], bands: number): { photometric: number; extraSamples?: number[] } {
  const rgb =
    bands >= 3 &&
    images.every((image) => {
      const p = Number(plan.lookups.get(image)!.placed.tiff.fileDirectory.getValue('PhotometricInterpretation'));
      return p === 2 || p === 6;
    });
  const color = rgb ? 3 : 1;
  return { photometric: rgb ? 2 : 1, extraSamples: bands > color ? new Array(bands - color).fill(0) : undefined };
}

export class MosaicDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly list_: HTMLOListElement;
  private readonly order_: HTMLSelectElement;
  private readonly reference_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Blob>();
  private images_: ViewerImage[] = [];
  private times_ = new Map<ViewerImage, number | null>();
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: MosaicDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog mosaic-dialog';
    this.dialog.setAttribute('aria-labelledby', 'mosaic-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="mosaic-title">モザイク</h2>
        <p class="wide processing-hint">複数の画像をつなぎ合わせて 1 枚にします。重なる所は優先順が上の画像を使い、データのない所（nodata）は次の画像で埋めます。</p>
        <div class="wide mosaic-images">
          <span>つなぐ画像（上ほど優先）</span>
          <ol class="mosaic-list" aria-label="つなぐ画像"></ol>
        </div>
        <label>優先順<select name="order" aria-label="優先順">
          <option value="layers">レイヤーの順（上を優先）</option>
          <option value="newest">新しい画像を優先</option>
          <option value="oldest">古い画像を優先</option>
        </select></label>
        <label class="check"><input name="feather" type="checkbox" /><span>境界をぼかしてつなぐ</span></label>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label>重なる所の値<select name="overlap" aria-label="重なる所の値"><option value="priority">優先する画像</option><option value="average">平均</option></select></label>
            <label>ぼかす幅（px）<input name="featherWidth" type="number" min="1" max="${MAX_FEATHER}" step="1" value="32" aria-label="ぼかす幅" /></label>
            <label class="wide">基準の画像（位置とピクセルの大きさ）<select name="reference" aria-label="基準の画像"></select></label>
            <label>範囲<select name="extent" aria-label="範囲"><option value="union">すべてを含む範囲</option><option value="intersection">重なる範囲</option></select></label>
            <label>再サンプリング<select name="resample" aria-label="再サンプリング"><option value="bilinear">バイリニア</option><option value="nearest">最近傍（値を変えない）</option></select></label>
            <label class="wide check"><input name="zero" type="checkbox" checked /><span>全バンド 0 の画素（黒い縁）をデータなしとして扱う</span></label>
          </div>
        </details>
        <p class="wide processing-hint composite-plan mosaic-plan"></p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="save" hidden>選択中の結果を GeoTIFF 保存</button>
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.list_ = this.dialog.querySelector('.mosaic-list')!;
    this.order_ = this.form_.elements.namedItem('order') as HTMLSelectElement;
    this.reference_ = this.form_.elements.namedItem('reference') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    this.order_.addEventListener('change', () => this.fillList_());
    this.list_.addEventListener('change', () => this.describe_(true));
    this.reference_.addEventListener('change', () => this.describe_(false));
    for (const name of ['extent', 'resample', 'overlap', 'feather', 'featherWidth', 'zero'])
      (this.form_.elements.namedItem(name) as HTMLElement).addEventListener('change', () => this.describe_(false));
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog with every open image chosen, in layer order. */
  async open(): Promise<void> {
    this.images_ = [...this.images.list()].filter((i) => tiffOf(i));
    this.times_ = new Map();
    this.note_.textContent = this.images_.length >= 2 ? '' : 'つなぐ画像を 2 枚以上開いてください';
    const selected = this.images.selected();
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    this.list_.replaceChildren();
    this.fillList_();
    this.dialog.showModal();
    if (this.options.timeOf) {
      const times = await Promise.all(this.images_.map((image) => this.options.timeOf!(image).catch(() => null)));
      this.images_.forEach((image, k) => this.times_.set(image, times[k]));
      this.fillList_();
    }
  }

  /** Whether `image` is a mosaic made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves a mosaic (default: the selected one) as a GeoTIFF. */
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

  /** The chosen images, first priority first. */
  chosen(): ViewerImage[] {
    return [...this.list_.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((c) => c.checked).map((c) => this.images_[Number(c.value)]);
  }

  /** The list of images in the chosen priority order, keeping what is ticked. */
  private fillList_(): void {
    const ticked = new Map([...this.list_.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map((c) => [c.value, c.checked]));
    const sorted = priorityOrder(this.images_, this.order_.value as MosaicOrder, this.times_);
    this.list_.replaceChildren(
      ...sorted.map((image) => {
        const i = String(this.images_.indexOf(image));
        const item = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = i;
        box.checked = ticked.get(i) ?? true;
        const name = document.createElement('span');
        name.textContent = image.name;
        label.append(box, name);
        const time = this.times_.get(image);
        if (time !== undefined) {
          const when = document.createElement('span');
          when.className = 'mosaic-time';
          when.textContent = time === null ? '撮影日時不明' : new Date(time).toISOString().slice(0, 10);
          label.append(when);
        }
        item.append(label);
        return item;
      }),
    );
    this.describe_(true);
  }

  private settings_(): MosaicSettings {
    const form = new FormData(this.form_);
    const width = Math.round(Number(form.get('featherWidth')));
    return {
      overlap: form.get('overlap') === 'average' ? 'average' : 'priority',
      feather: form.has('feather') ? Math.min(MAX_FEATHER, Math.max(1, Number.isFinite(width) ? width : 32)) : 0,
      resample: form.get('resample') === 'nearest' ? 'nearest' : 'bilinear',
      zeroIsEmpty: form.has('zero'),
    };
  }

  private plan_(chosen: ViewerImage[]): { plan: CompositePlan; bands: number } {
    const reference = this.images_[Number(this.reference_.value)];
    if (chosen.length < 2) throw new Error('つなぐ画像を 2 枚以上選んでください');
    if (!reference) throw new Error('基準の画像を選んでください');
    const extent = new FormData(this.form_).get('extent') === 'intersection' ? 'intersection' : 'union';
    const plan = planComposite(
      chosen.map((image) => ({ image, band: 0 })),
      reference,
      extent,
    );
    const bands = Math.min(...chosen.map((image) => image.source.getValueBandCount()));
    return { plan, bands };
  }

  /** Makes the mosaic; it opens as a new layer. */
  async run(): Promise<ViewerImage | null> {
    const chosen = this.chosen();
    const settings = this.settings_();
    this.run_.disabled = true;
    const running = { cancelled: false };
    this.running_ = running;
    const workers: Worker[] = [];
    try {
      const { plan, bands } = this.plan_(chosen);
      const { grid, type } = plan;
      const blocks = blocksOf(grid);
      const min = new Array<number>(bands).fill(Infinity);
      const max = new Array<number>(bands).fill(-Infinity);
      const writer = new TiledTiffWriter({ width: grid.width, height: grid.height, bands, sample: samplesOf(type, 0), tileSize: TILE, ...colorOf(plan, chosen, bands) });
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
      for (let i = 0; i < threads; i++) workers.push(new Worker(new URL('./mosaic-worker.ts', import.meta.url), { type: 'module' }));
      const lane = async (worker: Worker) => {
        while (next < blocks.length) {
          stop();
          const window = blocks[next++];
          const task = await readBlock(plan, chosen, bands, window, type, settings);
          stop();
          const buffers = task.reads.flatMap((r) => (r ? [(r.data as unknown as { buffer: ArrayBuffer }).buffer] : []));
          const block = await call(worker, task, buffers);
          writer.add(block.tiles);
          for (let b = 0; b < bands; b++) {
            min[b] = Math.min(min[b], block.min[b]);
            max[b] = Math.max(max[b], block.max[b]);
          }
          covered += block.covered;
          done++;
          if (!running.cancelled) note.textContent = `つないでいます… ${Math.floor((100 * done) / blocks.length)}%`;
        }
      };
      note.textContent = 'つないでいます… 0%';
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
      if (!covered) throw new Error('選んだ画像にデータのある所がありませんでした');
      const blob = writer.finish(await tagsOf(plan, min, max));

      const name = `${mosaicName(chosen)}_mosaic.tif`;
      this.note_.textContent = '結果を開いています…';
      const file = new File([blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const image = source && this.images.find(source);
      if (!source || !image) return null;
      this.made_.set(image, blob);
      this.images.setBadge(image, 'モザイク');
      this.dialog.close();
      this.options.say(`${name} を作りました（${chosen.length} 枚、${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px）`);
      return image;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (running.cancelled) this.options.say('モザイクを中止しました');
      else this.note_.textContent = `モザイクを作れませんでした: ${message}`;
      return null;
    } finally {
      for (const w of workers) w.terminate();
      this.running_ = null;
      this.run_.disabled = false;
    }
  }

  /** Says what will be made, or why it cannot; `images` also picks the finest chosen image as the reference. */
  private describe_(images: boolean): void {
    const chosen = this.chosen();
    if (images) {
      const before = this.images_[Number(this.reference_.value)];
      this.reference_.replaceChildren(...chosen.map((image) => new Option(image.name, String(this.images_.indexOf(image)))));
      const keep = before && chosen.includes(before) ? before : [...chosen].sort((a, b) => pixelSize(a) - pixelSize(b))[0];
      if (keep) this.reference_.value = String(this.images_.indexOf(keep));
    }
    const out = this.dialog.querySelector<HTMLElement>('.mosaic-plan')!;
    const width = this.form_.elements.namedItem('featherWidth') as HTMLInputElement;
    width.disabled = !(this.form_.elements.namedItem('feather') as HTMLInputElement).checked;
    this.run_.disabled = chosen.length < 2;
    if (chosen.length < 2) {
      out.textContent = this.images_.length >= 2 ? 'つなぐ画像を 2 枚以上選んでください。' : '';
      return;
    }
    try {
      const { plan, bands } = this.plan_(chosen);
      const { grid, type } = plan;
      const reference = this.images_[Number(this.reference_.value)];
      const bytes = grid.width * grid.height * bands * (type.bits / 8);
      const kind = type.format === 3 ? `${type.bits} bit 浮動小数` : `${type.bits} bit`;
      const counts = new Set(chosen.map((image) => image.source.getValueBandCount()));
      out.textContent =
        `結果は ${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px、${bands} バンド（${kind}）、${plan.ownGrid ? `${reference.name} と同じ格子` : 'Web メルカトル'}` +
        (bytes >= 2 ** 30 ? `（約 ${(bytes / 2 ** 30).toFixed(1)} GB、少し時間がかかります）` : '') +
        '。' +
        (counts.size > 1 ? `バンド数がそろわないので、先頭の ${bands} バンドをつなぎます。` : '');
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
      this.run_.disabled = true;
    }
  }
}

/** A name for the result from its images' names. */
function mosaicName(images: readonly ViewerImage[]): string {
  const names = images.map((image) => baseName(image.name));
  const text = names.length > 3 ? `${names.slice(0, 2).join('_')}_ほか${names.length - 2}枚` : names.join('_');
  return text.length > 80 ? text.slice(0, 80) : text;
}

/** Reads what a block (with a margin of the feather width) needs of each image, all bands: the window its mesh falls in, reduced when far more than the block. */
async function readBlock(
  plan: CompositePlan,
  images: readonly ViewerImage[],
  bands: number,
  window: readonly [number, number, number, number],
  type: SampleType,
  settings: MosaicSettings,
): Promise<MosaicTask> {
  const [x0, y0, x1, y1] = window;
  const width = x1 - x0;
  const height = y1 - y0;
  const pad = settings.feather;
  const pw = width + 2 * pad;
  const ph = height + 2 * pad;
  const samples = Array.from({ length: bands }, (_, b) => b);
  const reads = await Promise.all(
    images.map(async (image): Promise<MosaicRead | null> => {
      const { placed, lookup } = plan.lookups.get(image)!;
      const tiff = placed.tiff;
      const m = meshOf(lookup, x0 - pad, y0 - pad, pw, ph);
      const area = meshWindow(m.mesh, tiff.getWidth(), tiff.getHeight());
      if (!area) return null;
      const [wx0, wy0, wx1, wy1] = area;
      const factor = Math.max(1, Math.sqrt(((wx1 - wx0) * (wy1 - wy0)) / (2 * pw * ph)));
      const rw = Math.max(1, Math.round((wx1 - wx0) / factor));
      const rh = Math.max(1, Math.round((wy1 - wy0) / factor));
      const data = (await tiff.readRasters({ window: area, width: rw, height: rh, samples, interleave: true })) as unknown as ArrayLike<number>;
      return { data, bands, width: rw, height: rh, window: area, noData: tiff.getGDALNoData(), zeroIsEmpty: settings.zeroIsEmpty, mesh: m.mesh, cols: m.cols, rows: m.rows };
    }),
  );
  return { width, height, pad, bands, reads, type, resample: settings.resample, overlap: settings.overlap, feather: settings.feather, tileSize: TILE, tx0: x0 / TILE, ty0: y0 / TILE };
}

/** Sends `task` to `worker` and waits for its block. */
function call(worker: Worker, task: MosaicTask, transfer: Transferable[]): Promise<CompositeBlock> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<MosaicReply>) => (e.data.ok ? resolve(e.data.block) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || 'モザイクの処理が止まりました'));
    worker.postMessage(task, transfer);
  });
}
