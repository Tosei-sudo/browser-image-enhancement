// The simplest LERC2 (version 2) a decoder reads: 32-bit floats stored as
// they are ("one sweep"), with a mask when some pixels have no value (NaN).
// For the stand-in elevation tile service and its tests.
import { Buffer } from 'node:buffer';

/** `values` (`width` × `height`, row by row; NaN for none) as a LERC2 blob. */
export function encodeLerc(values, width, height) {
  const valid = [];
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    valid.push(values[i]);
    zMin = Math.min(zMin, values[i]);
    zMax = Math.max(zMax, values[i]);
  }
  const all = valid.length === values.length;
  // The mask: one bit a pixel (high bit first), run-length coded as literal runs of up to 32767 bytes, ended by -32768.
  let mask = Buffer.alloc(0);
  if (!all && valid.length) {
    const bits = Buffer.alloc(Math.ceil(values.length / 8));
    for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) bits[i >> 3] |= 128 >> (i & 7);
    const parts = [];
    for (let at = 0; at < bits.length; at += 32767) {
      const run = bits.subarray(at, at + 32767);
      const count = Buffer.alloc(2);
      count.writeInt16LE(run.length);
      parts.push(count, run);
    }
    const end = Buffer.alloc(2);
    end.writeInt16LE(-32768);
    mask = Buffer.concat([...parts, end]);
  }
  const header = Buffer.alloc(6 + 4 + 8 + 40);
  header.write('Lerc2 ', 0, 'ascii');
  header.writeInt32LE(2, 6); // version
  header.writeUInt32LE(height, 10);
  header.writeUInt32LE(width, 14);
  header.writeUInt32LE(valid.length, 18);
  header.writeInt32LE(8, 22); // micro block size
  // header.writeInt32LE(blob size, 26) below: decoders step to the next band by it.
  header.writeInt32LE(6, 30); // float
  header.writeDoubleLE(0, 34); // max error
  header.writeDoubleLE(valid.length ? zMin : 0, 42);
  header.writeDoubleLE(valid.length ? zMax : 0, 50);
  const maskSize = Buffer.alloc(4);
  maskSize.writeUInt32LE(mask.length);
  const blob = !valid.length || zMin === zMax ? Buffer.concat([header, maskSize, mask]) : Buffer.concat([header, maskSize, mask, Buffer.from([1]), Buffer.from(Float32Array.from(valid).buffer)]);
  blob.writeInt32LE(blob.length, 26);
  return blob;
}
