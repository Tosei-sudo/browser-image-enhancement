/**
 * Points to path (QGIS "Points to path"): the points of a layer joined into
 * lines, in the order of a field, one line per value of another field.
 */
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import { toLonLat } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { LonLat } from '../coordinates.js';
import { geodesicLength } from '../geodesic.js';
import type { Field } from '../services/index.js';
import { field, type ProcessingInput, type ProcessingResult } from './common.js';

/** Options of {@link pointsToLine}. */
export interface PointsToLineOptions {
  /** Field the points are joined in the order of; null keeps the layer's order. */
  orderField: string | null;
  /** Field whose values each make a line; null makes one line of all the points. */
  groupField: string | null;
}

/** A point with the values it is sorted and grouped by. */
interface Vertex {
  coordinate: Coordinate;
  order: unknown;
  group: unknown;
}

/** Whether a value counts as missing (sorted last). */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

/** A date value (epoch ms or a date string) as epoch ms; NaN when it is not one. */
function timeOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
}

/** A comparison of present values of a field of type `type` (unknown fields: numbers as numbers, others as text). */
function comparator(type: Field['type'] | undefined): (a: unknown, b: unknown) => number {
  const text = (a: unknown, b: unknown) => String(a).localeCompare(String(b), undefined, { numeric: true });
  if (type === 'date') {
    return (a, b) => {
      const ta = timeOf(a);
      const tb = timeOf(b);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.isNaN(ta) ? (Number.isNaN(tb) ? text(a, b) : 1) : -1;
      return ta - tb;
    };
  }
  if (type === 'integer' || type === 'double' || type === 'oid') {
    return (a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return Number.isNaN(na) ? (Number.isNaN(nb) ? text(a, b) : 1) : -1;
      return na - nb;
    };
  }
  if (type === undefined) {
    return (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : text(a, b));
  }
  return text;
}

/**
 * Joins the points of `input` into lines: sorted by `orderField` (dates as
 * times, numbers as numbers, text naturally; missing values last; ties keep
 * the layer's order), one line per value of `groupField` (missing values
 * making a group of their own). A multipoint gives its points in order.
 * Groups of fewer than two points make no line.
 */
export function pointsToLine(input: ProcessingInput, options: PointsToLineOptions): ProcessingResult {
  const { orderField, groupField } = options;
  const notes: string[] = [];
  const vertices: Vertex[] = [];
  let skipped = 0;
  for (const feature of input.features) {
    const geometry = feature.getGeometry();
    let coordinates: Coordinate[];
    if (geometry instanceof Point) coordinates = [geometry.getCoordinates()];
    else if (geometry instanceof MultiPoint) coordinates = geometry.getCoordinates();
    else {
      skipped++;
      continue;
    }
    const order = orderField ? feature.get(orderField) : null;
    const group = groupField ? (feature.get(groupField) ?? null) : null;
    for (const coordinate of coordinates) vertices.push({ coordinate, order, group });
  }
  if (skipped) notes.push(`点でない地物 ${skipped} 件を飛ばしました`);

  const orderType = orderField ? input.fields.find((f) => f.name === orderField) : undefined;
  const groupType = groupField ? input.fields.find((f) => f.name === groupField) : undefined;
  if (orderField) {
    const compare = comparator(orderType?.type);
    // Array.prototype.sort is stable: ties keep the layer's order.
    vertices.sort((a, b) => {
      const ea = isEmpty(a.order);
      const eb = isEmpty(b.order);
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return compare(a.order, b.order);
    });
  }

  // Groups in the order their first point appears in the layer.
  const groups = new Map<unknown, Vertex[]>();
  for (const vertex of vertices) {
    const list = groups.get(vertex.group);
    if (list) list.push(vertex);
    else groups.set(vertex.group, [vertex]);
  }

  const features: Feature[] = [];
  let short = 0;
  for (const [group, list] of groups) {
    if (list.length < 2) {
      short++;
      continue;
    }
    const coordinates = list.map((v) => v.coordinate);
    const properties: Record<string, unknown> = {};
    if (groupField) properties[groupField] = group;
    if (orderField) {
      properties.begin = list[0].order ?? null;
      properties.end = list[list.length - 1].order ?? null;
    }
    properties.points = list.length;
    properties.length_m = geodesicLength(coordinates.map((c) => toLonLat(c) as LonLat));
    const line = new Feature(properties);
    line.setGeometry(new LineString(coordinates));
    features.push(line);
  }
  if (short) notes.unshift(`点が 2 つ未満のグループ ${short} 件はラインにしませんでした`);
  notes.unshift(`ライン ${features.length} 本を作成しました`);

  const fields: Field[] = [];
  if (groupField) fields.push(field(groupField, groupType && groupType.type !== 'other' ? (groupType.type === 'oid' ? 'integer' : groupType.type) : 'string', groupType?.alias ?? groupField));
  if (orderField) {
    const type = orderType && orderType.type !== 'other' ? (orderType.type === 'oid' ? 'integer' : orderType.type) : 'string';
    fields.push(field('begin', type), field('end', type));
  }
  fields.push(field('points', 'integer'), field('length_m', 'double'));

  return { title: `${input.title}_ライン`, features, fields, crs: input.crs, notes };
}
