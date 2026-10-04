/**
 * Site settings read at start from `config.json` next to `index.html`, so the
 * base maps, the projection registry and other environment-dependent values
 * can be changed on the server without rebuilding. A missing or broken file,
 * or a missing or invalid entry, falls back to the built-in default for that
 * entry, so the site always starts.
 */

/** One base map: an XYZ tile URL (`{z}`, `{x}`, `{y}`, or `{-y}`). */
export interface BaseMapConfig {
  /** Key used in `?base=` links. */
  id: string;
  /** Name in the base map switch. */
  label: string;
  url: string;
  /** Attribution HTML shown on the map. */
  attributions: string;
  maxZoom: number;
}

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
}

const gsi = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

/** The settings used when `config.json` does not give them. */
export const defaultConfig: ViewerConfig = {
  baseMaps: [
    { id: 'gsi-std', label: '地理院 標準', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
    { id: 'gsi-pale', label: '地理院 淡色', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
    { id: 'gsi-photo', label: '地理院 写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', attributions: gsi, maxZoom: 18 },
    {
      id: 'osm',
      label: 'OpenStreetMap',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attributions: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      maxZoom: 19,
    },
  ],
  defaultBaseMap: '',
  projectionLookup: 'https://spatialreference.org/ref/{authority}/{code}/ogcwkt/',
  projections: {},
  layers: [],
};

/** An absolute http(s) URL or one relative to the page (`./`, `../`, `/`). */
const isUrl = (url: unknown): url is string => typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function baseMapOf(value: unknown, problems: string[], index: number): BaseMapConfig | null {
  if (!isRecord(value)) return (problems.push(`baseMaps[${index}] がオブジェクトではありません`), null);
  const { id, label, url, attributions, maxZoom } = value;
  if (typeof id !== 'string' || !id || !isUrl(url)) {
    problems.push(`baseMaps[${index}] に id か url（http(s) か相対パス）がありません`);
    return null;
  }
  return {
    id,
    label: typeof label === 'string' && label ? label : id,
    url,
    attributions: typeof attributions === 'string' ? attributions : '',
    maxZoom: typeof maxZoom === 'number' && Number.isInteger(maxZoom) && maxZoom >= 0 && maxZoom <= 30 ? maxZoom : 18,
  };
}

/**
 * The settings in a parsed `config.json`, each entry checked on its own: what
 * is missing or invalid takes the default, and `problems` says what was ignored.
 */
export function parseConfig(json: unknown): { config: ViewerConfig; problems: string[] } {
  const problems: string[] = [];
  const config: ViewerConfig = { ...defaultConfig, projections: { ...defaultConfig.projections }, layers: [...defaultConfig.layers] };
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

  return { config, problems };
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
