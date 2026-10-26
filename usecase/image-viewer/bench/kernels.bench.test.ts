/**
 * Times the viewer's heavy pixel loops on 12-megapixel (4000 × 3000) inputs, the
 * median of three runs after a warm-up: `npm run bench` (`ONLY=mosaic` to run
 * the ones whose name has that in it). Results are printed, not checked.
 */
import { test } from 'vitest';
import { evaluate, parseExpression } from '../src/band-math.js';
import { resampleMesh, meshOf, makeBlock } from '../src/composite.js';
import { resampleBands, distanceToEmpty, makeMosaicBlock } from '../src/mosaic.js';
import { reduceSamples } from '../src/reduce.js';
import { zoneStats, rasterizePolygon } from '../src/zonal.js';
import { traceContours } from '../src/contours.js';
import { viewshed } from '../src/viewshed.js';
import { phaseCorrelate } from '../src/align.js';
import { meanAndDeviation, changeMask, thresholdsOf, spreadOf } from '../src/change.js';
import { cutTiles } from '../src/tiff-stream.js';

const W = 4000, H = 3000, N = W * H;
function time(name: string, f: () => unknown, reps = 3) {
  f();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log(`${name.padEnd(48)} ${ts[ts.length >> 1].toFixed(0).padStart(6)} ms`);
}
let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const u16 = new Uint16Array(N * 3); for (let i = 0; i < u16.length; i++) u16[i] = (rnd() * 4000) | 0;
const f32 = Array.from({ length: 3 }, () => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = rnd() * 1000; return a; });
const band0 = new Uint16Array(N); for (let i = 0; i < N; i++) band0[i] = u16[i * 3];

test('kernels', () => {
  const only = process.env.ONLY;
  const run = (name: string, f: () => unknown, reps?: number) => { if (!only || name.includes(only)) time(name, f, reps); };
  const ndvi = parseExpression('(b - a) / (b + a)', ['a', 'b']);
  run('band-math ndvi 12MP', () => evaluate(ndvi, [f32[0], f32[1]], N));
  const complex = parseExpression('if(a > 500, sqrt(a * b) + abs(c - a), (a + b + c) / 3)', ['a', 'b', 'c']);
  run('band-math complex 12MP', () => evaluate(complex, f32, N));
  // an affine-ish lookup: rotate slightly
  const lookup = (xy: Float64Array) => { for (let k = 0; k < xy.length; k += 2) { const x = xy[k], y = xy[k + 1]; xy[k] = x * 0.999 + y * 0.01 + 3.2; xy[k + 1] = y * 0.999 - x * 0.01 + 20.7; } };
  const m = meshOf(lookup, 0, 0, W, H);
  const read1 = { data: band0, width: W, height: H, window: [0, 0, W, H] as [number, number, number, number], noData: 0, ...m };
  const out1 = new Uint16Array(N * 3);
  run('composite resampleMesh bilinear 1band 12MP', () => resampleMesh(read1, out1, W, H, 0, 3, 'bilinear', 65535));
  run('composite resampleMesh nearest 1band 12MP', () => resampleMesh(read1, out1, W, H, 0, 3, 'nearest', 65535));
  const blockW = 2048, blockH = 2048;
  const mb = meshOf(lookup, 0, 0, blockW, blockH);
  const readB = { ...read1, ...mb };
  run('composite makeBlock 3ch 2048² bilinear', () => makeBlock({ width: blockW, height: blockH, channels: [readB, readB, readB], type: { format: 1, bits: 16 }, resample: 'bilinear', tileSize: 256, tx0: 0, ty0: 0 }));
  const mread = { data: u16, width: W, height: H, window: [0, 0, W, H] as [number, number, number, number], bands: 3, noData: 0, zeroIsEmpty: false, ...m };
  const outM = new Float32Array(N * 3); const valid = new Uint8Array(N);
  run('mosaic resampleBands bilinear 3band 12MP', () => resampleBands(mread, outM, valid, W, H, 'bilinear'));
  run('mosaic resampleBands nearest 3band 12MP', () => resampleBands(mread, outM, valid, W, H, 'nearest'));
  for (let i = 0; i < N; i++) valid[i] = (i % W) > 100 && (i % W) < W - 300 ? 1 : 0;
  run('mosaic distanceToEmpty 12MP', () => distanceToEmpty(valid, W, H, 64));
  const mreadB = { ...mread, ...meshOf(lookup, 0, 0, blockW + 128, blockH + 128) };
  run('mosaic makeMosaicBlock 2 images feather 2048²', () => makeMosaicBlock({ width: blockW, height: blockH, pad: 64, bands: 3, type: { format: 1, bits: 16 }, overlap: 'priority', feather: 64, reads: [mreadB, mreadB], resample: 'bilinear', tileSize: 256, tx0: 0, ty0: 0 } as never));
  run('reduce f=4 3band 12MP', () => reduceSamples(u16, { x: 0, y: 0, w: W, h: H } as never, 4, 3, 0));
  run('zonal stats 3 bands 12MP', () => zoneStats(f32, null, (v) => v === 0));
  run('zonal stats median 1 band 12MP', () => zoneStats([f32[0]], null, () => false, true), 1);
  const ring: Array<[number, number]> = []; for (let k = 0; k < 2000; k++) { const a = (k / 2000) * Math.PI * 2; ring.push([2000 + Math.cos(a) * 1800 * (1 + 0.1 * Math.sin(a * 13)), 1500 + Math.sin(a) * 1400]); }
  run('zonal rasterizePolygon 2000 vertices 12MP', () => rasterizePolygon([ring], 0, 0, W, H));
  const dem = new Float32Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 500 + 300 * Math.sin(x / 300) * Math.cos(y / 250) + 20 * Math.sin(x / 17 + y / 23);
  const grid = { width: W, height: H, data: dem, noData: null, west: 139, north: 36, spacing: [1 / 3600, 1 / 3600] as [number, number] };
  run('contours 12MP interval 10', () => traceContours(grid, { window: [0, 0, W - 1, H - 1], stride: 1, interval: 10 }), 1);
  const vg = { west: 139, north: 36, dLon: 1 / 3600, dLat: 1 / 3600, width: 2000, height: 2000, heights: dem.subarray(0, 4_000_000) };
  run('viewshed 2000² (4MP) single thread', () => viewshed(vg, { lon: 139 + 1000 / 3600, lat: 36 - 1000 / 3600, observerHeight: 2, targetHeight: 0, radius: 40000, refraction: 0.13 } as never), 1);
  // Open ground seen from high up: every line runs its full length (the worst case before the height maxima).
  const open = new Float32Array(4_000_000); for (let y = 0; y < 2000; y++) for (let x = 0; x < 2000; x++) open[y * 2000 + x] = 100 + 2 * Math.sin(x / 50) * Math.sin(y / 70);
  run('viewshed 2000² open ground, observer 500 m', () => viewshed({ ...vg, heights: open }, { lon: 139 + 1000 / 3600, lat: 36 - 1000 / 3600, observerHeight: 500, targetHeight: 0, radius: 40000, refraction: 0.13 } as never), 1);
  const complex2 = parseExpression('min(a, b, 3) + clamp(ln(c), 0, 5)', ['a', 'b', 'c']);
  run('band-math min/clamp/ln 12MP', () => evaluate(complex2, f32, N));
  const pa = new Float32Array(512 * 512).map(() => rnd()); const pb = pa.slice();
  run('align phaseCorrelate 512²', () => phaseCorrelate(pa, pb, 512));
  run('change meanAndDeviation 12MP', () => meanAndDeviation(f32[0]));
  const th = thresholdsOf(f32[0], 500, null);
  run('change mask 12MP', () => changeMask(f32[0], th, 'increase' as never));
  run('change spreadOf 12MP', () => spreadOf(f32[0], 500), 1);
  run('cutTiles 3band u16 2048²', () => cutTiles(u16.subarray(0, 2048 * 2048 * 3), 2048, 2048, 3, 256, 0, 0, 65535));
});
