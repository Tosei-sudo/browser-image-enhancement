/**
 * What the viewer needs from a satellite image for orthorectification: its
 * RPC model (from the GeoTIFF tag or a side file) and whether it is
 * georeferenced at all. An image with RPC but no georeferencing (a level-1
 * product) is placed where its RPC model puts it, at the model's height
 * offset, until it is orthorectified.
 */
import { fromArrayBuffer, fromBlob, fromUrl, type GeoTIFF } from 'geotiff';
import type { GeoTIFFRaster } from 'browser-image-enhancement/openlayers';
import { rpcFromTag, rpcProjector, type Rpc } from './rpc.js';

/** The RPC model and georeferencing state of a TIFF. */
export interface TiffInfo {
  rpc: Rpc | null;
  georeferenced: boolean;
  width: number;
  height: number;
}

/** Opens a TIFF from a file or URL, reading only the parts asked for. */
export async function openTiff(from: Blob | string): Promise<GeoTIFF> {
  if (typeof from === 'string') return fromUrl(from);
  return typeof FileReader === 'undefined' ? fromArrayBuffer(await from.arrayBuffer()) : fromBlob(from);
}

/** The RPC model in the TIFF's RPCCoefficientTag (50844), and whether it has georeferencing tags. */
export async function tiffInfo(from: Blob | string): Promise<TiffInfo> {
  const tiff = await openTiff(from);
  const image = await tiff.getImage();
  const fd = image.fileDirectory;
  let rpc: Rpc | null = null;
  if (fd.hasTag(50844)) {
    try {
      rpc = rpcFromTag((await fd.loadValue(50844)) as ArrayLike<number>);
    } catch {
      rpc = null;
    }
  }
  return { rpc, georeferenced: fd.hasTag(33922) || fd.hasTag(34264), width: image.getWidth(), height: image.getHeight() };
}

/**
 * Approximate georeferencing from an RPC model: the box of the image corners
 * on the ground at the model's height offset, north up, in WGS 84.
 */
export function rpcGeo(rpc: Rpc, width: number, height: number): GeoTIFFRaster['geo'] {
  const p = rpcProjector(rpc);
  const corners = [
    [-0.5, -0.5],
    [width - 0.5, -0.5],
    [-0.5, height - 0.5],
    [width - 0.5, height - 0.5],
  ].map(([s, l]) => p.toGround(s, l, rpc.heightOff));
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const west = Math.min(...lons);
  const north = Math.max(...lats);
  return {
    modelPixelScale: [(Math.max(...lons) - west) / width, (north - Math.min(...lats)) / height, 0],
    modelTiepoint: [0, 0, 0, west, north, 0],
    geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326],
  };
}
