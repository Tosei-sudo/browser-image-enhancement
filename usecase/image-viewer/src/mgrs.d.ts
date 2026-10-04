// The mgrs package ships no types.
declare module 'mgrs' {
  /** MGRS string of `[lon, lat]`, `accuracy` digits per axis (default 5). */
  export function forward(lonLat: [number, number], accuracy?: number): string;
  /** `[west, south, east, north]` of the MGRS square. */
  export function inverse(mgrs: string): [number, number, number, number];
  /** `[lon, lat]` of the center of the MGRS square. */
  export function toPoint(mgrs: string): [number, number];
}
