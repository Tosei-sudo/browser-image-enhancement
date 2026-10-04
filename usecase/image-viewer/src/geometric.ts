/**
 * Geometric correction mode (the side panel's 幾何補正 section):
 *
 * - DTED files (.dt0, .dt1, .dt2) open as elevation data: shown on the map as
 *   a layer marked DEM, and used as the terrain for orthorectification.
 * - A satellite image with an RPC model (GeoTIFF tag, or an .RPB / _RPC.TXT
 *   file opened with it) can be orthorectified onto that terrain. The result
 *   is a new layer in the map's projection, keeping the image's bands and
 *   sample type.
 * - An orthorectified layer can be moved by hand to line it up where the RPC
 *   model is off: drag it on the map, or use the arrow keys (Shift: 10×).
 *   The move is in metres on the ground and goes into the saved GeoTIFF.
 */
import type OlMap from 'ol/Map.js';
import PointerInteraction from 'ol/interaction/Pointer.js';
import { rasterToGeoTIFF, type EnhancedGeoTIFF, type GeoTIFFSamples, type LoadImageControl } from 'browser-image-enhancement/openlayers';
import { pipeline, type Pipeline } from 'browser-image-enhancement';
import type { Raster, Resample } from 'browser-image-geometry';
import { readDted, type Dted } from './dted.js';
import { coversAny, elevationRange, type GeoidGrid } from './dem.js';
import { dtedToGeoTIFF } from './dem-layer.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { fromMercator, type OrthoInput, type OrthoResult } from './ortho.js';
import type { OrthoReply } from './ortho-worker.js';
import { MAX_OVERVIEW_SAMPLES } from './overviews.js';
import type { Rpc } from './rpc.js';
import { openTiff } from './satellite.js';
import { getShift, setShift } from './shift.js';

/** A satellite image that can be orthorectified. */
export interface SatelliteImage {
  rpc: Rpc;
  /** Where to read the full image from. */
  from: Blob | string;
}

/** An orthorectified layer. */
export interface OrthoImage {
  /** Name of the image it was made from. */
  sourceName: string;
  result: OrthoResult;
}

export interface GeometricOptions {
  say: (message: string) => void;
  /** Called when the panel changes what it knows about a layer (for the info panel). */
  onChange?: (image: ViewerImage) => void;
  /** Shows a new pipeline of the selected image in the correction panel (which then applies it). */
  onPipeline?: (pipeline: Pipeline) => void;
}

const resampleNames: Record<Resample, string> = { nearest: '最近傍', bilinear: 'バイリニア', bicubic: 'バイキュービック' };

export class GeometricMode {
  private readonly dems_ = new Map<ViewerImage, Dted>();
  private readonly satellites_ = new WeakMap<ViewerImage, SatelliteImage>();
  private readonly orthos_ = new WeakMap<ViewerImage, OrthoImage>();
  private shifting_ = false;
  private busy_ = false;
  private geoidGrid_: Promise<GeoidGrid> | null = null;
  private readonly drag_: PointerInteraction;

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly element: HTMLElement,
    private readonly options: GeometricOptions,
  ) {
    // Dragging moves the selected orthorectified layer instead of the map.
    let last: number[] | null = null;
    this.drag_ = new PointerInteraction({
      handleDownEvent: (e) => {
        if (!this.shifting_ || !this.orthoSelected_() || (e.originalEvent as PointerEvent).button !== 0) return false;
        last = e.coordinate;
        return true;
      },
      handleDragEvent: (e) => {
        if (!last) return;
        this.moveBy_(e.coordinate[0] - last[0], e.coordinate[1] - last[1]);
        last = e.coordinate;
      },
      handleUpEvent: () => {
        last = null;
        return false;
      },
    });
    this.drag_.setActive(false);
    map.addInteraction(this.drag_);

    document.addEventListener(
      'keydown',
      (e) => {
        if (!this.shifting_ || !this.orthoSelected_()) return;
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, select, [contenteditable]')) return;
        const step = (e.shiftKey ? 10 : 1) * (map.getView().getResolution() ?? 1);
        const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        const move = moves[e.key];
        if (e.key === 'Escape') this.setShifting(false);
        else if (move) this.moveBy_(...move);
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    this.render();
  }

  /** The DEM cells open now. */
  cells(): Dted[] {
    return [...this.dems_.values()];
  }

  /** The DEM shown by `image`, if it is one. */
  demOf(image: ViewerImage): Dted | null {
    return this.dems_.get(image) ?? null;
  }

  satelliteOf(image: ViewerImage): SatelliteImage | null {
    return this.satellites_.get(image) ?? null;
  }

  orthoOf(image: ViewerImage): OrthoImage | null {
    return this.orthos_.get(image) ?? null;
  }

  /** Opens a DTED file as elevation data. */
  async openDem(file: File): Promise<void> {
    const { say } = this.options;
    say(`${file.name} を読み込んでいます…`);
    let cell: Dted;
    try {
      cell = readDted(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      say(`${file.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const source = await this.loader.loadFile(dtedToGeoTIFF(cell), file.name).catch(() => null);
    const image = source && this.find_(source);
    if (!image) return;
    this.dems_.set(image, cell);
    this.images.setBadge(image, 'DEM');
    // Heights are 16-bit: stretch them to what the view shows, or the relief is a flat gray.
    this.setPipeline_(image, pipeline().autoStretch());
    const range = elevationRange(cell);
    say(`${file.name} を標高データ（${cell.level}）として開きました${range ? `。標高 ${range[0]}〜${range[1]} m` : ''}`);
    this.changed_(image);
  }

  /** Marks a loaded image as a satellite image with an RPC model. */
  setSatellite(source: EnhancedGeoTIFF, satellite: SatelliteImage): void {
    const image = this.find_(source);
    if (!image) return;
    this.satellites_.set(image, satellite);
    this.images.setBadge(image, 'RPC');
    // Satellite images are mostly 11 to 16-bit: start with DRA (the image has just been opened, so nothing is lost).
    this.setPipeline_(image, pipeline().autoStretch());
    this.changed_(image);
  }

  /** Forgets a closed layer. */
  remove(image: ViewerImage): void {
    this.dems_.delete(image);
    if (this.images.selected() === image) this.setShifting(false);
    this.render();
  }

  /** Turns moving the selected orthorectified layer on or off. */
  setShifting(on: boolean): void {
    this.shifting_ = on && !!this.orthoSelected_();
    this.drag_.setActive(this.shifting_);
    this.map.getViewport().classList.toggle('shifting', this.shifting_);
    this.render();
  }

  isShifting(): boolean {
    return this.shifting_;
  }

  /** Moves the selected orthorectified layer to `[east, north]` metres from where it was made. */
  setShiftMetres(east: number, north: number): void {
    const image = this.orthoSelected_();
    if (!image) return;
    const k = this.metresPerUnit_(image);
    setShift(image.source, [east / k, north / k]);
    this.showShift_(image);
  }

  /** How far the selected orthorectified layer has been moved, `[east, north]` in metres. */
  shiftMetres(image = this.orthoSelected_()): [number, number] {
    if (!image) return [0, 0];
    const [dx, dy] = getShift(image.source);
    const k = this.metresPerUnit_(image);
    return [dx * k, dy * k];
  }

  /** Orthorectifies `image` (default: the selected one) onto the open DEMs, as a new layer. */
  async orthorectify(image = this.images.selected(), resample: Resample = 'bilinear'): Promise<ViewerImage | null> {
    const satellite = image && this.satellites_.get(image);
    if (!image || !satellite || this.busy_) return null;
    const { say } = this.options;
    this.busy_ = true;
    this.render();
    try {
      say(`${baseName(image.name)} を読み込んでいます…`);
      const tiff = await openTiff(satellite.from);
      const first = await tiff.getImage();
      const width = first.getWidth();
      const height = first.getHeight();
      const bands = first.getSamplesPerPixel();
      // Large images are read reduced (from their overviews when they have them).
      const k = Math.max(1, Math.ceil(Math.sqrt((width * height * bands) / MAX_OVERVIEW_SAMPLES)));
      const w = Math.ceil(width / k);
      const h = Math.ceil(height / k);
      // The smallest level (the image or one of its overviews) that is still at least that large.
      let level = first;
      for (let i = 1, n = k > 1 ? await tiff.getImageCount() : 1; i < n; i++) {
        const overview = await tiff.getImage(i);
        if (overview.getWidth() >= w && overview.getWidth() < level.getWidth()) level = overview;
      }
      const data = (await level.readRasters(k > 1 ? { width: w, height: h, interleave: true } : { interleave: true })) as unknown as GeoTIFFSamples;
      const noData = first.getGDALNoData() ?? defaultNoData(data);
      const raster: Raster = { width: w, height: h, bands, data, noData };

      const cells = this.cells();
      say(`${baseName(image.name)} をオルソ補正しています（${cells.length ? `標高データ ${cells.length} 枚` : '標高データなし'}、${resampleNames[resample]}）…`);
      const geoid = await this.geoid_();
      const result = await runOrtho({ raster, scale: [width / w, height / h], rpc: satellite.rpc, cells, geoid, resample });

      const name = `${baseName(image.name)}_ortho.tif`;
      const blob = orthoGeoTIFF(result);
      const source = await this.loader.loadFile(blob, name).catch(() => null);
      const ortho = source && this.find_(source);
      if (!ortho || !source) return null;
      this.orthos_.set(ortho, { sourceName: image.name, result });
      this.images.setBadge(ortho, 'オルソ');
      // Keep the look of the original: its correction and band assignment.
      const select = image.source.getSelect();
      if (select) await source.setSelect(select);
      this.setPipeline_(ortho, image.source.getPipeline());
      const coverage = Math.round(result.demCoverage * 100);
      say(
        `${name} を作りました` +
          (coverage >= 100 ? '' : coverage > 0 ? `（標高データがない部分 ${100 - coverage}% は RPC の基準高 ${Math.round(satellite.rpc.heightOff)} m で補正）` : `（標高データがないため RPC の基準高 ${Math.round(satellite.rpc.heightOff)} m で補正）`) +
          (k > 1 ? `。大きい画像のため 1/${k} の解像度で補正しました` : ''),
      );
      this.changed_(ortho);
      return ortho;
    } catch (error) {
      say(`オルソ補正できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.busy_ = false;
      this.render();
    }
  }

  /** Saves the selected orthorectified layer as a GeoTIFF, moved as it is shown. */
  save(image = this.orthoSelected_()): void {
    const ortho = image && this.orthos_.get(image);
    if (!image || !ortho) return;
    const [dx, dy] = getShift(image.source);
    const blob = orthoGeoTIFF(ortho.result, [dx, dy]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName(image.name)}.tif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    this.options.say(`${a.download} を保存しました`);
  }

  /** Redraws the panel for the selected layer. */
  render(): void {
    const image = this.images.selected();
    const el = this.element;
    el.replaceChildren();
    const p = (text: string, className = 'geometry-note') => {
      const node = document.createElement('p');
      node.className = className;
      node.textContent = text;
      el.append(node);
      return node;
    };
    const button = (text: string, run: () => void, options: { pressed?: boolean; disabled?: boolean; name?: string } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (options.name) b.dataset.action = options.name;
      if (options.pressed !== undefined) b.setAttribute('aria-pressed', String(options.pressed));
      b.disabled = !!options.disabled;
      b.addEventListener('click', run);
      return b;
    };
    const row = (...children: HTMLElement[]) => {
      const div = document.createElement('div');
      div.className = 'geometry-row';
      div.append(...children);
      el.append(div);
      return div;
    };
    const cells = this.cells();

    const dem = image && this.dems_.get(image);
    const satellite = image && this.satellites_.get(image);
    const ortho = image && this.orthos_.get(image);
    if (image && dem) {
      p(`標高データ（${dem.level}）。開いている間、オルソ補正の地形に使います。`);
    } else if (image && ortho) {
      p(`${baseName(ortho.sourceName)} のオルソ補正画像。位置がずれていれば、ずらして合わせられます。`);
      row(
        button('位置をずらす', () => this.setShifting(!this.shifting_), { pressed: this.shifting_, name: 'shift' }),
        button('元に戻す', () => this.setShiftMetres(0, 0), { name: 'reset-shift' }),
        button('GeoTIFF 保存', () => this.save(image), { name: 'save-ortho' }),
      );
      const readout = p('', 'geometry-shift');
      readout.dataset.shift = '';
      if (this.shifting_) p('地図をドラッグするか矢印キー（Shift で 10 倍）で動かします。Esc で終了。');
      this.showShift_(image, readout);
    } else if (image && satellite) {
      const extent = this.lonLatExtent_(satellite.rpc);
      const covered = cells.length > 0 && coversAny(cells, extent);
      p(
        `RPC あり${satellite.rpc.errBias !== undefined ? `（誤差 ${satellite.rpc.errBias} m）` : ''}。` +
          (covered
            ? `標高データ ${cells.length} 枚の地形でオルソ補正します。`
            : `この範囲の標高データ（DTED）がありません。開かずに補正すると、RPC の基準高 ${Math.round(satellite.rpc.heightOff)} m の平面として補正します。`),
      );
      const select = document.createElement('select');
      select.setAttribute('aria-label', '再サンプリング');
      for (const [value, label] of Object.entries(resampleNames)) select.append(new Option(label, value, value === 'bilinear', value === 'bilinear'));
      row(select, button(this.busy_ ? '補正中…' : 'オルソ補正', () => void this.orthorectify(image, select.value as Resample), { disabled: this.busy_, name: 'ortho' }));
    } else {
      p('RPC 付きの衛星画像（GeoTIFF の RPC タグ、または .RPB・_RPC.TXT を一緒に開く）を選ぶと、オルソ補正できます。');
    }
    p(cells.length ? `標高データ: ${cells.map((c) => c.level).join('、')}（${cells.length} 枚）` : '標高データ: なし（DTED .dt0〜.dt2 を開くと使います）', 'geometry-dems');
  }

  private showShift_(image: ViewerImage, readout = this.element.querySelector<HTMLElement>('[data-shift]')): void {
    if (!readout) return;
    const [east, north] = this.shiftMetres(image);
    const f = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} m`;
    readout.textContent = `ずらし量: 東 ${f(east)}、北 ${f(north)}`;
  }

  private moveBy_(dx: number, dy: number): void {
    const image = this.orthoSelected_();
    if (!image) return;
    const [x, y] = getShift(image.source);
    setShift(image.source, [x + dx, y + dy]);
    this.showShift_(image);
  }

  /** Ground metres per Web Mercator unit at the layer's center. */
  private metresPerUnit_(image: ViewerImage): number {
    const extent = this.orthos_.get(image)!.result.extent;
    const [, lat] = fromMercator((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
    return Math.cos((lat * Math.PI) / 180);
  }

  private orthoSelected_(): ViewerImage | null {
    const image = this.images.selected();
    return image && this.orthos_.has(image) ? image : null;
  }

  private lonLatExtent_(rpc: Rpc): [number, number, number, number] {
    return [rpc.lonOff - rpc.lonScale, rpc.latOff - rpc.latScale, rpc.lonOff + rpc.lonScale, rpc.latOff + rpc.latScale];
  }

  private setPipeline_(image: ViewerImage, p: Pipeline): void {
    image.source.setPipeline(p);
    if (this.images.selected() === image) this.options.onPipeline?.(p);
    else void image.source.updateDra(this.map);
  }

  private find_(source: EnhancedGeoTIFF): ViewerImage | null {
    return this.images.list().find((i) => i.source === source) ?? null;
  }

  private changed_(image: ViewerImage): void {
    this.options.onChange?.(image);
    this.render();
  }

  private geoid_(): Promise<GeoidGrid> {
    this.geoidGrid_ ??= fetch(new URL('./egm96.bin', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error('ジオイドのデータを読み込めませんでした');
        return r.arrayBuffer();
      })
      .then((b) => new Int16Array(b));
    return this.geoidGrid_;
  }
}

/** The value outside the image when the file has none: 0 for integers, NaN for floats. */
function defaultNoData(data: GeoTIFFSamples): number {
  return data instanceof Float32Array || data instanceof Float64Array ? NaN : 0;
}

/** Runs the orthorectification in a worker. */
function runOrtho(input: OrthoInput): Promise<OrthoResult> {
  const worker = new Worker(new URL('./ortho-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<OrthoResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<OrthoReply>) => (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || 'オルソ補正の処理が止まりました'));
    worker.postMessage(input, [input.raster.data.buffer as ArrayBuffer]);
  }).finally(() => worker.terminate());
}

/** An orthorectified raster as a GeoTIFF in EPSG:3857, moved by `shift` map units. */
export function orthoGeoTIFF({ raster, geoTransform }: OrthoResult, [dx, dy]: readonly [number, number] = [0, 0]): Blob {
  const { bands } = raster;
  const color = bands >= 3 ? 3 : 1;
  return rasterToGeoTIFF({
    width: raster.width,
    height: raster.height,
    bands,
    data: raster.data as GeoTIFFSamples,
    noData: raster.noData ?? null,
    photometric: color === 3 ? 2 : 1,
    extraSamples: bands > color ? new Array(bands - color).fill(0) : undefined,
    geo: {
      modelPixelScale: [geoTransform[1], -geoTransform[5], 0],
      modelTiepoint: [0, 0, 0, geoTransform[0] + dx, geoTransform[3] + dy, 0],
      // Projected, pixel is area, Web Mercator.
      geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857],
    },
  }, { statistics: true });
}
