/**
 * Imaging modes of sensors: what a satellite can do depends on how it
 * images. A SAR satellite in spotlight mode looks at a small spot sharply,
 * in stripmap mode along a strip, in ScanSAR mode over a wide swath; each
 * mode has its own range of off-nadir angles, scene width and length, and
 * scenes per pass. So the satellites (their orbits, in `satelliteCatalogs`)
 * and the sensors (their modes, in `config.json`'s `sensorCatalogs`) are
 * kept apart: a satellite names its sensor, and {@link withModes} lists it
 * once per mode of that sensor, the mode's values taking the place of the
 * satellite's own. A satellite whose sensor has no modes stays as it is, so
 * satellite catalogs written before sensor catalogs work unchanged.
 *
 * A sensor catalog is either written in `config.json` (`sensors`, each with
 * its `modes`) or an Esri table of one record per sensor and mode, mapped by
 * `fields` like the satellite catalog.
 */
import { lookSideOf, platformKey, type LookSide, type SatelliteSpec } from './imaging-plan.js';

/** One imaging mode of a sensor. Values left out are the satellite's own. */
export interface SensorMode {
  /** The sensor it belongs to: matched with a satellite's `sensor` (or its series, or its name), ignoring case. */
  sensor: string;
  /** The mode's name (ストリップマップ, スポットライト …); empty for a sensor with one mode. */
  mode: string;
  sar?: boolean;
  /** Degrees. */
  maxOffNadir?: number;
  minOffNadir?: number;
  /** km. */
  swath?: number;
  /** km; the width when absent. */
  length?: number;
  lookSide?: LookSide;
  scenesPerPass?: number;
  /** Minutes between shots. */
  minInterval?: number;
  /** Shots in 24 hours. */
  maxPerDay?: number;
  /** Hours ahead an order must be placed. */
  leadTime?: number;
  /** Ground resolution, m. */
  resolution?: number;
  /** The sensor's usual mode, chosen when its satellite is; the first mode when none is marked. */
  primary?: boolean;
}

/** Attribute names of an Esri sensor table, by role (one record per sensor and mode). */
export interface SensorFields {
  sensor?: string;
  mode?: string;
  kind?: string;
  maxOffNadir?: string;
  minOffNadir?: string;
  swath?: string;
  length?: string;
  lookSide?: string;
  scenesPerPass?: string;
  minInterval?: string;
  maxPerDay?: string;
  leadTime?: string;
  resolution?: string;
  primary?: string;
}

/** One catalog of `config.json`'s `sensorCatalogs`. */
export interface SensorCatalogConfig {
  label: string;
  /** An Esri table (`…/FeatureServer/1`) of modes; absent when they are written in `config.json`. */
  url?: string;
  token?: string;
  where?: string;
  fields: SensorFields;
  /** The unit of `swath` and `length`. */
  swathUnit: 'km' | 'm';
  /** Values of `kind` that mean SAR. */
  sarPattern: RegExp;
  /** The modes written in `config.json` (`sensors`). */
  modes: SensorMode[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && /^[\w.]+$/.test(value);
const roles = ['sensor', 'mode', 'kind', 'maxOffNadir', 'minOffNadir', 'swath', 'length', 'lookSide', 'scenesPerPass', 'minInterval', 'maxPerDay', 'leadTime', 'resolution', 'primary'] as const;
const numbers = ['maxOffNadir', 'minOffNadir', 'swath', 'length', 'scenesPerPass', 'minInterval', 'maxPerDay', 'leadTime', 'resolution'] as const;
const defaultSar = /SAR|radar|レーダ/i;

const numberOf = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const textOf = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());
const yes = (value: unknown): boolean => value === true || value === 1 || /^(1|true|yes|y|はい|既定|標準)$/i.test(textOf(value));

/**
 * A mode from named values (`get(role)`): numbers checked, sizes turned to
 * km with `scale`. Null without a sensor name.
 */
function modeFrom(get: (role: (typeof roles)[number]) => unknown, scale: number, sar: RegExp): SensorMode | null {
  const sensor = textOf(get('sensor'));
  if (!sensor) return null;
  const mode: SensorMode = { sensor, mode: textOf(get('mode')) };
  const kind = get('kind');
  if (typeof kind === 'string' && kind.trim()) mode.sar = sar.test(kind);
  else if (typeof kind === 'boolean') mode.sar = kind;
  for (const key of numbers) {
    const v = numberOf(get(key));
    if (v !== null) mode[key] = key === 'swath' || key === 'length' ? v * scale : v;
  }
  const side = textOf(get('lookSide'));
  if (side) mode.lookSide = lookSideOf(side);
  if (yes(get('primary'))) mode.primary = true;
  return mode;
}

/** The catalog of one `sensorCatalogs` entry; null (with the reason in `problems`) when it cannot be used. */
export function sensorCatalogOf(value: unknown, problems: string[], index: number): SensorCatalogConfig | null {
  const at = `sensorCatalogs[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} はオブジェクトで指定`), null);
  const { label, url, token, fields, where, swathUnit, sarPattern, sensors } = value;
  let sar = defaultSar;
  if (typeof sarPattern === 'string' && sarPattern) {
    try {
      sar = new RegExp(sarPattern, 'i');
    } catch {
      problems.push(`${at} の sarPattern は正規表現として読み込み不可`);
    }
  }
  const scale = swathUnit === 'm' ? 0.001 : 1;
  const base = { label: typeof label === 'string' && label ? label : `センサーカタログ ${index + 1}`, swathUnit: swathUnit === 'm' ? ('m' as const) : ('km' as const), sarPattern: sar };

  if (Array.isArray(sensors)) {
    // Written here: each sensor with its modes; what a sensor says holds for all its modes unless a mode says otherwise.
    const modes: SensorMode[] = [];
    sensors.forEach((s, i) => {
      if (!isRecord(s) || typeof s.sensor !== 'string' || !s.sensor.trim()) return void problems.push(`${at}.sensors[${i}] に sensor（センサー名）なし`);
      const list = Array.isArray(s.modes) && s.modes.length ? s.modes : [{}];
      list.forEach((m, j) => {
        if (!isRecord(m)) return void problems.push(`${at}.sensors[${i}].modes[${j}] はオブジェクトで指定`);
        const get = (role: (typeof roles)[number]) => (role === 'sensor' ? s.sensor : role === 'mode' ? (m.mode ?? m.name) : (m[role] ?? s[role]));
        const mode = modeFrom(get, scale, sar);
        if (mode) modes.push(mode);
      });
    });
    return { ...base, fields: {}, modes };
  }

  if (typeof url !== 'string' || !/\/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.split('?', 1)[0])) {
    return (problems.push(`${at} は sensors（モードの一覧）か、…/FeatureServer/1 のようなテーブルの url を記述`), null);
  }
  if (!isRecord(fields)) return (problems.push(`${at} に fields（属性名の対応）なし`), null);
  const mapped: SensorFields = {};
  for (const role of roles) {
    const name = fields[role];
    if (name === undefined || name === '') continue;
    if (isName(name)) mapped[role] = name;
    else problems.push(`${at} の fields.${role} は属性名（英数字と _）で指定`);
  }
  if (!mapped.sensor) return (problems.push(`${at} に fields.sensor（センサー名の属性）なし`), null);
  return {
    ...base,
    url: url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof token === 'string' && token ? { token } : {}),
    ...(typeof where === 'string' && where.trim() ? { where: where.trim() } : {}),
    fields: mapped,
    modes: [],
  };
}

/** The mode of a sensor table's record; null when it names no sensor. */
export function sensorModeOf(attributes: Record<string, unknown>, catalog: SensorCatalogConfig): SensorMode | null {
  const get = (role: (typeof roles)[number]) => {
    const name = catalog.fields[role];
    return name ? attributes[name] : undefined;
  };
  return modeFrom(get, catalog.swathUnit === 'm' ? 0.001 : 1, catalog.sarPattern);
}

const keyOf = (text: string | undefined) => (text ?? '').trim().toLowerCase();

/**
 * The satellites listed once per imaging mode: each satellite whose sensor
 * (its `sensor`, else its series, else its name) has modes in `modes`
 * becomes one entry per mode, with the mode's values in place of its own.
 * A satellite that already has a `mode` (a catalog of one record per
 * satellite and mode) takes the values of the mode of that name, if any.
 * Of the entries of one satellite, one is `primary` (the mode marked so, or
 * the first) and the rest are not; a satellite with one entry has none.
 */
export function withModes(sats: readonly SatelliteSpec[], modes: readonly SensorMode[]): SatelliteSpec[] {
  const bySensor = new Map<string, SensorMode[]>();
  for (const m of modes) {
    const key = keyOf(m.sensor);
    bySensor.set(key, [...(bySensor.get(key) ?? []), m]);
  }
  const apply = (sat: SatelliteSpec, m: SensorMode): SatelliteSpec => {
    const swath = m.swath ?? sat.swath;
    return {
      ...sat,
      sensor: sat.sensor ?? m.sensor,
      ...(m.mode ? { mode: m.mode } : {}),
      sar: m.sar ?? sat.sar,
      maxOffNadir: m.maxOffNadir ?? sat.maxOffNadir,
      minOffNadir: m.minOffNadir ?? sat.minOffNadir,
      swath,
      length: m.length ?? (m.swath !== undefined ? m.swath : sat.length),
      lookSide: m.lookSide ?? sat.lookSide,
      scenesPerPass: m.scenesPerPass !== undefined ? Math.max(1, Math.round(m.scenesPerPass)) : sat.scenesPerPass,
      minInterval: m.minInterval ?? sat.minInterval,
      maxPerDay: m.maxPerDay !== undefined ? Math.round(m.maxPerDay) : sat.maxPerDay,
      leadTime: m.leadTime ?? sat.leadTime,
      ...(m.resolution !== undefined ? { resolution: m.resolution } : {}),
      ...(m.primary ? { primary: true } : {}),
    };
  };
  const out = sats.flatMap((sat) => {
    const found = [sat.sensor, sat.series, sat.name].map((k) => bySensor.get(keyOf(k))).find((list) => list?.length);
    if (!found) return [sat];
    if (sat.mode) {
      const same = found.find((m) => keyOf(m.mode) === keyOf(sat.mode));
      return [same ? apply(sat, same) : { ...sat }];
    }
    return found.map((m) => apply(sat, m));
  });
  // One usual mode per satellite with several.
  const groups = new Map<string, SatelliteSpec[]>();
  for (const sat of out) groups.set(platformKey(sat), [...(groups.get(platformKey(sat)) ?? []), sat]);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const usual = list.find((s) => s.primary) ?? list[0];
    for (const s of list) s.primary = s === usual;
  }
  return out;
}

/**
 * The modes of the sample SAR satellite (sampleSatellites in
 * imaging-plan.ts), for trying modes without a sensor catalog: stripmap
 * (its usual one), spotlight (a small sharp spot, nearer nadir) and ScanSAR
 * (a wide swath). Made up, like the satellite.
 */
export function sampleSensorModes(): SensorMode[] {
  return [
    { sensor: 'サンプルSAR衛星', mode: 'ストリップマップ', minOffNadir: 20, maxOffNadir: 45, swath: 50, length: 50, resolution: 5, primary: true },
    { sensor: 'サンプルSAR衛星', mode: 'スポットライト', minOffNadir: 15, maxOffNadir: 35, swath: 10, length: 10, resolution: 1 },
    { sensor: 'サンプルSAR衛星', mode: 'スキャンSAR', minOffNadir: 20, maxOffNadir: 45, swath: 250, length: 250, resolution: 20 },
  ];
}
