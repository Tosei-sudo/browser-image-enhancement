/**
 * Converting browser image sources to sRGB pixels and back.
 */
import { createImageData, type ImageDataLike } from './image.js';

/** Every image source the packages accept. */
export type ImageInput =
  | ImageDataLike
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas
  | Blob;

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  throw new Error('No canvas implementation is available in this environment.');
}

function context2d(canvas: OffscreenCanvas | HTMLCanvasElement): Canvas2D {
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }) as Canvas2D | null;
  if (!ctx) throw new Error('Could not get a 2D canvas context.');
  return ctx;
}

function isImageDataLike(input: unknown): input is ImageDataLike {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as ImageDataLike).data instanceof Uint8ClampedArray &&
    typeof (input as ImageDataLike).width === 'number' &&
    typeof (input as ImageDataLike).height === 'number'
  );
}

function sizeOf(source: CanvasImageSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  const s = source as { width: number; height: number };
  return { width: s.width, height: s.height };
}

function drawToImageData(source: CanvasImageSource): ImageData {
  const { width, height } = sizeOf(source);
  if (!(width > 0 && height > 0)) throw new RangeError('The image has no pixels (is it loaded?).');
  const ctx = context2d(createCanvas(width, height));
  ctx.drawImage(source, 0, 0);
  return ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
}

/**
 * Reads any supported input as sRGB ImageData. Pixels in other color spaces
 * (for example Display P3) are converted to sRGB by the browser. EXIF
 * orientation of encoded images is applied.
 */
export async function toImageData(input: ImageInput): Promise<ImageDataLike> {
  if (isImageDataLike(input)) {
    if (!input.colorSpace || input.colorSpace === 'srgb') return input;
    // Let the canvas convert, e.g. display-p3 -> srgb.
    const canvas = createCanvas(input.width, input.height);
    const ctx = canvas.getContext('2d', {
      colorSpace: input.colorSpace as PredefinedColorSpace,
      willReadFrequently: true,
    }) as Canvas2D | null;
    if (!ctx) throw new Error('Could not get a 2D canvas context.');
    ctx.putImageData(input as ImageData, 0, 0);
    return ctx.getImageData(0, 0, input.width, input.height, { colorSpace: 'srgb' });
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    // Older engines reject the `from-image` value; they apply EXIF orientation by default anyway.
    const bitmap = await createImageBitmap(input, { imageOrientation: 'from-image' }).catch((e: unknown) => {
      if (e instanceof TypeError) return createImageBitmap(input);
      throw e;
    });
    try {
      return drawToImageData(bitmap);
    } finally {
      bitmap.close();
    }
  }
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement && !input.complete) {
    await input.decode();
  }
  return drawToImageData(input as CanvasImageSource);
}

export function toCanvas(image: ImageDataLike): OffscreenCanvas | HTMLCanvasElement {
  const canvas =
    typeof document !== 'undefined' ? createHtmlCanvas(image.width, image.height) : createCanvas(image.width, image.height);
  context2d(canvas).putImageData(asImageData(image), 0, 0);
  return canvas;
}

function createHtmlCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function asImageData(image: ImageDataLike): ImageData {
  return typeof ImageData !== 'undefined' && image instanceof ImageData
    ? image
    : createImageData(image.data, image.width, image.height);
}

export async function toBlob(image: ImageDataLike, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = createCanvas(image.width, image.height);
  context2d(canvas).putImageData(asImageData(image), 0, 0);
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality),
  );
}
