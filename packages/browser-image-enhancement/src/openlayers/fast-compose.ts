/**
 * A faster way for OpenLayers' GeoTIFF source to put the bands it read into
 * one tile.
 *
 * OpenLayers interleaves the bands of every tile on the main thread
 * (`composeTile_`) pixel by pixel through nested arrays, with a `clamp` call
 * and an `isNaN` test of the no-data value for every sample. On a large
 * image that was the costliest script on the main thread while panning, as
 * much as the rest of the map's drawing together. Here each band is copied
 * in a plain strided loop, with the scale and no-data test worked out once
 * per band; the result is the same array OpenLayers makes. Tiles whose bands
 * come in a form this does not expect go through OpenLayers as before.
 */

type Samples = ArrayLike<number>;
type Compose = (sourceTileSize: [number, number], sourceSamples: Samples[][]) => Uint8Array | Float32Array;

/** The parts of OpenLayers' `GeoTIFF` source read here (as of OpenLayers 10). */
interface ComposeHost {
  composeTile_?: Compose;
  metadata_?: Array<Array<Record<string, string> | null | undefined>>;
  sourceInfo_?: Array<{ bands?: number[]; min?: number | number[]; max?: number | number[]; nodata?: number | number[] }>;
  sourceImagery_?: unknown[];
  samplesPerPixel_?: number[];
  nodataValues_?: Array<Array<number | null | undefined>>;
  normalize_?: boolean;
  bandCount: number;
  hasAlpha: boolean;
}

/** The smallest and largest value of a sample type, as OpenLayers scales samples without statistics. */
function typeRange(array: Samples): [number, number] {
  if (array instanceof Int8Array) return [-128, 127];
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return [0, 255];
  if (array instanceof Int16Array) return [-32768, 32767];
  if (array instanceof Uint16Array) return [0, 65535];
  if (array instanceof Int32Array) return [-2147483648, 2147483647];
  if (array instanceof Uint32Array) return [0, 4294967295];
  if (array instanceof Float32Array) return [1.2e-38, 3.4e38];
  return [0, 255];
}

/** Puts the bands of each tile together with {@link composeFast} instead of OpenLayers' per-pixel loop. */
export function fastComposeTiles(source: object): void {
  const host = source as ComposeHost;
  const original = host.composeTile_;
  if (typeof original !== 'function') return;
  host.composeTile_ = (sourceTileSize, sourceSamples) =>
    composeFast(host, sourceTileSize, sourceSamples) ?? original.call(host, sourceTileSize, sourceSamples);
}

/** The tile OpenLayers' `composeTile_` makes, or null when the samples are not in the form expected. */
export function composeFast(host: ComposeHost, sourceTileSize: [number, number], sourceSamples: Samples[][]): Uint8Array | Float32Array | null {
  const sourceInfo = host.sourceInfo_;
  const samplesPerPixel = host.samplesPerPixel_;
  const nodataValues = host.nodataValues_;
  const metadata = host.metadata_;
  const sourceCount = host.sourceImagery_?.length;
  if (!sourceInfo || !samplesPerPixel || !nodataValues || !metadata || !sourceCount) return null;
  const normalize = !!host.normalize_;
  const hasAlpha = host.hasAlpha;
  const bandCount = host.bandCount;
  const pixelCount = sourceTileSize[0] * sourceTileSize[1];

  let written = hasAlpha ? 1 : 0;
  for (let s = 0; s < sourceCount; s++) {
    const n = samplesPerPixel[s];
    const bands = sourceSamples[s];
    if (!bands || bands.length < n) return null;
    for (let k = 0; k < n; k++) if (!bands[k] || bands[k].length < pixelCount) return null;
    const mask = sourceSamples[sourceCount + s];
    if (mask && (!mask[0] || mask[0].length < pixelCount)) return null;
    written += n;
  }
  // OpenLayers writes as many values a pixel as it reads: anything else is left to it.
  if (written !== bandCount) return null;

  const data = normalize ? new Uint8Array(pixelCount * bandCount) : new Float32Array(pixelCount * bandCount);
  // 1: the pixel is transparent (so far); only kept with an alpha band.
  const clear = hasAlpha ? new Uint8Array(pixelCount).fill(1) : null;

  let offset = 0;
  for (let s = 0; s < sourceCount; s++) {
    const info = sourceInfo[s];
    const n = samplesPerPixel[s];
    const stats = metadata[s]?.[0];
    for (let k = 0; k < n; k++, offset++) {
      const values = sourceSamples[s][k];
      const band = info.bands ? info.bands[k] - 1 : k;
      let gain = 1;
      let bias = 0;
      if (normalize) {
        let min = Array.isArray(info.min) ? info.min[band] : info.min;
        let max = Array.isArray(info.max) ? info.max[band] : info.max;
        if (min === undefined) min = stats && 'STATISTICS_MINIMUM' in stats ? parseFloat(stats.STATISTICS_MINIMUM) : typeRange(sourceSamples[s][0])[0];
        if (max === undefined) max = stats && 'STATISTICS_MAXIMUM' in stats ? parseFloat(stats.STATISTICS_MAXIMUM) : typeRange(sourceSamples[s][0])[1];
        gain = 255 / (max - min);
        bias = -min * gain;
      }
      // 8-bit samples over 0-255 are stored as they are: scaling them changes no value.
      const scale = normalize && !(gain === 1 && bias === 0 && (values instanceof Uint8Array || values instanceof Uint8ClampedArray));
      if (!clear) {
        copyBand(data, values, offset, bandCount, pixelCount, scale, gain, bias);
        continue;
      }
      let nodata: number | null | undefined;
      if (Array.isArray(info.nodata)) nodata = info.nodata[band] !== undefined ? info.nodata[band] : nodataValues[s][band];
      else if (info.nodata !== undefined) nodata = info.nodata;
      else nodata = nodataValues[s][band];
      // As OpenLayers tests it: a value equal to no data, or NaN when no data is NaN or not given, stays transparent.
      const nanNoData = isNaN(nodata as number);
      if (nanNoData ? isIntegerArray(values) : typeof nodata !== 'number') {
        // No value can be no data (integers are never NaN; a sample never equals null): every pixel shows.
        copyBand(data, values, offset, bandCount, pixelCount, scale, gain, bias);
        clear.fill(0);
      } else if (nanNoData) copyBandNotNaN(data, clear, values, offset, bandCount, pixelCount, scale, gain, bias);
      else copyBandNot(data, clear, values, nodata, offset, bandCount, pixelCount, scale, gain, bias);
    }
    const mask = sourceSamples[sourceCount + s];
    if (clear && mask) {
      const m = mask[0];
      for (let p = 0; p < pixelCount; p++) if (clear[p] === 0 && !m[p]) clear[p] = 1;
    }
  }
  if (clear) {
    for (let p = 0, i = bandCount - 1; p < pixelCount; p++, i += bandCount) if (clear[p] === 0) data[i] = 255;
  }
  return data;
}

function isIntegerArray(values: Samples): boolean {
  return (
    values instanceof Uint8Array ||
    values instanceof Uint8ClampedArray ||
    values instanceof Int8Array ||
    values instanceof Uint16Array ||
    values instanceof Int16Array ||
    values instanceof Uint32Array ||
    values instanceof Int32Array
  );
}

function copyBand(data: Uint8Array | Float32Array, values: Samples, offset: number, stride: number, pixelCount: number, scale: boolean, gain: number, bias: number): void {
  if (scale) {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) data[i] = Math.min(Math.max(gain * values[p] + bias, 0), 255);
  } else {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) data[i] = values[p];
  }
}

function copyBandNotNaN(
  data: Uint8Array | Float32Array,
  clear: Uint8Array,
  values: Samples,
  offset: number,
  stride: number,
  pixelCount: number,
  scale: boolean,
  gain: number,
  bias: number,
): void {
  if (scale) {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
      const v = values[p];
      if (v !== v) continue;
      clear[p] = 0;
      data[i] = Math.min(Math.max(gain * v + bias, 0), 255);
    }
  } else {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
      const v = values[p];
      if (v !== v) continue;
      clear[p] = 0;
      data[i] = v;
    }
  }
}

function copyBandNot(
  data: Uint8Array | Float32Array,
  clear: Uint8Array,
  values: Samples,
  nodata: unknown,
  offset: number,
  stride: number,
  pixelCount: number,
  scale: boolean,
  gain: number,
  bias: number,
): void {
  if (scale) {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
      const v = values[p];
      if (v === nodata) continue;
      clear[p] = 0;
      data[i] = Math.min(Math.max(gain * v + bias, 0), 255);
    }
  } else {
    for (let p = 0, i = offset; p < pixelCount; p++, i += stride) {
      const v = values[p];
      if (v === nodata) continue;
      clear[p] = 0;
      data[i] = v;
    }
  }
}
