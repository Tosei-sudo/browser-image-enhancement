//#region src/core/process.d.ts
/** How pixels are computed: three channels, or one luminance channel. */
export type ResolvedMode = 'rgb' | 'gray';
/** True when every pixel has R = G = B. Stops at the first colored pixel. */
export declare function isMonochrome(data: Uint8ClampedArray): boolean;
//#endregion
//# sourceMappingURL=process.d.ts.map