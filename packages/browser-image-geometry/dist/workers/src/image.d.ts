//#region ../workers/src/image.d.ts
/** Anything shaped like `ImageData`: 8-bit RGBA, row-major, no padding. */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace?: string;
}
//#endregion
//# sourceMappingURL=image.d.ts.map