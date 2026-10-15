/**
 * One block of a raster calculation (band math, change detection), made off
 * the main thread: each input band looked up on the output grid through its
 * mesh (as an RGB composite's bands are, see composite.ts), the expression
 * evaluated over the block (band-math.ts), and the one-band 32-bit float
 * result cut into the tiles of the GeoTIFF being written.
 */
import { evaluate, type Expr } from './band-math.js';
import { resampleMesh, type ChannelRead, type Resampling } from './composite.js';
import { cutTiles, type Tile } from './tiff-stream.js';

export interface CalcTask {
  width: number;
  height: number;
  /** One per variable of the expression; null where the image does not reach the block. */
  inputs: Array<ChannelRead | null>;
  expr: Expr;
  resample: Resampling;
  tileSize: number;
  /** The block's first tile, in tiles. */
  tx0: number;
  ty0: number;
}

export interface CalcBlock {
  tiles: Tile[];
  /** The lowest and highest value (no data left out). */
  min: number;
  max: number;
  /** Pixels with a value. */
  covered: number;
}

/** Makes one block of a calculation. */
export function makeCalcBlock(task: CalcTask): CalcBlock {
  const { width, height } = task;
  const n = width * height;
  const values = task.inputs.map((read) => {
    const out = new Float32Array(n).fill(NaN);
    if (read) resampleMesh(read, out, width, height, 0, 1, task.resample, NaN);
    return out;
  });
  const result = evaluate(task.expr, values, n);
  let min = Infinity;
  let max = -Infinity;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const v = result[i];
    if (v !== v) continue;
    covered++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { tiles: cutTiles(result, width, height, 1, task.tileSize, task.tx0, task.ty0, NaN), min, max, covered };
}
