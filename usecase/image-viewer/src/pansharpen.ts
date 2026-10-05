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
 */
import { panSharpen, type PanSharpenMethod } from 'browser-image-enhancement';
import { affine, warpRaster, type Raster, type Resample } from 'browser-image-geometry';

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
 * grid, reduced by a whole factor when its `bands` samples would pass
 * `maxSamples`. With `sameGround` the multispectral image is stretched over
 * the panchromatic one instead of placed by its own grid.
 */
export function planPanSharpen(pan: Grid, ms: Grid, options: { bands: number; maxSamples: number; sameGround?: boolean }): PanSharpenPlan {
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
  const px0 = Math.max(0, Math.floor(cx + 1e-6));
  const py0 = Math.max(0, Math.floor(cy + 1e-6));
  const px1 = Math.min(pan.width, Math.ceil(cx + ax * m.width - 1e-6));
  const py1 = Math.min(pan.height, Math.ceil(cy + ay * m.height - 1e-6));
  if (px1 <= px0 || py1 <= py0) throw new Error('2 つの画像が重なっていません');

  let reduction = 1;
  while (Math.ceil((px1 - px0) / reduction) * Math.ceil((py1 - py0) / reduction) * options.bands > options.maxSamples) reduction++;
  const width = Math.ceil((px1 - px0) / reduction);
  const height = Math.ceil((py1 - py0) / reduction);

  // The multispectral pixels under the overlap, with a margin.
  const mx0 = Math.max(0, Math.floor((px0 - cx) / ax) - MARGIN);
  const my0 = Math.max(0, Math.floor((py0 - cy) / ay) - MARGIN);
  const mx1 = Math.min(m.width, Math.ceil((px1 - cx) / ax) + MARGIN);
  const my1 = Math.min(m.height, Math.ceil((py1 - cy) / ay) + MARGIN);
  // Read at full resolution unless that would not fit either (it is never needed finer than the output).
  let msReduction = 1;
  while (Math.ceil((mx1 - mx0) / msReduction) * Math.ceil((my1 - my0) / msReduction) * options.bands > options.maxSamples) msReduction++;
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
}

/** The pan-sharpened raster on the plan's output grid. */
export interface PanSharpenOutput {
  raster: Raster;
  weights: number[];
}

/** Resamples the multispectral image onto the output grid and sharpens it. */
export function runPanSharpen(job: PanSharpenJob): PanSharpenOutput {
  const { plan } = job;
  const { raster } = warpRaster(job.ms, affine(plan.msToOutput), {
    resample: job.resample,
    extent: [0, 0, plan.width, plan.height],
    width: plan.width,
    height: plan.height,
    edges: 'clamp',
  });
  const result = panSharpen(
    { data: job.pan.data, width: plan.width, height: plan.height, noData: job.pan.noData },
    { data: raster.data, width: plan.width, height: plan.height, bands: raster.bands, noData: raster.noData, alpha: job.alpha },
    { method: job.method, strength: job.strength, weights: job.weights },
  );
  return { raster: { width: plan.width, height: plan.height, bands: result.bands, data: result.data, noData: result.noData }, weights: result.weights };
}
