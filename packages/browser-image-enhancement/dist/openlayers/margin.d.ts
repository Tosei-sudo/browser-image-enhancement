//#region src/openlayers/margin.d.ts
/**
 * Margins for tiles. Sharpening reads neighbouring pixels, so a tile corrected
 * on its own would show seams at its edges. Each tile is instead corrected
 * with `pipeline.margin` pixels of its neighbour tiles around it and cropped
 * back afterwards; its pixels then equal the same area of the whole level
 * corrected at once.
 */
/** RGBA pixels of the tile `dx`, `dy` tiles away from the centre one, or null where there is none (outside the image). */
export type NeighbourTile = (dx: number, dy: number) => Uint8ClampedArray | null;
/**
 * The centre tile (`width` x `height`) with `margin` pixels of its neighbours
 * on every side. Where there is no neighbour the margin is transparent, which
 * the library treats exactly like the edge of the image.
 */
export declare function withMargin(tile: NeighbourTile, width: number, height: number, margin: number): Uint8ClampedArray;
/** The centre `width` x `height` pixels of an image padded by `margin` on every side. */
export declare function cropMargin(padded: Uint8ClampedArray, width: number, height: number, margin: number): Uint8ClampedArray;
//#endregion
//# sourceMappingURL=margin.d.ts.map