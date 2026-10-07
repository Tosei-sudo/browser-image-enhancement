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
import type { PipelineJSON } from 'browser-image-enhancement';
import { serviceNames, type Field, type ServiceRef } from './services/index.js';
import type { VectorStyleSpec } from './vector-style.js';
import type { TargetCrs } from './vector-write.js';

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
  /** Symbols and labels, for vector layers. */
  style?: VectorStyleSpec;
}

/** The area shown. */
export interface ProjectView {
  projection: string;
  center: [number, number];
  resolution: number;
  rotation: number;
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
    throw new Error('プロジェクトファイルではありません（JSON として読めません）');
  }
  if (!isObject(json) || json.format !== PROJECT_FORMAT) throw new Error('画像ビューアのプロジェクトファイルではありません');
  if (json.version !== 1) throw new Error(`このバージョンのプロジェクトファイル（${String(json.version)}）は読めません。ビューアを更新してください`);

  const fileSets: FileSetRef[] = Array.isArray(json.fileSets)
    ? json.fileSets.map((s) => ({
        files: isObject(s) && Array.isArray(s.files) ? s.files.filter((f): f is FileRef => isObject(f) && typeof f.name === 'string').map((f) => ({ name: f.name, size: isNumber(f.size) ? f.size : -1, lastModified: isNumber(f.lastModified) ? f.lastModified : 0 })) : [],
        ...(isObject(s) && typeof s.url === 'string' ? { url: s.url } : {}),
      }))
    : [];

  let skipped = 0;
  const layers: ProjectLayer[] = [];
  for (const raw of Array.isArray(json.layers) ? json.layers : []) {
    const layer = readLayer(raw, fileSets.length);
    if (layer) layers.push(layer);
    else skipped++;
  }

  const v = json.view;
  const view: ProjectView | null =
    isObject(v) && typeof v.projection === 'string' && Array.isArray(v.center) && v.center.length === 2 && v.center.every(isNumber) && isNumber(v.resolution) && v.resolution > 0
      ? { projection: v.projection, center: [v.center[0], v.center[1]], resolution: v.resolution, rotation: isNumber(v.rotation) ? v.rotation : 0 }
      : null;

  const selected = isNumber(json.selected) && Number.isInteger(json.selected) && json.selected >= 0 && json.selected < layers.length ? json.selected : null;
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
    },
    skipped,
  };
}

function readLayer(raw: unknown, sets: number): ProjectLayer | null {
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
  if (isObject(raw.style)) layer.style = raw.style as unknown as VectorStyleSpec;
  return layer;
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
export function matchLayers<L extends { type: string; name: string }>(saved: ReadonlyArray<{ type: string; name: string }>, opened: readonly L[]): Array<L | null> {
  const free = [...opened];
  return saved.map((s) => {
    const i = free.findIndex((o) => o.type === s.type && o.name === s.name);
    return i < 0 ? null : free.splice(i, 1)[0];
  });
}
