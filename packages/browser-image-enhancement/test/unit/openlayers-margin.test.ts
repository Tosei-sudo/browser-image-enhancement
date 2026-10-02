import { describe, expect, it } from 'vitest';
import { cropMargin, withMargin } from '../../examples/openlayers-cog/margin.js';
import { pipeline } from '../../src/index.js';
import { noiseImage } from '../helpers.js';

/** Tile (tx, ty) of a `w` x `h` grid over `img`, or null outside it. */
function tileOf(img: { data: Uint8ClampedArray; width: number; height: number }, w: number, h: number, tx: number, ty: number) {
  if (tx < 0 || ty < 0 || tx * w >= img.width || ty * h >= img.height) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((ty * h + y) * img.width + tx * w) * 4;
    out.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}

describe('OpenLayers example: tiles corrected with their neighbours as margin', () => {
  // Margins smaller than a tile and larger than one (reaching two tiles away).
  for (const radius of [1, 4]) {
    it(`match the whole level corrected at once (radius ${radius})`, () => {
      const w = 8;
      const h = 6;
      const level = noiseImage(w * 4, h * 3, radius);
      const p = pipeline().exposure(0.2).sharpen({ amount: 1.3, radius }).contrast(0.1);
      const m = p.margin;
      expect(m > w).toBe(radius === 4);
      const whole = p.runSync(level, { colorMode: 'rgb' }).data;
      for (let ty = 0; ty < 3; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          const padded = withMargin((dx, dy) => tileOf(level, w, h, tx + dx, ty + dy), w, h, m);
          const out = p.runSync({ data: padded, width: w + 2 * m, height: h + 2 * m }, { colorMode: 'rgb' }).data;
          expect(cropMargin(out, w, h, m)).toEqual(tileOf({ data: whole, width: level.width, height: level.height }, w, h, tx, ty));
        }
      }
    });
  }

  it('without a margin the tile is passed through', () => {
    const t = noiseImage(4, 4).data;
    expect(withMargin(() => t, 4, 4, 0)).toEqual(t);
    expect(cropMargin(t, 4, 4, 0)).toBe(t);
  });
});
