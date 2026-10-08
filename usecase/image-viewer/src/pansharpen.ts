/**
 * Pan-sharpening of two open images: a sharp panchromatic (gray) image and a
 * coarser multispectral one, separate files of different resolutions. The
 * multispectral image is resampled onto the panchromatic grid where the two
 * overlap, then the library's `panSharpen` puts the panchromatic detail into
 * its bands. The result keeps the multispectral bands and sample type at the
 * panchromatic resolution, georeferenced like the panchromatic image.
 *
 * Both images must be in the same CRS. Ordinary pictures (no georeferencing)
 * are taken to cover the same ground.
 *
 * A large result is made at full resolution a block at a time: the weights
 * and gains are first fitted on full-resolution windows spread over the
 * overlap ({@link fitPanSharpen}), then each block is sharpened with them
 * ({@link runPanSharpen}), so the blocks join without seams and only a few
 * blocks are ever in memory.
 */
import { panSharpen, type PanSharpenMethod, type PanSharpenModel } from 'browser-image-enhancement';
import { affine, warpRaster, type Raster, type RasterSamples, type Resample } from 'browser-image-geometry';

/** Where an image's full-resolution pixels lie: pixel `(i, j)`'s top-left corner is at `origin + (i, j) * resolution`. */
export interface Grid {
  width: number;
  height: number;
  origin: readonly [number, number];
  /** Pixel size in x and y; y is negative for north-up images. */
  resolution: readonly [number, number];
}

/** A window of an image to read: `[x0, y0, x1, y1]` in full-resolution pixels, read as `width` × `height` pixels. */
export interface ReadWindow {
  window: readonly [number, number, number, number];
  width: number;
  height: number;
}

/** What to read from each image, and how the multispectral pixels fall on the output. */
export interface PanSharpenPlan {
  pan: ReadWindow;
  ms: ReadWindow;
  /** Output size (the panchromatic window as read). */
  width: number;
  height: number;
  /** Affine matrix from multispectral read pixels to output pixels. */
  msToOutput: readonly [number, number, number, number, number, number];
  /** Output pixel `(0, 0)`'s top-left corner and the output pixel size, in the panchromatic image's CRS. */
  origin: [number, number];
  resolution: [number, number];
  /** Full-resolution panchromatic pixels per output pixel (1 unless the result had to be reduced). */
  reduction: number;
  /** Panchromatic pixels per multispectral pixel, across and down. */
  ratio: [number, number];
}

/** Multispectral pixels read beyond the overlap on each side, for the interpolation. */
const MARGIN = 3;

/**
 * Plans a pan-sharpening: the overlap of the two images on the panchromatic
 * grid (within `window`, in panchromatic pixels, when given), reduced by a
 * whole factor when its `bands` samples would pass `maxSamples` (default: no
 * limit). With `sameGround` the multispectral image is stretched over the
 * panchromatic one instead of placed by its own grid.
 */
export function planPanSharpen(
  pan: Grid,
  ms: Grid,
  options: { bands: number; maxSamples?: number; sameGround?: boolean; window?: readonly [number, number, number, number] },
): PanSharpenPlan {
  const maxSamples = options.maxSamples ?? Infinity;
  const m: Grid = options.sameGround
    ? { ...ms, origin: pan.origin, resolution: [(pan.resolution[0] * pan.width) / ms.width, (pan.resolution[1] * pan.height) / ms.height] }
    : ms;
  // Multispectral pixel position → panchromatic pixel position, per axis: p = a * m + c.
  const ax = m.resolution[0] / pan.resolution[0];
  const cx = (m.origin[0] - pan.origin[0]) / pan.resolution[0];
  const ay = m.resolution[1] / pan.resolution[1];
  const cy = (m.origin[1] - pan.origin[1]) / pan.resolution[1];
  if (!(ax > 0 && ay > 0) || ![cx, cy].every(Number.isFinite)) throw new Error('2 つの画像の向きが合いません');
  // The overlap, in panchromatic pixels.
  let px0 = Math.max(0, Math.floor(cx + 1e-6));
  let py0 = Math.max(0, Math.floor(cy + 1e-6));
  let px1 = Math.min(pan.width, Math.ceil(cx + ax * m.width - 1e-6));
  let py1 = Math.min(pan.height, Math.ceil(cy + ay * m.height - 1e-6));
  if (px1 <= px0 || py1 <= py0) throw new Error('2 つの画像が重なっていません');
  if (options.window) {
    const [wx0, wy0, wx1, wy1] = options.window;
    [px0, py0, px1, py1] = [Math.max(px0, wx0), Math.max(py0, wy0), Math.min(px1, wx1), Math.min(py1, wy1)];
    if (px1 <= px0 || py1 <= py0) throw new Error('窓が重なりの外です');
  }

  let reduction = 1;
  while (Math.ceil((px1 - px0) / reduction) * Math.ceil((py1 - py0) / reduction) * options.bands > maxSamples) reduction++;
  const width = Math.ceil((px1 - px0) / reduction);
  const height = Math.ceil((py1 - py0) / reduction);

  // The multispectral pixels under the overlap, with a margin.
  const mx0 = Math.max(0, Math.floor((px0 - cx) / ax) - MARGIN);
  const my0 = Math.max(0, Math.floor((py0 - cy) / ay) - MARGIN);
  const mx1 = Math.min(m.width, Math.ceil((px1 - cx) / ax) + MARGIN);
  const my1 = Math.min(m.height, Math.ceil((py1 - cy) / ay) + MARGIN);
  // Read at full resolution unless that would not fit either (it is never needed finer than the output).
  let msReduction = 1;
  while (Math.ceil((mx1 - mx0) / msReduction) * Math.ceil((my1 - my0) / msReduction) * options.bands > maxSamples) msReduction++;
  const msWidth = Math.ceil((mx1 - mx0) / msReduction);
  const msHeight = Math.ceil((my1 - my0) / msReduction);
  const kx = (mx1 - mx0) / msWidth;
  const ky = (my1 - my0) / msHeight;

  return {
    pan: { window: [px0, py0, px1, py1], width, height },
    ms: { window: [mx0, my0, mx1, my1], width: msWidth, height: msHeight },
    width,
    height,
    // Read pixel r → multispectral pixel mx0 + r·k → panchromatic pixel → output pixel.
    msToOutput: [
      (ax * kx * width) / (px1 - px0),
      0,
      ((cx + ax * mx0 - px0) * width) / (px1 - px0),
      0,
      (ay * ky * height) / (py1 - py0),
      ((cy + ay * my0 - py0) * height) / (py1 - py0),
    ],
    origin: [pan.origin[0] + px0 * pan.resolution[0], pan.origin[1] + py0 * pan.resolution[1]],
    resolution: [(pan.resolution[0] * (px1 - px0)) / width, (pan.resolution[1] * (py1 - py0)) / height],
    reduction,
    ratio: [ax, ay],
  };
}

/** Output pixels of a block: a whole number of tiles. */
export const BLOCK = 2048;

/**
 * The blocks to make a plan's output in, as panchromatic pixel windows
 * `[x0, y0, x1, y1]`, row by row; each starts on a multiple of `size` from
 * the output's corner.
 */
export function blocksOf(plan: PanSharpenPlan, size = BLOCK): Array<[number, number, number, number]> {
  const [x0, y0, x1, y1] = plan.pan.window;
  const out: Array<[number, number, number, number]> = [];
  for (let y = y0; y < y1; y += size) for (let x = x0; x < x1; x += size) out.push([x, y, Math.min(x1, x + size), Math.min(y1, y + size)]);
  return out;
}

/**
 * Full-resolution windows spread evenly over a plan's output, `count` across
 * and down at most, each `size` pixels square at most: where the weights and
 * gains of a large result are fitted.
 */
export function sampleWindows(plan: PanSharpenPlan, count = 8, size = 256): Array<[number, number, number, number]> {
  const [x0, y0, x1, y1] = plan.pan.window;
  const along = (a: number, b: number): Array<[number, number]> => {
    const n = Math.max(1, Math.min(count, Math.floor((b - a) / size)));
    const s = Math.min(size, b - a);
    return Array.from({ length: n }, (_, i) => {
      const start = a + (n > 1 ? Math.round(((b - a - s) * i) / (n - 1)) : Math.floor((b - a - s) / 2));
      return [start, start + s] as [number, number];
    });
  };
  return along(y0, y1).flatMap(([wy0, wy1]) => along(x0, x1).map(([wx0, wx1]) => [wx0, wy0, wx1, wy1] as [number, number, number, number]));
}

/** What the worker gets: both images as read, and how to combine them. */
export interface PanSharpenJob {
  pan: Raster;
  ms: Raster;
  /** The multispectral alpha band, if it has one. */
  alpha: boolean;
  plan: PanSharpenPlan;
  method: PanSharpenMethod;
  resample: Resample;
  strength: number;
  weights: 'auto' | 'equal';
  /** Weights and gains fitted before (for a block of a large result); fitted to this job when left out. */
  model?: PanSharpenModel;
}

/** The pan-sharpened raster on the plan's output grid. */
export interface PanSharpenOutput {
  raster: Raster;
  weights: number[];
  model: PanSharpenModel;
}

/** The multispectral image of a job resampled onto its output grid. */
function warped(job: PanSharpenJob): Raster {
  const { plan } = job;
  return warpRaster(job.ms, affine(plan.msToOutput), {
    resample: job.resample,
    extent: [0, 0, plan.width, plan.height],
    width: plan.width,
    height: plan.height,
    edges: 'clamp',
  }).raster;
}

/** Resamples the multispectral image onto the output grid and sharpens it. */
export function runPanSharpen(job: PanSharpenJob): PanSharpenOutput {
  const { plan } = job;
  const raster = warped(job);
  const result = panSharpen(
    { data: job.pan.data, width: plan.width, height: plan.height, noData: job.pan.noData },
    { data: raster.data, width: plan.width, height: plan.height, bands: raster.bands, noData: raster.noData, alpha: job.alpha },
    { method: job.method, strength: job.strength, weights: job.weights, model: job.model },
  );
  return { raster: { width: plan.width, height: plan.height, bands: result.bands, data: result.data, noData: result.noData }, weights: result.weights, model: result.model };
}

/**
 * Fits the weights and gains on the windows of `jobs` together (each job
 * one window, at full resolution): the model to sharpen every block of a
 * large result with.
 */
export function fitPanSharpen(jobs: PanSharpenJob[]): PanSharpenModel {
  if (!jobs.length) throw new Error('No windows to fit on.');
  const pieces = jobs.map((job) => ({ pan: job.pan.data, ms: warped(job).data, pixels: job.plan.width * job.plan.height }));
  const pixels = pieces.reduce((s, p) => s + p.pixels, 0);
  const bands = jobs[0].ms.bands;
  // The windows one under another: the statistics do not care where a pixel is.
  const Pan = pieces[0].pan.constructor as new (n: number) => RasterSamples;
  const Ms = pieces[0].ms.constructor as new (n: number) => RasterSamples;
  const pan = new Pan(pixels);
  const ms = new Ms(pixels * bands);
  let at = 0;
  for (const p of pieces) {
    pan.set(p.pan as never, at);
    ms.set(p.ms as never, at * bands);
    at += p.pixels;
  }
  const first = jobs[0];
  return panSharpen(
    { data: pan, width: 1, height: pixels, noData: first.pan.noData },
    { data: ms, width: 1, height: pixels, bands, noData: first.ms.noData, alpha: first.alpha },
    { method: first.method, strength: first.strength, weights: first.weights },
  ).model;
}
