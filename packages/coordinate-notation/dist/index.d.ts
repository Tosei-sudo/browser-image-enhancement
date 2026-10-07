//#region src/index.d.ts
/** WGS 84 longitude and latitude in degrees, longitude first (as GeoJSON). */
export type LonLat = [number, number];
/** `35.681240, 139.767100` (latitude first). */
export declare function formatLatLon([lon, lat]: LonLat): string;
/** `54S UE 88433 49290` (1 m precision); null outside the MGRS area (the poles). */
export declare function formatMgrs(lonLat: LonLat): string | null;
/** The UTM zone of a point, with the Norway and Svalbard exceptions (as MGRS uses). */
export declare function utmZone(lonLat: LonLat): number | null;
/** The EPSG code of a UTM zone on WGS 84. */
export declare function utmEpsg(zone: number, north: boolean): string;
/** `54N 386543 3950123`; null outside UTM (beyond 84°N / 80°S). */
export declare function formatUtm(lonLat: LonLat): string | null;
/**
 * Reads a coordinate typed in any of the supported notations:
 * - latitude, longitude, in decimal degrees or degrees, minutes and seconds:
 *   `35.6812, 139.7671`, `N35.6812 E139.7671`, `139.7671E 35.6812N`,
 *   `35°40'52.3"N 139°46'1.6"E`, `35 40 52.3 139 46 1.6`, `35d40m52s N`,
 *   `北緯35度40分52秒 東経139度46分1秒`, packed `354052N 1394601E`,
 *   `lat 35.68 lon 139.76`, `POINT(139.76 35.68)` (WKT, longitude first),
 *   full-width digits and Japanese punctuation. Without N/S/E/W or a label,
 *   latitude comes first, unless only the first value can be a longitude
 *   (`139.76, 35.68`);
 * - MGRS: `54SUE8843349290`, `54S UE 88433 49290` (any even number of digits);
 * - UTM: `54N 386543 3950123` (zone, N or S, easting, northing; `E`/`N` or `m` after the numbers are allowed).
 * Returns `[lon, lat]`, or null when the text is none of them.
 */
export declare function parseCoordinate(text: string): LonLat | null;
//#endregion
//# sourceMappingURL=index.d.ts.map