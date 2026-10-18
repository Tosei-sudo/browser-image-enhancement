/**
 * The messages of the embedding API (embed.ts): another web page shows the
 * viewer in an iframe and drives it with `postMessage`. This file holds what
 * can be checked without the page: config.json's `embed`, the requests a
 * parent page may send, each method's parameters, and which methods change
 * what is shown (refused when `embed.readOnly`).
 *
 * A request is `{ type: 'image-viewer', v: 1, id, method, params }`; the answer
 * is `{ type: 'image-viewer', v: 1, id, result }` or `{ …, id, error: { code,
 * message } }`, and events are `{ type: 'image-viewer', v: 1, event, data }`.
 * Everything a parent sends is data: checked strictly, capped in size, never run.
 */

export const PROTOCOL = 'image-viewer';
export const VERSION = 1;
/** Largest request, in characters of its JSON. */
export const MAX_REQUEST = 1_000_000;
/** Largest answer, in characters of its JSON. */
export const MAX_RESULT = 8_000_000;
/** Most origins `allowedOrigins` takes. */
const MAX_ORIGINS = 100;
const MAX_ID = 100;

/** config.json's `embed`: who may drive the viewer in an iframe. */
export interface EmbedConfig {
  /** Exact origins (`https://app.example.com`) of the pages allowed to embed and drive the viewer; [] turns the API off. */
  allowedOrigins: string[];
  /** Only reading and moving the view: methods that add, remove or change layers are refused. */
  readOnly: boolean;
}

export const defaultEmbed: EmbedConfig = { allowedOrigins: [], readOnly: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** config.json's `embed`, checked: origins must be exact (scheme, host, port), never `*`. */
export function embedConfigOf(value: unknown, problems: string[]): EmbedConfig {
  if (!isRecord(value)) return (problems.push('embed がオブジェクトではありません'), defaultEmbed);
  const origins: string[] = [];
  if (value.allowedOrigins !== undefined) {
    if (!Array.isArray(value.allowedOrigins)) problems.push('embed.allowedOrigins が配列ではありません');
    else {
      value.allowedOrigins.forEach((o, i) => {
        const origin = exactOrigin(o);
        if (!origin) problems.push(`embed.allowedOrigins[${i}]「${String(o).slice(0, 100)}」は https://app.example.com のようなオリジン（* は不可）にしてください`);
        else if (origins.length >= MAX_ORIGINS) problems.push(`embed.allowedOrigins は ${MAX_ORIGINS} 個までです`);
        else if (!origins.includes(origin)) origins.push(origin);
      });
    }
  }
  if (value.readOnly !== undefined && typeof value.readOnly !== 'boolean') problems.push('embed.readOnly は true か false にしてください');
  return { allowedOrigins: origins, readOnly: value.readOnly === true };
}

/** `value` when it is an http(s) origin written exactly (no path, no wildcard); null otherwise. */
function exactOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300 || value.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin === value.toLowerCase() ? url.origin : null;
}

/** Whether a message from `origin` may drive the viewer. */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return origin !== 'null' && allowed.includes(origin);
}

/** Why a request is refused. */
export type EmbedErrorCode = 'bad-request' | 'unknown-method' | 'read-only' | 'too-large' | 'busy' | 'hello-first' | 'failed';

export class EmbedError extends Error {
  constructor(
    readonly code: EmbedErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// --- Parameters ---------------------------------------------------------------------------------------------------

type Check = (value: unknown, name: string) => unknown;
const bad = (message: string) => new EmbedError('bad-request', message);

const str =
  (max: number, min = 1): Check =>
  (v, name) => {
    if (typeof v !== 'string' || v.length < min || v.length > max) throw bad(`${name} は ${min}〜${max} 文字の文字列です`);
    return v;
  };
const num =
  (min: number, max: number): Check =>
  (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${name} は ${min}〜${max} の数値です`);
    return v;
  };
const bool: Check = (v, name) => {
  if (typeof v !== 'boolean') throw bad(`${name} は true か false です`);
  return v;
};
const oneOf =
  (...choices: string[]): Check =>
  (v, name) => {
    if (typeof v !== 'string' || !choices.includes(v)) throw bad(`${name} は ${choices.join(' / ')} のどれかです`);
    return v;
  };
const lonLat: Check = (v, name) => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)) || Math.abs(v[0]) > 540 || Math.abs(v[1]) > 90) {
    throw bad(`${name} は [経度, 緯度] です`);
  }
  return v;
};
const bbox: Check = (v, name) => {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)) || v[0] > v[2] || v[1] > v[3] || Math.abs(v[1]) > 90 || Math.abs(v[3]) > 90) {
    throw bad(`${name} は [西, 南, 東, 北]（経緯度）です`);
  }
  return v;
};
const strList =
  (maxItems: number, maxLength: number): Check =>
  (v, name) => {
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || list.length > maxItems || !list.every((s) => typeof s === 'string' && s.length <= maxLength)) {
      throw bad(`${name} は文字列（${maxLength.toLocaleString()} 文字まで）の配列で、${maxItems} 個までです`);
    }
    return list;
  };
const object: Check = (v, name) => {
  if (!isRecord(v)) throw bad(`${name} はオブジェクトです`);
  return v;
};
const color: Check = (v, name) => {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw bad(`${name} は #rrggbb の色です`);
  return v;
};
/** A layer: its id from `listLayers` (or its name). */
const layer = str(500);

interface MethodSpec {
  /** Parameters by name: the check, and whether it must be given. */
  params: Record<string, [Check, boolean]>;
  /** Adds, removes or changes layers or the base map (refused when read-only). */
  mutating: boolean;
}

/**
 * The methods a parent page may call, with their parameters. Nothing here
 * edits features, saves, downloads or picks files: those stay with the person.
 */
export const METHODS: Readonly<Record<string, MethodSpec>> = {
  hello: { params: { events: [strList(10, 20), false] }, mutating: false },
  getView: { params: {}, mutating: false },
  setView: {
    params: { center: [lonLat, false], zoom: [num(0, 30), false], resolution: [num(1e-6, 1e8), false], rotation: [num(-360, 360), false], bbox: [bbox, false], duration: [num(0, 10_000), false] },
    mutating: false,
  },
  zoomTo: { params: { layer: [layer, true] }, mutating: false },
  listLayers: { params: {}, mutating: false },
  selectLayer: { params: { layer: [layer, true] }, mutating: false },
  getSelection: { params: { features: [bool, false] }, mutating: false },
  listBaseMaps: { params: {}, mutating: false },
  listTools: { params: {}, mutating: false },
  open: {
    params: { url: [str(4000), true], type: [oneOf('cog', 'file', 'wms', 'wmts', 'wfs', 'esri'), false], layer: [str(500), false], matrixSet: [str(200), false], format: [str(100), false] },
    mutating: true,
  },
  setVisible: { params: { layer: [layer, true], visible: [bool, true] }, mutating: true },
  setOpacity: { params: { layer: [layer, true], opacity: [num(0, 1), true] }, mutating: true },
  removeLayer: { params: { layer: [layer, true] }, mutating: true },
  setBaseMap: { params: { id: [str(200, 0), true] }, mutating: true },
  addShapes: {
    params: { wkt: [strList(1000, 200_000), false], geojson: [object, false], labels: [strList(1000, 200), false], name: [str(100), false], color: [color, false], zoom: [bool, false] },
    mutating: true,
  },
  runTool: { params: { id: [str(100), true], params: [object, false] }, mutating: true },
};

/** Events the viewer sends the parent page once it has said `hello`. */
export const EVENTS = ['ready', 'view', 'selection', 'layers', 'click'] as const;
export type EmbedEvent = (typeof EVENTS)[number];

/** Tools of the ツール menu a parent page may not run: ones that download files. */
const BLOCKED_TOOLS = new Set(['save-view']);

export const toolAllowed = (id: string): boolean => !BLOCKED_TOOLS.has(id);

/** The methods open to a parent page: all, or only those that change nothing when read-only. */
export function methodsFor(readOnly: boolean): string[] {
  return Object.entries(METHODS)
    .filter(([, spec]) => !readOnly || !spec.mutating)
    .map(([name]) => name);
}

export type RequestId = string | number;

export interface EmbedRequest {
  id: RequestId;
  method: string;
  params: Record<string, unknown>;
}

/** What a message read as a request became: the request, a refusal to answer, or null (not for us: ignored). */
export type ReadResult = { ok: true; request: EmbedRequest } | { ok: false; id: RequestId | null; error: EmbedError } | null;

const isPlain = (v: unknown): v is Record<string, unknown> => isRecord(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Characters of `value`'s JSON, or Infinity when it has none (cycles, BigInt) or passes `max`. */
function jsonLength(value: unknown, max: number): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : text.length > max ? Infinity : text.length;
  } catch {
    return Infinity;
  }
}

/** Reads a message as a request, checking its envelope, size, method and parameters. */
export function readRequest(data: unknown, readOnly = false): ReadResult {
  if (!isPlain(data) || data.type !== PROTOCOL || 'event' in data || 'result' in data || 'error' in data) return null;
  const id = (typeof data.id === 'string' && data.id.length > 0 && data.id.length <= MAX_ID) || (typeof data.id === 'number' && Number.isSafeInteger(data.id)) ? (data.id as RequestId) : null;
  const fail = (error: EmbedError): ReadResult => ({ ok: false, id, error });
  if (id === null) return fail(bad('id は文字列（100 文字まで）か整数です'));
  if (data.v !== VERSION) return fail(bad(`v は ${VERSION} です（このビューアのプロトコルの版）`));
  if (jsonLength(data, MAX_REQUEST) === Infinity) return fail(new EmbedError('too-large', `要求が大きすぎるか JSON にできません（${MAX_REQUEST.toLocaleString()} 文字まで）`));
  const method = data.method;
  if (typeof method !== 'string' || !Object.hasOwn(METHODS, method)) return fail(new EmbedError('unknown-method', `メソッド「${String(method).slice(0, 50)}」はありません。使えるもの: ${methodsFor(readOnly).join(', ')}`));
  const spec = METHODS[method];
  if (readOnly && spec.mutating) return fail(new EmbedError('read-only', `読み取り専用の埋め込みでは ${method} は使えません`));
  if (data.params !== undefined && data.params !== null && !isPlain(data.params)) return fail(bad('params はオブジェクトです'));
  const given = (data.params ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  try {
    for (const key of Object.keys(given)) if (!Object.hasOwn(spec.params, key)) throw bad(`${method} に ${key.slice(0, 50)} というパラメーターはありません（${Object.keys(spec.params).join(', ') || 'なし'}）`);
    for (const [key, [check, required]] of Object.entries(spec.params)) {
      if (given[key] === undefined) {
        if (required) throw bad(`${method} には ${key} が要ります`);
        continue;
      }
      params[key] = check(given[key], key);
    }
    if (method === 'addShapes' && params.wkt === undefined && params.geojson === undefined) throw bad('addShapes には wkt か geojson が要ります');
    if (method === 'setView' && params.bbox !== undefined && (params.center !== undefined || params.zoom !== undefined || params.resolution !== undefined)) throw bad('bbox と center・zoom・resolution は一緒に指定できません');
    if (method === 'hello' && Array.isArray(params.events) && !params.events.every((e) => (EVENTS as readonly string[]).includes(e as string))) throw bad(`events は ${EVENTS.join(' / ')} から選びます`);
  } catch (error) {
    return fail(error instanceof EmbedError ? error : bad(String(error)));
  }
  return { ok: true, request: { id, method, params } };
}

/** An answer, made plain (JSON) so nothing but data leaves the viewer; too large an answer is an error. */
export function answer(id: RequestId, result: unknown): Record<string, unknown> {
  const plain = result === undefined ? null : result;
  if (jsonLength(plain, MAX_RESULT) === Infinity) return failure(id, new EmbedError('too-large', `結果が大きすぎます（${MAX_RESULT.toLocaleString()} 文字まで）`));
  return { type: PROTOCOL, v: VERSION, id, result: JSON.parse(JSON.stringify(plain)) as unknown };
}

export function failure(id: RequestId, error: EmbedError): Record<string, unknown> {
  return { type: PROTOCOL, v: VERSION, id, error: { code: error.code, message: error.message } };
}

export function eventMessage(event: EmbedEvent, data: unknown): Record<string, unknown> {
  return { type: PROTOCOL, v: VERSION, event, data: JSON.parse(JSON.stringify(data ?? null)) as unknown };
}

/**
 * The link-shape parameters (link-shapes.ts) of an `addShapes` call: each WKT
 * (or coordinate) as a `geom`, the GeoJSON as `geojson`, then labels, name and color.
 */
export function shapeParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const wkt of (params.wkt as string[] | undefined) ?? []) out.append('geom', wkt);
  if (params.geojson !== undefined) out.append('geojson', JSON.stringify(params.geojson));
  for (const label of (params.labels as string[] | undefined) ?? []) out.append('label', label);
  if (typeof params.name === 'string') out.set('name', params.name);
  if (typeof params.color === 'string') out.set('color', params.color);
  return out;
}
