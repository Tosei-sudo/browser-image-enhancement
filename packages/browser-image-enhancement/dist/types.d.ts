import { ImageDataLike } from "./workers/src/image.js";
//#region src/types.d.ts
/** How color is handled. `auto` detects monochrome (R = G = B everywhere) input. */
export type ColorMode = 'auto' | 'rgb' | 'gray';
/**
 * Levels parameters. Points are sRGB-encoded values in [0, 1] (multiply by 255
 * for the familiar 0-255 scale); `gamma` is the midtone gamma (> 1 brightens).
 */
export interface LevelsOptions {
  /** Input black point, 0-1. Default 0. */
  inBlack?: number;
  /** Input white point, 0-1. Default 1. */
  inWhite?: number;
  /** Midtone gamma, 0.1-10. Default 1. */
  gamma?: number;
  /** Output black point, 0-1. Default 0. */
  outBlack?: number;
  /** Output white point, 0-1. Default 1. */
  outWhite?: number;
}
/** A single correction step in serializable form. */
export type OpSpec = {
  op: 'brightness';
  amount: number;
} | {
  op: 'contrast';
  amount: number;
} | {
  op: 'exposure';
  ev: number;
} | {
  op: 'gamma';
  gamma: number;
} | {
  op: 'saturation';
  amount: number;
} | {
  op: 'temperature';
  amount: number;
} | ({
  op: 'levels';
} & Required<LevelsOptions>);
export type OpName = OpSpec['op'];
/** Options shared by every entry point. */
export interface ColorOptions {
  /** Default `auto`. */
  colorMode?: ColorMode;
}
//#endregion
export type { ImageDataLike };
//# sourceMappingURL=types.d.ts.map