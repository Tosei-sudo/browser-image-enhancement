/**
 * Detections into a database: the AI layers' features (as the model made
 * them, as people corrected them, and ones people added) written to an Esri
 * feature layer, its attribute names mapped by role in `config.json`'s
 * `detectionOutputs`, as the image catalogs are.
 *
 * Each feature remembers what the model made (`ai_origin`) and what was sent
 * (`ai_sent`), so a transfer adds what is new, updates what was changed since
 * it was sent, and leaves the rest; and it says whether a feature is the
 * model's own, corrected, or added by hand.
 */
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import { toLonLat } from 'ol/proj.js';
import { geodesicArea } from '../geodesic.js';
import { getDistance } from 'ol/sphere.js';

/** What a feature's attribute can be written as, by role. */
export const transferRoles = {
  imageId: '画像ID',
  fileName: 'ファイル名',
  imageTime: '撮像日時',
  detectedAt: '検出日時',
  sentAt: '転記日時',
  class: 'クラス',
  classId: 'クラス番号',
  score: '確信度',
  model: 'モデル',
  status: '状態（AI・修正・手動）',
  lon: '経度',
  lat: '緯度',
  area: '面積（m²）',
  length: '長辺（m）',
  width: '短辺（m）',
  angle: '向き（°）',
  note: '備考',
} as const;
export type TransferRole = keyof typeof transferRoles;

/** Whether a feature is the model's own, corrected by a person, or added by a person. */
export type DetectionStatus = 'ai' | 'corrected' | 'manual';
export const statusLabels: Record<DetectionStatus, string> = { ai: 'AI', corrected: '修正', manual: '手動' };

/** One `detectionOutputs` entry. */
export interface DetectionOutput {
  label: string;
  /** The feature layer, `…/FeatureServer/0`. */
  url: string;
  token?: string;
  /** Attribute names by role; roles not given are not written. */
  fields: Partial<Record<TransferRole, string>>;
  /** The values written for each status (default AI, 修正, 手動). */
  statusValues: Record<DetectionStatus, string | number>;
  /** Attributes written as they are on every feature (`{ "SOURCE": "viewer" }`). */
  constants: Record<string, string | number | boolean | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);

/** One `detectionOutputs` entry; null (with the reason in `problems`) when it cannot be used. */
export function detectionOutputOf(value: unknown, problems: string[], index: number): DetectionOutput | null {
  const at = `detectionOutputs[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { label, url, token, fields, statusValues, constants } = value;
  if (typeof url !== 'string' || !/^(https?:)?\/\/|^\.{0,2}\//.test(url) || !/\/FeatureServer\/\d+\/?$/i.test(url.split('?', 1)[0])) {
    return (problems.push(`${at} の url は …/FeatureServer/0 のようなレイヤーの URL にしてください`), null);
  }
  if (!isRecord(fields)) return (problems.push(`${at} に fields（役割ごとの属性名）がありません`), null);
  const mapped: DetectionOutput['fields'] = {};
  for (const [role, name] of Object.entries(fields)) {
    if (!(role in transferRoles)) problems.push(`${at} の fields.${role} は使えない役割です`);
    else if (isName(name)) mapped[role as TransferRole] = name;
    else problems.push(`${at} の fields.${role} は属性名（英数字と _）にしてください`);
  }
  if (!Object.keys(mapped).length) return (problems.push(`${at} の fields に書き込む属性がありません`), null);
  const status: DetectionOutput['statusValues'] = { ai: 'AI', corrected: '修正', manual: '手動' };
  if (isRecord(statusValues)) {
    for (const key of ['ai', 'corrected', 'manual'] as const) {
      const v = statusValues[key];
      if (typeof v === 'string' || typeof v === 'number') status[key] = v;
    }
  }
  const fixed: DetectionOutput['constants'] = {};
  if (isRecord(constants)) {
    for (const [name, v] of Object.entries(constants)) {
      if (isName(name) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) fixed[name] = v as string | number | boolean | null;
      else problems.push(`${at} の constants.${name} は属性名と値（文字・数・真偽）にしてください`);
    }
  }
  return {
    label: typeof label === 'string' && label ? label : `転記先 ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped,
    statusValues: status,
    constants: fixed,
  };
}

/** What the model made, kept on the feature (not an attribute of the layer). */
const ORIGIN = 'ai_origin';
/** What was sent where, kept on the feature: `{ [url]: { id, signature } }`. */
const SENT = 'ai_sent';

/** The geometry as text, to the centimetre (Web Mercator), for comparing. */
function geometryText(geometry: Geometry | undefined): string {
  const flat = (geometry as unknown as { getFlatCoordinates?: () => number[] })?.getFlatCoordinates?.() ?? [];
  return flat.map((v) => v.toFixed(2)).join(',');
}

/** Marks a feature as the model made it (called when a detection layer is made). */
export function markOrigin(feature: Feature): void {
  feature.set(ORIGIN, { class: feature.get('class') ?? null, geometry: geometryText(feature.getGeometry()) }, true);
}

/** Whether a feature is the model's own, corrected (outline or class changed), or added by a person. */
export function statusOf(feature: Feature): DetectionStatus {
  const origin = feature.get(ORIGIN) as { class: unknown; geometry: string } | undefined;
  if (!origin) return 'manual';
  return origin.class === (feature.get('class') ?? null) && origin.geometry === geometryText(feature.getGeometry()) ? 'ai' : 'corrected';
}

/** A field of the target layer, as its REST description gives it. */
export interface TargetField {
  name: string;
  type: string;
  length?: number;
  editable?: boolean;
}

/** The size of a feature on the ground: area, and for a box (four corners) its long and short sides and their bearing. */
export function measure(geometry: Geometry): { area: number | null; length: number | null; width: number | null; angle: number | null } {
  const polygon = geometry instanceof Polygon ? geometry : geometry instanceof MultiPolygon ? geometry.getPolygon(0) : null;
  if (!polygon) return { area: null, length: null, width: null, angle: null };
  const rings = polygon.getCoordinates().map((ring) => ring.map((c) => toLonLat(c) as [number, number]));
  const area = rings.reduce((sum, ring, i) => sum + (i === 0 ? 1 : -1) * Math.abs(geodesicArea(ring).area), 0);
  const outer = rings[0];
  if (rings.length !== 1 || outer.length !== 5) return { area, length: null, width: null, angle: null };
  const a = getDistance(outer[0], outer[1]);
  const b = getDistance(outer[1], outer[2]);
  const [from, to] = a >= b ? [outer[0], outer[1]] : [outer[1], outer[2]];
  // Bearing of the long side, 0–180° clockwise from north.
  const φ1 = (from[1] * Math.PI) / 180;
  const φ2 = (to[1] * Math.PI) / 180;
  const Δλ = ((to[0] - from[0]) * Math.PI) / 180;
  const bearing = (Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)) * 180) / Math.PI;
  return { area, length: Math.max(a, b), width: Math.min(a, b), angle: Math.round(((bearing + 360) % 180) * 10) / 10 };
}

/** The value of each role for a feature (before it is fitted to the target's field types). */
export function roleValues(feature: Feature, now: number): Record<TransferRole, unknown> {
  const geometry = feature.getGeometry()!;
  const point = geometry instanceof Polygon ? geometry.getInteriorPoint() : geometry instanceof MultiPolygon ? geometry.getInteriorPoints().getPoint(0) : geometry instanceof Point ? geometry : null;
  const [lon, lat] = point ? toLonLat(point.getCoordinates().slice(0, 2)) : [null, null];
  const size = measure(geometry);
  const round = (v: number | null, digits: number) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
  return {
    imageId: feature.get('image_id') ?? null,
    fileName: feature.get('image') ?? null,
    imageTime: feature.get('image_time') ?? null,
    detectedAt: feature.get('detected_at') ?? null,
    sentAt: now,
    class: feature.get('class') ?? null,
    classId: feature.get('class_id') ?? null,
    score: feature.get('score') ?? null,
    model: feature.get('model') ?? null,
    status: statusOf(feature),
    lon: round(lon, 7),
    lat: round(lat, 7),
    area: round(size.area, 2),
    length: round(size.length, 2),
    width: round(size.width, 2),
    angle: feature.get('angle') ?? size.angle,
    note: feature.get('note') ?? null,
  };
}

/** A value fitted to an Esri field type: dates as milliseconds, numbers as numbers, text cut to the field's length. */
export function fitValue(value: unknown, field: TargetField): unknown {
  if (value === null || value === undefined || value === '') return null;
  switch (field.type) {
    case 'esriFieldTypeDate': {
      const ms = typeof value === 'number' ? value : Date.parse(String(value));
      return Number.isFinite(ms) ? ms : null;
    }
    case 'esriFieldTypeSmallInteger':
    case 'esriFieldTypeInteger':
    case 'esriFieldTypeBigInteger': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case 'esriFieldTypeSingle':
    case 'esriFieldTypeDouble': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'esriFieldTypeString': {
      const text = String(value);
      return field.length ? text.slice(0, field.length) : text;
    }
    default:
      return value;
  }
}

/** The attributes written for a feature (roles mapped, status as configured, constants added), fitted to the target's fields. */
export function transferAttributes(feature: Feature, output: DetectionOutput, fields: Map<string, TargetField>, now: number): Record<string, unknown> {
  const values = roleValues(feature, now);
  const attributes: Record<string, unknown> = {};
  for (const [role, name] of Object.entries(output.fields) as Array<[TransferRole, string]>) {
    const field = fields.get(name.toLowerCase());
    if (!field) continue;
    const value = role === 'status' ? output.statusValues[values.status as DetectionStatus] : values[role];
    attributes[field.name] = fitValue(value, field);
  }
  for (const [name, value] of Object.entries(output.constants)) {
    const field = fields.get(name.toLowerCase());
    if (field) attributes[field.name] = fitValue(value, field);
  }
  return attributes;
}

/** The mapped attribute names the target layer does not have (or cannot write). */
export function missingFields(output: DetectionOutput, fields: Map<string, TargetField>): string[] {
  return [...Object.values(output.fields), ...Object.keys(output.constants)].filter((name) => {
    const field = fields.get(name.toLowerCase());
    return !field || field.editable === false;
  });
}

/** What a transfer would do with a feature: add it, update what was sent, or leave it (sent and unchanged). */
export type TransferAction = { kind: 'add' } | { kind: 'update'; id: number } | { kind: 'same'; id: number };

/** What was sent of a feature, compared without the time of sending. */
export function signatureOf(attributes: Record<string, unknown>, geometry: object, sentAtField: string | undefined): string {
  const rest = { ...attributes };
  if (sentAtField) delete rest[sentAtField];
  return JSON.stringify([rest, geometry]);
}

export function actionOf(feature: Feature, url: string, signature: string): TransferAction {
  const sent = (feature.get(SENT) as Record<string, { id: number; signature: string }> | undefined)?.[url];
  if (!sent) return { kind: 'add' };
  return sent.signature === signature ? { kind: 'same', id: sent.id } : { kind: 'update', id: sent.id };
}

/** Remembers that a feature was written to `url` as object `id`. */
export function markSent(feature: Feature, url: string, id: number, signature: string): void {
  const sent = { ...((feature.get(SENT) as Record<string, unknown> | undefined) ?? {}), [url]: { id, signature } };
  feature.set(SENT, sent, true);
}

/** The geometry written to a layer of `geometryType`: polygons as they are, a point layer gets the polygon's inner point. */
export function targetGeometry(geometry: Geometry, geometryType: string): Geometry | null {
  if (geometryType === 'esriGeometryPolygon') return geometry instanceof Polygon || geometry instanceof MultiPolygon ? geometry : null;
  if (geometryType === 'esriGeometryPoint') {
    if (geometry instanceof Point) return geometry;
    if (geometry instanceof Polygon) return new Point(geometry.getInteriorPoint().getCoordinates().slice(0, 2));
    if (geometry instanceof MultiPolygon) return new Point(geometry.getInteriorPoints().getPoint(0).getCoordinates().slice(0, 2));
  }
  return null;
}
