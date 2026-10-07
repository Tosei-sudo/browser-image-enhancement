/**
 * The base map switch in the header: none (the checkerboard, as an image
 * viewer) or one of the base maps in `config.json`, drawn below every layer.
 * A base map is raster tiles (XYZ), vector tiles (a `{z}/{x}/{y}.pbf` URL, a
 * Mapbox / MapLibre style JSON, or an ArcGIS `VectorTileServer`, such as the
 * OpenStreetMap vector tiles of ArcGIS Online or an ArcGIS Data Appliance).
 * Base maps are not corrected.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import XYZ from 'ol/source/XYZ.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import MVT from 'ol/format/MVT.js';
import type { FeatureLike } from 'ol/Feature.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import type { BaseMapConfig } from './config.js';

/** The CSS class of base map layers, so they get a canvas of their own and their labels stay below the layers. */
const className = 'ol-layer basemap-layer';
/** Base map labels are decluttered among themselves, never against the viewer's layers. */
const declutter = 'basemap';

/** A select that shows one base map, or none (value ''). */
export class BaseMapSwitch {
  readonly select: HTMLSelectElement;
  private layers_: BaseLayer[] = [];
  /** Counts base map changes, so a style that arrives after another change is dropped. */
  private generation_ = 0;
  /** Settles when the base map shown last has loaded its style (at once for raster tiles). */
  ready: Promise<void> = Promise.resolve();

  constructor(
    target: HTMLElement,
    private readonly map: OlMap,
    private readonly baseMaps: readonly BaseMapConfig[],
    private readonly options: { say?: (message: string) => void } = {},
  ) {
    const label = document.createElement('label');
    label.className = 'basemap';
    this.select = document.createElement('select');
    this.select.append(new Option('背景なし', ''), ...baseMaps.map((b) => new Option(b.label, b.id)));
    this.select.addEventListener('change', () => this.set(this.select.value));
    label.append('背景地図', this.select);
    target.append(label);
  }

  /** Shows the base map `key` ('' for none). */
  set(key: string): void {
    const generation = ++this.generation_;
    for (const layer of this.layers_) {
      this.map.removeLayer(layer);
      layer.dispose();
    }
    this.layers_ = [];
    const base = this.baseMaps.find((b) => b.id === key);
    this.select.value = base ? key : '';
    this.map.getTargetElement()?.classList.toggle('has-basemap', !!base);
    if (!base) {
      this.ready = Promise.resolve();
      return;
    }
    const add = (layers: BaseLayer[]) => {
      if (generation !== this.generation_) {
        for (const layer of layers) layer.dispose();
        return;
      }
      for (const layer of layers) {
        layer.setZIndex(-1);
        this.map.addLayer(layer);
      }
      this.layers_.push(...layers);
    };
    if (base.type === 'xyz') {
      add([new TileLayer({ source: new XYZ({ url: base.url, attributions: base.attributions, maxZoom: base.maxZoom }) })]);
      this.ready = Promise.resolve();
    } else if (base.type === 'mvt') {
      add([plainVectorTiles(base)]);
      this.ready = Promise.resolve();
    } else {
      this.ready = styledVectorTiles(base).then(add, (error: unknown) => {
        if (generation !== this.generation_) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`背景地図「${base.label}」`, error);
        this.options.say?.(`背景地図「${base.label}」を読み込めませんでした: ${message}`);
      });
    }
  }

  get(): string {
    return this.select.value;
  }
}

/** A Mapbox / MapLibre style document, as far as it is read here. */
interface StyleJson {
  sources?: Record<string, { type?: string; url?: string; tiles?: string[]; [key: string]: unknown }>;
  layers?: { id?: string; type?: string; source?: string }[];
  [key: string]: unknown;
}

/** The parts of an ArcGIS `VectorTileServer` description read here. */
interface VectorTileServerInfo {
  tiles?: string[];
  defaultStyles?: string;
  minzoom?: number;
  maxzoom?: number;
  minLOD?: number;
  maxLOD?: number;
  copyrightText?: string;
  tileInfo?: { rows?: number; spatialReference?: { wkid?: number; latestWkid?: number }; lods?: { level: number }[] };
  error?: { code?: number; message?: string };
}

/** Web Mercator, under the codes ArcGIS uses for it. */
const webMercator = new Set([3857, 102100, 102113, 900913]);

const absolute = (url: string, base = document.baseURI) => new URL(url, base);

/** `url` with `token` as a query parameter (`url` unchanged without a token). */
function withToken(url: string, token: string | undefined): string {
  if (!token) return url;
  // Tile templates keep their braces, which URL would percent-encode.
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(`${what}を取得できません（ネットワークか CORS の設定を確認してください）`);
  }
  if (!response.ok) throw new Error(`${what}を取得できません: HTTP ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${what}が JSON ではありません`);
  }
}

/** The service root of a `VectorTileServer` URL, ending in `/`, without a query. */
function serverRoot(url: URL): string {
  const root = new URL(url.href);
  root.search = '';
  root.hash = '';
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  return root.href;
}

/** The description of an ArcGIS `VectorTileServer`; an error when it is one ArcGIS reports or not in Web Mercator. */
async function serverInfo(root: string, token: string | undefined): Promise<VectorTileServerInfo> {
  const info = await fetchJson<VectorTileServerInfo>(withToken(`${root}?f=json`, token), 'VectorTileServer の情報');
  if (info.error) {
    const code = info.error.code;
    const hint = code === 498 || code === 499 ? '（トークンが必要か、期限切れです）' : '';
    throw new Error(`VectorTileServer がエラーを返しました: ${info.error.message ?? code}${hint}`);
  }
  const sr = info.tileInfo?.spatialReference;
  const wkid = sr?.latestWkid ?? sr?.wkid;
  if (wkid !== undefined && !webMercator.has(wkid)) throw new Error(`Web メルカトル以外（WKID ${wkid}）のベクタータイルには対応していません`);
  return info;
}

/** The deepest zoom level an ArcGIS vector tile service has tiles for. */
function serverMaxZoom(info: VectorTileServerInfo): number {
  if (typeof info.maxzoom === 'number') return info.maxzoom;
  if (typeof info.maxLOD === 'number') return info.maxLOD;
  const lods = info.tileInfo?.lods ?? [];
  return lods.length ? Math.max(...lods.map((l) => l.level)) : 22;
}

/**
 * The style with each source that points to an ArcGIS `VectorTileServer`
 * turned into plain tile URLs and zoom range: ArcGIS answers its root URL with
 * HTML unless asked for JSON, names tiles `{z}/{y}/{x}`, and gives the zoom
 * range in its own words.
 */
async function resolveEsriSources(style: StyleJson, styleUrl: string, token: string | undefined, infos: Map<string, Promise<VectorTileServerInfo>>): Promise<StyleJson> {
  const sources = { ...style.sources };
  for (const [id, source] of Object.entries(sources)) {
    if (source.type !== 'vector' || !source.url || source.tiles) continue;
    const url = absolute(source.url, styleUrl);
    if (!/\/VectorTileServer\/?$/i.test(url.pathname)) continue;
    const root = serverRoot(url);
    if (!infos.has(root)) infos.set(root, serverInfo(root, token));
    const info = await infos.get(root)!;
    const tiles = info.tiles?.length ? info.tiles : ['tile/{z}/{y}/{x}.pbf'];
    const rest = { ...source };
    delete rest.url;
    sources[id] = {
      ...rest,
      tiles: tiles.map((t) => withToken(decodeURI(absolute(t, root).href), token)),
      minzoom: info.minzoom ?? info.minLOD ?? 0,
      maxzoom: serverMaxZoom(info),
      tileSize: info.tileInfo?.rows ?? 512,
      ...(info.copyrightText ? { attribution: info.copyrightText } : {}),
    };
  }
  return { ...style, sources };
}

/** The layers of a style (`style`) or of an ArcGIS `VectorTileServer` (`esri`), one per vector source the style draws. */
async function styledVectorTiles(base: BaseMapConfig): Promise<BaseLayer[]> {
  let styleUrl: string;
  let token: string | undefined;
  // The descriptions of the VectorTileServers asked so far, by root URL.
  const infos = new Map<string, Promise<VectorTileServerInfo>>();
  if (base.type === 'esri') {
    token = base.token;
    const root = serverRoot(absolute(base.url));
    if (base.style) styleUrl = absolute(base.style).href;
    else {
      infos.set(root, serverInfo(root, token));
      const info = await infos.get(root)!;
      styleUrl = absolute(`${(info.defaultStyles ?? 'resources/styles').replace(/\/$/, '')}/root.json`, root).href;
    }
  } else styleUrl = absolute(base.url).href;

  let style = await fetchJson<StyleJson>(withToken(styleUrl, token), 'スタイル');
  if (!style || typeof style !== 'object' || !Array.isArray(style.layers)) throw new Error('スタイル JSON ではありません');
  style = await resolveEsriSources(style, styleUrl, token, infos);

  // The sprite (icons) from a secured server needs the token too: in its URL, which carries it to the .json and the .png.
  if (token && typeof style.sprite === 'string') style = { ...style, sprite: withToken(absolute(style.sprite, styleUrl).href, token) };

  // One layer per vector source, in the order the style first draws them.
  const sourceIds: string[] = [];
  for (const layer of style.layers ?? []) {
    const id = layer.source;
    if (id && style.sources?.[id]?.type === 'vector' && !sourceIds.includes(id)) sourceIds.push(id);
  }
  if (!sourceIds.length) throw new Error('スタイルにベクタータイルのソースがありません');

  // The style reader is loaded only when a styled base map is first shown.
  const { applyBackground, applyStyle } = await import('ol-mapbox-style');
  const build = async (style: StyleJson) => {
    const layers = sourceIds.map(() => new VectorTileLayer({ className, declutter }));
    try {
      await Promise.all(layers.map((layer, i) => applyStyle(layer, style, { source: sourceIds[i] }, { styleUrl })));
      await applyBackground(layers[0], style, { styleUrl });
    } catch (error) {
      for (const layer of layers) layer.dispose();
      throw error;
    }
    return layers;
  };
  let layers: VectorTileLayer[];
  try {
    layers = await build(style);
  } catch (error) {
    // A missing sprite should cost the icons, not the whole map.
    if (!(error instanceof Error && error.message.startsWith('Sprites cannot be loaded')) || !style.sprite) throw error;
    console.warn('背景地図のアイコン（sprite）を読み込めなかったので、アイコンなしで表示します', error);
    layers = await build({ ...style, sprite: undefined });
  }
  if (base.attributions) for (const layer of layers) layer.getSource()?.setAttributions(base.attributions);
  return layers;
}

/** Vector tiles by URL template, in a plain light style: land use as areas, roads and borders as lines, names as labels. */
function plainVectorTiles(base: BaseMapConfig): VectorTileLayer {
  const area = new Style({ fill: new Fill({ color: '#e9e7e1' }), stroke: new Stroke({ color: '#d6d2c9', width: 0.5 }) });
  const line = new Style({ stroke: new Stroke({ color: '#b5b0a6', width: 1 }) });
  const label = new Style({
    text: new Text({ font: '12px sans-serif', fill: new Fill({ color: '#555' }), stroke: new Stroke({ color: '#fff', width: 3 }), overflow: false }),
  });
  const style = (feature: FeatureLike): Style | undefined => {
    const type = feature.getGeometry()?.getType();
    if (type === 'Polygon' || type === 'MultiPolygon') return area;
    if (type === 'LineString' || type === 'MultiLineString') return line;
    const name = feature.get('name') ?? feature.get('name:ja') ?? feature.get('name_ja');
    if (typeof name !== 'string' || !name) return undefined;
    label.getText()!.setText(name);
    return label;
  };
  return new VectorTileLayer({
    className,
    declutter,
    background: '#f6f5f2',
    source: new VectorTileSource({ format: new MVT(), url: base.url, maxZoom: base.maxZoom, attributions: base.attributions }),
    style,
  });
}
