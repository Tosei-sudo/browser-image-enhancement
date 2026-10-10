/**
 * Picture tiles from a service (WMS, WMTS, a base map) as one layer that can
 * be corrected on the GPU like the images.
 *
 * WebGL may only read pictures the server shares with CORS, so the tiles are
 * first loaded with `crossOrigin`. When the server does not allow it, the
 * first tiles fail; the layer then switches to an ordinary canvas tile layer
 * (loaded without CORS, not corrected), inside the same layer group so the
 * list, opacity and order keep working.
 */
import LayerGroup from 'ol/layer/Group.js';
import TileLayer from 'ol/layer/Tile.js';
import ImageTile from 'ol/source/ImageTile.js';
import type TileGrid from 'ol/tilegrid/TileGrid.js';
import type { ProjectionLike } from 'ol/proj.js';
import type { AttributionLike } from 'ol/source/Source.js';
import { GpuCorrectedTileLayer, TileCorrection } from 'browser-image-enhancement/openlayers';

export interface PictureTilesOptions {
  /** URL of the tile at z / x / y (OpenLayers tile coordinates). */
  url: (z: number, x: number, y: number) => string;
  tileGrid?: TileGrid;
  projection?: ProjectionLike;
  attributions?: AttributionLike;
  /** Correct on the GPU (WebGL2 is available). */
  gpu: boolean;
  /** Called when the server turned out not to allow CORS, so the layer is no longer corrected. */
  onNoCors?: () => void;
}

export interface PictureTiles {
  layer: LayerGroup;
  /** The correction, while the layer can be corrected. */
  correction: () => TileCorrection | null;
  /** Loads every tile again (the URLs changed: another time). */
  refresh: () => void;
}

export function pictureTiles(options: PictureTilesOptions): PictureTiles {
  const sourceOptions = {
    url: (z: number, x: number, y: number) => options.url(z, x, y),
    tileGrid: options.tileGrid,
    projection: options.projection,
    attributions: options.attributions,
    wrapX: false,
  };
  const plain = () => new TileLayer({ source: new ImageTile({ ...sourceOptions }) });
  // A new URL function gives the tiles a new key, so the renderers load them again (refresh() alone keeps the cached ones).
  const refresh = (group: LayerGroup) => () =>
    group.getLayers().forEach((l) => (l as TileLayer<ImageTile>).getSource()?.setUrl((z: number, x: number, y: number) => options.url(z, x, y)));

  if (!options.gpu) {
    const group = new LayerGroup({ layers: [plain()] });
    return { layer: group, correction: () => null, refresh: refresh(group) };
  }

  let correction: TileCorrection | null = new TileCorrection();
  const source = new ImageTile({ ...sourceOptions, crossOrigin: 'anonymous' });
  const corrected = new GpuCorrectedTileLayer({ source, correction });
  const group = new LayerGroup({ layers: [corrected] });

  // A tile that loads proves CORS works; failures before that mean it does not.
  let loaded = false;
  let failures = 0;
  source.on('tileloadend', () => (loaded = true));
  source.on('tileloaderror', () => {
    if (loaded || ++failures < 2 || !correction) return;
    correction = null;
    group.getLayers().setAt(0, plain());
    corrected.dispose();
    options.onNoCors?.();
  });
  return { layer: group, correction: () => correction, refresh: refresh(group) };
}
