/**
 * The 2D map drawn as tiles for the 3D view: every layer as the 2D map shows
 * it (corrections, DRA, styles, labels, base maps, measurements) is drawn by
 * the map itself at the extent of a globe tile and handed over as a canvas,
 * so the globe always shows exactly what 2D would.
 *
 * While the 3D view is open the 2D map is hidden under it and only draws
 * these tiles; its move events are held back so nothing reacts to the tile
 * views (DRA, contours, the scale marks of the layer list…).
 */
import type OlMap from 'ol/Map.js';
import type BaseEvent from 'ol/events/Event.js';
import type Layer from 'ol/layer/Layer.js';
import VectorSource from 'ol/source/Vector.js';
import { buffer, containsExtent, createEmpty, extend, intersects, isEmpty, type Extent } from 'ol/extent.js';
import { transformExtent, type ProjectionLike } from 'ol/proj.js';
import { getUid } from 'ol/util.js';
import { composeLayers } from './view-export.js';

/** The view the 2D map had before the 3D view took it over. */
interface SavedView {
  size: number[] | undefined;
  center: number[] | undefined;
  resolution: number | undefined;
  rotation: number;
}

/** Where the 2D map has something to draw: an extent, or null for everywhere. */
export type DataExtent = Extent | null;

/**
 * The part of the map any visible layer can draw in, in the view's
 * projection: the union of the layers' extents (their own, their tile grid's
 * or their features'), or null when a layer can draw anywhere (a base map).
 * Vector extents are widened by `margin` (map units) so symbols near the edge
 * are not cut off.
 */
export function dataExtent(map: OlMap, margin = 0): DataExtent {
  const code = map.getView().getProjection();
  const all = createEmpty();
  for (const layer of map.getAllLayers()) {
    if (!layer.getVisible() || layer.getOpacity() === 0) continue;
    const e = layerExtent(layer, code, margin);
    if (e === null) return null;
    if (e) extend(all, e);
  }
  return all;
}

/** A layer's extent as {@link dataExtent} uses it: undefined when it draws nothing. */
function layerExtent(layer: Layer, projection: ProjectionLike, margin: number): Extent | null | undefined {
  const own = layer.getExtent();
  if (own) return own;
  const source = layer.getSource() as unknown as {
    getTileGrid?: () => { getExtent(): Extent } | null;
    getProjection?: () => ProjectionLike | null;
    getImageExtent?: () => Extent;
  } | null;
  if (!source) return undefined;
  if (source instanceof VectorSource) {
    const e = source.getExtent() as Extent;
    return isEmpty(e) ? undefined : buffer(e, margin);
  }
  const from = source.getProjection?.() ?? projection;
  const grid = source.getTileGrid?.();
  const e = grid?.getExtent() ?? source.getImageExtent?.();
  if (!e) return null;
  try {
    return transformExtent(e, from, projection);
  } catch {
    return null;
  }
}

const ids = new WeakMap<object, number>();
let lastId = 0;
/** A number for an object (a style, a style function), the same each time. */
function idOf(o: unknown): string {
  if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(o ?? '');
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = ++lastId));
  return `#${id}`;
}

/**
 * What the drawn map depends on, as a string: each layer's visibility,
 * opacity, order, scale range and extent, its source's revision, its
 * correction's revision and its style. Drawing alone does not change it
 * (images and icons loading do change the layers' own revisions).
 */
export function layerSignature(map: OlMap): string {
  return map
    .getAllLayers()
    .map((l) => {
      const source = l.getSource() as { getRevision(): number } | null;
      const correction = (l as unknown as { correction_?: { getRevision?(): number } | null }).correction_;
      const style = (l as unknown as { getStyle?: () => unknown }).getStyle?.();
      return [
        getUid(l),
        l.getVisible(),
        l.getOpacity(),
        l.getZIndex(),
        l.getMinResolution(),
        l.getMaxResolution(),
        l.getMinZoom(),
        l.getMaxZoom(),
        String(l.getExtent() ?? ''),
        source ? `${getUid(source)}:${source.getRevision()}` : '',
        correction?.getRevision?.() ?? '',
        idOf(style),
      ].join(',');
    })
    .join('|');
}

/** Whether a tile at `extent` has anything to draw. */
export function tileHasData(data: DataExtent, extent: Extent): boolean {
  return data === null || (!isEmpty(data) && (intersects(data, extent) || containsExtent(extent, data)));
}

/**
 * Draws tiles of the 2D map, one at a time (the map has one view). Call
 * {@link begin} when the 3D view opens and {@link end} when it closes.
 */
export class MapTileRenderer {
  private saved_: SavedView | null = null;
  private queue_: Promise<unknown> = Promise.resolve();
  private drawing_ = 0;
  /** Called when the last tile asked for is drawn. */
  onIdle: () => void = () => {};

  constructor(private readonly map: OlMap) {}

  /** Whether the renderer has the map. */
  active(): boolean {
    return this.saved_ !== null;
  }

  /** Whether tiles are being drawn (the layers' change events then come from drawing, mostly). */
  busy(): boolean {
    return this.drawing_ > 0;
  }

  /** Takes the map over: keeps its view to put back, and holds back its move events. */
  begin(): void {
    if (this.saved_) return;
    const view = this.map.getView();
    this.saved_ = { size: this.map.getSize()?.slice(), center: view.getCenter()?.slice(), resolution: view.getResolution(), rotation: view.getRotation() };
    const map = this.map;
    const dispatch = map.dispatchEvent.bind(map);
    map.dispatchEvent = (event: BaseEvent | string) => {
      const type = typeof event === 'string' ? event : event.type;
      if (type === 'moveend' || type === 'movestart') return undefined;
      return dispatch(event);
    };
  }

  /**
   * Gives the map back with its view as it was, or centred on `center` at
   * `resolution` when given (where the 3D camera looked).
   */
  async end(at?: { center: number[]; resolution: number }): Promise<void> {
    const saved = this.saved_;
    if (!saved) return;
    // Let a tile being drawn finish first.
    await this.queue_.catch(() => {});
    this.saved_ = null;
    // The method of the prototype again.
    delete (this.map as unknown as Record<string, unknown>).dispatchEvent;
    const view = this.map.getView();
    this.map.updateSize();
    view.setRotation(at ? 0 : saved.rotation);
    view.setCenter(at?.center ?? saved.center);
    view.setResolution(at?.resolution ?? saved.resolution);
    this.map.render();
  }

  /**
   * The map drawn over `extent` (in the view's projection, unrotated) into
   * `width` × `height` CSS pixels, as one canvas at the map's pixel ratio.
   */
  render(extent: Extent, width: number, height: number, timeout = 30_000): Promise<HTMLCanvasElement> {
    this.drawing_++;
    const next = this.queue_
      .catch(() => {})
      .then(() => this.draw_(extent, width, height, timeout))
      .finally(() => {
        if (--this.drawing_ === 0) this.onIdle();
      });
    this.queue_ = next;
    return next;
  }

  private async draw_(extent: Extent, width: number, height: number, timeout: number): Promise<HTMLCanvasElement> {
    if (!this.saved_) throw new Error('3D 表示が閉じられました');
    const map = this.map;
    const view = map.getView();
    map.setSize([width, height]);
    view.setRotation(0);
    view.setCenter([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]);
    view.setResolution((extent[2] - extent[0]) / width);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeout);
      function done() {
        clearTimeout(timer);
        map.un('rendercomplete', done);
        resolve();
      }
      map.on('rendercomplete', done);
      map.render();
    });
    const ratio = (map as unknown as { pixelRatio_?: number }).pixelRatio_ ?? window.devicePixelRatio ?? 1;
    return composeLayers(map, [width, height], ratio).canvas;
  }
}
