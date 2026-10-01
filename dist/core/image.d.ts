import type { ImageDataLike } from '../types.js';
/**
 * Wraps pixels in a real `ImageData` when the environment has one, otherwise in
 * a plain object of the same shape (useful in tests and non-DOM workers).
 */
export declare function createImageData(data: Uint8ClampedArray, width: number, height: number): ImageData;
/** Throws if the object is not a well-formed 8-bit RGBA image. */
export declare function assertImageData(image: ImageDataLike): void;
//# sourceMappingURL=image.d.ts.map