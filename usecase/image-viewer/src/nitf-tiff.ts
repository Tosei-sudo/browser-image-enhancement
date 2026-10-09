/**
 * Opening a NITF image (or a SICD) as a GeoTIFF without copying its pixels:
 * a BigTIFF header is put in front of the file whose strips or tiles point
 * at the NITF's own blocks, so the viewer reads it like any other local
 * GeoTIFF (only the parts shown, RSET made on open). NITF stores its values
 * big-endian, as the header says.
 *
 * - Uncompressed images (IC NC, and NM with its block mask: missing blocks
 *   read as empty), 8 to 64-bit integer or float values, any band
 *   interleave (by row only when the image is one block).
 * - Complex SAR (SICD, or I / Q bands) is read as detected amplitude by the
 *   decoder in complex-decoder.ts.
 * - Placement: an RPC00B (or RPC00A) TRE becomes the RPC tag (adjusted by
 *   ICHIPB for a chip); IGEOLO corners (or a SICD's image corners) become
 *   ground control points, or a plain north-up georeferencing when they
 *   are a north-up rectangle.
 * - JPEG and JPEG 2000 compressed images are not read.
 */
import { COMPLEX_COMPRESSION, COMPLEX_TAG, ComplexKind } from './complex-decoder.js';
import { readNitf, treText, type NitfFile, type NitfImage, type Tre } from './nitf.js';
import { isSicdXml, parseSicd, type SicdInfo } from './sicd.js';
import { WGS84_KEYS } from './sensor-projection.js';
import proj4 from 'proj4';
import { parseCoordinate } from './coordinates.js';
import { ascii } from './overviews.js';

/** A NITF file as a TIFF the viewer opens, and what it says about itself. */
export interface NitfAsTiff {
  /** The TIFF: a header in front of the NITF file. */
  file: File;
  nitf: NitfFile;
  /** The image segment shown (the first, for a SICD stitched from several). */
  image: NitfImage;
  sicd: SicdInfo | null;
  /** Rows for the layer's information. */
  info: Array<[string, string]>;
  /** Things the user should know (other image segments not shown, …). */
  notes: string[];
}

const COMPRESSIONS: Record<string, string> = {
  NC: '非圧縮',
  NM: '非圧縮（ブロックマスク付き）',
  C1: 'CCITT 二値',
  M1: 'CCITT 二値',
  C3: 'JPEG',
  M3: 'JPEG',
  C4: 'ベクトル量子化',
  M4: 'ベクトル量子化',
  C5: '可逆 JPEG',
  M5: '可逆 JPEG',
  C7: 'SAR 圧縮',
  M7: 'SAR 圧縮',
  C8: 'JPEG 2000',
  M8: 'JPEG 2000',
  I1: 'ダウンサンプル JPEG',
};

/** Rows for the information panel, by the source of the NITF image they describe. */
const fileInfo = new WeakMap<object, Array<[string, string]>>();

/** Keeps rows for the information panel with `source`. */
export function setFileInfo(source: object, rows: Array<[string, string]>): void {
  fileInfo.set(source, rows);
}

/** The rows kept with `source` by {@link setFileInfo}, if any. */
export function fileInfoOf(source: object): Array<[string, string]> {
  return fileInfo.get(source) ?? [];
}

/** Gives `to` (a source replacing `from`) the rows kept with `from`. */
export function copyFileInfo(from: object, to: object): void {
  const rows = fileInfo.get(from);
  if (rows) fileInfo.set(to, rows);
}

/** Reads `file`'s NITF headers and makes the TIFF that shows its image. Throws, with a message for the user, when it cannot. */
export async function nitfAsTiff(file: File): Promise<NitfAsTiff> {
  const nitf = await readNitf(file);
  if (!nitf.images.length) throw new Error('画像セグメントがありません');
  const sicdXml = await findSicdXml(file, nitf);
  const sicd = sicdXml ? parseSicd(sicdXml) : null;
  const notes: string[] = [];

  let segments: NitfImage[];
  if (sicd) {
    // A large SICD is split into image segments one below another.
    segments = nitf.images.filter((s) => s.cols === nitf.images[0].cols && s.bands.length === nitf.images[0].bands.length);
  } else {
    const shown = nitf.images.filter((s) => s.represent !== 'NODISPLY');
    const candidates = shown.length ? shown : nitf.images;
    const largest = candidates.reduce((a, b) => (b.rows * b.cols > a.rows * a.cols ? b : a));
    segments = [largest];
    if (nitf.images.length > 1) notes.push(`画像セグメントが ${nitf.images.length} 個あります。いちばん大きい ${largest.index + 1} 番目を表示します`);
  }
  const image = segments[0];
  const ic = image.compression;
  if (ic !== 'NC' && ic !== 'NM') throw new Error(`${COMPRESSIONS[ic] ?? ic} で圧縮された NITF には対応していません（非圧縮のみ）`);
  if (![8, 16, 32, 64].includes(image.nbpp)) throw new Error(`${image.nbpp} ビットの画素には対応していません`);

  const complex = complexKindOf(image, sicd);
  const layout = await blockLayout(file, segments, complex !== null);
  const rows = segments.reduce((n, s) => n + s.rows, 0);
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [image.cols] },
    { tag: 257, type: LONG, values: [rows] },
  ];
  let samples = image.bands.length;
  let bits = image.nbpp;
  let format = { INT: 1, SI: 2, R: 3 }[image.pixelType] ?? 0;
  if (complex !== null) {
    samples = 1;
    bits = 32;
    format = 3;
  } else if (!format || (format === 3 && bits < 32)) {
    throw new Error(`画素の型 ${image.pixelType}（${image.nbpp} ビット）には対応していません`);
  }
  const rgb = complex === null && samples === 3 && image.bands.map((b) => b.represent).join('') === 'RGB';
  entries.push(
    { tag: 258, type: SHORT, values: new Array(samples).fill(bits) },
    { tag: 259, type: SHORT, values: [complex === null ? 1 : COMPLEX_COMPRESSION] },
    { tag: 262, type: SHORT, values: [rgb ? 2 : 1] },
    { tag: 277, type: SHORT, values: [samples] },
    { tag: 284, type: SHORT, values: [layout.planar ? 2 : 1] },
    { tag: 339, type: SHORT, values: new Array(samples).fill(format) },
  );
  const extra = samples - (rgb ? 3 : 1);
  if (extra > 0) entries.push({ tag: 338, type: SHORT, values: new Array(extra).fill(0) });
  if (layout.tiled) {
    entries.push(
      { tag: 322, type: LONG, values: [layout.blockWidth] },
      { tag: 323, type: LONG, values: [layout.blockHeight] },
      { tag: 324, type: LONG8, values: layout.offsets },
      { tag: 325, type: LONG8, values: layout.counts },
    );
  } else {
    entries.push(
      { tag: 273, type: LONG8, values: layout.offsets },
      { tag: 278, type: LONG, values: [layout.blockHeight] },
      { tag: 279, type: LONG8, values: layout.counts },
    );
  }
  if (complex !== null) entries.push({ tag: COMPLEX_TAG, type: DOUBLE, values: [complex, ...(complex === ComplexKind.AmpPhase8 && sicd?.ampTable ? sicd.ampTable : [])] });

  // Where it goes: the RPC model, else the corners.
  const rpc = rpcOf(image);
  if (rpc) entries.push({ tag: 50844, type: DOUBLE, values: rpc });
  const corners = sicd?.corners ?? cornersOf(image);
  if (corners) {
    const placed = placeByCorners(corners, image.cols, rows);
    entries.push(...placed);
  }
  if (!rpc && !corners) notes.push('位置情報（RPC・四隅の座標）がないため、地図上の位置は正しくありません');

  const metadata = gdalMetadata(nitf, image, sicd, complex !== null);
  entries.push({ tag: 42112, type: ASCII, values: ascii(metadata) });
  if (layout.padValue !== null) entries.push({ tag: 42113, type: ASCII, values: ascii(String(layout.padValue)) });

  const header = bigTiffHeader(entries, (headerLength) => {
    // Offsets into the NITF file move by the header's length.
    const at = entries.find((e) => e.tag === 324 || e.tag === 273)!;
    at.values = layout.offsets.map((o, k) => (layout.counts[k] ? o + headerLength : 0));
  });
  const tiff = new File([header, file], file.name, { type: 'image/tiff', lastModified: file.lastModified });
  return { file: tiff, nitf, image, sicd, info: infoRows(nitf, image, sicd, segments.length), notes };
}

/** The SICD XML in the file's data extension segments, if there is one. */
async function findSicdXml(file: Blob, nitf: NitfFile): Promise<string | null> {
  for (const des of nitf.des) {
    if (des.dataLength > 64 * 1024 * 1024) continue;
    if (!/XML|SICD/i.test(des.id)) continue;
    const text = new TextDecoder().decode(await file.slice(des.dataOffset, des.dataOffset + des.dataLength).arrayBuffer());
    if (isSicdXml(text)) return text;
  }
  return null;
}

/** How a complex image's samples are stored, or null when it is not complex. */
function complexKindOf(image: NitfImage, sicd: SicdInfo | null): ComplexKind | null {
  if (sicd) return sicd.kind;
  const sub = image.bands.map((b) => b.subcategory.toUpperCase()).join(',');
  if (image.bands.length === 2 && sub === 'I,Q') {
    if (image.pixelType === 'R' && image.nbpp === 32) return ComplexKind.Float32;
    if (image.pixelType === 'SI' && image.nbpp === 16) return ComplexKind.Int16;
    if (image.pixelType === 'SI' && image.nbpp === 8) return ComplexKind.Int8;
  }
  if (image.bands.length === 2 && sub === 'M,P' && image.nbpp === 8) return ComplexKind.AmpPhase8;
  if (image.pixelType === 'C' && image.bands.length === 1 && image.nbpp === 64) return ComplexKind.Float32;
  return null;
}

interface BlockLayout {
  tiled: boolean;
  planar: boolean;
  blockWidth: number;
  blockHeight: number;
  /** Offsets in the NITF file (0 with a count of 0 for a missing block). */
  offsets: number[];
  counts: number[];
  /** The pad value of a masked image (its no-data). */
  padValue: number | null;
}

/**
 * The mask table of an NM image: where each block is from the start of its
 * data (0xFFFFFFFF for a missing one), and the pad value. The table has an
 * entry per block, or (as GDAL reads it, and always for band sequential
 * images) per block of each band, band after band: which one is told by
 * where the data starts.
 */
async function readMask(file: Blob, image: NitfImage): Promise<{ dataStart: number; blockOffsets: number[] | null; padValue: number | null }> {
  const head = new DataView(await file.slice(image.dataOffset, image.dataOffset + 10).arrayBuffer());
  const imdatoff = head.getUint32(0);
  const bmrLength = head.getUint16(4);
  const tmrLength = head.getUint16(6);
  const padBits = head.getUint16(8);
  const padBytes = Math.ceil(padBits / 8);
  let padValue: number | null = null;
  if (padBytes) {
    const pad = new DataView(await file.slice(image.dataOffset + 10, image.dataOffset + 10 + padBytes).arrayBuffer());
    padValue = 0;
    for (let i = 0; i < padBytes; i++) padValue = padValue * 256 + pad.getUint8(i);
    if (image.pixelType === 'SI' && padBytes * 8 === image.nbpp && padValue >= 2 ** (image.nbpp - 1)) padValue -= 2 ** image.nbpp;
    if (image.pixelType === 'R') padValue = padBytes === 4 ? pad.getFloat32(0) : padBytes === 8 ? pad.getFloat64(0) : null;
  }
  let blockOffsets: number[] | null = null;
  if (bmrLength === 4) {
    const blocks = image.blocksPerRow * image.blocksPerCol;
    const entries = (imdatoff - 10 - padBytes) / (tmrLength === 4 ? 8 : 4);
    const count = entries >= blocks * image.bands.length ? blocks * image.bands.length : blocks;
    const at = image.dataOffset + 10 + padBytes;
    const table = new DataView(await file.slice(at, at + count * 4).arrayBuffer());
    blockOffsets = Array.from({ length: count }, (_, k) => table.getUint32(k * 4));
  }
  return { dataStart: image.dataOffset + imdatoff, blockOffsets, padValue };
}

/**
 * Where the image's strips (an image in one block) or tiles (one per
 * block) are in the NITF file. Several segments (a large SICD) are stacked
 * as strips.
 */
async function blockLayout(file: Blob, segments: NitfImage[], complex: boolean): Promise<BlockLayout> {
  const image = segments[0];
  const bands = image.bands.length;
  const bytes = image.nbpp / 8;
  const width = image.blockWidth || image.cols;
  const height = image.blockHeight || image.rows;
  const blocks = image.blocksPerRow * image.blocksPerCol;
  const single = blocks === 1 && width === image.cols;
  // Bands in separate planes: by block and band sequential, and by row (as one-row strips).
  const planar = !complex && bands > 1 && image.mode !== 'P';
  if (complex && image.mode !== 'P' && bands > 1) throw new Error(`複素数の画像のバンドの並び（IMODE ${image.mode}）には対応していません`);
  if (image.mode === 'R' && bands > 1 && !single) throw new Error('行ごとにバンドが並ぶ（IMODE R）ブロック分割の画像には対応していません');
  if (segments.length > 1 && (!single || segments.some((s) => s.blocksPerRow * s.blocksPerCol !== 1 || s.compression !== 'NC' || s.mode !== image.mode || s.nbpp !== image.nbpp))) {
    throw new Error('複数の画像セグメントに分かれたブロック分割の画像には対応していません');
  }
  const offsets: number[] = [];
  const counts: number[] = [];
  let padValue: number | null = null;

  if (single) {
    // Strips across the width: as many rows as make about a megabyte, dividing every segment but the last.
    const rowBytes = image.cols * bytes * (planar ? 1 : bands);
    const total = segments.reduce((n, s) => n + s.rows, 0);
    let rowsPerStrip = image.mode === 'R' && bands > 1 ? 1 : Math.max(1, Math.min(total, Math.floor((1 << 20) / rowBytes)));
    for (const s of segments.slice(0, -1)) while (s.rows % rowsPerStrip) rowsPerStrip--;
    const planes = planar ? bands : 1;
    for (let b = 0; b < planes; b++) {
      for (const s of segments) {
        let start = s.dataOffset;
        if (s.compression === 'NM') {
          const mask = await readMask(file, s);
          start = mask.dataStart;
          padValue = mask.padValue;
        }
        const plane = (s.blockHeight || s.rows) * rowBytes;
        for (let r = 0; r < s.rows; r += rowsPerStrip) {
          const n = Math.min(rowsPerStrip, s.rows - r);
          // By row: row r of band b follows the bands before it in that row.
          offsets.push(image.mode === 'R' && bands > 1 ? start + (r * bands + b) * rowBytes : start + b * plane + r * rowBytes);
          counts.push(n * rowBytes);
        }
      }
    }
    return { tiled: false, planar, blockWidth: image.cols, blockHeight: rowsPerStrip, offsets, counts, padValue };
  }

  const bandBlock = width * height * bytes;
  const fullBlock = bandBlock * bands;
  const mask = image.compression === 'NM' ? await readMask(file, image) : null;
  padValue = mask?.padValue ?? null;
  const start = mask?.dataStart ?? image.dataOffset;
  // A mask entry for each band's block (band after band), or one for each block.
  const perBand = mask?.blockOffsets?.length === blocks * bands && bands > 1;
  const planes = planar ? bands : 1;
  for (let b = 0; b < planes; b++) {
    for (let k = 0; k < blocks; k++) {
      // Without a mask: blocks one after another, all bands of a block together, or (band sequential) a band's blocks together.
      const plain = image.mode === 'S' ? (b * blocks + k) * bandBlock : k * fullBlock + (planar ? b * bandBlock : 0);
      let offset = start + plain;
      let missing = false;
      if (mask?.blockOffsets) {
        const own = perBand ? mask.blockOffsets[b * blocks + k] : mask.blockOffsets[k];
        missing = own === 0xffffffff;
        offset = start + own + (perBand || image.mode === 'S' ? 0 : planar ? b * bandBlock : 0);
      }
      offsets.push(missing ? 0 : offset);
      counts.push(missing ? 0 : planar ? bandBlock : fullBlock);
    }
  }
  return { tiled: true, planar, blockWidth: width, blockHeight: height, offsets, counts, padValue };
}

/** RPC00A coefficient i is RPC00B coefficient RPC00A_TO_B[i]. */
const RPC00A_TO_B = [0, 1, 2, 3, 4, 5, 6, 10, 7, 8, 9, 11, 14, 17, 12, 15, 18, 13, 16, 19];

/** The 92 values of the GeoTIFF RPC tag from the image's RPC00B or RPC00A TRE (adjusted to a chip by ICHIPB); null when it has none. */
export function rpcOf(image: NitfImage): number[] | null {
  const tre = image.tres.find((t) => t.tag === 'RPC00B') ?? image.tres.find((t) => t.tag === 'RPC00A');
  if (!tre || tre.data.length < 1041) return null;
  const t = treText(tre);
  if (t[0] !== '1') return null; // SUCCESS
  const widths = [7, 7, 6, 5, 8, 9, 5, 6, 5, 8, 9, 5];
  let at = 1;
  const head = widths.map((w) => {
    const v = Number(t.slice(at, at + w));
    at += w;
    return v;
  });
  const coefficients: number[][] = [];
  for (let set = 0; set < 4; set++) {
    const values = Array.from({ length: 20 }, (_, i) => Number(t.slice(at + i * 12, at + i * 12 + 12).trim()));
    at += 240;
    if (tre.tag === 'RPC00A') {
      const b = new Array<number>(20);
      values.forEach((v, i) => (b[RPC00A_TO_B[i]] = v));
      coefficients.push(b);
    } else coefficients.push(values);
  }
  const values = [...head, ...coefficients.flat()];
  if (!values.every(Number.isFinite)) return null;
  const chip = image.tres.find((t) => t.tag === 'ICHIPB');
  if (chip) adjustToChip(values, treText(chip));
  return values;
}

/**
 * Makes RPC values for the full image give the chip's pixels, from ICHIPB:
 * chip coordinates (OP) and full image coordinates (FI) of the chip's
 * corners, in pixel-area coordinates (0.5 is the first pixel's centre).
 */
function adjustToChip(values: number[], text: string): void {
  const n = (from: number, length: number) => Number(text.slice(from, from + length));
  // XFRM_FLAG 2, SCALE_FACTOR 10, ANAMRPH_CORR 2, SCANBLK_NUM 2: the corners follow.
  const op = Array.from({ length: 8 }, (_, i) => n(16 + i * 12, 12));
  const fi = Array.from({ length: 8 }, (_, i) => n(16 + 96 + i * 12, 12));
  const [opRow11, opCol11, , opCol12, opRow21] = op;
  const [fiRow11, fiCol11, , fiCol12, fiRow21] = fi;
  if (![...op, ...fi].every(Number.isFinite)) return;
  const rowScale = opRow21 !== opRow11 ? (fiRow21 - fiRow11) / (opRow21 - opRow11) : 1;
  const colScale = opCol12 !== opCol11 ? (fiCol12 - fiCol11) / (opCol12 - opCol11) : 1;
  if (!(rowScale > 0 && colScale > 0)) return;
  // values: 2 LINE_OFF, 3 SAMP_OFF, 7 LINE_SCALE, 8 SAMP_SCALE.
  values[2] = (values[2] + 0.5 - fiRow11) / rowScale + opRow11 - 0.5;
  values[3] = (values[3] + 0.5 - fiCol11) / colScale + opCol11 - 0.5;
  values[7] /= rowScale;
  values[8] /= colScale;
}

/** The IGEOLO corners as longitude, latitude (first row first column, first row last column, last row last column, last row first column); null when there are none the viewer can read. */
export function cornersOf(image: NitfImage): Array<[number, number]> | null {
  const g = image.igeolo;
  if (g.length < 60) return null;
  const parts = [0, 1, 2, 3].map((i) => g.slice(i * 15, i * 15 + 15));
  const corners = parts.map((p): [number, number] | null => {
    switch (image.icords) {
      case 'D':
        return [Number(p.slice(7)), Number(p.slice(0, 7))];
      case 'G': {
        const dms = (d: string, m: string, s: string, h: string) => (Number(d) + Number(m) / 60 + Number(s) / 3600) * (h === 'S' || h === 'W' ? -1 : 1);
        return [dms(p.slice(7, 10), p.slice(10, 12), p.slice(12, 14), p[14]), dms(p.slice(0, 2), p.slice(2, 4), p.slice(4, 6), p[6])];
      }
      case 'N':
      case 'S':
        return proj4(`+proj=utm +zone=${Number(p.slice(0, 2))}${image.icords === 'S' ? ' +south' : ''} +datum=WGS84`, 'EPSG:4326', [Number(p.slice(2, 8)), Number(p.slice(8, 15))]) as [number, number];
      case 'U':
        return parseCoordinate(p.trim());
      default:
        return null;
    }
  });
  if (corners.some((c) => !c || !c.every(Number.isFinite))) return null;
  return corners as Array<[number, number]>;
}

/**
 * Georeferencing from corner coordinates (pixel centres): a pixel size and
 * a tie point when they make a north-up rectangle, else ground control
 * points on a 5 × 5 grid between them.
 */
function placeByCorners(corners: Array<[number, number]>, width: number, height: number): Entry[] {
  const [ul, ur, lr, ll] = corners;
  const keys: Entry = { tag: 34735, type: SHORT, values: WGS84_KEYS };
  const dx = (ur[0] - ul[0]) / Math.max(1, width - 1);
  const dy = (ul[1] - ll[1]) / Math.max(1, height - 1);
  const tolerance = 1e-6 * Math.max(Math.abs(dx), Math.abs(dy)) * Math.max(width, height);
  const northUp =
    dx > 0 && dy > 0 && Math.abs(ul[1] - ur[1]) <= tolerance && Math.abs(ll[1] - lr[1]) <= tolerance && Math.abs(ul[0] - ll[0]) <= tolerance && Math.abs(ur[0] - lr[0]) <= tolerance;
  if (northUp) {
    return [
      { tag: 33550, type: DOUBLE, values: [dx, dy, 0] },
      { tag: 33922, type: DOUBLE, values: [0, 0, 0, ul[0] - dx / 2, ul[1] + dy / 2, 0] },
      keys,
    ];
  }
  const tiepoints: number[] = [];
  const n = 5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const v = j / (n - 1);
      const lon = (1 - u) * (1 - v) * ul[0] + u * (1 - v) * ur[0] + u * v * lr[0] + (1 - u) * v * ll[0];
      const lat = (1 - u) * (1 - v) * ul[1] + u * (1 - v) * ur[1] + u * v * lr[1] + (1 - u) * v * ll[1];
      tiepoints.push(0.5 + u * (width - 1), 0.5 + v * (height - 1), 0, lon, lat, 0);
    }
  }
  return [{ tag: 33922, type: DOUBLE, values: tiepoints }, keys];
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** GDAL metadata: each band's name (IREPBAND / ISUBCAT) and the NITF header fields, as GDAL's NITF driver names them. */
function gdalMetadata(nitf: NitfFile, image: NitfImage, sicd: SicdInfo | null, complex: boolean): string {
  const items: string[] = [];
  const item = (name: string, value: string, sample?: number) => {
    if (value) items.push(`<Item name="${name}"${sample === undefined ? '' : ` sample="${sample}" role="description"`}>${escapeXml(value)}</Item>`);
  };
  if (complex) item('DESCRIPTION', 'Amplitude', 0);
  else image.bands.forEach((b, i) => item('DESCRIPTION', [b.represent, b.subcategory].filter(Boolean).join(' ') || '', i));
  item('NITF_FHDR', nitf.version);
  item('NITF_FTITLE', nitf.title);
  item('NITF_FDT', nitf.datetime);
  item('NITF_OSTAID', nitf.originator);
  item('NITF_IID1', image.iid1);
  item('NITF_IID2', image.title);
  item('NITF_IDATIM', image.datetime);
  item('NITF_ISORCE', image.source);
  item('NITF_ICAT', image.category);
  item('NITF_IREP', image.represent);
  item('NITF_PVTYPE', image.pixelType);
  item('NITF_ABPP', String(image.abpp));
  item('NITF_IC', image.compression);
  item('NITF_IMODE', image.mode);
  item('NITF_ICORDS', image.icords);
  item('NITF_IGEOLO', image.igeolo);
  image.comments.forEach((c, i) => item(`NITF_IMAGE_COMMENTS_${i + 1}`, c));
  const tres = [...new Set([...nitf.tres, ...image.tres].map((t: Tre) => t.tag))];
  item('NITF_TRE', tres.join(', '));
  for (const [field, value] of sicd?.fields ?? []) item(`SICD_${field}`, value);
  return `<GDALMetadata>${items.join('')}</GDALMetadata>`;
}

/** Rows for the layer's information. */
function infoRows(nitf: NitfFile, image: NitfImage, sicd: SicdInfo | null, segments: number): Array<[string, string]> {
  const rows: Array<[string, string]> = [['元の形式', sicd ? `SICD（${nitf.version}）` : nitf.version]];
  if (image.iid1 || image.title) rows.push(['画像 ID', [image.iid1, image.title].filter(Boolean).join('・')]);
  const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(image.datetime);
  if (date) rows.push(['撮影日時', `${date[1]}-${date[2]}-${date[3]} ${date[4]}:${date[5]}:${date[6]} UTC`]);
  if (sicd) {
    rows.push(['表示', '複素数から求めた振幅'], ...sicd.facts);
    if (segments > 1) rows.push(['画像セグメント', `${segments} 個をつないで表示`]);
    return rows;
  }
  if (image.source) rows.push(['センサー', image.source]);
  rows.push(['画素', `${image.pixelType} ${image.abpp}/${image.nbpp} ビット・${image.represent || '-'}・${COMPRESSIONS[image.compression] ?? image.compression}`]);
  return rows;
}

// ---- A BigTIFF header with one image directory ----

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const DOUBLE = 12;
const LONG8 = 16;
const TYPE_SIZE: Record<number, number> = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [LONG8]: 8 };

interface Entry {
  tag: number;
  type: number;
  values: number[];
}

/**
 * A big-endian BigTIFF header and its one directory, values after it.
 * `beforeWrite` is called with the header's length once it is known, to
 * set values that depend on it (the same number of them).
 */
function bigTiffHeader(entries: Entry[], beforeWrite: (length: number) => void): ArrayBuffer {
  entries.sort((a, b) => a.tag - b.tag);
  const directory = 16;
  let at = directory + 8 + entries.length * 20 + 8;
  const places = entries.map((e) => {
    const size = TYPE_SIZE[e.type] * e.values.length;
    if (size <= 8) return -1;
    const p = at;
    at += size + (size & 1);
    return p;
  });
  const length = at + ((8 - (at % 8)) % 8);
  beforeWrite(length);
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4d4d);
  view.setUint16(2, 43);
  view.setUint16(4, 8);
  view.setUint16(6, 0);
  view.setBigUint64(8, BigInt(directory));
  view.setBigUint64(directory, BigInt(entries.length));
  entries.forEach((e, i) => {
    const p = directory + 8 + i * 20;
    view.setUint16(p, e.tag);
    view.setUint16(p + 2, e.type);
    view.setBigUint64(p + 4, BigInt(e.values.length));
    if (places[i] < 0) writeValues(view, p + 12, e);
    else {
      view.setBigUint64(p + 12, BigInt(places[i]));
      writeValues(view, places[i], e);
    }
  });
  view.setBigUint64(directory + 8 + entries.length * 20, 0n);
  return buffer;
}

function writeValues(view: DataView, at: number, e: Entry): void {
  const step = TYPE_SIZE[e.type];
  e.values.forEach((v, k) => {
    const p = at + k * step;
    if (e.type === ASCII) view.setUint8(p, v);
    else if (e.type === SHORT) view.setUint16(p, v);
    else if (e.type === LONG) view.setUint32(p, v);
    else if (e.type === LONG8) view.setBigUint64(p, BigInt(v));
    else view.setFloat64(p, v);
  });
}
