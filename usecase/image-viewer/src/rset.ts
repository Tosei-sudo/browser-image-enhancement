/**
 * Reduced-resolution sets (RSET, overviews) of the open images: whether an
 * image has them (in the file, or made by the viewer when it was opened),
 * which level the view is drawn from right now (an RSET level or the raw
 * pixels), and the progress of the ones being made.
 */
import type OlMap from 'ol/Map.js';
import { getWidth } from 'ol/extent.js';
import { transformExtent } from 'ol/proj.js';
import type { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';
import type { MadeOverviews } from './overviews.js';
import type { ViewerLayer } from './images.js';

const generated = new WeakMap<EnhancedGeoTIFF, MadeOverviews>();

/** Marks `source` as opened with an RSET the viewer made. */
export function markGenerated(source: EnhancedGeoTIFF, made: MadeOverviews): void {
  generated.set(source, made);
}

/** The RSET of an image: made by the viewer, in the file, or none; with each level's reduction (2 = half size), finest first. */
export interface RsetState {
  kind: 'generated' | 'file' | 'none';
  factors: number[];
}

export function rsetOf(source: EnhancedGeoTIFF): RsetState {
  const resolutions = source.getTileGrid()?.getResolutions() ?? [];
  const finest = Math.min(...resolutions);
  const factors = resolutions
    .map((r) => reduction(r / finest))
    .filter((f) => f > 1)
    .sort((a, b) => a - b);
  return { kind: !factors.length ? 'none' : generated.has(source) ? 'generated' : 'file', factors };
}

/** For the information panel: 生成済み（1/2〜1/32、5 レベル） and the like. */
export function rsetText({ kind, factors }: RsetState): string {
  if (kind === 'none') return 'なし（縮小表示でも生画素を読みます）';
  const range = factors.length > 1 ? `1/${factors[0]}〜1/${factors[factors.length - 1]}` : `1/${factors[0]}`;
  return `${kind === 'generated' ? '生成済み（このビューアーで作成）' : 'ファイルに内蔵'}・${range}、${factors.length} レベル`;
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
  const projection = source.getProjection();
  if (!resolution || !grid || !projection) return null;
  let sourceResolution = resolution;
  const viewProjection = view.getProjection();
  if (projection.getCode() !== viewProjection.getCode()) {
    // Across projections: scale by how wide the image is in each.
    const extent = grid.getExtent();
    sourceResolution = resolution * (getWidth(extent) / getWidth(transformExtent(extent, projection, viewProjection)));
  }
  const z = grid.getZForResolution(sourceResolution, source.zDirection);
  const resolutions = grid.getResolutions();
  return reduction(grid.getResolution(z) / Math.min(...resolutions));
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
    el.classList.toggle('raw', raw);
    el.textContent = raw ? '表示: 生画素' : `表示: RSET 1/${factor}`;
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
    label.textContent = `${name} の RSET を生成中…`;
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
