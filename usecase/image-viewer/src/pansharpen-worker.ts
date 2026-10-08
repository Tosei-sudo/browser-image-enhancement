/**
 * Runs pan-sharpening off the main thread: fits the weights and gains on
 * windows of the images, or sharpens one block and cuts it into the tiles
 * of the GeoTIFF being written.
 */
import { fitPanSharpen, runPanSharpen, type PanSharpenJob } from './pansharpen.js';
import { cutTiles, type Tile, type TileSamples } from './tiff-stream.js';
import type { PanSharpenModel } from 'browser-image-enhancement';

export type PanSharpenTask =
  | { kind: 'fit'; jobs: PanSharpenJob[] }
  /** A block, whose first tile is `(tx0, ty0)` in tiles of `tileSize`. */
  | { kind: 'block'; job: PanSharpenJob; tileSize: number; tx0: number; ty0: number };

/** A sharpened block: its tiles, each band's lowest and highest value (no data left out), and the sample type. */
export interface PanSharpenBlock {
  tiles: Tile[];
  min: number[];
  max: number[];
  sample: TileSamples;
}

export type PanSharpenReply =
  | { ok: true; model: PanSharpenModel }
  | { ok: true; block: PanSharpenBlock }
  | { ok: false; message: string };

const post = (reply: PanSharpenReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<PanSharpenTask>) => {
  try {
    const task = e.data;
    if (task.kind === 'fit') {
      post({ ok: true, model: fitPanSharpen(task.jobs) });
      return;
    }
    const { raster } = runPanSharpen(task.job);
    const data = raster.data as TileSamples;
    const noData = raster.noData ?? null;
    const { min, max } = range(data, raster.bands, noData);
    const tiles = cutTiles(data, raster.width, raster.height, raster.bands, task.tileSize, task.tx0, task.ty0, noData ?? 0);
    const sample = new (data.constructor as new (n: number) => TileSamples)(0);
    post({ ok: true, block: { tiles, min, max, sample } }, tiles.map((t) => t.bytes.buffer as ArrayBuffer));
  } catch (error) {
    post({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};

/** Each band's lowest and highest value, leaving out no data and NaN. */
function range(data: TileSamples, bands: number, noData: number | null): { min: number[]; max: number[] } {
  const min = new Array<number>(bands).fill(Infinity);
  const max = new Array<number>(bands).fill(-Infinity);
  for (let i = 0; i < data.length; i += bands) {
    for (let b = 0; b < bands; b++) {
      const v = data[i + b];
      if (v !== v || v === noData) continue;
      if (v < min[b]) min[b] = v;
      if (v > max[b]) max[b] = v;
    }
  }
  return { min, max };
}
