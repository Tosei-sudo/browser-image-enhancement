/** Files made in memory for the tests: a point Shapefile and a GeoTIFF without overviews. */

/** A point Shapefile's .shp. */
export function shp(points: Array<[number, number]>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(100 + points.length * 28);
  const v = new DataView(bytes.buffer);
  v.setInt32(0, 9994);
  v.setInt32(24, bytes.length / 2);
  v.setInt32(28, 1000, true);
  v.setInt32(32, 1, true);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((b, i) => v.setFloat64(36 + i * 8, b, true));
  points.forEach(([x, y], i) => {
    const at = 100 + i * 28;
    v.setInt32(at, i + 1);
    v.setInt32(at + 4, 10);
    v.setInt32(at + 8, 1, true);
    v.setFloat64(at + 12, x, true);
    v.setFloat64(at + 20, y, true);
  });
  return bytes;
}

/** A .dbf with character fields; `values` are the raw bytes of each cell. */
export function dbf(fields: Array<{ name: string; type?: string; length: number }>, rows: number[][][], ldid = 0): Uint8Array<ArrayBuffer> {
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((n, f) => n + f.length, 0);
  const bytes = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const v = new DataView(bytes.buffer);
  bytes[0] = 3;
  v.setUint32(4, rows.length, true);
  v.setUint16(8, headerLength, true);
  v.setUint16(10, recordLength, true);
  bytes[29] = ldid;
  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    for (let c = 0; c < f.name.length; c++) bytes[at + c] = f.name.charCodeAt(c);
    bytes[at + 11] = (f.type ?? 'C').charCodeAt(0);
    bytes[at + 16] = f.length;
  });
  bytes[headerLength - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerLength + r * recordLength;
    bytes[at++] = 0x20;
    row.forEach((cell, i) => {
      bytes.fill(0x20, at, at + fields[i].length);
      bytes.set(cell, at);
      at += fields[i].length;
    });
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

export const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
export const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
/** 東京 in Shift_JIS. */
export const tokyoSjis = [0x93, 0x8c, 0x8b, 0x9e];

/**
 * A GeoTIFF as plain as they come: one uncompressed strip of 8-bit RGB, no
 * tiles and no overviews, in WGS 84 / UTM zone 54N with 10 m pixels.
 */
export function plainGeoTiff(width: number, height: number): Uint8Array<ArrayBuffer> {
  const pixels = width * height * 3;
  const entries: Array<[tag: number, type: number, values: number[]]> = [
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, [8, 8, 8]],
    [259, 3, [1]],
    [262, 3, [2]],
    [273, 4, [0]], // strip offset, set below
    [277, 3, [3]],
    [278, 4, [height]],
    [279, 4, [pixels]],
    [284, 3, [1]],
    [33550, 12, [10, 10, 0]],
    [33922, 12, [0, 0, 0, 500000, 4000000, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32654]],
  ];
  const size = (type: number) => (type === 3 ? 2 : type === 4 ? 4 : 8);
  const ifdLength = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdLength;
  const placed = entries.map(([tag, type, values]) => {
    const bytes = values.length * size(type);
    const at = bytes > 4 ? extra : -1;
    if (bytes > 4) extra += bytes + (bytes % 2);
    return { tag, type, values, at };
  });
  const dataAt = extra;
  placed.find((e) => e.tag === 273)!.values = [dataAt];
  const out = new Uint8Array(dataAt + pixels);
  const v = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  v.setUint32(4, 8, true);
  v.setUint16(8, entries.length, true);
  const write = (at: number, type: number, values: number[]) =>
    values.forEach((x, i) => (type === 3 ? v.setUint16(at + i * 2, x, true) : type === 4 ? v.setUint32(at + i * 4, x, true) : v.setFloat64(at + i * 8, x, true)));
  placed.forEach(({ tag, type, values, at }, i) => {
    const e = 10 + i * 12;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, values.length, true);
    if (at >= 0) {
      v.setUint32(e + 8, at, true);
      write(at, type, values);
    } else {
      write(e + 8, type, values);
    }
  });
  // Fine vertical stripes: one-pixel lines that alias badly when sampled without overviews.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = dataAt + (y * width + x) * 3;
      const on = x % 2 === 0 ? 230 : 20;
      out[o] = on;
      out[o + 1] = on;
      out[o + 2] = (y * 255) / height;
    }
  }
  return out;
}

/** A .zip of `files`, stored without compression. */
export function zip(files: Array<{ name: string; bytes: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const crc = (data: Uint8Array) => {
    let c = ~0;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const header = (size: number, sig: number) => {
      const h = new Uint8Array(size + name.length);
      const v = new DataView(h.buffer);
      v.setUint32(0, sig, true);
      return { h, v };
    };
    const l = header(30, 0x04034b50);
    l.v.setUint16(4, 20, true);
    l.v.setUint32(14, crc(f.bytes), true);
    l.v.setUint32(18, f.bytes.length, true);
    l.v.setUint32(22, f.bytes.length, true);
    l.v.setUint16(26, name.length, true);
    l.h.set(name, 30);
    const c = header(46, 0x02014b50);
    c.v.setUint16(4, 20, true);
    c.v.setUint16(6, 20, true);
    c.v.setUint32(16, crc(f.bytes), true);
    c.v.setUint32(20, f.bytes.length, true);
    c.v.setUint32(24, f.bytes.length, true);
    c.v.setUint16(28, name.length, true);
    c.v.setUint32(42, offset, true);
    c.h.set(name, 46);
    local.push(l.h, f.bytes);
    central.push(c.h);
    offset += l.h.length + f.bytes.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, offset, true);
  const parts = [...local, ...central, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
