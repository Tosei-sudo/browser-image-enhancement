// Static server for the browser test: serves the built site (dist/), small
// georeferenced GeoTIFFs at /fixture.tif (8-bit) and /fixture16.tif (16-bit)
// (and the satellite-product quirks in /fixture-*.tif) with range requests, the way a COG is served from object storage, and
// stand-in services under /svc/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globals, writeArrayBuffer } from 'geotiff';
import { serveService } from './services.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.tif': 'image/tiff', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
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

globals.fieldTagTypes[globals.tags.GDAL_NODATA] = 'ASCII';

/**
 * 512×256 RGB reflectances (float32, 0.02-0.35 rising from left to right),
 * the left 40 % filled with `fill`, as the corners of a rotated scene are.
 * With `nodata` the fill is tagged as no data (GDAL_NODATA, as text).
 */
function fixtureFill(fill, nodata, width = 512, height = 256) {
  const values = new Float32Array(width * height * 3);
  const edge = Math.round(width * 0.4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < edge ? fill : 0.02 + (0.33 * (x - edge)) / (width - edge - 1);
      values.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  const [minX, minY, maxX, maxY] = [139.6, 35.6, 139.9, 35.75];
  return Buffer.from(
    writeArrayBuffer(values, {
      width,
      height,
      SamplesPerPixel: 3,
      BitsPerSample: [32, 32, 32],
      SampleFormat: [3, 3, 3],
      PhotometricInterpretation: 2,
      ...(nodata ? { GDAL_NODATA: nodata } : {}),
      ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
      ModelTiepoint: [0, 0, 0, minX, maxY, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

/**
 * 8-bit RGB whose GDAL metadata carries statistics of a dark first band
 * (0-60): OpenLayers scales every band by them unless told otherwise.
 * Band 0 is 0-60, bands 1 and 2 are 100-200.
 */
function fixtureStats(width = 512, height = 256) {
  const values = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      values[i] = Math.round((x / (width - 1)) * 60);
      values[i + 1] = values[i + 2] = 100 + Math.round((x / (width - 1)) * 100);
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
      GDAL_METADATA:
        '<GDALMetadata><Item name="STATISTICS_MINIMUM" sample="0">0</Item><Item name="STATISTICS_MAXIMUM" sample="0">60</Item></GDALMetadata>',
      ModelPixelScale: [(maxX - minX) / width, (maxY - minY) / height, 0],
      ModelTiepoint: [0, 0, 0, minX, maxY, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

const FLOAT32_LOWEST = -3.4028234663852886e38;
const fixtures = {
  '/fixture.tif': tif,
  '/fixture16.tif': tif16,
  // A fill value not tagged as no data.
  '/fixture-fill.tif': fixtureFill(-9999),
  // The lowest float as fill, tagged with the rounded text ArcGIS and others write.
  '/fixture-nodata.tif': fixtureFill(FLOAT32_LOWEST, '-3.40282e+38'),
  '/fixture-stats.tif': fixtureStats(),
};

/** A red 40 m cube as a binary glTF (y up, its base at the origin). */
function cubeGlb() {
  const faces = [
    [[1, 0, 0], [[20, 0, -20], [20, 40, -20], [20, 40, 20], [20, 0, 20]]],
    [[-1, 0, 0], [[-20, 0, 20], [-20, 40, 20], [-20, 40, -20], [-20, 0, -20]]],
    [[0, 1, 0], [[-20, 40, -20], [-20, 40, 20], [20, 40, 20], [20, 40, -20]]],
    [[0, -1, 0], [[-20, 0, 20], [-20, 0, -20], [20, 0, -20], [20, 0, 20]]],
    [[0, 0, 1], [[20, 0, 20], [20, 40, 20], [-20, 40, 20], [-20, 0, 20]]],
    [[0, 0, -1], [[-20, 0, -20], [-20, 40, -20], [20, 40, -20], [20, 0, -20]]],
  ];
  const positions = new Float32Array(faces.flatMap(([, quad]) => quad.flat()));
  const normals = new Float32Array(faces.flatMap(([n]) => [n, n, n, n].flat()));
  const indices = new Uint16Array(faces.flatMap((_, f) => [0, 2, 1, 0, 3, 2].map((i) => f * 4 + i)));
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
  const padded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.9, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: padded.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-20, 0, -20], max: [20, 40, 20] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + padded.length, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, padded)]);
}

/** A 3D Tiles tileset of one cube standing at `lon`, `lat` on the ellipsoid (east-north-up there). */
function tileset(lon, lat) {
  const [a, e2] = [6378137, 6.69437999014e-3];
  const [l, p] = [(lon * Math.PI) / 180, (lat * Math.PI) / 180];
  const n = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const position = [n * Math.cos(p) * Math.cos(l), n * Math.cos(p) * Math.sin(l), n * (1 - e2) * Math.sin(p)];
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  return Buffer.from(
    JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        transform: [...east, 0, ...north, 0, ...up, 0, ...position, 1],
        boundingVolume: { box: [0, 0, 20, 20, 0, 0, 0, 20, 0, 0, 0, 20] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri: 'cube.glb' },
      },
    }),
  );
}

fixtures['/tiles/tileset.json'] = tileset(139.75, 35.68);
fixtures['/tiles/cube.glb'] = cubeGlb();

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = normalize(decodeURIComponent(url.pathname));
  if (await serveService(req, res, url, `http://localhost:${port}`)) return;
  const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  let body;
  try {
    body = fixtures[path] ?? (await readFile(join(root, path === '/' ? 'index.html' : path)));
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
