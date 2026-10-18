/**
 * QGIS projects (`.qgs`, and `.qgz`: a zip holding one) read as the viewer's
 * project (project-file.ts), so they open the way an `.ivproj` does: layers
 * in the order of QGIS's layer tree, with their visibility and opacity;
 * services by URL (WMS, WMTS, XYZ, WFS, ArcGIS feature and map services),
 * local files by name (the person is asked for them), cloud GeoTIFFs by URL
 * (`/vsicurl/`); vector symbols and labels through the QML mapping
 * (style-file.ts), raster pseudo-color and band assignment where the viewer
 * has the same thing; and the map canvas's extent. Layers the viewer cannot
 * open (databases, vector tiles, meshes…) are listed instead.
 *
 * The view can also be written as a `.qgs`, for QGIS to open: services by
 * URL, local files by name (next to the project file), and vector styles.
 */
import { iter } from 'but-unzip';
import { attr, escapeXml as esc, kid, kids, parseXml, path, textOf, type XmlElement } from './safe-xml.js';
import { labelingXml, readQgisLayerStyle, rendererXml, StyleNotes, type SymbolKind } from './style-file.js';
import { readRasterRenderer } from './qgis-style.js';
import { singleSpec, type VectorStyleSpec } from './vector-style.js';
import { PROJECT_FORMAT, type FileRef, type FileSetRef, type Project, type ProjectLayer } from './project-file.js';
import type { ServiceRef } from './services/common.js';
import { splitXyz, xyzUrl, XYZ_LAYER } from './services/xyz.js';

/** The extensions of QGIS project files. */
export const QGIS_EXTENSIONS = ['.qgs', '.qgz'];

/** Whether a file name is a QGIS project's. */
export function isQgisName(name: string): boolean {
  return QGIS_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e));
}

/** The most bytes of a `.qgz` read, and of the `.qgs` inside (50 MB). */
export const MAX_QGIS = 50_000_000;

/** The `.qgs` text of a QGIS project file (unzipped from a `.qgz`). */
export async function qgisText(file: File): Promise<string> {
  if (file.size > MAX_QGIS) throw new Error(`${file.name} は大きすぎます（50 MB まで）`);
  if (!file.name.toLowerCase().endsWith('.qgz')) return file.text();
  const bytes = new Uint8Array(await file.arrayBuffer());
  for (const item of iter(bytes)) {
    if (!/\.qgs$/i.test(item.filename) || item.filename.includes('/')) continue;
    const data = await item.read();
    if (data.length > MAX_QGIS) throw new Error(`${file.name} の中の ${item.filename} が大きすぎます`);
    return new TextDecoder().decode(data);
  }
  throw new Error(`${file.name} に .qgs がありません`);
}

/** A QGIS project read for the viewer. */
export interface QgisImport {
  project: Project;
  /** The map canvas's extent, and the CRS it is in (`EPSG:…`). */
  extent: { crs: string; extent: [number, number, number, number] } | null;
  /** Layers that are not opened, each `name（why）`. */
  unsupported: string[];
  /** What of the opened layers' styles was left out, each `name: what`. */
  notes: string[];
}

/** `k=v&k=v` of a QGIS WMS / XYZ data source, values decoded; repeated keys kept in order. */
export function sourceParams(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of source.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    let value = eq < 0 ? '' : part.slice(eq + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, '%20'));
    } catch {
      // as written
    }
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

/** `key='value' key="value" key=value` of a QGIS WFS / ArcGIS data source. */
export function quotedParams(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([\w-]+)=(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.set(m[1], (m[2] ?? m[3] ?? m[4] ?? '').replace(/\\(.)/g, '$1'));
  return out;
}

const isHttp = (url: string) => /^https?:\/\//i.test(url);

/** Where a QGIS layer's data comes from, as the viewer opens it, or why it cannot. */
type Origin =
  | { kind: 'service'; ref: ServiceRef; note?: string }
  | { kind: 'url'; url: string }
  | { kind: 'files'; key: string; files: string[]; pick: string; url?: string; note?: string }
  | { kind: 'none'; why: string };

/** The file name of a path (`/data/roads.shp`, `C:\data\roads.shp`, `./roads.shp`). */
const baseName = (p: string) => p.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? p;

/** The files a local vector or raster file needs: a Shapefile's parts, else the file. */
function localFiles(file: string): string[] {
  const name = baseName(file);
  const m = /^(.*)\.shp$/i.exec(name);
  if (m) return ['.shp', '.shx', '.dbf', '.prj'].map((e) => m[1] + (name.endsWith('.SHP') ? e.toUpperCase() : e));
  return [name];
}

/** The origin of a layer from its provider and data source. */
export function originOf(provider: string, source: string, type: string): Origin {
  const p = provider.toLowerCase();
  if (type === 'vector-tile' || p === 'xyzvectortiles' || p === 'arcgisvectortileservice' || p === 'mbtilesvectortiles') return { kind: 'none', why: 'ベクタータイル' };
  if (type === 'mesh' || type === 'pointcloud' || type === 'annotation' || type === 'group' || type === 'plugin' || type === 'tiled-scene') return { kind: 'none', why: `${type} レイヤー` };
  if (p === 'wms') {
    const q = sourceParams(source);
    const url = q.get('url')?.[0] ?? '';
    if (!isHttp(url)) return { kind: 'none', why: 'URL がありません' };
    if (q.get('type')?.[0] === 'xyz') {
      const zmin = Number(q.get('zmin')?.[0] ?? 0);
      const zmax = Number(q.get('zmax')?.[0] ?? 19);
      return { kind: 'service', ref: { kind: 'xyz', url: xyzUrl(url, undefined, Number.isInteger(zmin) ? zmin : 0, Number.isInteger(zmax) ? zmax : 19), layer: XYZ_LAYER } };
    }
    if (q.get('type')?.[0] === 'mbtiles') return { kind: 'none', why: 'MBTiles' };
    const layers = (q.get('layers') ?? []).filter(Boolean);
    if (!layers.length) return { kind: 'none', why: 'レイヤー名がありません' };
    const note = layers.length > 1 ? `重ねた ${layers.length} レイヤーのうち最初の「${layers[0]}」だけを開きます` : undefined;
    const matrixSet = q.get('tileMatrixSet')?.[0];
    if (matrixSet) {
      const format = q.get('format')?.[0];
      return { kind: 'service', ref: { kind: 'wmts', url, layer: layers[0], matrixSet, ...(format ? { format } : {}) }, note };
    }
    return { kind: 'service', ref: { kind: 'wms', url, layer: layers[0] }, note };
  }
  if (p === 'wfs' || p === 'oapif') {
    if (p === 'oapif') return { kind: 'none', why: 'OGC API - Features' };
    let url: string | undefined;
    let typename: string | undefined;
    if (isHttp(source.trim())) {
      // A URI: `https://…?SERVICE=WFS&TYPENAME=…`.
      try {
        const u = new URL(source.trim());
        typename = [...u.searchParams].find(([k]) => /^type_?names?$/i.test(k))?.[1];
        for (const k of [...u.searchParams.keys()]) if (/^(service|version|request|typenames?|type_?name|srsname|bbox|outputformat)$/i.test(k)) u.searchParams.delete(k);
        url = u.href.replace(/\?$/, '');
      } catch {
        // not a URL after all
      }
    } else {
      const q = quotedParams(source);
      url = q.get('url');
      typename = q.get('typename');
    }
    if (!url || !isHttp(url) || !typename) return { kind: 'none', why: 'WFS の URL かレイヤー名がありません' };
    return { kind: 'service', ref: { kind: 'wfs', url, layer: typename } };
  }
  if (p === 'arcgisfeatureserver') {
    const url = quotedParams(source).get('url') ?? '';
    const m = /^(https?:\/\/.*\/(?:FeatureServer|MapServer))\/(\d+)\/?$/i.exec(url);
    if (!m) return { kind: 'none', why: 'ArcGIS のレイヤーの URL がありません' };
    return { kind: 'service', ref: { kind: 'esri', url: m[1], layer: m[2] } };
  }
  if (p === 'arcgismapserver') {
    const q = quotedParams(source);
    const url = (q.get('url') ?? '').replace(/\/+$/, '');
    if (/\/ImageServer$/i.test(url)) return { kind: 'service', ref: { kind: 'esri', url, layer: 'image' } };
    if (!/^https?:\/\/.*\/MapServer$/i.test(url)) return { kind: 'none', why: 'ArcGIS マップサービスの URL がありません' };
    const layer = q.get('layer');
    return { kind: 'service', ref: { kind: 'esri', url, layer: 'map' }, ...(layer ? { note: `マップサービスの地図全体を開きます（レイヤー ${layer} だけではありません）` } : {}) };
  }
  if (p === 'ogr' || p === 'gdal' || p === 'delimitedtext') {
    let file = source.split('|')[0].trim();
    const options = source.split('|').slice(1);
    let note: string | undefined;
    if (p === 'delimitedtext') {
      file = file.replace(/\?.*$/, '');
      try {
        if (/^file:/i.test(file)) file = decodeURIComponent(new URL(file).pathname);
      } catch {
        // as written
      }
    }
    // `/vsicurl/https://…`: a file on a server.
    const curl = /^\/vsicurl\/(https?:\/\/.+)$/i.exec(file);
    const http = curl?.[1] ?? (isHttp(file) ? file : null);
    if (http) {
      if (p === 'gdal') return { kind: 'url', url: http };
      return { kind: 'files', key: http, files: [baseName(http)], pick: '', url: http };
    }
    if (/^\/vsi/i.test(file)) {
      const zip = /^\/vsizip\/(.+?\.zip)(?:\/|$)/i.exec(file);
      if (!zip) return { kind: 'none', why: `${file.split('/')[1]} の仮想ファイル` };
      file = zip[1];
      note = 'zip の中のファイルは zip ごと開きます';
    }
    if (/^(PG|MSSQL|OCI|MySQL|ODBC|WFS|MongoDB):/i.test(file)) return { kind: 'none', why: 'データベース' };
    if (!file) return { kind: 'none', why: 'ファイルがありません' };
    if (options.some((o) => /^subset=/i.test(o))) note = '絞り込み（サブセット）は使わず、すべての地物を開きます';
    const layername = options.map((o) => /^layername=(.*)$/i.exec(o)?.[1]).find((x) => x !== undefined) ?? '';
    return { kind: 'files', key: file.replace(/\\/g, '/').toLowerCase(), files: localFiles(file), pick: layername, ...(note ? { note } : {}) };
  }
  if (p === 'postgres' || p === 'spatialite' || p === 'mssql' || p === 'oracle' || p === 'hana' || p === 'db2') return { kind: 'none', why: 'データベース' };
  if (p === 'memory') return { kind: 'none', why: '一時スクラッチレイヤー' };
  if (p === 'virtual') return { kind: 'none', why: '仮想レイヤー' };
  return { kind: 'none', why: `プロバイダー「${provider}」` };
}

/** The layers of the layer tree, top first, with whether they and every group above them are checked. */
function treeOrder(root: XmlElement): Array<{ id: string; name: string | null; visible: boolean }> {
  const out: Array<{ id: string; name: string | null; visible: boolean }> = [];
  const checked = (el: XmlElement) => attr(el, 'checked') !== 'Qt::Unchecked';
  const walk = (group: XmlElement, visible: boolean) => {
    for (const c of group.children) {
      if (c.local === 'layer-tree-layer') out.push({ id: attr(c, 'id') ?? '', name: attr(c, 'name'), visible: visible && checked(c) });
      else if (c.local === 'layer-tree-group') walk(c, visible && checked(c));
    }
  };
  const tree = kid(root, 'layer-tree-group');
  if (tree) walk(tree, true);
  // A custom drawing order, when the project has one: top first.
  const custom = kid(tree, 'custom-order');
  if (custom && attr(custom, 'enabled') === '1') {
    const order = kids(custom, 'item').map((i) => textOf(i));
    out.sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
  }
  return out;
}

const numberOf = (text: string | null | undefined) => {
  const n = Number(text);
  return text !== null && text !== undefined && text.trim() !== '' && Number.isFinite(n) ? n : null;
};

/** The authority id of a `<spatialrefsys>` under `el` (`EPSG:3857`), or null. */
function authid(el: XmlElement | undefined): string | null {
  const id = textOf(path(el, 'spatialrefsys', 'authid'));
  return id || null;
}

/** Reads a `.qgs` document as the viewer's project. Throws with a message for the status line when it is not one. */
export function readQgs(text: string, id: string = crypto.randomUUID()): QgisImport {
  const root = parseXml(text, MAX_QGIS);
  if (root.name !== 'qgis') throw new Error('QGIS のプロジェクトファイルではありません');
  const maplayers = new Map<string, XmlElement>();
  for (const m of kids(kid(root, 'projectlayers'), 'maplayer')) maplayers.set(textOf(kid(m, 'id')), m);
  let order = treeOrder(root);
  // Old projects without a layer tree: the layers as listed.
  if (!order.length) order = [...maplayers.keys()].map((k) => ({ id: k, name: null, visible: true }));

  const unsupported: string[] = [];
  const notes: string[] = [];
  const fileSets: FileSetRef[] = [];
  const setOf = new Map<string, number>();
  const layers: ProjectLayer[] = [];
  for (const entry of order) {
    const m = maplayers.get(entry.id);
    if (!m) continue;
    const name = entry.name || textOf(kid(m, 'layername')) || entry.id;
    const type = attr(m, 'type') ?? 'vector';
    const provider = textOf(kid(m, 'provider'));
    const origin = originOf(provider, textOf(kid(m, 'datasource')), type);
    if (origin.kind === 'none') {
      unsupported.push(`${name}（${origin.why}）`);
      continue;
    }
    const styleNotes = new StyleNotes();
    if (origin.kind !== 'url' && 'note' in origin && origin.note) styleNotes.add(origin.note);
    const raster = type === 'raster';
    const renderer = path(m, 'pipe', 'rasterrenderer');
    const opacity = raster ? (numberOf(attr(renderer, 'opacity')) ?? 1) : (numberOf(textOf(kid(m, 'layerOpacity'))) ?? 1);
    let source: ProjectLayer['source'];
    let layerType: ProjectLayer['type'] = 'service';
    let pick: string | undefined;
    if (origin.kind === 'service') {
      // XYZ tiles have no name of their own: QGIS's goes with the URL.
      const ref = origin.ref.kind === 'xyz' ? { ...origin.ref, url: (({ template, zmin, zmax }) => xyzUrl(template, name, zmin, zmax))(splitXyz(origin.ref.url)) } : origin.ref;
      source = { kind: 'service', ref };
    }
    else if (origin.kind === 'url') {
      source = { kind: 'url', url: origin.url };
      layerType = 'image';
    } else {
      let set = setOf.get(origin.key);
      if (set === undefined) {
        set = fileSets.length;
        setOf.set(origin.key, set);
        const files: FileRef[] = origin.files.map((f) => ({ name: f, size: -1, lastModified: 0 }));
        fileSets.push({ files, ...(origin.url ? { url: origin.url } : {}) });
      }
      source = { kind: 'files', set };
      layerType = raster ? 'image' : 'service';
      pick = origin.pick;
    }
    const layer: ProjectLayer = { type: layerType, name, source, visible: entry.visible, opacity: Math.max(0, Math.min(1, opacity)) };
    if (pick !== undefined) layer.pick = pick;
    if (!raster && kid(m, 'renderer-v2')) {
      layer.style = readQgisLayerStyle(m, singleSpec('#4363d8'), styleNotes);
    } else if (raster && renderer && layerType === 'image') {
      const style = readRasterRenderer(renderer, styleNotes);
      if (style.bands) layer.bands = style.bands;
      if (style.colorScale) layer.colorScale = style.colorScale;
    }
    if (raster && attr(m, 'hasScaleBasedVisibilityFlag') === '1') styleNotes.add('縮尺による表示の切り替え');
    if (textOf(kid(m, 'blendMode')) && textOf(kid(m, 'blendMode')) !== '0') styleNotes.add('重ね方（ブレンド）');
    for (const note of styleNotes.list()) notes.push(`${name}: ${note}`);
    layers.push(layer);
  }
  for (const [key, m] of maplayers) if (!order.some((o) => o.id === key)) unsupported.push(`${textOf(kid(m, 'layername')) || key}（レイヤーツリーにありません）`);

  // The map canvas's extent (the first canvas: the main one).
  const canvas = kids(root, 'mapcanvas').find((c) => attr(c, 'name') === 'theMapCanvas') ?? kid(root, 'mapcanvas');
  const box = kid(canvas, 'extent');
  const values = ['xmin', 'ymin', 'xmax', 'ymax'].map((k) => numberOf(textOf(kid(box, k))));
  const crs = authid(kid(canvas, 'destinationsrs')) ?? authid(kid(root, 'projectCrs'));
  let extent: QgisImport['extent'] = null;
  if (values.every((v): v is number => v !== null) && values[2] > values[0] && values[3] > values[1]) {
    if (crs && /^(EPSG|ESRI|IGNF):\d+$/i.test(crs)) extent = { crs: crs.toUpperCase(), extent: values as [number, number, number, number] };
    else notes.push(`表示範囲: 座標系「${crs ?? '不明'}」が分からないため使いません`);
  }
  if (numberOf(textOf(kid(canvas, 'rotation')))) notes.push('表示範囲: 地図の回転');

  return {
    project: {
      format: PROJECT_FORMAT,
      version: 1,
      id,
      saved: new Date().toISOString(),
      baseMap: 'none',
      view: null,
      fileSets,
      layers,
      selected: layers.length ? 0 : null,
    },
    extent,
    unsupported,
    notes,
  };
}

// ---------------------------------------------------------------- writing

/** What a `.qgs` is written of besides the project. */
export interface QgsWriteOptions {
  /** The kind of geometry of each project layer, for vector styles (null: not a vector layer, or a mixture). */
  kinds: Array<SymbolKind | null>;
  /** The extent shown, in `EPSG:3857`. */
  extent: [number, number, number, number] | null;
  title: string;
}

const MERCATOR = `<spatialrefsys nativeFormat="Wkt"><proj4>+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs</proj4><srsid>3857</srsid><srid>3857</srid><authid>EPSG:3857</authid><description>WGS 84 / Pseudo-Mercator</description><projectionacronym>merc</projectionacronym><ellipsoidacronym>EPSG:7030</ellipsoidacronym><geographicflag>false</geographicflag></spatialrefsys>`;
const WGS84 = `<spatialrefsys nativeFormat="Wkt"><proj4>+proj=longlat +datum=WGS84 +no_defs</proj4><srsid>3452</srsid><srid>4326</srid><authid>EPSG:4326</authid><description>WGS 84</description><projectionacronym>longlat</projectionacronym><ellipsoidacronym>EPSG:7030</ellipsoidacronym><geographicflag>true</geographicflag></spatialrefsys>`;

const enc = (v: string) => encodeURIComponent(v);

/** A layer's provider, data source and kind in QGIS, or null when QGIS cannot open it from the project. */
function qgisSource(layer: ProjectLayer, project: Project): { provider: string; source: string; type: 'raster' | 'vector'; srs: string } | null {
  const s = layer.source;
  if (s.kind === 'url') return { provider: 'gdal', source: `/vsicurl/${s.url}`, type: 'raster', srs: '' };
  if (s.kind === 'files') {
    const set = project.fileSets[s.set];
    const names = set?.files.map((f) => f.name) ?? [];
    const main = names.find((n) => /\.shp$/i.test(n)) ?? names.find((n) => !/\.(shx|dbf|prj|cpg|qml|aux\.xml|ovr|rpb|tfw|xml)$/i.test(n)) ?? names[0];
    if (!main) return null;
    if (set.url) return layer.type === 'image' ? { provider: 'gdal', source: `/vsicurl/${set.url}`, type: 'raster', srs: '' } : { provider: 'ogr', source: `/vsicurl/${set.url}`, type: 'vector', srs: '' };
    return layer.type === 'image' ? { provider: 'gdal', source: `./${main}`, type: 'raster', srs: '' } : { provider: 'ogr', source: `./${main}`, type: 'vector', srs: '' };
  }
  if (s.kind !== 'service') return null;
  const ref = s.ref;
  switch (ref.kind) {
    case 'wms':
      return { provider: 'wms', source: `contextualWMSLegend=0&crs=EPSG:3857&dpiMode=7&featureCount=10&format=image/png&layers=${enc(ref.layer)}&styles&url=${enc(ref.url)}`, type: 'raster', srs: MERCATOR };
    case 'wmts': {
      const caps = /\.xml($|\?)/i.test(ref.url) ? ref.url : `${ref.url}${ref.url.includes('?') ? '&' : '?'}SERVICE=WMTS&REQUEST=GetCapabilities`;
      return { provider: 'wms', source: `contextualWMSLegend=0&crs=EPSG:3857&dpiMode=7&featureCount=10&format=${enc(ref.format ?? 'image/png')}&layers=${enc(ref.layer)}&styles=default&tileMatrixSet=${enc(ref.matrixSet ?? '')}&url=${enc(caps)}`, type: 'raster', srs: MERCATOR };
    }
    case 'xyz': {
      const { template, zmin, zmax } = splitXyz(ref.url);
      return { provider: 'wms', source: `type=xyz&url=${enc(template)}&zmax=${zmax}&zmin=${zmin}`, type: 'raster', srs: MERCATOR };
    }
    case 'wfs':
      return { provider: 'WFS', source: `pagingEnabled='true' preferCoordinatesForWfsT11='false' restrictToRequestBBOX='1' srsname='EPSG:4326' typename='${ref.layer.replace(/'/g, "\\'")}' url='${ref.url.replace(/'/g, "\\'")}' version='auto'`, type: 'vector', srs: WGS84 };
    case 'esri':
      if (ref.layer === 'map' || ref.layer === 'image') return { provider: 'arcgismapserver', source: `crs='EPSG:3857' format='PNG32' layer='' url='${ref.url}'`, type: 'raster', srs: MERCATOR };
      return { provider: 'arcgisfeatureserver', source: `crs='EPSG:3857' filter='' url='${ref.url}/${ref.layer}' table="" sql=`, type: 'vector', srs: MERCATOR };
    default:
      return null;
  }
}

const geometryName: Record<SymbolKind, string> = { point: 'Point', line: 'Line', polygon: 'Polygon' };

/** The `.qgs` of a project; `left` gets the names of the layers QGIS could not open from it. */
export function writeQgs(project: Project, options: QgsWriteOptions, left: string[] = []): string {
  const tree: string[] = [];
  const maplayers: string[] = [];
  project.layers.forEach((layer, i) => {
    const q = qgisSource(layer, project);
    if (!q) {
      left.push(layer.name);
      return;
    }
    const id = `layer_${i}_${layer.name.replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 40)}`;
    const source = esc(q.source);
    tree.push(`<layer-tree-layer id="${esc(id)}" name="${esc(layer.name)}" checked="${layer.visible ? 'Qt::Checked' : 'Qt::Unchecked'}" expanded="0" providerKey="${q.provider}" source="${source}"><customproperties/></layer-tree-layer>`);
    const kind = options.kinds[i];
    const style: VectorStyleSpec | undefined = layer.style;
    let body: string;
    let attrs = '';
    if (q.type === 'vector' && style && kind) {
      const scaled = style.minScale || style.maxScale;
      attrs = ` geometry="${geometryName[kind]}" hasScaleBasedVisibilityFlag="${scaled ? 1 : 0}" minScale="${style.minScale ?? 0}" maxScale="${style.maxScale ?? 0}" labelsEnabled="${style.label.field ? 1 : 0}"`;
      body = `${rendererXml(style, kind)}${labelingXml(style, kind)}<layerOpacity>${layer.opacity}</layerOpacity>`;
    } else if (q.type === 'vector') {
      body = `<layerOpacity>${layer.opacity}</layerOpacity>`;
    } else {
      body = `<pipe><rasterrenderer type="${layer.bands ? 'multibandcolor' : 'singlebandcolordata'}" opacity="${layer.opacity}" alphaBand="-1"${layer.bands ? ` redBand="${layer.bands[0] + 1}" greenBand="${layer.bands[1] + 1}" blueBand="${layer.bands[2] + 1}"` : ' band="1"'}/></pipe>`;
    }
    maplayers.push(`<maplayer type="${q.type}"${attrs} autoRefreshEnabled="0" refreshOnNotifyEnabled="0" styleCategories="AllStyleCategories"><id>${esc(id)}</id><datasource>${source}</datasource><layername>${esc(layer.name)}</layername>${q.srs ? `<srs>${q.srs}</srs>` : ''}<provider encoding="UTF-8">${q.provider}</provider>${body}</maplayer>`);
  });
  const e = options.extent;
  const extent = e ? `<extent><xmin>${e[0]}</xmin><ymin>${e[1]}</ymin><xmax>${e[2]}</xmax><ymax>${e[3]}</ymax></extent>` : '';
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis projectname="${esc(options.title)}" version="3.34.0-Prizren" saveUser="" saveDateTime="${project.saved}">
  <homePath path=""/>
  <title>${esc(options.title)}</title>
  <projectCrs>${MERCATOR}</projectCrs>
  <layer-tree-group>
    <customproperties/>
    ${tree.join('\n    ')}
  </layer-tree-group>
  <mapcanvas name="theMapCanvas" annotationsVisible="1">
    <units>meters</units>
    ${extent}
    <rotation>0</rotation>
    <destinationsrs>${MERCATOR}</destinationsrs>
    <rendermaptile>0</rendermaptile>
  </mapcanvas>
  <projectlayers>
    ${maplayers.join('\n    ')}
  </projectlayers>
  <properties><Paths><Absolute type="bool">false</Absolute></Paths></properties>
</qgis>
`;
}
