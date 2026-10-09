/**
 * Runs {@link drawTriangles} in the library's worker pool, so reprojecting
 * tiles does not hold up the main thread while the map pans.
 */
import { getPool } from '../worker/pool.js';
import type { Pixels, ReprojectJob } from './reproject-kernel.js';

/** Negative ids, so they never meet the ids `execute` gives its strips on the same worker. */
let nextId = -1;

/** The tile drawn in a worker, or null when no worker can run (the caller then draws it itself). */
export async function drawInWorker(job: ReprojectJob): Promise<Pixels | null> {
  if (typeof Worker === 'undefined') return null;
  const pool = getPool();
  if (!pool.available) return null;
  let slot;
  try {
    [slot] = await pool.acquire(1);
  } catch {
    return null;
  }
  const id = nextId--;
  const float = job.stitch instanceof Float32Array;
  const { stitch, corners, ...rest } = job;
  const response = await pool.request(
    slot,
    { type: 'reproject', id, job: { ...rest, stitch: stitch.buffer as ArrayBuffer, corners: corners.buffer as ArrayBuffer, float } },
    [stitch.buffer as ArrayBuffer, corners.buffer as ArrayBuffer],
  );
  if (response.type !== 'reprojected') return null;
  return float ? new Float32Array(response.buffer) : new Uint8ClampedArray(response.buffer);
}
