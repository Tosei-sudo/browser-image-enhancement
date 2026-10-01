/**
 * A small georeferenced RGB GeoTIFF made in the browser, so the example (and
 * its browser test) can run without network access. Covers central Tokyo in
 * EPSG:4326 with a smooth color gradient and a few stripes.
 */
import { writeArrayBuffer } from 'geotiff';

export const FIXTURE_EXTENT = [139.6, 35.6, 139.9, 35.75] as const;

export function fixtureBlob(width = 768, height = 384): Blob {
  const values = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const stripe = Math.floor(x / 48) % 2 === 0 ? 0 : 24;
      values[i] = Math.round((x / (width - 1)) * 200) + stripe;
      values[i + 1] = Math.round((y / (height - 1)) * 200) + stripe;
      values[i + 2] = 120;
    }
  }
  const [minX, minY, maxX, maxY] = FIXTURE_EXTENT;
  const buffer = writeArrayBuffer(values, {
    width,
    height,
    SamplesPerPixel: 3,
    BitsPerSample: [8, 8, 8],
    PhotometricInterpretation: 2,
    ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
    ModelTiepoint: [0, 0, 0, minX, maxY, 0],
    GeographicTypeGeoKey: 4326,
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
  });
  return new Blob([buffer], { type: 'image/tiff' });
}
