/**
 * One block of a classification, made off the main thread: the bands looked
 * up on the output grid through their meshes (as an RGB composite's are, see
 * composite.ts), or taken as read when the grid is the image's own, then
 * either sampled (k-means, training statistics) or put in
 * classes and cut into the tiles of the two GeoTIFFs being written: the class
 * numbers and their colors. Pixels are put in classes in WebAssembly
 * (classify-wasm.ts) where it runs, else in JS (classify.ts).
 */
import { accumulate, classify, colorClasses, emptyStats, random, rasterizePolygons, samplePixels, type ClassModel, type ClassStats } from './classify.js';
import { resampleMesh, type ChannelRead, type Resampling } from './composite.js';
import { cutTiles, type Tile } from './tiff-stream.js';
import { classifyWasm } from './classify-wasm.js';

interface BlockInput {
  width: number;
  height: number;
  /** One per band; null where the image does not reach the block. */
  inputs: Array<ChannelRead | null>;
  resample: Resampling;
  /** The bands as read, one value per pixel of the block (the grid is the image's own): used instead of `inputs`. */
  direct?: { bands: ArrayLike<number>[]; noData: number | null };
}

/** Pass 1: a sample of the pixels (k-means), or the statistics of the training polygons. */
export interface SampleTask extends BlockInput {
  op: 'sample';
  /** Pixels to sample (0: none). */
  count: number;
  seed: number;
  /** Training polygons in the block's pixels, by 1-based class; `classes` of them. */
  polygons?: Array<{ label: number; rings: Float64Array[] }>;
  classes?: number;
}

export interface SampleResult {
  samples: Float32Array;
  stats: ClassStats | null;
}

/** Pass 2: every pixel in a class. */
export interface ClassifyTask extends BlockInput {
  op: 'classify';
  model: ClassModel;
  colors: Array<[number, number, number]>;
  tileSize: number;
  tx0: number;
  ty0: number;
  /** false: JS only (for comparing). */
  wasm?: boolean;
}

export interface ClassifyResult {
  classTiles: Tile[];
  colorTiles: Tile[];
  /** Pixels per class (index: class - 1). */
  counts: Float64Array;
}

/** The block's bands, NaN where there is no value. */
function bandsOf(task: BlockInput): Float32Array[] {
  const n = task.width * task.height;
  if (task.direct) {
    const { noData } = task.direct;
    return task.direct.bands.map((band) => {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = band[i];
        out[i] = v === noData ? NaN : v;
      }
      return out;
    });
  }
  return task.inputs.map((read) => {
    const out = new Float32Array(n).fill(NaN);
    if (read) resampleMesh(read, out, task.width, task.height, 0, 1, task.resample, NaN);
    return out;
  });
}

export function sampleBlock(task: SampleTask): SampleResult {
  const n = task.width * task.height;
  const values = bandsOf(task);
  const samples = task.count > 0 ? samplePixels(values, n, task.count, random(task.seed)) : new Float32Array(0);
  let stats: ClassStats | null = null;
  if (task.polygons && task.classes) {
    stats = emptyStats(task.classes, values.length);
    if (task.polygons.length) accumulate(stats, values, rasterizePolygons(task.polygons, task.width, task.height), n);
  }
  return { samples, stats };
}

export function classifyBlock(task: ClassifyTask): ClassifyResult {
  const { width, height } = task;
  const n = width * height;
  const bands = bandsOf(task);
  let made = task.wasm === false ? null : classifyWasm(bands, n, task.model, task.colors);
  if (!made) {
    const classes = classify(bands, n, task.model);
    const counts = new Float64Array(task.colors.length);
    for (let i = 0; i < n; i++) if (classes[i]) counts[classes[i] - 1]++;
    made = { classes, rgba: colorClasses(classes, task.colors), counts };
  }
  return {
    classTiles: cutTiles(made.classes, width, height, 1, task.tileSize, task.tx0, task.ty0, 0),
    colorTiles: cutTiles(made.rgba, width, height, 4, task.tileSize, task.tx0, task.ty0, 0),
    counts: made.counts,
  };
}
