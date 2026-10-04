/** Averages windows of a GeoTIFF down off the main thread, for {@link withOverviews}. */
import { fromBlob } from 'geotiff';
import { reduceWindow, tileDecoder, type Reduced, type ReduceWindow } from './reduce.js';

export interface OverviewJob {
  file: Blob;
  windows: ReduceWindow[];
  f: number;
  noData: number | null;
}

export type OverviewReply = { type: 'window'; reduced: Reduced } | { type: 'done' } | { type: 'error'; message: string };

const post = (reply: OverviewReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async ({ data: job }: MessageEvent<OverviewJob>) => {
  try {
    const image = await (await fromBlob(job.file)).getImage();
    const decoder = await tileDecoder(image);
    for (const win of job.windows) {
      const reduced = await reduceWindow(image, win, job.f, job.noData, decoder);
      post({ type: 'window', reduced }, [reduced.data.buffer as ArrayBuffer]);
    }
    post({ type: 'done' });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
