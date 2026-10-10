/**
 * What an Esri image service (ImageServer) or map service (MapServer) layer
 * draws: for an image service, which images of its mosaic dataset are shown
 * (an attribute condition, the order they are stacked in, how they are
 * merged) and the raster function they are drawn with; for a map service,
 * which of its layers are drawn and a condition on each one's attributes.
 *
 * Settings are plain JSON, kept in `?service=` links and project files, and
 * written in config.json's `serviceRules` as named presets.
 */

/** The display settings of an Esri image or map service layer. Absent fields leave the service's default. */
export interface EsriRasterSettings {
  /** ImageServer: the condition on the catalog's attributes the images shown must meet (SQL `where`). */
  where?: string;
  /**
   * ImageServer: how overlapping images are stacked: `esriMosaicAttribute` (by `sortField`),
   * `esriMosaicNorthwest`, `esriMosaicCenter`, `esriMosaicNadir`, `esriMosaicSeamline`,
   * `esriMosaicLockRaster` (only `lockRasterIds`) or `esriMosaicNone` (by object id).
   */
  method?: string;
  /** ImageServer, with `esriMosaicAttribute`: the attribute images are stacked by. */
  sortField?: string;
  /** ImageServer, with `esriMosaicAttribute`: the value nearest which goes on top (none: by the attribute's order). */
  sortValue?: string | number;
  /** ImageServer: smallest value on top (true), or largest (false, the default for a sort field). */
  ascending?: boolean;
  /** ImageServer: how overlapping pixels are merged: `MT_FIRST` (the top image), `MT_LAST`, `MT_MIN`, `MT_MAX`, `MT_MEAN`, `MT_BLEND`, `MT_SUM`. */
  operation?: string;
  /** ImageServer, with `esriMosaicLockRaster`: the object ids of the only images drawn. */
  lockRasterIds?: number[];
  /** ImageServer: a raster function the service offers, by name (`None` for the stored values). */
  rasterFunction?: string;
  /** ImageServer: a rendering rule written out (JSON); wins over `rasterFunction`. */
  renderingRule?: string;
  /** ImageServer: the bands drawn as red, green and blue (0-based, as the REST API counts them). */
  bandIds?: number[];
  /** MapServer: the ids of the layers drawn (none: the service's default). */
  layers?: number[];
  /** MapServer: a condition on the attributes of each layer, by layer id. */
  layerDefs?: Record<string, string>;
  /** The name of the preset (config.json's `serviceRules`) these settings came from, for the dialog and the information panel. */
  rule?: string;
}

/** A named preset of settings, for the services whose URL matches. */
export interface ServiceRule {
  /** Shown in the rule list. */
  label: string;
  /** Tested against the service URL (…/ImageServer or …/MapServer). */
  match: RegExp;
  /** Applied when a layer of a matching service opens without settings of its own. */
  default: boolean;
  settings: EsriRasterSettings;
}

/** The mosaic methods of the REST API, with names for the dialog. */
export const mosaicMethods: Record<string, string> = {
  esriMosaicAttribute: '属性で並べる',
  esriMosaicNorthwest: '北西を上に',
  esriMosaicCenter: '中心に近い順',
  esriMosaicNadir: '直下視に近い順',
  esriMosaicSeamline: 'シームライン',
  esriMosaicViewpoint: '視点に近い順',
  esriMosaicLockRaster: '画像を指定（ID）',
  esriMosaicNone: 'ID 順',
};

/** The mosaic operations, with names for the dialog. */
export const mosaicOperations: Record<string, string> = {
  MT_FIRST: '上の画像',
  MT_LAST: '下の画像',
  MT_MIN: '最小値',
  MT_MAX: '最大値',
  MT_MEAN: '平均',
  MT_BLEND: 'ブレンド',
  MT_SUM: '合計',
};

/** `allowedMosaicMethods` / `defaultMosaicMethod` names (`ByAttribute`, `NorthWest`) as mosaic rule methods. */
export function mosaicMethodOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  const names: Record<string, string> = {
    byattribute: 'esriMosaicAttribute',
    attribute: 'esriMosaicAttribute',
    northwest: 'esriMosaicNorthwest',
    center: 'esriMosaicCenter',
    nadir: 'esriMosaicNadir',
    seamline: 'esriMosaicSeamline',
    viewpoint: 'esriMosaicViewpoint',
    lockraster: 'esriMosaicLockRaster',
    none: 'esriMosaicNone',
  };
  if (names[key]) return names[key];
  return Object.keys(mosaicMethods).find((m) => m.toLowerCase() === key);
}

/** What an image service says of its own mosaicking, to fill in what the settings leave out. */
export interface MosaicDefaults {
  /** `defaultMosaicMethod` (`Northwest`, `ByAttribute`, …). */
  method?: string;
  sortField?: string;
  sortValue?: string | number | null;
  ascending?: boolean;
  /** `mosaicOperator` (`First`, `Mean`, …). */
  operation?: string;
}

/** The `mosaicRule` for the settings, or undefined when they leave the service's mosaicking as it is. */
export function mosaicRuleOf(settings: EsriRasterSettings, defaults: MosaicDefaults = {}): Record<string, unknown> | undefined {
  const where = settings.where?.trim();
  const touched = where || settings.method || settings.sortField || settings.operation || settings.lockRasterIds?.length || settings.ascending !== undefined;
  if (!touched) return undefined;
  // A sort field without a method means "stack by this attribute".
  const method = settings.method ?? (settings.sortField ? 'esriMosaicAttribute' : (mosaicMethodOf(defaults.method) ?? 'esriMosaicNorthwest'));
  const rule: Record<string, unknown> = { mosaicMethod: method };
  if (where) rule.where = where;
  if (method === 'esriMosaicAttribute') {
    const sortField = settings.sortField ?? defaults.sortField;
    if (sortField) rule.sortField = sortField;
    const sortValue = settings.sortField ? settings.sortValue : (settings.sortValue ?? defaults.sortValue ?? undefined);
    if (sortValue !== undefined && sortValue !== '') rule.sortValue = sortValue;
    // By a field alone the largest goes on top unless asked otherwise (the newest image, the highest quality).
    rule.ascending = settings.ascending ?? (settings.sortField ? false : (defaults.ascending ?? true));
  } else if (settings.ascending !== undefined) {
    rule.ascending = settings.ascending;
  }
  if (method === 'esriMosaicLockRaster') rule.lockRasterIds = settings.lockRasterIds ?? [];
  const operation = settings.operation ?? operationOf(defaults.operation);
  if (operation) rule.mosaicOperation = operation;
  return rule;
}

/** `mosaicOperator` (`First`) as a mosaic operation (`MT_FIRST`). */
function operationOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const op = `MT_${name.toUpperCase().replace(/^MT_/, '')}`;
  return op in mosaicOperations ? op : undefined;
}

/** The `renderingRule` for the settings: written out, or a raster function by name; undefined for the service's default. */
export function renderingRuleOf(settings: EsriRasterSettings): Record<string, unknown> | undefined {
  if (settings.renderingRule?.trim()) {
    const rule = JSON.parse(settings.renderingRule) as unknown;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('レンダリングルールは JSON のオブジェクトにしてください');
    return rule as Record<string, unknown>;
  }
  if (settings.rasterFunction) return { rasterFunction: settings.rasterFunction };
  return undefined;
}

/** `layers=show:…` and `layerDefs` for a map service export, from the settings. */
export function mapLayerParams(settings: EsriRasterSettings): Record<string, string> {
  const params: Record<string, string> = {};
  if (settings.layers) params.layers = `show:${settings.layers.length ? settings.layers.join(',') : '-1'}`;
  const defs = Object.entries(settings.layerDefs ?? {}).filter(([, where]) => where.trim());
  if (defs.length) params.layerDefs = JSON.stringify(Object.fromEntries(defs.map(([id, where]) => [id, where.trim()])));
  return params;
}

/** Whether the settings change what a map service draws (so its tile cache cannot be used). */
export function changesMap(settings: EsriRasterSettings): boolean {
  return Object.keys(mapLayerParams(settings)).length > 0;
}

/** Whether the settings change nothing. */
export function isDefault(settings: EsriRasterSettings): boolean {
  return Object.entries(settings).every(([key, value]) => key === 'rule' || value === undefined);
}

/** A short description of the settings, for the information panel. */
export function describeSettings(settings: EsriRasterSettings): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (settings.rule) lines.push(['表示ルール', settings.rule]);
  if (settings.where?.trim()) lines.push(['条件', settings.where.trim()]);
  if (settings.method) lines.push(['重ね方', mosaicMethods[settings.method] ?? settings.method]);
  if (settings.sortField) lines.push(['並び順', `${settings.sortField}（${settings.ascending ? '小さい順' : '大きい順'}を上に）`]);
  if (settings.operation) lines.push(['重なりの値', mosaicOperations[settings.operation] ?? settings.operation]);
  if (settings.lockRasterIds?.length) lines.push(['表示する画像', settings.lockRasterIds.join(', ')]);
  if (settings.renderingRule?.trim()) lines.push(['ラスター関数', 'JSON で指定']);
  else if (settings.rasterFunction) lines.push(['ラスター関数', settings.rasterFunction]);
  if (settings.bandIds?.length) lines.push(['バンド', settings.bandIds.map((b) => b + 1).join(', ')]);
  if (settings.layers) lines.push(['表示レイヤー', settings.layers.length ? settings.layers.join(', ') : 'なし']);
  for (const [id, where] of Object.entries(settings.layerDefs ?? {})) if (where.trim()) lines.push([`条件（レイヤー ${id}）`, where.trim()]);
  return lines;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ids = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0) ? (v as number[]) : undefined);

/**
 * Settings read from JSON (a link, a project file, config.json); fields of the
 * wrong type are dropped, with a note in `problems` when given.
 */
export function settingsOf(value: unknown, problems?: string[], at = 'settings'): EsriRasterSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    problems?.push(`${at} がオブジェクトではありません`);
    return undefined;
  }
  const s: EsriRasterSettings = {};
  const drop = (key: string) => problems?.push(`${at} の ${key} は無視しました（型が違います）`);
  const text = (key: 'where' | 'sortField' | 'rasterFunction' | 'renderingRule' | 'rule') => {
    const v = value[key];
    if (key === 'renderingRule' && isRecord(v)) s.renderingRule = JSON.stringify(v);
    else if (typeof v === 'string' && v.trim()) s[key] = v;
    else if (v !== undefined) drop(key);
  };
  (['where', 'sortField', 'rasterFunction', 'renderingRule', 'rule'] as const).forEach(text);
  if (value.method !== undefined) {
    const method = typeof value.method === 'string' ? mosaicMethodOf(value.method) : undefined;
    if (method) s.method = method;
    else drop('method');
  }
  if (value.operation !== undefined) {
    const op = typeof value.operation === 'string' ? operationOf(value.operation) : undefined;
    if (op) s.operation = op;
    else drop('operation');
  }
  if (typeof value.sortValue === 'string' || typeof value.sortValue === 'number') s.sortValue = value.sortValue;
  else if (value.sortValue !== undefined) drop('sortValue');
  if (typeof value.ascending === 'boolean') s.ascending = value.ascending;
  else if (value.ascending !== undefined) drop('ascending');
  for (const key of ['lockRasterIds', 'bandIds', 'layers'] as const) {
    if (value[key] === undefined) continue;
    const list = ids(value[key]);
    if (list) s[key] = list;
    else drop(key);
  }
  if (isRecord(value.layerDefs)) {
    const defs = Object.entries(value.layerDefs).filter((e): e is [string, string] => typeof e[1] === 'string');
    if (defs.length) s.layerDefs = Object.fromEntries(defs);
  } else if (value.layerDefs !== undefined) drop('layerDefs');
  if (s.renderingRule) {
    try {
      renderingRuleOf(s);
    } catch {
      drop('renderingRule');
      delete s.renderingRule;
    }
  }
  return s;
}

/** config.json's `serviceRules`: named settings for the services whose URL matches. */
export function serviceRulesOf(value: unknown, problems: string[]): ServiceRule[] {
  if (!Array.isArray(value)) {
    problems.push('serviceRules が配列ではありません');
    return [];
  }
  const rules: ServiceRule[] = [];
  value.forEach((entry, i) => {
    const at = `serviceRules[${i}]`;
    if (!isRecord(entry)) return void problems.push(`${at} がオブジェクトではありません`);
    const { match, label, default: isDefaultRule, ...rest } = entry;
    let pattern = /./;
    if (match !== undefined) {
      if (typeof match !== 'string') return void problems.push(`${at} の match は文字列（正規表現）にしてください`);
      try {
        pattern = new RegExp(match, 'i');
      } catch {
        return void problems.push(`${at} の match「${match}」は正規表現として読めません`);
      }
    }
    if (typeof label !== 'string' || !label.trim()) return void problems.push(`${at} に label（ルールの名前）がありません`);
    const settings = settingsOf(rest, problems, at) ?? {};
    delete settings.rule;
    rules.push({ label: label.trim(), match: pattern, default: isDefaultRule === true, settings });
  });
  return rules;
}

/** The rules for a service URL, in config.json's order. */
export function rulesFor(rules: readonly ServiceRule[], url: string): ServiceRule[] {
  return rules.filter((r) => r.match.test(url));
}

/** The settings of a rule, named after it. */
export function ruleSettings(rule: ServiceRule): EsriRasterSettings {
  return { ...rule.settings, rule: rule.label };
}

/** A value written in SQL: numbers as they are, dates as `DATE 'yyyy-mm-dd'` (`TIMESTAMP` with a time), text in quotes. */
export function sqlValue(value: string, type: 'string' | 'integer' | 'double' | 'date' | 'oid' | 'other'): string {
  const v = value.trim();
  if ((type === 'integer' || type === 'double' || type === 'oid') && v !== '' && Number.isFinite(Number(v))) return String(Number(v));
  if (type === 'date') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
    if (m) {
      const p = (n: string | undefined) => (n ?? '0').padStart(2, '0');
      const date = `${m[1]}-${p(m[2])}-${p(m[3])}`;
      return m[4] ? `TIMESTAMP '${date} ${p(m[4])}:${p(m[5])}:${p(m[6])}'` : `DATE '${date}'`;
    }
  }
  return `'${v.replaceAll("'", "''")}'`;
}

/** `where` with one more condition, joined by AND. */
export function andWhere(where: string, condition: string): string {
  const w = where.trim();
  if (!w) return condition;
  return /\bor\b/i.test(w) ? `(${w}) AND ${condition}` : `${w} AND ${condition}`;
}
