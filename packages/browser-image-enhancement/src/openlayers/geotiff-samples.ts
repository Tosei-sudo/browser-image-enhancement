/**
 * What OpenLayers' GeoTIFF source does not tell about the samples it reads:
 * whether they are plain 8-bit values, and the float32 no-data value as the
 * file really holds it.
 */
import type GeoTIFF from 'ol/source/GeoTIFF.js';

/** The parts of geotiff.js images that tell the sample type. */
interface SampleInfo {
  getSamplesPerPixel(): number;
  getBitsPerSample(sample?: number): number;
  getSampleFormat(sample?: number): number;
}

/**
 * True when every image the source reads holds unsigned 8-bit samples. Reads
 * the images OpenLayers opened (`sourceImagery_`, set before the loader);
 * false when they cannot be read, so the values are stretched here.
 */
export function isEightBit(source: GeoTIFF): boolean {
  const imagery = (source as unknown as { sourceImagery_?: SampleInfo[][] }).sourceImagery_;
  if (!Array.isArray(imagery) || imagery.length === 0) return false;
  try {
    return imagery.every((levels) => {
      const image = levels?.[0];
      if (!image) return false;
      for (let s = 0; s < image.getSamplesPerPixel(); s++) {
        if (image.getBitsPerSample(s) !== 8 || (image.getSampleFormat(s) ?? 1) !== 1) return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Makes OpenLayers read an 8-bit image's values as they are (0-255). Given no
 * `min`/`max`, it scales every band by the `STATISTICS_MINIMUM`/`MAXIMUM`
 * that GDAL wrote for the first band, so a file with statistics (of a darker
 * first band, or stale ones) comes out washed out or all white.
 */
export function keepEightBitRange(source: GeoTIFF): void {
  const info = (source as unknown as { sourceInfo_?: Array<{ min?: unknown; max?: unknown }> }).sourceInfo_;
  for (const s of info ?? []) {
    s.min ??= 0;
    s.max ??= 255;
  }
}

/** Largest float32 value. */
const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * For a float32 image whose no-data value OpenLayers cannot match: the
 * test for that value. `GDAL_NODATA` is text, often rounded
 * ("-3.40282e+38" for the lowest float), so a sample never equals the
 * number read from it, and the fill shows instead of being transparent.
 * GDAL itself writes the overviews with the rounded value cast to float32,
 * and the full image often with the exact lowest float: as GDAL does, a
 * value close to the largest float stands for any value that close. Null
 * when the samples are not float32 or the value matches as it is.
 */
export function floatNoData(source: GeoTIFF): ((v: number) => boolean) | null {
  const s = source as unknown as { sourceImagery_?: SampleInfo[][]; nodataValues_?: Array<Array<number | null>> };
  const imagery = s.sourceImagery_;
  if (!Array.isArray(imagery) || imagery.length !== 1) return null;
  const image = imagery[0]?.[imagery[0].length - 1];
  const nodata = s.nodataValues_?.[0]?.find((v) => v !== null && v !== undefined);
  if (!image || typeof nodata !== 'number' || !Number.isFinite(nodata)) return null;
  try {
    if (image.getSampleFormat(0) !== 3 || image.getBitsPerSample(0) !== 32) return null;
  } catch {
    return null;
  }
  if (Math.abs(Math.abs(nodata) - FLOAT32_MAX) <= FLOAT32_MAX * 1e-5) {
    const edge = Math.sign(nodata) * FLOAT32_MAX * (1 - 1e-5);
    return nodata < 0 ? (v) => v <= edge : (v) => v >= edge;
  }
  const f = Math.fround(nodata);
  return f === nodata ? null : (v) => v === f;
}

/** Fill values that stand for no data in files that do not say so: GDAL's and ESRI's usual ones. */
export const KNOWN_FILL_VALUES: readonly number[] = [-9999, -32768, -FLOAT32_MAX, FLOAT32_MAX];

/**
 * The test for samples that hold one of `values`, as the file holds them:
 * a value is also matched cast to float32 (a float image's samples), and a
 * value close to the largest float stands for any value that close (see
 * floatNoData). `nan` matches NaN too. Null when nothing is matched.
 */
export function valuesTest(values: readonly number[], nan: boolean): ((v: number) => boolean) | null {
  const exact = new Set<number>();
  let below = -Infinity;
  let above = Infinity;
  for (const v of values) {
    if (v !== v) {
      nan = true;
    } else if (Math.abs(Math.abs(v) - FLOAT32_MAX) <= FLOAT32_MAX * 1e-5 || !Number.isFinite(v)) {
      const edge = FLOAT32_MAX * (1 - 1e-5);
      if (v < 0) below = -edge;
      else above = edge;
    } else {
      exact.add(v);
      exact.add(Math.fround(v));
    }
  }
  if (!nan && exact.size === 0 && below === -Infinity && above === Infinity) return null;
  return (v) => v <= below || v >= above || exact.has(v) || (nan && v !== v);
}
