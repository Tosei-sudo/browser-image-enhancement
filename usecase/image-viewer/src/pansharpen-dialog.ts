/**
 * The pan-sharpening dialog (from the processing dialog): a panchromatic
 * image, a multispectral image and a method. The result opens as a new layer
 * at the full panchromatic resolution, however large, with the
 * multispectral image's band assignment and correction, and can be saved as
 * a GeoTIFF. Settings beyond the method (resampling, strength, intensity
 * weights) wait under 詳細設定.
 *
 * The result is made in blocks, a few at a time in workers, and written
 * into the file as they come; it opens like a chosen file, with an RSET
 * made for it (a large one is shown at once while the RSET is made).
 */
import type OlMap from 'ol/Map.js';
import type { GeoTIFFImage } from 'geotiff';
import type { PanSharpenMethod, Pipeline } from 'browser-image-enhancement';
import type { EnhancedGeoTIFF, GeoTIFFSamples, LoadImageControl } from 'browser-image-enhancement/openlayers';
import type { Resample } from 'browser-image-geometry';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { ascii, gdalStatistics, geoEntries } from './overviews.js';
import { blocksOf, planPanSharpen, sampleWindows, type Grid, type PanSharpenJob, type PanSharpenPlan, type ReadWindow } from './pansharpen.js';
import type { PanSharpenBlock, PanSharpenReply, PanSharpenTask } from './pansharpen-worker.js';
import { TiledTiffWriter, type TiffEntry } from './tiff-stream.js';

/** Tile size of the result. */
const TILE = 256;
/** Results up to this many pixels have their weights and gains fitted on the whole of them; larger ones on windows spread over them. */
const FIT_WHOLE = 2048 * 2048;

const methods: Array<[PanSharpenMethod, string]> = [
  ['gram-schmidt', 'Gram-Schmidt（おすすめ・色を保つ）'],
  ['ihs', 'IHS（くっきり・色が変わることも）'],
  ['brovey', 'Brovey（コントラスト強め）'],
];

export interface PanSharpenDialogOptions {
  say: (message: string) => void;
  /** Shows a new pipeline of the selected image in the correction panel. */
  onPipeline?: (pipeline: Pipeline) => void;
  /** Opens the result like a chosen file (with its RSET); default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
}

/** A pan-sharpened layer: what it was made of, and its file. */
interface Made {
  pan: string;
  ms: string;
  blob: Blob;
}

/** The full-resolution image of an open layer, as geotiff.js read it. */
function tiffOf(image: ViewerImage): GeoTIFFImage | null {
  return (image.source.getTiffImages()[0]?.[0] as GeoTIFFImage | undefined) ?? null;
}

function gridOf(tiff: GeoTIFFImage): Grid {
  const [x, y] = tiff.getOrigin();
  const [rx, ry] = tiff.getResolution();
  return { width: tiff.getWidth(), height: tiff.getHeight(), origin: [x, y], resolution: [rx, ry] };
}

/** The image's CRS code (projected or geographic), when its GeoKeys give one. */
function crsOf(tiff: GeoTIFFImage): number | null {
  const keys = tiff.getGeoKeys() ?? {};
  return (keys.ProjectedCSTypeGeoKey as number | undefined) ?? (keys.GeographicTypeGeoKey as number | undefined) ?? null;
}

/** Pixel size along x, for picking the finer image. */
const pixelSize = (image: ViewerImage): number => {
  const tiff = tiffOf(image);
  try {
    return tiff ? Math.abs(tiff.getResolution()[0]) : Infinity;
  } catch {
    return Infinity;
  }
};

export class PanSharpenDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly pan_: HTMLSelectElement;
  private readonly ms_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, Made>();
  private images_: ViewerImage[] = [];
  /** Set while a run goes on; closing the dialog stops it. */
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly options: PanSharpenDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog pansharpen-dialog';
    this.dialog.setAttribute('aria-labelledby', 'pansharpen-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="pansharpen-title">パンシャープン</h2>
        <label>パンクロ画像（高解像度・白黒）<select name="pan" aria-label="パンクロ画像"></select></label>
        <label>マルチスペクトル画像（カラー）<select name="ms" aria-label="マルチスペクトル画像"></select></label>
        <label class="wide">手法<select name="method" aria-label="手法">${methods.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <details class="wide pansharpen-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label>再サンプリング<select name="resample" aria-label="再サンプリング"><option value="bilinear">バイリニア</option><option value="bicubic">バイキュービック</option></select></label>
            <label>強さ（%）<input name="strength" type="number" min="0" max="200" step="5" value="100" aria-label="強さ" /></label>
            <label class="wide">輝度の重み<select name="weights" aria-label="輝度の重み"><option value="auto">自動（パンクロに合わせて推定）</option><option value="equal">均等</option></select></label>
          </div>
        </details>
        <p class="wide processing-hint pansharpen-plan"></p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="save" hidden>選択中の結果を GeoTIFF 保存</button>
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.pan_ = this.form_.elements.namedItem('pan') as HTMLSelectElement;
    this.ms_ = this.form_.elements.namedItem('ms') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.run_.addEventListener('click', () => void this.run());
    this.pan_.addEventListener('change', () => this.describe_());
    this.ms_.addEventListener('change', () => this.describe_());
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog with the finest one-band image as the panchromatic one and a color image as the multispectral one. */
  open(): void {
    this.images_ = [...this.images.list()].filter((i) => tiffOf(i));
    const option = (i: ViewerImage, n: number) => new Option(`${i.name}（${i.source.getValueBandCount()} バンド）`, String(n));
    this.pan_.replaceChildren(...this.images_.map(option));
    this.ms_.replaceChildren(...this.images_.map(option));
    const byFine = [...this.images_].sort((a, b) => pixelSize(a) - pixelSize(b));
    const pan = byFine.find((i) => i.source.getValueBandCount() === 1) ?? byFine[0];
    const ms = byFine.reverse().find((i) => i !== pan && i.source.getValueBandCount() > 1) ?? this.images_.find((i) => i !== pan);
    if (pan) this.pan_.value = String(this.images_.indexOf(pan));
    if (ms) this.ms_.value = String(this.images_.indexOf(ms));
    this.note_.textContent = this.images_.length < 2 ? 'パンクロ画像とマルチスペクトル画像を開いてください' : '';
    const selected = this.images.selected();
    (this.dialog.querySelector('button[value=save]') as HTMLButtonElement).hidden = !(selected && this.made_.has(selected));
    this.describe_();
    this.dialog.showModal();
  }

  /** Whether `image` is a pan-sharpened layer made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves a pan-sharpened layer (default: the selected one) as a GeoTIFF. */
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

  /** Pan-sharpens with the dialog's choices; the result opens as a new layer. */
  async run(): Promise<ViewerImage | null> {
    const form = new FormData(this.form_);
    const pan = this.images_[Number(form.get('pan'))];
    const ms = this.images_[Number(form.get('ms'))];
    if (!pan || !ms || pan === ms) {
      this.note_.textContent = '別々のパンクロ画像とマルチスペクトル画像を選んでください';
      return null;
    }
    this.run_.disabled = true;
    const running = { cancelled: false };
    this.running_ = running;
    const workers: Worker[] = [];
    try {
      const { plan, panTiff, msTiff, at } = this.plan_(pan, ms);
      const alpha = await hasAlpha(msTiff);
      const settings = {
        alpha,
        method: form.get('method') as PanSharpenMethod,
        resample: form.get('resample') as Resample,
        strength: Math.max(0, Number(form.get('strength')) || 0) / 100,
        weights: form.get('weights') === 'equal' ? ('equal' as const) : ('auto' as const),
      };
      /** Both images under a window of the output, read at full resolution. */
      const read = async (window: readonly [number, number, number, number]): Promise<PanSharpenJob> => {
        const p = at(window);
        const [panData, msData] = await Promise.all([readWindow(panTiff, p.pan, [0]), readWindow(msTiff, p.ms)]);
        return {
          pan: { width: p.pan.width, height: p.pan.height, bands: 1, data: panData, noData: panTiff.getGDALNoData() },
          ms: { width: p.ms.width, height: p.ms.height, bands: msTiff.getSamplesPerPixel(), data: msData, noData: msTiff.getGDALNoData() },
          plan: p,
          ...settings,
        };
      };
      /** Set when a block failed: the others stop too. */
      let failed = false;
      const stop = () => {
        if (running.cancelled) throw new Error('中止しました');
        if (failed) throw new Error('ほかのブロックで失敗しました');
      };
      const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < threads; i++) workers.push(new Worker(new URL('./pansharpen-worker.ts', import.meta.url), { type: 'module' }));

      // The weights and gains, from the whole result when it is small, else from windows spread over it.
      this.note_.textContent = '色の関係を調べています…';
      const fitOn = plan.width * plan.height <= FIT_WHOLE ? [plan.pan.window] : sampleWindows(plan);
      const fitJobs = await Promise.all(fitOn.map(read));
      stop();
      const fitted = await call(
        workers[0],
        { kind: 'fit', jobs: fitJobs },
        fitJobs.flatMap((j) => [j.pan.data.buffer as ArrayBuffer, j.ms.data.buffer as ArrayBuffer]),
      );
      if (!('model' in fitted)) throw new Error('係数を求められませんでした');
      const model = fitted.model;

      // Then the blocks, a few at a time, each written into the file as it comes.
      const blocks = blocksOf(plan);
      const [x0, y0] = plan.pan.window;
      const bands = msTiff.getSamplesPerPixel();
      const min = new Array<number>(bands).fill(Infinity);
      const max = new Array<number>(bands).fill(-Infinity);
      let writer: TiledTiffWriter | null = null;
      let next = 0;
      let done = 0;
      const note = this.note_;
      /** Makes blocks in `worker` until none are left. */
      async function lane(worker: Worker): Promise<void> {
        while (next < blocks.length) {
          stop();
          const window = blocks[next++];
          const job = await read(window);
          stop();
          const task: PanSharpenTask = { kind: 'block', job: { ...job, model }, tileSize: TILE, tx0: (window[0] - x0) / TILE, ty0: (window[1] - y0) / TILE };
          const reply = await call(worker, task, [job.pan.data.buffer as ArrayBuffer, job.ms.data.buffer as ArrayBuffer]);
          if (!('block' in reply)) throw new Error('ブロックを作れませんでした');
          const block: PanSharpenBlock = reply.block;
          writer ??= new TiledTiffWriter({
            width: plan.width,
            height: plan.height,
            bands,
            sample: block.sample,
            tileSize: TILE,
            ...colorOf(bands, alpha),
          });
          writer.add(block.tiles);
          for (let b = 0; b < bands; b++) {
            min[b] = Math.min(min[b], block.min[b]);
            max[b] = Math.max(max[b], block.max[b]);
          }
          done++;
          if (!running.cancelled) note.textContent = `パンシャープンしています… ${Math.floor((100 * done) / blocks.length)}%`;
        }
      }
      note.textContent = 'パンシャープンしています… 0%';
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
      const blob = (writer as TiledTiffWriter | null)!.finish(await tagsOf(plan, panTiff, msTiff, min, max));

      const name = `${baseName(ms.name)}_pansharpen.tif`;
      this.note_.textContent = '結果を開いています…';
      const file = new File([blob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const image = source && this.images.find(source);
      if (!source || !image) return null;
      this.made_.set(image, { pan: pan.name, ms: ms.name, blob });
      this.images.setBadge(image, 'パンシャープン');
      await keepLook(ms.source, source);
      this.setPipeline_(image, ms.source.getPipeline());
      this.dialog.close();
      this.options.say(`${name} を作りました（${plan.width.toLocaleString()} × ${plan.height.toLocaleString()} px）`);
      return image;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (running.cancelled) this.options.say('パンシャープンを中止しました');
      else this.note_.textContent = `パンシャープンできませんでした: ${message}`;
      return null;
    } finally {
      for (const w of workers) w.terminate();
      this.running_ = null;
      this.run_.disabled = false;
    }
  }

  /**
   * The plan of the whole result, at full resolution, and the plan of a
   * window of it (in panchromatic pixels).
   */
  private plan_(
    pan: ViewerImage,
    ms: ViewerImage,
  ): { plan: PanSharpenPlan; panTiff: GeoTIFFImage; msTiff: GeoTIFFImage; at: (window: readonly [number, number, number, number]) => PanSharpenPlan } {
    const panTiff = tiffOf(pan);
    const msTiff = tiffOf(ms);
    if (!panTiff || !msTiff) throw new Error('画像を読み込み中です');
    // Ordinary pictures have no ground position of their own: they are taken to cover the same ground.
    const sameGround = pan.kind === 'image' || ms.kind === 'image';
    if (!sameGround) {
      const a = crsOf(panTiff);
      const b = crsOf(msTiff);
      if (a !== null && b !== null && a !== b) throw new Error(`座標系が違います（EPSG:${a} と EPSG:${b}）。同じ座標系の画像を選んでください`);
    }
    const panGrid = gridOf(panTiff);
    const msGrid = gridOf(msTiff);
    const bands = msTiff.getSamplesPerPixel();
    const plan = planPanSharpen(panGrid, msGrid, { bands, sameGround });
    const at = (window: readonly [number, number, number, number]) => planPanSharpen(panGrid, msGrid, { bands, sameGround, window });
    return { plan, panTiff, msTiff, at };
  }

  /** Says what will be made, or why it cannot. */
  private describe_(): void {
    const out = this.dialog.querySelector<HTMLElement>('.pansharpen-plan')!;
    const pan = this.images_[Number(this.pan_.value)];
    const ms = this.images_[Number(this.ms_.value)];
    this.run_.disabled = !pan || !ms || pan === ms;
    if (!pan || !ms) {
      out.textContent = '';
      return;
    }
    if (pan === ms) {
      out.textContent = '別々の画像を選んでください';
      return;
    }
    try {
      const { plan, msTiff } = this.plan_(pan, ms);
      const ratio = (plan.ratio[0] + plan.ratio[1]) / 2;
      const warn = pan.source.getValueBandCount() > 1 ? ' パンクロ画像は 1 バンド目を使います。' : '';
      const finer = ratio < 1 ? ' マルチスペクトル画像の方が細かいようです。選び方を確かめてください。' : '';
      const bytes = plan.width * plan.height * msTiff.getSamplesPerPixel() * Math.ceil(msTiff.getBitsPerSample() / 8);
      out.textContent =
        `解像度の比 1 : ${ratio.toFixed(ratio < 10 ? 2 : 1)}。結果は ${plan.width.toLocaleString()} × ${plan.height.toLocaleString()} px、${msTiff.getSamplesPerPixel()} バンド` +
        (bytes >= 2 ** 30 ? `（約 ${(bytes / 2 ** 30).toFixed(1)} GB、少し時間がかかります）` : '') +
        `。${warn}${finer}`;
    } catch (error) {
      out.textContent = error instanceof Error ? error.message : String(error);
      this.run_.disabled = true;
    }
  }

  private setPipeline_(image: ViewerImage, p: Pipeline): void {
    image.source.setPipeline(p);
    if (this.images.selected() === image) this.options.onPipeline?.(p);
    else void image.source.updateDra(this.map);
  }
}

/** Reads a window of `tiff` at the plan's size, pixel-interleaved. */
async function readWindow(tiff: GeoTIFFImage, read: ReadWindow, samples?: number[]): Promise<GeoTIFFSamples> {
  const [x0, y0, x1, y1] = read.window;
  const options = { window: [x0, y0, x1, y1], width: read.width, height: read.height, interleave: true as const, ...(samples ? { samples } : {}) };
  return (await tiff.readRasters(options)) as unknown as GeoTIFFSamples;
}

/** Whether the TIFF's last sample is alpha (ExtraSamples 1 or 2). */
async function hasAlpha(tiff: GeoTIFFImage): Promise<boolean> {
  const fd = tiff.fileDirectory;
  if (!fd.hasTag(338)) return false;
  const extra = Array.from((await fd.loadValue(338)) as ArrayLike<number>, Number);
  return extra.length > 0 && (extra[extra.length - 1] === 1 || extra[extra.length - 1] === 2);
}

/** Copies the multispectral layer's band assignment to the result. */
async function keepLook(from: EnhancedGeoTIFF, to: EnhancedGeoTIFF): Promise<void> {
  const select = from.getSelect();
  if (select) await to.setSelect(select);
}

/** Sends `task` to `worker` and waits for its answer. */
function call(worker: Worker, task: PanSharpenTask, transfer: Transferable[]): Promise<Exclude<PanSharpenReply, { ok: false }>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<PanSharpenReply>) => (e.data.ok ? resolve(e.data) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || 'パンシャープンの処理が止まりました'));
    worker.postMessage(task, transfer);
  });
}

/** PhotometricInterpretation and ExtraSamples of the result: RGB (or gray) and the rest, the last being alpha when the multispectral image has it. */
function colorOf(bands: number, alpha: boolean): { photometric: number; extraSamples?: number[] } {
  const color = bands - (alpha ? 1 : 0) >= 3 ? 3 : 1;
  return {
    photometric: color === 3 ? 2 : 1,
    extraSamples: bands > color ? Array.from({ length: bands - color }, (_, i) => (alpha && i === bands - color - 1 ? 2 : 0)) : undefined,
  };
}

/** The result's georeferencing (the panchromatic image's CRS), no-data value and each band's range. */
async function tagsOf(plan: PanSharpenPlan, panTiff: GeoTIFFImage, msTiff: GeoTIFFImage, min: number[], max: number[]): Promise<TiffEntry[]> {
  const fd = panTiff.fileDirectory;
  const tag = async (id: number) => (fd.hasTag(id) ? await fd.loadValue(id) : undefined);
  const numbers = (v: unknown) => (v === undefined ? undefined : Array.from(v as ArrayLike<number>, Number));
  const text = await tag(34737);
  const entries: TiffEntry[] = geoEntries({
    modelPixelScale: [plan.resolution[0], -plan.resolution[1], 0],
    modelTiepoint: [0, 0, 0, plan.origin[0], plan.origin[1], 0],
    geoKeyDirectory: numbers(await tag(34735)),
    geoDoubleParams: numbers(await tag(34736)),
    geoAsciiParams: typeof text === 'string' ? text : undefined,
  });
  const statistics = gdalStatistics(min, max);
  if (statistics) entries.push({ tag: 42112, type: 2, values: ascii(statistics) }); // GDAL_METADATA
  // The no-data value panSharpen gives the result: the multispectral one, else NaN for floats or 0 for integers.
  const noData = msTiff.getGDALNoData() ?? (msTiff.getSampleFormat() === 3 ? NaN : 0);
  entries.push({ tag: 42113, type: 2, values: ascii(String(noData)) }); // GDAL_NODATA
  return entries;
}
