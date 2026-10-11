/** OpenJPEG built to WebAssembly (decoder only): an Emscripten module factory. */
declare module '@cornerstonejs/codec-openjpeg/decodewasmjs' {
  const factory: (options?: { locateFile?: (path: string) => string }) => Promise<{
    J2KDecoder: new () => {
      getEncodedBuffer(length: number): Uint8Array;
      getDecodedBuffer(): Uint8Array;
      decode(): void;
      getFrameInfo(): { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean };
      delete(): void;
    };
  }>;
  export default factory;
}

declare module '@cornerstonejs/codec-openjpeg/decodewasm?url' {
  const url: string;
  export default url;
}
