/**
 * WCS 2.0 (2.0.1 or 2.0.0): the coverages of GetCapabilities, read with
 * GetCoverage as a GeoTIFF of the area asked for (subset in the coverage's
 * own CRS and axes, from DescribeCoverage), scaled down with the scaling
 * extension when the area holds more pixels than the caps (or refused when
 * the server has no scaling), and opened like a local GeoTIFF.
 */
import { transformExtent } from 'ol/proj.js';
import { getIntersection, type Extent } from 'ol/extent.js';
import {
  childText,
  children,
  descendants,
  projectionOf,
  requestXml,
  ServiceError,
  withParams,
  type LayerChoice,
  type OpenContext,
  type OpenPick,
  type ServiceCatalog,
} from './common.js';
import { areaInDegrees, fetchGeoTiff, fitScale, withFileName } from './coverage.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const SCALING = /WCS_service-extension_scaling\/1\.0\/conf\/scaling/;

/** What DescribeCoverage says of a coverage's grid. */
export interface CoverageGrid {
  id: string;
  crs: string;
  /** Axis labels, in the order of the corners. */
  labels: string[];
  lower: number[];
  upper: number[];
  /** Cells along each axis (same order), when known. */
  size: Array<number | null>;
  /** Which axis is east-west (x); the other two-dimensional one is north-south. */
  x: number;
  y: number;
}

/** A GetCoverage request worked out: the subset per axis, its pixel size, and the scale factor (1: none). */
export interface CoveragePlan {
  subsets: Array<[label: string, low: number, high: number]>;
  width: number | null;
  height: number | null;
  scale: number;
}

/** Reads WCS capabilities at `url`. */
export async function readWcs(url: string): Promise<ServiceCatalog> {
  const doc = await requestXml(withParams(url, { SERVICE: 'WCS', REQUEST: 'GetCapabilities', ACCEPTVERSIONS: '2.0.1,2.0.0' }));
  const root = doc.documentElement;
  if (root.localName !== 'Capabilities' || !/\/wcs\/2\.0/.test(root.namespaceURI ?? '')) throw new ServiceError('WCS 2.0 の GetCapabilities 以外');
  const version = root.getAttribute('version') ?? '2.0.1';
  const operation = (name: string) => descendants(doc, 'Operation').find((o) => o.getAttribute('name') === name);
  const href = (name: string) => (operation(name) ? descendants(operation(name)!, 'Get')[0]?.getAttributeNS(XLINK, 'href') : null) || url;
  const profiles = descendants(doc, 'Profile').map((p) => p.textContent?.trim() ?? '');
  const scaling = profiles.some((p) => SCALING.test(p));
  const formats = descendants(doc, 'formatSupported').map((f) => f.textContent?.trim() ?? '');
  const format = formats.find((f) => f === 'image/tiff') ?? formats.find((f) => /tiff/i.test(f)) ?? 'image/tiff';
  const summaries = descendants(doc, 'CoverageSummary');
  const choices: LayerChoice[] = summaries
    .map((s) => {
      const id = childText(s, 'CoverageId') ?? childText(s, 'Identifier') ?? '';
      return { name: id, title: childText(s, 'Title') ?? id, abstract: childText(s, 'Abstract'), area: 'raster' as const };
    })
    .filter((c) => c.name);
  if (choices.length === 0) throw new ServiceError('カバレッジなし');
  const ep = { describe: href('DescribeCoverage'), get: href('GetCoverage'), version, format, scaling };
  return {
    kind: 'wcs',
    url,
    title: descendants(doc, 'ServiceIdentification').map((s) => childText(s, 'Title'))[0] ?? url,
    choices,
    open: async (choice, context, pick = {}) => {
      await openCoverage(choice, ep, context, pick);
      return null;
    },
  };
}

async function openCoverage(choice: LayerChoice, ep: { describe: string; get: string; version: string; format: string; scaling: boolean }, context: OpenContext, pick: OpenPick): Promise<void> {
  if (!context.openRaster) throw new ServiceError('画像として表示不可');
  const doc = await requestXml(withParams(ep.describe, { SERVICE: 'WCS', VERSION: ep.version, REQUEST: 'DescribeCoverage', COVERAGEID: choice.name }));
  const grid = coverageGrid(doc, choice.name);
  const projection = await projectionOf(grid.crs);
  if (!projection) throw new ServiceError(`${grid.crs} に非対応`);
  const degrees = areaInDegrees(context, pick);
  const area = degrees ? transformExtent(degrees, 'EPSG:4326', projection) : null;
  const plan = coveragePlan(grid, area, ep.scaling);
  const url = getCoverageUrl(ep.get, ep.version, grid.id, ep.format, plan);
  context.say(`${choice.title} の画素値を読み込み中…${plan.width && plan.height ? `（${Math.round(plan.width * plan.scale)} × ${Math.round(plan.height * plan.scale)} 画素）` : ''}`);
  const file = await fetchGeoTiff(url, grid.id);
  await context.openRaster(file, withFileName(url, file.name));
}

/** The grid of coverage `id` in a DescribeCoverage document. */
export function coverageGrid(doc: Document, id: string): CoverageGrid {
  const description = descendants(doc, 'CoverageDescription').find((d) => childText(d, 'CoverageId') === id) ?? descendants(doc, 'CoverageDescription')[0];
  if (!description) throw new ServiceError('DescribeCoverage の読み込みに失敗');
  const envelope = descendants(description, 'Envelope')[0] ?? descendants(description, 'EnvelopeWithTimePeriod')[0];
  if (!envelope) throw new ServiceError('カバレッジの範囲が不明');
  const numbers = (s: string | undefined) => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  const lower = numbers(childText(envelope, 'lowerCorner'));
  const upper = numbers(childText(envelope, 'upperCorner'));
  const labels = (envelope.getAttribute('axisLabels') ?? '').trim().split(/\s+/).filter(Boolean);
  if (lower.length < 2 || lower.length !== upper.length || lower.some((n) => !Number.isFinite(n))) throw new ServiceError('カバレッジの範囲の読み込みに失敗');
  while (labels.length < lower.length) labels.push(['x', 'y', 'z', 't'][labels.length] ?? `a${labels.length}`);
  const crs = envelope.getAttribute('srsName') ?? '';

  // Cells per CRS axis: each offset vector moves along one CRS axis (GeoServer's grid is i, j whatever the CRS order).
  const size: Array<number | null> = labels.map(() => null);
  const rectified = descendants(description, 'RectifiedGrid')[0] ?? descendants(description, 'Grid')[0];
  if (rectified) {
    const low = numbers(descendants(rectified, 'low')[0]?.textContent ?? '');
    const high = numbers(descendants(rectified, 'high')[0]?.textContent ?? '');
    const counts = high.map((h, i) => h - (low[i] ?? 0) + 1);
    const offsets = children(rectified, 'offsetVector').map((o) => numbers(o.textContent ?? ''));
    counts.forEach((count, k) => {
      const offset = offsets[k];
      const axis = offset?.length === labels.length ? offset.reduce((best, v, i) => (Math.abs(v) > Math.abs(offset[best]) ? i : best), 0) : k;
      if (axis < size.length && Number.isFinite(count) && count > 0) size[axis] = count;
    });
  }
  const yLike = (label: string) => /^(lat|latitude|y|n|north|northing|row|j)$/i.test(label);
  const xLike = (label: string) => /^(lon|long|longitude|x|e|east|easting|col|column|i)$/i.test(label);
  let x = labels.findIndex(xLike);
  let y = labels.findIndex(yLike);
  if (x < 0 && y < 0) [x, y] = [0, 1];
  else if (x < 0) x = y === 0 ? 1 : 0;
  else if (y < 0) y = x === 0 ? 1 : 0;
  return { id: childText(description, 'CoverageId') ?? id, crs, labels, lower, upper, size, x, y };
}

/**
 * The subsets for `area` (x, y in the coverage CRS; all of it when null),
 * clipped to the coverage, and the scale that keeps it within the caps.
 * Without `scaling`, an area over the caps is refused.
 */
export function coveragePlan(grid: CoverageGrid, area: Extent | null, scaling: boolean): CoveragePlan {
  const full: Extent = [grid.lower[grid.x], grid.lower[grid.y], grid.upper[grid.x], grid.upper[grid.y]];
  const box = area ? getIntersection(full, area) : full;
  if (!(box[2] > box[0] && box[3] > box[1])) throw new ServiceError('範囲とカバレッジの重なりなし');
  const cells = (axis: number, span: number) => {
    const n = grid.size[axis];
    const whole = grid.upper[axis] - grid.lower[axis];
    return n && whole > 0 ? Math.max(1, Math.round((n * span) / whole)) : null;
  };
  const width = cells(grid.x, box[2] - box[0]);
  const height = cells(grid.y, box[3] - box[1]);
  const scale = width && height ? fitScale(width, height) : 1;
  if (scale < 1 && !scaling) {
    throw new ServiceError(`範囲が大きすぎ（${width!.toLocaleString()} × ${height!.toLocaleString()} 画素）。サーバーが縮小に対応していないため、表示範囲の縮小が必要`);
  }
  const subsets: CoveragePlan['subsets'] = area
    ? [
        [grid.labels[grid.x], box[0], box[2]],
        [grid.labels[grid.y], box[1], box[3]],
      ]
    : [];
  return { subsets, width, height, scale };
}

/** The GetCoverage KVP request of a plan (GeoTIFF in `format`). */
export function getCoverageUrl(endpoint: string, version: string, id: string, format: string, plan: CoveragePlan): string {
  const u = new URL(endpoint, globalThis.location?.href);
  for (const key of [...u.searchParams.keys()]) if (/^(service|version|request|coverageid|format|subset|scalefactor)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.set('SERVICE', 'WCS');
  u.searchParams.set('VERSION', version);
  u.searchParams.set('REQUEST', 'GetCoverage');
  u.searchParams.set('COVERAGEID', id);
  u.searchParams.set('FORMAT', format);
  const n = (v: number) => String(+v.toPrecision(12));
  for (const [label, low, high] of plan.subsets) u.searchParams.append('SUBSET', `${label}(${n(low)},${n(high)})`);
  if (plan.scale < 1) u.searchParams.set('SCALEFACTOR', String(Math.floor(plan.scale * 1e6) / 1e6));
  return u.href;
}
