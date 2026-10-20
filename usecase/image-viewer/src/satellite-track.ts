/**
 * The ground track and what a satellite can image (撮像可能範囲) over a
 * moment or a period, for the 「衛星パス」 panel (satellite-track-panel.ts):
 * the sub-satellite points, and on each side it can look to the band between
 * its smallest and largest off-nadir angle. The orbit comes from the TLE
 * (SGP4) as in the imaging plan (imaging-plan.ts).
 *
 * Coordinates are longitude, latitude. {@link wrapLine} and
 * {@link wrapPolygon} cut what crosses the antimeridian into pieces within
 * ±180°, for the 2D map.
 */
import { groundStateAt, satrecOf, sunElevation, type SatelliteSpec } from './imaging-plan.js';
import { ecefOf, type Xyz } from './imaging-plan-3d.js';

type LonLat = [number, number];

export interface TrackOptions {
  /** Seconds between samples (else chosen from the period). */
  step?: number;
  /** A smaller largest off-nadir angle than the satellite's own (degrees). */
  maxOffNadir?: number;
  /** Optical satellites reach only where the Sun is at least this high (degrees) at the sub-satellite point; undefined: always. */
  minSun?: number;
}

/** One band of the reach: the inner and outer edges, sample by sample (same length). */
export interface ReachBand {
  side: 'left' | 'right' | 'both';
  inner: LonLat[];
  outer: LonLat[];
}

export interface SatelliteTrack {
  sat: SatelliteSpec;
  from: number;
  to: number;
  /** The sample times (ms) and where the satellite is over the ground then. */
  times: number[];
  track: LonLat[];
  /** Height above the ellipsoid, metres. */
  heights: number[];
  ascending: boolean[];
  /** Whether the satellite can image at each sample (daylight, for optical ones when asked). */
  open: boolean[];
  /** The reach bands, each cut where it cannot image (`open`). */
  bands: ReachBand[];
  /** The off-nadir angles of the bands (degrees). */
  offNadir: { min: number; max: number };
}

/** Seconds between samples for a period: about 3000 samples, 10 s to 60 s apart. */
export function stepFor(ms: number): number {
  return Math.min(60, Math.max(10, Math.round(ms / 1000 / 3000)));
}

/**
 * The off-nadir angles (left positive) bounding each band a satellite can
 * image: both sides from the nadir in one band when it has no smallest angle,
 * else a band on each side it can look to.
 */
export function reachAngles(sat: SatelliteSpec, maxOffNadir = sat.maxOffNadir): Array<{ side: ReachBand['side']; inner: number; outer: number }> {
  const max = Math.max(0, Math.min(sat.maxOffNadir, maxOffNadir));
  const min = Math.min(max, Math.max(0, sat.minOffNadir));
  if (sat.lookSide === 'both' && min === 0) return [{ side: 'both', inner: -max, outer: max }];
  const sides = sat.lookSide === 'both' ? (['left', 'right'] as const) : [sat.lookSide];
  return sides.map((side) => (side === 'left' ? { side, inner: min, outer: max } : { side, inner: -min, outer: -max }));
}

/** The track and reach of `sat` from `from` to `to` (ms); null when its TLE cannot be read. */
export function satelliteTrack(sat: SatelliteSpec, from: number, to: number, options: TrackOptions = {}): SatelliteTrack | null {
  const satrec = satrecOf(sat);
  if (typeof satrec === 'string') return null;
  const step = (options.step ?? stepFor(to - from)) * 1000;
  const angles = reachAngles(sat, options.maxOffNadir);
  const offNadirs = angles.flatMap((a) => [a.inner, a.outer]);
  const result: SatelliteTrack = {
    sat,
    from,
    to,
    times: [],
    track: [],
    heights: [],
    ascending: [],
    open: [],
    bands: [],
    offNadir: { min: Math.min(...angles.map((a) => Math.abs(a.inner))), max: Math.max(...angles.map((a) => Math.abs(a.outer))) },
  };
  const edges = angles.map(() => ({ inner: [] as LonLat[], outer: [] as LonLat[] }));
  const n = Math.max(1, Math.ceil((to - from) / step));
  for (let i = 0; i <= n; i++) {
    const t = Math.min(to, from + i * step);
    const g = groundStateAt(satrec, t, offNadirs);
    if (!g) continue;
    result.times.push(t);
    result.track.push(g.lonLat);
    result.heights.push(g.height * 1000);
    result.ascending.push(g.ascending);
    result.open.push(options.minSun === undefined || sat.sar || sunElevation(g.lonLat, t) >= options.minSun);
    edges.forEach((e, k) => {
      e.inner.push(g.across[2 * k]);
      e.outer.push(g.across[2 * k + 1]);
    });
  }
  // Each band in runs of samples where the satellite can image.
  angles.forEach((a, k) => {
    let start = -1;
    for (let i = 0; i <= result.open.length; i++) {
      if (i < result.open.length && result.open[i]) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0 && i - start > 1) result.bands.push({ side: a.side, inner: edges[k].inner.slice(start, i), outer: edges[k].outer.slice(start, i) });
      start = -1;
    }
  });
  return result;
}

/** The sample nearest a moment, and where it is (null when there are none). */
export function sampleAt(track: SatelliteTrack, ms: number): number {
  let best = -1;
  let gap = Infinity;
  track.times.forEach((t, i) => {
    if (Math.abs(t - ms) < gap) [best, gap] = [i, Math.abs(t - ms)];
  });
  return best;
}

/** Longitudes made continuous (no jumps of more than 180°). */
function unwrapped(coords: readonly LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const [lon, lat] of coords) {
    const before = out[out.length - 1];
    out.push([before ? lon + Math.round((before[0] - lon) / 360) * 360 : lon, lat]);
  }
  return out;
}

/** Which copies of the world (…, −1, 0, 1, …: 360° apart) longitudes reach. */
function worlds(coords: readonly LonLat[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const [lon] of coords) [min, max] = [Math.min(min, lon), Math.max(max, lon)];
  const out: number[] = [];
  for (let k = Math.round(min / 360); k * 360 - 180 < max; k++) if (k * 360 + 180 > min) out.push(k);
  return out;
}

const cut = (a: LonLat, b: LonLat, x: number): LonLat => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];

/** A line (longitude, latitude) in pieces within ±180°, cut where it crosses the antimeridian. */
export function wrapLine(coords: readonly LonLat[]): LonLat[][] {
  const line = unwrapped(coords);
  const pieces: LonLat[][] = [];
  for (const k of worlds(line)) {
    const [w, e] = [k * 360 - 180, k * 360 + 180];
    const inside = (p: LonLat) => p[0] >= w && p[0] <= e;
    let piece: LonLat[] = [];
    const end = () => {
      if (piece.length > 1) pieces.push(piece.map(([lon, lat]) => [lon - k * 360, lat] as LonLat));
      piece = [];
    };
    line.forEach((p, i) => {
      const q = line[i - 1];
      if (inside(p)) {
        if (q && !inside(q)) piece.push(cut(q, p, q[0] < w ? w : e));
        piece.push(p);
      } else if (q && inside(q)) {
        piece.push(cut(q, p, p[0] < w ? w : e));
        end();
      }
    });
    end();
  }
  return pieces;
}

/** A ring (longitude, latitude; closed or not) in pieces within ±180°, clipped at the antimeridian. */
export function wrapPolygon(ring: readonly LonLat[]): LonLat[][] {
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  const all = unwrapped(open);
  const out: LonLat[][] = [];
  for (const k of worlds(all)) {
    // Sutherland–Hodgman against the two edges of this world.
    let poly = all;
    for (const [x, keep] of [
      [k * 360 - 180, (p: LonLat) => p[0] >= k * 360 - 180],
      [k * 360 + 180, (p: LonLat) => p[0] <= k * 360 + 180],
    ] as Array<[number, (p: LonLat) => boolean]>) {
      const next: LonLat[] = [];
      poly.forEach((p, i) => {
        const q = poly[(i + poly.length - 1) % poly.length];
        if (keep(p)) {
          if (!keep(q)) next.push(cut(q, p, x));
          next.push(p);
        } else if (keep(q)) next.push(cut(q, p, x));
      });
      poly = next;
    }
    if (poly.length < 3) continue;
    const shifted = poly.map(([lon, lat]) => [lon - k * 360, lat] as LonLat);
    shifted.push(shifted[0]);
    out.push(shifted);
  }
  return out;
}

/** A band as rings of up to `chunk` samples along it (each joined to the next), for drawing. */
export function bandRings(band: ReachBand, chunk = 30): LonLat[][] {
  const rings: LonLat[][] = [];
  const n = band.inner.length;
  for (let i = 0; i < n - 1; i += chunk) {
    const j = Math.min(n - 1, i + chunk);
    const inner = unwrapped(band.inner.slice(i, j + 1));
    const outer = unwrapped(band.outer.slice(i, j + 1));
    // The outer edge in the same world as the inner one.
    const shift = Math.round((inner[0][0] - outer[0][0]) / 360) * 360;
    rings.push([...inner, ...outer.reverse().map(([lon, lat]) => [lon + shift, lat] as LonLat), inner[0]]);
  }
  return rings;
}

/** A track for the 3D view: the orbit at its height, and the reach on the ground. */
export interface Track3d {
  name: string;
  color: string;
  /** ECEF metres, and the height of each point above the ellipsoid. */
  orbit: Xyz[];
  heights: number[];
  /** The reach as rings on the ground (longitude, latitude). */
  reach: LonLat[][];
  /** The satellite at the moment (single-moment tracks): where it is, where it goes, its nadir and a label. */
  at?: { position: Xyz; velocity: Xyz; aim: Xyz; label: string };
}

/** `track` for the 3D view, with the satellite at sample `at` (when given). */
export function track3d(track: SatelliteTrack, color: string, at?: { index: number; label: string }): Track3d {
  const orbit = track.track.map(([lon, lat], i) => ecefOf(lon, lat, track.heights[i]));
  const reach = track.bands.flatMap((b) => bandRings(b, 10));
  const result: Track3d = { name: track.sat.name, color, orbit, heights: track.heights.slice(), reach };
  if (at && at.index >= 0) {
    const i = at.index;
    const [a, b] = [orbit[Math.max(0, i - 1)], orbit[Math.min(orbit.length - 1, i + 1)]];
    const dt = (track.times[Math.min(orbit.length - 1, i + 1)] - track.times[Math.max(0, i - 1)]) / 1000 || 1;
    const [lon, lat] = track.track[i];
    result.at = { position: orbit[i], velocity: [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt], aim: ecefOf(lon, lat), label: at.label };
  }
  return result;
}
