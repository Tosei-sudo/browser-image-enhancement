/**
 * What a script can do in the viewer: the functions behind `viewer.*` and
 * `geo.*` (see sandbox.ts for how they are reached). Each checks what the
 * script gives it, and none hands out anything the script should not have:
 * no URLs or tokens of services, no files beyond what is asked, no DOM.
 *
 * - Layers: the list, features as GeoJSON (longitude / latitude), the selection.
 * - Editing: features added, changed and deleted go into the layer's edit
 *   session (the edit toolbar), as one undo step; nothing reaches a
 *   service or a file until the person presses 「保存」.
 * - New layers: temporary layers kept in the browser, and new rasters (GeoTIFF).
 * - Rasters: size and georeferencing, pixel values of a window, values at points.
 * - Tools: the processing tools (buffer, centroids, points to lines,
 *   Voronoi), the imaging plan, geodesic measures and geometry operations.
 * - Files: GeoJSON, CSV, Shapefile and GeoPackage exports and text files,
 *   handed over as downloads (a few per run).
 * - Everything else a person does (layers shown and ordered, correction,
 *   styles, the view, tool dialogs, opening layers): automation.ts.
 */
import Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type Geometry from 'ol/geom/Geometry.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { createEmpty, extend, intersects as extentsIntersect, isEmpty, type Extent } from 'ol/extent.js';
import { get as getProjection, toLonLat, transform, transformExtent } from 'ol/proj.js';
import TopologyPreservingSimplifier from 'jsts/org/locationtech/jts/simplify/TopologyPreservingSimplifier.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import { rasterToGeoTIFF, type GeoTIFFSamples } from 'browser-image-enhancement/openlayers';
import type { ViewerImage, ViewerLayer, ViewerService } from '../images.js';
import type { Selection } from '../selection.js';
import { asLayerType, type Editor } from '../editor.js';
import { editTargetOf, parseValue, type EditSession } from '../edit-session.js';
import type { Field } from '../services/index.js';
import { geodesicArea, geodesicLength } from '../geodesic.js';
import { aeqd, centerOf, direct, fromLocal, inverse, toLocal, type ProcessingInput, type ProcessingResult } from '../processing/common.js';
import { fromJsts, intersection, toJsts, union } from '../processing/jsts.js';
import { geodesicBuffer } from '../processing/buffer.js';
import { centroids } from '../processing/centroid.js';
import { pointsToLine } from '../processing/points-to-line.js';
import { voronoi } from '../processing/voronoi.js';
import { targetCrs } from '../processing/reproject.js';
import { exportFile, exportStyle, type ExportFormat } from '../export-dialog.js';
import { download } from '../local-edit.js';
import { webMercator, wgs84, type TargetCrs } from '../vector-write.js';
import { place, tiffOf } from '../composite-dialog.js';
import { MAX_TARGETS, planFeatures, startPlan, targetOf } from '../imaging-plan-panel.js';
import type { PlanOptions, PlanTarget, SatelliteSpec } from '../imaging-plan.js';
import type { LonLat } from '../coordinates.js';
import {
  MAX_FEATURES,
  TEXT_TYPES,
  featuresCsv,
  fileName,
  inferFields,
  readFeatures,
  readFields,
  readGeometry,
  scriptId,
  toOlFeatures,
  writeFeatures,
  writeGeometry,
  type ScriptFeatureCollection,
} from './convert.js';
import type { ScriptHandlers } from './sandbox.js';
import { automationHandlers, type AutomationContext } from './automation.js';

/** Most samples (width × height × bands) read or written in one call. */
export const MAX_SAMPLES = 16_777_216;
/** Most points sampled in one call. */
const MAX_POINTS = 10_000;
/** Most downloads in one run. */
const MAX_DOWNLOADS = 20;
/** Largest text file a script may save. */
const MAX_TEXT_FILE = 64 * 1024 * 1024;

export interface ScriptContext extends AutomationContext {
  map: OlMap;
  layers: () => readonly ViewerLayer[];
  selectedLayer: () => ViewerLayer | null;
  selectLayer: (layer: ViewerLayer) => void;
  zoomTo: (layer: ViewerLayer) => Promise<void>;
  selection: Selection;
  editor: Editor;
  /** Adds a temporary layer (kept in the browser) and returns its row. */
  addTempLayer: (result: ProcessingResult, made: string) => Promise<ViewerService | null>;
  /** Opens a GeoTIFF the script made; returns its row. */
  openRaster: (file: File) => Promise<ViewerLayer | null>;
  /** The satellites of the imaging plan (its catalog, or the samples). */
  satellites: () => Promise<SatelliteSpec[]>;
}

/** What the script is told about a layer. */
export interface ScriptLayerInfo {
  id: string;
  name: string;
  /** `vector` features, `table` rows without geometry, `raster` an open image, `picture` a map or tile service. */
  kind: 'vector' | 'table' | 'raster' | 'picture';
  visible: boolean;
  selected: boolean;
  count?: number;
  fields?: Array<{ name: string; alias: string; type: Field['type'] }>;
  geometryType?: string | null;
  /** What edits the layer takes; absent when it cannot be edited. */
  editable?: { add: boolean; update: boolean; delete: boolean };
  /** For a raster: pixels and bands. */
  width?: number;
  height?: number;
  bands?: number;
}

const layerIds = new WeakMap<ViewerLayer, string>();
let nextLayer = 1;

/** The id scripts (and the embedding API, embed.ts) know a layer by. */
export function layerId(layer: ViewerLayer): string {
  let id = layerIds.get(layer);
  if (!id) layerIds.set(layer, (id = `L${nextLayer++}`));
  return id;
}

const geojson = new GeoJSON();

/** A number option, checked. */
function num(value: unknown, name: string, fallback?: number, min = -Infinity, max = Infinity): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new TypeError(`${name} を数値で指定してください`);
    return fallback;
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${name} は数値で指定してください`);
  if (n < min || n > max) throw new RangeError(`${name} は ${min}〜${max} の範囲で指定してください`);
  return n;
}

/** An options object (empty when none). */
function opts(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('オプションはオブジェクトで指定してください');
  return value as Record<string, unknown>;
}

/** A time from a script: a Date, milliseconds or text. */
function time(value: unknown, name: string): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${name} は日時（Date、ミリ秒、または "2026-10-20T09:00" のような文字列）で指定してください`);
  return ms;
}

/** `[west, south, east, north]` in longitude / latitude. */
function lonLatBox(value: unknown, name = 'bbox'): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new TypeError(`${name} は [西, 南, 東, 北]（経緯度）で指定してください`);
  const [w, s, e, n] = value as number[];
  if (w > e || s > n) throw new RangeError(`${name} は [西, 南, 東, 北] の順です`);
  return [w, s, e, n];
}

/** Coordinates of a GeoJSON geometry, without OpenLayers (longitude / latitude as given). */
function rings(geometry: { type: string; coordinates?: unknown; geometries?: unknown[] }): { polygons: LonLat[][][]; lines: LonLat[][]; points: LonLat[] } {
  const out = { polygons: [] as LonLat[][][], lines: [] as LonLat[][], points: [] as LonLat[] };
  const c = geometry.coordinates as never;
  switch (geometry.type) {
    case 'Point':
      out.points.push(c);
      break;
    case 'MultiPoint':
      for (const p of c as LonLat[]) out.points.push(p);
      break;
    case 'LineString':
      out.lines.push(c);
      break;
    case 'MultiLineString':
      out.lines.push(...(c as LonLat[][]));
      break;
    case 'Polygon':
      out.polygons.push(c);
      break;
    case 'MultiPolygon':
      out.polygons.push(...(c as LonLat[][][]));
      break;
    case 'GeometryCollection':
      for (const g of (geometry.geometries ?? []) as Array<{ type: string }>) {
        const r = rings(g);
        out.polygons.push(...r.polygons);
        out.lines.push(...r.lines);
        out.points.push(...r.points);
      }
  }
  return out;
}

/**
 * The functions a script can call, made for one run, and `finish`, called
 * when it ends: its edits of each layer become one undo step.
 */
export function scriptHandlers(ctx: ScriptContext): { handlers: ScriptHandlers; finish: () => void } {
  /** Where each edited layer's undo steps stood before the script's first edit. */
  const marks = new Map<EditSession, number>();
  const projection = () => ctx.map.getView().getProjection().getCode();
  let downloads = 0;
  const count = () => {
    if (++downloads > MAX_DOWNLOADS) throw new Error(`1 回の実行で保存できるファイルは ${MAX_DOWNLOADS} 個までです`);
  };

  /** A layer named by its id, its name or its info object. */
  const layerOf = (ref: unknown): ViewerLayer => {
    const key = typeof ref === 'object' && ref !== null && 'id' in ref ? (ref as { id: unknown }).id : ref;
    if (typeof key !== 'string' || !key) throw new TypeError('レイヤーを id か名前で指定してください（viewer.layers() で一覧できます）');
    const list = ctx.layers();
    const byId = list.find((l) => layerId(l) === key);
    if (byId) return byId;
    const byName = list.filter((l) => l.name === key);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`「${key}」という名前のレイヤーが ${byName.length} 個あります。id で指定してください`);
    throw new Error(`レイヤー「${key}」が見つかりません`);
  };
  const vectorOf = (ref: unknown): ViewerService & { service: { vector: NonNullable<ViewerService['service']['vector']> } } => {
    const layer = layerOf(ref);
    if (layer.type !== 'service' || !layer.service.vector) throw new Error(`${layer.name} はベクターレイヤーではありません`);
    return layer as never;
  };
  const imageOf = (ref: unknown): ViewerImage => {
    const layer = layerOf(ref);
    if (layer.type !== 'image') throw new Error(`${layer.name} は画像（ラスター）レイヤーではありません`);
    return layer;
  };

  const info = (layer: ViewerLayer): ScriptLayerInfo => {
    const base = { id: layerId(layer), name: layer.name, visible: layer.layer.getVisible(), selected: ctx.selectedLayer() === layer };
    if (layer.type === 'image') {
      const tiff = tiffOf(layer);
      return { ...base, kind: 'raster', ...(tiff ? { width: tiff.getWidth(), height: tiff.getHeight(), bands: tiff.getSamplesPerPixel() } : {}) };
    }
    const vector = layer.service.vector;
    if (!vector) return { ...base, kind: 'picture' };
    const target = editTargetOf(layer.service);
    const features = vector.source.getFeatures();
    const types = new Set(features.slice(0, 1000).map((f) => f.getGeometry()?.getType() ?? null));
    return {
      ...base,
      kind: layer.service.tableOnly ? 'table' : 'vector',
      count: features.length,
      fields: vector.fields.map((f) => ({ name: f.name, alias: f.alias, type: f.type })),
      geometryType: target?.geometryType ?? (types.size === 1 ? [...types][0] : null),
      ...(target ? { editable: { add: target.canCreate, update: target.canUpdate, delete: target.canDelete } } : {}),
    };
  };

  /** The features of a layer a script names by id (any not in the layer is an error). */
  const featuresById = (layer: ViewerService, ids: unknown): Feature[] => {
    if (!Array.isArray(ids)) ids = [ids];
    const wanted = (ids as unknown[]).map((v) => (typeof v === 'object' && v !== null && 'id' in v ? (v as { id: unknown }).id : v));
    if (wanted.length > MAX_FEATURES) throw new RangeError(`一度に ${MAX_FEATURES.toLocaleString()} 件までです`);
    const index = new Map(layer.service.vector!.source.getFeatures().map((f) => [scriptId(f), f]));
    return wanted.map((id) => {
      const f = typeof id === 'string' ? index.get(id) : undefined;
      if (!f) throw new Error(`${layer.name} に id「${String(id)}」の地物がありません（viewer.features() の id を使ってください）`);
      return f;
    });
  };

  /** Starts editing `layer` (the edit toolbar shows it) and returns its session. */
  const sessionOf = (layer: ViewerService) => {
    if (!editTargetOf(layer.service)) throw new Error(`${layer.name} は編集できません`);
    if (!ctx.editor.start(layer)) throw new Error(`${layer.name} の編集を始められませんでした（別のレイヤーの未保存の変更を残しました）`);
    const session = ctx.editor.session()!;
    if (!marks.has(session)) marks.set(session, session.steps());
    return session;
  };

  /** A field of `layer` by name; null (with a warning noted) for one it does not have. */
  const fieldIn = (fields: readonly Field[], name: string): Field | null => fields.find((f) => f.name === name) ?? null;

  /** What a script hands a tool: a layer (all, or its selected features) or GeoJSON. */
  const inputOf = (value: unknown, selected: boolean): ProcessingInput => {
    if (typeof value === 'string' || (typeof value === 'object' && value !== null && 'id' in value && !('type' in value))) {
      const layer = vectorOf(value);
      const vector = layer.service.vector;
      const all = vector.source.getFeatures();
      const features = selected ? ctx.selection.list().filter((f) => vector.source.hasFeature(f)) : all;
      return { title: layer.name, features, fields: vector.fields, crs: layer.service.exportCrs ?? layer.service.fileCrs };
    }
    const features = toOlFeatures(readFeatures(value, projection()));
    return { title: 'スクリプト', features, fields: inferFields(features) };
  };

  const resultOut = async (result: ProcessingResult, addLayer: unknown, made: string): Promise<ScriptFeatureCollection & { layer?: string; notes?: string[] }> => {
    const out: ScriptFeatureCollection & { layer?: string; notes?: string[] } = writeFeatures(result.features, projection());
    if (result.notes?.length) out.notes = result.notes;
    if (addLayer) {
      if (typeof addLayer === 'string') result.title = addLayer.slice(0, 200);
      const row = await ctx.addTempLayer(result, made);
      if (row) out.layer = layerId(row);
    }
    return out;
  };

  /** A map geometry from a script's GeoJSON. */
  const geom = (value: unknown) => readGeometry(value, projection());
  const out = (g: Geometry | null) => (g ? writeGeometry(g, projection()) : null);
  /** Two geometries in a local plane near them (metres), for planar operations. */
  const local = (...gs: Geometry[]) => {
    const extent = createEmpty();
    for (const g of gs) extend(extent, g.getExtent());
    const p = aeqd(centerOf(extent));
    return { p, gs: gs.map((g) => toLocal(g, p)) };
  };
  const overlay = (a: unknown, b: unknown, op: 'intersection' | 'difference' | 'symDifference') => {
    const x = toJsts(geom(a));
    const y = toJsts(geom(b));
    if (op === 'intersection') return out(fromJsts(intersection(x, y)));
    return out(fromJsts(op === 'difference' ? OverlayOp.difference(x, y) : OverlayOp.symDifference(x, y)));
  };
  const predicate = (name: 'intersects' | 'contains' | 'within' | 'touches' | 'crosses' | 'overlaps' | 'disjoint' | 'equals') => (a: unknown, b: unknown) =>
    Boolean(toJsts(geom(a))[name === 'equals' ? 'equalsTopo' : name](toJsts(geom(b))));

  const handlers: Record<string, (...args: never[]) => unknown> = {
    // --- Layers ---------------------------------------------------------------------------------------------
    layers: () => ctx.layers().map(info),
    layer: (ref: unknown) => info(layerOf(ref)),
    selectedLayer: () => {
      const layer = ctx.selectedLayer();
      return layer ? info(layer) : null;
    },
    selectLayer: (ref: unknown) => {
      ctx.selectLayer(layerOf(ref));
      return true;
    },
    features: (ref: unknown, options?: unknown) => {
      const o = opts(options);
      const layer = vectorOf(ref);
      const source = layer.service.vector.source;
      let list = o.selected ? ctx.selection.list().filter((f) => source.hasFeature(f)) : source.getFeatures();
      if (o.bbox !== undefined) {
        const box = transformExtent(lonLatBox(o.bbox), 'EPSG:4326', projection());
        list = list.filter((f) => {
          const g = f.getGeometry();
          return g ? extentsIntersect(g.getExtent(), box) && g.intersectsExtent(box) : false;
        });
      }
      const limit = num(o.limit, 'limit', MAX_FEATURES, 0, MAX_FEATURES);
      if (list.length > limit && o.limit === undefined) throw new RangeError(`${layer.name} は ${list.length.toLocaleString()} 件あります。limit か bbox で ${MAX_FEATURES.toLocaleString()} 件以下にしてください`);
      const fields = Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === 'string') : undefined;
      return writeFeatures(list.slice(0, limit), projection(), fields);
    },
    selection: () => {
      const features = ctx.selection.list();
      const layer = ctx.layers().find((l) => l.type === 'service' && features.length && l.service.vector?.source.hasFeature(features[0]));
      return { layer: layer ? layerId(layer) : null, ids: features.map(scriptId) };
    },
    select: (ref: unknown, ids: unknown) => {
      const layer = vectorOf(ref);
      if (ctx.selectedLayer() !== layer) ctx.selectLayer(layer);
      const features = featuresById(layer, ids ?? []);
      ctx.selection.set(features);
      return features.length;
    },
    zoomTo: async (target: unknown) => {
      const view = ctx.map.getView();
      if (Array.isArray(target) && target.length === 4) {
        view.fit(transformExtent(lonLatBox(target, '範囲'), 'EPSG:4326', projection()), { padding: [40, 40, 40, 40], maxZoom: 19 });
      } else if (typeof target === 'string' || (typeof target === 'object' && target !== null && 'id' in target && !('type' in target))) {
        await ctx.zoomTo(layerOf(target));
      } else {
        const extent = createEmpty();
        for (const { geometry } of readFeatures(target, projection())) if (geometry) extend(extent, geometry.getExtent());
        if (isEmpty(extent)) throw new Error('移動先の図形がありません');
        view.fit(extent, { padding: [40, 40, 40, 40], maxZoom: 19 });
      }
      return true;
    },
    view: () => {
      const view = ctx.map.getView();
      const size = ctx.map.getSize();
      const extent = size ? view.calculateExtent(size) : null;
      return {
        center: toLonLat(view.getCenter() ?? [0, 0], projection()),
        zoom: view.getZoom() ?? null,
        rotation: view.getRotation(),
        bbox: extent ? transformExtent(extent, projection(), 'EPSG:4326') : null,
      };
    },

    // --- Editing (into the edit session; saved only by 「保存」) -------------------------------------------------
    addFeatures: (ref: unknown, value: unknown) => {
      const layer = vectorOf(ref);
      const items = readFeatures(value, projection());
      const session = sessionOf(layer);
      const target = session.target;
      if (!target.canCreate) throw new Error(`${layer.name} には地物を追加できません`);
      const fields = layer.service.vector.fields;
      const ignored = new Set<string>();
      // Everything checked first: a refused feature adds nothing.
      const prepared = items.map((item, i) => {
        if (!item.geometry && !layer.service.tableOnly) throw new Error(`${i + 1} 件目にジオメトリがありません`);
        let geometry = item.geometry;
        if (geometry && target.geometryType) {
          geometry = asLayerType(geometry, target.geometryType);
          if (geometry.getType() !== target.geometryType) throw new Error(`${i + 1} 件目: ${layer.name} には ${target.geometryType} しか追加できません（${item.geometry!.getType()} です）`);
        } else if (geometry && !['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'].includes(geometry.getType())) {
          throw new Error(`${i + 1} 件目: ${geometry.getType()} は追加できません`);
        }
        const values: Array<[string, unknown]> = [];
        for (const [name, v] of Object.entries(item.properties)) {
          const field = fieldIn(fields, name);
          if (!field || !field.editable) {
            ignored.add(name);
            continue;
          }
          const text = v === null ? '' : field.type === 'date' && typeof v === 'number' ? new Date(v).toISOString() : String(v);
          const parsed = parseValue(field, text);
          if (typeof parsed === 'object' && parsed !== null) throw new Error(`${i + 1} 件目: ${parsed.error}`);
          values.push([name, parsed]);
        }
        return { geometry, values };
      });
      const added: Feature[] = [];
      session.group(() => {
        for (const { geometry, values } of prepared) {
          const f = new Feature();
          if (geometry) f.setGeometry(geometry);
          session.add(f);
          for (const [name, v] of values) f.set(name, v, true);
          f.changed();
          added.push(f);
        }
      });
      return { ids: added.map(scriptId), pending: session.count(), ...(ignored.size ? { ignored: [...ignored] } : {}) };
    },
    updateFeatures: (ref: unknown, updates: unknown) => {
      const layer = vectorOf(ref);
      const list = Array.isArray(updates) ? updates : [updates];
      if (list.length > MAX_FEATURES) throw new RangeError(`一度に ${MAX_FEATURES.toLocaleString()} 件までです`);
      const features = featuresById(layer, list.map((u) => (u as { id?: unknown })?.id));
      const session = sessionOf(layer);
      const fields = layer.service.vector.fields;
      const ignored = new Set<string>();
      const prepared = list.map((u, i) => {
        const { properties, geometry } = (u ?? {}) as { properties?: unknown; geometry?: unknown };
        const f = features[i];
        const values: Array<[Field, string | number | boolean | null]> = [];
        const props = readFeatures({ type: 'Feature', geometry: null, properties }, projection())[0].properties;
        for (const [name, v] of Object.entries(props)) {
          const field = fieldIn(fields, name);
          if (!field) {
            ignored.add(name);
            continue;
          }
          if (!session.canEdit(f, field)) throw new Error(`${layer.name} の ${field.alias} は変更できません`);
          values.push([field, v]);
        }
        let g: Geometry | null = null;
        if (geometry !== undefined && geometry !== null) {
          if (!session.isAdded(f) && !session.target.canUpdate) throw new Error(`${layer.name} の形状は変更できません`);
          g = geom(geometry);
          const type = session.target.geometryType;
          if (type) {
            g = asLayerType(g, type);
            if (g.getType() !== type) throw new Error(`${i + 1} 件目: ${layer.name} の形状は ${type} です（${g.getType()} は使えません）`);
          }
        }
        return { f, values, g };
      });
      const problems: string[] = [];
      session.group(() => {
        for (const { f, values, g } of prepared) {
          for (const [field, v] of values) {
            const why = session.setValue(f, field, v);
            if (why) problems.push(why);
          }
          if (g) {
            const before = new Map([[f, f.getGeometry()?.clone()]]);
            f.setGeometry(g);
            session.reshaped(before);
          }
        }
      });
      if (problems.length) throw new Error(`${problems.length} 件の値を設定できませんでした: ${problems[0]}（設定できたものは未保存の変更に入っています）`);
      return { updated: prepared.length, pending: session.count(), ...(ignored.size ? { ignored: [...ignored] } : {}) };
    },
    deleteFeatures: (ref: unknown, ids: unknown) => {
      const layer = vectorOf(ref);
      const features = featuresById(layer, ids);
      const session = sessionOf(layer);
      if (!session.target.canDelete && features.some((f) => !session.isAdded(f))) throw new Error(`${layer.name} の地物は削除できません`);
      ctx.selection.remove(features);
      session.group(() => session.delete(features));
      return { deleted: features.length, pending: session.count() };
    },
    pendingEdits: () => {
      const layer = ctx.editor.editing();
      const session = ctx.editor.session();
      return layer && session ? { layer: layerId(layer), name: layer.name, count: session.count() } : null;
    },

    saveEdits: async () => {
      const layer = ctx.editor.editing();
      const session = ctx.editor.session();
      const count = session?.count() ?? 0;
      if (!layer || !session || count === 0) return { saved: 0, failed: [] };
      // A person agrees to every write a script asks for, with what and where it goes.
      if (!confirm(`スクリプトが「${layer.name}」の未保存の変更 ${count} 件を${session.target.savedTo}に保存しようとしています。保存しますか？`)) {
        throw new Error('保存は取り消されました（変更は未保存のまま残っています）');
      }
      const outcome = await ctx.editor.save();
      if (!outcome) throw new Error('ほかの保存が進行中です');
      return { saved: outcome.saved, failed: outcome.failed.map((f) => ({ id: f.feature ? scriptId(f.feature) : null, message: f.message })), ...(outcome.note ? { note: outcome.note } : {}) };
    },

    // --- New layers -------------------------------------------------------------------------------------------
    createLayer: async (name: unknown, value: unknown, options?: unknown) => {
      const o = opts(options);
      if (typeof name !== 'string' || !name.trim()) throw new TypeError('レイヤーの名前を指定してください');
      const features = toOlFeatures(readFeatures(value ?? [], projection()));
      const fields = o.fields !== undefined ? readFields(o.fields) : inferFields(features);
      const row = await ctx.addTempLayer({ title: name.trim().slice(0, 200), features, fields, crs: wgs84 }, `スクリプトで作成（${features.length.toLocaleString()} 件）`);
      if (!row) throw new Error('レイヤーを追加できませんでした');
      return layerId(row);
    },

    // --- Rasters -----------------------------------------------------------------------------------------------
    rasterInfo: (ref: unknown) => {
      const image = imageOf(ref);
      const p = place(image);
      const w = p.tiff.getWidth();
      const h = p.tiff.getHeight();
      const extent: Extent = [p.origin[0] + p.shift[0], p.origin[1] + h * p.resolution[1] + p.shift[1], p.origin[0] + w * p.resolution[0] + p.shift[0], p.origin[1] + p.shift[1]];
      let bbox: number[] | null;
      try {
        bbox = transformExtent(extent, p.projection, 'EPSG:4326', 8);
      } catch {
        bbox = null;
      }
      return {
        width: w,
        height: h,
        bands: p.tiff.getSamplesPerPixel(),
        crs: p.projection.getCode(),
        extent,
        bbox,
        pixelSize: [Math.abs(p.resolution[0]), Math.abs(p.resolution[1])],
        noData: p.tiff.getGDALNoData(),
        bitsPerSample: p.tiff.getBitsPerSample(),
        levels: image.source.getTiffImages()[0]?.length ?? 1,
      };
    },
    readPixels: async (ref: unknown, options?: unknown) => {
      const o = opts(options);
      const image = imageOf(ref);
      const p = place(image);
      const W = p.tiff.getWidth();
      const H = p.tiff.getHeight();
      const spp = p.tiff.getSamplesPerPixel();
      // The window, in full-resolution pixels.
      let win: [number, number, number, number];
      if (o.window !== undefined) {
        const v = o.window;
        if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => Number.isInteger(n))) throw new TypeError('window は [x0, y0, x1, y1]（画素、整数）で指定してください');
        win = [Math.max(0, v[0]), Math.max(0, v[1]), Math.min(W, v[2]), Math.min(H, v[3])];
      } else if (o.bbox !== undefined) {
        const box = lonLatBox(o.bbox);
        const e = transformExtent(box, 'EPSG:4326', p.projection, 8);
        const xs = [e[0], e[2]].map((x) => (x - p.shift[0] - p.origin[0]) / p.resolution[0]);
        const ys = [e[1], e[3]].map((y) => (y - p.shift[1] - p.origin[1]) / p.resolution[1]);
        win = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))), Math.min(W, Math.ceil(Math.max(...xs))), Math.min(H, Math.ceil(Math.max(...ys)))];
      } else {
        win = [0, 0, W, H];
      }
      const ww = win[2] - win[0];
      const wh = win[3] - win[1];
      if (ww <= 0 || wh <= 0) throw new RangeError('範囲が画像の外です');
      const bands = o.bands === undefined ? Array.from({ length: spp }, (_, i) => i) : (Array.isArray(o.bands) ? o.bands : [o.bands]).map((b) => num(b, 'bands', undefined, 0, spp - 1));
      if (!bands.every(Number.isInteger) || bands.length === 0) throw new TypeError('bands は 0 から始まるバンド番号の配列です');
      let width = o.width === undefined ? ww : Math.round(num(o.width, 'width', undefined, 1, 65536));
      let height = o.height === undefined ? wh : Math.round(num(o.height, 'height', undefined, 1, 65536));
      if (o.width !== undefined && o.height === undefined) height = Math.max(1, Math.round((wh * width) / ww));
      if (o.height !== undefined && o.width === undefined) width = Math.max(1, Math.round((ww * height) / wh));
      let reduced = false;
      if (width * height * bands.length > MAX_SAMPLES) {
        const k = Math.sqrt(MAX_SAMPLES / (width * height * bands.length));
        width = Math.max(1, Math.floor(width * k));
        height = Math.max(1, Math.floor(height * k));
        reduced = true;
      }
      // Read from the coarsest level that still has the pixels asked for (the overviews of a COG or an RSET).
      const levels = (image.source.getTiffImages()[0] ?? [p.tiff]) as Array<typeof p.tiff>;
      let level = p.tiff;
      for (const l of levels) if (l.getWidth() >= (W * width) / ww && l.getHeight() >= (H * height) / wh && l.getWidth() < level.getWidth()) level = l;
      const sx = level.getWidth() / W;
      const sy = level.getHeight() / H;
      const lwin = [Math.floor(win[0] * sx), Math.floor(win[1] * sy), Math.max(Math.floor(win[0] * sx) + 1, Math.ceil(win[2] * sx)), Math.max(Math.floor(win[1] * sy) + 1, Math.ceil(win[3] * sy))];
      const rasters = (await level.readRasters({ window: lwin, width, height, samples: bands })) as unknown as ArrayLike<GeoTIFFSamples>;
      const extent: Extent = [
        p.origin[0] + win[0] * p.resolution[0] + p.shift[0],
        p.origin[1] + win[3] * p.resolution[1] + p.shift[1],
        p.origin[0] + win[2] * p.resolution[0] + p.shift[0],
        p.origin[1] + win[1] * p.resolution[1] + p.shift[1],
      ];
      return {
        width,
        height,
        bands: bands.length,
        data: Array.from(rasters),
        window: win,
        crs: p.projection.getCode(),
        extent,
        pixelSize: [(extent[2] - extent[0]) / width, (extent[3] - extent[1]) / height],
        noData: p.tiff.getGDALNoData(),
        ...(reduced ? { reduced: true } : {}),
      };
    },
    sample: async (ref: unknown, points: unknown, options?: unknown) => {
      const o = opts(options);
      const image = imageOf(ref);
      const p = place(image);
      if (!Array.isArray(points)) throw new TypeError('点は [[経度, 緯度], …] で指定してください');
      if (points.length > MAX_POINTS) throw new RangeError(`一度に ${MAX_POINTS.toLocaleString()} 点までです`);
      const spp = p.tiff.getSamplesPerPixel();
      const bands = o.bands === undefined ? Array.from({ length: spp }, (_, i) => i) : (Array.isArray(o.bands) ? o.bands : [o.bands]).map((b) => num(b, 'bands', undefined, 0, spp - 1));
      const values: Array<number[] | null> = [];
      for (const point of points) {
        const lonLat = Array.isArray(point) ? point : (point as { coordinates?: unknown })?.coordinates;
        if (!Array.isArray(lonLat) || typeof lonLat[0] !== 'number' || typeof lonLat[1] !== 'number') throw new TypeError('点は [経度, 緯度] で指定してください');
        const [x, y] = transform([lonLat[0], lonLat[1]], 'EPSG:4326', p.projection);
        const px = Math.floor((x - p.shift[0] - p.origin[0]) / p.resolution[0]);
        const py = Math.floor((y - p.shift[1] - p.origin[1]) / p.resolution[1]);
        if (!(px >= 0 && py >= 0 && px < p.tiff.getWidth() && py < p.tiff.getHeight())) {
          values.push(null);
          continue;
        }
        const r = (await p.tiff.readRasters({ window: [px, py, px + 1, py + 1], samples: bands })) as unknown as ArrayLike<ArrayLike<number>>;
        values.push(Array.from(r, (band) => Number(band[0])));
      }
      return values;
    },
    createRaster: async (name: unknown, raster: unknown) => {
      if (typeof name !== 'string' || !name.trim()) throw new TypeError('ラスターの名前を指定してください');
      const r = opts(raster);
      const width = Math.round(num(r.width, 'width', undefined, 1, 65536));
      const height = Math.round(num(r.height, 'height', undefined, 1, 65536));
      const raw = r.data;
      const bandList: ArrayLike<number>[] = Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' ? (raw as ArrayLike<number>[]) : [raw as ArrayLike<number>];
      if (!bandList.every((b) => b && typeof b === 'object' && typeof b.length === 'number')) throw new TypeError('data はバンドごとの配列（Float32Array など）か、その配列です');
      const n = width * height;
      if (n * bandList.length > MAX_SAMPLES) throw new RangeError(`画素が多すぎます（width × height × バンド数 が ${MAX_SAMPLES.toLocaleString()} まで）`);
      bandList.forEach((b, i) => {
        if (b.length !== n) throw new RangeError(`バンド ${i} の値の数が ${b.length} です（width × height = ${n}）`);
      });
      const first = bandList[0];
      const Type = (ArrayBuffer.isView(first) && !(first instanceof DataView) ? first.constructor : Float32Array) as new (n: number) => GeoTIFFSamples;
      const allowed = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array] as unknown[];
      const data = new (allowed.includes(Type) ? Type : Float32Array)(n * bandList.length);
      const nb = bandList.length;
      for (let b = 0; b < nb; b++) {
        const band = bandList[b];
        for (let i = 0; i < n; i++) data[i * nb + b] = band[i];
      }
      const crs = typeof r.crs === 'string' ? r.crs : 'EPSG:4326';
      const proj = getProjection(crs);
      const code = Number(/^EPSG:(\d+)$/i.exec(crs)?.[1]);
      if (!proj || !Number.isInteger(code)) throw new Error(`座標系 ${crs} は使えません（EPSG:4326 や、読み込んだ画像の crs を指定してください）`);
      const box = r.extent ?? r.bbox;
      if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number' && Number.isFinite(v)) || box[0] >= box[2] || box[1] >= box[3]) {
        throw new TypeError('extent（または bbox）は [最小X, 最小Y, 最大X, 最大Y]（crs の座標）で指定してください');
      }
      const [x0, y0, x1, y1] = box as number[];
      const geographic = proj.getUnits() === 'degrees';
      const noData = r.noData === undefined || r.noData === null ? null : num(r.noData, 'noData');
      const blob = rasterToGeoTIFF(
        {
          width,
          height,
          bands: nb,
          data,
          noData,
          photometric: nb >= 3 ? 2 : 1,
          ...(nb > 3 ? { extraSamples: Array(nb - 3).fill(0) } : nb === 2 ? { extraSamples: [0] } : {}),
          geo: {
            modelPixelScale: [(x1 - x0) / width, (y1 - y0) / height, 0],
            modelTiepoint: [0, 0, 0, x0, y1, 0],
            geoKeyDirectory: [1, 1, 0, 3, 1024, 0, 1, geographic ? 2 : 1, 1025, 0, 1, 1, geographic ? 2048 : 3072, 0, 1, code],
          },
        },
        { statistics: true },
      );
      const file = new File([blob], fileName(name, 'raster', ['tif', 'tiff']), { type: 'image/tiff' });
      const row = await ctx.openRaster(file);
      return row ? layerId(row) : null;
    },

    // --- Tools -------------------------------------------------------------------------------------------------
    runTool: async (name: unknown, input: unknown, options?: unknown) => {
      const o = opts(options);
      const data = inputOf(input, Boolean(o.selected));
      if (data.features.length === 0) throw new Error('入力の地物がありません');
      let result: ProcessingResult;
      let made: string;
      switch (name) {
        case 'buffer': {
          const distance = num(o.distance, 'distance', undefined, -1e7, 1e7);
          const cap = o.cap === 'flat' || o.cap === 'square' ? o.cap : 'round';
          result = geodesicBuffer(data, { distance, dissolve: Boolean(o.dissolve), segments: Math.round(num(o.segments, 'segments', 16, 1, 64)), cap });
          made = `測地線バッファ ${distance} m（${data.title}）`;
          break;
        }
        case 'centroid':
          result = centroids(data, { perPart: Boolean(o.perPart), inside: Boolean(o.inside) });
          made = `重心（${data.title}）`;
          break;
        case 'pointsToLine':
          result = pointsToLine(data, { orderField: typeof o.orderField === 'string' ? o.orderField : null, groupField: typeof o.groupField === 'string' ? o.groupField : null });
          made = `ポイント→ライン（${data.title}）`;
          break;
        case 'voronoi': {
          const clip = o.clip === undefined || o.clip === null ? null : inputOf(o.clip, false).features;
          result = voronoi(data, { keepAttributes: Boolean(o.keepAttributes), margin: num(o.margin, 'margin', 10, 0, 1000), clip });
          made = `ボロノイ（${data.title}）`;
          break;
        }
        default:
          throw new Error(`ツール「${String(name)}」はありません（buffer・centroid・pointsToLine・voronoi）`);
      }
      return resultOut(result, o.addLayer, `${made}・スクリプト`);
    },
    satellites: async () =>
      (await ctx.satellites()).map((s) => ({ name: s.name, id: s.id, source: s.source, sar: s.sar, swath: s.swath, maxOffNadir: s.maxOffNadir, lookSide: s.lookSide })),
    imagingPlan: async (options?: unknown) => {
      const o = opts(options);
      let sats = await ctx.satellites();
      if (o.satellites !== undefined) {
        const names = (Array.isArray(o.satellites) ? o.satellites : [o.satellites]).map(String);
        sats = sats.filter((s) => names.some((n) => s.name === n || s.id === n || s.name.toLowerCase().includes(n.toLowerCase())));
      }
      if (!sats.length) throw new Error('計算する衛星がありません（viewer.satellites() で一覧できます）');
      const proj = projection();
      let targets: PlanTarget[];
      const t = o.target;
      if (Array.isArray(t) && t.length === 2 && t.every((v) => typeof v === 'number')) {
        targets = [{ label: `${t[1]}, ${t[0]}`, center: [t[0], t[1]] as [number, number], points: [] }];
      } else {
        const data = inputOf(t, Boolean(o.selected));
        const features = data.features.filter((f) => f.getGeometry());
        if (!features.length) throw new Error('対象に図形がありません');
        const labelField = typeof o.labelField === 'string' ? o.labelField : null;
        const label = (f: Feature, i: number) => String((labelField ? f.get(labelField) : null) ?? f.get('name') ?? f.get('名称') ?? `${data.title} ${i + 1}`);
        if (o.each === false || features.length === 1) {
          const one = targetOf(features, proj, features.length === 1 ? label(features[0], 0) : data.title);
          targets = one ? [one] : [];
        } else {
          if (features.length > MAX_TARGETS) throw new RangeError(`対象が ${features.length} 件あります。${MAX_TARGETS} 件以下にするか each: false でまとめて計算してください`);
          targets = features.flatMap((f, i) => {
            const one = targetOf([f], proj, label(f, i));
            return one ? [one] : [];
          });
        }
      }
      if (!targets.length) throw new Error('対象に図形がありません');
      const start = o.start === undefined ? Date.now() : time(o.start, 'start');
      const end = o.end !== undefined ? time(o.end, 'end') : start + num(o.days, 'days', 7, 0.01, 60) * 86400000;
      if (end <= start || end - start > 60 * 86400000) throw new RangeError('期間は 60 日以内で、end は start より後にしてください');
      const planOptions: PlanOptions = {
        start,
        end,
        maxOffNadir: o.maxOffNadir === undefined || o.maxOffNadir === null ? null : num(o.maxOffNadir, 'maxOffNadir', undefined, 0, 80),
        daylight: o.daylight === 'none' ? 'none' : 'optical',
        minSunElevation: num(o.minSunElevation, 'minSunElevation', 10, -18, 90),
        now: Date.now(),
        minIncidence: o.minIncidence === undefined || o.minIncidence === null ? null : num(o.minIncidence, 'minIncidence', undefined, 0, 89),
        maxIncidence: o.maxIncidence === undefined || o.maxIncidence === null ? null : num(o.maxIncidence, 'maxIncidence', undefined, 0, 89),
        pass: o.pass === 'ascending' || o.pass === 'descending' ? o.pass : null,
        side: o.side === 'left' || o.side === 'right' ? o.side : null,
      };
      const { result: planned } = startPlan(sats, targets, planOptions);
      const result = await planned;
      if (typeof result === 'string') throw new Error(`撮像計画を計算できませんでした: ${result}`);
      let ops = result.opportunities;
      if (o.firstOnly) {
        const seen = new Set<string>();
        ops = ops.filter((op) => {
          const key = `${op.satellite}:${op.target}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
      const response: Record<string, unknown> = {
        opportunities: ops.map((op) => ({
          time: new Date(op.time).toISOString(),
          satellite: sats[op.satellite].name,
          satelliteId: sats[op.satellite].id,
          target: targets[op.target].label,
          targetIndex: op.target,
          offNadir: round(op.offNadir),
          incidence: round(op.incidence),
          elevation: round(op.elevation),
          side: op.side,
          ascending: op.ascending,
          sunElevation: round(op.sunElevation, 1),
          coverage: round(op.coverage, 3),
          scenes: op.strips * op.frames,
          tleAgeDays: round(op.tleAge, 1),
        })),
        problems: result.problems,
        tooSoon: result.tooSoon,
      };
      if (o.addLayer && ops.length) {
        const layerResult = planFeatures(ops, sats, targets, false);
        if (typeof o.addLayer === 'string') layerResult.title = o.addLayer.slice(0, 200);
        const row = await ctx.addTempLayer(layerResult, `撮像計画（スクリプト、${ops.length} 回）`);
        if (row) response.layer = layerId(row);
      }
      return response;
    },

    // --- Files -------------------------------------------------------------------------------------------------
    export: async (target: unknown, options?: unknown) => {
      const o = opts(options);
      const requested = typeof o.format === 'string' ? o.format.toLowerCase() : null;
      const ext = typeof o.name === 'string' ? /\.([a-z]+)$/i.exec(o.name)?.[1]?.toLowerCase() : undefined;
      const formatOf: Record<string, ExportFormat | 'csv'> = { geojson: 'geojson', json: 'geojson', csv: 'csv', shapefile: 'shapefile', shp: 'shapefile', zip: 'shapefile', geopackage: 'geopackage', gpkg: 'geopackage' };
      const format = formatOf[requested ?? ext ?? 'geojson'];
      if (!format) throw new Error(`形式「${requested ?? ext}」には書き出せません（geojson・csv・shapefile・geopackage）`);
      const data = inputOf(target, Boolean(o.selected));
      const layer = typeof target === 'string' || (typeof target === 'object' && target !== null && 'id' in target && !('type' in target)) ? vectorOf(target) : null;
      count();
      if (format === 'csv') {
        const name = fileName(o.name, data.title, ['csv']);
        download(name, featuresCsv(data.features, data.fields, projection()), 'text/csv');
        return name;
      }
      let crs: TargetCrs = wgs84;
      if (o.crs === 'layer') crs = layer?.service.exportCrs ?? layer?.service.fileCrs ?? wgs84;
      else if (o.crs === 'EPSG:3857') crs = webMercator;
      else if (typeof o.crs === 'string' && o.crs !== 'EPSG:4326') crs = await targetCrs(o.crs);
      const file = await exportFile(typeof o.name === 'string' ? o.name.replace(/\.[a-z]+$/i, '') : data.title, data.features, data.fields, format, crs, layer ? exportStyle(layer) : undefined);
      download(file.name, file.bytes, file.type);
      return file.name;
    },
    saveText: (name: unknown, text: unknown) => {
      if (typeof text !== 'string') throw new TypeError('保存する内容は文字列で渡してください（JSON は JSON.stringify で）');
      if (text.length > MAX_TEXT_FILE) throw new RangeError('内容が大きすぎます（64 MB まで）');
      const file = fileName(name, 'script', Object.keys(TEXT_TYPES));
      count();
      download(file, text, TEXT_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]);
      return file;
    },

    // --- Geometry (GeoJSON in longitude / latitude) -------------------------------------------------------------
    'geo.area': (g: unknown) => {
      const { polygons } = rings(geojson.writeGeometryObject(geom(g), { featureProjection: projection(), dataProjection: 'EPSG:4326' }) as never);
      return polygons.reduce((sum, polygon) => sum + polygon.reduce((s, ring, i) => s + (i === 0 ? 1 : -1) * geodesicArea(ring).area, 0), 0);
    },
    'geo.length': (g: unknown) => {
      const { polygons, lines } = rings(geojson.writeGeometryObject(geom(g), { featureProjection: projection(), dataProjection: 'EPSG:4326' }) as never);
      return lines.reduce((s, l) => s + geodesicLength(l), 0) + polygons.flat().reduce((s, r) => s + geodesicLength(r), 0);
    },
    'geo.distance': (a: unknown, b: unknown) => {
      const x = geom(a);
      const y = geom(b);
      if (x.getType() === 'Point' && y.getType() === 'Point') {
        const p = (g: Geometry) => toLonLat((g as unknown as { getCoordinates(): number[] }).getCoordinates(), projection()) as LonLat;
        return inverse(p(x), p(y)).distance;
      }
      const { gs } = local(x, y);
      return toJsts(gs[0]).distance(toJsts(gs[1])) as number;
    },
    'geo.inverse': (a: unknown, b: unknown) => {
      const point = (v: unknown) => {
        if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') throw new TypeError('点は [経度, 緯度] で指定してください');
        return [v[0], v[1]] as LonLat;
      };
      return inverse(point(a), point(b));
    },
    'geo.direct': (from: unknown, azimuth: unknown, distance: unknown) => {
      if (!Array.isArray(from) || typeof from[0] !== 'number' || typeof from[1] !== 'number') throw new TypeError('点は [経度, 緯度] で指定してください');
      return direct([from[0], from[1]], num(azimuth, '方位角'), num(distance, '距離'));
    },
    'geo.buffer': (g: unknown, distance: unknown, options?: unknown) => {
      const o = opts(options);
      const f = new Feature(geom(g));
      const cap = o.cap === 'flat' || o.cap === 'square' ? o.cap : 'round';
      const result = geodesicBuffer({ title: '', features: [f], fields: [] }, { distance: num(distance, '距離', undefined, -1e7, 1e7), segments: Math.round(num(o.segments, 'segments', 16, 1, 64)), cap });
      return out(result.features[0]?.getGeometry() ?? null);
    },
    'geo.centroid': (g: unknown, options?: unknown) => {
      const result = centroids({ title: '', features: [new Feature(geom(g))], fields: [] }, { inside: Boolean(opts(options).inside) });
      return out(result.features[0]?.getGeometry() ?? null);
    },
    'geo.simplify': (g: unknown, tolerance: unknown) => {
      const { p, gs } = local(geom(g));
      return out(fromLocal(fromJsts(TopologyPreservingSimplifier.simplify(toJsts(gs[0]), num(tolerance, '許容誤差', undefined, 0)))!, p));
    },
    'geo.bbox': (g: unknown) => transformExtent(geom(g).getExtent(), projection(), 'EPSG:4326'),
    'geo.union': (...gs: unknown[]) => {
      const list = gs.length === 1 && Array.isArray(gs[0]) ? (gs[0] as unknown[]) : gs;
      if (list.length > MAX_FEATURES) throw new RangeError('多すぎます');
      return out(fromJsts(union(list.map((g) => toJsts(geom(g))))));
    },
    'geo.intersection': (a: unknown, b: unknown) => overlay(a, b, 'intersection'),
    'geo.difference': (a: unknown, b: unknown) => overlay(a, b, 'difference'),
    'geo.symDifference': (a: unknown, b: unknown) => overlay(a, b, 'symDifference'),
    'geo.intersects': predicate('intersects'),
    'geo.contains': predicate('contains'),
    'geo.within': predicate('within'),
    'geo.touches': predicate('touches'),
    'geo.crosses': predicate('crosses'),
    'geo.overlaps': predicate('overlaps'),
    'geo.disjoint': predicate('disjoint'),
    'geo.equals': predicate('equals'),
    'geo.transform': (g: unknown, from: unknown, to: unknown) => {
      if (typeof from !== 'string' || typeof to !== 'string') throw new TypeError('座標系を "EPSG:6677" のように指定してください');
      if (!getProjection(from) || !getProjection(to)) throw new Error(`座標系 ${getProjection(from) ? to : from} が登録されていません`);
      const o = g as { type?: string };
      if (!o || typeof o !== 'object' || typeof o.type !== 'string') throw new TypeError('GeoJSON のジオメトリを指定してください');
      const geometry = geojson.readGeometry(o.type === 'Feature' ? (g as { geometry: unknown }).geometry : g);
      return geojson.writeGeometryObject(geometry.transform(from, to));
    },
  };
  Object.assign(handlers, automationHandlers(ctx, { layerOf, imageOf, vectorOf, info, layerId, download: count }));
  const finish = () => {
    // Only the session still being edited: an ended one has nothing left to undo.
    for (const [session, from] of marks) if (ctx.editor.session() === session) session.merge(from);
    marks.clear();
  };
  return { handlers: new Map(Object.entries(handlers) as Array<[string, (...args: unknown[]) => unknown]>), finish };
}

