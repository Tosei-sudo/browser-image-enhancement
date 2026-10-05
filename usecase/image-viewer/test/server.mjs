// Static server for the browser test: serves the built site (dist/), small
// georeferenced GeoTIFFs at /fixture.tif (8-bit) and /fixture16.tif (16-bit)
// with range requests, the way a COG is served from object storage, and
// stand-in services under /svc/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globals, writeArrayBuffer } from 'geotiff';
import { serveService } from './services.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.tif': 'image/tiff', '.json': 'application/json' };
const port = Number(process.env.PORT ?? 4175);

/** 512×256 RGB over central Tokyo (EPSG:4326): a red-green gradient on blue. */
function fixture(width = 512, height = 256) {
  const values = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      values[i] = Math.round((x / (width - 1)) * 200);
      values[i + 1] = Math.round((y / (height - 1)) * 200);
      values[i + 2] = 120;
    }
  }
  const [minX, minY, maxX, maxY] = [139.6, 35.6, 139.9, 35.75];
  return Buffer.from(
    writeArrayBuffer(values, {
      width,
      height,
      SamplesPerPixel: 3,
      BitsPerSample: [8, 8, 8],
      SampleFormat: [1, 1, 1],
      PhotometricInterpretation: 2,
      ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
      ModelTiepoint: [0, 0, 0, minX, maxY, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}
const tif = fixture();

// geotiff.js reads GDAL's metadata tags but has no type to write them with.
globals.fieldTagTypes[globals.tags.GDAL_METADATA] = 'ASCII';

/** GDAL's metadata XML naming the bands, as gdal_translate writes it. */
const bandNames = (names) =>
  `<GDALMetadata><Item name="AREA_OR_POINT">Area</Item>${names
    .map((n, i) => `<Item name="DESCRIPTION" sample="${i}" role="description">${n}</Item>`)
    .join('')}</GDALMetadata>`;

/**
 * 512×256, 4 bands of 16-bit values over the same area, like a Landsat
 * scene: a narrow part of 0-65535, with band 2 (0-based) brighter than the
 * others, as blue is in the haze of real imagery. Band 0 rises from left to right.
 * The bands are named Blue, Green, Red and NIR in GDAL's metadata.
 */
function fixture16(width = 512, height = 256) {
  const values = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      values[i] = 6000 + Math.round((x / (width - 1)) * 4000);
      values[i + 1] = 7000 + Math.round((y / (height - 1)) * 3000);
      values[i + 2] = 8500 + ((x + y) % 7) * 100;
      values[i + 3] = 15000;
    }
  }
  const [minX, minY, maxX, maxY] = [139.6, 35.6, 139.9, 35.75];
  return Buffer.from(
    writeArrayBuffer(values, {
      width,
      height,
      SamplesPerPixel: 4,
      BitsPerSample: [16, 16, 16, 16],
      SampleFormat: [1, 1, 1, 1],
      PhotometricInterpretation: 1,
      GDAL_METADATA: bandNames(['Blue', 'Green', 'Red', 'NIR']),
      ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
      ModelTiepoint: [0, 0, 0, minX, maxY, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}
const tif16 = fixture16();

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = normalize(decodeURIComponent(url.pathname));
  if (await serveService(req, res, url, `http://localhost:${port}`)) return;
  const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  let body;
  try {
    body = path === '/fixture.tif' ? tif : path === '/fixture16.tif' ? tif16 : await readFile(join(root, path === '/' ? 'index.html' : path));
  } catch {
    return res.writeHead(404).end('not found');
  }
  // Range requests, as object storage answers them (geotiff.js reads COGs in ranges).
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (!range) return res.writeHead(200, { ...headers, 'accept-ranges': 'bytes' }).end(body);
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
  res.writeHead(206, { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}` }).end(body.subarray(start, end + 1));
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
