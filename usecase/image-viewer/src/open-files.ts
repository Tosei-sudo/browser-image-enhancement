/**
 * Files chosen or dropped together: Shapefiles, GeoJSON and GeoPackages
 * become vector layers with an attribute table (editable, see local-edit.ts),
 * DTED files open as elevation data, GeoTIFFs without overviews get them (an
 * RSET) first (appended to the file, which is read where it is; a large one
 * is shown at once, zoomed in only, and gets its RSET after), and other
 * pictures open as they are. A GeoTIFF with an RPC model (its own tag, or an
 * .RPB / _RPC.TXT file chosen with it) is marked for orthorectification;
 * without georeferencing it is placed where the model puts it. A GDAL .ovr
 * file chosen with a GeoTIFF (`a.tif.ovr` or `a.ovr`) is its RSET, used
 * instead of making one. A georeferenced GeoTIFF without an RPC model can be
 * orthorectified more simply; the satellite's direction comes from an .IMD
 * file chosen with it, or from its GDAL metadata. A NITF file (or SICD,
 * shown as amplitude) opens as a GeoTIFF read in place (see nitf-tiff.ts).
 */
import { isEmpty } from 'ol/extent.js';
import type Projection from 'ol/proj/Projection.js';
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { MAX_FEATURES, nextColor, projectionOf, type ServiceLayer } from './services/index.js';
import { vectorLayer } from './services/vector.js';
import { LayerStyle, singleSpec, type VectorStyleSpec } from './vector-style.js';
import { readStyleQml } from './style-file.js';
import { isVectorName, readVectorFiles, stem, type VectorFile } from './vector-files.js';
import { isCsvName, readCsv } from './csv.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import type Feature from 'ol/Feature.js';
import { geoEntries, isTiff, madeOverviews, planOverviews, type OverviewPlan } from './overviews.js';
import { isOvrName, ovrBelongsTo, withExternalOverviews } from './external-overviews.js';
import { isDtedName } from './dted.js';
import { isRpcName, parseRpcText, rpcBaseName, type Rpc } from './rpc.js';
import { sensorPlacementOf, tiffInfo } from './satellite.js';
import { isImdName, sensorViewFromText, type SensorView } from './simple-ortho.js';
import type { GeometricMode } from './geometric.js';
import { baseName } from './images.js';
import { handleOf } from './recent-files.js';
import { isEditable, localTarget } from './local-edit.js';
import { markGenerated, rsetSettings, type RsetJob, type RsetProgress } from './rset.js';
import { isNitf } from './nitf.js';
import { copyFileInfo, nitfAsTiff, setFileInfo, type NitfAsTiff } from './nitf-tiff.js';

export interface OpenFilesContext {
  loader: LoadImageControl;
  /** Adds a vector layer to the list. */
  addLayer: (layer: ServiceLayer) => void;
  say: (message: string) => void;
  /** Takes DTED files and satellite images. */
  geometry: GeometricMode;
  /** Shows the RSETs being made. */
  rset?: RsetProgress;
  /**
   * Called when an image opened with an RSET the viewer made. For a large
   * image, shown before its RSET was made (see {@link rsetSettings}), it is
   * called again when the RSET is done, with the source to show from then on
   * and the one it `replaces`: put it on the image's layer, or dispose of it
   * when the image has been closed. When the RSET could not be made, the
   * image keeps its source, given as both.
   */
  onRsetMade?: (source: EnhancedGeoTIFF, replaces?: EnhancedGeoTIFF) => void;
  /** Called when a large image is shown before its RSET is made (it is being made). */
  onRsetBuilding?: (source: EnhancedGeoTIFF) => void;
}

/** The file chooser's `accept`: pictures, GeoTIFFs (and their .ovr), NITF and SICD, Shapefiles (and their .qml style), GeoJSON, GeoPackages, CSV, DTED, RPC and IMD files, and project files (opened by project.ts). */
export const acceptFiles = '.ivproj,.tif,.tiff,.ovr,.ntf,.nitf,.nsf,.r0,.sicd,image/*,.zip,.shp,.dbf,.shx,.prj,.cpg,.qml,.geojson,.json,.gpkg,.csv,.tsv,.dt0,.dt1,.dt2,.rpb,.rpc,.txt,.imd';

export async function openFiles(files: File[], context: OpenFilesContext): Promise<void> {
  const vectors = files.filter((f) => isVectorName(f.name));
  if (vectors.length) await openVectors(vectors, context);
  for (const file of files.filter((f) => isCsvName(f.name))) await openCsv(file, context);
  for (const file of files.filter((f) => isDtedName(f.name))) await context.geometry.openDem(file);
  const rpcs = await readRpcFiles(files.filter((f) => isRpcName(f.name)), context);
  const ovrs = files.filter((f) => isOvrName(f.name));
  const views = await readImdFiles(files.filter((f) => isImdName(f.name)));
  const images = files.filter(
    (f) => !isVectorName(f.name) && !isCsvName(f.name) && !isDtedName(f.name) && !isRpcName(f.name) && !isOvrName(f.name) && !isImdName(f.name) && !/\.txt$/i.test(f.name),
  );
  const used = new Set<File>();
  for (const file of images) {
    // An RPC file goes with the image of the same name, or with the only image; so does an .ovr file.
    const rpc = rpcs.get(baseName(file.name).toLowerCase()) ?? (images.length === 1 && rpcs.size === 1 ? [...rpcs.values()][0] : null);
    const ovr = ovrs.find((o) => ovrBelongsTo(o.name, file.name)) ?? (images.length === 1 && ovrs.length === 1 ? ovrs[0] : null);
    if (ovr) used.add(ovr);
    const view = views.get(baseName(file.name).toLowerCase()) ?? (images.length === 1 && views.size === 1 ? [...views.values()][0] : null);
    await openImage(file, context, rpc, ovr, view);
  }
  const unused = ovrs.filter((o) => !used.has(o));
  if (unused.length) context.say(`${unused.map((o) => o.name).join('、')} に合う GeoTIFF がありません（画像と一緒に選んでください）`);
}

/** The satellite directions in .IMD files, by the image name they belong to. */
async function readImdFiles(files: File[]): Promise<Map<string, SensorView>> {
  const views = new Map<string, SensorView>();
  for (const file of files) {
    const view = sensorViewFromText(await file.text());
    if (view) views.set(baseName(file.name).toLowerCase(), view);
  }
  return views;
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
    const read = await readVectorFiles(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), handle: handleOf(f) }))), projectionOf);
    for (const file of read) addLayer(vectorFileLayer(file));
    say(`${read.map((f) => f.title).join('、')} を開きました（✎ で編集できます）`);
  } catch (error) {
    say(`${names} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens a CSV as a table without geometry (points come from it with 「XY 座標からポイントを作成」). */
async function openCsv(file: File, { addLayer, say }: OpenFilesContext): Promise<void> {
  try {
    const csv = readCsv(new Uint8Array(await file.arrayBuffer()), stem(file.name));
    addLayer(csvLayer(csv));
    say(`${file.name} を開きました（${csv.features.length.toLocaleString()} 行。「プロセッシング」の「XY 座標からポイントを作成」で地図に置けます）`);
  } catch (error) {
    say(`${file.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A table layer for the list: nothing on the map, its rows in the attribute table. */
export function csvLayer(csv: ReturnType<typeof readCsv>): ServiceLayer {
  const source = new VectorSource<Feature>({ features: csv.features });
  return {
    ref: null,
    badge: 'CSV',
    title: csv.title,
    layer: new VectorLayer({ source }),
    correction: null,
    vector: { source, fields: csv.fields, truncated: false },
    tableOnly: true,
    extent: null,
    info: [
      ['種類', 'CSV（表のみ・読み取り専用）'],
      ['行数', csv.features.length.toLocaleString()],
      ['列数', csv.fields.length.toLocaleString()],
      ['文字コード', csv.encoding === 'shift_jis' ? 'Shift_JIS' : 'UTF-8'],
      ['区切り', { '\t': 'タブ', ',': 'カンマ', ';': 'セミコロン' }[csv.delimiter] ?? csv.delimiter],
    ],
  };
}

/**
 * Opens one picture or GeoTIFF made in the viewer (a pan-sharpened image)
 * the way a chosen file opens, RSET and all; its source, or null when it
 * could not be opened.
 */
export function openImageFile(file: File, context: OpenFilesContext): Promise<EnhancedGeoTIFF | null> {
  return openImage(file, context);
}

/**
 * Opens a picture or GeoTIFF; a GeoTIFF without overviews gets them first,
 * from its .ovr file when there is one. A large one without an .ovr is
 * shown at once (only zoomed in near its raw pixels) while they are made.
 */
async function openImage(file: File, context: OpenFilesContext, sideRpc: Rpc | null = null, ovr: File | null = null, view: SensorView | null = null): Promise<EnhancedGeoTIFF | null> {
  const { loader, say, geometry, rset, onRsetMade } = context;
  let blob: Blob = file;
  let rpc: Rpc | null = null;
  let georeferenced = false;
  let projection: Projection | undefined;
  let nitf: NitfAsTiff | null = null;
  if (await isNitf(file)) {
    try {
      nitf = await nitfAsTiff(file);
    } catch (error) {
      say(`${file.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    for (const note of nitf.notes) say(`${file.name}: ${note}`);
    // From here on it is a GeoTIFF whose pixels are the NITF's.
    file = nitf.file;
    blob = file;
  }
  if (await isTiff(file)) {
    say(`${file.name} を読み込んでいます…`);
    const info = await tiffInfo(file).catch(() => null);
    rpc = sideRpc ?? info?.rpc ?? null;
    georeferenced = !!info?.georeferenced;
    view ??= info?.view ?? null;
    // A satellite image without georeferencing (or with ground control points only, like an ICEYE GRD) goes where its RPC model puts it, else where its points do: warped through the model as it is drawn.
    const placement = info ? sensorPlacementOf(info, rpc) : null;
    const geo = placement?.geo;
    projection = placement?.projection ?? undefined;
    if (ovr) {
      try {
        blob = (await withExternalOverviews(file, ovr, { name: ovr.name, replace: geo ? geoEntries(geo) : [] })) ?? file;
      } catch (error) {
        say(`${ovr.name} は ${file.name} の RSET に使えません（${error instanceof Error ? error.message : String(error)}）。RSET を生成します`);
      }
    }
    // Unreadable here (an unusual TIFF): open it as it is, and let the loader say what is wrong.
    const plan = blob === file ? await planOverviews(file, { geo }).catch(() => null) : null;
    if (plan && plan.width * plan.height > rsetSettings.showFirstAbove) {
      const source = await loader.loadFile(plan.raw, file.name, { projection }).catch(() => null);
      if (!source) return null;
      if (nitf) setFileInfo(source, nitf.info);
      context.onRsetBuilding?.(source);
      if (rpc) geometry.setSatellite(source, { rpc, from: file });
      else if (georeferenced) geometry.setGeoreferenced(source, file, view);
      void buildLater(file.name, plan, source, context, projection);
      return source;
    }
    if (plan) blob = (await buildOverviews(file.name, plan, rset)) ?? file;
  }
  const source = await loader.loadFile(blob, file.name, { projection }).catch(() => null); // the loader's onError tells the user
  if (source && nitf) setFileInfo(source, nitf.info);
  const made = madeOverviews(blob);
  if (source && made) {
    markGenerated(source, made);
    onRsetMade?.(source);
  }
  if (source && rpc) geometry.setSatellite(source, { rpc, from: file });
  else if (source && georeferenced) geometry.setGeoreferenced(source, file, view);
  return source;
}

/** Makes the overviews of `plan`, with its progress in `rset`; null when they cannot be made. */
async function buildOverviews(name: string, plan: OverviewPlan, rset: RsetProgress | undefined): Promise<Blob | null> {
  let job: RsetJob | null = null;
  try {
    return await plan.build((done) => {
      job ??= rset?.start(name) ?? null;
      job?.update(done);
    });
  } catch {
    return null;
  } finally {
    (job as RsetJob | null)?.end(); // set in onProgress
  }
}

/** Makes the RSET of an image already shown as `shown`, then gives the source to show from then on to `onRsetMade`. */
async function buildLater(name: string, plan: OverviewPlan, shown: EnhancedGeoTIFF, { loader, say, rset, onRsetMade }: OpenFilesContext, projection?: Projection): Promise<void> {
  // The progress panel shows at once: the image is on the map, but zoomed out nothing is drawn yet.
  const job = rset?.start(name) ?? null;
  const blob = await Promise.resolve(rsetSettings.hold)
    .then(() => plan.build((done) => job?.update(done)))
    .catch(() => null)
    .finally(() => job?.end());
  const made = blob && madeOverviews(blob);
  const source = blob && made ? await loader.createSource(blob, { projection }).catch(() => null) : null;
  if (!source || !made) {
    say(`${name} の RSET を生成できませんでした。縮小表示でも生画素を読みます`);
    onRsetMade?.(shown, shown);
    return;
  }
  markGenerated(source, made);
  copyFileInfo(shown, source);
  onRsetMade?.(source, shown);
}

/** The style a file came with, when it has one the viewer can read. */
function fileStyle(file: VectorFile): VectorStyleSpec | null {
  if (!file.styleQml) return null;
  try {
    return readStyleQml(file.styleQml, singleSpec('#4363d8'));
  } catch {
    return null;
  }
}

/** A layer for the list, like a service's vector layer but without a link; editable when it can be saved again. */
export function vectorFileLayer(file: VectorFile): ServiceLayer {
  const truncated = file.features.length > MAX_FEATURES;
  const features = truncated ? file.features.slice(0, MAX_FEATURES) : file.features;
  const layer = vectorLayer(features);
  const source = layer.getSource()!;
  const extent = source.getExtent();
  const editable = isEditable(file, truncated);
  // Every attribute of a file can be changed, but the GeoPackage feature id.
  const fields = editable ? file.fields.map((f) => (f.type === 'oid' ? f : { ...f, editable: true })) : file.fields;
  const info: Array<[string, string]> = [
    ['種類', editable ? file.format : `${file.format}（読み取り専用）`],
    ['座標系', file.crs],
    ['地物数', `${file.features.length.toLocaleString()}${truncated ? `（先頭 ${MAX_FEATURES.toLocaleString()} 件）` : ''}`],
  ];
  if (file.encoding) info.push(['文字コード', file.encoding === 'shift_jis' ? 'Shift_JIS' : file.encoding.toUpperCase()]);
  if (editable && file.format === 'Shapefile' && file.encoding !== 'utf-8') info.push(['保存', '属性は UTF-8（.cpg 付き）で書き込みます']);
  return {
    ref: null,
    badge: { Shapefile: 'SHP', GeoJSON: 'GeoJSON', GeoPackage: 'GPKG' }[file.format],
    title: file.title,
    layer,
    correction: null,
    vector: { source, fields, truncated, idField: file.gpkg?.idColumn },
    // The style that came with the file, else one symbol in the next color; 「初期設定に戻す」 goes back to it.
    style: new LayerStyle(layer, fileStyle(file) ?? singleSpec(nextColor())),
    ...(editable ? { editTarget: localTarget(file, source, fields) } : {}),
    fileCrs: file.writeCrs,
    extent: extent && !isEmpty(extent) ? extent : null,
    info,
  };
}
