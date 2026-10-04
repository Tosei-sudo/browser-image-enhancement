/**
 * Unsaved edits of a vector layer: features added, reshaped, moved, deleted
 * and attributes changed, each step undoable, until "save" hands them all
 * to the layer's {@link EditTarget}: an Esri service (one `applyEdits`) or
 * a local file (written again). Features the target refuses stay unsaved,
 * with its reason.
 */
import type Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Observable from 'ol/Observable.js';
import type VectorSource from 'ol/source/Vector.js';
import { applyEdits, esriGeometry, queryIds, type EsriLayerInfo } from './services/esri.js';
import type { Field, ServiceLayer } from './services/index.js';

export interface SaveOutcome {
  saved: number;
  failed: Array<{ feature: Feature | null; message: string }>;
  /** What the target says about where the edits went. */
  note?: string;
}

/** Geometry types a layer can draw, as OpenLayers names them. */
export type DrawableType = 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';

/** The unsaved edits handed to a target. */
export interface Edits {
  adds: Feature[];
  /** Changed features (not added, not deleted): which attributes, and whether the geometry. */
  updates: Array<{ feature: Feature; attributes: string[]; geometry: boolean }>;
  deletes: Feature[];
}

/** Where the edits of a layer go, and what it allows. */
export interface EditTarget {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** The geometry type new features are drawn as; null when any (the toolbar asks). */
  geometryType: DrawableType | null;
  /** Attributes a new feature starts with. */
  template: Record<string, unknown>;
  /** What the "save" button says it does (status line). */
  savedTo: string;
  /** Saves the edits; returns why each refused feature was refused (none: all saved), and a note for the status line. */
  save(edits: Edits): Promise<{ refused?: Map<Feature, string>; note?: string }>;
}

/** Where the edits of a layer go; null when it cannot be edited. */
export function editTargetOf(service: ServiceLayer): EditTarget | null {
  if (service.editTarget) return service.editTarget;
  const { esri, vector } = service;
  if (!esri || !vector || !(esri.canCreate || esri.canUpdate || esri.canDelete)) return null;
  return esriTarget(esri, vector.fields);
}

const esriDrawTypes: Record<string, DrawableType> = {
  esriGeometryPoint: 'Point',
  esriGeometryMultipoint: 'MultiPoint',
  esriGeometryPolyline: 'LineString',
  esriGeometryPolygon: 'Polygon',
};

/** An editable Esri layer: the edits go to the server in one `applyEdits`, and what was saved is read back. */
export function esriTarget(info: EsriLayerInfo, fields: Field[]): EditTarget {
  const oid = info.objectIdField;
  const editable = new Set(fields.filter((f) => f.editable).map((f) => f.name));
  const attributesOf = (f: Feature, names: Iterable<string>) => Object.fromEntries([...names].filter((n) => editable.has(n)).map((n) => [n, f.get(n) ?? null]));
  return {
    canCreate: info.canCreate && !!esriDrawTypes[info.geometryType],
    canUpdate: info.canUpdate,
    canDelete: info.canDelete,
    geometryType: esriDrawTypes[info.geometryType] ?? null,
    template: Object.fromEntries(Object.entries(info.template).filter(([name]) => name !== oid)),
    savedTo: 'サーバー',
    async save({ adds, updates, deletes }) {
      const result = await applyEdits(info, {
        adds: adds.map((f) => ({ geometry: esriGeometry(f.getGeometry()!), attributes: attributesOf(f, Object.keys(f.getProperties())) })),
        updates: updates.map(({ feature: f, attributes, geometry }) => ({
          attributes: { [oid]: f.get(oid), ...attributesOf(f, attributes) },
          ...(geometry ? { geometry: esriGeometry(f.getGeometry()!) } : {}),
        })),
        deletes: deletes.map((f) => Number(f.get(oid))),
      });
      const failed = new Map<Feature, string>();
      const reread: Array<[Feature, number]> = [];
      const check = (f: Feature, r: { success?: boolean; error?: { description: string } | null } | undefined) => {
        if (!r?.success) failed.set(f, r?.error?.description ?? '理由不明');
        return !!r?.success;
      };
      adds.forEach((f, i) => {
        const r = result.addResults[i];
        if (!check(f, r && r.objectId === undefined ? { ...r, success: false } : r)) return;
        f.set(oid, r.objectId);
        f.setId(r.objectId);
        reread.push([f, r.objectId!]);
      });
      updates.forEach(({ feature: f }, i) => {
        if (check(f, result.updateResults[i])) reread.push([f, Number(f.get(oid))]);
      });
      deletes.forEach((f, i) => check(f, result.deleteResults[i]));
      // Values the server fills in (edit tracking, defaults).
      if (reread.length) {
        const fresh = await queryIds(info.url, oid, reread.map(([, id]) => id), info.token).catch(() => []);
        const byId = new Map(fresh.map((f) => [f.getId(), f]));
        for (const [f, id] of reread) {
          const server = byId.get(id);
          if (!server) continue;
          const { [server.getGeometryName()]: geometry, ...attributes } = server.getProperties();
          f.setProperties(attributes);
          if (geometry) f.setGeometry(geometry as Geometry);
        }
      }
      return { refused: failed };
    },
  };
}

/** Fires `change` after every edit, undo, discard and save. */
export class EditSession extends Observable {
  private readonly added_ = new Set<Feature>();
  private readonly deleted_ = new Set<Feature>();
  private readonly geometry_ = new Set<Feature>();
  private readonly attributes_ = new Map<Feature, Set<string>>();
  /**
   * Undo steps, last on top: each takes back its change feature by feature,
   * so a save can drop the part of a step that is on the server now.
   */
  private readonly undo_: Array<Map<Feature, () => void>> = [];
  /** Why the server refused a feature, until it is saved. */
  private readonly errors_ = new Map<Feature, string>();

  constructor(
    readonly target: EditTarget,
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
    return field.editable && (this.added_.has(feature) ? this.target.canCreate : this.target.canUpdate);
  }

  /** A new feature, drawn on the map: it gets the template's attributes. */
  add(feature: Feature): void {
    for (const [name, value] of Object.entries(this.target.template)) feature.set(name, value, true);
    this.source.addFeature(feature);
    this.added_.add(feature);
    this.push_(
      new Map([
        [
          feature,
          () => {
            this.added_.delete(feature);
            this.errors_.delete(feature);
            if (this.source.hasFeature(feature)) this.source.removeFeature(feature);
          },
        ],
      ]),
    );
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
        this.deleted_.add(feature);
        removed.push({ feature, added: false });
      }
    }
    if (removed.length === 0) return;
    this.push_(
      new Map(
        removed.map(({ feature, added }) => [
          feature,
          () => {
            this.source.addFeature(feature);
            if (added) this.added_.add(feature);
            else this.deleted_.delete(feature);
          },
        ]),
      ),
    );
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
    this.push_(
      new Map(
        [...was].map(([feature, had]) => [
          feature,
          () => {
            feature.setGeometry(before.get(feature));
            if (!had) this.geometry_.delete(feature);
          },
        ]),
      ),
    );
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
    this.push_(
      new Map([
        [
          feature,
          () => {
            feature.set(field.name, previous);
            if (!had) {
              changed.delete(field.name);
              if (changed.size === 0) this.attributes_.delete(feature);
            }
          },
        ],
      ]),
    );
    return null;
  }

  /** Takes back the last edit. */
  undo(): void {
    const step = this.undo_.pop();
    if (step) for (const undo of [...step.values()].reverse()) undo();
    this.changed();
  }

  /** Takes back every unsaved edit. */
  discard(): void {
    while (this.undo_.length) for (const undo of [...this.undo_.pop()!.values()].reverse()) undo();
    this.errors_.clear();
    this.changed();
  }

  /** Hands every unsaved edit to the target; what it saved can no longer be undone. */
  async save(): Promise<SaveOutcome> {
    const adds = [...this.added_];
    const updates = [...new Set([...this.geometry_, ...this.attributes_.keys()])]
      .filter((f) => !this.added_.has(f) && !this.deleted_.has(f))
      .map((feature) => ({ feature, attributes: [...(this.attributes_.get(feature) ?? [])], geometry: this.geometry_.has(feature) }));
    const deletes = [...this.deleted_];
    const outcome: SaveOutcome = { saved: 0, failed: [] };
    if (adds.length + updates.length + deletes.length === 0) return outcome;

    const { refused = new Map<Feature, string>(), note } = await this.target.save({ adds, updates, deletes });
    outcome.note = note;
    for (const f of [...adds, ...updates.map((u) => u.feature), ...deletes]) {
      const message = refused.get(f);
      if (message !== undefined) {
        this.errors_.set(f, message);
        outcome.failed.push({ feature: f, message });
        continue;
      }
      this.added_.delete(f);
      this.deleted_.delete(f);
      this.forget_(f);
      outcome.saved++;
    }
    // What was saved can no longer be undone (undoing it would only change the map, not what was saved);
    // the steps of failed edits keep their place.
    const failed = new Set(outcome.failed.map((f) => f.feature));
    for (const step of this.undo_) for (const feature of [...step.keys()]) if (!failed.has(feature)) step.delete(feature);
    for (let i = this.undo_.length - 1; i >= 0; i--) if (this.undo_[i].size === 0) this.undo_.splice(i, 1);
    this.changed();
    return outcome;
  }

  /** Saved: no longer changed. */
  private forget_(f: Feature): void {
    this.geometry_.delete(f);
    this.attributes_.delete(f);
    this.errors_.delete(f);
  }

  private push_(step: Map<Feature, () => void>): void {
    this.undo_.push(step);
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
