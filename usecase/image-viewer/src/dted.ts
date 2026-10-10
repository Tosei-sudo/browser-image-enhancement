/**
 * DTED (Digital Terrain Elevation Data) level 0, 1 and 2 (.dt0, .dt1, .dt2):
 * one 1° × 1° cell of elevations in metres above mean sea level (EGM96),
 * as defined in MIL-PRF-89020B.
 *
 * The file is a 80-byte User Header Label (UHL), a 648-byte Data Set
 * Identification (DSI), a 2700-byte Accuracy Description (ACC), then one
 * record per longitude line, west to east. Each record holds the posts of
 * that line from south to north as 16-bit signed-magnitude integers.
 * Posts are points: the first one of the first record is exactly at the
 * cell's south-west corner.
 */

/** A DTED cell read into memory, north up. */
export interface Dted {
  /** `DTED0`, `DTED1` or `DTED2` (from the DSI, else from the post spacing); `GeoTIFF` for a GeoTIFF DEM. */
  level: string;
  /** Longitude of the westernmost post line, degrees. */
  west: number;
  /** Latitude of the southernmost post row, degrees. */
  south: number;
  /** Spacing between post lines (longitude) and rows (latitude), degrees. */
  spacing: [lon: number, lat: number];
  /** Posts across (longitude lines). */
  width: number;
  /** Posts down (latitude rows). */
  height: number;
  /** Elevations in metres, row by row from north to south; voids are {@link DTED_VOID} (a GeoTIFF DEM's are floats). */
  data: Int16Array | Float32Array;
  /** Absolute vertical accuracy in metres (90% linear error), when given. */
  verticalAccuracy: number | null;
}

/** Elevation of posts with no data. */
export const DTED_VOID = -32767;

const UHL_LENGTH = 80;
const DSI_LENGTH = 648;
const ACC_LENGTH = 2700;

/** Whether `name` looks like a DTED file. */
export function isDtedName(name: string): boolean {
  return /\.dt[0-2]$/i.test(name);
}

/** Reads a DTED file. Throws when it is not one. */
export function readDted(buffer: ArrayBuffer | Uint8Array): Dted {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Tape labels (VOL, HDR) may come first: look for the UHL in the first records.
  let uhl = -1;
  for (let at = 0; at <= Math.min(bytes.length - UHL_LENGTH, 4 * UHL_LENGTH); at += UHL_LENGTH) {
    if (text(bytes, at, 4) === 'UHL1') {
      uhl = at;
      break;
    }
  }
  if (uhl < 0) throw new Error('DTED のヘッダー（UHL）が見つかりません');

  const west = angle(text(bytes, uhl + 4, 8));
  const south = angle(text(bytes, uhl + 12, 8));
  const lonSpacing = int(text(bytes, uhl + 20, 4)) / 36000;
  const latSpacing = int(text(bytes, uhl + 24, 4)) / 36000;
  const accuracy = text(bytes, uhl + 28, 4).trim();
  const width = int(text(bytes, uhl + 47, 4));
  const height = int(text(bytes, uhl + 51, 4));
  if (!(lonSpacing > 0 && latSpacing > 0 && width > 1 && height > 1)) throw new Error('DTED のヘッダーが読めません');

  const dsi = uhl + UHL_LENGTH;
  const level = text(bytes, dsi + 59, 5).match(/^DTED[0-2]$/)?.[0] ?? levelOf(latSpacing);
  const first = dsi + DSI_LENGTH + ACC_LENGTH;
  const recordLength = 12 + 2 * height;
  if (bytes.length < first + recordLength * width) throw new Error('DTED のデータが途中で切れています');

  const data = new Int16Array(width * height);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let x = 0; x < width; x++) {
    const record = first + x * recordLength;
    if (bytes[record] !== 0xaa) throw new Error(`DTED のデータレコード ${x + 1} が壊れています`);
    const line = view.getUint16(record + 4); // longitude count: the record's place west to east
    const column = line < width ? line : x;
    for (let y = 0; y < height; y++) {
      const raw = view.getUint16(record + 8 + 2 * y);
      // Signed magnitude, not two's complement.
      const value = raw & 0x8000 ? -(raw & 0x7fff) : raw;
      data[(height - 1 - y) * width + column] = value;
    }
  }
  return {
    level,
    west,
    south,
    spacing: [lonSpacing, latSpacing],
    width,
    height,
    data,
    verticalAccuracy: /^\d+$/.test(accuracy) ? Number(accuracy) : null,
  };
}

/** `DDDMMSSH` (H is N, S, E or W) as degrees. */
function angle(value: string): number {
  const m = value.trim().match(/^(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])$/i);
  if (!m) throw new Error(`DTED の座標が読めません: ${value}`);
  const degrees = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  return /[SW]/i.test(m[4]) ? -degrees : degrees;
}

function int(value: string): number {
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : NaN;
}

function text(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** The level from the latitude spacing: 30″ for level 0, 3″ for level 1, 1″ for level 2. */
function levelOf(latSpacing: number): string {
  const seconds = latSpacing * 3600;
  return seconds >= 15 ? 'DTED0' : seconds >= 2 ? 'DTED1' : 'DTED2';
}
