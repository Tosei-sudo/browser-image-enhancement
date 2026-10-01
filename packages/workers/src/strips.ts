/** Helpers for cutting an image into horizontal strips, one per worker. */

/** Splits `height` rows into `count` contiguous ranges of near-equal size. */
export function splitRows(height: number, count: number): Array<[start: number, end: number]> {
  const n = Math.max(1, Math.min(count, height));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) ranges.push([Math.floor((height * i) / n), Math.floor((height * (i + 1)) / n)]);
  return ranges;
}

/** How many strips an image of `pixels` pixels and `height` rows is worth splitting into. */
export function stripCount(pixels: number, height: number, maxWorkers: number, minStripPixels: number): number {
  return Math.max(1, Math.min(maxWorkers, Math.ceil(pixels / minStripPixels), height));
}

/** Lets other main-thread tasks (rendering, input) run between strip copies. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
