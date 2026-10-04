/**
 * Files chosen or dropped together: Shapefiles and GeoJSON become read-only
 * vector layers with an attribute table, GeoTIFFs without overviews get them
 * first, and other pictures open as they are.
 */
import { isEmpty } from 'ol/extent.js';
import type { LoadImageControl } from 'browser-image-enhancement/openlayers';
import { MAX_FEATURES, nextColor, projectionOf, type ServiceLayer } from './services/index.js';
import { plainStyle, vectorLayer } from './services/vector.js';
import { isVectorName, readVectorFiles, type VectorFile } from './vector-files.js';
import { isTiff, withOverviews } from './overviews.js';

export interface OpenFilesContext {
  loader: LoadImageControl;
  /** Adds a vector layer to the list. */
  addLayer: (layer: ServiceLayer) => void;
  say: (message: string) => void;
}

/** The file chooser's `accept`: pictures, GeoTIFFs, Shapefiles and GeoJSON. */
export const acceptFiles = '.tif,.tiff,image/*,.zip,.shp,.dbf,.shx,.prj,.cpg,.geojson,.json';

export async function openFiles(files: File[], context: OpenFilesContext): Promise<void> {
  const vectors = files.filter((f) => isVectorName(f.name));
  if (vectors.length) await openVectors(vectors, context);
  for (const file of files.filter((f) => !isVectorName(f.name))) await openImage(file, context);
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
async function openImage(file: File, { loader, say }: OpenFilesContext): Promise<void> {
  let blob: Blob = file;
  if (await isTiff(file)) {
    say(`${file.name} を読み込んでいます…`);
    // Unreadable here (an unusual TIFF): open it as it is, and let the loader say what is wrong.
    blob = (await withOverviews(file).catch(() => null)) ?? file;
  }
  await loader.loadFile(blob, file.name).catch(() => {}); // the loader's onError tells the user
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
    badge: file.format === 'Shapefile' ? 'SHP' : 'GeoJSON',
    title: file.title,
    layer,
    correction: null,
    vector: { source, fields: file.fields, truncated },
    extent: extent && !isEmpty(extent) ? extent : null,
    info,
  };
}
