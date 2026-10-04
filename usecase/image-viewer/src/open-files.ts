/**
 * Files chosen or dropped together: Shapefiles and GeoJSON become read-only
 * vector layers with an attribute table, DTED files open as elevation data,
 * GeoTIFFs without overviews get them first (appended to the file, which
 * is read where it is), and other pictures open as they are. A GeoTIFF with
 * an RPC model (its own tag, or an .RPB / _RPC.TXT file chosen with it) is marked for orthorectification; without georeferencing
 * it is placed where the model puts it.
 */
import { isEmpty } from 'ol/extent.js';
import type { LoadImageControl } from 'browser-image-enhancement/openlayers';
import { MAX_FEATURES, nextColor, projectionOf, type ServiceLayer } from './services/index.js';
import { plainStyle, vectorLayer } from './services/vector.js';
import { isVectorName, readVectorFiles, type VectorFile } from './vector-files.js';
import { isTiff, withOverviews } from './overviews.js';
import { isDtedName } from './dted.js';
import { isRpcName, parseRpcText, rpcBaseName, type Rpc } from './rpc.js';
import { rpcGeo, tiffInfo } from './satellite.js';
import type { GeometricMode } from './geometric.js';
import { baseName } from './images.js';

export interface OpenFilesContext {
  loader: LoadImageControl;
  /** Adds a vector layer to the list. */
  addLayer: (layer: ServiceLayer) => void;
  say: (message: string) => void;
  /** Takes DTED files and satellite images. */
  geometry: GeometricMode;
}

/** The file chooser's `accept`: pictures, GeoTIFFs, Shapefiles, GeoJSON, GeoPackages, DTED and RPC files. */
export const acceptFiles = '.tif,.tiff,image/*,.zip,.shp,.dbf,.shx,.prj,.cpg,.geojson,.json,.gpkg,.dt0,.dt1,.dt2,.rpb,.rpc,.txt';

export async function openFiles(files: File[], context: OpenFilesContext): Promise<void> {
  const vectors = files.filter((f) => isVectorName(f.name));
  if (vectors.length) await openVectors(vectors, context);
  for (const file of files.filter((f) => isDtedName(f.name))) await context.geometry.openDem(file);
  const rpcs = await readRpcFiles(files.filter((f) => isRpcName(f.name)), context);
  const images = files.filter((f) => !isVectorName(f.name) && !isDtedName(f.name) && !isRpcName(f.name) && !/\.txt$/i.test(f.name));
  for (const file of images) {
    // An RPC file goes with the image of the same name, or with the only image.
    const rpc = rpcs.get(baseName(file.name).toLowerCase()) ?? (images.length === 1 && rpcs.size === 1 ? [...rpcs.values()][0] : null);
    await openImage(file, context, rpc);
  }
}

/** The RPC models of side files, by the image name they belong to. */
async function readRpcFiles(files: File[], { say }: OpenFilesContext): Promise<Map<string, Rpc>> {
  const models = new Map<string, Rpc>();
  for (const file of files) {
    try {
      models.set(rpcBaseName(file.name), parseRpcText(await file.text()));
    } catch (error) {
      say(`${file.name} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return models;
}

async function openVectors(files: File[], { addLayer, say }: OpenFilesContext): Promise<void> {
  const names = files.map((f) => f.name).join('、');
  say(`${names} を読み込んでいます…`);
  try {
    const read = await readVectorFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), projectionOf);
    for (const file of read) addLayer(vectorFileLayer(file));
    say(`${read.map((f) => f.title).join('、')} を開きました（読み取り専用）`);
  } catch (error) {
    say(`${names} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens a picture or GeoTIFF; a GeoTIFF without overviews gets them first. */
async function openImage(file: File, { loader, say, geometry }: OpenFilesContext, sideRpc: Rpc | null = null): Promise<void> {
  let blob: Blob = file;
  let rpc: Rpc | null = null;
  if (await isTiff(file)) {
    say(`${file.name} を読み込んでいます…`);
    const info = await tiffInfo(file).catch(() => null);
    rpc = sideRpc ?? info?.rpc ?? null;
    // A satellite image without georeferencing goes where its RPC model puts it.
    const geo = rpc && info && !info.georeferenced ? rpcGeo(rpc, info.width, info.height) : undefined;
    // Unreadable here (an unusual TIFF): open it as it is, and let the loader say what is wrong.
    const onProgress = (done: number) => say(`${file.name} の概観を作っています… ${Math.floor(done * 100)}%`);
    blob = (await withOverviews(file, { geo, onProgress }).catch(() => null)) ?? file;
  }
  const source = await loader.loadFile(blob, file.name).catch(() => null); // the loader's onError tells the user
  if (source && rpc) geometry.setSatellite(source, { rpc, from: file });
}

/** A layer for the list, like a service's vector layer but read-only and without a link. */
export function vectorFileLayer(file: VectorFile): ServiceLayer {
  const truncated = file.features.length > MAX_FEATURES;
  const features = truncated ? file.features.slice(0, MAX_FEATURES) : file.features;
  const layer = vectorLayer(features, plainStyle(nextColor()));
  const source = layer.getSource()!;
  const extent = source.getExtent();
  const info: Array<[string, string]> = [
    ['種類', `${file.format}（読み取り専用）`],
    ['座標系', file.crs],
    ['地物数', `${file.features.length.toLocaleString()}${truncated ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
  ];
  if (file.encoding) info.push(['文字コード', file.encoding === 'shift_jis' ? 'Shift_JIS' : file.encoding.toUpperCase()]);
  return {
    ref: null,
    badge: { Shapefile: 'SHP', GeoJSON: 'GeoJSON', GeoPackage: 'GPKG' }[file.format],
    title: file.title,
    layer,
    correction: null,
    vector: { source, fields: file.fields, truncated },
    extent: extent && !isEmpty(extent) ? extent : null,
    info,
  };
}
