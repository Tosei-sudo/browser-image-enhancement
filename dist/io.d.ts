import type { ImageDataLike } from './types.js';
/** Everything `pipeline().run()` accepts. */
export type ImageInput = ImageDataLike | ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | Blob;
export declare function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement;
/**
 * Reads any supported input as sRGB ImageData. Pixels in other color spaces
 * (for example Display P3) are converted to sRGB by the browser. EXIF
 * orientation of encoded images is applied.
 */
export declare function toImageData(input: ImageInput): Promise<ImageDataLike>;
export declare function toCanvas(image: ImageDataLike): OffscreenCanvas | HTMLCanvasElement;
export declare function toBlob(image: ImageDataLike, type?: string, quality?: number): Promise<Blob>;
//# sourceMappingURL=io.d.ts.map