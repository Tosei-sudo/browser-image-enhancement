/**
 * Runs a raster calculation (band math, change detection) over open images:
 * the bands are lined up on one grid as an RGB composite's are (see
 * composite-dialog.ts), the blocks are made in workers (raster-calc.ts), and
 * the result is a one-band 32-bit float GeoTIFF, NaN where there is no data.
 */
import type { Expr } from './band-math.js';
import { blocksOf, planComposite, readBlock, tagsOf, type Channel, type CompositePlan } from './composite-dialog.js';
import type { Resampling } from './composite.js';
import type { CalcBlock, CalcTask } from './raster-calc.js';
import type { CalcReply } from './raster-calc-worker.js';
import { TiledTiffWriter } from './tiff-stream.js';
import type { ViewerImage } from './images.js';

/** Tile size of the result. */
const TILE = 256;
const FLOAT32 = { format: 3, bits: 32 };

export interface CalcRequest {
  /** One band per variable of the expression. */
  inputs: Channel[];
  expr: Expr;
  /** Whose grid (position and pixel size) the result takes. */
  reference: ViewerImage;
  extent?: 'intersection' | 'union';
  resample?: Resampling;
  /** Called as blocks are made, 0–1. */
  onProgress?: (done: number) => void;
  /** Set `cancelled` to stop. */
  control?: { cancelled: boolean };
}

export interface CalcResult {
  blob: Blob;
  plan: CompositePlan;
  min: number;
  max: number;
}

/** The plan of a calculation (for saying what will be made); throws when it cannot be made. */
export function planCalc(inputs: readonly Channel[], reference: ViewerImage, extent: 'intersection' | 'union' = 'intersection'): CompositePlan {
  const plan = planComposite(inputs, reference, extent);
  return { ...plan, type: FLOAT32 };
}

/** Makes the result. */
export async function runCalc(request: CalcRequest): Promise<CalcResult> {
  const { inputs, expr, reference } = request;
  const plan = planCalc(inputs, reference, request.extent);
  const resample = request.resample ?? 'bilinear';
  const control = request.control ?? { cancelled: false };
  const { grid } = plan;
  const blocks = blocksOf(grid);
  const writer = new TiledTiffWriter({ width: grid.width, height: grid.height, bands: 1, sample: new Float32Array(0), tileSize: TILE, photometric: 1 });
  let min = Infinity;
  let max = -Infinity;
  let covered = 0;
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
    for (let i = 0; i < Math.min(threads, blocks.length); i++) workers.push(new Worker(new URL('./raster-calc-worker.ts', import.meta.url), { type: 'module' }));
    const lane = async (worker: Worker) => {
      while (next < blocks.length) {
        stop();
        const window = blocks[next++];
        const read = await readBlock(plan, inputs, window, FLOAT32, resample);
        stop();
        const task: CalcTask = { width: read.width, height: read.height, inputs: read.channels, expr, resample, tileSize: TILE, tx0: read.tx0, ty0: read.ty0 };
        const buffers = [...new Set(read.channels.flatMap((c) => (c ? [(c.data as unknown as { buffer: ArrayBuffer }).buffer] : [])))];
        const block = await call(worker, task, buffers);
        writer.add(block.tiles);
        min = Math.min(min, block.min);
        max = Math.max(max, block.max);
        covered += block.covered;
        done++;
        request.onProgress?.(done / blocks.length);
      }
    };
    await Promise.all(
      workers.map(async (worker) => {
        try {
          await lane(worker);
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
  if (!covered) throw new Error('値のある画素がありませんでした（画像が重なっていないか、すべてノーデータです）');
  const blob = writer.finish(await tagsOf(plan, [min], [max]));
  return { blob, plan, min, max };
}

function call(worker: Worker, task: CalcTask, transfer: Transferable[]): Promise<CalcBlock> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<CalcReply>) => (e.data.ok ? resolve(e.data.block) : reject(new Error(e.data.message)));
    worker.onerror = (e) => reject(new Error(e.message || '計算が止まりました'));
    worker.postMessage(task, transfer);
  });
}
