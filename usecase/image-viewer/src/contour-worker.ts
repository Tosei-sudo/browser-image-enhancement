/** Traces {@link traceContours} off the main thread, keeping the grid it was given once. */
import { traceContours, type ContourLine, type ContourRequest, type ElevationGrid } from './contours.js';

export type ContourMessage = { grid: ElevationGrid } | { id: number; request: ContourRequest };

export type ContourReply = { id: number; ok: true; lines: ContourLine[]; truncated: boolean } | { id: number; ok: false; message: string };

let grid: ElevationGrid | null = null;

self.onmessage = (e: MessageEvent<ContourMessage>) => {
  if ('grid' in e.data) {
    grid = e.data.grid;
    return;
  }
  const { id, request } = e.data;
  try {
    if (!grid) throw new Error('標高データがありません');
    const { lines, truncated } = traceContours(grid, request);
    const reply: ContourReply = { id, ok: true, lines, truncated };
    (self as unknown as Worker).postMessage(reply, lines.map((l) => l.coordinates.buffer as ArrayBuffer));
  } catch (error) {
    const reply: ContourReply = { id, ok: false, message: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(reply);
  }
};
