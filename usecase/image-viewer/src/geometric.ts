/**
 * Geometric correction mode (the side panel's 幾何補正 section):
 *
 * - DTED files (.dt0, .dt1, .dt2) open as elevation data: shown on the map as
 *   a layer marked DEM, and used as the terrain for orthorectification.
 * - A satellite image with an RPC model (GeoTIFF tag, or an .RPB / _RPC.TXT
 *   file opened with it) can be orthorectified onto that terrain. The result
 *   is a new layer in the map's projection, keeping the image's bands and
 *   sample type.
 * - A georeferenced image without an RPC model can be orthorectified more
 *   simply: the DEM height moves each point toward or away from the
 *   satellite, given the direction it looked from (azimuth and elevation,
 *   from an .IMD file or the GDAL metadata, or typed in). See simple-ortho.ts.
 * - An orthorectified layer can be moved by hand to line it up where the RPC
 *   model is off: drag it on the map, or use the arrow keys (Shift: 10×).
 *   The move is in metres on the ground and goes into the saved GeoTIFF.
 * - A DEM can show contour lines (off at first): at a round interval for its
 *   range, or one chosen.
 */
import type OlMap from 'ol/Map.js';
import PointerInteraction from 'ol/interaction/Pointer.js';
import { getTransform, transformExtent } from 'ol/proj.js';
import type { GeoTIFFImage } from 'geotiff';
import { rasterToGeoTIFF, type EnhancedGeoTIFF, type GeoTIFFSamples, type LoadImageControl } from 'browser-image-enhancement/openlayers';
import { pipeline, type Pipeline } from 'browser-image-enhancement';
import type { Raster, Resample } from 'browser-image-geometry';
import { readDted, type Dted } from './dted.js';
import { coversAny, elevationAt, elevationRange, loadGeoid, type GeoidGrid } from './dem.js';
import { dtedToGeoTIFF } from './dem-layer.js';
import { ContourLayer } from './contour-layer.js';
import { gridOfDted, niceInterval } from './contours.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';
import { fromMercator, type OrthoInput, type OrthoResult } from './ortho.js';
import type { OrthoReply } from './ortho-worker.js';
import { MAX_OVERVIEW_SAMPLES } from './overviews.js';
import type { Rpc } from './rpc.js';
import { openTiff } from './satellite.js';
import { displacement, sampleGrid, type GridMap, type SensorView, type SimpleOrthoInput } from './simple-ortho.js';
import { getShift, setShift } from './shift.js';

/** A satellite image that can be orthorectified. */
export interface SatelliteImage {
  rpc: Rpc;
  /** Where to read the full image from. */
  from: Blob | string;
}

/** A georeferenced image without an RPC model, for the simple orthorectification. */
export interface GeoImage {
  /** Where to read the full image from. */
  from: Blob | string;
  /** Where the satellite looked from: from metadata, or as typed in the panel. */
  view: SensorView | null;
  /** The height the image was placed at (m above sea level); null: the mean DEM height over it. */
  referenceHeight: number | null;
  /** `[west, south, east, north]` in degrees, once known. */
  lonLat: [number, number, number, number] | null;
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

/** Contour intervals to choose from, metres. */
const CONTOUR_INTERVALS = [1, 2, 5, 10, 20, 50, 100, 200, 500];

export class GeometricMode {
  private readonly dems_ = new Map<ViewerImage, Dted>();
  private readonly contours_ = new Map<ViewerImage, ContourLayer>();
  /** Contour interval chosen for a DEM (none: a round one for its range). */
  private readonly contourIntervals_ = new WeakMap<ViewerImage, number>();
  private readonly autoIntervals_ = new WeakMap<ViewerImage, number>();
  private contourNote_ = '';
  private readonly satellites_ = new WeakMap<ViewerImage, SatelliteImage>();
  private readonly orthos_ = new WeakMap<ViewerImage, OrthoImage>();
  private readonly geoImages_ = new WeakMap<ViewerImage, GeoImage>();
  private shifting_ = false;
  private busy_ = false;
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

  geoImageOf(image: ViewerImage): GeoImage | null {
    return this.geoImages_.get(image) ?? null;
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

  /** Marks a loaded, georeferenced image without an RPC model, for the simple orthorectification. */
  setGeoreferenced(source: EnhancedGeoTIFF, from: Blob | string, view: SensorView | null = null): void {
    const image = this.find_(source);
    if (!image || this.satellites_.has(image) || this.dems_.has(image)) return;
    const geo: GeoImage = { from, view, referenceHeight: null, lonLat: null };
    this.geoImages_.set(image, geo);
    void source
      .getView()
      .then((v) => {
        if (!v.extent) return;
        geo.lonLat = transformExtent(v.extent, v.projection ?? 'EPSG:4326', 'EPSG:4326') as GeoImage['lonLat'];
        if (this.images.selected() === image) this.render();
      })
      .catch(() => {});
    this.changed_(image);
  }

  /** Shows or hides the contour lines of a DEM. */
  setContours(image: ViewerImage, on: boolean): void {
    const dem = this.dems_.get(image);
    const shown = this.contours_.get(image);
    if (!dem || on === !!shown) return;
    if (on) {
      this.contourNote_ = '';
      const contours = new ContourLayer(this.map, image.layer, gridOfDted(dem), {
        interval: this.contourInterval(image),
        onTraced: (_, truncated) => {
          const note = truncated ? '間隔が細かすぎるため、一部の等高線だけ表示しています。広い間隔にするか拡大してください。' : '';
          if (note === this.contourNote_) return;
          this.contourNote_ = note;
          if (this.images.selected() === image) this.render();
        },
      });
      this.contours_.set(image, contours);
    } else {
      shown!.dispose();
      this.contours_.delete(image);
    }
    this.render();
  }

  /** Whether a DEM shows its contour lines. */
  hasContours(image: ViewerImage): boolean {
    return this.contours_.has(image);
  }

  /** Sets the contour interval of a DEM in metres (null: a round one for its range). */
  setContourInterval(image: ViewerImage, interval: number | null): void {
    if (interval === null) this.contourIntervals_.delete(image);
    else this.contourIntervals_.set(image, interval);
    this.contours_.get(image)?.setInterval(this.contourInterval(image));
    this.render();
  }

  /** The contour interval of a DEM in metres. */
  contourInterval(image: ViewerImage): number {
    return this.contourIntervals_.get(image) ?? this.autoInterval_(image);
  }

  /** Forgets a closed layer. */
  remove(image: ViewerImage): void {
    this.dems_.delete(image);
    this.contours_.get(image)?.dispose();
    this.contours_.delete(image);
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
      const { raster, width, height } = await readForOrtho(satellite.from);
      const cells = this.cells();
      say(`${baseName(image.name)} をオルソ補正しています（${cells.length ? `標高データ ${cells.length} 枚` : '標高データなし'}、${resampleNames[resample]}）…`);
      const geoid = await this.geoid_();
      const result = await runOrtho({ raster, scale: [width / raster.width, height / raster.height], rpc: satellite.rpc, cells, geoid, resample });

      const ortho = await this.addOrtho_(image, result);
      if (!ortho) return null;
      const coverage = Math.round(result.demCoverage * 100);
      say(
        `${baseName(image.name)}_ortho.tif を作りました` +
          (coverage >= 100 ? '' : coverage > 0 ? `（標高データがない部分 ${100 - coverage}% は RPC の基準高 ${Math.round(satellite.rpc.heightOff)} m で補正）` : `（標高データがないため RPC の基準高 ${Math.round(satellite.rpc.heightOff)} m で補正）`) +
          reducedNote(width / raster.width),
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

  /**
   * Orthorectifies a georeferenced image without an RPC model (default: the
   * selected one) onto the open DEMs, from the direction the satellite looked
   * from, as a new layer.
   */
  async simpleOrthorectify(image = this.images.selected(), resample: Resample = 'bilinear'): Promise<ViewerImage | null> {
    const geo = image && this.geoImages_.get(image);
    const view = geo?.view;
    if (!image || !geo || !view || this.busy_) return null;
    const { say } = this.options;
    const projection = image.source.getProjection();
    const cells = this.cells();
    if (!projection) {
      say('この画像の座標系が分からないため、簡易オルソ補正できません');
      return null;
    }
    this.busy_ = true;
    this.render();
    try {
      say(`${baseName(image.name)} を読み込んでいます…`);
      const { first, raster, width, height } = await readForOrtho(geo.from);
      const { width: w, height: h } = raster;
      // Raster position → the image's CRS → Web Mercator, and back.
      const [ox, oy] = first.getOrigin();
      const [rx, ry] = first.getResolution();
      const sx = (rx * width) / w;
      const sy = (ry * height) / h;
      const toMercator = getTransform(projection, 'EPSG:3857');
      const fromMercator3857 = getTransform('EPSG:3857', projection);
      const toMap = sampleGrid([0, 0, w, h], 33, 33, (x, y) => toMercator([ox + x * sx, oy + y * sy]));
      const extent = gridBounds(toMap);
      const pixelSize = Math.sqrt(((extent[2] - extent[0]) * (extent[3] - extent[1])) / (w * h));

      const reference = geo.referenceHeight ?? meanHeight(cells, toMap) ?? 0;
      // How far the terrain can move a point, in Web Mercator units: the inverse grid reaches that far beyond the output.
      const [, lat] = fromMercator((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
      const ranges = cells.map(elevationRange).filter((r): r is [number, number] => !!r);
      const highest = ranges.reduce((m, r) => Math.max(m, Math.abs(r[0] - reference), Math.abs(r[1] - reference)), 0);
      const margin = (Math.hypot(...displacement(view)) * highest) / Math.cos((lat * Math.PI) / 180) + 2 * pixelSize;
      const reach: GridMap['extent'] = [extent[0] - margin, extent[1] - margin, extent[2] + margin, extent[3] + margin];
      const toRaster = sampleGrid(reach, 65, 65, (x, y) => {
        const [px, py] = fromMercator3857([x, y]);
        return [(px - ox) / sx, (py - oy) / sy];
      });

      say(`${baseName(image.name)} を簡易オルソ補正しています（標高データ ${cells.length} 枚、方位角 ${view.azimuth}°・仰角 ${view.elevation}°、基準高 ${Math.round(reference)} m）…`);
      const result = await runOrtho({ raster, toMap, toRaster, extent, pixelSize, cells, view, referenceHeight: reference, resample });
      const ortho = await this.addOrtho_(image, result);
      if (!ortho) return null;
      const coverage = Math.round(result.demCoverage * 100);
      say(
        `${baseName(image.name)}_ortho.tif を作りました` +
          (coverage >= 100 ? '' : coverage > 0 ? `（標高データがない部分 ${100 - coverage}% はそのまま）` : '（この範囲に標高データがないため、位置は変わっていません）') +
          reducedNote(width / w),
      );
      this.changed_(ortho);
      return ortho;
    } catch (error) {
      say(`簡易オルソ補正できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.busy_ = false;
      this.render();
    }
  }

  /** Adds an orthorectified result of `image` as a new layer that looks like it. */
  private async addOrtho_(image: ViewerImage, result: OrthoResult): Promise<ViewerImage | null> {
    const name = `${baseName(image.name)}_ortho.tif`;
    const source = await this.loader.loadFile(orthoGeoTIFF(result), name).catch(() => null);
    const ortho = source && this.find_(source);
    if (!ortho || !source) return null;
    this.orthos_.set(ortho, { sourceName: image.name, result });
    this.images.setBadge(ortho, 'オルソ');
    // Keep the look of the original: its correction and band assignment.
    const select = image.source.getSelect();
    if (select) await source.setSelect(select);
    this.setPipeline_(ortho, image.source.getPipeline());
    return ortho;
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
    const geo = image && this.geoImages_.get(image);
    if (image && dem) {
      p(`標高データ（${dem.level}）。開いている間、オルソ補正の地形に使います。`);
      this.renderContours_(image, row);
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
    } else if (image && geo) {
      this.renderSimple_(geo, image, cells, p, row, button);
    } else {
      p('RPC 付きの衛星画像（GeoTIFF の RPC タグ、または .RPB・_RPC.TXT を一緒に開く）か、位置情報のある GeoTIFF を選ぶと、オルソ補正できます。');
    }
    p(cells.length ? `標高データ: ${cells.map((c) => c.level).join('、')}（${cells.length} 枚）` : '標高データ: なし（DTED .dt0〜.dt2 を開くと使います）', 'geometry-dems');
  }

  /** The simple orthorectification's part of the panel: the satellite's direction, then the details most never need. */
  private renderSimple_(
    geo: GeoImage,
    image: ViewerImage,
    cells: Dted[],
    p: (text: string) => HTMLElement,
    row: (...children: HTMLElement[]) => HTMLElement,
    button: (text: string, run: () => void, options?: { disabled?: boolean; name?: string }) => HTMLButtonElement,
  ): void {
    const covered = cells.length > 0 && !!geo.lonLat && coversAny(cells, geo.lonLat);
    p(
      'RPC のない画像は、衛星の方向と標高データで簡易オルソ補正できます。' +
        (covered ? '' : 'この範囲の標高データ（DTED）を開いてください。') +
        (geo.view ? '' : '衛星の方位角と仰角を入れてください（.IMD を画像と一緒に開くと読み取ります）。'),
    );
    const angles = { azimuth: geo.view?.azimuth ?? NaN, elevation: geo.view?.elevation ?? NaN };
    const run = button(this.busy_ ? '補正中…' : '簡易オルソ補正', () => void this.simpleOrthorectify(image, resample.value as Resample), { name: 'simple-ortho' });
    const update = () => {
      const ok = angles.azimuth >= 0 && angles.azimuth <= 360 && angles.elevation > 0 && angles.elevation <= 90;
      geo.view = ok ? { ...angles } : null;
      run.disabled = this.busy_ || !ok || !covered;
    };
    const field = (label: string, value: number, min: number, max: number, set: (v: number) => void, placeholder = '') => {
      const el = document.createElement('label');
      el.className = 'geometry-field';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = 'any';
      input.placeholder = placeholder;
      input.name = label;
      if (Number.isFinite(value)) input.value = String(value);
      input.addEventListener('input', () => {
        set(input.value === '' ? NaN : Number(input.value));
        update();
      });
      el.append(label, input);
      return el;
    };
    row(
      field('方位角 °', angles.azimuth, 0, 360, (v) => (angles.azimuth = v)),
      field('仰角 °', angles.elevation, 1, 90, (v) => (angles.elevation = v)),
    );
    const details = document.createElement('details');
    details.className = 'geometry-details';
    const summary = document.createElement('summary');
    summary.textContent = '詳細';
    const resample = document.createElement('select');
    resample.setAttribute('aria-label', '再サンプリング');
    for (const [value, label] of Object.entries(resampleNames)) resample.append(new Option(label, value, value === 'bilinear', value === 'bilinear'));
    const reference = field('基準高 m', geo.referenceHeight ?? NaN, -500, 9000, (v) => (geo.referenceHeight = Number.isFinite(v) ? v : null), '平均標高');
    reference.title = '画像を地図に置いた高さ。空欄なら画像の範囲の平均標高';
    const inner = row(reference, resample);
    details.append(summary, inner);
    this.element.append(details);
    row(run);
    update();
  }

  /** The contour switch and interval of a DEM. */
  private renderContours_(image: ViewerImage, row: (...children: HTMLElement[]) => HTMLDivElement): void {
    const on = this.contours_.has(image);
    const label = document.createElement('label');
    label.className = 'geometry-check';
    label.title = 'DEM のすぐ上に描きます。DEM の不透明度を 0 にすると等高線だけになります';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = on;
    check.dataset.action = 'contours';
    check.addEventListener('change', () => this.setContours(image, check.checked));
    label.append(check, '等高線');
    if (!on) {
      row(label);
      return;
    }
    const select = document.createElement('select');
    select.setAttribute('aria-label', '等高線の間隔');
    select.title = '等高線の間隔（5 本ごとの太線に標高を表示）';
    const chosen = this.contourIntervals_.get(image);
    select.append(new Option(`自動（${this.autoInterval_(image)} m）`, '', chosen === undefined, chosen === undefined));
    for (const m of CONTOUR_INTERVALS) select.append(new Option(`${m} m`, String(m), m === chosen, m === chosen));
    select.addEventListener('change', () => this.setContourInterval(image, select.value ? Number(select.value) : null));
    row(label, select);
    if (this.contourNote_) {
      const note = document.createElement('p');
      note.className = 'geometry-note';
      note.textContent = this.contourNote_;
      this.element.append(note);
    }
  }

  /** A round contour interval for a DEM's range: about 20 lines. */
  private autoInterval_(image: ViewerImage): number {
    let interval = this.autoIntervals_.get(image);
    if (interval === undefined) {
      const dem = this.dems_.get(image);
      const range = dem && elevationRange(dem);
      interval = range ? niceInterval(range[0], range[1]) : 10;
      this.autoIntervals_.set(image, interval);
    }
    return interval;
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
    return loadGeoid();
  }
}

/** The value outside the image when the file has none: 0 for integers, NaN for floats. */
function defaultNoData(data: GeoTIFFSamples): number {
  return data instanceof Float32Array || data instanceof Float64Array ? NaN : 0;
}

/** What the message adds when the image was corrected reduced. */
function reducedNote(k: number): string {
  const n = Math.round(k);
  return n > 1 ? `。大きい画像のため 1/${n} の解像度で補正しました` : '';
}

/**
 * Reads an image for orthorectification: large ones reduced (from their
 * overviews when they have them), so the result stays within what the
 * viewer can make overviews for.
 */
async function readForOrtho(from: Blob | string): Promise<{ first: GeoTIFFImage; raster: Raster; width: number; height: number }> {
  const tiff = await openTiff(from);
  const first = await tiff.getImage();
  const width = first.getWidth();
  const height = first.getHeight();
  const bands = first.getSamplesPerPixel();
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
  return { first, raster: { width: w, height: h, bands, data, noData }, width, height };
}

/** `[minX, minY, maxX, maxY]` of a grid's values. */
function gridBounds({ values }: GridMap): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 2) {
    b[0] = Math.min(b[0], values[i]);
    b[1] = Math.min(b[1], values[i + 1]);
    b[2] = Math.max(b[2], values[i]);
    b[3] = Math.max(b[3], values[i + 1]);
  }
  return b;
}

/** The mean DEM height at a grid's values (Web Mercator points), or null where no DEM covers any. */
function meanHeight(cells: readonly Dted[], { values }: GridMap): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i += 2) {
    const h = elevationAt(cells, ...fromMercator(values[i], values[i + 1]));
    if (h === null) continue;
    sum += h;
    n++;
  }
  return n ? sum / n : null;
}

/** Runs the orthorectification in a worker. */
function runOrtho(input: OrthoInput | SimpleOrthoInput): Promise<OrthoResult> {
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
