/**
 * What the service readers share: the layer a service adds to the viewer,
 * its attribute fields, and helpers for requests, XML and coordinate systems.
 */
import type BaseLayer from 'ol/layer/Base.js';
import type Feature from 'ol/Feature.js';
import type VectorSource from 'ol/source/Vector.js';
import type OlMap from 'ol/Map.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { Extent } from 'ol/extent.js';
import { get as getProjection, type ProjectionLike } from 'ol/proj.js';
import type Projection from 'ol/proj/Projection.js';
import { fromEPSGCode } from 'ol/proj/proj4.js';
import type { TileCorrection } from 'browser-image-enhancement/openlayers';
import type { EsriLayerInfo } from './esri.js';

/** The kinds of service the viewer reads. */
export type ServiceKind = 'wms' | 'wmts' | 'wfs' | 'esri';

export const serviceNames: Record<ServiceKind, string> = {
  wms: 'WMS',
  wmts: 'WMTS',
  wfs: 'WFS',
  esri: 'Esri フィーチャーサービス',
};

/** One attribute of a vector layer. */
export interface Field {
  name: string;
  /** Heading in the table. */
  alias: string;
  type: 'string' | 'integer' | 'double' | 'date' | 'oid' | 'other';
  /** Whether the value can be changed (Esri, when the layer is editable). */
  editable: boolean;
  nullable: boolean;
  /** Longest text, for strings. */
  length?: number;
  /** A list of allowed values: code → name. */
  codes?: Array<{ code: string | number; name: string }>;
  /** Allowed range, for numbers. */
  range?: [number, number];
}

/** The attributes of a vector layer, for the table. */
export interface VectorData {
  source: VectorSource<Feature>;
  fields: Field[];
  /** Field holding the feature's id on the server (Esri OBJECTID). */
  idField?: string;
  /** Features left out because the layer has more than {@link MAX_FEATURES}. */
  truncated: boolean;
}

/** How to open the layer again (for `?service=` links). */
export interface ServiceRef {
  kind: ServiceKind;
  url: string;
  layer: string;
  /** WMTS: tile matrix set and image format. */
  matrixSet?: string;
  format?: string;
}

/** A layer of a service, added to the viewer. */
export interface ServiceLayer {
  /** How to open it again; null for a layer read from a local file. */
  ref: ServiceRef | null;
  /** Badge in the layer list, for local files (`SHP`, `GeoJSON`); services show their kind. */
  badge?: string;
  title: string;
  layer: BaseLayer;
  /** The correction of picture layers that can be corrected on the GPU. */
  correction: TileCorrection | null;
  /** Attributes, for vector layers. */
  vector: VectorData | null;
  /** Esri layer description, for Esri layers. */
  esri?: EsriLayerInfo;
  /** Area covered, in the view projection, when known. */
  extent: Extent | null;
  /** Lines for the information panel. */
  info: Array<[string, string]>;
  /** WMS: features at a point (GetFeatureInfo). */
  featureInfo?: (coordinate: Coordinate, map: OlMap) => Promise<{ features: Feature[]; fields: Field[] }>;
  dispose?: () => void;
}

/** One layer a service offers, for the choice list. */
export interface LayerChoice {
  /** Name or id the service knows the layer by. */
  name: string;
  title: string;
  abstract?: string;
  /** WMTS: tile matrix sets and image formats to choose from (the first is the default). */
  matrixSets?: string[];
  formats?: string[];
}

/** What a reader needs to open a layer. */
export interface OpenContext {
  /** Correct picture layers on the GPU. */
  gpu: boolean;
  /** Esri: token for secured services. */
  token?: string;
  /** Shows a message to the user. */
  say: (message: string) => void;
}

/** A service, read: its layers to choose from. */
export interface ServiceCatalog {
  kind: ServiceKind;
  url: string;
  title: string;
  choices: LayerChoice[];
  /** Opens one layer; `matrixSet` and `format` pick among a WMTS layer's. */
  open: (choice: LayerChoice, context: OpenContext, pick?: { matrixSet?: string; format?: string }) => Promise<ServiceLayer>;
}

/** The most features read from one vector layer. */
export const MAX_FEATURES = 50_000;

/** What went wrong reading a service, in words for the status line. */
export class ServiceError extends Error {}

/** `fetch`, with messages that say what to check when a service cannot be read. */
export async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ServiceError('接続できませんでした（URL、またはサーバーが CORS を許可しているかを確認してください）');
  }
  if (!response.ok) throw new ServiceError(`サーバーがエラーを返しました（HTTP ${response.status}）`);
  return response;
}

/** Reads an XML document; a service exception report becomes an error. */
export async function requestXml(url: string): Promise<Document> {
  const text = await (await request(url)).text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new ServiceError('応答が XML ではありません');
  const root = doc.documentElement.localName;
  if (root === 'ServiceExceptionReport' || root === 'ExceptionReport') {
    const message = doc.documentElement.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    throw new ServiceError(`サービスがエラーを返しました: ${message.slice(0, 200)}`);
  }
  return doc;
}

/** `url` with `params` set (replacing any of the same name, ignoring case). */
export function withParams(url: string, params: Record<string, string | number | undefined>): string {
  const u = new URL(url, location.href);
  for (const [key, value] of Object.entries(params)) {
    for (const existing of [...u.searchParams.keys()]) if (existing.toLowerCase() === key.toLowerCase()) u.searchParams.delete(existing);
    if (value !== undefined) u.searchParams.set(key, String(value));
  }
  return u.href;
}

/** Child elements of `parent` named `name` (any namespace). */
export function children(parent: Element | Document, name: string): Element[] {
  const element = parent instanceof Document ? parent.documentElement : parent;
  return [...element.children].filter((c) => c.localName === name);
}

/** Text of the first child element named `name` (any namespace). */
export function childText(parent: Element, name: string): string | undefined {
  return children(parent, name)[0]?.textContent?.trim() || undefined;
}

/** All descendant elements named `name` (any namespace). */
export function descendants(parent: Element | Document, name: string): Element[] {
  return [...parent.getElementsByTagNameNS('*', name)];
}

/** The EPSG code in a CRS name: `EPSG:6668`, `urn:ogc:def:crs:EPSG::6668`, `http://www.opengis.net/def/crs/EPSG/0/6668`. */
export function epsgCode(crs: string): number | null {
  if (/CRS:?84$/i.test(crs)) return 4326;
  const m = /EPSG(?::+|\/\d+\/|\/)(\d+)$/i.exec(crs.trim());
  if (!m) return null;
  const code = Number(m[1]);
  return code === 900913 || code === 102100 || code === 102113 ? 3857 : code;
}

/** The projection for a CRS name, loading its definition from the registry in config.json when needed; null when unknown. */
export async function projectionOf(crs: string): Promise<Projection | null> {
  const code = epsgCode(crs);
  if (code === null) return getProjection(crs);
  const known = getProjection(`EPSG:${code}`);
  if (known) return known;
  try {
    return await fromEPSGCode(code);
  } catch {
    return null;
  }
}

/** Whether `projection` is the map's own (no reprojection needed). */
export function isWebMercator(projection: ProjectionLike): boolean {
  return getProjection(projection)?.getCode() === 'EPSG:3857';
}

/** Distinct colors for vector layers, in the order they are added. */
const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324'];
let next = 0;
export function nextColor(): string {
  return palette[next++ % palette.length];
}
