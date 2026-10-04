/**
 * Rational polynomial coefficients (RPC00B), the sensor model delivered with
 * most satellite images: image line and sample as ratios of cubic
 * polynomials of latitude, longitude and height above the WGS 84 ellipsoid.
 *
 * Read from the GeoTIFF RPCCoefficientTag (50844), a DigitalGlobe / Maxar
 * `.RPB` file, or a GDAL-style `_RPC.TXT` file (`LINE_OFF: …`).
 * Line and sample 0 are the center of the first pixel, as in GDAL.
 */

/** An RPC00B model. */
export interface Rpc {
  lineOff: number;
  sampOff: number;
  latOff: number;
  lonOff: number;
  heightOff: number;
  lineScale: number;
  sampScale: number;
  latScale: number;
  lonScale: number;
  heightScale: number;
  /** 20 coefficients each, in RPC00B term order. */
  lineNum: number[];
  lineDen: number[];
  sampNum: number[];
  sampDen: number[];
  /** Bias and random error of the model in metres, when given. */
  errBias?: number;
  errRand?: number;
}

/** The model from the 92 values of GeoTIFF tag 50844. */
export function rpcFromTag(values: ArrayLike<number>): Rpc {
  if (values.length < 92) throw new Error('RPC タグの値が足りません');
  const v = Array.from(values, Number);
  return check({
    errBias: v[0],
    errRand: v[1],
    lineOff: v[2],
    sampOff: v[3],
    latOff: v[4],
    lonOff: v[5],
    heightOff: v[6],
    lineScale: v[7],
    sampScale: v[8],
    latScale: v[9],
    lonScale: v[10],
    heightScale: v[11],
    lineNum: v.slice(12, 32),
    lineDen: v.slice(32, 52),
    sampNum: v.slice(52, 72),
    sampDen: v.slice(72, 92),
  });
}

/** Whether `name` is an RPC side file: `.RPB` or `…_RPC.TXT` / `….rpc`. */
export function isRpcName(name: string): boolean {
  return /\.rpb$|_rpc\.txt$|\.rpc$/i.test(name);
}

/** The image file name an RPC side file belongs to, without extension, lower case. */
export function rpcBaseName(name: string): string {
  return name.replace(/(_rpc\.txt|\.rpb|\.rpc)$/i, '').toLowerCase();
}

/** Reads a `.RPB` or `_RPC.TXT` file. Throws when it holds no complete model. */
export function parseRpcText(text: string): Rpc {
  const values = new Map<string, number[]>();
  if (/lineNumCoef/i.test(text)) {
    // RPB: `lineOffset = 1234.0;` and `lineNumCoef = ( a, b, … );`
    for (const m of text.matchAll(/(\w+)\s*=\s*(\([^)]*\)|[^;\n]+);/g)) {
      values.set(m[1].toLowerCase(), numbers(m[2]));
    }
    const one = (key: string) => values.get(key.toLowerCase())?.[0] ?? NaN;
    const many = (key: string) => values.get(key.toLowerCase()) ?? [];
    return check({
      errBias: one('errBias'),
      errRand: one('errRand'),
      lineOff: one('lineOffset'),
      sampOff: one('sampOffset'),
      latOff: one('latOffset'),
      lonOff: one('longOffset'),
      heightOff: one('heightOffset'),
      lineScale: one('lineScale'),
      sampScale: one('sampScale'),
      latScale: one('latScale'),
      lonScale: one('longScale'),
      heightScale: one('heightScale'),
      lineNum: many('lineNumCoef'),
      lineDen: many('lineDenCoef'),
      sampNum: many('sampNumCoef'),
      sampDen: many('sampDenCoef'),
    });
  }
  // _RPC.TXT: `LINE_OFF: 1234 pixels`, `LINE_NUM_COEFF_1: …` (also `LINE_NUM_COEFF: a b c …`).
  for (const m of text.matchAll(/^\s*([A-Z_0-9]+)\s*[:=]\s*(.+)$/gim)) values.set(m[1].toUpperCase(), numbers(m[2]));
  const one = (key: string) => values.get(key)?.[0] ?? NaN;
  const many = (key: string) => {
    const all = values.get(key);
    if (all && all.length >= 20) return all.slice(0, 20);
    return Array.from({ length: 20 }, (_, i) => values.get(`${key}_${i + 1}`)?.[0] ?? NaN);
  };
  return check({
    errBias: one('ERR_BIAS'),
    errRand: one('ERR_RAND'),
    lineOff: one('LINE_OFF'),
    sampOff: one('SAMP_OFF'),
    latOff: one('LAT_OFF'),
    lonOff: one('LONG_OFF'),
    heightOff: one('HEIGHT_OFF'),
    lineScale: one('LINE_SCALE'),
    sampScale: one('SAMP_SCALE'),
    latScale: one('LAT_SCALE'),
    lonScale: one('LONG_SCALE'),
    heightScale: one('HEIGHT_SCALE'),
    lineNum: many('LINE_NUM_COEFF'),
    lineDen: many('LINE_DEN_COEFF'),
    sampNum: many('SAMP_NUM_COEFF'),
    sampDen: many('SAMP_DEN_COEFF'),
  });
}

function numbers(text: string): number[] {
  return (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

function check(rpc: Rpc): Rpc {
  const scalars = [rpc.lineOff, rpc.sampOff, rpc.latOff, rpc.lonOff, rpc.heightOff, rpc.lineScale, rpc.sampScale, rpc.latScale, rpc.lonScale, rpc.heightScale];
  const lists = [rpc.lineNum, rpc.lineDen, rpc.sampNum, rpc.sampDen];
  if (!scalars.every(Number.isFinite) || !lists.every((l) => l.length === 20 && l.every(Number.isFinite))) {
    throw new Error('RPC の係数が揃っていません');
  }
  if (!rpc.lineScale || !rpc.sampScale || !rpc.latScale || !rpc.lonScale || !rpc.heightScale) throw new Error('RPC の係数が揃っていません');
  if (!Number.isFinite(rpc.errBias)) delete rpc.errBias;
  if (!Number.isFinite(rpc.errRand)) delete rpc.errRand;
  return rpc;
}

/** The 20 RPC00B terms of normalized longitude L, latitude P and height H. */
function terms(L: number, P: number, H: number, t: Float64Array): void {
  t[0] = 1;
  t[1] = L;
  t[2] = P;
  t[3] = H;
  t[4] = L * P;
  t[5] = L * H;
  t[6] = P * H;
  t[7] = L * L;
  t[8] = P * P;
  t[9] = H * H;
  t[10] = P * L * H;
  t[11] = L * L * L;
  t[12] = L * P * P;
  t[13] = L * H * H;
  t[14] = L * L * P;
  t[15] = P * P * P;
  t[16] = P * H * H;
  t[17] = L * L * H;
  t[18] = P * P * H;
  t[19] = H * H * H;
}

function dot(c: readonly number[], t: Float64Array): number {
  let s = 0;
  for (let i = 0; i < 20; i++) s += c[i] * t[i];
  return s;
}

/** Ground → image with an RPC model. */
export interface RpcProjector {
  /** Sample (x) and line (y) of longitude, latitude and ellipsoidal height. Line and sample 0 are the first pixel's center. */
  toImage(lon: number, lat: number, height: number): [sample: number, line: number];
  /**
   * Longitude and latitude seen at `sample`, `line` for a point at `height`:
   * the inverse of {@link toImage} for that height, solved by Newton's method.
   */
  toGround(sample: number, line: number, height: number): [lon: number, lat: number];
}

export function rpcProjector(rpc: Rpc): RpcProjector {
  const t = new Float64Array(20);
  const toImage = (lon: number, lat: number, height: number): [number, number] => {
    const L = (lon - rpc.lonOff) / rpc.lonScale;
    const P = (lat - rpc.latOff) / rpc.latScale;
    const H = (height - rpc.heightOff) / rpc.heightScale;
    terms(L, P, H, t);
    const line = dot(rpc.lineNum, t) / dot(rpc.lineDen, t);
    const samp = dot(rpc.sampNum, t) / dot(rpc.sampDen, t);
    return [samp * rpc.sampScale + rpc.sampOff, line * rpc.lineScale + rpc.lineOff];
  };
  const toGround = (sample: number, line: number, height: number): [number, number] => {
    let lon = rpc.lonOff;
    let lat = rpc.latOff;
    // A step of a thousandth of the model's extent for the numerical Jacobian.
    const dLon = rpc.lonScale * 1e-4;
    const dLat = rpc.latScale * 1e-4;
    for (let i = 0; i < 20; i++) {
      const [s0, l0] = toImage(lon, lat, height);
      const es = sample - s0;
      const el = line - l0;
      if (Math.abs(es) < 1e-4 && Math.abs(el) < 1e-4) break;
      const [s1, l1] = toImage(lon + dLon, lat, height);
      const [s2, l2] = toImage(lon, lat + dLat, height);
      const a = (s1 - s0) / dLon;
      const b = (s2 - s0) / dLat;
      const c = (l1 - l0) / dLon;
      const d = (l2 - l0) / dLat;
      const det = a * d - b * c;
      if (!det) break;
      lon += (d * es - b * el) / det;
      lat += (a * el - c * es) / det;
    }
    return [lon, lat];
  };
  return { toImage, toGround };
}
