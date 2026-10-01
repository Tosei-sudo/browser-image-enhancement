import { Histogram } from "../types.js";
//#region src/core/histogram.d.ts
/**
 * Adds histograms (of tiles, strips, ...) into one. Mixing gray and color
 * histograms gives a color one, with gray counted on every channel.
 */
export declare function mergeHistograms(histograms: readonly Histogram[]): Histogram;
//#endregion
//# sourceMappingURL=histogram.d.ts.map