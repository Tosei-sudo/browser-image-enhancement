import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromArrayBuffer } from 'geotiff';
import { isNitf, readNitf } from '../src/nitf.js';
import { cornersOf, nitfAsTiff } from '../src/nitf-tiff.js';
import { planOverviews } from '../src/overviews.js';
import { sensorPlacementOf, tiffInfo } from '../src/satellite.js';
import { parseSicd } from '../src/sicd.js';
import { sensorPlacement } from '../src/sensor-projection.js';

// Made with GDAL's NITF driver and sarpy's SICD writer: 40 × 30 pixels.
const W = 40;
const H = 30;
const fixture = (name: string) => new File([readFileSync(new URL(`./data/nitf/${name}`, import.meta.url))], name);

async function open(name: string) {
  const nitf = await nitfAsTiff(fixture(name));
  const tiff = await fromArrayBuffer(await nitf.file.arrayBuffer());
  return { nitf, image: await tiff.getImage() };
}

async function pixels(name: string): Promise<number[][]> {
  const { image } = await open(name);
  const bands = (await image.readRasters()) as unknown as ArrayLike<number>[];
  return bands.map((b) => Array.from(b));
}

const expected = (f: (x: number, y: number) => number) => Array.from({ length: W * H }, (_, i) => f(i % W, Math.floor(i / W)));

describe('NITF headers', () => {
  it('reads a NITF 2.1 image subheader', async () => {
    expect(await isNitf(fixture('rgb-blocks.ntf'))).toBe(true);
    const nitf = await readNitf(fixture('rgb-blocks.ntf'));
    expect(nitf.version).toBe('NITF02.10');
    expect(nitf.images).toHaveLength(1);
    const [image] = nitf.images;
    expect([image.rows, image.cols, image.nbpp, image.pixelType, image.represent, image.mode]).toEqual([H, W, 8, 'INT', 'RGB', 'B']);
    expect(image.bands.map((b) => b.represent)).toEqual(['R', 'G', 'B']);
    expect([image.blocksPerRow, image.blocksPerCol, image.blockWidth, image.blockHeight]).toEqual([3, 2, 16, 16]);
  });
});

describe('NITF as a GeoTIFF', () => {
  const rgb = [expected((x) => (x * 5) % 256), expected((_, y) => (y * 7) % 256), expected((x, y) => (x + y) % 256)];

  it.each(['rgb-blocks.ntf', 'rgb-pixel.ntf', 'rgb-sequential.ntf', 'rgb-row.ntf'])('reads the pixels of %s where they are', async (name) => {
    expect(await pixels(name)).toEqual(rgb);
    const { image } = await open(name);
    expect(image.fileDirectory.getValue('PhotometricInterpretation')).toBe(2);
  });

  it.each(['rgb-masked-blocks.ntf', 'rgb-masked-bands.ntf'])('reads a masked image (%s), a missing block empty', async (name) => {
    // Block 5 of 6 (x 16 to 31, y 16 to 29) is left out.
    const gap = (x: number, y: number) => x >= 16 && x < 32 && y >= 16;
    expect(await pixels(name)).toEqual(rgb.map((band) => band.map((v, i) => (gap(i % W, Math.floor(i / W)) ? 0 : v))));
  });

  it('places a north-up image by its corners', async () => {
    const { image } = await open('rgb-blocks.ntf');
    const [x0, y0] = image.getOrigin();
    const [dx, dy] = image.getResolution();
    // GDAL wrote the corner pixels' centres with three decimals.
    expect(x0).toBeCloseTo(139.7, 2);
    expect(y0).toBeCloseTo(35.7, 2);
    expect(dx).toBeCloseTo(0.001, 4);
    expect(dy).toBeCloseTo(-0.001, 4);
  });

  it('reads 16-bit values and the RPC00B model', async () => {
    expect(await pixels('rpc16.ntf')).toEqual([expected((x, y) => (x * 3 + y * 2) * 7)]);
    const { nitf } = await open('rpc16.ntf');
    const info = await tiffInfo(nitf.file);
    expect(info.rpc).not.toBeNull();
    const rpc = info.rpc!;
    expect([rpc.lineOff, rpc.sampOff, rpc.latOff, rpc.lonOff, rpc.heightOff, rpc.errBias]).toEqual([15, 20, 35.68, 139.75, 50, 1.5]);
    expect(rpc.sampNum[1]).toBe(1);
    expect(rpc.lineNum[2]).toBe(-1);
    // Not georeferenced otherwise: placed through its RPC model.
    expect(sensorPlacementOf(info, info.rpc)?.projection).toBeTruthy();
  });

  it('places a rotated image by ground control points from its corners', async () => {
    expect(await pixels('rotated.ntf')).toEqual([expected((x) => (x * 5) % 256)]);
    const { nitf } = await open('rotated.ntf');
    const info = await tiffInfo(nitf.file);
    expect(info.georeferenced).toBe(false);
    expect(info.gcps?.tiepoints.length).toBe(25 * 6);
    const placement = sensorPlacementOf(info, null)!;
    expect(placement.projection).toBeTruthy();
    // The first pixel's centre is where the geotransform put it (to the second of arc IGEOLO keeps).
    const ul = cornersOf(nitf.image)![0];
    expect(ul[0]).toBeCloseTo(139.7 + 0.0005 + 0.00015, 3);
    expect(ul[1]).toBeCloseTo(35.7 + 0.0001 - 0.0005, 3);
  });

  it('reads signed values placed by UTM corners', async () => {
    expect(await pixels('utm-int16.ntf')).toEqual([expected((x, y) => x - y * 3)]);
    const { nitf } = await open('utm-int16.ntf');
    const [lon, lat] = cornersOf(nitf.image)![0];
    expect(lon).toBeCloseTo(139.77, 1);
    expect(lat).toBeCloseTo(35.69, 1);
  });

  it('reads float bands', async () => {
    const [a, b] = await pixels('float2.ntf');
    expect(a[5]).toBeCloseTo(5 / W, 6);
    expect(b[W * 7]).toBeCloseTo(7 / H, 6);
  });

  it('gets an RSET like any GeoTIFF', async () => {
    const { nitf } = await open('rgb-blocks.ntf');
    const plan = await planOverviews(nitf.file, { geo: { modelPixelScale: [1, 1, 0], modelTiepoint: [0, 0, 0, 0, 0, 0] } });
    expect(plan).not.toBeNull();
    const out = await fromArrayBuffer(await (await plan!.build()).arrayBuffer());
    expect(await out.getImageCount()).toBeGreaterThan(1);
  });
});

describe('SICD', () => {
  it('reads the XML: pixel type, corners and facts', async () => {
    const { nitf } = await open('re32f.sicd');
    expect(nitf.sicd?.pixelType).toBe('RE32F_IM32F');
    expect(nitf.sicd?.corners?.[0]).toEqual([139.7, 35.7]);
    expect(nitf.sicd?.corners?.[2]).toEqual([139.81, 35.66]);
    expect(nitf.info).toContainEqual(['センサー', 'TESTSAT']);
    expect(parseSicd('<SICD><ImageData><PixelType>RE16I_IM16I</PixelType></ImageData></SICD>').corners).toBeNull();
  });

  it('shows 32-bit float complex pixels as amplitude', async () => {
    const [amplitude] = await pixels('re32f.sicd');
    const want = expected((x, y) => 1 + x + 2 * y);
    amplitude.forEach((a, i) => expect(a).toBeCloseTo(want[i], 3));
    const { image } = await open('re32f.sicd');
    expect(image.getSamplesPerPixel()).toBe(1);
  });

  it('joins a SICD split into image segments', async () => {
    const [amplitude] = await pixels('re32f-two-segments.sicd');
    const want = expected((x, y) => 1 + x + 2 * y);
    amplitude.forEach((a, i) => expect(a).toBeCloseTo(want[i], 3));
  });

  it('shows 16-bit integer complex pixels as amplitude', async () => {
    const [amplitude] = await pixels('re16i.sicd');
    expect(amplitude.slice(0, 4).map((a) => Number(a.toFixed(4)))).toEqual([1, 1, 2.2361, 3.6056]);
  });

  it('shows amplitude / phase pixels through the amplitude table', async () => {
    const [amplitude] = await pixels('amp8i.sicd');
    // Stored as numpy rounded them: half to even.
    const even = (v: number) => (v % 1 === 0.5 && Math.floor(v) % 2 === 0 ? Math.floor(v) : Math.round(v));
    const want = expected((x, y) => 2 * (even((1 + x + 2 * y) / 2) % 256));
    expect(amplitude).toEqual(want);
  });

  it('is placed by its image corners', async () => {
    const { nitf } = await open('re32f.sicd');
    const info = await tiffInfo(nitf.file);
    const placement = sensorPlacementOf(info, info.rpc)!;
    const [lon, lat] = sensorPlacement(placement.projection)!.model.toLonLat(0.5, 0.5);
    expect(lon).toBeCloseTo(139.7, 6);
    expect(lat).toBeCloseTo(35.7, 6);
  });
});

describe('NITF that cannot be read', () => {
  it('says JPEG 2000 is not read', async () => {
    await expect(nitfAsTiff(fixture('jpeg2000.ntf'))).rejects.toThrow(/JPEG 2000/);
  });
});
