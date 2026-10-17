// lerc (Esri's LERC decoder, version 3: plain JavaScript) ships without types: the one call the viewer uses.
declare module 'lerc' {
  interface LercPixelBlock {
    width: number;
    height: number;
    /** One array per band. */
    pixels: Array<ArrayLike<number>>;
    /** 1 where a pixel has a value; null when all have. */
    mask: Uint8Array | null;
  }
  const Lerc: { decode(input: ArrayBuffer, options?: { inputOffset?: number }): LercPixelBlock };
  export default Lerc;
}
