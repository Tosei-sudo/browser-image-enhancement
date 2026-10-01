/** Anything shaped like `ImageData`: 8-bit RGBA, row-major, no padding. */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace?: string;
}

/**
 * Wraps pixels in a real `ImageData` when the environment has one, otherwise in
 * a plain object of the same shape (useful in tests and non-DOM workers).
 */
export function createImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

/** Throws if the object is not a well-formed 8-bit RGBA image. */
export function assertImageData(
  image: ImageDataLike,
  colorSpaceHint = 'Use the pipeline API, which converts other color spaces to sRGB.',
): void {
  if (!image || !(image.data instanceof Uint8ClampedArray)) {
    throw new TypeError('Expected ImageData (an object with a Uint8ClampedArray `data`).');
  }
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid image size ${width}x${height}.`);
  }
  if (image.data.length !== width * height * 4) {
    throw new RangeError(`data.length ${image.data.length} does not match ${width}x${height}x4.`);
  }
  if (image.colorSpace && image.colorSpace !== 'srgb') {
    throw new RangeError(
      `Only sRGB pixels are supported here (got ${image.colorSpace}). ` +
        colorSpaceHint,
    );
  }
}
