/**
 * ベクター投影変換: a copy of a layer to be written in another CRS. Features
 * stay in the map's projection (`EPSG:3857`) for display; the layer's CRS
 * decides what export writes. The Japanese CRSs (JGD2011, JGD2000, Tokyo, the
 * plane rectangular zones, UTM) are built in, so they work offline.
 */
import proj4 from 'proj4';
import type Geometry from 'ol/geom/Geometry.js';
import GeometryCollection from 'ol/geom/GeometryCollection.js';
import SimpleGeometry from 'ol/geom/SimpleGeometry.js';
import { register } from 'ol/proj/proj4.js';
import { epsgCode, projectionOf } from '../services/common.js';
import { webMercator, wgs84, type TargetCrs } from '../vector-write.js';
import { copyFields, type ProcessingInput, type ProcessingResult } from './common.js';

/** Origins (latitude, longitude in degrees) of the plane rectangular coordinate systems I–XIX. */
const zoneOrigins: Array<[number, number]> = [
  [33, 129.5], // I
  [33, 131], // II
  [36, 132 + 10 / 60], // III
  [33, 133.5], // IV
  [36, 134 + 20 / 60], // V
  [36, 136], // VI
  [36, 137 + 10 / 60], // VII
  [36, 138.5], // VIII
  [36, 139 + 50 / 60], // IX
  [40, 140 + 50 / 60], // X
  [44, 140.25], // XI
  [44, 142.25], // XII
  [44, 144.25], // XIII
  [26, 142], // XIV
  [26, 127.5], // XV
  [26, 124], // XVI
  [26, 131], // XVII
  [20, 136], // XVIII
  [26, 154], // XIX
];
const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX'];

/** A preset CRS with what is needed to use and write it offline. */
interface Preset {
  code: string;
  name: string;
  proj4?: string;
  wkt?: string;
}

const grs80 = 'SPHEROID["GRS_1980",6378137.0,298.257222101]';
const geogcs = {
  jgd2011: `GEOGCS["GCS_JGD_2011",DATUM["D_JGD_2011",${grs80}],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`,
  jgd2000: `GEOGCS["GCS_JGD_2000",DATUM["D_JGD_2000",${grs80}],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`,
  tokyo: 'GEOGCS["GCS_Tokyo",DATUM["D_Tokyo",SPHEROID["Bessel_1841",6377397.155,299.1528128]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]',
};
const jgd2011 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** ESRI WKT of a Transverse Mercator CRS. */
function tmercWkt(name: string, geog: string, lat0: number, lon0: number, k: number, x0: number): string {
  return `PROJCS["${name}",${geog},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",${x0.toFixed(1)}],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${lon0}],PARAMETER["Scale_Factor",${k}],PARAMETER["Latitude_Of_Origin",${lat0.toFixed(1)}],UNIT["Meter",1.0]]`;
}

const presets: Preset[] = [
  { code: 'EPSG:4326', name: 'WGS 84（経緯度）', wkt: wgs84.wkt! },
  { code: 'EPSG:3857', name: 'Web メルカトル', wkt: webMercator.wkt! },
  { code: 'EPSG:6668', name: 'JGD2011（経緯度）', proj4: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs', wkt: geogcs.jgd2011 },
  { code: 'EPSG:4612', name: 'JGD2000（経緯度）', proj4: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs', wkt: geogcs.jgd2000 },
  { code: 'EPSG:4301', name: '旧日本測地系 Tokyo（経緯度）', proj4: '+proj=longlat +ellps=bessel +towgs84=-146.414,507.337,680.507,0,0,0,0 +no_defs', wkt: geogcs.tokyo },
  ...zoneOrigins.map(([lat0, lon0], i): Preset => ({
    code: `EPSG:${6669 + i}`,
    name: `JGD2011 平面直角座標系 ${roman[i]} 系`,
    proj4: `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 ${jgd2011}`,
    wkt: tmercWkt(`JGD_2011_Japan_Zone_${i + 1}`, geogcs.jgd2011, lat0, lon0, 0.9999, 0),
  })),
  ...[51, 52, 53, 54, 55].map((zone, i): Preset => ({
    code: `EPSG:${6688 + i}`,
    name: `JGD2011 UTM ${zone}N`,
    proj4: `+proj=utm +zone=${zone} ${jgd2011}`,
    wkt: tmercWkt(`JGD_2011_UTM_Zone_${zone}N`, geogcs.jgd2011, 0, zone * 6 - 183, 0.9996, 500000),
  })),
  ...[51, 52, 53, 54, 55, 56].map((zone): Preset => ({
    code: `EPSG:${32600 + zone}`,
    name: `WGS 84 UTM ${zone}N`,
    proj4: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`,
    wkt: tmercWkt(`WGS_1984_UTM_Zone_${zone}N`, wgs84.wkt!, 0, zone * 6 - 183, 0.9996, 500000),
  })),
];

/** The CRSs offered for conversion, in order: code (`EPSG:6677`) and name. */
export const crsPresets: Array<{ code: string; name: string }> = presets.map(({ code, name }) => ({ code, name }));

/** Registers the built-in definitions of the preset CRSs with proj4 and OpenLayers. */
export function registerJapaneseCrs(): void {
  for (const preset of presets) if (preset.proj4) proj4.defs(preset.code, preset.proj4);
  register(proj4);
}

/**
 * The CRS to write a layer in, for an EPSG code (`EPSG:6677` or `6677`).
 * Codes that are not built in are resolved by {@link projectionOf} (which may
 * fetch a definition); their WKT comes from `lookup` when given.
 */
export async function targetCrs(code: string, lookup?: (code: string) => Promise<string | null>): Promise<TargetCrs> {
  const trimmed = code.trim();
  const epsg = epsgCode(/^\d+$/.test(trimmed) ? `EPSG:${trimmed}` : trimmed);
  if (epsg === null) throw new Error(`「${code}」は EPSG コードではありません（例: EPSG:6677）`);
  if (epsg === 4326) return wgs84;
  if (epsg === 3857) return webMercator;
  const full = `EPSG:${epsg}`;
  const projection = await projectionOf(full);
  if (!projection) throw new Error(`${full} の座標系の定義が見つかりません`);
  const preset = presets.find((p) => p.code === full);
  let wkt = preset?.wkt ?? null;
  if (wkt === null && lookup) {
    try {
      wkt = await lookup(full);
    } catch {
      wkt = null;
    }
  }
  return { projection: projection.getCode(), name: preset ? `${preset.name}（${full}）` : full, epsg, wkt };
}

/** Whether every coordinate of `geometry` is a finite number. */
function finite(geometry: Geometry): boolean {
  if (geometry instanceof GeometryCollection) return geometry.getGeometries().every(finite);
  if (geometry instanceof SimpleGeometry) return geometry.getFlatCoordinates().every(Number.isFinite);
  return true;
}

/**
 * A copy of `input` to be written in `crs`. Features keep their map
 * coordinates; those that cannot be expressed in `crs` (outside its area, so
 * the transformation fails) are left out.
 */
export function reproject(input: ProcessingInput, crs: TargetCrs): ProcessingResult {
  const features = [];
  let failed = 0;
  for (const feature of input.features) {
    const geometry = feature.getGeometry();
    if (geometry) {
      let ok: boolean;
      try {
        ok = finite(geometry.clone().transform('EPSG:3857', crs.projection));
      } catch {
        ok = false;
      }
      if (!ok) {
        failed++;
        continue;
      }
    }
    features.push(feature.clone());
  }
  const short = crs.epsg !== null ? `EPSG${crs.epsg}` : crs.projection.replace(/[^A-Za-z0-9]+/g, '');
  const notes = [`${features.length} 個の地物を ${crs.name} に変換しました`];
  if (failed > 0) notes.push(`${crs.name} に変換できない地物 ${failed} 個を除きました`);
  return { title: `${input.title}_${short}`, features, fields: copyFields(input.fields), crs, notes };
}
