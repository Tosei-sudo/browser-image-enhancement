/**
 * Runs a classification of an open image (classify.ts) over its own grid, a
 * block at a time in workers: first a pass that samples the pixels for
 * k-means, or gathers the statistics of the training polygons; then a pass
 * that puts every pixel in a class. The result is two GeoTIFFs of the
 * image's grid: the class numbers (8-bit, 0 = no data) and the classes in
 * their colors (RGBA, transparent where there is no data), with the pixels
 * and the area of each class.
 */
import { getTransform } from 'ol/proj.js';
import { emptyStats, addStats, kMeans, classColor, trainModel, type ClassModel, type ClassifierKind } from './classify.js';
import type { ClassifyResult, ClassifyTask, SampleResult, SampleTask } from './classify-block.js';
import type { ClassifyReply } from './classify-worker.js';
import { blocksOf, readBlock, tagsOf, type Channel, type CompositePlan } from './composite-dialog.js';
import type { Resampling } from './composite.js';
import { geodesicArea } from './geodesic.js';
import { planCalc } from './raster-calc-run.js';
import { TiledTiffWriter } from './tiff-stream.js';
import type { ByteSink } from './byte-sink.js';
import type { ViewerImage } from './images.js';
import type { LonLat } from './coordinates.js';

const TILE = 256;
const UINT8 = { format: 1, bits: 8 };
const FLOAT32 = { format: 3, bits: 32 };
/** Pixels k-means is trained on, over the whole image. */
const MAX_SAMPLES = 60_000;
/** Most bytes of first-pass reads kept for the second pass (k-means). */
const MAX_KEPT_BYTES = 256 * 2 ** 20;
/** Most classes (the class numbers are 8-bit, and a legend longer than this is not read). */
export const MAX_CLASSES = 50;

/** Training polygons of one class, rings in the image's projection (`[[x, y], …]`, closed or not). */
export interface TrainingClass {
  name: string;
  polygons: Array<Array<Array<[number, number]>>>;
}

export type ClassifyMethod =
  | { kind: 'kmeans'; classes: number; iterations?: number; seed?: number }
  | { kind: 'supervised'; classifier: ClassifierKind; training: TrainingClass[] };

export interface ClassifyRequest {
  image: ViewerImage;
  /** 0-based bands used. */
  bands: number[];
  method: ClassifyMethod;
  resample?: Resampling;
  /** Called as blocks are made: the pass (1 or 2) and how far it is, 0–1. */
  onProgress?: (pass: 1 | 2, done: number) => void;
  /** Set `cancelled` to stop. */
  control?: { cancelled: boolean };
  /** false: classify in JS only, not WebAssembly (for comparing). */
  wasm?: boolean;
  /** Where the two GeoTIFFs are written (default: in the page), and their names. */
  output?: { classes: { sink: ByteSink; name: string }; colors: { sink: ByteSink; name: string } };
}

/** One class of the result. */
export interface ClassSummary {
  name: string;
  color: [number, number, number];
  pixels: number;
  /** Square meters (geodesic, by the pixels' sizes where they lie). */
  area: number;
}

export interface ClassifyOutput {
  /** Class numbers, 8-bit, 0 = no data. */
  classBlob: File;
  /** The classes in their colors, RGBA. */
  colorBlob: File;
  plan: CompositePlan;
  classes: ClassSummary[];
  model: ClassModel;
}

/** The plan (the image's own grid); throws when the image cannot be classified. */
export function planClassify(image: ViewerImage, bands: readonly number[]): CompositePlan {
  if (!bands.length) throw new Error('バンドを 1 つ以上選んでください');
  return planCalc(
    bands.map((band) => ({ image, band })),
    image,
  );
}

/** Classifies the image. */
export async function runClassify(request: ClassifyRequest): Promise<ClassifyOutput> {
  const { image, bands, method } = request;
  const channels: Channel[] = bands.map((band) => ({ image, band }));
  const plan = planClassify(image, bands);
  const { grid } = plan;
  const resample = request.resample ?? 'nearest';
  const control = request.control ?? { cancelled: false };
  const blocks = blocksOf(grid);
  const total = grid.width * grid.height;
  const dims = bands.length;
  const read = blockReader(plan, channels, resample);

  // Training polygons in the grid's pixels, with their bounding boxes.
  const training =
    method.kind === 'supervised'
      ? method.training.flatMap((c, k) =>
          c.polygons.map((rings) => {
            const pixelRings = rings.map((ring) => {
              const out = new Float64Array(ring.length * 2);
              ring.forEach(([x, y], i) => {
                out[2 * i] = (x - grid.origin[0]) / grid.resolution[0];
                out[2 * i + 1] = (y - grid.origin[1]) / grid.resolution[1];
              });
              return out;
            });
            const box = [Infinity, Infinity, -Infinity, -Infinity];
            for (const r of pixelRings) {
              for (let i = 0; i < r.length; i += 2) {
                box[0] = Math.min(box[0], r[i]);
                box[1] = Math.min(box[1], r[i + 1]);
                box[2] = Math.max(box[2], r[i]);
                box[3] = Math.max(box[3], r[i + 1]);
              }
            }
            return { label: k + 1, rings: pixelRings, box };
          }),
        )
      : [];
  if (method.kind === 'supervised') {
    if (method.training.length < 2) throw new Error('学習用のクラスが 2 つ以上必要です');
    if (method.training.length > MAX_CLASSES) throw new Error(`クラスは ${MAX_CLASSES} までです（${method.training.length} あります）`);
    if (!training.some((t) => t.box[2] > 0 && t.box[3] > 0 && t.box[0] < grid.width && t.box[1] < grid.height)) {
      throw new Error('学習用のポリゴンが画像の範囲にありません');
    }
  } else if (!(method.classes >= 2 && method.classes <= MAX_CLASSES)) {
    throw new Error(`クラス数は 2 から ${MAX_CLASSES} までです`);
  }

  // Pass 1: samples for k-means, or the training statistics.
  // By block, so k-means sees them in the same order whichever worker finished first.
  const samples: Float32Array[] = [];
  // k-means reads every block twice: keep the first reads for the second pass when they are not too large.
  const keep = method.kind === 'kmeans' && (total * dims * plan.reference.tiff.getBytesPerPixel()) / plan.reference.tiff.getSamplesPerPixel() <= MAX_KEPT_BYTES;
  const kept = new Map<number, BlockRead>();
  const stats = emptyStats(method.kind === 'supervised' ? method.training.length : 0, dims);
  await runBlocks(blocks, control, request.onProgress && ((done) => request.onProgress!(1, done)), async (window, worker, index) => {
    const [x0, y0, x1, y1] = window;
    const polygons =
      method.kind === 'supervised'
        ? training
            .filter((t) => t.box[0] < x1 && t.box[2] > x0 && t.box[1] < y1 && t.box[3] > y0)
            .map((t) => ({
              label: t.label,
              rings: t.rings.map((r) => {
                const out = new Float64Array(r.length);
                for (let i = 0; i < r.length; i += 2) {
                  out[i] = r[i] - x0;
                  out[i + 1] = r[i + 1] - y0;
                }
                return out;
              }),
            }))
        : [];
    // Blocks without training polygons are not read at all.
    if (method.kind === 'supervised' && !polygons.length) return;
    const block = await read(window);
    if (keep) kept.set(index, copyOf(block));
    const task: SampleTask = {
      op: 'sample',
      ...block,
      resample,
      count: method.kind === 'kmeans' ? Math.ceil((MAX_SAMPLES * block.width * block.height) / total) : 0,
      seed: (method.kind === 'kmeans' ? (method.seed ?? 1) : 1) + x0 * 7919 + y0,
      ...(method.kind === 'supervised' ? { polygons, classes: method.training.length } : {}),
    };
    const result = (await call(worker, task, buffersOf(block))) as SampleResult;
    samples[index] = result.samples;
    if (result.stats) addStats(stats, result.stats);
  });

  let model: ClassModel;
  let names: string[];
  if (method.kind === 'kmeans') {
    const all = new Float32Array(samples.reduce((n, s) => n + (s?.length ?? 0), 0));
    let at = 0;
    for (const s of samples) {
      if (!s) continue;
      all.set(s, at);
      at += s.length;
    }
    if (!all.length) throw new Error('値のある画素がありませんでした');
    model = { kind: 'distance', dims, means: kMeans(all, dims, method.classes, method.iterations ?? 30, method.seed ?? 1) };
    names = Array.from({ length: method.classes }, (_, c) => `クラス ${c + 1}`);
  } else {
    names = method.training.map((c) => c.name);
    model = trainModel(stats, method.classifier, names);
  }
  const colors = names.map((_, c) => [...classColor(c + 1)] as [number, number, number]);

  // Pass 2: every pixel in a class, both files at once.
  const out = request.output;
  const classWriter = new TiledTiffWriter({ width: grid.width, height: grid.height, bands: 1, sample: new Uint8Array(0), tileSize: TILE, photometric: 1, sink: out?.classes.sink });
  const colorWriter = new TiledTiffWriter({ width: grid.width, height: grid.height, bands: 4, sample: new Uint8Array(0), tileSize: TILE, photometric: 2, extraSamples: [2], sink: out?.colors.sink });
  const pixels = new Float64Array(names.length);
  const areas = new Float64Array(names.length);
  const toLonLat = getTransform(plan.projection, 'EPSG:4326');
  await runBlocks(blocks, control, request.onProgress && ((done) => request.onProgress!(2, done)), async (window, worker, index) => {
    const block = kept.get(index) ?? (await read(window));
    kept.delete(index);
    const task: ClassifyTask = { op: 'classify', ...block, resample, model, colors, tileSize: TILE, tx0: window[0] / TILE, ty0: window[1] / TILE, wasm: request.wasm };
    const result = (await call(worker, task, buffersOf(block))) as ClassifyResult;
    await Promise.all([classWriter.add(result.classTiles), colorWriter.add(result.colorTiles)]);
    const area = pixelArea(plan, (window[0] + window[2]) / 2, (window[1] + window[3]) / 2, toLonLat);
    result.counts.forEach((n, c) => {
      pixels[c] += n;
      areas[c] += n * area;
    });
  });
  if (!pixels.some((n) => n > 0)) throw new Error('値のある画素がありませんでした');

  const plan8: CompositePlan = { ...plan, type: UINT8 };
  const classBlob = await classWriter.finish(await tagsOf(plan8, [1], [names.length]), out?.classes.name);
  // The colors need no no-data value: their alpha is the mask.
  const colorBlob = await colorWriter.finish((await tagsOf(plan8, [0, 0, 0, 0], [255, 255, 255, 255])).filter((e) => e.tag !== 42113), out?.colors.name);
  return {
    classBlob,
    colorBlob,
    plan,
    model,
    classes: names.map((name, c) => ({ name, color: colors[c], pixels: pixels[c], area: areas[c] })),
  };
}

/** The ground area of one pixel of the grid around pixel `(x, y)`, in m². */
function pixelArea(plan: CompositePlan, x: number, y: number, toLonLat: ReturnType<typeof getTransform>): number {
  const { origin, resolution } = plan.grid;
  // A square of 16 × 16 pixels, for precision, divided back.
  const s = 8;
  const corner = (dx: number, dy: number) => toLonLat([origin[0] + (x + dx) * resolution[0], origin[1] + (y + dy) * resolution[1]]) as LonLat;
  const ring = [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
  return Math.abs(geodesicArea(ring).area) / (4 * s * s);
}

/** What a block of the classification is read as: the bands through their meshes, or as read. */
interface BlockRead {
  width: number;
  height: number;
  inputs: SampleTask['inputs'];
  direct?: SampleTask['direct'];
}

/**
 * Reads blocks of the grid. When the grid is the image's own (no shift, no
 * other projection: always so unless the image is placed by a sensor model),
 * a block is the image's pixels as they are: all the bands in one read,
 * nothing to look up. Otherwise each band through its mesh, as a composite's.
 */
function blockReader(plan: CompositePlan, channels: Channel[], resample: Resampling): (window: [number, number, number, number]) => Promise<BlockRead> {
  const { grid, reference } = plan;
  const ox = (grid.origin[0] - reference.origin[0] - reference.shift[0]) / reference.resolution[0];
  const oy = (grid.origin[1] - reference.origin[1] - reference.shift[1]) / reference.resolution[1];
  const own =
    plan.ownGrid &&
    channels.every((c) => c.image === reference.image) &&
    grid.resolution[0] === reference.resolution[0] &&
    grid.resolution[1] === reference.resolution[1] &&
    Math.abs(ox - Math.round(ox)) < 1e-6 &&
    Math.abs(oy - Math.round(oy)) < 1e-6 &&
    Math.round(ox) >= 0 &&
    Math.round(oy) >= 0 &&
    Math.round(ox) + grid.width <= reference.tiff.getWidth() &&
    Math.round(oy) + grid.height <= reference.tiff.getHeight();
  if (!own) {
    return async (window) => {
      const read = await readBlock(plan, channels, window, FLOAT32, resample);
      return { width: read.width, height: read.height, inputs: read.channels };
    };
  }
  const dx = Math.round(ox);
  const dy = Math.round(oy);
  const tiff = reference.tiff;
  const samples = channels.map((c) => c.band);
  return async ([x0, y0, x1, y1]) => {
    const bands = (await tiff.readRasters({ window: [x0 + dx, y0 + dy, x1 + dx, y1 + dy], samples })) as unknown as ArrayLike<number>[];
    return { width: x1 - x0, height: y1 - y0, inputs: channels.map(() => null), direct: { bands: Array.from(bands), noData: tiff.getGDALNoData() } };
  };
}

/** A copy of a block's reads (the worker takes the originals). */
function copyOf(block: BlockRead): BlockRead {
  const copy = <T>(a: T): T => (a as unknown as { slice(): T }).slice();
  return {
    ...block,
    inputs: block.inputs.map((c) => (c ? { ...c, data: copy(c.data), mesh: c.mesh.slice() } : null)),
    direct: block.direct && { noData: block.direct.noData, bands: block.direct.bands.map(copy) },
  };
}

/** The buffers of the bands read for a block, each once. */
function buffersOf(block: BlockRead): ArrayBuffer[] {
  const arrays = [...block.inputs.flatMap((c) => (c ? [c.data] : [])), ...(block.direct?.bands ?? [])];
  return [...new Set(arrays.map((a) => (a as unknown as { buffer: ArrayBuffer }).buffer))];
}

/** Runs `work` on every block in a few workers. */
async function runBlocks(
  blocks: Array<[number, number, number, number]>,
  control: { cancelled: boolean },
  onProgress: ((done: number) => void) | undefined,
  work: (window: [number, number, number, number], worker: Worker, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let done = 0;
  let failed = false;
  const stop = () => {
    if (control.cancelled) throw new Error('中止しました');
    if (failed) throw new Error('ほかのブロックで失敗しました');
  };
  const workers: Worker[] = [];
  const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  try {
    for (let i = 0; i < Math.min(threads, blocks.length); i++) workers.push(new Worker(new URL('./classify-worker.ts', import.meta.url), { type: 'module' }));
    await Promise.all(
      workers.map(async (worker) => {
        try {
          while (next < blocks.length) {
            stop();
            const index = next++;
            await work(blocks[index], worker, index);
            stop();
            done++;
            onProgress?.(done / blocks.length);
          }
        } catch (error) {
          failed = true;
          throw error;
        }
      }),
    );
    stop();
  } finally {
    for (const w of workers) w.terminate();
  }
}

function call(worker: Worker, task: SampleTask | ClassifyTask, transfer: Transferable[]): Promise<SampleResult | ClassifyResult> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ClassifyReply>) => (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || '分類が止まりました'));
    worker.postMessage(task, transfer);
  });
}
