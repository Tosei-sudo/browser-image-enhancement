/**
 * Overviews for local GeoTIFFs that have none. Such a file has one resolution
 * only, so a zoomed-out view samples the full-resolution pixels sparsely and
 * looks rough and shimmering. Rewriting it as a tiled GeoTIFF with averaged
 * overviews (`rasterToGeoTIFF`) makes it look like a COG at every zoom.
 */
import { fromArrayBuffer, fromBlob } from 'geotiff';
import { rasterToGeoTIFF, type GeoTIFFRaster, type GeoTIFFSamples } from 'browser-image-enhancement/openlayers';

/** Images up to this size are shown well without overviews. */
const SMALL = 512;
/** The most samples read into memory to build overviews (about 50 million RGB pixels). */
export const MAX_OVERVIEW_SAMPLES = 150_000_000;

/**
 * A copy of the GeoTIFF `file` with overviews, or null when it needs none
 * (it has overviews already, or is small) or cannot be rewritten (too large,
 * a palette or odd bit depth): then open the file as it is.
 *
 * With `geo`, the copy gets that georeferencing instead of the file's own and
 * is made whatever the file's size and overviews, with each band's range as
 * statistics so its 11 to 16-bit values are not crushed into a few gray
 * levels (for a satellite image placed by its RPC model, see `rpcGeo`).
 */
export async function withOverviews(file: Blob, options: { geo?: GeoTIFFRaster['geo'] } = {}): Promise<Blob | null> {
  // Only the header is read until the pixels are needed (whole files where there is no FileReader).
  const tiff = typeof FileReader === 'undefined' ? await fromArrayBuffer(await file.arrayBuffer()) : await fromBlob(file);
  const forced = !!options.geo;
  if (!forced && (await tiff.getImageCount()) > 1) return null;
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  if (width * height * bands > MAX_OVERVIEW_SAMPLES || (!forced && Math.max(width, height) <= SMALL)) return null;
  const bits = image.getBitsPerSample();
  if (![8, 16, 32, 64].includes(bits)) return null;

  const fd = image.fileDirectory;
  const tag = async (id: number) => (fd.hasTag(id) ? await fd.loadValue(id) : undefined);
  const numbers = (v: unknown) => (v === undefined ? undefined : Array.from(v as ArrayLike<number>, Number));
  // JPEG (YCbCr) is decoded to RGB; palettes and other models are left as they are.
  let photometric = Number(await tag(262));
  if (photometric === 6) photometric = 2;
  if (![0, 1, 2].includes(photometric)) return null;

  const data = (await image.readRasters({ interleave: true })) as unknown as GeoTIFFSamples;
  const ascii = await tag(34737);
  return rasterToGeoTIFF({
    width,
    height,
    bands,
    data,
    noData: image.getGDALNoData(),
    photometric,
    extraSamples: numbers(await tag(338)),
    geo: options.geo ?? {
      modelPixelScale: numbers(await tag(33550)),
      modelTiepoint: numbers(await tag(33922)),
      modelTransformation: numbers(await tag(34264)),
      geoKeyDirectory: numbers(await tag(34735)),
      geoDoubleParams: numbers(await tag(34736)),
      geoAsciiParams: typeof ascii === 'string' ? ascii : undefined,
    },
  }, { statistics: forced });
}

/** Whether `file` starts like a TIFF or BigTIFF. */
export async function isTiff(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const le = b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0;
  const be = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 42 || b[3] === 43);
  return le || be;
}
