import { describe, expect, it } from 'vitest';
import EnhancedGeoTIFF from '../../src/openlayers/enhanced-geotiff.js';
import type { BandSelection } from '../../src/index.js';

/** A source whose file never loads, so the band count stays unknown. */
const unready = (select?: BandSelection) => new EnhancedGeoTIFF({ sources: [{ blob: new Blob([]) }], select });

describe('EnhancedGeoTIFF band selection before the image is ready', () => {
  it('rejects indexes that can never be bands', async () => {
    for (const bad of [[-1, 1, 2], [0.5, 1, 2], [0, 1, Number.NaN], [-2]] as unknown as BandSelection[]) {
      expect(() => unready(bad)).toThrow(RangeError);
      await expect(unready().setSelect(bad)).rejects.toThrow(RangeError);
    }
    expect(() => unready([0, 1] as unknown as BandSelection)).toThrow(RangeError);
  });

  it('keeps valid indexes until the band count is known', async () => {
    const source = unready([3, 2, 1]);
    await source.setSelect([5]);
    await source.setSelect(null);
  });
});
