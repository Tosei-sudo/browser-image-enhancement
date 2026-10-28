/**
 * AI results into the observations (観測記録): what a model found — in this
 * viewer (ツール → AI → 物体検出) or by an AI system elsewhere that keeps its
 * results in an Esri feature service (`config.json`'s `aiResultSources`, a
 * point or polygon layer, attribute names mapped by role) — recorded as
 * observation points.
 *
 * An image opened from the image catalog brings the results of its catalog
 * id from each source, shown as a layer; 「観測記録へ取り込み」 then records
 * the chosen ones (or all): a polygon by its centroid (a box also by its long
 * side), its class as a kind of the classification, its score as a level of
 * 確度. Results lying where the image already has a record are left out, so
 * importing twice does not record twice.
 */
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import { toLonLat } from 'ol/proj.js';
import { getDistance } from 'ol/sphere.js';
import { measure } from './transfer.js';

/** What an attribute of a result can be, by role. */
export const resultRoles = {
  imageId: '画像ID（カタログの画像 ID）',
  class: 'クラス',
  score: 'スコア（確信度）',
  time: '検出日時',
  model: 'モデル',
  length: '長さ（m）',
  heading: '向き（°）',
  note: '備考',
  id: '結果ID',
} as const;
export type ResultRole = keyof typeof resultRoles;

/** A level of 確度 a score reaches: the first whose `min` the score is at or above. */
export interface ScoreLevel {
  min: number;
  label: string;
}

/** How results become records: shared by every source (`aiImport`), each source can say its own. */
export interface ImportDefaults {
  /** The kind (種別, a path such as `船舶 > タンカー`) of each class; a class not given is looked up in the classification by name. */
  classes: Record<string, string>;
  /** Score (0–1) to 確度, highest first; null: from the store's levels (≥ 0.8 the second level, else the third). */
  confidences: ScoreLevel[] | null;
  /** Results scoring lower are left out. */
  minScore: number;
  /** The activity (活動) recorded. */
  activity: string;
}

export const defaultImport: ImportDefaults = { classes: {}, confidences: null, minScore: 0, activity: '' };

/** One `aiResultSources` entry: a layer an AI system elsewhere writes its results to. */
export interface AiResultSource extends Partial<ImportDefaults> {
  label: string;
  /** A point or polygon feature layer, `…/FeatureServer/0`. */
  url: string;
  token?: string;
  /** Attribute names by role; `imageId` is needed. */
  fields: Partial<Record<ResultRole, string>> & { imageId: string };
  /** Only these results (an SQL where clause), as `STATUS = 1`. */
  where?: string;
  /** The score a sure result has (1, or 100 for percentages). */
  scoreMax: number;
  /** At most this many results per image. */
  maxResults: number;
  /** False: results are read only when asked (ツール → AI → 観測記録へ取り込み), not when an image is opened. */
  auto: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);

/** Score levels (`[{ "min": 0.8, "label": "推定" }, …]`), highest first; null when none can be used. */
export function scoreLevelsOf(value: unknown, problems: string[], at: string): ScoreLevel[] | null {
  if (!Array.isArray(value)) return (problems.push(`${at} は配列で指定`), null);
  const out: ScoreLevel[] = [];
  value.forEach((v, i) => {
    if (!isRecord(v) || typeof v.min !== 'number' || !Number.isFinite(v.min) || typeof v.label !== 'string' || !v.label.trim()) {
      return void problems.push(`${at}[${i}] は { "min": 数, "label": 確度 } で指定`);
    }
    out.push({ min: v.min, label: v.label.trim() });
  });
  return out.length ? out.sort((a, b) => b.min - a.min) : null;
}

/** The import settings an object gives (`aiImport`, or a source's own); only what it says. */
function importOf(value: Record<string, unknown>, problems: string[], at: string): Partial<ImportDefaults> {
  const out: Partial<ImportDefaults> = {};
  if ('classes' in value) {
    if (isRecord(value.classes)) {
      out.classes = {};
      for (const [name, kind] of Object.entries(value.classes)) {
        if (typeof kind === 'string' && kind.trim()) out.classes[name] = kind.trim();
        else problems.push(`${at}.classes.${name} は種別（文字列）で指定`);
      }
    } else problems.push(`${at}.classes は { クラス: 種別 } で指定`);
  }
  if ('confidences' in value) out.confidences = scoreLevelsOf(value.confidences, problems, `${at}.confidences`);
  if ('minScore' in value) {
    if (typeof value.minScore === 'number' && Number.isFinite(value.minScore)) out.minScore = value.minScore;
    else problems.push(`${at}.minScore は数で指定`);
  }
  if ('activity' in value) {
    if (typeof value.activity === 'string') out.activity = value.activity.trim();
    else problems.push(`${at}.activity は文字列で指定`);
  }
  return out;
}

/** `aiImport`: how every AI result (this viewer's too) becomes a record. */
export function importDefaultsOf(value: unknown, problems: string[]): ImportDefaults {
  if (!isRecord(value)) return (problems.push('aiImport はオブジェクトで指定'), { ...defaultImport });
  return { ...defaultImport, ...importOf(value, problems, 'aiImport') };
}

/** One `aiResultSources` entry; null (with the reason in `problems`) when it cannot be used. */
export function aiResultSourceOf(value: unknown, problems: string[], index: number): AiResultSource | null {
  const at = `aiResultSources[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} はオブジェクトで指定`), null);
  const { label, url, token, fields, where, scoreMax, maxResults, auto } = value;
  if (typeof url !== 'string' || !/^(https?:)?\/\/|^\.{0,2}\//.test(url) || !/\/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.split('?', 1)[0])) {
    return (problems.push(`${at} の url は …/FeatureServer/0 のようなレイヤーの URL で指定`), null);
  }
  if (!isRecord(fields)) return (problems.push(`${at} に fields（役割ごとの属性名）なし`), null);
  const mapped: Partial<Record<ResultRole, string>> = {};
  for (const [role, name] of Object.entries(fields)) {
    if (!(role in resultRoles)) problems.push(`${at} の fields.${role} は使用不可の役割`);
    else if (isName(name)) mapped[role as ResultRole] = name;
    else problems.push(`${at} の fields.${role} は属性名（英数字と _）で指定`);
  }
  if (!mapped.imageId) return (problems.push(`${at} の fields.imageId（画像 ID の属性名）なし`), null);
  if (where !== undefined && typeof where !== 'string') problems.push(`${at} の where は文字列で指定`);
  const positive = (v: unknown, name: string, fallback: number) => {
    if (v === undefined) return fallback;
    if (typeof v === 'number' && v > 0) return v;
    problems.push(`${at} の ${name} は正の数で指定`);
    return fallback;
  };
  return {
    label: typeof label === 'string' && label ? label : `AI 結果 ${index + 1}`,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    fields: mapped as AiResultSource['fields'],
    ...(typeof where === 'string' && where.trim() ? { where: where.trim() } : {}),
    scoreMax: positive(scoreMax, 'scoreMax', 1),
    maxResults: Math.round(positive(maxResults, 'maxResults', 2000)),
    auto: auto !== false,
    ...importOf(value, problems, at),
  };
}

/** The where clause of an image's results. */
export function resultWhere(source: AiResultSource, imageId: string): string {
  const own = `${source.fields.imageId} = '${imageId.replace(/'/g, "''")}'`;
  return source.where ? `(${own}) AND (${source.where})` : own;
}

export type ResultAsk = (url: string, params: Record<string, string>, token?: string) => Promise<unknown>;

const format = new EsriJSON();
const WEB_MERCATOR = JSON.stringify({ wkid: 102100, latestWkid: 3857 });

/** The results of an image (its catalog id), in Web Mercator as the source's attributes say them; page by page up to `maxResults`. */
export async function fetchResults(source: AiResultSource, imageId: string, ask: ResultAsk): Promise<{ features: Feature[]; truncated: boolean }> {
  type Answer = { features?: unknown[]; exceededTransferLimit?: boolean };
  const base = { where: resultWhere(source, imageId), outFields: '*', returnGeometry: 'true', outSR: WEB_MERCATOR };
  const features: Feature[] = [];
  let json = (await ask(`${source.url}/query`, base, source.token)) as Answer;
  for (;;) {
    const page = format.readFeatures(json, { dataProjection: 'EPSG:3857', featureProjection: 'EPSG:3857' }) as Feature[];
    features.push(...page);
    if (!json.exceededTransferLimit || !page.length || features.length >= source.maxResults) break;
    try {
      json = (await ask(`${source.url}/query`, { ...base, resultOffset: String(features.length), resultRecordCount: String(Math.min(page.length, source.maxResults - features.length)) }, source.token)) as Answer;
    } catch {
      // No paging: what came first.
      return { features, truncated: true };
    }
  }
  return { features: features.slice(0, source.maxResults), truncated: features.length > source.maxResults || (json.exceededTransferLimit ?? false) };
}

/** An attribute read whatever the case of its name. */
function attribute(feature: Feature, name: string | undefined): unknown {
  if (!name) return undefined;
  const value = feature.get(name);
  if (value !== undefined) return value;
  const lower = name.toLowerCase();
  const key = feature.getKeys().find((k) => k.toLowerCase() === lower);
  return key ? feature.get(key) : undefined;
}

const numberOf = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const timeOf = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null) : null);
const textOf = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * The properties a result's feature gets, the same names this viewer's AI
 * layers use (`class`, `score`, `model`, `image_id`, …): the score on 0–1,
 * where it came from (`source`, `result_id`).
 */
export function resultProperties(feature: Feature, source: AiResultSource, image: { id: string; name: string; time: number | null }): Record<string, unknown> {
  const f = source.fields;
  const score = numberOf(attribute(feature, f.score));
  return {
    class: textOf(attribute(feature, f.class)),
    score: score === null ? null : Math.round((score / source.scoreMax) * 1e4) / 1e4,
    model: textOf(attribute(feature, f.model)),
    image: image.name,
    image_id: textOf(attribute(feature, f.imageId)) ?? image.id,
    image_time: image.time,
    detected_at: timeOf(attribute(feature, f.time)),
    length: numberOf(attribute(feature, f.length)),
    heading: numberOf(attribute(feature, f.heading)),
    note: textOf(attribute(feature, f.note)),
    source: source.label,
    result_id: textOf(attribute(feature, f.id) ?? feature.getId()),
  };
}

/** Where a result is recorded: a point as it is; a polygon at its centroid (of the largest part). Longitude / latitude. */
export function pointOf(geometry: Geometry | undefined): [number, number] | null {
  if (!geometry) return null;
  if (geometry instanceof Point) return toLonLat(geometry.getCoordinates()) as [number, number];
  const polygons = geometry instanceof Polygon ? [geometry] : geometry instanceof MultiPolygon ? geometry.getPolygons() : [];
  if (!polygons.length) {
    const extent = geometry.getExtent();
    return Number.isFinite(extent[0]) ? (toLonLat([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]) as [number, number]) : null;
  }
  const largest = polygons.reduce((a, b) => (b.getArea() > a.getArea() ? b : a));
  const ring = largest.getCoordinates()[0];
  // The centroid of the outer ring (Web Mercator is conformal: fine at the size of a thing), about its first corner, for precision.
  const [ox, oy] = ring[0];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const x0 = ring[i][0] - ox;
    const y0 = ring[i][1] - oy;
    const x1 = ring[i + 1][0] - ox;
    const y1 = ring[i + 1][1] - oy;
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-9) return toLonLat(largest.getInteriorPoint().getCoordinates().slice(0, 2)) as [number, number];
  return toLonLat([ox + cx / (3 * area), oy + cy / (3 * area)]) as [number, number];
}

/** The levels a score reaches when none are configured: ≥ 0.8 the second of the store's levels, else the third (a model's guess is never the first, 確定). */
export function defaultScoreLevels(levels: readonly string[]): ScoreLevel[] {
  if (levels.length >= 3) return [{ min: 0.8, label: levels[1] }, { min: 0, label: levels[2] }];
  if (levels.length === 2) return [{ min: 0, label: levels[1] }];
  return [];
}

/** The 確度 of a score: the first level it reaches ('' none, or no score). */
export function confidenceOf(score: number | null, levels: readonly ScoreLevel[]): string {
  if (score === null) return '';
  return levels.find((l) => score >= l.min)?.label ?? '';
}

/** One result as a record to make. */
export interface ImportItem {
  feature: Feature;
  lon: number;
  lat: number;
  class: string;
  kind: string;
  confidence: string;
  activity: string;
  note: string;
  length: number | null;
  heading: number | null;
}

/** What an import would record, and what it leaves out. */
export interface ImportPlan {
  items: ImportItem[];
  /** Scoring under the minimum. */
  low: number;
  /** Where the image already has a record. */
  recorded: number;
  /** Without a place. */
  placeless: number;
}

/** How near (m) an existing record makes a result one already recorded. */
export const RECORDED_METRES = 10;

/** The note a record gets: the class, the score and the model, then the result's own note. */
export function importNote(feature: Feature): string {
  const cls = textOf(feature.get('class')) ?? '';
  const score = numberOf(feature.get('score'));
  const model = textOf(feature.get('model')) ?? textOf(feature.get('source'));
  const own = textOf(feature.get('note'));
  return [`AI: ${cls}${score === null ? '' : ` ${score.toFixed(2)}`}${model ? `（${model}）` : ''}`, own].filter(Boolean).join(' ');
}

/**
 * The records an import makes of `features`: kinds by class, 確度 by score,
 * left out when scoring under `minScore` or lying within RECORDED_METRES of
 * one of `existing` (the image's records), unless `again`.
 */
export function importPlan(
  features: readonly Feature[],
  settings: { kinds: Record<string, string>; levels: readonly ScoreLevel[]; minScore: number; activity: string },
  existing: ReadonlyArray<{ lon: number; lat: number }>,
  again = false,
): ImportPlan {
  const plan: ImportPlan = { items: [], low: 0, recorded: 0, placeless: 0 };
  const taken = [...existing];
  for (const feature of features) {
    const score = numberOf(feature.get('score'));
    if (score !== null && score < settings.minScore) {
      plan.low++;
      continue;
    }
    const geometry = feature.getGeometry();
    const at = pointOf(geometry);
    if (!at) {
      plan.placeless++;
      continue;
    }
    if (!again && taken.some((o) => getDistance([o.lon, o.lat], at) <= RECORDED_METRES)) {
      plan.recorded++;
      continue;
    }
    taken.push({ lon: at[0], lat: at[1] });
    const cls = textOf(feature.get('class')) ?? '';
    const size = geometry ? measure(geometry) : null;
    const length = numberOf(feature.get('length')) ?? (size?.length != null ? Math.round(size.length * 10) / 10 : null);
    const heading = numberOf(feature.get('heading'));
    plan.items.push({
      feature,
      lon: at[0],
      lat: at[1],
      class: cls,
      kind: settings.kinds[cls] ?? cls,
      confidence: confidenceOf(score, settings.levels),
      activity: settings.activity,
      note: importNote(feature),
      length: length !== null && length > 0 ? length : null,
      heading: heading === null ? null : ((heading % 360) + 360) % 360,
    });
  }
  return plan;
}

/** The classes of `features`, most common first, with how many each. */
export function classCounts(features: readonly Feature[]): Array<{ class: string; count: number }> {
  const counts = new Map<string, number>();
  for (const f of features) {
    const cls = textOf(f.get('class')) ?? '';
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return [...counts].map(([cls, count]) => ({ class: cls, count })).sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}
