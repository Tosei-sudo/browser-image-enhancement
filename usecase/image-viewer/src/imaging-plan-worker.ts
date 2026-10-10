/** Plans imaging opportunities off the main thread (imaging-plan.ts), telling the share done as it goes. */
import { planAccess, type PlanOptions, type PlanTarget, type SatelliteSpec } from './imaging-plan.js';

export interface PlanJob {
  satellites: SatelliteSpec[];
  targets: PlanTarget[];
  options: PlanOptions;
}

self.onmessage = (event: MessageEvent<PlanJob>) => {
  const { satellites, targets, options } = event.data;
  try {
    const result = planAccess(satellites, targets, options, (done) => self.postMessage({ progress: done }));
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
