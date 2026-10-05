/**
 * Saving what the map shows ("表示範囲を保存"): either the view as drawn
 * (every visible layer with its correction, vectors and labels) as a PNG or
 * a georeferenced RGBA GeoTIFF, optionally rendered 2 or 4 times larger; or
 * the selected GeoTIFF's own samples under the view (every band, its sample
 * type and no-data, in its own CRS) as a GeoTIFF.
 */
import type OlMap from 'ol/Map.js';
import { transformExtent, type ProjectionLike } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import { rasterToGeoTIFF, type GeoTIFFRaster, type GeoTIFFSamples } from 'browser-image-enhancement/openlayers';
import type { GeoTIFFImage } from 'geotiff';
import type { ImageList, ViewerImage } from './images.js';
import { safeName } from './export-dialog.js';
import { getShift } from './shift.js';

/** What is saved: the map as drawn, or the selected image's samples. */
export type ViewContent = 'view' | 'data';
/** The file written. */
export type ViewFormat = 'png' | 'geotiff';

/** Largest width or height of a saved view, in pixels (canvases and WebGL refuse much more). */
export const MAX_VIEW_SIZE = 8192;
/** Most samples read for a clip of the image's data; larger clips are read from an overview. */
export const MAX_CLIP_SAMPLES = 64_000_000;
/** The sizes offered for a saved view, as multiples of the screen. */
export const VIEW_SCALES = [1, 2, 4] as const;

/** The number of an `EPSG:n` code, or null for anything else. */
export function epsgOf(code: string): number | null {
  const m = /^EPSG:(\d+)$/i.exec(code);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Georeferencing tags for a raster whose pixel (0, 0) corner is at `origin`
 * and whose next pixel to the right and below are `right` and `down` away (in
 * map units). An unrotated raster gets ModelPixelScale and ModelTiepoint, a
 * rotated one ModelTransformation.
 */
export function affineGeo(
  origin: readonly [number, number],
  right: readonly [number, number],
  down: readonly [number, number],
  epsg: number,
  geographic: boolean,
): GeoTIFFRaster['geo'] {
  const geoKeyDirectory = [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, 1, geographic ? 2048 : 3072, 0, 1, epsg];
  const straight = Math.abs(right[1]) <= Math.abs(right[0]) * 1e-9 && Math.abs(down[0]) <= Math.abs(down[1]) * 1e-9;
  if (straight && right[0] > 0 && down[1] < 0) {
    return { modelPixelScale: [right[0], -down[1], 0], modelTiepoint: [0, 0, 0, origin[0], origin[1], 0], geoKeyDirectory };
  }
  // X = a·i + b·j + d, Y = e·i + f·j + h.
  const modelTransformation = [right[0], down[0], 0, origin[0], right[1], down[1], 0, origin[1], 0, 0, 0, 0, 0, 0, 0, 1];
  return { modelTransformation, geoKeyDirectory };
}

/** A rectangle of an image, in pixels. */
export interface PixelWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The pixels of an image (`width` × `height`, its top left corner at
 * `origin`, `resolution` per pixel with y negative going down) covering
 * `extent`, clipped to the image; null when they do not meet.
 */
export function pixelWindow(extent: Extent, origin: readonly number[], resolution: readonly number[], width: number, height: number): PixelWindow | null {
  const [rx, ry] = [resolution[0], resolution[1]];
  const cols = [(extent[0] - origin[0]) / rx, (extent[2] - origin[0]) / rx];
  const rows = [(extent[3] - origin[1]) / ry, (extent[1] - origin[1]) / ry];
  // A hair of slack, so a view that lines up with the pixels does not take a whole extra row.
  const x0 = Math.max(0, Math.floor(Math.min(...cols) + 1e-6));
  const x1 = Math.min(width, Math.ceil(Math.max(...cols) - 1e-6));
  const y0 = Math.max(0, Math.floor(Math.min(...rows) + 1e-6));
  const y1 = Math.min(height, Math.ceil(Math.max(...rows) - 1e-6));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Which level to read `window` (in full-resolution pixels) from so that at
 * most `maxSamples` samples are read: the image (level 0) when it fits, else
 * the finest overview that does. `levels` are the image and its overviews,
 * finest first. Returns the level and the window in its pixels; when even the
 * coarsest is too large, the coarsest.
 */
export function pickLevel(
  levels: ReadonlyArray<{ width: number; height: number }>,
  window: PixelWindow,
  bands: number,
  maxSamples = MAX_CLIP_SAMPLES,
): { level: number; window: PixelWindow } {
  const [full] = levels;
  let found = { level: 0, window };
  for (let i = 0; i < levels.length; i++) {
    const kx = levels[i].width / full.width;
    const ky = levels[i].height / full.height;
    const x = Math.floor(window.x * kx);
    const y = Math.floor(window.y * ky);
    const w = Math.max(1, Math.min(levels[i].width, Math.ceil((window.x + window.w) * kx)) - x);
    const h = Math.max(1, Math.min(levels[i].height, Math.ceil((window.y + window.h) * ky)) - y);
    found = { level: i, window: { x, y, w, h } };
    if (w * h * bands <= maxSamples) break;
  }
  return found;
}

/** The scales from {@link VIEW_SCALES} whose output (`size` CSS pixels at `pixelRatio`) stays within {@link MAX_VIEW_SIZE}. */
export function viewScales(size: readonly number[], pixelRatio: number, max = MAX_VIEW_SIZE): number[] {
  const long = Math.max(size[0], size[1]) * pixelRatio;
  return VIEW_SCALES.filter((s, i) => i === 0 || Math.round(long * s) <= max);
}

/** The pixel ratio the map draws at. */
function pixelRatioOf(map: OlMap): number {
  return (map as unknown as { pixelRatio_?: number }).pixelRatio_ ?? window.devicePixelRatio ?? 1;
}

/**
 * The layers' canvases as one canvas of `size` CSS pixels at `pixelRatio`,
 * stacked, placed and faded as on screen (the way OpenLayers' export example
 * does). Canvases a server did not allow to be read (tiles without CORS) are
 * left out and counted.
 */
export function composeLayers(map: OlMap, size: readonly number[], pixelRatio: number): { canvas: HTMLCanvasElement; skipped: number } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size[0] * pixelRatio);
  canvas.height = Math.round(size[1] * pixelRatio);
  const ctx = canvas.getContext('2d')!;
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  probe.canvas.width = probe.canvas.height = 1;
  let skipped = 0;
  for (const layer of map.getViewport().querySelectorAll<HTMLCanvasElement>('.ol-layer canvas, canvas.ol-layer')) {
    if (!layer.width || !layer.height) continue;
    try {
      probe.clearRect(0, 0, 1, 1);
      probe.drawImage(layer, 0, 0, 1, 1, 0, 0, 1, 1);
      probe.getImageData(0, 0, 1, 1);
    } catch {
      skipped++;
      continue;
    }
    const parent = layer.parentElement;
    const opacity = (parent?.classList.contains('ol-layer') ? parent.style.opacity : '') || layer.style.opacity;
    ctx.globalAlpha = opacity === '' ? 1 : Number(opacity);
    // A CSS matrix from the canvas's pixels to CSS pixels, or its CSS size.
    const m = /^matrix\(([^(]*)\)$/.exec(layer.style.transform)?.[1].split(',').map(Number) ?? [
      parseFloat(layer.style.width) / layer.width || 1 / pixelRatio,
      0,
      0,
      parseFloat(layer.style.height) / layer.height || 1 / pixelRatio,
      0,
      0,
    ];
    const background = parent?.style.backgroundColor;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size[0], size[1]);
    }
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(layer, 0, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  return { canvas, skipped };
}

/** Resolves once the map has drawn every tile of the current view (or after `timeout` ms). */
function rendered(map: OlMap, timeout = 60_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout);
    function done() {
      clearTimeout(timer);
      map.un('rendercomplete', done);
      resolve();
    }
    map.on('rendercomplete', done);
    map.render();
  });
}

/** The view as drawn, `scale` times the screen's size, and where it is. */
export interface DrawnView {
  canvas: HTMLCanvasElement;
  /** Georeferencing for a GeoTIFF, or null when the view's projection has no EPSG code. */
  geo: GeoTIFFRaster['geo'] | null;
  /** Layers left out because their server does not allow reading them. */
  skipped: number;
}

/**
 * Draws the view `scale` times larger (same area, finer tiles) and returns it
 * composed into one canvas; the map is put back as it was afterwards.
 */
export async function drawView(map: OlMap, scale = 1): Promise<DrawnView> {
  const size = map.getSize();
  const view = map.getView();
  const resolution = view.getResolution();
  if (!size || !resolution) throw new Error('地図が表示されていません');
  const ratio = pixelRatioOf(map);
  const big = [Math.round(size[0] * scale), Math.round(size[1] * scale)];
  try {
    if (scale !== 1) {
      // The map draws into a larger viewport (clipped on screen) at a finer resolution: the same area, more pixels.
      map.setSize(big);
      view.setResolution(resolution / scale);
      if (Math.abs(view.getResolution()! * scale - resolution) > resolution * 1e-6) {
        throw new Error(`この表示からは ${scale} 倍に拡大できません（ズームの上限です）`);
      }
    }
    await rendered(map);
    const { canvas, skipped } = composeLayers(map, big, ratio);
    const projection = view.getProjection();
    const epsg = epsgOf(projection.getCode());
    let geo: GeoTIFFRaster['geo'] | null = null;
    if (epsg) {
      const at = (x: number, y: number) => map.getCoordinateFromPixelInternal([x / ratio, y / ratio]);
      const [o, r, d] = [at(0, 0), at(1, 0), at(0, 1)];
      geo = affineGeo([o[0], o[1]], [r[0] - o[0], r[1] - o[1]], [d[0] - o[0], d[1] - o[1]], epsg, projection.getUnits() === 'degrees');
    }
    return { canvas, geo, skipped };
  } finally {
    if (scale !== 1) {
      map.setSize(size);
      view.setResolution(resolution);
    }
  }
}

/** An RGBA canvas as an 8-bit RGBA GeoTIFF (alpha as transparency). */
export function canvasToGeoTIFF(canvas: HTMLCanvasElement, geo: GeoTIFFRaster['geo']): Blob {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  return rasterToGeoTIFF(
    { width, height, bands: 4, data: new Uint8Array(data.buffer, data.byteOffset, data.length), photometric: 2, extraSamples: [2], geo },
    { tileSize: 512 },
  );
}

/** A clip of an image's samples, written as a GeoTIFF. */
export interface Clip {
  blob: Blob;
  width: number;
  height: number;
  bands: number;
  /** The overview it was read from: 1 for the image's own resolution, else how many times coarser. */
  reduced: number;
}

/**
 * The samples of `image` under the view (its bounding box when rotated):
 * every band, as stored (sample type, no-data), in the image's CRS, as a
 * GeoTIFF. Read from an overview when the clip is larger than
 * {@link MAX_CLIP_SAMPLES}.
 */
export async function clipImage(map: OlMap, image: ViewerImage): Promise<Clip> {
  const levels = (image.source.getTiffImages()[0] ?? []) as GeoTIFFImage[];
  const full = levels[0];
  const size = map.getSize();
  const projection = image.source.getProjection();
  if (!full || !size || !projection) throw new Error('画像を読み込み中です');
  let origin: number[];
  let resolution: number[];
  try {
    origin = full.getOrigin();
    resolution = full.getResolution();
  } catch {
    throw new Error('この画像の位置情報（回転付きの変換など）からは切り出せません');
  }
  const view = map.getView();
  let extent = view.calculateExtent(size);
  extent = transformExtent(extent, view.getProjection(), projection as ProjectionLike, 8);
  // A moved (orthorectified) layer shows its pixels elsewhere: clip where they are shown, save them there.
  const [sx, sy] = getShift(image.source);
  extent = [extent[0] - sx, extent[1] - sy, extent[2] - sx, extent[3] - sy];
  const window = pixelWindow(extent, origin, resolution, full.getWidth(), full.getHeight());
  if (!window) throw new Error('表示範囲に画像がありません');
  const bands = full.getSamplesPerPixel();
  const sizes = levels.map((l) => ({ width: l.getWidth(), height: l.getHeight() }));
  const picked = pickLevel(sizes, window, bands);
  const level = levels[picked.level];
  const w = picked.window;
  const data = (await level.readRasters({ window: [w.x, w.y, w.x + w.w, w.y + w.h], interleave: true })) as unknown as GeoTIFFSamples;
  const kx = full.getWidth() / level.getWidth();
  const ky = full.getHeight() / level.getHeight();
  const fd = full.fileDirectory;
  const [geoKeyDirectory, geoDoubleParams, geoAsciiParams, extra] = await Promise.all([
    fd.loadValue('GeoKeyDirectory'),
    fd.loadValue('GeoDoubleParams'),
    fd.loadValue('GeoAsciiParams'),
    fd.loadValue('ExtraSamples'),
  ]);
  const color = bands >= 3 ? 3 : 1;
  const extraSamples = bands > color ? Array.from({ length: bands - color }, (_, i) => Number((extra as ArrayLike<number> | undefined)?.[i] ?? 0)) : undefined;
  const blob = rasterToGeoTIFF(
    {
      width: w.w,
      height: w.h,
      bands,
      data,
      noData: full.getGDALNoData(),
      photometric: color === 3 ? 2 : 1,
      extraSamples,
      geo: {
        modelPixelScale: [Math.abs(resolution[0]) * kx, Math.abs(resolution[1]) * ky, 0],
        modelTiepoint: [0, 0, 0, origin[0] + w.x * kx * resolution[0] + sx, origin[1] + w.y * ky * resolution[1] + sy, 0],
        geoKeyDirectory: geoKeyDirectory ? Array.from(geoKeyDirectory as ArrayLike<number>) : undefined,
        geoDoubleParams: geoDoubleParams ? Array.from(geoDoubleParams as ArrayLike<number>) : undefined,
        geoAsciiParams: typeof geoAsciiParams === 'string' ? geoAsciiParams : undefined,
      },
    },
    { statistics: true },
  );
  return { blob, width: w.w, height: w.h, bands, reduced: Math.round(kx) };
}

/** A canvas as a PNG. */
function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG にできませんでした'))), 'image/png'));
}

/** A file name without its folders and extension. */
function stem(name: string): string {
  const base = name.split(/[\\/]/).pop()!.split('?')[0];
  return safeName(base.replace(/\.[^.]+$/, ''));
}

/** The "表示範囲を保存" dialog. */
export class ViewExportDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly note_: HTMLElement;
  private busy_ = false;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: { say: (message: string) => void },
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service view-export';
    this.dialog.setAttribute('aria-labelledby', 'view-export-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form view-export-form">
        <h2 id="view-export-title">表示範囲を保存</h2>
        <label class="wide">内容<select name="content" aria-label="内容">
          <option value="view">見たまま（表示中のレイヤーを補正・スタイルごと）</option>
          <option value="data">選択中の画像の元データ（全バンド・元の値と座標系）</option>
        </select></label>
        <label>形式<select name="format" aria-label="形式">
          <option value="png">PNG</option>
          <option value="geotiff">GeoTIFF</option>
        </select></label>
        <label>大きさ<select name="scale" aria-label="大きさ"></select></label>
      </form>
      <p class="service-status view-export-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="save" class="primary">保存</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.note_ = this.dialog.querySelector('.view-export-note')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => void this.save());
    this.form_.addEventListener('change', () => this.update_());
    button.addEventListener('click', () => this.open());
  }

  private field_<T extends HTMLSelectElement>(name: string): T {
    return this.form_.elements.namedItem(name) as T;
  }

  /** The selected image, when its samples can be clipped (a GeoTIFF placed by its georeferencing). */
  private clippable_(): ViewerImage | null {
    const image = this.images.selected();
    return image?.kind === 'geotiff' ? image : null;
  }

  /** Opens the dialog. */
  open(): void {
    const size = this.map.getSize() ?? [0, 0];
    const ratio = pixelRatioOf(this.map);
    const scale = this.field_('scale');
    const allowed = viewScales(size, ratio);
    scale.replaceChildren(
      ...VIEW_SCALES.map((s) => {
        const o = new Option(`${s === 1 ? '画面と同じ' : `${s} 倍`}（${Math.round(size[0] * ratio * s)} × ${Math.round(size[1] * ratio * s)} px）`, String(s));
        o.disabled = !allowed.includes(s);
        return o;
      }),
    );
    scale.value = '1';
    const data = this.field_('content').querySelector<HTMLOptionElement>('option[value=data]')!;
    data.disabled = !this.clippable_();
    if (data.disabled) this.field_('content').value = 'view';
    this.update_();
    this.dialog.showModal();
  }

  private update_(): void {
    const content = this.field_('content').value as ViewContent;
    const format = this.field_('format');
    const png = format.querySelector<HTMLOptionElement>('option[value=png]')!;
    png.disabled = content === 'data';
    if (png.disabled) format.value = 'geotiff';
    this.field_('scale').disabled = content === 'data';
    const notes: string[] = [];
    if (content === 'view') {
      notes.push('地図に見えているとおり（補正・ベクターのスタイルとラベル・背景地図）を保存します。画像のない部分は透明です');
      if (format.value === 'geotiff') notes.push(`8bit の RGBA で、地図の座標系（${this.map.getView().getProjection().getCode()}）の位置情報を付けます`);
      if (this.map.getView().getRotation() && format.value === 'geotiff') notes.push('地図が回転しているので、回転付きの変換（ModelTransformation）で書きます');
    } else {
      const image = this.clippable_();
      notes.push(`${image ? stem(image.name) : '画像'} の表示範囲を、補正をかけない元の値のまま全バンド切り出します（座標系・データ型・nodata もそのまま）`);
      notes.push(`大きすぎるときは RSET（縮小版）から読みます`);
    }
    this.note_.textContent = notes.join('。');
  }

  /** Writes the file chosen in the dialog and hands it over. */
  async save(): Promise<void> {
    if (this.busy_) return;
    const content = this.field_('content').value as ViewContent;
    const format = this.field_('format').value as ViewFormat;
    const scale = Number(this.field_('scale').value) || 1;
    this.dialog.close();
    const { say } = this.options;
    this.busy_ = true;
    try {
      if (content === 'data') {
        const image = this.clippable_();
        if (!image) throw new Error('GeoTIFF の画像を選んでください');
        say(`${stem(image.name)} の表示範囲を切り出しています…`);
        const clip = await clipImage(this.map, image);
        const name = `${stem(image.name)}_clip.tif`;
        saveBlob(name, clip.blob);
        say(`${name} を保存しました（${clip.width} × ${clip.height} px、${clip.bands} バンド${clip.reduced > 1 ? `、大きいため RSET 1/${clip.reduced} から` : ''}）`);
        return;
      }
      say('表示範囲を描いています…');
      const drawn = await drawView(this.map, scale);
      const selected = this.images.selectedLayer();
      const base = `${selected ? stem(selected.name) : 'view'}_view`;
      let name: string;
      if (format === 'geotiff') {
        if (!drawn.geo) throw new Error(`地図の座標系（${this.map.getView().getProjection().getCode()}）を GeoTIFF に書けません`);
        name = `${base}.tif`;
        saveBlob(name, canvasToGeoTIFF(drawn.canvas, drawn.geo));
      } else {
        name = `${base}.png`;
        saveBlob(name, await toPng(drawn.canvas));
      }
      say(
        `${name} を保存しました（${drawn.canvas.width} × ${drawn.canvas.height} px）` +
          (drawn.skipped ? `。読み取りを許可していないサーバーのレイヤー ${drawn.skipped} 件は含めていません` : ''),
      );
    } catch (error) {
      say(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy_ = false;
    }
  }
}

function saveBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
