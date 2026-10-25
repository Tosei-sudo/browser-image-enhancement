/**
 * The classification (分類体系) of the things observations are about: a tree
 * whose branches go as deep as they need — ships 船舶 > 支援船 > 〇〇級,
 * aircraft 航空機 > 戦闘機 > F-15 > F-15J — with the individual thing (its
 * real name: △△, a tail number) below the deepest class.
 *
 * A record's kind (種別) is the path of its class written out
 * (`船舶 > 支援船 > 〇〇級`), so it reads the same in the feature layer and
 * the CSV, and may stop at any depth (only 「船舶」 known yet).
 *
 * Each branch names its own levels: `levels` on a class names the depths
 * from its root down (「大分類・艦種・級」), the nearest class that says wins;
 * `nameLabel` says what the individual's name is (「艦名」「機番」); `members`
 * lists known individuals of a class, so typing one's name fills its class.
 *
 * A class also holds its specifications (諸元: length, width, other names,
 * country…, by `specFields`, a class's values standing for its branch below
 * unless a lower class says otherwise) and reference photos.
 *
 * Kept as a flat list of classes by path (parents implied), from
 * `config.json`'s `observationTaxonomy` (a nested tree), changed in the panel
 * and saved in an Esri table (`taxonomyTable` of a store) or the browser.
 */
import type { ObservationAsk } from './observations.js';

/** One class: its path from the root, and what it says of its branch. */
export interface Taxon {
  path: string[];
  /** The names of the depths from the root (this class's branch down), when this class sets them. */
  levels?: string[];
  /** What an individual's name is called below this class (艦名, 機番). */
  nameLabel?: string;
  /** Known individuals of this class (real names). */
  members?: string[];
  /** Specifications (諸元) by field name: 全長, 英名… */
  specs?: Record<string, string>;
  /** Reference photos: URLs, or `local:` ids of photos kept in the browser (taxon-photos.ts). */
  photos?: string[];
}

/** A class's own settings, beside its path. */
type Own = Omit<Taxon, 'path'>;

/** A class as `config.json` writes it: nested. */
export interface TaxonTree extends Own {
  name: string;
  children?: TaxonTree[];
}

/** One specification field (諸元の項目). */
export interface SpecField {
  name: string;
  /** text; number (sorted and shown with its unit); list (several, 読点区切り); url (a link). */
  type: 'text' | 'number' | 'list' | 'url';
  unit?: string;
}

/** The fields offered at first. */
export const defaultSpecFields: SpecField[] = [
  { name: '別名', type: 'list' },
  { name: '英名', type: 'text' },
  { name: '開発国', type: 'text' },
  { name: '運用国', type: 'list' },
  { name: '全長', type: 'number', unit: 'm' },
  { name: '全幅', type: 'number', unit: 'm' },
  { name: '全高', type: 'number', unit: 'm' },
  { name: '排水量', type: 'number', unit: 't' },
  { name: '就役', type: 'text' },
  { name: '識別の特徴', type: 'text' },
  { name: '資料', type: 'url' },
];

/** Written between the levels of a kind. */
export const SEPARATOR = ' > ';

/** The path of a kind (`船舶 > 支援船`, also › / ＞ between). */
export const pathOf = (kind: string): string[] =>
  kind
    .split(/\s*[>›＞]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The kind of a path. */
export const kindOf = (path: readonly string[]): string => path.join(SEPARATOR);

/** Whether a kind is `path` or below it. */
export function within(kind: string, path: readonly string[]): boolean {
  const p = pathOf(kind);
  return path.length <= p.length && path.every((s, i) => p[i] === s);
}

const key = (path: readonly string[]) => path.join('\u0000');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const words = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))] : undefined;
const segment = (name: string) => name.replace(/\s*[>›＞]\s*/g, ' ').trim();

/** The specification values that say something. */
const specsOf = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    const text = Array.isArray(v) ? v.join('、') : typeof v === 'number' || typeof v === 'string' ? String(v).trim() : '';
    if (k.trim() && text) out[k.trim()] = text;
  }
  return Object.keys(out).length ? out : undefined;
};

/** A copy of a class's own settings, without the empty ones. */
function ownOf(t: Own): Own {
  const specs = specsOf(t.specs);
  return {
    ...(t.levels?.length ? { levels: [...t.levels] } : {}),
    ...(t.nameLabel ? { nameLabel: t.nameLabel } : {}),
    ...(t.members?.length ? { members: [...new Set(t.members)] } : {}),
    ...(specs ? { specs } : {}),
    ...(t.photos?.length ? { photos: [...new Set(t.photos)] } : {}),
  };
}

/** Fills in the parents and sorts parents before children, siblings in the order they came; later duplicates add to the first. */
export function normalize(list: readonly Taxon[]): Taxon[] {
  const byKey = new Map<string, Taxon>();
  const order: string[] = [];
  const put = (t: Taxon) => {
    const k = key(t.path);
    const had = byKey.get(k);
    if (!had) {
      byKey.set(k, { path: [...t.path], ...ownOf(t) });
      order.push(k);
      return;
    }
    if (t.levels?.length && !had.levels) had.levels = [...t.levels];
    if (t.nameLabel && !had.nameLabel) had.nameLabel = t.nameLabel;
    if (t.members?.length) had.members = [...new Set([...(had.members ?? []), ...t.members])];
    const specs = specsOf(t.specs);
    if (specs) had.specs = { ...specs, ...had.specs };
    if (t.photos?.length) had.photos = [...new Set([...(had.photos ?? []), ...t.photos])];
  };
  for (const t of list) {
    const path = t.path.map(segment).filter(Boolean);
    if (!path.length) continue;
    for (let d = 1; d < path.length; d++) put({ path: path.slice(0, d) });
    put({ ...t, path });
  }
  // Depth first, in the order each first came.
  const rank = new Map(order.map((k, i) => [k, i]));
  const children = new Map<string, Taxon[]>();
  for (const k of order) {
    const t = byKey.get(k)!;
    const parent = key(t.path.slice(0, -1));
    const list = children.get(parent);
    if (list) list.push(t);
    else children.set(parent, [t]);
  }
  const out: Taxon[] = [];
  const walk = (parent: string) => {
    for (const t of (children.get(parent) ?? []).sort((a, b) => rank.get(key(a.path))! - rank.get(key(b.path))!)) {
      out.push(t);
      walk(key(t.path));
    }
  };
  walk(key([]));
  return out;
}

/** The flat list of a nested tree. */
export function flatten(trees: readonly TaxonTree[], parent: string[] = []): Taxon[] {
  const out: Taxon[] = [];
  for (const t of trees) {
    const path = [...parent, t.name];
    out.push({ path, ...ownOf(t) });
    if (t.children?.length) out.push(...flatten(t.children, path));
  }
  return normalize(out);
}

/** The nested tree of a flat list (for `config.json`). */
export function nest(list: readonly Taxon[]): TaxonTree[] {
  const roots: TaxonTree[] = [];
  const nodes = new Map<string, TaxonTree>();
  for (const t of normalize(list)) {
    const node: TaxonTree = { name: t.path[t.path.length - 1], ...ownOf(t) };
    nodes.set(key(t.path), node);
    const parent = nodes.get(key(t.path.slice(0, -1)));
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

/** Classes of the plain kinds of before (`kinds: ["船舶", …]`), each a root. */
export const fromKinds = (kinds: readonly string[]): Taxon[] => normalize(kinds.map((k) => ({ path: pathOf(k) })));

/** `config.json`'s `observationTaxonomy` (nested, as TaxonTree); null when it cannot be used. */
export function taxonomyOf(value: unknown, problems: string[], at = 'observationTaxonomy'): Taxon[] | null {
  if (!Array.isArray(value)) return (problems.push(`${at} は分類の配列で指定`), null);
  const tree = (v: unknown, where: string): TaxonTree | null => {
    if (typeof v === 'string' && v.trim()) return { name: v.trim() };
    if (!isRecord(v) || typeof v.name !== 'string' || !v.name.trim()) return (problems.push(`${where} は name のある分類（または名前の文字列）で指定`), null);
    const children = Array.isArray(v.children) ? v.children.map((c, i) => tree(c, `${where}.children[${i}]`)).filter((c): c is TaxonTree => c !== null) : undefined;
    if (v.children !== undefined && !Array.isArray(v.children)) problems.push(`${where}.children は配列で指定`);
    return {
      name: v.name.trim(),
      ...(words(v.levels)?.length ? { levels: words(v.levels) } : {}),
      ...(typeof v.nameLabel === 'string' && v.nameLabel.trim() ? { nameLabel: v.nameLabel.trim() } : {}),
      ...(words(v.members)?.length ? { members: words(v.members) } : {}),
      ...(specsOf(v.specs) ? { specs: specsOf(v.specs) } : {}),
      ...(words(v.photos)?.length ? { photos: words(v.photos) } : {}),
      ...(children?.length ? { children } : {}),
    };
  };
  return flatten(value.map((v, i) => tree(v, `${at}[${i}]`)).filter((t): t is TaxonTree => t !== null));
}

/** The classification with the kinds records use that it does not have yet (added under theirs). */
export const withKinds = (list: readonly Taxon[], kinds: Iterable<string>): Taxon[] => normalize([...list, ...[...kinds].map((k) => ({ path: pathOf(k) }))]);

/** A class by path. */
export const find = (list: readonly Taxon[], path: readonly string[]): Taxon | undefined => list.find((t) => key(t.path) === key(path));

/** The classes right below a path ([] for the roots). */
export const childrenOf = (list: readonly Taxon[], path: readonly string[]): Taxon[] => list.filter((t) => t.path.length === path.length + 1 && path.every((s, i) => t.path[i] === s));

/** The name of a depth (0 the root) in a path's branch: the nearest class on the path that names it. */
export function levelName(list: readonly Taxon[], path: readonly string[], depth: number): string {
  for (let d = Math.min(path.length, depth + 1); d >= 1; d--) {
    const levels = find(list, path.slice(0, d))?.levels;
    // A class's levels count from the root.
    if (levels?.[depth]) return levels[depth];
  }
  return '';
}

/** What an individual's name is called below a path: the nearest class that says, else 「名前」. */
export function nameLabelOf(list: readonly Taxon[], path: readonly string[]): string {
  for (let d = path.length; d >= 1; d--) {
    const label = find(list, path.slice(0, d))?.nameLabel;
    if (label) return label;
  }
  return '';
}

/** The class of each known individual's name. */
export function memberIndex(list: readonly Taxon[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of list) for (const m of t.members ?? []) if (!out.has(m)) out.set(m, t.path);
  return out;
}

/** `kind` with `from` (and below) moved to `to`; unchanged when it is not under `from`. */
export function rewrite(kind: string, from: readonly string[], to: readonly string[]): string {
  if (!within(kind, from)) return kind;
  return kindOf([...to, ...pathOf(kind).slice(from.length)]);
}

/** The classification with a class (and its branch) moved or renamed to `to`. */
export function moveTaxon(list: readonly Taxon[], from: readonly string[], to: readonly string[]): Taxon[] {
  if (!from.length || !to.length) return [...list];
  // Not into its own branch.
  if (to.length > from.length && from.every((s, i) => to[i] === s)) throw new Error('自身の下位への移動は不可');
  return normalize(list.map((t) => (t.path.length >= from.length && from.every((s, i) => t.path[i] === s) ? { ...t, path: [...to, ...t.path.slice(from.length)] } : t)));
}

/** The classification with a class's branch placed just before a sibling (`before`), or after its siblings (null). */
export function placeTaxon(list: readonly Taxon[], path: readonly string[], before: readonly string[] | null): Taxon[] {
  const under = (t: Taxon, p: readonly string[]) => t.path.length >= p.length && p.every((s, i) => t.path[i] === s);
  const branch = list.filter((t) => under(t, path));
  if (!branch.length) return [...list];
  const rest = list.filter((t) => !under(t, path));
  const parent = path.slice(0, -1);
  const at = before && before.length === path.length ? rest.findIndex((t) => key(t.path) === key(before)) : -1;
  // After the parent's last descendant when no sibling is named.
  let end = rest.length;
  if (at < 0 && parent.length) {
    const last = rest.reduce((found, t, i) => (under(t, parent) ? i : found), -1);
    if (last >= 0) end = last + 1;
  }
  const index = at >= 0 ? at : end;
  return normalize([...rest.slice(0, index), ...branch, ...rest.slice(index)]);
}

/** The classification without a class and its branch. */
export const removeTaxon = (list: readonly Taxon[], path: readonly string[]): Taxon[] => list.filter((t) => !(t.path.length >= path.length && path.every((s, i) => t.path[i] === s)));

/** The classification with a class's own settings changed (those named in `changes`; empty clears). */
export const updateTaxon = (list: readonly Taxon[], path: readonly string[], changes: Own): Taxon[] =>
  normalize(list.map((t) => (key(t.path) === key(path) ? { path: t.path, ...ownOf({ ...t, ...changes }) } : t)));

/** `config.json`'s `specFields` (names alone are text fields); null when it cannot be used. */
export function specFieldsOf(value: unknown, problems: string[], at = 'specFields'): SpecField[] | null {
  if (!Array.isArray(value)) return (problems.push(`${at} は諸元の項目の配列で指定`), null);
  const out: SpecField[] = [];
  value.forEach((v, i) => {
    const f = typeof v === 'string' ? { name: v } : v;
    if (!isRecord(f) || typeof f.name !== 'string' || !f.name.trim()) return void problems.push(`${at}[${i}] は name のある項目（または名前の文字列）で指定`);
    const type = f.type === undefined ? 'text' : f.type;
    if (type !== 'text' && type !== 'number' && type !== 'list' && type !== 'url') return void problems.push(`${at}[${i}].type は text・number・list・url のいずれかで指定`);
    if (out.some((x) => x.name === f.name)) return;
    out.push({ name: f.name.trim(), type, ...(typeof f.unit === 'string' && f.unit.trim() ? { unit: f.unit.trim() } : {}) });
  });
  return out;
}

/** A class's specifications, its own and those of the classes above it (the nearest wins), by field; `from` is the class that says. */
export function specsAt(list: readonly Taxon[], path: readonly string[]): Map<string, { value: string; from: string[] }> {
  const out = new Map<string, { value: string; from: string[] }>();
  for (let d = path.length; d >= 1; d--) {
    const t = find(list, path.slice(0, d));
    for (const [name, value] of Object.entries(t?.specs ?? {})) if (!out.has(name)) out.set(name, { value, from: path.slice(0, d) });
  }
  return out;
}

/** A class's reference photos: its own, else those of the nearest class above that has some. */
export function photosAt(list: readonly Taxon[], path: readonly string[]): { photos: string[]; from: string[] } {
  for (let d = path.length; d >= 1; d--) {
    const photos = find(list, path.slice(0, d))?.photos;
    if (photos?.length) return { photos, from: path.slice(0, d) };
  }
  return { photos: [], from: [] };
}

/** A specification shown: with its unit. */
export const specText = (field: SpecField | undefined, value: string): string => (field?.unit && value ? `${value} ${field.unit}` : value);

/** The class a name stands for: a class's own name, else one of its other names (the list fields: 別名) or its 英名, any case. */
export function classByName(list: readonly Taxon[], name: string, fields: readonly SpecField[] = defaultSpecFields): string[] | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const own = list.find((t) => t.path[t.path.length - 1].toLowerCase() === q);
  if (own) return own.path;
  const names = fields.filter((f) => f.type === 'list' || /名/.test(f.name)).map((f) => f.name);
  const hit = list.find((t) => names.some((n) => (t.specs?.[n] ?? '').split(/[,、]/).some((w) => w.trim().toLowerCase() === q)));
  return hit?.path ?? null;
}

/** The deepest depth in use. */
export const depthOf = (list: readonly Taxon[], kinds: Iterable<string> = []): number => Math.max(0, ...list.map((t) => t.path.length), ...[...kinds].map((k) => pathOf(k).length));

/** Where a store's classification is kept. */
export interface TaxonomyStore {
  readonly label: string;
  /** The classification kept, or null when none is kept yet (the configured one applies). */
  load(): Promise<Taxon[] | null>;
  save(list: readonly Taxon[]): Promise<void>;
  /** The specification fields kept, or null when none are kept yet. */
  loadFields(): Promise<SpecField[] | null>;
  saveFields(fields: readonly SpecField[]): Promise<void>;
}

/** A classification in this browser (localStorage), one per store. */
export class LocalTaxonomyStore implements TaxonomyStore {
  readonly label = 'このブラウザ';
  constructor(private readonly name: string) {}

  private get key_(): string {
    return `image-viewer.obs-taxonomy:${this.name}`;
  }

  async load(): Promise<Taxon[] | null> {
    try {
      const text = localStorage.getItem(this.key_);
      if (!text) return null;
      const value = JSON.parse(text) as unknown;
      return Array.isArray(value) ? normalize(value.filter((t): t is Taxon => isRecord(t) && Array.isArray(t.path))) : null;
    } catch {
      return null;
    }
  }

  async save(list: readonly Taxon[]): Promise<void> {
    localStorage.setItem(this.key_, JSON.stringify(normalize(list)));
  }

  async loadFields(): Promise<SpecField[] | null> {
    try {
      const text = localStorage.getItem(`${this.key_}:fields`);
      return text ? specFieldsOf(JSON.parse(text), []) : null;
    } catch {
      return null;
    }
  }

  async saveFields(fields: readonly SpecField[]): Promise<void> {
    localStorage.setItem(`${this.key_}:fields`, JSON.stringify(fields));
  }
}

/** The attributes of a classification table by role. */
export interface TaxonomyFields {
  path: string;
  levels: string;
  nameLabel: string;
  members: string;
  /** The specifications, as JSON. */
  specs: string;
  /** The reference photos' URLs, one per line. */
  photos: string;
  order: string;
}

export const defaultTaxonomyFields: TaxonomyFields = {
  path: 'PATH',
  levels: 'LEVELS',
  nameLabel: 'NAME_LABEL',
  members: 'MEMBERS',
  specs: 'SPECS',
  photos: 'PHOTOS',
  order: 'SORT_ORDER',
};

/** A store's `taxonomyTable`: an editable Esri table, one row per class. */
export interface TaxonomyTableConfig {
  url: string;
  token?: string;
  fields: TaxonomyFields;
}

/** A `taxonomyTable` entry; null (with the reason in `problems`) when it cannot be used. */
export function taxonomyTableOf(value: unknown, problems: string[], at: string): TaxonomyTableConfig | null {
  const v = typeof value === 'string' ? { url: value } : value;
  if (!isRecord(v) || typeof v.url !== 'string' || !/\/FeatureServer\/\d+\/?$/i.test(v.url.split('?', 1)[0]))
    return (problems.push(`${at} は編集できる …/FeatureServer/1 のようなテーブルの URL で指定`), null);
  const fields = { ...defaultTaxonomyFields };
  if (isRecord(v.fields)) {
    for (const [k, name] of Object.entries(v.fields)) {
      if (!(k in defaultTaxonomyFields)) problems.push(`${at}.fields.${k} は使用不可の役割`);
      else if (typeof name === 'string' && /^[\w.]+$/.test(name)) fields[k as keyof TaxonomyFields] = name;
      else problems.push(`${at}.fields.${k} は属性名で指定`);
    }
  }
  return {
    url: v.url.split('?', 1)[0].replace(/\/+$/, ''),
    ...(typeof v.token === 'string' && v.token ? { token: v.token } : {}),
    fields,
  };
}

const list = (text: unknown) =>
  String(text ?? '')
    .split(/[,、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A classification in an Esri table (shared by everyone using the store). */
export class EsriTaxonomyStore implements TaxonomyStore {
  readonly label: string;
  /** The row that holds the specification fields (its PATH), not a class. */
  static readonly FIELDS_ROW = '#諸元項目';
  /** The object id of each class's row (by path). */
  private readonly oids_ = new Map<string, number>();
  private fieldsRow_: { oid: number | null; fields: SpecField[] | null } = { oid: null, fields: null };
  private oid_: string | null = null;
  private types_: Record<string, string> = {};

  constructor(
    private readonly config: TaxonomyTableConfig,
    private readonly ask: ObservationAsk,
    label: string,
  ) {
    this.label = label;
  }

  private async layer_(): Promise<string> {
    if (this.oid_) return this.oid_;
    const json = (await this.ask(this.config.url, {}, this.config.token)) as {
      fields?: Array<{ name: string; type: string }>;
      objectIdField?: string;
    };
    for (const f of json.fields ?? []) this.types_[f.name] = f.type;
    if (!(this.config.fields.path in this.types_)) throw new Error(`分類のテーブルに属性 ${this.config.fields.path} なし`);
    this.oid_ = json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
    return this.oid_;
  }

  async load(): Promise<Taxon[] | null> {
    const oid = await this.layer_();
    const f = this.config.fields;
    const rows: Array<{ taxon: Taxon; order: number }> = [];
    this.oids_.clear();
    for (let offset = 0; offset < 100000; ) {
      const json = (await this.ask(
        `${this.config.url}/query`,
        {
          where: '1=1',
          outFields: '*',
          returnGeometry: 'false',
          resultOffset: String(offset),
          resultRecordCount: '2000',
        },
        this.config.token,
      )) as {
        features?: Array<{ attributes: Record<string, unknown> }>;
        exceededTransferLimit?: boolean;
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? '分類の読み込み不可');
      const features = json.features ?? [];
      for (const { attributes: a } of features) {
        if (String(a[f.path] ?? '') === EsriTaxonomyStore.FIELDS_ROW) {
          this.fieldsRow_ = { oid: typeof a[oid] === 'number' ? (a[oid] as number) : null, fields: jsonOf(a[f.specs], (v) => specFieldsOf(v, [])) ?? null };
          continue;
        }
        const path = pathOf(String(a[f.path] ?? ''));
        if (!path.length) continue;
        if (typeof a[oid] === 'number') this.oids_.set(key(path), a[oid] as number);
        const levels = list(a[f.levels]);
        const members = list(a[f.members]);
        const nameLabel = String(a[f.nameLabel] ?? '').trim();
        const specs = jsonOf(a[f.specs], specsOf);
        const photos = String(a[f.photos] ?? '')
          .split(/\s*\n\s*/)
          .filter(Boolean);
        rows.push({
          taxon: {
            path,
            ...(levels.length ? { levels } : {}),
            ...(nameLabel ? { nameLabel } : {}),
            ...(members.length ? { members } : {}),
            ...(specs ? { specs } : {}),
            ...(photos.length ? { photos } : {}),
          },
          order: Number(a[f.order]) || rows.length,
        });
      }
      if (!json.exceededTransferLimit || !features.length) break;
      offset += features.length;
    }
    return rows.length ? normalize(rows.sort((a, b) => a.order - b.order).map((r) => r.taxon)) : null;
  }

  async save(taxa: readonly Taxon[]): Promise<void> {
    const oid = await this.layer_();
    const f = this.config.fields;
    const all = normalize(taxa);
    const attributesOf = (t: Taxon, i: number) => {
      const values: Record<string, unknown> = {
        [f.path]: kindOf(t.path),
        [f.levels]: (t.levels ?? []).join(','),
        [f.nameLabel]: t.nameLabel ?? '',
        [f.members]: (t.members ?? []).join(','),
        [f.specs]: t.specs ? JSON.stringify(t.specs) : '',
        [f.photos]: (t.photos ?? []).join('\n'),
        [f.order]: i,
      };
      const out: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(values)) if (name in this.types_) out[name] = value;
      const id = this.oids_.get(key(t.path));
      if (id !== undefined) out[oid] = id;
      return { attributes: out };
    };
    const kept = new Set(all.map((t) => key(t.path)));
    const deletes = [...this.oids_].filter(([k]) => !kept.has(k)).map(([, id]) => id);
    const adds = all.map((t, i) => [t, i] as const).filter(([t]) => !this.oids_.has(key(t.path)));
    const updates = all.map((t, i) => [t, i] as const).filter(([t]) => this.oids_.has(key(t.path)));
    const json = (await this.ask(
      `${this.config.url}/applyEdits`,
      {
        adds: JSON.stringify(adds.map(([t, i]) => attributesOf(t, i))),
        updates: JSON.stringify(updates.map(([t, i]) => attributesOf(t, i))),
        deletes: deletes.join(','),
        rollbackOnFailure: 'false',
      },
      this.config.token,
    )) as {
      addResults?: Array<{
        success: boolean;
        objectId?: number;
        error?: { description?: string } | null;
      }>;
      updateResults?: Array<{
        success: boolean;
        error?: { description?: string } | null;
      }>;
      deleteResults?: Array<{ success: boolean; objectId?: number }>;
    };
    const failed: string[] = [];
    (json.addResults ?? []).forEach((r, k) => {
      if (r.success && typeof r.objectId === 'number') this.oids_.set(key(adds[k][0].path), r.objectId);
      else if (!r.success) failed.push(r.error?.description ?? '追加失敗');
    });
    for (const r of json.updateResults ?? []) if (!r.success) failed.push(r.error?.description ?? '更新失敗');
    const gone = new Set(deletes);
    for (const [k, id] of [...this.oids_]) if (gone.has(id)) this.oids_.delete(k);
    if (failed.length) throw new Error(`分類 ${failed.length} 件の保存に失敗: ${failed[0]}`);
  }

  async loadFields(): Promise<SpecField[] | null> {
    // Read with the classes.
    if (this.oid_ === null) await this.load();
    return this.fieldsRow_.fields;
  }

  async saveFields(fields: readonly SpecField[]): Promise<void> {
    const oid = await this.layer_();
    const f = this.config.fields;
    if (!(f.specs in this.types_)) throw new Error(`分類のテーブルに属性 ${f.specs} なし`);
    const row = { attributes: { [f.path]: EsriTaxonomyStore.FIELDS_ROW, [f.specs]: JSON.stringify(fields), ...(this.fieldsRow_.oid !== null ? { [oid]: this.fieldsRow_.oid } : {}) } };
    const json = (await this.ask(`${this.config.url}/applyEdits`, { [this.fieldsRow_.oid !== null ? 'updates' : 'adds']: JSON.stringify([row]), rollbackOnFailure: 'false' }, this.config.token)) as {
      addResults?: Array<{ success: boolean; objectId?: number; error?: { description?: string } | null }>;
      updateResults?: Array<{ success: boolean; error?: { description?: string } | null }>;
    };
    const result = (this.fieldsRow_.oid !== null ? json.updateResults : json.addResults)?.[0];
    if (!result?.success) throw new Error(`諸元の項目の保存に失敗: ${result?.error?.description ?? '応答なし'}`);
    this.fieldsRow_ = { oid: this.fieldsRow_.oid ?? (json.addResults?.[0]?.objectId as number | undefined) ?? null, fields: [...fields] };
  }
}

/** A JSON text read with `read`; undefined when it is not JSON. */
function jsonOf<T>(text: unknown, read: (value: unknown) => T | undefined | null): T | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return read(JSON.parse(text)) ?? undefined;
  } catch {
    return undefined;
  }
}
