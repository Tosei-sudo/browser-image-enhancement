import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromArrayBuffer, ImageFileDirectory } from 'geotiff';
import { isNitf, readNitf } from '../src/nitf.js';
import { cornersOf, nitfAsTiff } from '../src/nitf-tiff.js';
import { planOverviews } from '../src/overviews.js';
import { sensorPlacementOf, tiffInfo } from '../src/satellite.js';
import { parseSicd } from '../src/sicd.js';
import { readJ2kLayout, readSiz, tileCodestream, tileGrid } from '../src/j2k.js';
import { decodeJ2k } from '../src/j2k-decoder.js';
import { jpegIsRgb, ycbcrToRgb } from '../src/jpeg-blocks.js';
import { sensorPlacement } from '../src/sensor-projection.js';

// Made with GDAL's NITF driver and sarpy's SICD writer: 40 × 30 pixels.
// The JPEG 2000 ones are lossless (NPJE_NUMERICALLY_LOSSLESS), in 32 × 32 tiles; lossless-jpeg.ntf is rgb-blocks.ntf with IC C5 (and a COMRAT).
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

describe('big-endian arrays read a piece at a time', () => {
  // In a browser, arrays past the first piece of a directory read are deferred, and geotiff.js read them
  // as little-endian; src/geotiff-big-endian.ts (loaded with overviews.ts) reads them in the file's order.
  it('reads a deferred big-endian array of tile offsets right', async () => {
    const bytes = new DataView(new ArrayBuffer(24));
    [5, 70000, 2 ** 40].forEach((v, k) => bytes.setBigUint64(k * 8, BigInt(v)));
    const source = { fetch: async ([s]: Array<{ offset: number; length: number }>) => [bytes.buffer.slice(s.offset, s.offset + s.length)] };
    const deferred = (tag: number) => new Map([[tag, { source, arrayOffset: 0, littleEndian: false, fieldType: 16, length: 3, data: new Array(3), itemSize: 8 }]]);
    const directory = new ImageFileDirectory(new Map(), new Map(), deferred(324) as never, 0);
    expect(Number(await directory.loadValueIndexed('TileOffsets', 1))).toBe(70000);
    expect(Array.from((await directory.loadValue('TileOffsets')) as ArrayLike<number>, Number)).toEqual([5, 70000, 2 ** 40]);
    const other = new ImageFileDirectory(new Map(), new Map(), deferred(325) as never, 0);
    expect(Array.from((await other.loadValue('TileByteCounts')) as ArrayLike<number>, Number)).toEqual([5, 70000, 2 ** 40]);
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

describe('compressed NITF', () => {
  const rgb = [expected((x) => (x * 5) % 256), expected((_, y) => (y * 7) % 256), expected((x, y) => (x + y) % 256)];
  /** Lossy JPEG: within `tolerance` of what was written. */
  const near = (got: number[][], want: number[][], tolerance: number) =>
    expect(Math.max(...got.flatMap((band, b) => band.map((v, i) => Math.abs(v - want[b][i]))))).toBeLessThanOrEqual(tolerance);

  it.each(['jpeg2000-rgb.ntf', 'jpeg2000-one-tile.ntf'])('reads the JPEG 2000 tiles of %s (lossless) exactly', async (name) => {
    expect(await pixels(name)).toEqual(rgb);
    const { nitf, image } = await open(name);
    expect(nitf.image.compression).toBe('C8');
    expect(image.fileDirectory.getValue('PhotometricInterpretation')).toBe(2);
  });

  it('reads 16-bit JPEG 2000, unsigned and signed', async () => {
    expect(await pixels('jpeg2000-u16.ntf')).toEqual([expected((x, y) => (x * 3 + y * 2) * 7)]);
    expect(await pixels('jpeg2000-int16.ntf')).toEqual([expected((x, y) => x - y * 3)]);
  });

  it('makes a codestream of each JPEG 2000 tile, with the image area cut to the tile', async () => {
    const file = fixture('jpeg2000-rgb.ntf');
    const [image] = (await readNitf(file)).images;
    const layout = await readJ2kLayout(file, image.dataOffset, image.dataOffset + image.dataLength);
    expect(tileGrid(layout.siz)).toEqual([2, 1]);
    expect(layout.interleaved).toBe(false);
    const { offset, length } = layout.tiles[1];
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    const { codestream, index } = tileCodestream(layout.header, bytes);
    expect(index).toBe(1);
    const siz = readSiz(codestream);
    expect([siz.x0, siz.y0, siz.width, siz.height, siz.tileWidth, siz.tileHeight]).toEqual([32, 0, 40, 30, 8, 30]);
    const tile = await decodeJ2k(codestream);
    expect([tile.width, tile.height, tile.components]).toEqual([8, 30, 3]);
    expect(tile.data[0]).toBe(32 * 5);
  });

  it.each(['jpeg-rgb.ntf', 'jpeg-masked.ntf'])('reads the JPEG blocks of %s as RGB', async (name) => {
    // Within what JPEG decoders differ by (GDAL's libjpeg reads these within 4).
    near(await pixels(name), rgb, 8);
    const { nitf } = await open(name);
    expect(nitf.image.compression).toBe(name === 'jpeg-rgb.ntf' ? 'C3' : 'M3');
  });

  it('reads a grey JPEG', async () => {
    near(await pixels('jpeg-gray.ntf'), [expected((x) => (x * 5) % 256)], 1);
  });

  it.each(['jpeg2000-rgb.ntf', 'jpeg-rgb.ntf'])('gets an RSET of %s like any GeoTIFF', async (name) => {
    const { nitf } = await open(name);
    const plan = await planOverviews(nitf.file, { geo: { modelPixelScale: [1, 1, 0], modelTiepoint: [0, 0, 0, 0, 0, 0] } });
    const out = await fromArrayBuffer(await (await plan!.build()).arrayBuffer());
    expect(await out.getImageCount()).toBeGreaterThan(1);
  });

  it('turns YCbCr into RGB unless an Adobe marker says the JPEG holds RGB', () => {
    const data = Uint8Array.of(76, 85, 255, 150, 128, 128);
    ycbcrToRgb(data);
    expect(Array.from(data)).toEqual([254, 0, 0, 150, 150, 150]);
    const adobe = (transform: number) => Uint8Array.of(0xff, 0xd8, 0xff, 0xee, 0, 14, ...[...'Adobe'].map((c) => c.charCodeAt(0)), 0, 100, 0, 0, 0, 0, transform, 0xff, 0xda);
    expect(jpegIsRgb(adobe(0))).toBe(true);
    expect(jpegIsRgb(adobe(1))).toBe(false);
    expect(jpegIsRgb(Uint8Array.of(0xff, 0xd8, 0xff, 0xda))).toBe(false);
  });
});

describe('NITF that cannot be read', () => {
  it('says which compression is not read', async () => {
    await expect(nitfAsTiff(fixture('lossless-jpeg.ntf'))).rejects.toThrow(/には非対応/);
  });
});
