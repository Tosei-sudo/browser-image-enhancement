/**
 * The project file (`.ivproj`): what is open in the viewer, saved as JSON so
 * it opens again as it was — the layers in their order with their
 * visibility, opacity, correction, band assignment and symbol style, the
 * base map and the area shown.
 *
 * Layers are kept by how to open them again, not by their pixels: a COG or a
 * service by its URL, a local file by its name (and size, to tell it from
 * another file of the same name). The files themselves stay where they are;
 * opening the project finds them again through the handles the browser keeps
 * (project.ts), or asks for them. Temporary layers (processing results) are
 * kept whole, since they live nowhere else.
 */
import { colorScales, type ColorClasses, type PipelineJSON } from 'browser-image-enhancement';
import type { LayerBlendMode, LayerColorScale } from 'browser-image-enhancement/openlayers';
import { bboxOf, serviceNames, type Field, type ServiceRef } from './services/index.js';
import { settingsOf } from './services/esri-rules.js';
import type { VectorStyleSpec } from './vector-style.js';
import type { TargetCrs } from './vector-write.js';
import type { ProjectLayout } from './layout.js';
import { readBookmarks, type Bookmark } from './bookmarks.js';
import { readScripts, type SavedScript } from './script/saved.js';
import type { SavedNotes } from './annotations.js';
import type { Georef, GeorefMethod } from './georef.js';

/** The extension of project files. */
export const PROJECT_EXTENSION = '.ivproj';
/** The media type of project files (the PWA's file handler, the save dialog). */
export const PROJECT_TYPE = 'application/x-image-viewer-project+json';
/** The `format` every project file names. */
export const PROJECT_FORMAT = 'browser-image-viewer-project';

/** A local file a layer was opened from. */
export interface FileRef {
  name: string;
  /** Bytes, to tell the file from another of the same name. */
  size: number;
  /** ms since the epoch, as the file said when saved. */
  lastModified: number;
}

/** Files opened together (an image and its .RPB, a Shapefile's parts): they are opened together again. */
export interface FileSetRef {
  files: FileRef[];
  /** Fetched from this URL (a `file` layer of config.json) rather than chosen. */
  url?: string;
}

/** A processing result, kept whole. */
export interface TempLayerRef {
  id: string;
  title: string;
  made: string;
  created: number;
  fields: Field[];
  crs: TargetCrs;
  /** GeoJSON FeatureCollection, in `EPSG:3857`. */
  features: object;
}

/** How a layer opens again. */
export type LayerSource =
  | { kind: 'url'; url: string }
  | { kind: 'service'; ref: ServiceRef }
  | { kind: 'files'; set: number }
  | { kind: 'temp'; layer: TempLayerRef };

/** One layer of a project. */
export interface ProjectLayer {
  type: 'image' | 'service';
  /** The name in the list (a file name, a URL, a layer title). */
  name: string;
  source: LayerSource;
  visible: boolean;
  opacity: number;
  /** The correction (images, and picture layers of services). */
  pipeline?: PipelineJSON;
  /** Bands shown as R, G and B (0-based), for images of more bands. */
  bands?: [number, number, number];
  /** Whether the DRA range was locked. */
  draLocked?: boolean;
  /** The color scale of a one-band image (see colorize-dialog.ts). */
  colorScale?: LayerColorScale;
  /** How an image is laid over the layers under it, when not `normal`. */
  blend?: LayerBlendMode;
  /** Which pixels of an image are transparent, when not the default (`auto` on, no more values; see nodata-dialog.ts). */
  noData?: { auto: boolean; values: number[] };
  /** The projection set in the viewer for an image without one (see georef.ts). */
  georef?: Georef;
  /** Symbols and labels, for vector layers. */
  style?: VectorStyleSpec;
  /** A GeoTIFF used as elevation data. */
  dem?: true;
  /** The definition query (SQL WHERE) of a vector layer: only the features meeting it are shown. */
  query?: string;
  /** The timeline's settings of the layer: whether it follows the window, its time attributes, a typed time. */
  time?: { on: boolean; start?: string | null; end?: string | null; time?: number };
  /**
   * A layer of another program's project (QGIS), which names it its own way:
   * it is the layer of its file set whose name has this in it (a GeoPackage's
   * table), else the first one left. Not saved.
   */
  pick?: string;
  /** Index in the project's `groups` of the group the layer is in. */
  group?: number;
}

/** A group of layers in the list (its layers name it by index). */
export interface ProjectGroup {
  name: string;
  visible: boolean;
  collapsed: boolean;
}

/** The area shown. */
export interface ProjectView {
  projection: string;
  center: [number, number];
  resolution: number;
  rotation: number;
}

/** The 3D view: whether it was open, the camera, and its settings. */
export interface ProjectGlobe {
  open: boolean;
  /** Degrees, metres above the ellipsoid, heading and pitch in degrees. */
  camera: { lon: number; lat: number; height: number; heading: number; pitch: number };
  terrain: boolean;
  exaggeration: number;
  heightMode: 'auto' | 'orthometric' | 'ground' | 'ellipsoid';
  natural: boolean;
  /** 3D Tiles by URL. */
  tilesets: Array<{ url: string; show: boolean }>;
}

/** A project file. */
export interface Project {
  format: typeof PROJECT_FORMAT;
  version: 1;
  /** Stays the same across saves; the browser keeps the files' handles under it. */
  id: string;
  /** ISO time of the save. */
  saved: string;
  /** Build that saved it (for the curious). */
  app?: string;
  baseMap: string;
  view: ProjectView | null;
  fileSets: FileSetRef[];
  /** Top first, as listed. */
  layers: ProjectLayer[];
  /** Index in `layers` of the selected layer. */
  selected: number | null;
  /** Groups of layers, top first. */
  groups?: ProjectGroup[];
  /** The 3D view, once it has been opened. */
  globe?: ProjectGlobe;
  /** The screen: panel sizes, open sections, the timeline and the dashboard. */
  layout?: ProjectLayout;
  /** Named views (bookmarks.ts). */
  bookmarks?: Bookmark[];
  /** Notes drawn on the map (annotations.ts): GeoJSON in `EPSG:3857`. */
  annotations?: SavedNotes;
  /** ArcGIS elevation services used as elevation data, by URL (tokens are not kept). */
  elevationServices?: string[];
  /** The scripts saved in the browser (script-dialog.ts): added to the saved ones when the project opens, never run by it. */
  scripts?: SavedScript[];
}

/** Whether a file name is a project file's. */
export function isProjectName(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_EXTENSION);
}

/** The project's name: the file name without the extension. */
export function projectName(fileName: string): string {
  return isProjectName(fileName) ? fileName.slice(0, -PROJECT_EXTENSION.length) : fileName;
}

/** The project as the text of its file. */
export function writeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Reads the text of a project file. Throws, with a message for the status
 * line, when it is not one; layers that cannot be read are left out (and
 * counted in `skipped`).
 */
export function readProject(text: string): { project: Project; skipped: number } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('プロジェクトファイル以外（JSON として読み込み不可）');
  }
  if (!isObject(json) || json.format !== PROJECT_FORMAT) throw new Error('画像ビューアのプロジェクトファイル以外');
  if (json.version !== 1) throw new Error(`このバージョンのプロジェクトファイル（${String(json.version)}）は読み込み不可。ビューアを更新`);

  const fileSets: FileSetRef[] = Array.isArray(json.fileSets)
    ? json.fileSets.map((s) => ({
        files: isObject(s) && Array.isArray(s.files) ? s.files.filter((f): f is FileRef => isObject(f) && typeof f.name === 'string').map((f) => ({ name: f.name, size: isNumber(f.size) ? f.size : -1, lastModified: isNumber(f.lastModified) ? f.lastModified : 0 })) : [],
        ...(isObject(s) && typeof s.url === 'string' ? { url: s.url } : {}),
      }))
    : [];

  const groups: ProjectGroup[] = Array.isArray(json.groups)
    ? json.groups.map((g) => ({
        name: isObject(g) && typeof g.name === 'string' ? g.name : 'グループ',
        visible: !(isObject(g) && g.visible === false),
        collapsed: isObject(g) && g.collapsed === true,
      }))
    : [];

  let skipped = 0;
  const layers: ProjectLayer[] = [];
  for (const raw of Array.isArray(json.layers) ? json.layers : []) {
    const layer = readLayer(raw, fileSets.length, groups.length);
    if (layer) layers.push(layer);
    else skipped++;
  }

  const v = json.view;
  const view: ProjectView | null =
    isObject(v) && typeof v.projection === 'string' && Array.isArray(v.center) && v.center.length === 2 && v.center.every(isNumber) && isNumber(v.resolution) && v.resolution > 0
      ? { projection: v.projection, center: [v.center[0], v.center[1]], resolution: v.resolution, rotation: isNumber(v.rotation) ? v.rotation : 0 }
      : null;

  const selected = isNumber(json.selected) && Number.isInteger(json.selected) && json.selected >= 0 && json.selected < layers.length ? json.selected : null;
  const globe = readGlobe(json.globe);
  const bookmarks = readBookmarks(json.bookmarks);
  const scripts = readScripts(json.scripts);
  return {
    project: {
      format: PROJECT_FORMAT,
      version: 1,
      id: typeof json.id === 'string' && json.id ? json.id : crypto.randomUUID(),
      saved: typeof json.saved === 'string' ? json.saved : '',
      ...(typeof json.app === 'string' ? { app: json.app } : {}),
      baseMap: typeof json.baseMap === 'string' ? json.baseMap : '',
      view,
      fileSets,
      layers,
      // A layer left out moves the others: keep the selection only when nothing was.
      selected: skipped ? null : selected,
      ...(groups.length ? { groups } : {}),
      ...(globe ? { globe } : {}),
      ...(isObject(json.layout) ? { layout: readLayout(json.layout, skipped > 0) } : {}),
      ...(bookmarks.length ? { bookmarks } : {}),
      ...(scripts.length ? { scripts } : {}),
      ...(Array.isArray(json.elevationServices) && json.elevationServices.some((u) => typeof u === 'string') ? { elevationServices: json.elevationServices.filter((u): u is string => typeof u === 'string') } : {}),
      ...(isObject(json.annotations) && json.annotations.type === 'FeatureCollection' && Array.isArray(json.annotations.features) ? { annotations: json.annotations as unknown as SavedNotes } : {}),
    },
    skipped,
  };
}

function readLayer(raw: unknown, sets: number, groups: number): ProjectLayer | null {
  if (!isObject(raw) || (raw.type !== 'image' && raw.type !== 'service') || typeof raw.name !== 'string' || !isObject(raw.source)) return null;
  const source = readSource(raw.source, sets);
  if (!source) return null;
  const layer: ProjectLayer = {
    type: raw.type,
    name: raw.name,
    source,
    visible: raw.visible !== false,
    opacity: isNumber(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : 1,
  };
  if (isObject(raw.pipeline) && raw.pipeline.version === 1 && Array.isArray(raw.pipeline.ops)) layer.pipeline = raw.pipeline as unknown as PipelineJSON;
  if (Array.isArray(raw.bands) && raw.bands.length === 3 && raw.bands.every((b) => Number.isInteger(b) && (b as number) >= 0)) layer.bands = raw.bands as [number, number, number];
  if (raw.draLocked === true) layer.draLocked = true;
  const scale = readColorScale(raw.colorScale);
  if (scale) layer.colorScale = scale;
  if (typeof raw.blend === 'string' && blendModes.includes(raw.blend as LayerBlendMode)) layer.blend = raw.blend as LayerBlendMode;
  if (isObject(raw.noData) && typeof raw.noData.auto === 'boolean' && Array.isArray(raw.noData.values)) {
    layer.noData = { auto: raw.noData.auto, values: raw.noData.values.filter((v): v is number => isNumber(v)) };
  }
  const georef = readGeoref(raw.georef);
  if (georef && layer.type === 'image') layer.georef = georef;
  if (isObject(raw.style)) layer.style = raw.style as unknown as VectorStyleSpec;
  if (raw.dem === true) layer.dem = true;
  if (typeof raw.query === 'string' && raw.query.trim() && layer.type === 'service') layer.query = raw.query.trim();
  if (isObject(raw.time) && typeof raw.time.on === 'boolean') {
    const t = raw.time;
    const name = (v: unknown) => (typeof v === 'string' ? v : v === null ? null : undefined);
    layer.time = { on: t.on as boolean };
    if (name(t.start) !== undefined) layer.time.start = name(t.start);
    if (name(t.end) !== undefined) layer.time.end = name(t.end);
    if (isNumber(t.time)) layer.time.time = t.time;
  }
  if (Number.isInteger(raw.group) && (raw.group as number) >= 0 && (raw.group as number) < groups) layer.group = raw.group as number;
  return layer;
}

const georefMethods: readonly GeorefMethod[] = ['worldfile', 'aux', 'extent', 'corners', 'keep'];

/** A saved projection: a CRS, six finite numbers and how it was set. */
function readGeoref(raw: unknown): Georef | null {
  if (!isObject(raw) || typeof raw.crs !== 'string' || !raw.crs.trim() || !Array.isArray(raw.transform) || raw.transform.length !== 6 || !raw.transform.every(isNumber)) return null;
  const method = georefMethods.includes(raw.method as GeorefMethod) ? (raw.method as GeorefMethod) : 'extent';
  return { crs: raw.crs, transform: [...raw.transform], method, ...(typeof raw.from === 'string' ? { from: raw.from } : {}) };
}

const blendModes: readonly LayerBlendMode[] = ['normal', 'screen', 'lighten', 'darken', 'multiply', 'difference'];

/** A saved color scale: a preset's name or stops (a position and 3 or 4 numbers each). */
function readColorScale(raw: unknown): LayerColorScale | null {
  if (!isObject(raw)) return null;
  const s = raw.scale;
  const named = typeof s === 'string' && Object.hasOwn(colorScales, s);
  const stops =
    Array.isArray(s) &&
    s.length > 0 &&
    s.every((stop) => Array.isArray(stop) && isNumber(stop[0]) && Array.isArray(stop[1]) && (stop[1].length === 3 || stop[1].length === 4) && stop[1].every(isNumber));
  if (!named && !stops) return null;
  const classes = readColorClasses(raw.classes);
  return {
    scale: s as LayerColorScale['scale'],
    ...(raw.reverse === true ? { reverse: true } : {}),
    ...(raw.fade === true && !classes ? { fade: true } : {}),
    ...(classes ? { classes } : {}),
  };
}

const classMethods = ['equal', 'quantile', 'unique', 'manual'] as const;

/** Saved color classes: a kind and up to 256 classes of a value and 3 or 4 color numbers each (null when unreadable). */
export function readColorClasses(raw: unknown): ColorClasses | null {
  if (!isObject(raw) || (raw.kind !== 'range' && raw.kind !== 'exact') || !Array.isArray(raw.classes)) return null;
  const classes = raw.classes
    .filter((c): c is Record<string, unknown> => isObject(c) && isNumber(c.value) && Array.isArray(c.color) && (c.color.length === 3 || c.color.length === 4) && c.color.every(isNumber))
    .slice(0, 256)
    .map((c) => ({
      value: c.value as number,
      color: (c.color as number[]).map((v) => Math.min(255, Math.max(0, Math.round(v)))),
      ...(typeof c.label === 'string' ? { label: c.label.slice(0, 200) } : {}),
    }));
  if (!classes.length) return null;
  return {
    kind: raw.kind,
    classes,
    ...(isNumber(raw.min) ? { min: raw.min } : {}),
    ...(classMethods.includes(raw.method as never) ? { method: raw.method as ColorClasses['method'] } : {}),
  };
}

const heightModes = ['auto', 'orthometric', 'ground', 'ellipsoid'] as const;

function readGlobe(g: unknown): ProjectGlobe | null {
  if (!isObject(g) || !isObject(g.camera)) return null;
  const c = g.camera;
  if (![c.lon, c.lat, c.height].every(isNumber)) return null;
  return {
    open: g.open === true,
    camera: { lon: c.lon as number, lat: c.lat as number, height: c.height as number, heading: isNumber(c.heading) ? c.heading : 0, pitch: isNumber(c.pitch) ? c.pitch : -90 },
    terrain: g.terrain !== false,
    exaggeration: isNumber(g.exaggeration) ? Math.min(10, Math.max(1, g.exaggeration)) : 1,
    heightMode: heightModes.includes(g.heightMode as never) ? (g.heightMode as ProjectGlobe['heightMode']) : 'auto',
    natural: g.natural !== false,
    tilesets: Array.isArray(g.tilesets)
      ? g.tilesets.filter((t): t is Record<string, unknown> => isObject(t) && typeof t.url === 'string' && /^https?:/i.test(t.url)).map((t) => ({ url: t.url as string, show: t.show !== false }))
      : [],
  };
}

/** The layout part, as far as it can be read; the timeline, the dashboard, the split and the docks check theirs as they take them. */
function readLayout(raw: Record<string, unknown>, layersSkipped: boolean): ProjectLayout {
  const layout: ProjectLayout = {};
  for (const key of ['sideWidth', 'dashboardWidth', 'tableHeight'] as const) if (isNumber(raw[key]) && raw[key] > 0) layout[key] = raw[key];
  if (typeof raw.tableCollapsed === 'boolean') layout.tableCollapsed = raw.tableCollapsed;
  if (isObject(raw.folds)) layout.folds = Object.fromEntries(Object.entries(raw.folds).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
  if (isObject(raw.timeline)) layout.timeline = raw.timeline;
  // The dashboard's layer is an index: not when layers were left out.
  if (isObject(raw.dashboard)) layout.dashboard = layersSkipped ? { ...raw.dashboard, layer: null } : raw.dashboard;
  // The side by side comparison (its panes' layers are indexes too); it checks the rest as it takes it.
  if (isObject(raw.split)) layout.split = (layersSkipped ? { ...raw.split, layers: [] } : raw.split) as unknown as ProjectLayout['split'];
  // Where the panels are (the layout checks it as it takes it).
  if (isObject(raw.dock)) layout.dock = raw.dock as unknown as ProjectLayout['dock'];
  // The kept attribute tables' layers are indexes too.
  if (Array.isArray(raw.tables) && !layersSkipped) {
    layout.tables = raw.tables.filter((t): t is { id: string; layer: number } => isObject(t) && typeof t.id === 'string' && Number.isInteger(t.layer) && (t.layer as number) >= 0);
  }
  return layout;
}

function readSource(s: Record<string, unknown>, sets: number): LayerSource | null {
  switch (s.kind) {
    case 'url':
      return typeof s.url === 'string' ? { kind: 'url', url: s.url } : null;
    case 'service': {
      const r = s.ref;
      if (!isObject(r) || typeof r.url !== 'string' || typeof r.layer !== 'string' || typeof r.kind !== 'string' || !Object.hasOwn(serviceNames, r.kind)) return null;
      const ref: ServiceRef = { kind: r.kind as ServiceRef['kind'], url: r.url, layer: r.layer };
      if (typeof r.matrixSet === 'string') ref.matrixSet = r.matrixSet;
      if (typeof r.format === 'string') ref.format = r.format;
      const settings = settingsOf(r.settings);
      if (settings) ref.settings = settings;
      const bbox = bboxOf(r.bbox);
      if (bbox) ref.bbox = bbox;
      if (typeof r.filter === 'string' && r.filter) ref.filter = r.filter;
      return { kind: 'service', ref };
    }
    case 'files':
      return Number.isInteger(s.set) && (s.set as number) >= 0 && (s.set as number) < sets ? { kind: 'files', set: s.set as number } : null;
    case 'temp': {
      const t = s.layer;
      if (!isObject(t) || typeof t.title !== 'string' || !isObject(t.features) || !isObject(t.crs) || !Array.isArray(t.fields)) return null;
      return {
        kind: 'temp',
        layer: {
          id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
          title: t.title,
          made: typeof t.made === 'string' ? t.made : '',
          created: isNumber(t.created) ? t.created : Date.now(),
          fields: t.fields as Field[],
          crs: t.crs as unknown as TargetCrs,
          features: t.features,
        },
      };
    }
    default:
      return null;
  }
}

/** The file of `files` that is `ref`: the same name, and the same size when one with it is there. */
export function matchFile<F extends { name: string; size: number }>(ref: FileRef, files: readonly F[]): F | undefined {
  const named = files.filter((f) => f.name.toLowerCase() === ref.name.toLowerCase());
  return named.find((f) => f.size === ref.size) ?? named[0];
}

/**
 * Which of the layers opened from one file set are the saved ones: each saved
 * layer takes the first opened layer of the same type and name not yet taken.
 * Returns, in the order of `saved`, the matching opened layer or null.
 */
export function matchLayers<L extends { type: string; name: string }>(saved: ReadonlyArray<{ type: string; name: string; pick?: string }>, opened: readonly L[]): Array<L | null> {
  const free = [...opened];
  return saved.map((s) => {
    let i = free.findIndex((o) => o.type === s.type && o.name === s.name);
    if (i < 0 && s.pick !== undefined) {
      const pick = s.pick.toLowerCase();
      i = pick ? free.findIndex((o) => o.name.toLowerCase().includes(pick)) : -1;
      if (i < 0) i = free.length ? 0 : -1;
    }
    return i < 0 ? null : free.splice(i, 1)[0];
  });
}
