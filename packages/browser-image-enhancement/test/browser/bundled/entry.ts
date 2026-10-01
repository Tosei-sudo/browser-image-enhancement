// A consumer app that imports the published build and is bundled by Vite.
// Checks that the worker file referenced via `new URL(..., import.meta.url)` survives bundling.
import { configureWorkers, pipeline } from '../../../dist/index.js';

(window as unknown as { bundledResult: unknown }).bundledResult = (async () => {
  let workers = 0;
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      workers++;
    }
  };
  configureWorkers({ maxWorkers: 2, minStripPixels: 1000 });
  const data = new Uint8ClampedArray(100 * 100 * 4).map((_, i) => (i * 37) & 255);
  const img = new ImageData(data, 100, 100);
  const p = pipeline().contrast(0.3).saturation(0.4);
  const a = await p.run(img);
  const b = p.runSync(img);
  return { workers, same: a.data.every((v, i) => v === b.data[i]) };
})();
