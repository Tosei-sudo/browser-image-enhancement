import type { ImageDataLike, OpSpec } from '../src/types.js';

/** Deterministic PRNG (mulberry32) so failures reproduce. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
}

/** Random color image with random alpha. */
export function noiseImage(width: number, height: number, seed = 1): ImageDataLike {
  const r = rng(seed);
  return image(width, height, () => [r() * 256, r() * 256, r() * 256, r() * 256].map(Math.floor) as [number, number, number, number]);
}

/** Random monochrome (R = G = B) image with random alpha. */
export function grayImage(width: number, height: number, seed = 1): ImageDataLike {
  const r = rng(seed);
  return image(width, height, () => {
    const v = Math.floor(r() * 256);
    return [v, v, v, Math.floor(r() * 256)];
  });
}

/** Every 8-bit code on every channel, plus combinations, in a 256x256 image. */
export function rampImage(): ImageDataLike {
  return image(256, 256, (x, y) => [x, y, (x * 7 + y * 13) & 255, 255]);
}

export function copy(img: ImageDataLike): ImageDataLike {
  return { data: img.data.slice(), width: img.width, height: img.height };
}

/** A random chain of 1-6 corrections with random (valid) parameters. */
export function randomOps(r: () => number): OpSpec[] {
  const n = 1 + Math.floor(r() * 6);
  const signed = () => r() * 2 - 1;
  const ops: OpSpec[] = [];
  for (let i = 0; i < n; i++) {
    switch (Math.floor(r() * 8)) {
      case 0:
        ops.push({ op: 'brightness', amount: signed() });
        break;
      case 1:
        ops.push({ op: 'contrast', amount: signed() * 0.9 });
        break;
      case 2:
        ops.push({ op: 'exposure', ev: signed() * 3 });
        break;
      case 3:
        ops.push({ op: 'gamma', gamma: 0.3 + r() * 3 });
        break;
      case 4:
        ops.push({ op: 'saturation', amount: signed() });
        break;
      case 5:
        ops.push({ op: 'temperature', amount: signed() });
        break;
      case 6: {
        // Per-channel or uniform; white may exceed 1 (reaching values pushed past white).
        const pick = () => [r() * 0.4, 0.6 + r() * 0.5];
        if (r() < 0.5) {
          const [black, white] = pick();
          ops.push({ op: 'stretch', black: [black, black, black], white: [white, white, white] });
        } else {
          const p = [pick(), pick(), pick()];
          ops.push({ op: 'stretch', black: [p[0][0], p[1][0], p[2][0]], white: [p[0][1], p[1][1], p[2][1]] });
        }
        break;
      }
      default: {
        const inBlack = r() * 0.4;
        const outBlack = r() * 0.3;
        ops.push({
          op: 'levels',
          inBlack,
          inWhite: 0.6 + r() * 0.4,
          gamma: 0.4 + r() * 2,
          outBlack,
          outWhite: 0.7 + r() * 0.3,
        });
      }
    }
  }
  return ops;
}

export function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export function isGrayPixels(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return false;
  return true;
}

export function pixel(img: ImageDataLike, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}
