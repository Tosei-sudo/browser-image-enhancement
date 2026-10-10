/**
 * Site settings read at start from `config.json` next to `index.html`, so the
 * base maps, the projection registry and other environment-dependent values
 * can be changed on the server without rebuilding. A missing or broken file,
 * or a missing or invalid entry, falls back to the built-in default for that
 * entry, so the site always starts.
 */
import { Pipeline, presets, type PresetName } from 'browser-image-enhancement';
import { catalogOf, type CatalogConfig } from './catalog.js';
import { satelliteCatalogOf, type SatelliteCatalogConfig } from './imaging-plan.js';
import { pathMappingOf, type PathMapping } from './local-paths.js';

/**
 * What a base map URL points to:
 * - `xyz`: raster tiles, a URL with `{z}`, `{x}`, `{y}` (or `{-y}`);
 * - `mvt`: vector tiles (Mapbox Vector Tile / `.pbf`), a URL with `{z}`, `{x}`, `{y}`, drawn in a plain built-in style;
 * - `style`: a Mapbox / MapLibre style JSON (its vector tiles drawn as the style says);
 * - `esri`: an ArcGIS `VectorTileServer` (ArcGIS Online, Enterprise or Data Appliance), drawn in its default style.
 */
export type BaseMapType = 'xyz' | 'mvt' | 'style' | 'esri';

/** One base map. */
export interface BaseMapConfig {
  /** Key used in `?base=` links. */
  id: string;
  /** Name in the base map switch. */
  label: string;
  /** Read from the URL when `config.json` does not say (see {@link baseMapType}). */
  type: BaseMapType;
  url: string;
  /** Attribution HTML shown on the map. */
  attributions: string;
  /** The deepest zoom level with tiles (`xyz` and `mvt`); deeper views enlarge those. */
  maxZoom: number;
  /** For `esri`: another style for the server, such as one saved with ArcGIS Vector Tile Style Editor. */
  style?: string;
  /** For `esri`: an ArcGIS token added to every request to the server. */
  token?: string;
}

/**
 * The kind of base map a URL points to: an ArcGIS `VectorTileServer`, tiles
 * by `{z}/{x}/{y}` (vector when the file is `.pbf` or `.mvt`), or else a style JSON.
 */
export function baseMapType(url: string): BaseMapType {
  const path = url.split(/[?#]/, 1)[0];
  if (/\/VectorTileServer\/?$/i.test(path)) return 'esri';
  if (path.includes('{z}')) return /\.(pbf|mvt)$/i.test(path) ? 'mvt' : 'xyz';
  return 'style';
}

const baseMapTypes: readonly BaseMapType[] = ['xyz', 'mvt', 'style', 'esri'];

/**
 * A layer opened at start: a COG by URL, a layer of a service (as in
 * `?service=` links), or a file by URL (GeoJSON, a zipped Shapefile, a
 * picture or GeoTIFF), read like a local file.
 */
export type LayerConfig =
  | { type: 'cog'; url: string }
  | { type: 'file'; url: string }
  | { type: 'wms' | 'wmts' | 'wfs' | 'esri'; url: string; layer: string; matrixSet?: string; format?: string };

export interface ViewerConfig {
  /** Base maps in the order of the switch (after "none"). */
  baseMaps: BaseMapConfig[];
  /** The base map shown when the link has no `?base=`; '' for none. */
  defaultBaseMap: string;
  /**
   * Where definitions of unregistered projections come from: a URL with
   * `{authority}` (lower case, such as `epsg`) and `{code}` (such as `6677`)
   * that answers with OGC WKT or a proj4 string. '' turns lookups off, so
   * only built-in and `projections` codes work.
   */
  projectionLookup: string;
  /** Extra projection definitions registered at start, without a lookup: `{ "EPSG:6677": "+proj=tmerc …" }`. */
  projections: Record<string, string>;
  /** Layers opened at start, bottom first. */
  layers: LayerConfig[];
  /** Defaults for images by file name; the first rule that matches applies. */
  imageRules: ImageRule[];
  /** Esri feature layers of images to search and open (catalog.ts); none hides the 「画像カタログ」 button. */
  imageCatalogs: CatalogConfig[];
  /** What local path prefixes in catalogs stand for: a URL, or a folder allowed in the browser (local-paths.ts). */
  pathMappings: PathMapping[];
  /** Esri layers (or tables) of satellites with their TLEs and specifications, for the 「撮像計画」 panel (imaging-plan.ts). */
  satelliteCatalogs: SatelliteCatalogConfig[];
}

/**
 * What an image whose file name matches starts with when it opens: a
 * correction and the bands shown. Changes made in the panel afterwards (and a
 * project file's saved settings) take over as usual.
 */
export interface ImageRule {
  /** Shown in the status line when the rule is applied; the pattern when `config.json` gives no `label`. */
  label: string;
  /** Tested against the file name (for a URL, the last part of its path). */
  match: RegExp;
  /** The correction to start with, from `preset` and `enhance`; null leaves the correction as it is. */
  pipeline: Pipeline | null;
  /** The bands shown as R, G and B, or one band in gray: 1-based numbers, or band names (GDAL's DESCRIPTION, e.g. "NIR"). */
  bands: Array<number | string> | null;
}

const gsi = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const osm = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

/** The settings used when `config.json` does not give them. */
export const defaultConfig: ViewerConfig = {
  baseMaps: [
    { id: 'gsi-std', label: '地理院 標準', type: 'xyz', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
    { id: 'gsi-pale', label: '地理院 淡色', type: 'xyz', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
    { id: 'gsi-photo', label: '地理院 写真', type: 'xyz', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', attributions: gsi, maxZoom: 18 },
    { id: 'gsi-vector', label: '地理院 ベクトル', type: 'style', url: 'https://gsi-cyberjapan.github.io/optimal_bvmap/style/std.json', attributions: gsi, maxZoom: 16 },
    {
      id: 'osm',
      label: 'OpenStreetMap',
      type: 'xyz',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attributions: osm,
      maxZoom: 19,
    },
    {
      id: 'esri-osm',
      label: 'OpenStreetMap（Esri ベクトル）',
      type: 'esri',
      url: 'https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer',
      attributions: `Esri, ${osm}`,
      maxZoom: 22,
    },
  ],
  defaultBaseMap: '',
  projectionLookup: 'https://spatialreference.org/ref/{authority}/{code}/ogcwkt/',
  projections: {},
  layers: [],
  imageRules: [],
  imageCatalogs: [],
  pathMappings: [],
  satelliteCatalogs: [],
};

/** An absolute http(s) URL or one relative to the page (`./`, `../`, `/`). */
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function baseMapOf(value: unknown, problems: string[], index: number): BaseMapConfig | null {
  if (!isRecord(value)) return (problems.push(`baseMaps[${index}] がオブジェクトではありません`), null);
  const { id, label, type, url, attributions, maxZoom, style, token } = value;
  if (typeof id !== 'string' || !id || !isUrl(url)) {
    problems.push(`baseMaps[${index}] に id か url（http(s) か相対パス）がありません`);
    return null;
  }
  if (type !== undefined && !baseMapTypes.includes(type as BaseMapType)) {
    problems.push(`baseMaps[${index}] の type「${String(type)}」は xyz・mvt・style・esri のどれかにしてください`);
    return null;
  }
  const kind = (type as BaseMapType | undefined) ?? baseMapType(url);
  if (style !== undefined && !isUrl(style)) problems.push(`baseMaps[${index}] の style は http(s) か相対パスの URL にしてください`);
  return {
    id,
    label: typeof label === 'string' && label ? label : id,
    type: kind,
    url,
    attributions: typeof attributions === 'string' ? attributions : '',
    // Vector tiles usually stop at zoom 14 and are enlarged beyond it.
    maxZoom: typeof maxZoom === 'number' && Number.isInteger(maxZoom) && maxZoom >= 0 && maxZoom <= 30 ? maxZoom : kind === 'mvt' ? 14 : 18,
    ...(kind === 'esri' && isUrl(style) ? { style } : {}),
    ...(kind === 'esri' && typeof token === 'string' && token ? { token } : {}),
  };
}

/**
 * The settings in a parsed `config.json`, each entry checked on its own: what
 * is missing or invalid takes the default, and `problems` says what was ignored.
 */
export function parseConfig(json: unknown): { config: ViewerConfig; problems: string[] } {
  const problems: string[] = [];
  const config: ViewerConfig = { ...defaultConfig, projections: { ...defaultConfig.projections }, layers: [...defaultConfig.layers], imageRules: [...defaultConfig.imageRules], imageCatalogs: [...defaultConfig.imageCatalogs], pathMappings: [...defaultConfig.pathMappings], satelliteCatalogs: [...defaultConfig.satelliteCatalogs] };
  if (!isRecord(json)) return { config, problems: ['設定がオブジェクトではありません'] };

  if ('baseMaps' in json) {
    if (Array.isArray(json.baseMaps)) {
      const seen = new Set<string>();
      config.baseMaps = json.baseMaps
        .map((b, i) => baseMapOf(b, problems, i))
        .filter((b): b is BaseMapConfig => {
          if (!b) return false;
          if (seen.has(b.id)) return (problems.push(`baseMaps の id「${b.id}」が重複しています`), false);
          seen.add(b.id);
          return true;
        });
    } else problems.push('baseMaps が配列ではありません');
  }

  if ('defaultBaseMap' in json) {
    const key = json.defaultBaseMap;
    if (key === '' || key === null) config.defaultBaseMap = '';
    else if (typeof key === 'string' && config.baseMaps.some((b) => b.id === key)) config.defaultBaseMap = key;
    else problems.push(`defaultBaseMap「${String(key)}」は baseMaps にありません`);
  }

  if ('projectionLookup' in json) {
    const url = json.projectionLookup;
    if (url === '' || url === null) config.projectionLookup = '';
    else if (typeof url === 'string' && url.includes('{code}')) config.projectionLookup = url;
    else problems.push('projectionLookup は {code} を含む URL にしてください');
  }

  if ('projections' in json) {
    if (isRecord(json.projections)) {
      for (const [code, def] of Object.entries(json.projections)) {
        if (/^[A-Za-z]+:\S+$/.test(code) && typeof def === 'string' && def.trim()) config.projections[code.toUpperCase()] = def;
        else problems.push(`projections の「${code}」は無視しました`);
      }
    } else problems.push('projections がオブジェクトではありません');
  }

  if ('layers' in json) {
    if (Array.isArray(json.layers)) config.layers = json.layers.map((l, i) => layerOf(l, problems, i)).filter((l): l is LayerConfig => l !== null);
    else problems.push('layers が配列ではありません');
  }

  if ('imageRules' in json) {
    if (Array.isArray(json.imageRules)) config.imageRules = json.imageRules.map((r, i) => imageRuleOf(r, problems, i)).filter((r): r is ImageRule => r !== null);
    else problems.push('imageRules が配列ではありません');
  }

  if ('imageCatalogs' in json) {
    if (Array.isArray(json.imageCatalogs)) config.imageCatalogs = json.imageCatalogs.map((c, i) => catalogOf(c, problems, i)).filter((c): c is CatalogConfig => c !== null);
    else problems.push('imageCatalogs が配列ではありません');
  }

  if ('pathMappings' in json) {
    if (Array.isArray(json.pathMappings)) config.pathMappings = json.pathMappings.map((m, i) => pathMappingOf(m, problems, i)).filter((m): m is PathMapping => m !== null);
    else problems.push('pathMappings が配列ではありません');
  }

  if ('satelliteCatalogs' in json) {
    if (Array.isArray(json.satelliteCatalogs)) {
      config.satelliteCatalogs = json.satelliteCatalogs.map((c, i) => satelliteCatalogOf(c, problems, i)).filter((c): c is SatelliteCatalogConfig => c !== null);
    } else problems.push('satelliteCatalogs が配列ではありません');
  }

  return { config, problems };
}

const isPreset = (name: unknown): name is PresetName => typeof name === 'string' && Object.hasOwn(presets, name);

function imageRuleOf(value: unknown, problems: string[], index: number): ImageRule | null {
  const at = `imageRules[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { match, caseSensitive, label, preset, enhance, bands } = value;
  if (typeof match !== 'string' || !match) return (problems.push(`${at} に match（ファイル名の正規表現）がありません`), null);
  let pattern: RegExp;
  try {
    // File names on Windows and most servers ignore case, so the patterns do too unless told.
    pattern = new RegExp(match, caseSensitive === true ? '' : 'i');
  } catch (error) {
    return (problems.push(`${at} の match は正規表現として読めません（${error instanceof Error ? error.message : String(error)}）`), null);
  }

  let pipeline: Pipeline | null = null;
  if (preset !== undefined) {
    if (isPreset(preset)) pipeline = presets[preset];
    else problems.push(`${at} の preset「${String(preset)}」は ${Object.keys(presets).join('・')} のどれかにしてください`);
  }
  if (enhance !== undefined) pipeline = enhanceOf(enhance, pipeline, problems, at);

  let shown: Array<number | string> | null = null;
  if (bands !== undefined) {
    const list = Array.isArray(bands) ? bands : [bands];
    const valid = (b: unknown) => (typeof b === 'number' && Number.isInteger(b) && b >= 1) || (typeof b === 'string' && b.trim() !== '');
    if ((list.length === 1 || list.length === 3) && list.every(valid)) shown = list as Array<number | string>;
    else problems.push(`${at} の bands は [赤, 緑, 青] か 1 つのバンド（1 から数えた番号かバンド名）にしてください`);
  }

  if (!pipeline && !shown) return (problems.push(`${at} は補正（preset・enhance）もバンド（bands）も指定していないので無視しました`), null);
  return { label: typeof label === 'string' && label ? label : match, match: pattern, pipeline, bands: shown };
}

/**
 * The correction `enhance` gives: a saved pipeline (`{ "version": 1, "ops": [...] }`,
 * as in a project file) or its steps alone used as they are, or values by
 * step (`{ "contrast": 0.2, "autoStretch": { "lowPercent": 1 } }`) set on top of `base`.
 */
function enhanceOf(enhance: unknown, base: Pipeline | null, problems: string[], at: string): Pipeline | null {
  if (Array.isArray(enhance) || (isRecord(enhance) && 'ops' in enhance)) {
    try {
      return Pipeline.fromJSON(Array.isArray(enhance) ? { version: 1, ops: enhance } : (enhance as never));
    } catch (error) {
      problems.push(`${at} の enhance は補正として読めません（${error instanceof Error ? error.message : String(error)}）`);
      return base;
    }
  }
  if (!isRecord(enhance)) return (problems.push(`${at} の enhance がオブジェクトではありません`), base);
  let pipeline = base ?? new Pipeline();
  for (const [op, params] of Object.entries(enhance)) {
    if (typeof params !== 'number' && !isRecord(params)) {
      problems.push(`${at} の enhance の「${op}」は数値か、パラメーターのオブジェクトにしてください`);
      continue;
    }
    try {
      pipeline = pipeline.set(op as never, params as never);
    } catch (error) {
      problems.push(`${at} の enhance の「${op}」は無視しました（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  return pipeline;
}

/** The first rule whose pattern matches the file name `name` (the last part of a URL's path). */
export function imageRuleFor(rules: readonly ImageRule[], name: string): ImageRule | undefined {
  return rules.find((rule) => rule.match.test(name));
}

function layerOf(value: unknown, problems: string[], index: number): LayerConfig | null {
  if (!isRecord(value)) return (problems.push(`layers[${index}] がオブジェクトではありません`), null);
  const { type, url, layer, matrixSet, format } = value;
  if (!isUrl(url)) return (problems.push(`layers[${index}] に url（http(s) か相対パス）がありません`), null);
  if (type === 'cog' || type === 'file') return { type, url };
  if (type === 'wms' || type === 'wmts' || type === 'wfs' || type === 'esri') {
    if (typeof layer !== 'string' || !layer) return (problems.push(`layers[${index}] に layer（レイヤー名）がありません`), null);
    return {
      type,
      url,
      layer,
      ...(typeof matrixSet === 'string' && matrixSet ? { matrixSet } : {}),
      ...(typeof format === 'string' && format ? { format } : {}),
    };
  }
  problems.push(`layers[${index}] の type「${String(type)}」は cog・file・wms・wmts・wfs・esri のどれかにしてください`);
  return null;
}

/** The lookup URL for a projection code such as `EPSG:6677`. */
export function lookupUrl(template: string, code: string): string {
  const [authority, number] = code.split(':', 2);
  return template.replaceAll('{authority}', encodeURIComponent(authority.toLowerCase())).replaceAll('{code}', encodeURIComponent(number));
}

/**
 * Fetches and reads `config.json` (relative to the page); the defaults when it
 * is missing, unreadable or not JSON. Problems are logged to the console.
 */
export async function loadConfig(url = new URL('config.json', document.baseURI).href): Promise<ViewerConfig> {
  let json: unknown;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 404) return defaultConfig;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    json = await response.json();
  } catch (error) {
    console.warn(`config.json を読めなかったので既定の設定を使います: ${error instanceof Error ? error.message : String(error)}`);
    return defaultConfig;
  }
  const { config, problems } = parseConfig(json);
  for (const problem of problems) console.warn(`config.json: ${problem}`);
  return config;
}

/** A file by URL, named after the last part of its path, to open like a local file. */
export async function fetchFile(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const path = new URL(url, document.baseURI).pathname;
  let name = path.slice(path.lastIndexOf('/') + 1) || 'layer';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep it encoded
  }
  return new File([await response.blob()], name);
}
