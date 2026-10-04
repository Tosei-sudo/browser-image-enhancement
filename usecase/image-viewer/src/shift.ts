/**
 * Moving an image on the map without reading it again: the source's tile
 * grid is replaced by a copy moved by `[dx, dy]`, so the same tiles are drawn
 * somewhere else at once (OpenLayers works out where each tile goes from the
 * grid on every frame). Used to line up an orthorectified satellite image
 * whose RPC model is off by some metres.
 *
 * Only for sources in the map's projection: a source in another projection
 * is drawn through reprojected tiles, which this does not move.
 */
import TileGrid from 'ol/tilegrid/TileGrid.js';
import type { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';

interface Shifted {
  /** The grid the source was opened with. */
  grid: TileGrid;
  shift: [number, number];
}

const shifted = new WeakMap<EnhancedGeoTIFF, Shifted>();

/** How far `source` has been moved, in map units (`[0, 0]` when never). */
export function getShift(source: EnhancedGeoTIFF): [number, number] {
  const s = shifted.get(source)?.shift;
  return s ? [s[0], s[1]] : [0, 0];
}

/** Moves `source` by `[dx, dy]` map units from where it was opened (not from where it is). */
export function setShift(source: EnhancedGeoTIFF, [dx, dy]: readonly [number, number]): void {
  let state = shifted.get(source);
  if (!state) {
    const grid = source.getTileGrid();
    if (!grid) throw new Error('The source is not ready.');
    state = { grid, shift: [0, 0] };
    shifted.set(source, state);
    // Everything that asks where the image is (zoom to it, pixel coordinates, the info panel) gets the moved place.
    const original = source.getView.bind(source);
    source.getView = async () => {
      const view = await original();
      const [sx, sy] = shifted.get(source)!.shift;
      return {
        ...view,
        extent: view.extent ? [view.extent[0] + sx, view.extent[1] + sy, view.extent[2] + sx, view.extent[3] + sy] : view.extent,
        center: view.center ? [view.center[0] + sx, view.center[1] + sy] : view.center,
      };
    };
  }
  state.shift = [dx, dy];
  const base = state.grid;
  const resolutions = base.getResolutions();
  const extent = base.getExtent();
  const grid = new TileGrid({
    extent: extent ? [extent[0] + dx, extent[1] + dy, extent[2] + dx, extent[3] + dy] : undefined,
    origins: resolutions.map((_, z) => {
      const [x, y] = base.getOrigin(z);
      return [x + dx, y + dy];
    }),
    resolutions,
    tileSizes: resolutions.map((_, z) => base.getTileSize(z)),
    minZoom: base.getMinZoom(),
  });
  (source as unknown as { tileGrid: TileGrid }).tileGrid = grid;
  source.changed();
}
