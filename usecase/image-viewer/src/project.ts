/**
 * Saving what is open as a project file (`.ivproj`, see project-file.ts) and
 * opening one again: the 「プロジェクト」 menu, Ctrl+S, and project files
 * chosen, dropped or opened from the operating system (the installed app is
 * the handler of `.ivproj` files, see pwa.ts).
 *
 * Local files are found again without asking where the browser can: through
 * the handles kept for the project when it was saved (IndexedDB), else those
 * of 「最近」. Files the browser must be allowed to read again, and files it
 * does not know, are listed in a dialog that asks for them in one click.
 */
import type OlMap from 'ol/Map.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { Pipeline } from 'browser-image-enhancement';
import { dropImageRule, imageRuleOf } from './image-rules.js';
import type { LoadImageControl } from 'browser-image-enhancement/openlayers';
import { groupNameOf, type ImageList, type ViewerImage, type ViewerLayer } from './images.js';
import { isPicture } from './open-files.js';
import type { Georef } from './georef.js';
import type { BaseMapSwitch } from './basemap.js';
import { openRef } from './add-service.js';
import { fetchFile } from './config.js';
import { fileOf, handleOf, hasFileAccess, type RecentFiles } from './recent-files.js';
import { tempLayer, type TempRecord, type TempStore } from './temp-layers.js';
import { normalizeSpec } from './vector-style.js';
import type { OpenContext } from './services/index.js';
import { buildInfo, buildLabel } from './build-info.js';
import {
  isProjectName,
  matchFile,
  matchLayers,
  PROJECT_EXTENSION,
  PROJECT_FORMAT,
  PROJECT_TYPE,
  projectName,
  readProject,
  writeProject,
  type FileRef,
  type FileSetRef,
  type Project,
  type ProjectGlobe,
  type ProjectGroup,
  type ProjectLayer,
} from './project-file.js';
import type { ProjectLayout } from './layout.js';
import { markRow } from './colorize-dialog.js';
import type { Bookmark } from './bookmarks.js';
import type { SavedScript } from './script/saved.js';
import type { SavedNotes } from './annotations.js';
import { isQgisName, qgisText, readQgs, writeQgs } from './qgis-project.js';
import { symbolKindOf } from './style-file.js';
import { projectionOf } from './services/common.js';
import { transform, transformExtent } from 'ol/proj.js';
import { nameList, type StatusBatch } from './status-line.js';

/** Files opened together, as the viewer opened them. */
export interface OpenedSet {
  files: File[];
  /** Fetched from this URL (config.json) rather than chosen. */
  url?: string;
}

export interface ProjectOptions {
  map: OlMap;
  images: ImageList;
  loader: LoadImageControl;
  baseMap: BaseMapSwitch;
  tempStore: TempStore;
  /** The remembered files of 「最近」, searched for a project's files. */
  recent: RecentFiles | null;
  /**
   * Opens files as if chosen (the viewer's openFiles): with `fit` false the
   * view stays where it is, and `onProgress` hears how many of the images are shown.
   */
  openFiles: (files: File[], options?: { fit?: boolean; onProgress?: (done: number, total: number) => void }) => Promise<void>;
  serviceContext: () => OpenContext;
  say: (message: string) => void;
  /** Starts a batch on the status line for many images opened together: their messages are summed up rather than said one by one. */
  beginStatus?: (total: number, label?: string) => StatusBatch;
  /** Remembers a project file opened or saved in 「最近」. */
  remember?: (handles: FileSystemFileHandle[]) => void;
  /** Called when the layers have changed (to update the link). */
  onChange?: () => void;
  /** The 3D view's state to save (null: it has not been opened). */
  globeState?: () => ProjectGlobe | null;
  /** Brings back the 3D view of a project (null: the project has none); resolves to whether 3D is open. */
  restoreGlobe?: (state: ProjectGlobe | null) => Promise<boolean>;
  /** Whether a layer is a GeoTIFF used as elevation data. */
  isDem?: (layer: ViewerLayer) => boolean;
  /** Makes a layer elevation data again. */
  useAsDem?: (layer: ViewerLayer) => Promise<unknown>;
  /** Each layer's timeline settings. */
  layerTime?: { get: (layer: ViewerLayer) => ProjectLayer['time']; set: (layer: ViewerLayer, saved: NonNullable<ProjectLayer['time']>) => void };
  /** The elevation services by URL: saved with the project, and added when it opens. */
  elevationServices?: { get: () => string[]; add: (urls: string[]) => Promise<void> };
  /** The bookmarks: saved with the project, and added to the viewer's when it opens. */
  bookmarks?: { get: () => Bookmark[]; merge: (list: Bookmark[]) => void };
  /** The saved scripts: saved with the project, and added to the browser's when it opens (none is run). */
  scripts?: { get: () => SavedScript[]; add: (list: SavedScript[]) => void };
  /** The notes drawn on the map: saved with the project, and put back (or cleared) when it opens. */
  notes?: { get: () => SavedNotes | null; set: (saved: SavedNotes | null) => void };
  /** The projections set for images without one (georef-dialog.ts): saved, and set again when the project opens. */
  georef?: { get: (layer: ViewerImage) => Georef | null; apply: (layer: ViewerImage, saved: Georef) => Promise<void> };
  /** The screen layout (panels, timeline, dashboard); indexes are of the project's layers. */
  layout?: {
    collect: (indexOf: (listIndex: number) => number) => ProjectLayout;
    apply: (layout: ProjectLayout, listIndexOf: (projectIndex: number) => number) => void;
  };
}

interface PermissionHandle extends FileSystemFileHandle {
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

type SaveFilePicker = (options: { suggestedName?: string; id?: string; startIn?: FileSystemHandle; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>;
type OpenFilePicker = (options: { multiple?: boolean; id?: string; startIn?: FileSystemHandle; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle[]>;

const projectTypes = [{ description: '画像ビューアのプロジェクト', accept: { [PROJECT_TYPE]: [PROJECT_EXTENSION] } }];

/** From this many images opened together, their group starts folded. */
const GROUP_FOLD_ABOVE = 12;

/** The project of the viewer: what was saved or opened last, and the menu that saves and opens. */
export class ProjectControl {
  private id_: string | null = null;
  private name_: string | null = null;
  private handle_: FileSystemFileHandle | null = null;
  private readonly sets_ = new WeakMap<ViewerLayer, OpenedSet>();
  private readonly handles_ = new ProjectHandles();
  private ready_: Promise<void> = Promise.resolve();
  private busy_ = false;
  /** Files opened one set after another (sets dropped while others open wait). */
  private opening_: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProjectOptions) {}

  /** Waits for `ready` (the layers opened at start) before a project replaces them. */
  setReady(ready: Promise<void>): void {
    this.ready_ = ready.catch(() => {});
  }

  /** The project's name (its file name without the extension), null before one is saved or opened. */
  name(): string | null {
    return this.name_;
  }

  /**
   * Opens files the way the viewer does, remembering which layers came from
   * them, so a project can name the files to open again. Project files among
   * them are opened as projects.
   */
  async openFiles(files: File[], url?: string): Promise<void> {
    const qgis = files.find((f) => isQgisName(f.name));
    if (qgis) {
      await this.openQgis(qgis);
      return;
    }
    const projects = files.filter((f) => isProjectName(f.name));
    const rest = files.filter((f) => !isProjectName(f.name));
    if (rest.length) {
      const opening = this.opening_.then(() => this.openTogether_(rest, url));
      this.opening_ = opening.catch(() => {});
      await opening;
    }
    if (projects.length > 1) this.options.say('プロジェクトは一度に一つだけ開けます。最初の一つを開きます');
    if (projects[0]) await this.openFile(projects[0], handleOf(projects[0]) ?? null);
  }

  /**
   * Opens files chosen or dropped together: the layers they make go into a
   * group of their own (from two on); many images are shown as each is
   * ready, with the view fitted to them all rather than to each.
   */
  private async openTogether_(files: File[], url?: string): Promise<void> {
    const { images } = this.options;
    const pictures = files.filter(isPicture).length;
    const many = pictures >= 2;
    // Many images: their group is there at once (folded when they are a lot), saying how far they have got.
    const batch = images.beginBatch(groupNameOf(files.map((f) => f.name)), { group: many, collapsed: pictures > GROUP_FOLD_ABOVE });
    let fitted = false;
    const status = many ? this.options.beginStatus?.(pictures) : undefined;
    const onProgress = (done: number, total: number) => {
      status?.progress(done);
      const group = images.batchGroup();
      if (!group) return;
      images.setGroupNote(group, done < total ? `読み込み中 ${done}/${total}` : null);
      // To the first image at once, to all of them at the end.
      if (!fitted) void images.zoomToGroup(group, 0);
      fitted = true;
    };
    try {
      await this.track_({ files, ...(url ? { url } : {}) }, () => this.options.openFiles(files, many ? { fit: false, onProgress } : {}));
    } finally {
      let said: string | undefined;
      if (batch) {
        const { group, added } = images.endBatch();
        if (many && group) void images.zoomToGroup(group);
        else if (many && added[0]) void images.zoomTo(added[0]);
        if (group && added.length > 2) said = `${added.length} 件のレイヤーをグループ「${group.name}」にまとめて開きました`;
      }
      if (status) status.end(said);
      else if (said) this.options.say(said);
    }
  }

  /**
   * Marks `layer` as opened from `files` (a processing result kept in the
   * browser), so a project names them and opens them again.
   */
  adopt(layer: ViewerLayer, files: File[]): void {
    this.sets_.set(layer, { files });
  }

  /** Runs `open`, and marks the layers it adds as opened from `set`; returns them, top first. */
  private async track_(set: OpenedSet, open: () => Promise<void>): Promise<ViewerLayer[]> {
    const before = new Set(this.options.images.layers());
    await open();
    const added = this.options.images.layers().filter((l) => !before.has(l));
    for (const layer of added) this.sets_.set(layer, set);
    return added;
  }

  /** Chooses a QGIS project (.qgs, .qgz) and opens it. */
  async chooseQgis(): Promise<void> {
    const [file] = await chooseFiles('.qgs,.qgz', false);
    if (file) await this.openQgis(file);
  }

  /**
   * Opens a QGIS project as the viewer's: its layers (asking for local
   * files), styles and extent; what cannot be opened is listed.
   */
  async openQgis(file: File): Promise<boolean> {
    const { say, map } = this.options;
    let read: ReturnType<typeof readQgs>;
    try {
      read = readQgs(await qgisText(file));
    } catch (error) {
      say(`${file.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    read.project.baseMap = this.options.baseMap.get();
    const name = file.name.replace(/\.qg[sz]$/i, '');
    if (!(await this.open(read.project, name))) return false;
    // A QGIS project is not saved over: 「保存」 asks where the .ivproj goes.
    this.handle_ = null;
    if (read.extent) {
      const projection = await projectionOf(read.extent.crs).catch(() => null);
      const view = map.getView();
      try {
        if (!projection) throw new Error();
        view.fit(transformExtent(read.extent.extent, projection, view.getProjection()), { size: map.getSize() });
      } catch {
        read.notes.push(`表示範囲: 座標系 ${read.extent.crs} を読めませんでした`);
      }
    }
    const parts = [`QGIS プロジェクト「${name}」を開きました`];
    if (read.unsupported.length) parts.push(`開けないレイヤー: ${read.unsupported.join('、')}`);
    if (read.notes.length) parts.push(`省いた設定: ${read.notes.join('、')}`);
    say(parts.join('。'));
    return true;
  }

  /** Writes what is open as a QGIS project (.qgs) and downloads it. */
  exportQgis(): void {
    const { map, say } = this.options;
    const { project, left, listed } = this.collect();
    const kinds = listed.map((l) => {
      if (l.type !== 'service' || !l.service.vector) return null;
      const types = new Set(l.service.vector.source.getFeatures().slice(0, 1000).map((f) => symbolKindOf(f.getGeometry()?.getType())));
      return types.size === 1 ? [...types][0] : (types.has('polygon') ? 'polygon' : types.has('line') ? 'line' : types.has('point') ? 'point' : null);
    });
    const size = map.getSize();
    let extent: [number, number, number, number] | null = null;
    try {
      if (size) extent = transformExtent(map.getView().calculateExtent(size), map.getView().getProjection(), 'EPSG:3857') as [number, number, number, number];
    } catch {
      extent = null;
    }
    const title = this.name_ ?? '画像ビューアの表示';
    const text = writeQgs(project, { kinds, extent, title }, left);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.qgs`;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    const files = project.fileSets.some((s) => !s.url);
    say(`${title}.qgs を書き出しました${files ? '（手元のファイルは .qgs と同じフォルダーに置いてください）' : ''}${left.length ? `。QGIS で開けないもの: ${left.join('、')}` : ''}`);
  }

  /** What is open now, as a project; `left` names the layers a project cannot open again, `listed` the layers of the project's. */
  collect(): { project: Project; left: string[]; listed: ViewerLayer[] } {
    const { images, map, baseMap } = this.options;
    const sets: OpenedSet[] = [];
    const left: string[] = [];
    const layers: ProjectLayer[] = [];
    const listed: ViewerLayer[] = [];
    const savedGroups: Array<NonNullable<ReturnType<ImageList['groupOf']>>> = [];
    const geojson = new GeoJSON();
    for (const l of images.layers()) {
      const set = this.sets_.get(l);
      let source: ProjectLayer['source'] | null = null;
      if (l.type === 'service' && l.service.temp) {
        const record = l.service.temp;
        const features = l.service.vector ? geojson.writeFeaturesObject(l.service.vector.source.getFeatures()) : record.features;
        source = { kind: 'temp', layer: { ...record, features } };
      } else if (l.type === 'service' && l.service.ref) {
        source = { kind: 'service', ref: { ...l.service.ref } };
      } else if (set) {
        if (!sets.includes(set)) sets.push(set);
        source = { kind: 'files', set: sets.indexOf(set) };
      } else if (l.type === 'image' && /^https?:\/\//i.test(l.name)) {
        source = { kind: 'url', url: l.name };
      }
      if (!source) {
        left.push(l.name);
        continue;
      }
      const layer: ProjectLayer = { type: l.type, name: l.name, source, visible: images.isVisible(l), opacity: l.layer.getOpacity() };
      const correction = l.type === 'image' ? l.source : l.service.correction;
      const pipeline = correction?.getPipeline();
      if (pipeline && pipeline.ops.length) layer.pipeline = pipeline.toJSON();
      if (l.type === 'image') {
        const bands = l.source.getSelect();
        if (bands) layer.bands = [...bands];
        const noData = l.source.getNoData();
        if (!noData.auto || noData.values.length) layer.noData = noData;
        const georef = this.options.georef?.get(l);
        if (georef) layer.georef = { ...georef, transform: [...georef.transform] };
      }
      if (correction?.isDraLocked()) layer.draLocked = true;
      if (l.type === 'image') {
        const scale = l.layer.getColorScale();
        if (scale) layer.colorScale = scale;
        if (l.layer.getBlendMode() !== 'normal') layer.blend = l.layer.getBlendMode();
      }
      if (l.type === 'service' && l.service.style) layer.style = l.service.style.get();
      if (this.options.isDem?.(l)) layer.dem = true;
      const time = this.options.layerTime?.get(l);
      if (time) layer.time = time;
      const group = images.groupOf(l);
      if (group) {
        if (!savedGroups.includes(group)) savedGroups.push(group);
        layer.group = savedGroups.indexOf(group);
      }
      layers.push(layer);
      listed.push(l);
    }
    const view = map.getView();
    const center = view.getCenter();
    const resolution = view.getResolution();
    const selected = images.selectedLayer();
    const index = selected ? listed.indexOf(selected) : -1;
    const fileSets: FileSetRef[] = sets.map((s) => ({ files: s.files.map(fileRef), ...(s.url ? { url: s.url } : {}) }));
    const globe = this.options.globeState?.() ?? null;
    this.id_ ??= crypto.randomUUID();
    return {
      project: {
        format: PROJECT_FORMAT,
        version: 1,
        id: this.id_,
        saved: new Date().toISOString(),
        ...(buildInfo ? { app: buildLabel(buildInfo) } : {}),
        baseMap: baseMap.get(),
        view: center && resolution ? { projection: view.getProjection().getCode(), center: [center[0], center[1]], resolution, rotation: view.getRotation() } : null,
        fileSets,
        layers,
        selected: index < 0 ? null : index,
        ...(savedGroups.length ? { groups: savedGroups.map((g): ProjectGroup => ({ name: g.name, visible: g.visible, collapsed: g.collapsed })) } : {}),
        ...(globe ? { globe } : {}),
        ...(this.options.bookmarks?.get().length ? { bookmarks: this.options.bookmarks.get() } : {}),
        ...(this.options.scripts?.get().length ? { scripts: this.options.scripts.get() } : {}),
        ...(this.options.elevationServices?.get().length ? { elevationServices: this.options.elevationServices.get() } : {}),
        ...(this.options.notes?.get() ? { annotations: this.options.notes.get()! } : {}),
        ...(this.options.layout ? { layout: this.options.layout.collect((i) => listed.indexOf(images.layers()[i])) } : {}),
      },
      left,
      listed,
    };
  }

  /**
   * Saves the project: over the file it was opened from or saved to last
   * (unless `as`), else where the person chooses, else as a download.
   */
  async save(as = false): Promise<void> {
    const { say } = this.options;
    const { project, left } = this.collect();
    const text = writeProject(project);
    const suggested = `${this.name_ ?? '無題のプロジェクト'}${PROJECT_EXTENSION}`;
    let savedAs: string;
    try {
      if (!as && this.handle_ && (await allowed(this.handle_, 'readwrite'))) {
        await write(this.handle_, text);
        savedAs = this.handle_.name;
      } else if (typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function') {
        const picker = (window as unknown as { showSaveFilePicker: SaveFilePicker }).showSaveFilePicker;
        let handle: FileSystemFileHandle;
        try {
          handle = await picker({ suggestedName: suggested, id: 'image-viewer-project', types: projectTypes, ...(this.handle_ ? { startIn: this.handle_ } : {}) });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          throw error;
        }
        await write(handle, text);
        this.handle_ = handle;
        savedAs = handle.name;
        this.options.remember?.([handle]);
      } else {
        download(text, suggested);
        savedAs = suggested;
      }
    } catch (error) {
      say(`プロジェクトを保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.setName_(projectName(savedAs));
    // The handles of the local files, so the project opens them again without asking where they are.
    const sets = this.options.images.layers().map((l) => this.sets_.get(l)).filter((s): s is OpenedSet => !!s);
    const kept = sets.flatMap((s) => s.files.map((f) => ({ name: f.name, size: f.size, handle: handleOf(f) }))).filter((h): h is KeptHandle => !!h.handle);
    await this.handles_.put(project.id, kept).catch(() => {});
    say(left.length ? `${savedAs} に保存しました（${left.join('、')} は保存できません。このブラウザに保存されていない処理結果の画像は GeoTIFF に書き出してから開いてください）` : `${savedAs} に保存しました`);
  }

  /** Chooses a project file and opens it. */
  async choose(): Promise<void> {
    if (hasFileAccess()) {
      const picker = (window as unknown as { showOpenFilePicker: OpenFilePicker }).showOpenFilePicker;
      let handle: FileSystemFileHandle | undefined;
      try {
        [handle] = await picker({ id: 'image-viewer-project', types: projectTypes });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // Not allowed here (a cross-origin frame): the ordinary chooser.
      }
      if (handle) {
        await this.openFile(await fileOf(handle), handle);
        return;
      }
    }
    const [file] = await chooseFiles(PROJECT_EXTENSION, false);
    if (file) await this.openFile(file, null);
  }

  /** Opens a project file (chosen, dropped, or from the operating system). */
  async openFile(file: File, handle: FileSystemFileHandle | null): Promise<void> {
    let read: ReturnType<typeof readProject>;
    try {
      read = readProject(await file.text());
    } catch (error) {
      this.options.say(`${file.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (handle) this.options.remember?.([handle]);
    await this.open(read.project, projectName(file.name), handle, read.skipped);
  }

  /**
   * Replaces what is open with the project. Open temporary layers the
   * project has stay as they are; others are closed (asking first, since
   * closing them forgets them).
   */
  async open(project: Project, name: string, handle: FileSystemFileHandle | null = null, skipped = 0): Promise<boolean> {
    const { images, say } = this.options;
    if (this.busy_) {
      say('プロジェクトを開いている途中です');
      return false;
    }
    this.busy_ = true;
    let status: StatusBatch | undefined;
    try {
      await this.ready_;
      const keepTemp = new Set(project.layers.flatMap((l) => (l.source.kind === 'temp' ? [l.source.layer.id] : [])));
      const closing = images.layers().filter((l) => !(l.type === 'service' && l.service.temp && keepTemp.has(l.service.temp.id)));
      const temps = closing.filter((l) => l.type === 'service' && l.service.temp).length;
      if (closing.length && !confirm(`開いているレイヤーを閉じて、プロジェクト「${name}」を開きますか？${temps ? `\n（一時レイヤー ${temps} 件はブラウザからも消えます）` : ''}`)) return false;
      for (const l of closing) images.remove(l);

      this.id_ = project.id;
      this.handle_ = handle;
      this.setName_(name);
      this.options.baseMap.set(project.baseMap);
      say(`プロジェクト「${name}」を開いています…`);
      // Messages of the files opening are summed up on the status line, with the problems below.
      status = this.options.beginStatus?.(project.layers.length, `プロジェクト「${name}」を開いています…`);

      const files = await this.findFiles_(project, handle);
      const problems: string[] = [];
      // The list is drawn once a frame as the layers come, and nothing is selected until the end.
      const batch = images.beginBatch(name, { grouping: false });
      let found: Array<ViewerLayer | null>;
      try {
        found = await this.openLayers_(project, files, problems);
      } finally {
        if (batch) images.endBatch();
      }

      // In the saved order, as they were, and in their groups.
      images.arrange(found.filter((l): l is ViewerLayer => !!l));
      for (const [g, saved] of (project.groups ?? []).entries()) {
        const members = found.filter((l, i): l is ViewerLayer => !!l && project.layers[i].group === g);
        if (!members.length) continue;
        const group = images.createGroup(members, saved.name, saved.collapsed);
        if (!saved.visible) images.setGroupVisible(group, false);
      }
      // Projections set in the viewer first: the image is read again, and the settings below go on its new source.
      for (const [i, saved] of project.layers.entries()) {
        const l = found[i];
        if (l?.type !== 'image' || !saved.georef || !this.options.georef) continue;
        const now = this.options.georef.get(l);
        if (now && JSON.stringify(now) === JSON.stringify(saved.georef)) continue;
        await this.options.georef.apply(l, saved.georef).catch((error: unknown) => void problems.push(`${saved.name} の投影（${error instanceof Error ? error.message : String(error)}）`));
      }
      const pending: Array<Promise<void>> = [];
      project.layers.forEach((saved, i) => {
        const l = found[i];
        if (!l) return;
        images.setVisible(l, saved.visible);
        images.setOpacity(l, saved.opacity);
        const correction = l.type === 'image' ? l.source : l.service.correction;
        if (correction && saved.pipeline) {
          try {
            correction.setPipeline(Pipeline.fromJSON(saved.pipeline));
          } catch (error) {
            problems.push(`${saved.name} の補正（${error instanceof Error ? error.message : String(error)}）`);
          }
        }
        // As saved, not as config.json's imageRules start the image.
        const rule = l.type === 'image' ? imageRuleOf(l.source) : undefined;
        if (l.type === 'image') dropImageRule(l.source);
        if (l.type === 'image' && rule?.pipeline && !saved.pipeline) l.source.setPipeline(new Pipeline());
        if (l.type === 'image' && saved.bands) pending.push(l.source.setSelect(saved.bands).catch(() => void problems.push(`${saved.name} のバンド割り当て`)));
        else if (l.type === 'image' && rule?.bands) pending.push(l.source.setSelect(null).catch(() => {}));
        if (l.type === 'image' && (saved.noData || rule?.noData)) pending.push(l.source.setNoData(saved.noData ?? {}).catch(() => void problems.push(`${saved.name} のノーデータ`)));
        if (l.type === 'image' && (saved.colorScale || saved.blend)) {
          l.layer.setColorScale(saved.colorScale ?? null);
          l.layer.setBlendMode(saved.blend ?? 'normal');
          markRow(l);
        }
        if (l.type === 'service' && l.service.style && saved.style) l.service.style.set(normalizeSpec(saved.style, l.service.style.initial));
        if (saved.time) this.options.layerTime?.set(l, saved.time);
      });
      await Promise.all(pending);
      // Elevation services, then GeoTIFFs used as elevation data.
      if (project.elevationServices?.length) await this.options.elevationServices?.add(project.elevationServices);
      for (const [i, saved] of project.layers.entries()) {
        const l = found[i];
        if (l && saved.dem && !this.options.isDem?.(l)) await this.options.useAsDem?.(l);
      }
      // The 3D view as saved; the 2D view is where it was, unless 3D is open (its camera is).
      const threeD = await (this.options.restoreGlobe?.(project.globe ?? null) ?? Promise.resolve(false)).catch((error: unknown) => {
        problems.push(`3D 表示（${error instanceof Error ? error.message : String(error)}）`);
        return false;
      });
      if (!threeD) this.restoreView_(project);
      if (project.bookmarks?.length) this.options.bookmarks?.merge(project.bookmarks);
      if (project.scripts?.length) this.options.scripts?.add(project.scripts);
      this.options.notes?.set(project.annotations ?? null);
      // The correction panel shows the selected layer's correction as it is now.
      const selected = project.selected !== null ? found[project.selected] : found.find((l) => l);
      images.select(null);
      images.select(selected ?? images.layers()[0] ?? null);
      // The screen as it was (an older project, without one: the timeline and the dashboard closed).
      this.options.layout?.apply(project.layout ?? {}, (i) => {
        const l = found[i];
        return l ? images.layers().indexOf(l) : -1;
      });
      // Locked DRA ranges are taken again, of the area saved.
      for (const [i, saved] of project.layers.entries()) {
        const l = found[i];
        const correction = l?.type === 'image' ? l.source : l?.service.correction;
        if (correction && saved.draLocked) void correction.updateDra(this.options.map).then(() => correction.setDraLocked(true));
      }
      this.options.onChange?.();
      const missing = project.layers.filter((_, i) => !found[i]).map((l) => l.name);
      if (skipped) problems.push(`読めないレイヤー ${skipped} 件`);
      if (missing.length) problems.unshift(...missing);
      if (status) status.end(`プロジェクト「${name}」を開きました`, problems);
      else say(problems.length ? `プロジェクト「${name}」を開きました（開けなかったもの: ${nameList(problems)}）` : `プロジェクト「${name}」を開きました`);
      status = undefined;
      return true;
    } finally {
      status?.end();
      this.busy_ = false;
    }
  }

  /** Opens the layers, bottom first; the opened layer of each saved one, in the project's order (null when it did not open). */
  private async openLayers_(project: Project, files: Array<File[] | null>, problems: string[]): Promise<Array<ViewerLayer | null>> {
    const { images, loader, say, tempStore } = this.options;
    const found: Array<ViewerLayer | null> = project.layers.map(() => null);
    const openedSets = new Set<number>();
    const open = images.layers();
    for (let i = project.layers.length - 1; i >= 0; i--) {
      const saved = project.layers[i];
      const source = saved.source;
      try {
        if (source.kind === 'url') {
          const image = await loader.loadUrl(source.url).catch(() => null);
          found[i] = (image && images.find(image)) || null;
        } else if (source.kind === 'service') {
          const opened = await openRef(source.ref, this.options.serviceContext());
          if (opened) found[i] = images.addService(opened);
        } else if (source.kind === 'temp') {
          const kept = open.find((l) => l.type === 'service' && l.service.temp?.id === source.layer.id);
          if (kept) found[i] = kept;
          else {
            const record: TempRecord = structuredClone(source.layer);
            await tempStore.put(record).catch(() => {});
            found[i] = images.addService(tempLayer(record, tempStore));
          }
        } else if (!openedSets.has(source.set)) {
          openedSets.add(source.set);
          const chosen = files[source.set];
          const set = project.fileSets[source.set];
          if (!chosen?.length) continue;
          const added = await this.track_({ files: chosen, ...(set.url ? { url: set.url } : {}) }, () => this.options.openFiles(chosen, { fit: false }));
          // The layers of this set the project has; the others were closed before it was saved.
          const wanted = project.layers.map((l, j) => ({ l, j })).filter(({ l }) => l.source.kind === 'files' && l.source.set === source.set);
          const matched = matchLayers(
            wanted.map(({ l }) => l),
            [...added].reverse(),
          );
          wanted.forEach(({ j }, k) => (found[j] = matched[k]));
          for (const l of added) if (!matched.includes(l)) images.remove(l);
        }
      } catch (error) {
        problems.push(`${saved.name}（${error instanceof Error ? error.message : String(error)}）`);
        say(`${saved.name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return found;
  }

  private restoreView_(project: Project): void {
    const saved = project.view;
    if (!saved) return;
    const view = this.options.map.getView();
    const code = view.getProjection().getCode();
    let center = saved.center;
    try {
      if (saved.projection !== code) center = transform(saved.center, saved.projection, code) as [number, number];
    } catch {
      return;
    }
    view.cancelAnimations();
    view.setRotation(saved.rotation);
    view.setCenter(center);
    view.setResolution(saved.resolution);
  }

  /** The files of each file set: found by their handles, allowed, chosen, or null when they are not to be had. */
  private async findFiles_(project: Project, projectHandle: FileSystemFileHandle | null): Promise<Array<File[] | null>> {
    const sets = project.fileSets;
    const result: Array<Array<File | null>> = sets.map((s) => s.files.map(() => null));
    const kept = await this.handles_.get(project.id).catch(() => []);
    const recent = (await this.options.recent?.list().catch(() => [])) ?? [];
    const recentHandles = recent.flatMap((e) => e.handles);
    const waiting: Waiting[] = [];

    for (const [s, set] of sets.entries()) {
      if (set.url) {
        try {
          const file = await fetchFile(set.url);
          result[s] = set.files.map(() => null);
          result[s][0] = file;
        } catch (error) {
          this.options.say(`${set.url} を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      for (const [f, ref] of set.files.entries()) {
        const candidates = [
          ...kept.filter((k) => k.name === ref.name && (ref.size < 0 || k.size === ref.size)).map((k) => k.handle),
          ...recentHandles.filter((h) => h.name === ref.name),
        ];
        let prompt: PermissionHandle | null = null;
        for (const handle of candidates as PermissionHandle[]) {
          const state = await handle.queryPermission?.({ mode: 'read' }).catch(() => 'denied' as const) ?? 'granted';
          if (state === 'granted') {
            const file = await fileOf(handle).catch(() => null);
            if (file && (ref.size < 0 || file.size === ref.size)) {
              result[s][f] = file;
              break;
            }
          } else if (state === 'prompt') prompt ??= handle;
        }
        if (!result[s][f]) waiting.push({ set: s, index: f, ref, handle: prompt });
      }
    }

    if (waiting.length) await new FilesDialog(waiting, projectHandle).ask((w, file) => (result[w.set][w.index] = file));
    return result.map((files) => {
      const got = files.filter((f): f is File => !!f);
      return got.length ? got : null;
    });
  }

  private setName_(name: string): void {
    this.name_ = name;
    document.title = `${name} - 画像ビューア`;
  }
}

/** A file of a project that is not open yet: its handle needs allowing, or it must be chosen. */
interface Waiting {
  set: number;
  index: number;
  ref: FileRef;
  /** A handle the browser must be allowed to read again. */
  handle: PermissionHandle | null;
}

/**
 * The dialog of a project's files that cannot be opened without asking:
 * 「許可して開く」 allows the known ones in one click, 「ファイルを選ぶ…」
 * finds the others among the files chosen (by name), and 「省いて開く」 opens
 * the project without them.
 */
class FilesDialog {
  private readonly dialog = document.createElement('dialog');
  private readonly list = document.createElement('ul');
  private readonly allow = document.createElement('button');
  private readonly pick = document.createElement('button');
  private readonly skip = document.createElement('button');

  constructor(
    private readonly waiting: Waiting[],
    private readonly projectHandle: FileSystemFileHandle | null,
  ) {
    const d = this.dialog;
    d.className = 'add-service project-files';
    d.setAttribute('aria-labelledby', 'project-files-title');
    const title = document.createElement('h2');
    title.id = 'project-files-title';
    title.textContent = 'プロジェクトのファイル';
    const note = document.createElement('p');
    note.className = 'project-files-note';
    note.textContent = '次のファイルを開くには、読み取りの許可か、ファイルの場所が必要です。';
    this.list.className = 'project-files-list';
    const actions = document.createElement('div');
    actions.className = 'service-actions';
    for (const [b, text] of [
      [this.allow, '許可して開く'],
      [this.pick, 'ファイルを選ぶ…'],
      [this.skip, 'これらを省いて開く'],
    ] as const) {
      b.type = 'button';
      b.textContent = text;
      actions.append(b);
    }
    d.append(title, note, this.list, actions);
    document.body.append(d);
  }

  /** Shows the dialog until every file is had or the rest are skipped; `take` gets each file as it comes. */
  ask(take: (w: Waiting, file: File) => void): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        this.dialog.close();
        this.dialog.remove();
        resolve();
      };
      const update = () => {
        if (!this.waiting.length) return finish();
        this.list.replaceChildren(
          ...this.waiting.map((w) => {
            const li = document.createElement('li');
            const state = document.createElement('span');
            state.className = 'project-file-state';
            state.textContent = w.handle ? '許可が必要' : '場所が不明';
            li.append(w.ref.name, ' ', state);
            return li;
          }),
        );
        this.allow.hidden = !this.waiting.some((w) => w.handle);
      };
      const got = (w: Waiting, file: File) => {
        take(w, file);
        this.waiting.splice(this.waiting.indexOf(w), 1);
      };
      this.allow.addEventListener('click', async () => {
        for (const w of this.waiting.filter((x) => x.handle)) {
          const handle = w.handle!;
          try {
            const state = (await handle.requestPermission?.({ mode: 'read' })) ?? 'granted';
            const file = state === 'granted' ? await fileOf(handle) : null;
            if (file && (w.ref.size < 0 || file.size === w.ref.size)) got(w, file);
            else w.handle = null;
          } catch {
            w.handle = null;
          }
        }
        update();
      });
      this.pick.addEventListener('click', async () => {
        const chosen = await this.choose_();
        for (const w of [...this.waiting]) {
          const file = matchFile(w.ref, chosen);
          if (file) got(w, file);
        }
        update();
      });
      this.skip.addEventListener('click', finish);
      this.dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        finish();
      });
      update();
      if (this.waiting.length) this.dialog.showModal();
    });
  }

  /** Files chosen by the person, with the picker where there is one (it starts in the project's folder). */
  private async choose_(): Promise<File[]> {
    if (hasFileAccess()) {
      const picker = (window as unknown as { showOpenFilePicker: OpenFilePicker }).showOpenFilePicker;
      try {
        const handles = await picker({ multiple: true, id: 'image-viewer', ...(this.projectHandle ? { startIn: this.projectHandle } : {}) });
        return Promise.all(handles.map(fileOf));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return [];
      }
    }
    return chooseFiles('', true);
  }
}

/** The ordinary file chooser; resolves with nothing when it is cancelled. */
function chooseFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function fileRef(file: File): FileRef {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

async function allowed(handle: FileSystemFileHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  const h = handle as PermissionHandle;
  let state = (await h.queryPermission?.({ mode })) ?? 'granted';
  if (state === 'prompt') state = (await h.requestPermission?.({ mode })) ?? 'denied';
  return state === 'granted';
}

async function write(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(new Blob([text], { type: PROJECT_TYPE }));
  await writable.close();
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: PROJECT_TYPE }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A local file of a project, with the handle it can be read through again. */
interface KeptHandle {
  name: string;
  size: number;
  handle: FileSystemFileHandle;
}

/** The handles of each project's local files, by project id, in IndexedDB. */
class ProjectHandles {
  private db_: Promise<IDBDatabase> | null = null;

  async get(id: string): Promise<KeptHandle[]> {
    if (typeof indexedDB === 'undefined') return [];
    const entry = await this.run_<{ id: string; files: KeptHandle[] } | undefined>('readonly', (s) => s.get(id));
    return entry?.files ?? [];
  }

  async put(id: string, files: KeptHandle[]): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    await this.run_('readwrite', (s) => s.put({ id, files, saved: Date.now() }));
  }

  private async run_<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    this.db_ ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('image-viewer-projects', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = (await this.db_).transaction('handles', mode);
    const request = body(tx.objectStore('handles'));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}
