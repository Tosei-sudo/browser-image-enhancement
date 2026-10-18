/**
 * Times the viewer's vector work on 100,000 features (polygons of 24 vertices,
 * a text, a number and a date each), the median of three runs after a
 * warm-up: `npm run bench` (`ONLY=fgb` to run the ones whose name has that in
 * it). Results are printed, not checked.
 */
import { test } from 'vitest';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import type { Field } from '../src/services/index.js';
import { fieldsOf } from '../src/services/wms.js';
import { readGeoJson, readShapefile } from '../src/vector-files.js';
import { readFgb, writeFgb } from '../src/vector-formats.js';
import { writeGeoJson, writeGeoPackage, writeShapefile } from '../src/vector-write.js';
import { readGeoPackage } from '../src/geopackage.js';
import { compareValues, display, toCsv } from '../src/table-text.js';
import { classesFor, categoriesFor, singleSpec, styleFunction } from '../src/vector-style.js';
import { painter } from '../src/gl-vector.js';

const N = Number(process.env.FEATURES ?? 100_000);
function time(name: string, f: () => unknown, reps = 3) {
  f();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    f();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`${name.padEnd(48)} ${ts[ts.length >> 1].toFixed(0).padStart(6)} ms`);
}
async function timeAsync(name: string, f: () => Promise<unknown>, reps = 3) {
  await f();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    await f();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`${name.padEnd(48)} ${ts[ts.length >> 1].toFixed(0).padStart(6)} ms`);
}
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;

function makeFeatures(): Feature[] {
  const out: Feature[] = [];
  const side = Math.ceil(Math.sqrt(N));
  for (let i = 0; i < N; i++) {
    const cx = 15000000 + (i % side) * 200;
    const cy = 4000000 + Math.floor(i / side) * 200;
    const ring: number[][] = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r = 60 + 30 * rnd();
      ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    ring.push(ring[0]);
    const geometry = i % 10 === 0 ? new MultiPolygon([[ring], [ring.map(([x, y]) => [x + 90, y])]]) : new Polygon([ring]);
    out.push(new Feature({ geometry, name: `地物${(rnd() * 5000) | 0}`, value: rnd() * 1000, made: Date.UTC(2020, 0, 1) + rnd() * 1e11 }));
  }
  return out;
}

test('vector', async () => {
  const only = process.env.ONLY;
  const run = (name: string, f: () => unknown, reps?: number) => {
    if (!only || name.includes(only)) time(name, f, reps);
  };
  const runAsync = async (name: string, f: () => Promise<unknown>, reps?: number) => {
    if (!only || name.includes(only)) await timeAsync(name, f, reps);
  };
  const features = makeFeatures();
  const fields: Field[] = [
    { name: 'name', alias: 'name', type: 'string', editable: false, nullable: true },
    { name: 'value', alias: 'value', type: 'double', editable: false, nullable: true },
    { name: 'made', alias: 'made', type: 'date', editable: false, nullable: true },
  ];

  const once = <T,>(name: string, f: () => T): T => {
    const t = performance.now();
    const out = f();
    console.log(`${name.padEnd(48)} ${(performance.now() - t).toFixed(0).padStart(6)} ms (once)`);
    return out;
  };
  const shp = once('write shapefile', () => writeShapefile('bench', features, fields));
  const part = (ext: string) => shp.find((f) => f.name.endsWith(ext))!.bytes;
  const fgb = once('write fgb', () => writeFgb('bench', features, fields));
  const geojson = once('write geojson', () => writeGeoJson(features, fields));
  const gpkg = await (async () => {
    const t = performance.now();
    const out = await writeGeoPackage('bench', features, fields);
    console.log(`${'write geopackage'.padEnd(48)} ${(performance.now() - t).toFixed(0).padStart(6)} ms (once)`);
    return out;
  })();
  console.log(`shp ${(part('.shp').length / 1e6).toFixed(1)} MB, fgb ${(fgb.length / 1e6).toFixed(1)} MB, geojson ${(geojson.length / 1e6).toFixed(1)} MB`);

  run('read shapefile', () => readShapefile('bench', { shp: part('.shp'), dbf: part('.dbf'), prj: new TextDecoder().decode(part('.prj')) }), 1);
  await runAsync('read fgb', () => readFgb(fgb, 'bench'), 1);
  await runAsync('read geopackage', async () => (await readGeoPackage(gpkg, 'bench'))[0].gpkg!.db.close(), 1);
  await runAsync('read geojson', () => readGeoJson(geojson, 'bench'), 1);

  run('fieldsOf', () => fieldsOf(features));
  run('table sort text', () => features.slice().sort((a, b) => compareValues(a.get('name'), b.get('name'), fields[0])), 1);
  run('table sort number', () => features.slice().sort((a, b) => compareValues(a.get('value'), b.get('value'), fields[1])));
  run('table search (3 columns)', () => features.filter((f) => fields.some((field) => display(field, f.get(field.name)).toLowerCase().includes('99'))), 1);
  run('table csv', () => toCsv(fields, features), 1);

  run('style categories (name)', () => categoriesFor(features, 'name'));
  run('style classes jenks (value)', () => classesFor(features, 'value', 'jenks', 7, 'reds'));
  const labelled = { ...singleSpec('#3366ff'), label: { ...singleSpec('#3366ff').label, field: 'name' } };
  const fn = styleFunction(labelled);
  run('style function + labels, all features', () => {
    for (const f of features) fn(f, 10);
  });
  const labelOnly = styleFunction(labelled, undefined, 0, false);
  run('label geometry (interior points), all features', () => {
    for (const f of features) {
      const out = labelOnly(f, 10);
      const s = Array.isArray(out) ? out[0] : out;
      const g = s?.getGeometryFunction()(f);
      void g;
    }
  });
  const paint = painter(classesSpec(features));
  run('gpu painter (graduated), all features', () => {
    for (const f of features) paint(f);
  });
});

function classesSpec(features: Feature[]) {
  const spec = singleSpec('#3366ff');
  return { ...spec, mode: 'graduated' as const, field: 'value', classes: classesFor(features, 'value', 'jenks', 7, 'reds') };
}
