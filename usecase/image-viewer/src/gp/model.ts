/**
 * Server-side geoprocessing, without the network: ArcGIS GPServer tasks and
 * OGC API – Processes descriptions turned into one kind of form (what each
 * parameter asks for), the person's values turned into what the server
 * takes, and the server's results read back (features, images, files and
 * plain values). The requests themselves are in client.ts, the dialog in
 * gp-dialog.ts.
 *
 * Everything here comes from a server: it is checked as it is read, feature
 * counts and text are capped, and only http(s) URLs are kept.
 */
import type Feature from 'ol/Feature.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import type { ProjectionLike } from 'ol/proj.js';
import type { Field } from '../services/common.js';

/** The two kinds of processing service. */
export type GpKind = 'esri' | 'ogc';

/** What a form control asks for. */
export type GpFieldType =
  | 'string'
  | 'choice'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'linear-unit'
  | 'features'
  | 'table'
  | 'raster'
  | 'file'
  | 'multi'
  | 'json';

/** One input of a task, as a form control. */
export interface GpField {
  /** The parameter's name on the server. */
  name: string;
  label: string;
  type: GpFieldType;
  required: boolean;
  description?: string;
  /** Allowed values (`choice`, and `multi` when the server lists them). */
  choices?: Array<string | number>;
  /** The server's default, already in the control's terms (a number, `true`, an ISO date…). */
  default?: unknown;
  /** `features`: what can be drawn for it; null when the server does not say. */
  geometry?: 'Point' | 'LineString' | 'Polygon' | null;
  /** `features` (OGC): whether the server takes one geometry, one feature or a collection. */
  shape?: 'geometry' | 'feature' | 'collection';
  /** `linear-unit`: the server's default unit (`esriMeters`…). */
  units?: string;
  /** `features` / `table` (Esri): the attributes the task's default value lists. */
  fields?: Array<{ name: string; type: string; alias?: string }>;
  /** Esri: the parameter's data type as the server writes it. */
  dataType?: string;
  /** Range of numbers (OGC `minimum` / `maximum`). */
  min?: number;
  max?: number;
}

/** One output of a task. */
export interface GpOutputSpec {
  name: string;
  label: string;
  dataType?: string;
}

/** A task (Esri) or process (OGC), read. */
export interface GpTask {
  kind: GpKind;
  /** The task's URL (`…/GPServer/Buffer`) or process URL (`…/processes/buffer`). */
  url: string;
  id: string;
  title: string;
  description?: string;
  inputs: GpField[];
  outputs: GpOutputSpec[];
  /** Run as a job (submitJob / `Prefer: respond-async`) rather than waiting for the answer. */
  async: boolean;
  /** Esri: the map service a job draws its results in (`resultMapServerName`). */
  resultMapServer?: string;
}

/** A service, read: the tasks to choose from. */
export interface GpService {
  kind: GpKind;
  url: string;
  title: string;
  tasks: Array<{ id: string; title: string; url: string }>;
}

/** The most features read from one result, and sent as one input. */
export const MAX_GP_FEATURES = 50_000;
/** The most tasks listed for one service. */
const MAX_TASKS = 500;
/** The longest text kept from a server (a description, a value). */
const MAX_TEXT = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** `url` resolved against `base`, when it is http(s); null for anything else (`javascript:`, `file:`, `data:`…). */
export function safeUrl(url: unknown, base?: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** What a URL points at: a GPServer, one of its tasks, or (anything else) an OGC API – Processes endpoint. */
export function classifyUrl(url: string): { kind: 'esri-service'; root: string } | { kind: 'esri-task'; root: string; task: string } | { kind: 'ogc'; url: string } {
  const clean = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const m = /^(.*\/GPServer)(?:\/([^/]+))?$/i.exec(clean);
  if (m) return m[2] ? { kind: 'esri-task', root: m[1], task: decodeURIComponent(m[2]) } : { kind: 'esri-service', root: m[1] };
  return { kind: 'ogc', url: clean };
}

// ---------------------------------------------------------------- Esri

/** The tasks of a GPServer (`{ tasks: ['Buffer', …] }`). */
export function parseEsriService(root: string, json: unknown): GpService {
  if (!isRecord(json) || !Array.isArray(json.tasks)) throw new Error('GPServer の応答に tasks なし');
  const tasks = json.tasks
    .map((t) => (typeof t === 'string' ? t : isRecord(t) ? text(t.name, 200) : undefined))
    .filter((t): t is string => !!t)
    .slice(0, MAX_TASKS)
    .map((name) => ({ id: name, title: name, url: `${root}/${encodeURIComponent(name)}` }));
  const title = decodeURIComponent(root.split('/').slice(-2, -1)[0] ?? root);
  return { kind: 'esri', url: root, title, tasks };
}

const linearUnits = ['esriMeters', 'esriKilometers', 'esriFeet', 'esriMiles', 'esriNauticalMiles', 'esriYards', 'esriInches', 'esriCentimeters', 'esriMillimeters', 'esriDecimalDegrees'];
/** Units offered for a linear unit, with their Japanese names. */
export const linearUnitNames: Record<string, string> = {
  esriMeters: 'm',
  esriKilometers: 'km',
  esriFeet: 'フィート',
  esriMiles: 'マイル',
  esriNauticalMiles: '海里',
  esriYards: 'ヤード',
  esriInches: 'インチ',
  esriCentimeters: 'cm',
  esriMillimeters: 'mm',
  esriDecimalDegrees: '度',
};

const esriGeometries: Record<string, GpField['geometry']> = {
  esriGeometryPoint: 'Point',
  esriGeometryMultipoint: 'Point',
  esriGeometryPolyline: 'LineString',
  esriGeometryPolygon: 'Polygon',
  esriGeometryEnvelope: 'Polygon',
};

/** The fields a feature or record set's default value lists. */
function esriFieldsOf(value: unknown): GpField['fields'] {
  if (!isRecord(value) || !Array.isArray(value.fields)) return undefined;
  return value.fields
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.name === 'string' && typeof f.type === 'string')
    .slice(0, 500)
    .map((f) => ({ name: f.name as string, type: f.type as string, ...(typeof f.alias === 'string' ? { alias: f.alias } : {}) }));
}

/** One parameter of a GP task as a form control; null for outputs and types the form cannot take. */
export function esriField(p: unknown): GpField | null {
  if (!isRecord(p) || typeof p.name !== 'string' || typeof p.dataType !== 'string') return null;
  if (p.direction !== undefined && p.direction !== 'esriGPParameterDirectionInput') return null;
  if (p.parameterType === 'esriGPParameterTypeDerived') return null;
  const dataType = p.dataType;
  const base = {
    name: p.name,
    label: text(p.displayName, 200) ?? p.name,
    required: p.parameterType === 'esriGPParameterTypeRequired',
    ...(text(p.description) ? { description: text(p.description) } : {}),
    dataType,
  };
  const choices = Array.isArray(p.choiceList) ? p.choiceList.filter((c): c is string | number => typeof c === 'string' || typeof c === 'number').slice(0, 1000) : [];
  const def = p.defaultValue;
  switch (dataType) {
    case 'GPString':
      return choices.length
        ? { ...base, type: 'choice', choices, ...(typeof def === 'string' ? { default: def } : {}) }
        : { ...base, type: 'string', ...(typeof def === 'string' ? { default: def } : {}) };
    case 'GPLong':
    case 'GPDouble': {
      const type = dataType === 'GPLong' ? 'integer' : 'number';
      if (choices.length) return { ...base, type: 'choice', choices, ...(typeof def === 'number' ? { default: def } : {}) };
      return { ...base, type, ...(typeof def === 'number' && Number.isFinite(def) ? { default: def } : {}) };
    }
    case 'GPBoolean':
      return { ...base, type: 'boolean', default: def === true };
    case 'GPDate':
      return { ...base, type: 'date', ...(typeof def === 'number' && Number.isFinite(def) ? { default: new Date(def).toISOString() } : {}) };
    case 'GPLinearUnit': {
      const d = isRecord(def) ? def : {};
      const units = typeof d.units === 'string' && linearUnits.includes(d.units) ? d.units : 'esriMeters';
      return { ...base, type: 'linear-unit', units, ...(typeof d.distance === 'number' && Number.isFinite(d.distance) ? { default: d.distance } : {}) };
    }
    case 'GPFeatureRecordSetLayer': {
      const geometry = isRecord(def) && typeof def.geometryType === 'string' ? (esriGeometries[def.geometryType] ?? null) : null;
      return { ...base, type: 'features', geometry, fields: esriFieldsOf(def) };
    }
    case 'GPRecordSet':
      return { ...base, type: 'table', fields: esriFieldsOf(def) };
    case 'GPRasterDataLayer':
    case 'GPRasterData':
      return { ...base, type: 'raster', ...(isRecord(def) && safeUrl(def.url) ? { default: safeUrl(def.url) } : {}) };
    case 'GPDataFile':
      return { ...base, type: 'file', ...(isRecord(def) && safeUrl(def.url) ? { default: safeUrl(def.url) } : {}) };
    default:
      if (dataType.startsWith('GPMultiValue')) {
        return { ...base, type: 'multi', ...(choices.length ? { choices } : {}), ...(Array.isArray(def) ? { default: def.filter((v) => typeof v === 'string' || typeof v === 'number').join(', ') } : {}) };
      }
      // Anything else (GPField, GPSpatialReference…) as the JSON the server takes.
      return { ...base, type: 'json', ...(def !== undefined && def !== null ? { default: JSON.stringify(def).slice(0, MAX_TEXT) } : {}) };
  }
}

/** A GP task's description (`…/GPServer/Buffer?f=json`). */
export function parseEsriTask(url: string, json: unknown, service?: unknown): GpTask {
  if (!isRecord(json) || !Array.isArray(json.parameters)) throw new Error('GP タスクの応答に parameters なし');
  const params = json.parameters.slice(0, 200);
  const inputs = params.map(esriField).filter((f): f is GpField => f !== null);
  const outputs = params
    .filter((p): p is Record<string, unknown> => isRecord(p) && p.direction === 'esriGPParameterDirectionOutput' && typeof p.name === 'string')
    .map((p) => ({ name: p.name as string, label: text(p.displayName, 200) ?? (p.name as string), ...(typeof p.dataType === 'string' ? { dataType: p.dataType } : {}) }));
  const id = text(json.name, 200) ?? decodeURIComponent(url.split('/').pop() ?? '');
  const mapServer = isRecord(service) ? text(service.resultMapServerName, 200) : undefined;
  return {
    kind: 'esri',
    url,
    id,
    title: text(json.displayName, 200) ?? id,
    ...(text(json.description) ? { description: text(json.description) } : {}),
    inputs,
    outputs,
    async: json.executionType === 'esriExecutionTypeAsynchronous',
    ...(mapServer && /^[\w.-]+$/.test(mapServer) ? { resultMapServer: mapServer } : {}),
  };
}

// ---------------------------------------------------------------- OGC

/** The link of `rel` among `links` (an OGC API links array), resolved against `base`. */
export function linkOf(links: unknown, rels: string[], base: string): string | null {
  if (!Array.isArray(links)) return null;
  for (const rel of rels) {
    const link = links.find((l) => isRecord(l) && l.rel === rel && (l.type === undefined || /json/i.test(String(l.type))));
    const href = isRecord(link) ? safeUrl(link.href, base) : null;
    if (href) return href;
  }
  return null;
}

const PROCESSES_REL = ['http://www.opengis.net/def/rel/ogc/1.0/processes', 'processes'];

/** The processes URL of an OGC API landing page; null when it has none. */
export function ogcProcessesUrl(url: string, json: unknown): string | null {
  return isRecord(json) ? linkOf(json.links, PROCESSES_REL, url) : null;
}

/** The processes of an OGC API – Processes list (`/processes`). */
export function parseOgcProcessList(url: string, json: unknown): GpService {
  if (!isRecord(json) || !Array.isArray(json.processes)) throw new Error('processes の一覧なし');
  const base = url.endsWith('/') ? url : `${url}/`;
  const tasks = json.processes
    .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.id === 'string' && !!p.id)
    .slice(0, MAX_TASKS)
    .map((p) => {
      const own = linkOf(p.links, ['self', 'process', 'http://www.opengis.net/def/rel/ogc/1.0/process'], url);
      return { id: p.id as string, title: text(p.title, 200) ?? (p.id as string), url: own ?? new URL(encodeURIComponent(p.id as string), base).href };
    });
  return { kind: 'ogc', url, title: text(json.title, 200) ?? 'OGC API – Processes', tasks };
}

/** Whether a JSON schema stands for GeoJSON, and which: `collection`, `feature` or `geometry`. */
function geoJsonShape(schema: Record<string, unknown>): GpField['shape'] | null {
  const hint = [schema.format, schema.contentMediaType, schema.$ref].filter((v) => typeof v === 'string').join(' ').toLowerCase();
  if (/feature-?collection/.test(hint)) return 'collection';
  if (/geometry/.test(hint)) return 'geometry';
  if (/geojson-feature|(^|[^a-z])feature(geojson|[^a-z]|$)/.test(hint)) return 'feature';
  if (/geojson|geo\+json/.test(hint)) return 'collection';
  return null;
}

/** The schema an input takes, with `oneOf` / `anyOf` / `allOf` of one useful member unwrapped. */
function schemaOf(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list) && list.length) {
      const geo = list.find((s) => isRecord(s) && geoJsonShape(s));
      if (geo) return geo as Record<string, unknown>;
      if (list.length === 1) return { ...schema, ...schemaOf(list[0]), [key]: undefined };
    }
  }
  return schema;
}

/** One input of an OGC process description as a form control. */
export function ogcField(id: string, input: unknown): GpField {
  const d = isRecord(input) ? input : {};
  const schema = schemaOf(d.schema);
  const base = {
    name: id,
    label: text(d.title, 200) ?? id,
    required: d.minOccurs === undefined ? schema.default === undefined : Number(d.minOccurs) > 0,
    ...(text(d.description) ? { description: text(d.description) } : {}),
  };
  const def = schema.default;
  const range = {
    ...(typeof schema.minimum === 'number' ? { min: schema.minimum } : {}),
    ...(typeof schema.maximum === 'number' ? { max: schema.maximum } : {}),
  };
  const shape = geoJsonShape(schema);
  if (shape) return { ...base, type: 'features', geometry: null, shape };
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const choices = schema.enum.filter((c): c is string | number => typeof c === 'string' || typeof c === 'number').slice(0, 1000);
    return { ...base, type: 'choice', choices, ...(typeof def === 'string' || typeof def === 'number' ? { default: def } : {}) };
  }
  switch (schema.type) {
    case 'string':
      if (schema.format === 'date' || schema.format === 'date-time') return { ...base, type: 'date', ...(typeof def === 'string' ? { default: def } : {}) };
      if (schema.format === 'uri' || schema.format === 'url') return { ...base, type: 'file', ...(safeUrl(def) ? { default: safeUrl(def) } : {}) };
      return { ...base, type: 'string', ...(typeof def === 'string' ? { default: def } : {}) };
    case 'integer':
      return { ...base, type: 'integer', ...range, ...(typeof def === 'number' ? { default: def } : {}) };
    case 'number':
      return { ...base, type: 'number', ...range, ...(typeof def === 'number' ? { default: def } : {}) };
    case 'boolean':
      return { ...base, type: 'boolean', default: def === true };
    default:
      return { ...base, type: 'json', ...(def !== undefined ? { default: JSON.stringify(def).slice(0, MAX_TEXT) } : {}) };
  }
}

/** An OGC process description (`/processes/{id}`). */
export function parseOgcProcess(url: string, json: unknown): GpTask {
  if (!isRecord(json) || typeof json.id !== 'string') throw new Error('プロセスの説明に id なし');
  // 1.0 has inputs as a map; drafts had a list of { id, … }.
  const entries = (value: unknown): Array<[string, unknown]> =>
    Array.isArray(value)
      ? value.filter((v) => isRecord(v) && typeof v.id === 'string').map((v) => [(v as { id: string }).id, v])
      : isRecord(value)
        ? Object.entries(value)
        : [];
  const inputs = entries(json.inputs).slice(0, 200).map(([id, input]) => ogcField(id, input));
  const outputs = entries(json.outputs)
    .slice(0, 200)
    .map(([id, output]) => ({ name: id, label: (isRecord(output) && text(output.title, 200)) || id }));
  const control = Array.isArray(json.jobControlOptions) ? json.jobControlOptions : ['sync-execute'];
  return {
    kind: 'ogc',
    url,
    id: json.id,
    title: text(json.title, 200) ?? json.id,
    ...(text(json.description) ? { description: text(json.description) } : {}),
    inputs,
    outputs,
    async: control.includes('async-execute'),
  };
}

// ---------------------------------------------------------------- inputs

/** Features handed to a `features` or `table` input: in the map's projection (`EPSG:3857`). */
export interface FeatureInput {
  features: Feature[];
  fields: Field[];
}

/** A value from the form. */
export type GpValue = string | number | boolean | null | { distance: number; units: string } | FeatureInput;

const isFeatureInput = (v: GpValue): v is FeatureInput => isRecord(v) && Array.isArray((v as unknown as FeatureInput).features);
const esriFormat = new EsriJSON();
const geoJson = new GeoJSON();
const WEB_MERCATOR = { wkid: 102100, latestWkid: 3857 };
const esriTypes: Record<Field['type'], string> = {
  string: 'esriFieldTypeString',
  integer: 'esriFieldTypeInteger',
  double: 'esriFieldTypeDouble',
  date: 'esriFieldTypeDate',
  oid: 'esriFieldTypeOID',
  other: 'esriFieldTypeString',
};

/** Features as an Esri feature set in Web Mercator (`GPFeatureRecordSetLayer`), or rows without geometry (`GPRecordSet`). */
export function esriFeatureSet(input: FeatureInput, table = false): object {
  if (input.features.length > MAX_GP_FEATURES) throw new Error(`送れる地物は ${MAX_GP_FEATURES.toLocaleString()} 件まで`);
  const fields = input.fields.filter((f) => f.type !== 'other').map((f) => ({ name: f.name, type: esriTypes[f.type], alias: f.alias }));
  const names = new Set(fields.map((f) => f.name));
  const attributesOf = (f: Feature) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(f.getProperties())) {
      if (key === f.getGeometryName() || !names.has(key)) continue;
      out[key] = value instanceof Date ? value.getTime() : value;
    }
    return out;
  };
  if (table) return { fields, features: input.features.map((f) => ({ attributes: attributesOf(f) })) };
  const features = input.features.flatMap((f) => {
    const geometry = f.getGeometry();
    if (!geometry) return [];
    return [{ geometry: esriFormat.writeGeometryObject(geometry, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' }), attributes: attributesOf(f) }];
  });
  const type = input.features.map((f) => f.getGeometry()?.getType()).find(Boolean);
  const geometryType =
    type === 'Point' ? 'esriGeometryPoint' : type === 'MultiPoint' ? 'esriGeometryMultipoint' : type === 'LineString' || type === 'MultiLineString' ? 'esriGeometryPolyline' : 'esriGeometryPolygon';
  return { geometryType, spatialReference: WEB_MERCATOR, fields, features };
}

/** Features as GeoJSON (WGS 84) in the shape an OGC input takes. */
export function ogcGeoJson(input: FeatureInput, shape: GpField['shape'] = 'collection'): object {
  if (input.features.length > MAX_GP_FEATURES) throw new Error(`送れる地物は ${MAX_GP_FEATURES.toLocaleString()} 件まで`);
  const options = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857', decimals: 8 };
  if (shape === 'geometry') {
    const geometry = input.features.find((f) => f.getGeometry())?.getGeometry();
    if (!geometry) throw new Error('図形なし');
    return geoJson.writeGeometryObject(geometry, options);
  }
  if (shape === 'feature') {
    if (!input.features[0]) throw new Error('地物なし');
    return geoJson.writeFeatureObject(input.features[0], options);
  }
  return geoJson.writeFeaturesObject(input.features, options);
}

/** What is missing or wrong in `values` for `task`, in the person's words; empty when nothing. */
export function checkValues(task: GpTask, values: Record<string, GpValue>): string[] {
  const problems: string[] = [];
  for (const field of task.inputs) {
    const value = values[field.name];
    const empty = value === null || value === undefined || value === '' || (isFeatureInput(value) && value.features.length === 0);
    if (empty) {
      if (field.required && field.type !== 'boolean') problems.push(`「${field.label}」を入力`);
      continue;
    }
    if ((field.type === 'integer' || field.type === 'number') && typeof value === 'number') {
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) problems.push(`「${field.label}」は${field.type === 'integer' ? '整数' : '数値'}で指定`);
      else if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) problems.push(`「${field.label}」は ${field.min ?? ''}〜${field.max ?? ''} で指定`);
    }
    if ((field.type === 'raster' || field.type === 'file') && !safeUrl(value)) problems.push(`「${field.label}」は http(s) の URL で指定`);
    if (field.type === 'json' && typeof value === 'string') {
      try {
        JSON.parse(value);
      } catch {
        problems.push(`「${field.label}」は JSON で記述`);
      }
    }
  }
  return problems;
}

/** The parameters of an Esri `execute` / `submitJob` (each a string, as the form-encoded request takes them). */
export function esriParams(task: GpTask, values: Record<string, GpValue>): Record<string, string> {
  const problems = checkValues(task, values);
  if (problems.length) throw new Error(problems.join('。'));
  // Results in the map's projection, so they need no lookup of a CRS.
  const params: Record<string, string> = { 'env:outSR': '102100' };
  for (const field of task.inputs) {
    const value = values[field.name];
    if (value === null || value === undefined || value === '') continue;
    if (isFeatureInput(value)) {
      if (value.features.length) params[field.name] = JSON.stringify(esriFeatureSet(value, field.type === 'table'));
      continue;
    }
    switch (field.type) {
      case 'boolean':
        params[field.name] = value ? 'true' : 'false';
        break;
      case 'date': {
        const t = typeof value === 'number' ? value : Date.parse(String(value));
        if (Number.isFinite(t)) params[field.name] = String(t);
        break;
      }
      case 'linear-unit':
        params[field.name] = JSON.stringify(isRecord(value) ? value : { distance: Number(value), units: field.units ?? 'esriMeters' });
        break;
      case 'raster':
      case 'file':
        params[field.name] = JSON.stringify({ url: safeUrl(value) });
        break;
      case 'multi':
        params[field.name] = JSON.stringify(
          String(value)
            .split(/[,、\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      default:
        params[field.name] = String(value);
    }
  }
  return params;
}

/** The `inputs` of an OGC execute request. */
export function ogcInputs(task: GpTask, values: Record<string, GpValue>): Record<string, unknown> {
  const problems = checkValues(task, values);
  if (problems.length) throw new Error(problems.join('。'));
  const inputs: Record<string, unknown> = {};
  for (const field of task.inputs) {
    const value = values[field.name];
    if (value === null || value === undefined || value === '') continue;
    if (isFeatureInput(value)) {
      if (value.features.length) inputs[field.name] = ogcGeoJson(value, field.shape);
      continue;
    }
    switch (field.type) {
      case 'file':
      case 'raster':
        inputs[field.name] = { href: safeUrl(value) };
        break;
      case 'json':
        inputs[field.name] = JSON.parse(String(value));
        break;
      case 'linear-unit':
        inputs[field.name] = isRecord(value) ? (value as { distance: number }).distance : value;
        break;
      case 'date': {
        const t = Date.parse(String(value));
        inputs[field.name] = Number.isFinite(t) ? new Date(t).toISOString() : value;
        break;
      }
      case 'choice':
        // Keep the type the server listed (a number stays a number).
        inputs[field.name] = field.choices?.find((c) => String(c) === String(value)) ?? value;
        break;
      default:
        inputs[field.name] = value;
    }
  }
  return inputs;
}

// ---------------------------------------------------------------- results

/** One result of a run. */
export type GpOutput =
  | { kind: 'features'; name: string; label: string; features: Feature[]; fields: Field[]; truncated: boolean; srs: string | null }
  | { kind: 'image'; name: string; label: string; url: string }
  | { kind: 'link'; name: string; label: string; url: string }
  | { kind: 'value'; name: string; label: string; text: string };

/** The CRS name of an Esri `spatialReference` (`EPSG:6677`), or its WKT; null when it has neither. */
export function esriSrs(sr: unknown): string | null {
  if (!isRecord(sr)) return null;
  const wkid = Number(sr.latestWkid ?? sr.wkid);
  if (Number.isInteger(wkid) && wkid > 0) return wkid === 102100 || wkid === 102113 || wkid === 900913 ? 'EPSG:3857' : `EPSG:${wkid}`;
  return typeof sr.wkt === 'string' && sr.wkt.length < 20_000 ? sr.wkt : null;
}

const fieldTypes: Record<string, Field['type']> = {
  esriFieldTypeOID: 'integer',
  esriFieldTypeString: 'string',
  esriFieldTypeSmallInteger: 'integer',
  esriFieldTypeInteger: 'integer',
  esriFieldTypeBigInteger: 'integer',
  esriFieldTypeSingle: 'double',
  esriFieldTypeDouble: 'double',
  esriFieldTypeDate: 'date',
  esriFieldTypeDateOnly: 'string',
  esriFieldTypeTimeOnly: 'string',
  esriFieldTypeGlobalID: 'string',
  esriFieldTypeGUID: 'string',
};

/** The attributes of an Esri result as editable fields of a temporary layer. */
function esriResultFields(fields: unknown): Field[] {
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((f): Field[] => {
    if (!isRecord(f) || typeof f.name !== 'string' || typeof f.type !== 'string' || !fieldTypes[f.type]) return [];
    return [{ name: f.name, alias: typeof f.alias === 'string' && f.alias ? f.alias : f.name, type: fieldTypes[f.type], editable: true, nullable: true }];
  });
}

/** Fields for features without a list of them (GeoJSON): every property, typed by its values. */
export function inferFields(features: Feature[]): Field[] {
  const types = new Map<string, Set<string>>();
  for (const f of features.slice(0, 1000)) {
    for (const [key, value] of Object.entries(f.getProperties())) {
      if (key === f.getGeometryName() || value === null || value === undefined) continue;
      const kind = typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'double') : typeof value === 'object' ? 'other' : 'string';
      if (!types.has(key)) types.set(key, new Set());
      types.get(key)!.add(kind);
    }
  }
  return [...types].map(([name, kinds]) => {
    const type: Field['type'] = kinds.has('other') ? 'other' : kinds.has('string') ? 'string' : kinds.has('double') ? 'double' : 'integer';
    return { name, alias: name, type, editable: type !== 'other', nullable: true };
  });
}

/** Up to {@link MAX_GP_FEATURES} of `features`. */
function capped(features: Feature[]): { features: Feature[]; truncated: boolean } {
  return features.length > MAX_GP_FEATURES ? { features: features.slice(0, MAX_GP_FEATURES), truncated: true } : { features, truncated: false };
}

/** A plain value as text for the result panel. */
function valueText(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

const imageLike = /\.(tiff?|png|jpe?g|webp|gif|jp2|ntf|nitf)(?:[?#]|$)/i;

/**
 * One result of an Esri task (`{ paramName, dataType, value }`). Features are
 * read from `dataProjection` (the result's spatial reference, resolved by the
 * caller from {@link esriSrs}) into the map's projection.
 */
export function esriOutput(result: unknown, label?: string, dataProjection: ProjectionLike = 'EPSG:3857', base?: string): GpOutput | null {
  if (!isRecord(result) || typeof result.paramName !== 'string') return null;
  const name = result.paramName;
  const head = { name, label: label ?? name };
  const value = result.value;
  const dataType = typeof result.dataType === 'string' ? result.dataType : '';
  if ((dataType === 'GPFeatureRecordSetLayer' || dataType === 'GPRecordSet') && isRecord(value)) {
    if (!Array.isArray(value.features)) return { ...head, kind: 'value', text: '（地物なし）' };
    const all = esriFormat.readFeatures({ features: value.features.slice(0, MAX_GP_FEATURES + 1) }, { dataProjection, featureProjection: 'EPSG:3857' }) as Feature[];
    const { features, truncated } = capped(all);
    const fields = esriResultFields(value.fields);
    return { ...head, kind: 'features', features, fields: fields.length ? fields : inferFields(features), truncated, srs: esriSrs(value.spatialReference) };
  }
  if ((dataType === 'GPRasterDataLayer' || dataType === 'GPRasterData' || dataType === 'GPDataFile') && isRecord(value)) {
    const url = safeUrl(value.url, base);
    if (!url) return { ...head, kind: 'value', text: '（URL なし）' };
    const image = dataType !== 'GPDataFile' || imageLike.test(url) || (typeof value.format === 'string' && /^(tiff?|png|jpe?g)$/i.test(value.format));
    return { ...head, kind: image ? 'image' : 'link', url };
  }
  if (dataType === 'GPDate' && typeof value === 'number') return { ...head, kind: 'value', text: new Date(value).toISOString() };
  if (dataType === 'GPLinearUnit' && isRecord(value)) return { ...head, kind: 'value', text: `${value.distance} ${linearUnitNames[String(value.units)] ?? value.units}` };
  return { ...head, kind: 'value', text: value === null || value === undefined ? '（なし）' : valueText(value) };
}

/** Whether `value` is a GeoJSON object. */
function isGeoJson(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ['FeatureCollection', 'Feature', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'].includes(value.type as string);
}

/** One OGC output value: GeoJSON, a link (`{ href, type }`), a qualified value (`{ value, mediaType }`) or a plain value. */
export function ogcOutput(name: string, value: unknown, label = name, base?: string): GpOutput {
  const head = { name, label };
  if (isGeoJson(value)) {
    const object = value.type === 'FeatureCollection' && Array.isArray(value.features) ? { ...value, features: value.features.slice(0, MAX_GP_FEATURES + 1) } : value;
    let dataProjection = 'EPSG:4326';
    try {
      dataProjection = geoJson.readProjection(object)?.getCode() ?? 'EPSG:4326';
    } catch {
      // an unknown `crs` member: GeoJSON is WGS 84
    }
    const all = geoJson.readFeatures(object, { dataProjection, featureProjection: 'EPSG:3857' });
    const { features, truncated } = capped(all);
    return { ...head, kind: 'features', features, fields: inferFields(features), truncated, srs: dataProjection };
  }
  if (isRecord(value) && typeof value.href === 'string') {
    const url = safeUrl(value.href, base);
    if (!url) return { ...head, kind: 'value', text: '（http(s) 以外のリンクは表示不可）' };
    const type = typeof value.type === 'string' ? value.type : '';
    return { ...head, kind: /^image\//i.test(type) || imageLike.test(url) ? 'image' : 'link', url };
  }
  if (isRecord(value) && 'value' in value && Object.keys(value).every((k) => ['value', 'mediaType', 'encoding', 'schema', 'format'].includes(k))) {
    return ogcOutput(name, value.value, label, base);
  }
  return { ...head, kind: 'value', text: value === null || value === undefined ? '（なし）' : valueText(value) };
}

/**
 * The results of an OGC run: a map of outputs by id (the document response),
 * or the one output itself (a raw GeoJSON response). Unknown keys of a map
 * are still shown, under their own names.
 */
export function ogcOutputs(task: GpTask, json: unknown, base?: string): GpOutput[] {
  const labels = new Map(task.outputs.map((o) => [o.name, o.label]));
  if (isGeoJson(json) || !isRecord(json)) return [ogcOutput(task.outputs[0]?.name ?? 'result', json, task.outputs[0]?.label, base)];
  // 1.0 drafts: { outputs: [{ id, value }] }.
  if (Array.isArray(json.outputs)) {
    return json.outputs.filter((o) => isRecord(o) && typeof o.id === 'string').slice(0, 200).map((o) => ogcOutput(o.id as string, o.value ?? o, labels.get(o.id as string), base));
  }
  return Object.entries(json)
    .filter(([key]) => key !== 'links')
    .slice(0, 200)
    .map(([key, value]) => ogcOutput(key, value, labels.get(key), base));
}

/** Job states of both kinds, as one. */
export type JobState = 'waiting' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The state of an Esri job (`esriJobSucceeded`…). */
export function esriJobState(status: unknown): JobState {
  switch (status) {
    case 'esriJobSucceeded':
      return 'succeeded';
    case 'esriJobFailed':
    case 'esriJobTimedOut':
      return 'failed';
    case 'esriJobCancelled':
    case 'esriJobCancelling':
    case 'esriJobDeleted':
      return 'cancelled';
    case 'esriJobExecuting':
      return 'running';
    default:
      return 'waiting';
  }
}

/** The state of an OGC job (`accepted`, `running`, `successful`, `failed`, `dismissed`). */
export function ogcJobState(status: unknown): JobState {
  switch (status) {
    case 'successful':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'dismissed':
      return 'cancelled';
    case 'running':
      return 'running';
    default:
      return 'waiting';
  }
}

/** The messages of an Esri job or result (`[{ type, description }]`), newest last, at most `max`. */
export function esriMessages(messages: unknown, max = 20): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.description === 'string')
    .map((m) => `${m.type === 'esriJobMessageTypeError' ? 'エラー: ' : m.type === 'esriJobMessageTypeWarning' ? '警告: ' : ''}${(m.description as string).slice(0, 500)}`)
    .slice(-max);
}

/** Japanese names of the job states, for the status line. */
export const jobStateNames: Record<JobState, string> = {
  waiting: '待機中',
  running: '実行中',
  succeeded: '完了',
  failed: '失敗',
  cancelled: '取り消し',
};
