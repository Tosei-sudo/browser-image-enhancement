import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DTED_VOID, isDtedName, readDted } from '../src/dted.js';
import { elevationAt, geoidHeight } from '../src/dem.js';
import { isRpcName, parseRpcText, rpcBaseName, rpcFromTag, rpcProjector, type Rpc } from '../src/rpc.js';
import { fromMercator, orthorectify, toMercator } from '../src/ortho.js';
import { dted, rpcModel } from './fixtures.js';

const geoidBytes = readFileSync(new URL('../src/egm96.bin', import.meta.url));
const geoid = new Int16Array(geoidBytes.buffer.slice(geoidBytes.byteOffset, geoidBytes.byteOffset + geoidBytes.byteLength));

describe('DTED', () => {
  it('reads level 0, 1 and 2 cells', () => {
    for (const [level, spacing, posts] of [
      ['DTED0', 30, 121],
      ['DTED1', 3, 1201],
      ['DTED2', 1, 3601],
    ] as const) {
      const cell = readDted(dted({ west: 139, south: 35, spacing: [spacing, spacing], level, elevation: () => 10 }));
      expect(cell.level).toBe(level);
      expect([cell.width, cell.height]).toEqual([posts, posts]);
      expect(cell.west).toBe(139);
      expect(cell.south).toBe(35);
      expect(cell.spacing[1] * 3600).toBeCloseTo(spacing, 9);
    }
  });

  it('tells the level from the spacing when the DSI does not', () => {
    const cell = readDted(dted({ west: 139, south: 35, spacing: [2, 1], elevation: () => 0 }));
    expect(cell.level).toBe('DTED2');
    expect(cell.width).toBe(1801); // longitude spacing doubles above 50° in real files; any spacing is read
  });

  it('puts north at the top and reads signed-magnitude heights and voids', () => {
    const bytes = dted({
      west: -1,
      south: -1,
      spacing: [30, 30],
      elevation: (lon, lat) => (lon < -0.995 && lat > -0.01 ? -40000 : Math.round(lat * 1000)),
    });
    const cell = readDted(bytes);
    expect(cell.west).toBe(-1);
    expect(cell.south).toBe(-1);
    expect(cell.data[0]).toBe(DTED_VOID); // north-west corner
    expect(cell.data[1]).toBe(0); // north edge
    expect(cell.data[(cell.height - 1) * cell.width]).toBe(-1000); // south-west corner: negative
    expect(cell.verticalAccuracy).toBe(30);
  });

  it('rejects other files', () => {
    expect(() => readDted(new Uint8Array(4000))).toThrow(/UHL/);
    expect(isDtedName('n35_e139_1arc_v3.dt2')).toBe(true);
    expect(isDtedName('E139/N35.DT1')).toBe(true);
    expect(isDtedName('a.tif')).toBe(false);
  });

  it('samples elevations between posts', () => {
    const cell = readDted(dted({ west: 139, south: 35, spacing: [30, 30], elevation: (lon, lat) => (lon - 139) * 1000 + (lat - 35) * 100 }));
    expect(elevationAt([cell], 139.5, 35.5)).toBeCloseTo(550, 0);
    expect(elevationAt([cell], 139 + 1 / 240, 35)).toBeCloseTo(1000 / 240, 0);
    expect(elevationAt([cell], 140.5, 35.5)).toBeNull();
  });
});

describe('geoid', () => {
  it('gives EGM96 heights', () => {
    expect(geoidHeight(geoid, 139.77, 35.68)).toBeCloseTo(36.4, 0); // Tokyo
    expect(geoidHeight(geoid, 0, 0)).toBeCloseTo(17.2, 0);
    expect(geoidHeight(geoid, 147, -8)).toBeCloseTo(84, -1);
    expect(geoidHeight(geoid, 180, 0)).toBeCloseTo(geoidHeight(geoid, -180, 0), 6);
  });
});

describe('RPC', () => {
  const model = rpcModel(139.75, 35.65) as Rpc;

  it('projects and inverts', () => {
    const p = rpcProjector(model);
    expect(p.toImage(139.75, 35.65, 500)).toEqual([499.5, 499.5]);
    const [s, l] = p.toImage(139.76, 35.66, 1200);
    const [lon, lat] = p.toGround(s, l, 1200);
    expect(lon).toBeCloseTo(139.76, 8);
    expect(lat).toBeCloseTo(35.66, 8);
  });

  it('reads the GeoTIFF tag, RPB and _RPC.TXT', () => {
    const tag = [1, 2, model.lineOff, model.sampOff, model.latOff, model.lonOff, model.heightOff, model.lineScale, model.sampScale, model.latScale, model.lonScale, model.heightScale, ...model.lineNum, ...model.lineDen, ...model.sampNum, ...model.sampDen];
    expect(rpcFromTag(tag)).toEqual({ ...model, errBias: 1, errRand: 2 });

    const list = (c: number[]) => `(\n  ${c.map((v) => v.toExponential(15)).join(',\n  ')})`;
    const rpb = `satId = "XXXX";
bandId = "P";
SpecId = "RPC00B";
BEGIN_GROUP = IMAGE
  errBias = 3.0;
  errRand = 0.5;
  lineOffset = ${model.lineOff};
  sampOffset = ${model.sampOff};
  latOffset = ${model.latOff};
  longOffset = ${model.lonOff};
  heightOffset = ${model.heightOff};
  lineScale = ${model.lineScale};
  sampScale = ${model.sampScale};
  latScale = ${model.latScale};
  longScale = ${model.lonScale};
  heightScale = ${model.heightScale};
  lineNumCoef = ${list(model.lineNum)};
  lineDenCoef = ${list(model.lineDen)};
  sampNumCoef = ${list(model.sampNum)};
  sampDenCoef = ${list(model.sampDen)};
END_GROUP = IMAGE
END;`;
    expect(parseRpcText(rpb)).toEqual({ ...model, errBias: 3, errRand: 0.5 });

    const coeffs = (key: string, c: number[]) => c.map((v, i) => `${key}_${i + 1}: ${v}`).join('\n');
    const txt = `LINE_OFF: ${model.lineOff} pixels
SAMP_OFF: ${model.sampOff} pixels
LAT_OFF: ${model.latOff} degrees
LONG_OFF: ${model.lonOff} degrees
HEIGHT_OFF: ${model.heightOff} meters
LINE_SCALE: ${model.lineScale} pixels
SAMP_SCALE: ${model.sampScale} pixels
LAT_SCALE: ${model.latScale} degrees
LONG_SCALE: ${model.lonScale} degrees
HEIGHT_SCALE: ${model.heightScale} meters
${coeffs('LINE_NUM_COEFF', model.lineNum)}
${coeffs('LINE_DEN_COEFF', model.lineDen)}
${coeffs('SAMP_NUM_COEFF', model.sampNum)}
${coeffs('SAMP_DEN_COEFF', model.sampDen)}
`;
    expect(parseRpcText(txt)).toEqual(model);
    expect(() => parseRpcText('LINE_OFF: 1')).toThrow(/RPC/);
  });

  it('matches side files to images', () => {
    expect(isRpcName('scene.RPB')).toBe(true);
    expect(isRpcName('scene_RPC.TXT')).toBe(true);
    expect(isRpcName('scene.tif')).toBe(false);
    expect(rpcBaseName('Scene_RPC.TXT')).toBe('scene');
    expect(rpcBaseName('Scene.RPB')).toBe('scene');
  });
});

describe('orthorectify', () => {
  const lon0 = 139.75;
  const lat0 = 35.65;
  const model = rpcModel(lon0, lat0) as Rpc;
  // A mountain plateau 1500 m above sea level over the whole scene.
  const cell = readDted(dted({ west: 139, south: 35, spacing: [3, 3], elevation: () => 1500 }));
  const target: [number, number] = [139.76, 35.64];

  /** A 1000 × 1000 16-bit image, dark except a bright 3 × 3 spot where `target` is seen from the satellite. */
  function scene(height: number) {
    const [s, l] = rpcProjector(model).toImage(target[0], target[1], height);
    const data = new Uint16Array(1000 * 1000).fill(100);
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) data[(Math.round(l) + y) * 1000 + Math.round(s) + x] = 4000;
    return { width: 1000, height: 1000, bands: 1, data };
  }

  /** Where the brightest output pixel is, in degrees. */
  function brightest(result: ReturnType<typeof orthorectify>): [number, number] {
    const { raster, geoTransform } = result;
    let best = 0;
    for (let i = 1; i < raster.data.length; i++) if (raster.data[i] > raster.data[best]) best = i;
    const x = geoTransform[0] + ((best % raster.width) + 0.5) * geoTransform[1];
    const y = geoTransform[3] + (Math.floor(best / raster.width) + 0.5) * geoTransform[5];
    return fromMercator(x, y);
  }

  it('puts features at their place on the terrain', () => {
    const ellipsoidal = 1500 + geoidHeight(geoid, ...target);
    const result = orthorectify({ raster: scene(ellipsoidal), scale: 1, rpc: model, cells: [cell], geoid });
    expect(result.raster.data).toBeInstanceOf(Uint16Array);
    expect(result.demCoverage).toBe(1);
    const [lon, lat] = brightest(result);
    // About 11 m per pixel: within a pixel and a half.
    expect(Math.abs(lon - target[0]) * 111_000 * Math.cos((lat0 * Math.PI) / 180)).toBeLessThan(15);
    expect(Math.abs(lat - target[1]) * 111_000).toBeLessThan(15);
  });

  it('is off by the relief displacement without a DEM', () => {
    const ellipsoidal = 1500 + geoidHeight(geoid, ...target);
    const result = orthorectify({ raster: scene(ellipsoidal), scale: 1, rpc: model, cells: [], geoid });
    expect(result.demCoverage).toBe(0);
    const [, lat] = brightest(result);
    expect(Math.abs(lat - target[1]) * 111_000).toBeGreaterThan(500);
  });

  it('works on a reduced copy of the image', () => {
    const ellipsoidal = 1500 + geoidHeight(geoid, ...target);
    const full = scene(ellipsoidal);
    const half = new Uint16Array(500 * 500);
    for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) half[y * 500 + x] = Math.max(full.data[2 * y * 1000 + 2 * x], full.data[2 * y * 1000 + 2 * x + 1], full.data[(2 * y + 1) * 1000 + 2 * x], full.data[(2 * y + 1) * 1000 + 2 * x + 1]);
    const result = orthorectify({ raster: { width: 500, height: 500, bands: 1, data: half }, scale: 2, rpc: model, cells: [cell], geoid });
    const [lon, lat] = brightest(result);
    expect(Math.abs(lon - target[0]) * 111_000 * Math.cos((lat0 * Math.PI) / 180)).toBeLessThan(30);
    expect(Math.abs(lat - target[1]) * 111_000).toBeLessThan(30);
  });

  it('converts Web Mercator both ways', () => {
    const [lon, lat] = fromMercator(...toMercator(139.7671, 35.6812));
    expect(lon).toBeCloseTo(139.7671, 9);
    expect(lat).toBeCloseTo(35.6812, 9);
  });
});
