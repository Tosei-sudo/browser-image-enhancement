/** DTED cells as GeoTIFFs, so they open on the map like any other image. */
import { rasterToGeoTIFF } from 'browser-image-enhancement/openlayers';
import { DTED_VOID, type Dted } from './dted.js';

/**
 * A DTED cell as a tiled GeoTIFF with overviews (16-bit, EPSG:4326), for
 * showing it on the map. Posts are points, so each pixel is centered on its post.
 */
export function dtedToGeoTIFF(cell: Dted): Blob {
  const [dLon, dLat] = cell.spacing;
  const north = cell.south + (cell.height - 1) * dLat;
  return rasterToGeoTIFF({
    width: cell.width,
    height: cell.height,
    bands: 1,
    data: cell.data,
    noData: DTED_VOID,
    photometric: 1,
    geo: {
      modelPixelScale: [dLon, dLat, 0],
      modelTiepoint: [0, 0, 0, cell.west - dLon / 2, north + dLat / 2, 0],
      // Geographic, pixel is area, WGS 84.
      geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326],
    },
  }, { statistics: true });
}
