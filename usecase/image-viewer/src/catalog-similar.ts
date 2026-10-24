/**
 * 「類似画像の検索」: images of an image catalog taken like a given one, for
 * comparison: the same sensor, an angle and an azimuth within a tolerance,
 * and a footprint over the same ground. The catalog is asked for the
 * sensor and the angles (and the footprint's extent); how much of the
 * footprint each one covers is measured here, and the list is ordered from
 * the most alike.
 */
import { emptySearch, type CatalogConfig, type CatalogRecord, type CatalogSearch } from './catalog.js';

/** How alike the images must be. */
export interface SimilarTolerance {
  /** Only the reference's sensor. */
  sameSensor: boolean;
  /** Degrees either side of the reference's angle; null for any angle. */
  angle: number | null;
  /** Degrees either side of the reference's azimuth (through north); null for any azimuth. */
  azimuth: number | null;
  /** The least share of the reference's footprint an image must cover, 0 to 1 (0: any overlap). */
  minOverlap: number;
}

export const defaultTolerance: SimilarTolerance = { sameSensor: true, angle: 5, azimuth: 20, minOverlap: 0 };

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** The catalog search for images like `reference` (dates and SQL of `base` kept). */
export function similarSearch(catalog: CatalogConfig, reference: CatalogRecord, tolerance: SimilarTolerance, base: CatalogSearch = emptySearch): CatalogSearch {
  const { fields } = catalog;
  const search: CatalogSearch = { ...base, sensor: '', maxAngle: null, azimuthFrom: null, azimuthTo: null };
  if (fields.sensor && tolerance.sameSensor && reference.sensor) search.sensor = reference.sensor;
  const parts: string[] = [];
  if (fields.angle && finite(reference.angle) && finite(tolerance.angle) && tolerance.angle >= 0) {
    parts.push(`${fields.angle} >= ${round(reference.angle - tolerance.angle)}`, `${fields.angle} <= ${round(reference.angle + tolerance.angle)}`);
  }
  if (fields.azimuth && finite(reference.azimuth) && finite(tolerance.azimuth) && tolerance.azimuth >= 0 && tolerance.azimuth < 180) {
    const wrap = (v: number) => round(((v % 360) + 360) % 360);
    // From > to goes through north (whereOf writes it as an OR).
    search.azimuthFrom = wrap(reference.azimuth - tolerance.azimuth);
    search.azimuthTo = wrap(reference.azimuth + tolerance.azimuth);
  }
  if (base.where.trim()) parts.push(`(${base.where.trim()})`);
  search.where = parts.join(' AND ');
  return search;
}

/** The difference of two directions in degrees, 0 to 180. */
export function azimuthDifference(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** One image found, with how much of the reference it covers. */
export interface SimilarImage {
  record: CatalogRecord;
  /** The share of the reference's footprint it covers, 0 to 1 (null when it could not be measured). */
  overlap: number | null;
  /** How unlike the reference it is: 0 is the same; the list goes from the smallest. */
  distance: number;
}

/**
 * The images like `reference` among `records`, the most alike first: the
 * reference itself and those covering less than `minOverlap` (or nothing) of
 * it left out. `overlapOf` measures the share of the reference an image's
 * footprint covers.
 */
export function rankSimilar(
  reference: CatalogRecord,
  records: CatalogRecord[],
  tolerance: SimilarTolerance,
  overlapOf: (record: CatalogRecord) => number | null,
): SimilarImage[] {
  const same = (r: CatalogRecord) =>
    r === reference || r.feature === reference.feature || (reference.id !== '' && r.id === reference.id) || (reference.source !== null && JSON.stringify(r.source) === JSON.stringify(reference.source));
  const found: SimilarImage[] = [];
  for (const record of records) {
    if (same(record)) continue;
    const overlap = overlapOf(record);
    if (overlap !== null && (overlap <= 0 || overlap < tolerance.minOverlap)) continue;
    // Each difference against its tolerance (or a natural scale without one), and the ground not shared.
    let distance = overlap === null ? 1 : 1 - overlap;
    if (finite(reference.angle) && finite(record.angle)) distance += Math.abs(record.angle - reference.angle) / (finite(tolerance.angle) && tolerance.angle > 0 ? tolerance.angle : 10);
    if (finite(reference.azimuth) && finite(record.azimuth)) distance += azimuthDifference(record.azimuth, reference.azimuth) / (finite(tolerance.azimuth) && tolerance.azimuth > 0 ? tolerance.azimuth : 45);
    if (reference.sensor && record.sensor !== reference.sensor) distance += 1;
    found.push({ record, overlap, distance });
  }
  return found.sort((a, b) => a.distance - b.distance);
}
