/**
 * Esri scene services (I3S): 3D object and integrated mesh layers of a
 * `…/SceneServer`, through CesiumJS's I3S reader. Scene layers give heights
 * above the geoid (gravity-related); CesiumJS shifts them to the ellipsoid
 * with a geoid it reads as elevation tiles, which this module makes from the
 * bundled EGM96 grid (no Esri elevation service is needed, so it works in a
 * closed network). CesiumJS reads scene layers in WGS 84 (wkid 4326) only.
 */
import { HeightmapTerrainData, I3SDataProvider, WebMercatorTilingScheme } from '@cesium/engine';
import { Math as CesiumMath } from '@cesium/core';
import { geoidHeight, type GeoidGrid } from './dem.js';

/** Whether `url` is a scene service or one of its layers. */
export function isSceneServer(url: string): boolean {
  return /\/SceneServer(\/layers\/\d+)?\/?(\?.*)?$/i.test(url);
}

/** Posts across a geoid tile. */
const SIZE = 65;
/** Level of the geoid tiles: about 1,250 km across, posts some 20 km apart (the EGM96 grid is 0.5°). */
const LEVEL = 5;

/** EGM96 as the elevation tiles CesiumJS's I3S reader takes its geoid from. */
function geoidTiles(geoid: GeoidGrid): unknown {
  const tilingScheme = new WebMercatorTilingScheme();
  return {
    tilingScheme,
    _lodCount: LEVEL,
    requestTileGeometry(x: number, y: number, level: number) {
      const buffer = new Float32Array(SIZE * SIZE);
      // Rows north to south, posts evenly spaced in Web Mercator.
      const native = tilingScheme.tileXYToNativeRectangle(x, y, level);
      const projection = tilingScheme.projection;
      for (let row = 0; row < SIZE; row++) {
        const my = native.north - ((native.north - native.south) * row) / (SIZE - 1);
        for (let col = 0; col < SIZE; col++) {
          const mx = native.west + ((native.east - native.west) * col) / (SIZE - 1);
          const c = projection.unproject({ x: mx, y: my, z: 0 } as never);
          buffer[row * SIZE + col] = geoidHeight(geoid, CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude));
        }
      }
      return Promise.resolve(new HeightmapTerrainData({ buffer, width: SIZE, height: SIZE }));
    },
  };
}

/** Opens a scene service (or one of its layers), placed on the ellipsoid with EGM96. */
export function openSceneService(url: string, geoid: GeoidGrid): Promise<I3SDataProvider> {
  return I3SDataProvider.fromUrl(url, { geoidTiledTerrainProvider: geoidTiles(geoid) as never, showFeatures: false });
}
