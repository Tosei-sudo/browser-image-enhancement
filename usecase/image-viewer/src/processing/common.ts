/**
 * What the processing tools share: their input (a vector layer's features in
 * the map's projection, `EPSG:3857`, with its fields), their result (a new
 * layer), and a local azimuthal equidistant projection on the WGS 84
 * ellipsoid, in which planar geometry is done near a place with distances
 * from its centre exact.
 */
import * as geographiclib from 'geographiclib-geodesic';
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import { toLonLat, fromLonLat } from 'ol/proj.js';
import type { LonLat } from '../coordinates.js';
import type { Field } from '../services/index.js';
import type { TargetCrs } from '../vector-write.js';

const { Geodesic } = ((geographiclib as unknown as { default?: typeof geographiclib }).default ?? geographiclib) as typeof geographiclib;
const WGS84 = Geodesic.WGS84;

/** A vector layer handed to a tool. */
export interface ProcessingInput {
  title: string;
  /** Features in `EPSG:3857`. */
  features: Feature[];
  fields: Field[];
  /** The CRS the layer is written in by default (its file's), when known. */
  crs?: TargetCrs;
}

/** What a tool makes: a new (temporary) layer. */
export interface ProcessingResult {
  title: string;
  /** Features in `EPSG:3857`. */
  features: Feature[];
  fields: Field[];
  /** The CRS the layer is written in by default; WGS 84 when absent. */
  crs?: TargetCrs;
  /** Lines for the status bar: what was made, what was skipped. */
  notes?: string[];
}

/** A field made by a tool (any attribute can be edited in a temporary layer). */
export function field(name: string, type: Field['type'], alias = name): Field {
  return { name, alias, type, editable: true, nullable: true };
}

/** Fields of the input, copied for the result (all editable, ids become ordinary integers). */
export function copyFields(fields: Field[]): Field[] {
  return fields.filter((f) => f.type !== 'other').map((f) => ({ ...f, type: f.type === 'oid' ? 'integer' : f.type, editable: true, codes: undefined }));
}

/** The attributes of `feature` (without its geometry). */
export function attributesOf(feature: Feature): Record<string, unknown> {
  const properties = { ...feature.getProperties() };
  delete properties[feature.getGeometryName()];
  return properties;
}

/** A local projection: WGS 84 longitude / latitude to metres on a plane, and back. */
export interface LocalProjection {
  center: LonLat;
  forward(lonLat: LonLat): [number, number];
  inverse(xy: [number, number]): LonLat;
}

/**
 * The azimuthal equidistant projection centred on `center`, on the WGS 84
 * ellipsoid (GeographicLib): the distance and direction of every point from
 * the centre are true. Away from the centre other distances stretch slowly
 * (under 0.1 % within about 300 km).
 */
export function aeqd(center: LonLat): LocalProjection {
  const [lon0, lat0] = center;
  return {
    center,
    forward([lon, lat]) {
      const r = WGS84.Inverse(lat0, lon0, lat, lon, Geodesic.DISTANCE | Geodesic.AZIMUTH);
      const s = r.s12 ?? 0;
      const azimuth = ((r.azi1 ?? 0) * Math.PI) / 180;
      return [s * Math.sin(azimuth), s * Math.cos(azimuth)];
    },
    inverse([x, y]) {
      const s = Math.hypot(x, y);
      if (s === 0) return [lon0, lat0];
      const r = WGS84.Direct(lat0, lon0, (Math.atan2(x, y) * 180) / Math.PI, s, Geodesic.LATITUDE | Geodesic.LONGITUDE | Geodesic.LONG_UNROLL);
      return [r.lon2!, r.lat2!];
    },
  };
}

/** Geodesic distance (m) and forward azimuth (degrees from north) from `a` to `b`. */
export function inverse(a: LonLat, b: LonLat): { distance: number; azimuth: number } {
  const r = WGS84.Inverse(a[1], a[0], b[1], b[0], Geodesic.DISTANCE | Geodesic.AZIMUTH);
  return { distance: r.s12 ?? 0, azimuth: r.azi1 ?? 0 };
}

/** The point `distance` metres from `from` towards `azimuth` (degrees from north), along the geodesic. */
export function direct(from: LonLat, azimuth: number, distance: number): LonLat {
  const r = WGS84.Direct(from[1], from[0], azimuth, distance, Geodesic.LATITUDE | Geodesic.LONGITUDE | Geodesic.LONG_UNROLL);
  return [r.lon2!, r.lat2!];
}

/** Applies `map` to every coordinate of a copy of `geometry`. */
function mapCoordinates(geometry: Geometry, map: (xy: [number, number]) => [number, number]): Geometry {
  const copy = geometry.clone();
  copy.applyTransform((input, output = input, stride = 2) => {
    for (let i = 0; i < input.length; i += stride) {
      const [x, y] = map([input[i], input[i + 1]]);
      output[i] = x;
      output[i + 1] = y;
    }
    return output;
  });
  return copy;
}

/** A copy of a map geometry (`EPSG:3857`) in the local projection's metres. */
export function toLocal(geometry: Geometry, projection: LocalProjection): Geometry {
  return mapCoordinates(geometry, (xy) => projection.forward(toLonLat(xy) as LonLat));
}

/** A copy of a geometry in the local projection's metres, back in the map's projection (`EPSG:3857`). */
export function fromLocal(geometry: Geometry, projection: LocalProjection): Geometry {
  return mapCoordinates(geometry, (xy) => fromLonLat(projection.inverse(xy)) as [number, number]);
}

/** The middle of a map extent (`EPSG:3857`) as longitude / latitude: the centre for {@link aeqd}. */
export function centerOf(extent: number[]): LonLat {
  return toLonLat([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]) as LonLat;
}
