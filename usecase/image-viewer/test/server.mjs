// Static server for the browser test: serves the built site (dist/), a
// small georeferenced GeoTIFF at /fixture.tif with range requests, the way a
// COG is served from object storage, and stand-in services under /svc/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { serveService } from './services.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.tif': 'image/tiff' };
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

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = normalize(decodeURIComponent(url.pathname));
  if (await serveService(req, res, url, `http://localhost:${port}`)) return;
  const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (path === '/fixture.tif') {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!range) return res.writeHead(200, { ...headers, 'accept-ranges': 'bytes' }).end(tif);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : tif.length - 1, tif.length - 1);
    return res
      .writeHead(206, { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${tif.length}` })
      .end(tif.subarray(start, end + 1));
  }
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
