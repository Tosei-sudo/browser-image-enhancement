/**
 * Unsaved edits of an Esri layer: features added, reshaped, moved, deleted
 * and attributes changed, each step undoable, until "save" sends them all
 * in one `applyEdits`. Features the server refuses stay unsaved, with the
 * server's reason.
 */
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Observable from 'ol/Observable.js';
import type VectorSource from 'ol/source/Vector.js';
import { applyEdits, esriGeometry, queryIds, type EsriLayerInfo } from './services/esri.js';
import type { Field } from './services/index.js';

export interface SaveOutcome {
  saved: number;
  failed: Array<{ feature: Feature | null; message: string }>;
}

/** Fires `change` after every edit, undo, discard and save. */
export class EditSession extends Observable {
  private readonly added_ = new Set<Feature>();
  private readonly deleted_ = new Map<Feature, number>();
  private readonly geometry_ = new Set<Feature>();
  private readonly attributes_ = new Map<Feature, Set<string>>();
  private readonly undo_: Array<() => void> = [];
  /** Why the server refused a feature, until it is saved. */
  private readonly errors_ = new Map<Feature, string>();

  constructor(
    readonly info: EsriLayerInfo,
    readonly source: VectorSource<Feature>,
    readonly fields: Field[],
  ) {
    super();
  }

  /** Features with unsaved changes (deleted ones included). */
  count(): number {
    const changed = new Set<Feature>([...this.added_, ...this.geometry_, ...this.attributes_.keys()]);
    for (const f of this.deleted_.keys()) changed.delete(f);
    return changed.size + this.deleted_.size;
  }

  isAdded(feature: Feature): boolean {
    return this.added_.has(feature);
  }

  /** Whether the feature (or one of its attributes) has unsaved changes. */
  isDirty(feature: Feature, field?: string): boolean {
    if (field !== undefined) return this.added_.has(feature) || !!this.attributes_.get(feature)?.has(field);
    return this.added_.has(feature) || this.geometry_.has(feature) || this.attributes_.has(feature);
  }

  errorOf(feature: Feature): string | undefined {
    return this.errors_.get(feature);
  }

  canUndo(): boolean {
    return this.undo_.length > 0;
  }

  /** Whether an attribute can be changed on this feature. */
  canEdit(feature: Feature, field: Field): boolean {
    return field.editable && (this.added_.has(feature) ? this.info.canCreate : this.info.canUpdate);
  }

  /** A new feature, drawn on the map: it gets the template's attributes. */
  add(feature: Feature): void {
    for (const [name, value] of Object.entries(this.info.template)) if (name !== this.info.objectIdField) feature.set(name, value, true);
    this.source.addFeature(feature);
    this.added_.add(feature);
    this.push_(() => {
      this.added_.delete(feature);
      this.errors_.delete(feature);
      if (this.source.hasFeature(feature)) this.source.removeFeature(feature);
    });
  }

  /** Deletes features (they leave the map until undone or discarded). */
  delete(features: Feature[]): void {
    const removed: Array<{ feature: Feature; added: boolean }> = [];
    for (const feature of features) {
      if (!this.source.hasFeature(feature)) continue;
      this.source.removeFeature(feature);
      if (this.added_.has(feature)) {
        this.added_.delete(feature);
        removed.push({ feature, added: true });
      } else {
        this.deleted_.set(feature, Number(feature.get(this.info.objectIdField)));
        removed.push({ feature, added: false });
      }
    }
    if (removed.length === 0) return;
    this.push_(() => {
      for (const { feature, added } of removed) {
        this.source.addFeature(feature);
        if (added) this.added_.add(feature);
        else this.deleted_.delete(feature);
      }
    });
  }

  /** Records that features were reshaped or moved; `before` are their geometries before. */
  reshaped(before: Map<Feature, Geometry | undefined>): void {
    const was = new Map<Feature, boolean>();
    for (const [feature, geometry] of before) {
      const now = feature.getGeometry();
      if (geometry && now && JSON.stringify(geometry.getExtent()) === JSON.stringify(now.getExtent()) && sameCoordinates(geometry, now)) continue;
      was.set(feature, this.geometry_.has(feature));
      this.geometry_.add(feature);
    }
    if (was.size === 0) return;
    this.push_(() => {
      for (const [feature, had] of was) {
        feature.setGeometry(before.get(feature));
        if (!had) this.geometry_.delete(feature);
      }
    });
  }

  /**
   * Sets an attribute from the text of a table cell. Returns why the value is
   * not allowed, or null when it was set.
   */
  setAttribute(feature: Feature, field: Field, text: string): string | null {
    const parsed = parseValue(field, text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) return parsed.error;
    const value = parsed as string | number | null;
    const previous = feature.get(field.name);
    if (previous === value) return null;
    const changed = this.attributes_.get(feature) ?? new Set<string>();
    const had = changed.has(field.name);
    changed.add(field.name);
    this.attributes_.set(feature, changed);
    feature.set(field.name, value);
    this.push_(() => {
      feature.set(field.name, previous);
      if (!had) {
        changed.delete(field.name);
        if (changed.size === 0) this.attributes_.delete(feature);
      }
    });
    return null;
  }

  /** Takes back the last edit. */
  undo(): void {
    this.undo_.pop()?.();
    this.changed();
  }

  /** Takes back every unsaved edit. */
  discard(): void {
    while (this.undo_.length) this.undo_.pop()!();
    this.errors_.clear();
    this.changed();
  }

  /** Sends every unsaved edit; succeeded ones are read back from the server (for values it fills in). */
  async save(): Promise<SaveOutcome> {
    const oid = this.info.objectIdField;
    const editable = new Set(this.fields.filter((f) => f.editable).map((f) => f.name));
    const adds = [...this.added_];
    const updates = [...new Set([...this.geometry_, ...this.attributes_.keys()])].filter((f) => !this.added_.has(f) && !this.deleted_.has(f));
    const deletes = [...this.deleted_];
    const outcome: SaveOutcome = { saved: 0, failed: [] };
    if (adds.length + updates.length + deletes.length === 0) return outcome;

    const attributesOf = (f: Feature, names: Iterable<string>) => Object.fromEntries([...names].filter((n) => editable.has(n)).map((n) => [n, f.get(n) ?? null]));
    const result = await applyEdits(this.info, {
      adds: adds.map((f) => ({ geometry: esriGeometry(f.getGeometry()!), attributes: attributesOf(f, Object.keys(f.getProperties())) })),
      updates: updates.map((f) => ({
        attributes: { [oid]: f.get(oid), ...attributesOf(f, this.attributes_.get(f) ?? []) },
        ...(this.geometry_.has(f) ? { geometry: esriGeometry(f.getGeometry()!) } : {}),
      })),
      deletes: deletes.map(([, id]) => id),
    });

    const reread: Array<[Feature, number]> = [];
    const fail = (f: Feature, r: { error?: { description: string } | null } | undefined) => {
      const message = r?.error?.description ?? '理由不明';
      this.errors_.set(f, message);
      outcome.failed.push({ feature: f, message });
    };
    adds.forEach((f, i) => {
      const r = result.addResults[i];
      if (!r?.success || r.objectId === undefined) return fail(f, r);
      f.set(oid, r.objectId);
      f.setId(r.objectId);
      this.added_.delete(f);
      this.forget_(f);
      reread.push([f, r.objectId]);
      outcome.saved++;
    });
    updates.forEach((f, i) => {
      const r = result.updateResults[i];
      if (!r?.success) return fail(f, r);
      this.forget_(f);
      reread.push([f, Number(f.get(oid))]);
      outcome.saved++;
    });
    deletes.forEach(([f], i) => {
      const r = result.deleteResults[i];
      if (!r?.success) return fail(f, r);
      this.deleted_.delete(f);
      this.forget_(f);
      outcome.saved++;
    });
    // What was saved can no longer be undone; failed edits keep their place.
    if (outcome.failed.length === 0) this.undo_.length = 0;

    if (reread.length) {
      const fresh = await queryIds(this.info.url, oid, reread.map(([, id]) => id), this.info.token).catch(() => []);
      const byId = new Map(fresh.map((f) => [f.getId(), f]));
      for (const [f, id] of reread) {
        const server = byId.get(id);
        if (!server) continue;
        const { [server.getGeometryName()]: geometry, ...attributes } = server.getProperties();
        f.setProperties(attributes);
        if (geometry) f.setGeometry(geometry as Geometry);
      }
    }
    this.changed();
    return outcome;
  }

  /** Saved: no longer changed. */
  private forget_(f: Feature): void {
    this.geometry_.delete(f);
    this.attributes_.delete(f);
    this.errors_.delete(f);
  }

  private push_(undo: () => void): void {
    this.undo_.push(undo);
    this.changed();
  }
}

function sameCoordinates(a: Geometry, b: Geometry): boolean {
  const flat = (g: Geometry) => (g as unknown as { getFlatCoordinates?: () => number[] }).getFlatCoordinates?.() ?? [];
  const x = flat(a);
  const y = flat(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The value for a field from the text typed in its cell, or why it is not allowed. */
export function parseValue(field: Field, text: string): string | number | null | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return field.nullable ? null : field.type === 'string' ? '' : { error: `${field.alias} は空にできません` };
  switch (field.type) {
    case 'integer':
    case 'double': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { error: `${field.alias} は数値で入力してください` };
      if (field.type === 'integer' && !Number.isInteger(n)) return { error: `${field.alias} は整数で入力してください` };
      if (field.range && (n < field.range[0] || n > field.range[1])) return { error: `${field.alias} は ${field.range[0]}〜${field.range[1]} の範囲で入力してください` };
      return field.codes ? (field.codes.find((c) => String(c.code) === trimmed)?.code ?? n) : n;
    }
    case 'date': {
      const ms = new Date(trimmed).getTime();
      return Number.isFinite(ms) ? ms : { error: `${field.alias} は日時で入力してください` };
    }
    default: {
      if (field.length && trimmed.length > field.length) return { error: `${field.alias} は ${field.length} 文字以内で入力してください` };
      return field.codes ? (field.codes.find((c) => String(c.code) === trimmed)?.code ?? trimmed) : trimmed;
    }
  }
}
