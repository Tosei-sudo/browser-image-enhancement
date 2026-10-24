/**
 * Cloud cover forecasts for the imaging plan's optical shots: a forecast
 * service of `config.json`'s `cloudForecast` (Open-Meteo by default, or one
 * answering the same way inside a closed network) is asked for the hourly
 * cloud cover at the targets, and each shot is told the cover at its moment.
 *
 * Nothing is asked until the person turns the forecast on in the panel, as
 * the targets' places go to the service.
 */
import type { Opportunity, PlanTarget, SatelliteSpec } from './imaging-plan.js';

/** `config.json`'s `cloudForecast`: an Open-Meteo-style forecast API. */
export interface CloudForecastConfig {
  /** The forecast endpoint (`…/v1/forecast`). */
  url: string;
  /** Its name in the panel. */
  label: string;
}

export const defaultCloudForecast: CloudForecastConfig = { url: 'https://api.open-meteo.com/v1/forecast', label: 'Open-Meteo' };

/** How far ahead forecasts reach, days. */
export const FORECAST_DAYS = 16;
/** Places closer than this (degrees) share one forecast. */
const GRID = 0.25;
/** The most places asked for in one request. */
const PER_REQUEST = 50;

/** `config.json`'s `cloudForecast`: an object with `url` (and `label`), or false for none. */
export function cloudForecastOf(value: unknown, problems: string[]): CloudForecastConfig | null {
  if (value === false || value === null) return null;
  if (typeof value === 'object' && value && !Array.isArray(value)) {
    const { url, label } = value as Record<string, unknown>;
    if (typeof url === 'string' && /^(https?:)?\/\/|^\.{0,2}\//.test(url)) return { url, label: typeof label === 'string' && label ? label : '雲量予報' };
  }
  problems.push('cloudForecast は { "url": "…/v1/forecast" } か false で指定');
  return defaultCloudForecast;
}

/** One place's hourly cloud cover: times (ms) and percents. */
export interface CloudSeries {
  times: number[];
  cover: number[];
}

/** The cover at `ms`, between the hours either side; null outside the forecast. */
export function cloudAt(series: CloudSeries, ms: number): number | null {
  const { times, cover } = series;
  if (!times.length || ms < times[0] || ms > times[times.length - 1]) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const [a, b] = [cover[lo], cover[hi]];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : Number.isFinite(b) ? b : null;
  const f = times[hi] === times[lo] ? 0 : (ms - times[lo]) / (times[hi] - times[lo]);
  return a + (b - a) * f;
}

/** The key of the grid cell a place falls in. */
const keyOf = ([lon, lat]: [number, number]) => `${Math.round(lat / GRID) * GRID},${Math.round(lon / GRID) * GRID}`;

/** Reads one place's series from a response entry. */
function seriesOf(entry: unknown): CloudSeries | null {
  const hourly = (entry as { hourly?: { time?: unknown; cloud_cover?: unknown } } | null)?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.cloud_cover)) return null;
  const times = hourly.time.map((t) => (typeof t === 'number' ? t * 1000 : Date.parse(`${String(t)}Z`)));
  const cover = hourly.cloud_cover.map((v) => (typeof v === 'number' ? v : Number.NaN));
  return { times, cover };
}

/** The forecasts for places (longitude, latitude), by grid cell, asked for in batches. */
export async function fetchClouds(config: CloudForecastConfig, places: Array<[number, number]>, fetcher: typeof fetch = fetch): Promise<Map<string, CloudSeries>> {
  const cells = new Map<string, [number, number]>();
  for (const p of places) {
    const key = keyOf(p);
    if (!cells.has(key)) cells.set(key, key.split(',').map(Number).reverse() as [number, number]);
  }
  const out = new Map<string, CloudSeries>();
  const keys = [...cells.keys()];
  for (let i = 0; i < keys.length; i += PER_REQUEST) {
    const batch = keys.slice(i, i + PER_REQUEST);
    const params = new URLSearchParams({
      latitude: batch.map((k) => cells.get(k)![1].toFixed(2)).join(','),
      longitude: batch.map((k) => cells.get(k)![0].toFixed(2)).join(','),
      hourly: 'cloud_cover',
      forecast_days: String(FORECAST_DAYS),
      timezone: 'GMT',
      timeformat: 'unixtime',
    });
    const response = await fetcher(`${config.url}${config.url.includes('?') ? '&' : '?'}${params}`);
    if (!response.ok) throw new Error(`${config.label} が ${response.status} を返却`);
    const json = (await response.json()) as unknown;
    const entries = Array.isArray(json) ? json : [json];
    batch.forEach((key, k) => {
      const series = seriesOf(entries[k]);
      if (series) out.set(key, series);
    });
  }
  return out;
}

/**
 * Tells the optical satellites' opportunities the forecast cover at their
 * moment (`cloud`, percent); those outside the forecast, or of SAR
 * satellites, are left without. Returns how many were told.
 */
export function applyClouds(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], forecasts: Map<string, CloudSeries>): number {
  let n = 0;
  for (const op of ops) {
    delete op.cloud;
    if (sats[op.satellite]?.sar) continue;
    const series = forecasts.get(keyOf(targets[op.target].center));
    const cover = series ? cloudAt(series, op.time) : null;
    if (cover !== null) {
      op.cloud = Math.round(cover);
      n++;
    }
  }
  return n;
}

/** The places whose forecasts the optical opportunities need (those within the forecast's reach of `now`). */
export function placesFor(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], now = Date.now()): Array<[number, number]> {
  const until = now + FORECAST_DAYS * 86400000;
  const seen = new Set<number>();
  for (const op of ops) if (!sats[op.satellite]?.sar && op.time >= now - 3600000 && op.time <= until) seen.add(op.target);
  return [...seen].map((t) => targets[t].center);
}
