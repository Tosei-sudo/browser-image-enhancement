import { describe, expect, it } from 'vitest';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import { composeFast } from '../../src/openlayers/fast-compose.js';

/*
 * The bands of a tile put together in strided loops give exactly the tile
 * OpenLayers' own per-pixel loop gives: values, scaling, no data (numbers,
 * NaN, none) and masks, for one source or several.
 */

type Host = Parameters<typeof composeFast>[0];
const olCompose = (GeoTIFF.prototype as unknown as { composeTile_: (this: Host, size: [number, number], samples: unknown[][]) => Uint8Array | Float32Array }).composeTile_;

const W = 37;
const H = 23;

function band<T extends Uint8Array | Uint16Array | Int16Array | Float32Array>(Ctor: new (n: number) => T, seed: number, nodata?: number): T {
  const a = new Ctor(W * H);
  for (let i = 0; i < a.length; i++) {
    const v = ((i + 1) * 7919 * (seed + 3)) % 3001;
    a[i] = Ctor === (Float32Array as unknown) ? v / 7 - 50 : Ctor === (Int16Array as unknown) ? v - 1500 : v % (Ctor === (Uint8Array as unknown) ? 256 : 3001);
    if (i % 11 === seed % 11) a[i] = nodata ?? (Ctor === (Float32Array as unknown) ? NaN : 0);
  }
  return a;
}

function mask(seed: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = i % 7 === seed % 7 ? 0 : 255;
  return m;
}

interface Case {
  name: string;
  host: Partial<Host>;
  samples: unknown[][];
}

const cases: Case[] = [];
for (const normalize of [true, false]) {
  for (const hasAlpha of [true, false]) {
    cases.push(
      {
        name: `8-bit RGB normalize=${normalize} alpha=${hasAlpha}`,
        host: { normalize_: normalize, hasAlpha, bandCount: 3 + (hasAlpha ? 1 : 0), samplesPerPixel_: [3], sourceInfo_: [{}], nodataValues_: [[0, 0, 0]], metadata_: [[{}]] },
        samples: [[band(Uint8Array, 1), band(Uint8Array, 2), band(Uint8Array, 3)]],
      },
      {
        name: `16-bit with statistics and min/max normalize=${normalize} alpha=${hasAlpha}`,
        host: {
          normalize_: normalize,
          hasAlpha,
          bandCount: 2 + (hasAlpha ? 1 : 0),
          samplesPerPixel_: [2],
          sourceInfo_: [{ min: [10, undefined as unknown as number], bands: [2, 1] }],
          nodataValues_: [[null, 7]],
          metadata_: [[{ STATISTICS_MINIMUM: '3', STATISTICS_MAXIMUM: '2900' }]],
        },
        samples: [[band(Uint16Array, 4, 7), band(Uint16Array, 5, 7)]],
      },
      {
        name: `float with NaN and no no-data value normalize=${normalize} alpha=${hasAlpha}`,
        host: { normalize_: normalize, hasAlpha, bandCount: 1 + (hasAlpha ? 1 : 0), samplesPerPixel_: [1], sourceInfo_: [{}], nodataValues_: [[undefined]], metadata_: [[null]] },
        samples: [[band(Float32Array, 6)]],
      },
      {
        name: `16-bit without a no-data value normalize=${normalize} alpha=${hasAlpha}`,
        host: { normalize_: normalize, hasAlpha, bandCount: 1 + (hasAlpha ? 1 : 0), samplesPerPixel_: [1], sourceInfo_: [{}], nodataValues_: [[undefined]], metadata_: [[{}]] },
        samples: [[band(Uint16Array, 10)]],
      },
      {
        name: `8-bit over 0-255 with no data null normalize=${normalize} alpha=${hasAlpha}`,
        host: { normalize_: normalize, hasAlpha, bandCount: 3 + (hasAlpha ? 1 : 0), samplesPerPixel_: [3], sourceInfo_: [{ min: 0, max: 255 }], nodataValues_: [[null, null, null]], metadata_: [[null]] },
        samples: [[band(Uint8Array, 11), band(Uint8Array, 12), band(Uint8Array, 13)]],
      },
      {
        name: `two sources with masks and source no data normalize=${normalize} alpha=${hasAlpha}`,
        host: {
          normalize_: normalize,
          hasAlpha,
          bandCount: 3 + (hasAlpha ? 1 : 0),
          samplesPerPixel_: [2, 1],
          sourceInfo_: [{ nodata: 0, max: 200 }, { nodata: [-1500], min: -1500 }],
          nodataValues_: [[null, null], [null]],
          metadata_: [[{}], [{}]],
        },
        samples: [[band(Uint8Array, 7), band(Uint8Array, 8)], [band(Int16Array, 9, -1500)], [mask(1)], [mask(2)]],
      },
    );
  }
}

describe('composeFast', () => {
  for (const c of cases) {
    it(`gives OpenLayers' tile: ${c.name}`, () => {
      const host = { sourceImagery_: c.host.samplesPerPixel_!.map(() => []), ...c.host } as Host;
      const want = olCompose.call(host, [W, H], c.samples);
      const got = composeFast(host, [W, H], c.samples as never)!;
      expect(got).not.toBeNull();
      expect(got.constructor).toBe(want.constructor);
      expect(Array.from(got)).toEqual(Array.from(want));
    });
  }

  it('leaves tiles of an unexpected layout to OpenLayers', () => {
    const host = { sourceImagery_: [[]], normalize_: true, hasAlpha: false, bandCount: 4, samplesPerPixel_: [3], sourceInfo_: [{}], nodataValues_: [[0, 0, 0]], metadata_: [[{}]] } as unknown as Host;
    expect(composeFast(host, [W, H], [[band(Uint8Array, 1), band(Uint8Array, 2), band(Uint8Array, 3)]] as never)).toBeNull();
    expect(composeFast({ ...host, bandCount: 3 }, [W, H], [[band(Uint8Array, 1)]] as never)).toBeNull();
  });

  it('is faster than OpenLayers on a 512² RGB tile', () => {
    const size = 512 * 512;
    const rgb = [0, 1, 2].map((k) => Uint8Array.from({ length: size }, (_, i) => (i * (k + 3)) & 255));
    const host = { sourceImagery_: [[]], normalize_: true, hasAlpha: true, bandCount: 4, samplesPerPixel_: [3], sourceInfo_: [{}], nodataValues_: [[0, 0, 0]], metadata_: [[{}]] } as unknown as Host;
    const time = (f: () => unknown) => {
      for (let i = 0; i < 10; i++) f();
      const t = performance.now();
      for (let i = 0; i < 10; i++) f();
      return (performance.now() - t) / 10;
    };
    const ol = time(() => olCompose.call(host, [512, 512], [rgb]));
    const fast = time(() => composeFast(host, [512, 512], [rgb] as never));
    console.log(`composeTile 512² RGB+alpha: OpenLayers ${ol.toFixed(1)} ms, fast ${fast.toFixed(1)} ms`);
    expect(fast).toBeLessThan(ol);
  });
});
