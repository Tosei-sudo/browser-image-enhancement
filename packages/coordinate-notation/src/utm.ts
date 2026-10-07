/**
 * UTM on WGS 84 without proj4: the transverse Mercator projection in
 * Krüger's series to sixth order in n (Karney 2011), accurate to well under a
 * millimetre within a zone and its neighbours.
 */

const a = 6378137;
const f = 1 / 298.257223563;
const k0 = 0.9996;
const e = Math.sqrt(f * (2 - f));
const n = f / (2 - f);
const n2 = n * n;
const n3 = n2 * n;
const n4 = n3 * n;
const n5 = n4 * n;
const n6 = n5 * n;
/** Radius of the rectifying sphere, times the scale on the central meridian. */
const kA = (k0 * a) / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

const alpha = [
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];

const beta = [
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6,
];

const RAD = Math.PI / 180;

function centralMeridian(zone: number): number {
  return (zone * 6 - 183) * RAD;
}

/** Conformal latitude's tangent from the geodetic latitude's tangent. */
function conformalTan(tau: number): number {
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.hypot(1, tau)));
  return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}

/** `[lon, lat]` in degrees → `[easting, northing]` in metres in the given zone. */
export function toUtm([lon, lat]: [number, number], zone: number, north: boolean): [number, number] {
  const lambda = lon * RAD - centralMeridian(zone);
  const tauP = conformalTan(Math.tan(lat * RAD));
  const cosL = Math.cos(lambda);
  const xiP = Math.atan2(tauP, cosL);
  const etaP = Math.asinh(Math.sin(lambda) / Math.hypot(tauP, cosL));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return [500_000 + kA * eta, kA * xi + (north ? 0 : 10_000_000)];
}

/** `[easting, northing]` in metres in the given zone → `[lon, lat]` in degrees. */
export function fromUtm([easting, northing]: [number, number], zone: number, north: boolean): [number, number] {
  const xi = (northing - (north ? 0 : 10_000_000)) / kA;
  const eta = (easting - 500_000) / kA;
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta = Math.sinh(etaP);
  const cosXi = Math.cos(xiP);
  const tauP = Math.sin(xiP) / Math.hypot(sinhEta, cosXi);
  // Newton's method for the geodetic latitude whose conformal latitude is tauP.
  const e2 = e * e;
  let tau = tauP;
  for (let i = 0; i < 10; i++) {
    const tauI = conformalTan(tau);
    const delta = ((tauP - tauI) / Math.hypot(1, tauI)) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.hypot(1, tau)));
    tau += delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  const lambda = Math.atan2(sinhEta, cosXi);
  return [(lambda + centralMeridian(zone)) / RAD, Math.atan(tau) / RAD];
}
