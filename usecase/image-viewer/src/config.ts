/**
 * Site settings read at start from `config.json` next to `index.html`, so the
 * base maps, the projection registry and other environment-dependent values
 * can be changed on the server without rebuilding. A missing or broken file,
 * or a missing or invalid entry, falls back to the built-in default for that
 * entry, so the site always starts.
 */
import { Pipeline, presets, type PresetName } from 'browser-image-enhancement';
import { catalogOf, type CatalogConfig } from './catalog.js';
import { groundStationsOf, satelliteCatalogOf, type GroundStation, type SatelliteCatalogConfig } from './imaging-plan.js';
import { cloudForecastOf, defaultCloudForecast, type CloudForecastConfig } from './imaging-plan-weather.js';
import { aiModelOf, COCO_CLASSES, type AiModelConfig } from './ai/model-config.js';
import { detectionOutputOf, type DetectionOutput } from './ai/transfer.js';
import { pathMappingOf, type PathMapping } from './local-paths.js';
import { serviceRulesOf, settingsOf, type EsriRasterSettings, type ServiceRule } from './services/esri-rules.js';
import { movingFeedOf, type FeedConfig } from './moving.js';
import { DEFAULT_GEOCODERS, type GeocoderConfig, type GeocoderType } from './geocode.js';
import { defaultEmbed, embedConfigOf, type EmbedConfig } from './embed-protocol.js';
import { arcgisPortalOf, authFetch, authRuleOf, type ArcgisPortalConfig, type AuthRule } from './auth.js';
import { DEFAULT_STAC_CATALOGS, stacCatalogOf, type StacCatalogConfig } from './stac.js';

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
  | {
      type: ServiceLayerType;
      url: string;
      layer: string;
      matrixSet?: string;
      format?: string;
      settings?: EsriRasterSettings;
      /** OGC API – Features, WCS, OGC API – Coverages: the area read (degrees: west, south, east, north). */
      bbox?: [number, number, number, number];
      /** OGC API – Features: the condition. */
      filter?: string;
    };

/** The service kinds a `layers` entry can be (as `ServiceKind` in services/common.ts). */
export type ServiceLayerType = 'wms' | 'wmts' | 'wfs' | 'esri' | 'ogc-features' | 'ogc-tiles' | 'wcs' | 'ogc-coverage' | 'xyz';
const serviceLayerTypes: readonly string[] = ['wms', 'wmts', 'wfs', 'esri', 'ogc-features', 'ogc-tiles', 'wcs', 'ogc-coverage'];

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
  /** How often, in minutes, the open viewer checks the image catalog watches for new images (catalog-watch.ts). */
  watchInterval: number;
  /** What local path prefixes in catalogs stand for: a URL, or a folder allowed in the browser (local-paths.ts). */
  pathMappings: PathMapping[];
  /** Esri layers (or tables) of satellites with their TLEs and specifications, for the 「撮像計画」 panel (imaging-plan.ts). */
  satelliteCatalogs: SatelliteCatalogConfig[];
  /** Where the imaging plan asks for cloud cover forecasts (imaging-plan-weather.ts); null hides the choice. Only asked once turned on in the panel. */
  cloudForecast: CloudForecastConfig | null;
  /** Ground stations, for when the imaging plan's shots can be sent down (imaging-plan.ts); none hides the column. */
  groundStations: GroundStation[];
  /** ONNX models for the AI tools (ai-tools.ts): object detection and click segmentation. Files can be chosen too. */
  aiModels: AiModelConfig[];
  /** Esri feature layers the AI tools' results are written to (ai-transfer.ts), attributes mapped by role; none hides 「DB へ転記」. */
  detectionOutputs: DetectionOutput[];
  /**
   * Named display rules of Esri image and map services (attribute conditions,
   * stacking order, raster function, layers shown), for the services whose URL
   * matches; one marked `default` applies when a layer opens.
   */
  serviceRules: ServiceRule[];
  /** ArcGIS elevation services (image services of heights, elevation tile services) used as elevation data from the start. */
  elevationServices: ElevationServiceConfig[];
  /** Where the jump field looks up place names and addresses (geocode.ts); [] reads coordinates only. */
  geocoders: GeocoderConfig[];
  /** Pages (exact origins) allowed to show the viewer in an iframe and drive it by postMessage (embed.ts); none turns it off. */
  embed: EmbedConfig;
  /** ArcGIS Online / Enterprise portals to sign in to (OAuth 2.0 with PKCE, auth.ts); none hides 「サインイン」. */
  arcgisPortals: ArcgisPortalConfig[];
  /** Headers or query parameters added to requests to URLs that start with a prefix (auth.ts). */
  authRules: AuthRule[];
  /** Feeds of ships and aircraft listed in 「移動体（AIS・ADS-B）」 (moving.ts). */
  movingFeeds: FeedConfig[];
  /** STAC APIs (or static catalogs) for the 「STAC 検索」 panel (stac.ts); [] hides it, so nothing leaves the page. */
  stacCatalogs: StacCatalogConfig[];
  /** Server-side processing services (ArcGIS GPServer, OGC API – Processes) offered in 「サーバ処理」. */
  gpServices: GpServiceConfig[];
}

/** A processing service of config.json: its name in the list, its URL, and a token when it needs one. */
export interface GpServiceConfig {
  label: string;
  url: string;
  token?: string;
}

/** An elevation service of config.json: its URL, and a token when it needs one. */
export interface ElevationServiceConfig {
  url: string;
  token?: string;
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
  /** Which pixels are transparent (see nodata-dialog.ts); null leaves the default. */
  noData?: { auto?: boolean; values: number[] } | null;
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
  watchInterval: 10,
  pathMappings: [],
  satelliteCatalogs: [],
  cloudForecast: defaultCloudForecast,
  groundStations: [],
  aiModels: sampleModels(),
  detectionOutputs: [],
  serviceRules: [],
  elevationServices: [],
  geocoders: [...DEFAULT_GEOCODERS],
  embed: defaultEmbed,
  arcgisPortals: [],
  authRules: [],
  movingFeeds: [],
  stacCatalogs: [...DEFAULT_STAC_CATALOGS],
  gpServices: [],
};

/**
 * The AI models that ship with the viewer (`models/`, so they work in a
 * closed network too), used while `config.json` has no `aiModels` of its own.
 * YOLOX-Tiny and MobileSAM are Apache-2.0, YOLO11s-OBB is AGPL-3.0 (see
 * `public/models/README.md`).
 */
function sampleModels(): AiModelConfig[] {
  return [
    // Trained on DOTA (aerial and satellite pictures); its classes, input size and task come from its metadata.
    { kind: 'detect', label: 'YOLO11s-OBB（衛星・航空写真・DOTA 15 クラス）', url: './models/yolo11s-obb.onnx' },
    { kind: 'detect', label: 'YOLOX-Tiny（サンプル・COCO 80 クラス）', url: './models/yolox_tiny.onnx', format: 'yolox', inputSize: [416, 416], classes: [...COCO_CLASSES], score: 0.3 },
    { kind: 'sam', label: 'MobileSAM（サンプル）', encoder: './models/mobile_sam_encoder.onnx', decoder: './models/mobile_sam_decoder.onnx' },
  ];
}

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

const geocoderTypes: readonly GeocoderType[] = ['gsi', 'nominatim', 'arcgis', 'features', 'csv'];

function geocoderOf(value: unknown, problems: string[], index: number): GeocoderConfig | null {
  if (!isRecord(value)) return (problems.push(`geocoders[${index}] がオブジェクトではありません`), null);
  const { type, url, label, token, field } = value;
  if (!geocoderTypes.includes(type as GeocoderType)) return (problems.push(`geocoders[${index}] の type は ${geocoderTypes.join('・')} のどれかにしてください`), null);
  if (!isUrl(url)) return (problems.push(`geocoders[${index}] に url（http(s) か相対パス）がありません`), null);
  if (type === 'features' && (typeof field !== 'string' || !field)) return (problems.push(`geocoders[${index}] の features には名前の属性（field）が要ります`), null);
  return {
    type: type as GeocoderType,
    url,
    label: typeof label === 'string' && label ? label : String(type),
    ...(typeof token === 'string' && token ? { token } : {}),
    ...(typeof field === 'string' && field ? { field } : {}),
  };
}

/**
 * The settings in a parsed `config.json`, each entry checked on its own: what
 * is missing or invalid takes the default, and `problems` says what was ignored.
 */
export function parseConfig(json: unknown): { config: ViewerConfig; problems: string[] } {
  const problems: string[] = [];
  const config: ViewerConfig = { ...defaultConfig, projections: { ...defaultConfig.projections }, layers: [...defaultConfig.layers], imageRules: [...defaultConfig.imageRules], imageCatalogs: [...defaultConfig.imageCatalogs], pathMappings: [...defaultConfig.pathMappings], satelliteCatalogs: [...defaultConfig.satelliteCatalogs], groundStations: [], aiModels: [...defaultConfig.aiModels], detectionOutputs: [...defaultConfig.detectionOutputs], serviceRules: [...defaultConfig.serviceRules], elevationServices: [...defaultConfig.elevationServices], geocoders: [...defaultConfig.geocoders], arcgisPortals: [...defaultConfig.arcgisPortals], authRules: [...defaultConfig.authRules], movingFeeds: [...defaultConfig.movingFeeds], stacCatalogs: [...defaultConfig.stacCatalogs], gpServices: [] };
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
  if ('watchInterval' in json) {
    const { watchInterval } = json;
    if (typeof watchInterval === 'number' && watchInterval >= 1 && watchInterval <= 24 * 60) config.watchInterval = watchInterval;
    else problems.push('watchInterval は新着画像を確認する間隔（1〜1440 分）にしてください');
  }

  if ('pathMappings' in json) {
    if (Array.isArray(json.pathMappings)) config.pathMappings = json.pathMappings.map((m, i) => pathMappingOf(m, problems, i)).filter((m): m is PathMapping => m !== null);
    else problems.push('pathMappings が配列ではありません');
  }

  if ('serviceRules' in json) config.serviceRules = serviceRulesOf(json.serviceRules, problems);

  if ('elevationServices' in json) {
    if (Array.isArray(json.elevationServices)) {
      config.elevationServices = json.elevationServices.flatMap((e, i): ElevationServiceConfig[] => {
        // A URL alone will do.
        const entry = typeof e === 'string' ? { url: e } : e;
        if (!isRecord(entry) || typeof entry.url !== 'string' || !/^https?:\/\/.+\/ImageServer\/?$/i.test(entry.url.trim())) {
          problems.push(`elevationServices[${i}] の url は …/ImageServer の URL にしてください`);
          return [];
        }
        return [{ url: entry.url.trim(), ...(typeof entry.token === 'string' && entry.token ? { token: entry.token } : {}) }];
      });
    } else problems.push('elevationServices が配列ではありません');
  }

  if ('geocoders' in json) {
    if (Array.isArray(json.geocoders)) config.geocoders = json.geocoders.map((g, i) => geocoderOf(g, problems, i)).filter((g): g is GeocoderConfig => g !== null);
    else problems.push('geocoders が配列ではありません');
  }

  if ('satelliteCatalogs' in json) {
    if (Array.isArray(json.satelliteCatalogs)) {
      config.satelliteCatalogs = json.satelliteCatalogs.map((c, i) => satelliteCatalogOf(c, problems, i)).filter((c): c is SatelliteCatalogConfig => c !== null);
    } else problems.push('satelliteCatalogs が配列ではありません');
  }

  if ('cloudForecast' in json) config.cloudForecast = cloudForecastOf(json.cloudForecast, problems);
  if ('groundStations' in json) config.groundStations = groundStationsOf(json.groundStations, problems);

  if ('aiModels' in json) {
    if (Array.isArray(json.aiModels)) config.aiModels = json.aiModels.map((m, i) => aiModelOf(m, problems, i)).filter((m): m is AiModelConfig => m !== null);
    else problems.push('aiModels が配列ではありません');
  }

  if ('detectionOutputs' in json) {
    if (Array.isArray(json.detectionOutputs)) {
      config.detectionOutputs = json.detectionOutputs.map((o, i) => detectionOutputOf(o, problems, i)).filter((o): o is DetectionOutput => o !== null);
    } else problems.push('detectionOutputs が配列ではありません');
  }

  if ('embed' in json) config.embed = embedConfigOf(json.embed, problems);
  if ('arcgisPortals' in json) {
    if (Array.isArray(json.arcgisPortals)) {
      const seen = new Set<string>();
      config.arcgisPortals = json.arcgisPortals
        .map((p, i) => arcgisPortalOf(p, problems, i))
        .filter((p): p is ArcgisPortalConfig => {
          if (!p) return false;
          if (seen.has(p.url)) return (problems.push(`arcgisPortals の url「${p.url}」が重複しています`), false);
          seen.add(p.url);
          return true;
        });
    } else problems.push('arcgisPortals が配列ではありません');
  }

  if ('authRules' in json) {
    if (Array.isArray(json.authRules)) config.authRules = json.authRules.map((r, i) => authRuleOf(r, problems, i)).filter((r): r is AuthRule => r !== null);
    else problems.push('authRules が配列ではありません');
  }

  if ('movingFeeds' in json) {
    if (Array.isArray(json.movingFeeds)) config.movingFeeds = json.movingFeeds.map((f, i) => movingFeedOf(f, problems, i)).filter((f): f is FeedConfig => f !== null);
    else problems.push('movingFeeds が配列ではありません');
  }
  if ('stacCatalogs' in json) {
    if (Array.isArray(json.stacCatalogs)) config.stacCatalogs = json.stacCatalogs.map((c, i) => stacCatalogOf(c, problems, i)).filter((c): c is StacCatalogConfig => c !== null);
    else problems.push('stacCatalogs が配列ではありません');
  }
  if ('gpServices' in json) {
    if (Array.isArray(json.gpServices)) {
      config.gpServices = json.gpServices.flatMap((e, i): GpServiceConfig[] => {
        // A URL alone will do.
        const entry = typeof e === 'string' ? { url: e } : e;
        if (!isRecord(entry) || typeof entry.url !== 'string' || !/^https?:\/\/./i.test(entry.url.trim())) {
          problems.push(`gpServices[${i}] の url は http(s) の URL にしてください`);
          return [];
        }
        const url = entry.url.trim();
        const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : url;
        return [{ label, url, ...(typeof entry.token === 'string' && entry.token ? { token: entry.token } : {}) }];
      });
    } else problems.push('gpServices が配列ではありません');
  }

  return { config, problems };
}

const isPreset = (name: unknown): name is PresetName => typeof name === 'string' && Object.hasOwn(presets, name);

function imageRuleOf(value: unknown, problems: string[], index: number): ImageRule | null {
  const at = `imageRules[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { match, caseSensitive, label, preset, enhance, bands, noData } = value;
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

  // `noData`: values ([0], or one number), or { "auto": false, "values": [0] } to leave the file's own value out.
  let transparent: ImageRule['noData'] = null;
  if (noData !== undefined) {
    const read = (v: unknown) => (Array.isArray(v) ? v : [v]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    if (typeof noData === 'number' || Array.isArray(noData)) transparent = { values: read(noData) };
    else if (isRecord(noData) && (noData.auto === undefined || typeof noData.auto === 'boolean')) transparent = { ...(noData.auto === false ? { auto: false } : {}), values: noData.values === undefined ? [] : read(noData.values) };
    else problems.push(`${at} の noData は値（数値か数値の配列）か { "auto": false, "values": [0] } の形にしてください`);
  }

  if (!pipeline && !shown && !transparent) return (problems.push(`${at} は補正（preset・enhance）もバンド（bands）もノーデータ（noData）も指定していないので無視しました`), null);
  return { label: typeof label === 'string' && label ? label : match, match: pattern, pipeline, bands: shown, ...(transparent ? { noData: transparent } : {}) };
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
  const { type, url, layer, matrixSet, format, settings, bbox, filter } = value;
  if (!isUrl(url)) return (problems.push(`layers[${index}] に url（http(s) か相対パス）がありません`), null);
  if (type === 'cog' || type === 'file') return { type, url };
  // XYZ tiles: a {z}/{x}/{y} template, one layer.
  if (type === 'xyz') return { type, url, layer: 'tiles' };
  if (typeof type === 'string' && serviceLayerTypes.includes(type)) {
    const box =
      Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => typeof n === 'number' && Number.isFinite(n)) && bbox[0] <= bbox[2] && bbox[1] <= bbox[3]
        ? (bbox as [number, number, number, number])
        : undefined;
    if (bbox !== undefined && !box) problems.push(`layers[${index}].bbox は [西, 南, 東, 北]（度）の 4 つの数にしてください`);
    if (typeof layer !== 'string' || !layer) return (problems.push(`layers[${index}] に layer（レイヤー名）がありません`), null);
    return {
      type: type as ServiceLayerType,
      url,
      layer,
      ...(box ? { bbox: box } : {}),
      ...(typeof filter === 'string' && filter.trim() ? { filter: filter.trim() } : {}),
      ...(typeof matrixSet === 'string' && matrixSet ? { matrixSet } : {}),
      ...(typeof format === 'string' && format ? { format } : {}),
      ...(type === 'esri' && settings !== undefined ? { settings: settingsOf(settings, problems, `layers[${index}].settings`) } : {}),
    };
  }
  problems.push(`layers[${index}] の type「${String(type)}」は cog・file・wms・wmts・wfs・esri・ogc-features・ogc-tiles・wcs・ogc-coverage・xyz のどれかにしてください`);
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
  const response = await authFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const u = new URL(url, document.baseURI);
  const path = u.pathname;
  // `#file=<name>` names a file whose URL does not (a WCS GetCoverage); the fragment is never sent.
  const hinted = /^#file=([^&]+)$/.exec(u.hash)?.[1];
  let name = hinted ?? (path.slice(path.lastIndexOf('/') + 1) || 'layer');
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep it encoded
  }
  return new File([await response.blob()], name);
}
