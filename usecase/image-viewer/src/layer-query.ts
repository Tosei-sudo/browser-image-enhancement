/**
 * Attribute queries on vector layers: selecting the features that meet a SQL
 * `WHERE` (new selection, add, remove, or within the selection, as ArcGIS
 * does), and each layer's definition query (既定クエリ), which leaves the
 * other features out of the map and the attribute table alike. Esri layers
 * and tables ask their server (the definition query reads the features
 * again with `where`); the others are tested in the browser (sql-where.ts).
 */
import type Feature from 'ol/Feature.js';
import type { FeatureLike } from 'ol/Feature.js';
import Observable from 'ol/Observable.js';
import type { Selection } from './selection.js';
import { objectIdsWhere } from './services/esri.js';
import type { ServiceLayer } from './services/index.js';
import { compileWhere, type SqlField, type SqlTest } from './sql-where.js';

/** How the features found change the selection. */
export type SelectMode = 'new' | 'add' | 'remove' | 'within';

export const selectModes: Array<[SelectMode, string]> = [
  ['new', '新規選択'],
  ['add', '選択に追加'],
  ['remove', '選択から解除'],
  ['within', '選択内から選択'],
];

interface Definition {
  where: string;
  /** The browser's test; null when the server filters (Esri). */
  test: SqlTest | null;
}

/** The fields a condition on `service` can name: its attributes, and any other property its features carry. */
export function queryFields(service: ServiceLayer): SqlField[] {
  const vector = service.vector;
  if (!vector) return [];
  const fields: SqlField[] = vector.fields.map((f) => ({ name: f.name, type: f.type }));
  const known = new Set(fields.map((f) => f.name));
  const first = vector.source.getFeatures().slice(0, 50);
  for (const f of first) {
    const geometry = f.getGeometryName();
    for (const [key, value] of Object.entries(f.getProperties())) {
      if (key === geometry || known.has(key) || (value !== null && typeof value === 'object')) continue;
      known.add(key);
      fields.push({ name: key });
    }
  }
  return fields;
}

/** Whether the server answers conditions on `service` (an Esri layer or table). */
export const onServer = (service: ServiceLayer) => !!service.esri && !!service.requery;

/** Fires `change` when a layer's definition query is set or cleared. */
export class LayerQueries extends Observable {
  private readonly definitions_ = new WeakMap<ServiceLayer, Definition>();

  /** @param onChange Called after a layer's definition query is set or cleared (its features shown are new). */
  constructor(private readonly onChange: (service: ServiceLayer) => void = () => {}) {
    super();
  }

  /** The definition query of a layer, or null. */
  get(service: ServiceLayer): string | null {
    return this.definitions_.get(service)?.where ?? null;
  }

  /**
   * Sets the definition query of a layer (null or blank: none). Throws when
   * the SQL cannot be read (SqlError) or the server refuses it; the query
   * before stays then. Resolves to the number of features shown.
   */
  async set(service: ServiceLayer, where: string | null): Promise<number> {
    const vector = service.vector;
    if (!vector) throw new Error('属性のないレイヤー');
    const text = where?.trim() || null;
    if (text === this.get(service)) return this.features(service).length;
    let count: number;
    if (onServer(service)) {
      count = await service.requery!(text);
      if (text) this.definitions_.set(service, { where: text, test: null });
      else this.definitions_.delete(service);
    } else if (text) {
      const test = compileWhere(text, queryFields(service));
      this.definitions_.set(service, { where: text, test });
      service.style?.setDefinition((f: FeatureLike) => test((k) => f.get(k)));
      count = this.features(service).length;
    } else {
      this.definitions_.delete(service);
      service.style?.setDefinition(null);
      count = vector.source.getFeatures().length;
    }
    this.onChange(service);
    this.changed();
    return count;
  }

  /** Whether `feature` of `service` passes its definition query (always, without one or when the server filters). */
  passes(service: ServiceLayer, feature: FeatureLike): boolean {
    const test = this.definitions_.get(service)?.test;
    return !test || test((k) => feature.get(k));
  }

  /** Whether the browser filters the layer's features (a definition query not on a server). */
  filters(service: ServiceLayer): boolean {
    return !!this.definitions_.get(service)?.test;
  }

  /** The layer's features that pass its definition query. */
  features(service: ServiceLayer): Feature[] {
    const all = service.vector?.source.getFeatures() ?? [];
    return this.filters(service) ? all.filter((f) => this.passes(service, f)) : all;
  }

  /** The features of `service` (among those shown) meeting `where`: asked of the server for Esri layers. */
  async find(service: ServiceLayer, where: string): Promise<Feature[]> {
    const candidates = this.features(service);
    if (onServer(service)) {
      const ids = await objectIdsWhere(service.esri!, where);
      const oid = service.vector?.idField;
      return candidates.filter((f) => ids.has(Number(f.getId() ?? (oid ? f.get(oid) : undefined))));
    }
    const test = compileWhere(where, queryFields(service));
    return candidates.filter((f) => test((k) => f.get(k)));
  }

  /** How many of the shown features meet `where`, in the browser (throws when it cannot be read here). */
  count(service: ServiceLayer, where: string): number {
    const test = compileWhere(where, queryFields(service));
    let n = 0;
    for (const f of this.features(service)) if (test((k) => f.get(k))) n++;
    return n;
  }

  /** Selects the features meeting `where` in the way `mode` says; resolves to those found and the selection after. */
  async select(service: ServiceLayer, where: string, mode: SelectMode, selection: Selection): Promise<{ found: number; selected: number }> {
    const found = await this.find(service, where);
    if (mode === 'new') selection.set(found);
    else if (mode === 'add') selection.add(found);
    else if (mode === 'remove') selection.remove(found);
    else {
      const hit = new Set(found);
      selection.set(selection.list().filter((f) => hit.has(f)));
    }
    return { found: found.length, selected: selection.list().length };
  }
}
