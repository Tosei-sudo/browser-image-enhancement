/**
 * Margins for tiles. Sharpening reads neighbouring pixels, so a tile corrected
 * on its own would show seams at its edges. Each tile is instead corrected
 * with `pipeline.margin` pixels of its neighbour tiles around it and cropped
 * back afterwards; its pixels then equal the same area of the whole level
 * corrected at once.
 */

/** RGBA pixels of the tile `dx`, `dy` tiles away from the centre one, or null where there is none (outside the image). */
export type NeighbourTile = (dx: number, dy: number) => Uint8ClampedArray | null;

/**
 * The centre tile (`width` x `height`) with `margin` pixels of its neighbours
 * on every side. Where there is no neighbour the margin is transparent, which
 * the library treats exactly like the edge of the image.
 */
export function withMargin(tile: NeighbourTile, width: number, height: number, margin: number): Uint8ClampedArray {
  const W = width + 2 * margin;
  const H = height + 2 * margin;
  const out = new Uint8ClampedArray(W * H * 4);
  const nx = Math.ceil(margin / width);
  const ny = Math.ceil(margin / height);
  for (let dy = -ny; dy <= ny; dy++) {
    for (let dx = -nx; dx <= nx; dx++) {
      // The part of this tile inside the padded area, in padded coordinates.
      const x0 = Math.max(0, margin + dx * width);
      const x1 = Math.min(W, margin + (dx + 1) * width);
      const y0 = Math.max(0, margin + dy * height);
      const y1 = Math.min(H, margin + (dy + 1) * height);
      if (x1 <= x0 || y1 <= y0) continue;
      const src = tile(dx, dy);
      if (!src) continue;
      const sx = x0 - (margin + dx * width);
      for (let y = y0; y < y1; y++) {
        const sy = y - (margin + dy * height);
        const from = (sy * width + sx) * 4;
        out.set(src.subarray(from, from + (x1 - x0) * 4), (y * W + x0) * 4);
      }
    }
  }
  return out;
}

/** The centre `width` x `height` pixels of an image padded by `margin` on every side. */
export function cropMargin(padded: Uint8ClampedArray, width: number, height: number, margin: number): Uint8ClampedArray {
  if (margin === 0) return padded;
  const W = width + 2 * margin;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y + margin) * W + margin) * 4;
    out.set(padded.subarray(from, from + width * 4), y * width * 4);
  }
  return out;
}
