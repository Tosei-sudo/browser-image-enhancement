/**
 * 「XY 座標からポイントを作成」: a point per row from two attribute columns
 * (longitude / latitude, or easting / northing in any CRS), like QGIS's
 * "Create points layer from table". Typically the input is a CSV table.
 */
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { get as getProjection, transform } from 'ol/proj.js';
import type { TargetCrs } from '../vector-write.js';
import { attributesOf, copyFields, type ProcessingInput, type ProcessingResult } from './common.js';

export interface XyOptions {
  /** Column of X (longitude, easting). */
  xField: string;
  /** Column of Y (latitude, northing). */
  yField: string;
  /** The CRS the values are in. */
  crs: TargetCrs;
}

/** A coordinate value: a number, or text holding one (full-width digits and thousands separators allowed); null when not one. */
export function coordinateValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value
    .trim()
    .replace(/[０-９．－＋]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/,/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  return Number(text);
}

export function xyToPoints(input: ProcessingInput, { xField, yField, crs }: XyOptions): ProcessingResult {
  if (!getProjection(crs.projection)) throw new Error(`${crs.name} の座標系の定義がありません`);
  const geographic = getProjection(crs.projection)!.getUnits() === 'degrees';
  const features: Feature[] = [];
  let missing = 0;
  let outside = 0;
  let swapped = 0;
  for (const row of input.features) {
    const x = coordinateValue(row.get(xField));
    const y = coordinateValue(row.get(yField));
    if (x === null || y === null) {
      missing++;
      continue;
    }
    if (geographic && (Math.abs(y) > 90 || Math.abs(x) > 180)) {
      if (Math.abs(x) <= 90 && Math.abs(y) <= 180) swapped++;
      outside++;
      continue;
    }
    const at = transform([x, y], crs.projection, 'EPSG:3857');
    if (!at.every(Number.isFinite)) {
      outside++;
      continue;
    }
    const feature = new Feature({ ...attributesOf(row), geometry: new Point(at) });
    features.push(feature);
  }
  const notes = [`ポイント ${features.length.toLocaleString()} 点を作成しました`];
  if (missing) notes.push(`X・Y が数値でない行 ${missing.toLocaleString()} 件を飛ばしました`);
  if (outside) notes.push(`座標系の範囲外の行 ${outside.toLocaleString()} 件を飛ばしました${swapped ? '（X と Y が逆かもしれません。X が経度、Y が緯度です）' : ''}`);
  return { title: `${input.title}_ポイント`, features, fields: copyFields(input.fields), crs, notes };
}
