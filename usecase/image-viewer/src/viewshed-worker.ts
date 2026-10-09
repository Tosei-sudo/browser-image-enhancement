/** Runs {@link viewshed} for bands of rows off the main thread; the grid comes once, before the bands. */
import { viewshed, type ViewshedGrid, type ViewshedOptions } from './viewshed.js';

export type ViewshedMessage = { grid: ViewshedGrid } | { options: ViewshedOptions; rowStart: number; rowEnd: number };

export type ViewshedReply = { ok: true; rowStart: number; result: Uint8Array } | { ok: false; message: string };

let grid: ViewshedGrid | null = null;

self.onmessage = (e: MessageEvent<ViewshedMessage>) => {
  if ('grid' in e.data) {
    grid = e.data.grid;
    return;
  }
  const { options, rowStart, rowEnd } = e.data;
  try {
    if (!grid) throw new Error('標高データがありません');
    const result = viewshed(grid, options, rowStart, rowEnd);
    const reply: ViewshedReply = { ok: true, rowStart, result };
    (self as unknown as Worker).postMessage(reply, [result.buffer as ArrayBuffer]);
  } catch (error) {
    const reply: ViewshedReply = { ok: false, message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(reply);
  }
};
