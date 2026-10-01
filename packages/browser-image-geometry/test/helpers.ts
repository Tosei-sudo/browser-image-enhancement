import type { ImageDataLike } from '@browser-image/workers';

export function makeImage(width: number, height: number, fn: (x: number, y: number) => [number, number, number, number]): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
  return { data, width, height };
}

/** Deterministic pseudo-random pixels with varied alpha. */
export function noiseImage(width: number, height: number, opaque = false): ImageDataLike {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0), s >>> 24);
  return makeImage(width, height, () => [rnd(), rnd(), rnd(), opaque ? 255 : rnd()]);
}

/** A smooth gradient (opaque), where interpolation errors stay small. */
export function smoothImage(width: number, height: number): ImageDataLike {
  return makeImage(width, height, (x, y) => [(x * 255) / width, (y * 255) / height, ((x + y) * 127) / (width + height), 255]);
}

export function pixel(img: ImageDataLike, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}

export function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
