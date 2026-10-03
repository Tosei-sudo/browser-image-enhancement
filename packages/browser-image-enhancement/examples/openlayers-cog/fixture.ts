/**
 * A small georeferenced RGB GeoTIFF made in the browser, so the example (and
 * its browser test) can run without network access. Covers central Tokyo in
 * EPSG:4326 with a smooth color gradient and a few stripes.
 */
import { writeArrayBuffer } from 'geotiff';

export const FIXTURE_EXTENT = [139.6, 35.6, 139.9, 35.75] as const;

/**
 * The fixture as 16-bit values: the 8-bit picture mapped to 3000-8100, a
 * narrow part of the 0-65535 range like real 16-bit imagery. Read it with
 * `normalize: false` so the stretch is computed on these raw values.
 */
export function fixture16Blob(width = 768, height = 384): Blob {
  return fixtureBlob(width, height, true);
}

export function fixtureBlob(width = 768, height = 384, sixteenBit = false): Blob {
  const values = sixteenBit ? new Uint16Array(width * height * 3) : new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const stripe = Math.floor(x / 48) % 2 === 0 ? 0 : 24;
      const to = (v: number) => (sixteenBit ? 3000 + v * 20 : v);
      values[i] = to(Math.round((x / (width - 1)) * 200) + stripe);
      values[i + 1] = to(Math.round((y / (height - 1)) * 200) + stripe);
      values[i + 2] = to(120);
    }
  }
  const [minX, minY, maxX, maxY] = FIXTURE_EXTENT;
  const buffer = writeArrayBuffer(values, {
    width,
    height,
    SamplesPerPixel: 3,
    BitsPerSample: sixteenBit ? [16, 16, 16] : [8, 8, 8],
    SampleFormat: [1, 1, 1],
    PhotometricInterpretation: 2,
    ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
    ModelTiepoint: [0, 0, 0, minX, maxY, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
  });
  return new Blob([buffer], { type: 'image/tiff' });
}

/**
 * A 5-band 8-bit fixture, like multispectral imagery: band 1 a left-to-right
 * ramp, band 2 a top-to-bottom ramp, bands 3, 4 and 5 flat at 40, 120 and
 * 220, so any band assignment can be told apart by its pixel values.
 */
export function fixtureMultibandBlob(width = 768, height = 384): Blob {
  const bands = 5;
  const values = new Uint8Array(width * height * bands);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * bands;
      values[i] = Math.round((x / (width - 1)) * 200);
      values[i + 1] = Math.round((y / (height - 1)) * 200);
      values[i + 2] = 40;
      values[i + 3] = 120;
      values[i + 4] = 220;
    }
  }
  const [minX, minY, maxX, maxY] = FIXTURE_EXTENT;
  const buffer = writeArrayBuffer(values, {
    width,
    height,
    SamplesPerPixel: bands,
    BitsPerSample: new Array(bands).fill(8),
    SampleFormat: new Array(bands).fill(1),
    PhotometricInterpretation: 1,
    ExtraSamples: new Array(bands - 1).fill(0),
    ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
    ModelTiepoint: [0, 0, 0, minX, maxY, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
  });
  return new Blob([buffer], { type: 'image/tiff' });
}
