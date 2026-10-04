// shpjs ships without types: the two parsers the viewer uses.
declare module 'shpjs' {
  /** GeoJSON geometries of a .shp, in longitude / latitude when `prj` (the .prj text) is given. */
  export function parseShp(shp: ArrayBuffer | ArrayBufferView, prj?: string | false): Array<{ type: string } | null>;
  /** Records of a .dbf, text decoded as `cpg` (a TextDecoder label). */
  export function parseDbf(dbf: ArrayBuffer | ArrayBufferView, cpg?: string): Array<Record<string, unknown>>;
}
