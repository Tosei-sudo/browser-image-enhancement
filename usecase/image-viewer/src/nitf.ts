/**
 * Reading NITF (National Imagery Transmission Format, MIL-STD-2500 /
 * NSIF) headers: the file header, each image segment's subheader with its
 * TREs, and the data extension segments (where a SICD keeps its XML). Only
 * headers are read; the pixels stay in the file (see nitf-tiff.ts).
 *
 * NITF 2.1 (and NSIF 1.0, the same layout) and NITF 2.0 are read.
 */

/** A tagged record extension: its 6-letter tag and its bytes. */
export interface Tre {
  tag: string;
  data: Uint8Array;
}

/** One band of an image segment. */
export interface NitfBand {
  /** IREPBAND: R, G, B, M (mono), LU (palette), I, Q, … (blank when none). */
  represent: string;
  /** ISUBCAT: a wavelength, I / Q for complex SAR, M / P for amplitude / phase. */
  subcategory: string;
  /** NLUTS: the number of lookup tables. */
  luts: number;
}

/** An image segment: its subheader fields and where its data is. */
export interface NitfImage {
  /** The segment's number in the file, from 0. */
  index: number;
  /** Where its data starts in the file, and how long it is. */
  dataOffset: number;
  dataLength: number;
  iid1: string;
  /** IID2 (NITF 2.1) or ITITLE (2.0). */
  title: string;
  /** IDATIM, as written (CCYYMMDDhhmmss). */
  datetime: string;
  targetId: string;
  source: string;
  rows: number;
  cols: number;
  /** PVTYPE: INT, SI, R, C or B. */
  pixelType: string;
  /** IREP: MONO, RGB, RGB/LUT, MULTI, NODISPLY, … */
  represent: string;
  /** ICAT: VIS, MS, SAR, … */
  category: string;
  /** ABPP: the bits actually used in each value. */
  abpp: number;
  /** PJUST: R (right-justified) or L. */
  justify: string;
  /** ICORDS: how IGEOLO is written (blank when there is none). */
  icords: string;
  igeolo: string;
  comments: string[];
  /** IC: NC (none), NM (masked), C3 (JPEG), C8 (JPEG 2000), … */
  compression: string;
  bands: NitfBand[];
  /** IMODE: B (by block), P (by pixel), R (by row) or S (band sequential). */
  mode: string;
  blocksPerRow: number;
  blocksPerCol: number;
  /** NPPBH, NPPBV: pixels per block (0 when the block is the whole width or height of a large image). */
  blockWidth: number;
  blockHeight: number;
  /** NBPP: the bits each value is stored in. */
  nbpp: number;
  /** IDLVL, IALVL and ILOC (row, column): where the segment goes relative to the one it is attached to. */
  displayLevel: number;
  attachLevel: number;
  location: [number, number];
  tres: Tre[];
}

/** A data extension segment: its DESID and where its data is. */
export interface NitfDes {
  id: string;
  dataOffset: number;
  dataLength: number;
}

/** What {@link readNitf} reads from a file. */
export interface NitfFile {
  /** FHDR and FVER: NITF02.10, NITF02.00 or NSIF01.00. */
  version: string;
  title: string;
  /** FDT, as written. */
  datetime: string;
  originator: string;
  /** CLEVEL, the complexity level. */
  complexity: string;
  /** FSCLAS: U, R, C, S or T. */
  classification: string;
  images: NitfImage[];
  des: NitfDes[];
  /** The file header's TREs. */
  tres: Tre[];
}

/** Whether a file name looks like a NITF file. */
export function isNitfName(name: string): boolean {
  return /\.(ntf|nitf|nsf|nsif|r0|sicd)$/i.test(name);
}

/** Whether `file` starts like a NITF (or NSIF) file. */
export async function isNitf(file: Blob): Promise<boolean> {
  const head = new TextDecoder('latin1').decode(await file.slice(0, 9).arrayBuffer());
  return /^(NITF0[12]\.[01]0|NSIF01\.00)$/.test(head);
}

/** Reads fixed-width text fields one after another. */
class Fields {
  private readonly text: string;
  constructor(
    readonly bytes: Uint8Array,
    public at = 0,
  ) {
    this.text = new TextDecoder('latin1').decode(bytes);
  }
  /** The next `n` characters, without trailing spaces. */
  s(n: number): string {
    if (this.at + n > this.bytes.length) throw new RangeError('NITF のヘッダーが途中で切れています');
    const v = this.text.slice(this.at, this.at + n);
    this.at += n;
    return v.replace(/[\s\0]+$/, '');
  }
  /** The next `n` characters as a number (0 when blank). */
  n(n: number): number {
    const t = this.s(n).trim();
    const v = t === '' ? 0 : Number(t);
    if (!Number.isFinite(v)) throw new Error(`NITF のヘッダーの数値が読めません（${t}）`);
    return v;
  }
  skip(n: number): void {
    this.at += n;
  }
  /** The next `n` bytes. */
  b(n: number): Uint8Array {
    const v = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
}

/** Reads the TREs packed in `bytes` (a UDHD, XHD, UDID or IXSHD field after its overflow number). */
export function readTres(bytes: Uint8Array): Tre[] {
  const tres: Tre[] = [];
  const f = new Fields(bytes);
  while (f.at + 11 <= bytes.length) {
    const tag = f.s(6);
    const length = f.n(5);
    tres.push({ tag, data: bytes.slice(f.at, f.at + length) });
    f.skip(length);
  }
  return tres;
}

/** Skips a security block: 167 characters in NITF 2.1; 2.0's has a downgrade event when FSDWNG is 999998. */
function security(f: Fields, v20: boolean): string {
  const start = f.at;
  const classification = f.s(1);
  if (!v20) {
    f.at = start + 167;
    return classification;
  }
  f.skip(40 + 40 + 40 + 20 + 20);
  const downgrade = f.s(6);
  if (downgrade === '999998') f.skip(40);
  return classification;
}

/** An extension field: its length, then (when there is any) a 3-digit overflow number and its TREs. */
function extensions(f: Fields, lengthDigits = 5): Tre[] {
  const length = f.n(lengthDigits);
  if (length <= 3) {
    f.skip(length);
    return [];
  }
  f.skip(3);
  return readTres(f.b(length - 3));
}

/** Reads the headers of a NITF file. Throws, with a message for the user, when it is not one this can read. */
export async function readNitf(file: Blob): Promise<NitfFile> {
  const read = async (from: number, length: number) => new Uint8Array(await file.slice(from, from + length).arrayBuffer());
  const start = read(0, 400);
  const first = new Fields(await start);
  const fhdr = first.s(4);
  const fver = first.s(5);
  const version = fhdr + fver;
  if (!/^(NITF02\.10|NITF02\.00|NSIF01\.00)$/.test(version)) throw new Error(`NITF ではないか、対応していない版です（${version || '不明'}）`);
  const v20 = version === 'NITF02.00';
  // Where HL is depends on the version; find it, then read the whole header.
  first.skip(2 + 4 + 10 + 14 + 80);
  security(first, v20);
  first.skip(5 + 5 + 1 + (v20 ? 0 : 3) + (v20 ? 27 : 24) + 18 + 12);
  const headerLength = first.n(6);
  const f = new Fields(await read(0, headerLength));
  f.skip(9);
  const complexity = f.s(2);
  f.skip(4); // STYPE
  const originator = f.s(10);
  const datetime = f.s(14);
  const title = f.s(80);
  const classification = security(f, v20);
  f.skip(5 + 5 + 1 + (v20 ? 0 : 3) + (v20 ? 27 : 24) + 18 + 12 + 6);

  const table = (count: number, subheaderDigits: number, dataDigits: number) =>
    Array.from({ length: count }, () => ({ subheader: f.n(subheaderDigits), data: f.n(dataDigits) }));
  const images = table(f.n(3), 6, 10);
  const graphics = table(f.n(3), 4, 6);
  const labels = v20 ? table(f.n(3), 4, 3) : (f.skip(3), []); // NUMX is reserved in 2.1
  const texts = table(f.n(3), 4, 5);
  const des = table(f.n(3), 4, 9);
  const res = table(f.n(3), 4, 7);
  const tres = [...extensions(f), ...extensions(f)];
  void res;

  let at = headerLength;
  const imageSegments: NitfImage[] = [];
  for (const [index, seg] of images.entries()) {
    imageSegments.push(readImageSubheader(await read(at, seg.subheader), index, at + seg.subheader, seg.data, v20));
    at += seg.subheader + seg.data;
  }
  for (const seg of [...graphics, ...labels, ...texts]) at += seg.subheader + seg.data;
  const desSegments: NitfDes[] = [];
  for (const seg of des) {
    const h = new Fields(await read(at, Math.min(seg.subheader, 64)));
    h.skip(2);
    desSegments.push({ id: h.s(25), dataOffset: at + seg.subheader, dataLength: seg.data });
    at += seg.subheader + seg.data;
  }
  return { version, title, datetime, originator, complexity, classification, images: imageSegments, des: desSegments, tres };
}

function readImageSubheader(bytes: Uint8Array, index: number, dataOffset: number, dataLength: number, v20: boolean): NitfImage {
  const f = new Fields(bytes);
  if (f.s(2) !== 'IM') throw new Error('NITF の画像セグメントが読めません');
  const iid1 = f.s(10);
  const datetime = f.s(14);
  const targetId = f.s(17);
  const title = f.s(80);
  security(f, v20);
  f.skip(1); // ENCRYP
  const source = f.s(42);
  const rows = f.n(8);
  const cols = f.n(8);
  const pixelType = f.s(3);
  const represent = f.s(8);
  const category = f.s(8);
  const abpp = f.n(2);
  const justify = f.s(1);
  const icords = f.s(1);
  // In NITF 2.0, ICORDS N means none; in 2.1, blank does.
  const hasGeolo = icords !== '' && !(v20 && icords === 'N');
  const igeolo = hasGeolo ? f.s(60) : '';
  const comments = Array.from({ length: f.n(1) }, () => f.s(80));
  const compression = f.s(2);
  if (compression !== 'NC' && compression !== 'NM') f.skip(4); // COMRAT
  let count = f.n(1);
  if (count === 0) count = f.n(5);
  const bands: NitfBand[] = [];
  for (let b = 0; b < count; b++) {
    const represent = f.s(2).trim();
    const subcategory = f.s(6).trim();
    f.skip(1 + 3); // IFC, IMFLT
    const luts = f.n(1);
    if (luts) f.skip(luts * f.n(5));
    bands.push({ represent, subcategory, luts });
  }
  f.skip(1); // ISYNC
  const mode = f.s(1);
  const blocksPerRow = f.n(4);
  const blocksPerCol = f.n(4);
  const blockWidth = f.n(4);
  const blockHeight = f.n(4);
  const nbpp = f.n(2);
  const displayLevel = f.n(3);
  const attachLevel = f.n(3);
  const location: [number, number] = [f.n(5), f.n(5)];
  f.skip(4); // IMAG
  const tres = [...extensions(f), ...extensions(f)];
  return {
    index,
    dataOffset,
    dataLength,
    iid1,
    title,
    datetime,
    targetId,
    source,
    rows,
    cols,
    pixelType,
    represent,
    category,
    abpp,
    justify,
    icords: hasGeolo ? icords : '',
    igeolo,
    comments,
    compression,
    bands,
    mode,
    blocksPerRow,
    blocksPerCol,
    blockWidth,
    blockHeight,
    nbpp,
    displayLevel,
    attachLevel,
    location,
    tres,
  };
}

/** The text of a TRE. */
export function treText(tre: Tre): string {
  return new TextDecoder('latin1').decode(tre.data);
}
