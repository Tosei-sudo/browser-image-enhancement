/**
 * Reduced-resolution sets (RSET, overviews) of the open images: whether an
 * image has them (in the file, in a GDAL .ovr file chosen with it, or made
 * by the viewer when it was opened; while they are being made, the image is
 * on the map already, drawn only zoomed in near its raw pixels),
 * which level the view is drawn from right now (an RSET level or the raw
 * pixels), and the progress of the ones being made.
 */
import type OlMap from 'ol/Map.js';
import type View from 'ol/View.js';
import type BaseLayer from 'ol/layer/Base.js';
import { getWidth } from 'ol/extent.js';
import { unByKey } from 'ol/Observable.js';
import { transformExtent } from 'ol/proj.js';
import type { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';
import type { MadeOverviews } from './overviews.js';
import type { ViewerLayer } from './images.js';

const generated = new WeakMap<EnhancedGeoTIFF, MadeOverviews>();

/** Marks `source` as opened with an RSET the viewer made, or joined from an .ovr file. */
export function markGenerated(source: EnhancedGeoTIFF, made: MadeOverviews): void {
  generated.set(source, made);
}

/** How far out the view may be zoomed from the raw pixels while the RSET is made (2: down to half size). */
export const RAW_ZOOM_OUT = 2;

/** When the viewer shows an image before its RSET is made. */
export const rsetSettings = {
  /** Images of more pixels than this are shown at once, and get their RSET after; smaller ones get it first (it takes well under a second). */
  showFirstAbove: 4096 * 4096,
  /** Held back until this settles, when set: lets the browser tests look at an image before its RSET is done. */
  hold: null as Promise<unknown> | null,
};

/** Images being shown before their RSET is made, and how to show them at every scale again. */
const building = new WeakMap<EnhancedGeoTIFF, () => void>();

/**
 * Marks `source` as shown before its RSET is made: `layer` is drawn only
 * when the view is zoomed in near the raw pixels (down to 1/{@link RAW_ZOOM_OUT}),
 * as zoomed out it would read every raw tile of the image.
 */
export function markBuilding(source: EnhancedGeoTIFF, layer: BaseLayer, map: OlMap): void {
  const limit = () => {
    const scale = viewScale(map.getView(), source);
    const resolutions = source.getTileGrid()?.getResolutions() ?? [];
    // A little over, so the view at exactly 1/2 still shows it (the layer is drawn below its maximum).
    layer.setMaxResolution(scale && resolutions.length ? (Math.min(...resolutions) / scale) * RAW_ZOOM_OUT * 1.01 : Infinity);
  };
  limit();
  // Another view (a base map in another projection) has other units.
  const key = map.on('change:view', limit);
  building.set(source, () => {
    unByKey(key);
    layer.setMaxResolution(Infinity);
  });
}

/** Ends {@link markBuilding}: the layer is drawn at every scale again. */
export function endBuilding(source: EnhancedGeoTIFF): void {
  building.get(source)?.();
  building.delete(source);
}

/**
 * The RSET of an image: made by the viewer, from an .ovr file (named in
 * `ovr`), in the file, being made, or none; with each level's reduction (2 =
 * half size), finest first.
 */
export interface RsetState {
  kind: 'generated' | 'external' | 'file' | 'building' | 'none';
  factors: number[];
  ovr?: string;
}

export function rsetOf(source: EnhancedGeoTIFF): RsetState {
  if (building.has(source)) return { kind: 'building', factors: [] };
  const resolutions = source.getTileGrid()?.getResolutions() ?? [];
  const finest = Math.min(...resolutions);
  const factors = resolutions
    .map((r) => reduction(r / finest))
    .filter((f) => f > 1)
    .sort((a, b) => a - b);
  const made = generated.get(source);
  if (!factors.length) return { kind: 'none', factors };
  if (made?.external) return { kind: 'external', factors, ovr: made.external };
  return { kind: made ? 'generated' : 'file', factors };
}

/** For the information panel: 生成済み（1/2〜1/32、5 レベル） and the like. */
export function rsetText({ kind, factors, ovr }: RsetState): string {
  if (kind === 'building') return `生成中（それまでは 1/${RAW_ZOOM_OUT} 以上に拡大したときだけ生画素で表示します）`;
  if (kind === 'none') return 'なし（縮小表示でも生画素を読みます）';
  const range = factors.length > 1 ? `1/${factors[0]}〜1/${factors[factors.length - 1]}` : `1/${factors[0]}`;
  const from = { generated: '生成済み（このビューアーで作成）', external: `外部 OVR（${ovr}）`, file: 'ファイルに内蔵' }[kind];
  return `${from}・${range}、${factors.length} レベル`;
}

/**
 * The reduction of the level the view draws `source` from: 1 for the raw
 * pixels, 8 for the RSET level at 1/8. Taken the way OpenLayers picks its
 * zoom level, with the view's resolution in the image's units.
 */
export function shownFactor(map: OlMap, source: EnhancedGeoTIFF): number | null {
  const view = map.getView();
  const resolution = view.getResolution();
  const grid = source.getTileGrid();
  const scale = viewScale(view, source);
  if (!resolution || !grid || !scale) return null;
  const z = grid.getZForResolution(resolution * scale, source.zDirection);
  const resolutions = grid.getResolutions();
  return reduction(grid.getResolution(z) / Math.min(...resolutions));
}

/**
 * Image units per view unit (1 in the same projection): across projections,
 * how wide the image is in each. Null before the source is ready.
 */
function viewScale(view: View, source: EnhancedGeoTIFF): number | null {
  const grid = source.getTileGrid();
  const projection = source.getProjection();
  if (!grid || !projection) return null;
  const viewProjection = view.getProjection();
  if (projection.getCode() === viewProjection.getCode()) return 1;
  const extent = grid.getExtent();
  return getWidth(extent) / getWidth(transformExtent(extent, projection, viewProjection));
}

/** A ratio of resolutions as the power of two it stands for (levels halve with rounding up, so 254.8 is 256). */
function reduction(ratio: number): number {
  return 2 ** Math.round(Math.log2(ratio));
}

/**
 * A label on the map for the selected image: whether the view shows its raw
 * pixels or an RSET level (and which).
 */
export class RsetIndicator {
  readonly element = document.createElement('div');
  private layer_: ViewerLayer | null = null;

  constructor(private readonly map: OlMap) {
    this.element.className = 'rset-shown';
    this.element.hidden = true;
    map.getTargetElement()?.append(this.element);
    const update = () => this.update();
    map.getView().on('change:resolution', update);
    map.on('moveend', update);
    map.on('change:view', () => map.getView().on('change:resolution', update));
  }

  /** Follows `layer` (the selected one; none for a service or nothing). */
  setLayer(layer: ViewerLayer | null): void {
    this.layer_ = layer;
    this.update();
  }

  update(): void {
    const layer = this.layer_;
    const factor = layer?.type === 'image' ? shownFactor(this.map, layer.source) : null;
    const el = this.element;
    el.hidden = factor === null;
    if (factor === null || layer?.type !== 'image') return;
    const raw = factor === 1;
    // While the RSET is made, nothing is drawn zoomed out.
    const resolution = this.map.getView().getResolution();
    const waiting = building.has(layer.source) && resolution !== undefined && resolution >= layer.layer.getMaxResolution();
    el.classList.toggle('raw', raw && !waiting);
    el.classList.toggle('waiting', waiting);
    el.textContent = waiting ? `RSET 生成中: 1/${RAW_ZOOM_OUT} 以上に拡大すると表示します` : raw ? '表示: 生画素' : `表示: RSET 1/${factor}`;
  }
}

/** One RSET being made: its progress, then gone. */
export interface RsetJob {
  update(done: number): void;
  end(): void;
}

/** Panel on the map listing the RSETs being made, with a progress bar each. */
export class RsetProgress {
  readonly element = document.createElement('div');

  constructor(target: HTMLElement) {
    this.element.className = 'rset-progress';
    this.element.setAttribute('role', 'status');
    this.element.hidden = true;
    target.append(this.element);
  }

  start(name: string): RsetJob {
    const row = document.createElement('div');
    row.className = 'rset-job';
    const label = document.createElement('span');
    label.textContent = `${name} の RSET を生成中…（拡大すると生画素で表示します）`;
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = 0;
    const percent = document.createElement('span');
    percent.className = 'rset-percent';
    percent.textContent = '0%';
    row.append(label, bar, percent);
    this.element.append(row);
    this.element.hidden = false;
    return {
      update: (done) => {
        bar.value = done;
        percent.textContent = `${Math.floor(done * 100)}%`;
      },
      end: () => {
        row.remove();
        this.element.hidden = !this.element.childElementCount;
      },
    };
  }
}
