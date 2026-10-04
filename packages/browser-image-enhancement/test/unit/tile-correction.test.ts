import { describe, expect, it } from 'vitest';
import { pipeline } from '../../src/index.js';
import { histogram } from '../../src/stats.js';
import TileCorrection from '../../src/openlayers/tile-correction.js';

/** A 2×1 picture: one dark and one mid-gray pixel. */
const image = { width: 2, height: 1, data: new Uint8ClampedArray([20, 20, 20, 255, 120, 120, 120, 255]) };

describe('TileCorrection', () => {
  it('keeps the pipeline and tells the layer to redraw', () => {
    const c = new TileCorrection();
    let changes = 0;
    c.on('change', () => changes++);
    c.setPipeline(pipeline().exposure(1));
    expect(c.getPipeline().ops).toEqual([{ op: 'exposure', ev: 1 }]);
    expect(c.getEffectivePipeline().ops).toEqual([{ op: 'exposure', ev: 1 }]);
    expect(changes).toBe(1);
    expect(c.getColorMode()).toBe('rgb');
    expect(c.getValueBandCount()).toBe(0);
  });

  it('fixes autoStretch from the statistics the layer gives it', () => {
    const c = new TileCorrection({ pipeline: pipeline().autoStretch({ lowPercent: 0, highPercent: 0 }) });
    expect(c.wantsStats()).toBe(false);
    c.setStats(histogram(image), { extent: [0, 0, 1, 1], z: 0, tiles: 0, pixels: 2 });
    const [step] = c.getEffectivePipeline().ops;
    expect(step.op).toBe('stretch');
    expect(c.getEffectivePipeline().needsStats).toBe(false);
    expect(c.getDraInfo()?.pixels).toBe(2);
  });
});

describe('TileCorrection.updateDra', () => {
  /** Enough of a map for updateDra. */
  const map = () => {
    const listeners: Array<() => void> = [];
    return {
      getView: () => ({ getCenter: () => [0, 0], getResolution: () => 1, getRotation: () => 0 }),
      getSize: () => [100, 100],
      once: (_: string, f: () => void) => listeners.push(f),
      listeners,
    };
  };

  it('asks the layer for statistics once per view, also when a change listener asks again', async () => {
    const c = new TileCorrection({ pipeline: pipeline().autoStretch() });
    const m = map();
    let changes = 0;
    // Like EnhanceControl: a change without statistics asks for them again.
    c.on('change', () => {
      changes++;
      void c.updateDra(m as never);
    });
    await c.updateDra(m as never);
    expect(c.wantsStats()).toBe(true);
    expect(changes).toBe(1);
    c.setStats(histogram(image), { extent: [0, 0, 1, 1], z: 0, tiles: 0, pixels: 2 });
    expect(c.wantsStats()).toBe(false);
    await c.updateDra(m as never);
    expect(changes).toBe(1);
  });
});
