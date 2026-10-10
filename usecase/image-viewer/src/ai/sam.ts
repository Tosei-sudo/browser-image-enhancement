/**
 * Segment Anything (SAM and its small relatives) on a picture: the encoder
 * sees the picture once, scaled so its longer side is the input side (1024)
 * and padded; each click then only runs the light decoder with the clicked
 * points, and the best of its masks becomes a polygon.
 *
 * The decoder is the one segment-anything's `export_onnx_model.py` writes:
 * inputs `image_embeddings`, `point_coords`, `point_labels`, `mask_input`,
 * `has_mask_input`, `orig_im_size`; outputs `masks` (logits, the picture's
 * size, or a smaller low-resolution mask) and `iou_predictions`.
 *
 * Everything here is pure; the tensors are plain typed arrays.
 */

/** SAM's normalization (ImageNet, in 0–255). */
export const SAM_MEAN: [number, number, number] = [123.675, 116.28, 103.53];
export const SAM_STD: [number, number, number] = [58.395, 57.12, 57.375];

/** How a picture is scaled into the encoder's input: the scale, and the scaled size. */
export function samScale(width: number, height: number, side = 1024): { scale: number; width: number; height: number } {
  const scale = side / Math.max(width, height);
  return { scale, width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The encoder input (NCHW float32, `side` × `side`) from the scaled picture
 * (RGBA, `width` × `height` at its top left): normalized, and zero (the mean)
 * in the padding and under transparent pixels.
 */
export function samTensor(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  side = 1024,
  mean: readonly number[] = SAM_MEAN,
  std: readonly number[] = SAM_STD,
): Float32Array {
  const plane = side * side;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < Math.min(height, side); y++) {
    for (let x = 0; x < Math.min(width, side); x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3] === 0) continue;
      const o = y * side + x;
      out[o] = (rgba[i] - mean[0]) / std[0];
      out[o + plane] = (rgba[i + 1] - mean[1]) / std[1];
      out[o + 2 * plane] = (rgba[i + 2] - mean[2]) / std[2];
    }
  }
  return out;
}

/** A clicked point on the picture (pixels): `positive` to take it in, otherwise to leave it out. */
export interface SamPoint {
  x: number;
  y: number;
  positive: boolean;
}

/**
 * The decoder's prompt tensors for `points` on a picture scaled by `scale`:
 * the points in the encoder's input pixels, then the padding point (0, 0)
 * labelled −1 that stands for "no box".
 */
export function samPrompt(points: readonly SamPoint[], scale: number): { coords: Float32Array; labels: Float32Array; count: number } {
  const count = points.length + 1;
  const coords = new Float32Array(count * 2);
  const labels = new Float32Array(count);
  points.forEach((p, i) => {
    coords[i * 2] = p.x * scale;
    coords[i * 2 + 1] = p.y * scale;
    labels[i] = p.positive ? 1 : 0;
  });
  labels[points.length] = -1;
  return { coords, labels, count };
}

/**
 * The picture-sized mask (1 = the object) from the decoder's `masks` output
 * (`[1, k, h, w]` logits) and `iou_predictions` (`[1, k]`): the mask the
 * decoder rates best. A mask of the picture's own size is used as it is; a
 * smaller (low-resolution) one covers the padded encoder input, and is
 * sampled bilinearly.
 */
export function samMask(
  masks: { dims: readonly number[]; data: ArrayLike<number> },
  scores: ArrayLike<number> | null,
  width: number,
  height: number,
  scale: number,
  side = 1024,
): Uint8Array {
  const [, k, mh, mw] = masks.dims;
  let best = 0;
  if (scores) for (let i = 1; i < k; i++) if (scores[i] > scores[best]) best = i;
  const plane = mh * mw;
  const data = masks.data;
  const base = best * plane;
  const out = new Uint8Array(width * height);
  if (mw === width && mh === height) {
    for (let i = 0; i < out.length; i++) out[i] = data[base + i] > 0 ? 1 : 0;
    return out;
  }
  // The low-resolution mask covers the side × side input; a picture pixel's centre is at (x + ½)·scale there.
  const sx = (scale * mw) / side;
  const sy = (scale * mh) / side;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const ya = Math.floor(fy);
    const yb = Math.min(ya + 1, mh - 1);
    const ty = fy - ya;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const xa = Math.floor(fx);
      const xb = Math.min(xa + 1, mw - 1);
      const tx = fx - xa;
      const v =
        (data[base + ya * mw + xa] * (1 - tx) + data[base + ya * mw + xb] * tx) * (1 - ty) +
        (data[base + yb * mw + xa] * (1 - tx) + data[base + yb * mw + xb] * tx) * ty;
      out[y * width + x] = v > 0 ? 1 : 0;
    }
  }
  return out;
}

/** The connected part (4-neighbours) of `mask` holding (`x`, `y`); the whole mask when that pixel is outside it. */
export function partAt(mask: Uint8Array, width: number, height: number, x: number, y: number): Uint8Array {
  const start = Math.floor(y) * width + Math.floor(x);
  if (x < 0 || y < 0 || x >= width || y >= height || !mask[start]) return mask;
  const out = new Uint8Array(mask.length);
  const stack = [start];
  out[start] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const px = i % width;
    for (const j of [px > 0 ? i - 1 : -1, px < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j >= 0 && j < mask.length && mask[j] && !out[j]) {
        out[j] = 1;
        stack.push(j);
      }
    }
  }
  return out;
}
