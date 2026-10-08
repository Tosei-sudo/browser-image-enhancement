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
import { transform } from 'ol/proj.js';
import { Pipeline } from 'browser-image-enhancement';
import { dropImageRule, imageRuleOf } from './image-rules.js';
import type { LoadImageControl } from 'browser-image-enhancement/openlayers';
import type { ImageList, ViewerLayer } from './images.js';
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
  type ProjectLayer,
} from './project-file.js';

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
  /** Opens files as if chosen (the viewer's openFiles). */
  openFiles: (files: File[]) => Promise<void>;
  serviceContext: () => OpenContext;
  say: (message: string) => void;
  /** Remembers a project file opened or saved in 「最近」. */
  remember?: (handles: FileSystemFileHandle[]) => void;
  /** Called when the layers have changed (to update the link). */
  onChange?: () => void;
}

interface PermissionHandle extends FileSystemFileHandle {
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

type SaveFilePicker = (options: { suggestedName?: string; id?: string; startIn?: FileSystemHandle; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>;
type OpenFilePicker = (options: { multiple?: boolean; id?: string; startIn?: FileSystemHandle; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle[]>;

const projectTypes = [{ description: '画像ビューアのプロジェクト', accept: { [PROJECT_TYPE]: [PROJECT_EXTENSION] } }];

/** The project of the viewer: what was saved or opened last, and the menu that saves and opens. */
export class ProjectControl {
  private id_: string | null = null;
  private name_: string | null = null;
  private handle_: FileSystemFileHandle | null = null;
  private readonly sets_ = new WeakMap<ViewerLayer, OpenedSet>();
  private readonly handles_ = new ProjectHandles();
  private ready_: Promise<void> = Promise.resolve();
  private busy_ = false;

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
    const projects = files.filter((f) => isProjectName(f.name));
    const rest = files.filter((f) => !isProjectName(f.name));
    if (rest.length) await this.track_({ files: rest, ...(url ? { url } : {}) }, () => this.options.openFiles(rest));
    if (projects.length > 1) this.options.say('プロジェクトは一度に一つだけ開けます。最初の一つを開きます');
    if (projects[0]) await this.openFile(projects[0], handleOf(projects[0]) ?? null);
  }

  /** Runs `open`, and marks the layers it adds as opened from `set`; returns them, top first. */
  private async track_(set: OpenedSet, open: () => Promise<void>): Promise<ViewerLayer[]> {
    const before = new Set(this.options.images.layers());
    await open();
    const added = this.options.images.layers().filter((l) => !before.has(l));
    for (const layer of added) this.sets_.set(layer, set);
    return added;
  }

  /** What is open now, as a project; `left` names the layers a project cannot open again. */
  collect(): { project: Project; left: string[] } {
    const { images, map, baseMap } = this.options;
    const sets: OpenedSet[] = [];
    const left: string[] = [];
    const layers: ProjectLayer[] = [];
    const listed: ViewerLayer[] = [];
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
      const layer: ProjectLayer = { type: l.type, name: l.name, source, visible: l.layer.getVisible(), opacity: l.layer.getOpacity() };
      const correction = l.type === 'image' ? l.source : l.service.correction;
      const pipeline = correction?.getPipeline();
      if (pipeline && pipeline.ops.length) layer.pipeline = pipeline.toJSON();
      if (l.type === 'image') {
        const bands = l.source.getSelect();
        if (bands) layer.bands = [...bands];
      }
      if (correction?.isDraLocked()) layer.draLocked = true;
      if (l.type === 'service' && l.service.style) layer.style = l.service.style.get();
      layers.push(layer);
      listed.push(l);
    }
    const view = map.getView();
    const center = view.getCenter();
    const resolution = view.getResolution();
    const selected = images.selectedLayer();
    const index = selected ? listed.indexOf(selected) : -1;
    const fileSets: FileSetRef[] = sets.map((s) => ({ files: s.files.map(fileRef), ...(s.url ? { url: s.url } : {}) }));
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
      },
      left,
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
    say(left.length ? `${savedAs} に保存しました（${left.join('、')} は保存できません。処理結果の画像は GeoTIFF に書き出してから開いてください）` : `${savedAs} に保存しました`);
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

      const files = await this.findFiles_(project, handle);
      const problems: string[] = [];
      const found = await this.openLayers_(project, files, problems);

      // In the saved order, as they were.
      images.arrange(found.filter((l): l is ViewerLayer => !!l));
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
        if (l.type === 'service' && l.service.style && saved.style) l.service.style.set(normalizeSpec(saved.style, l.service.style.initial));
      });
      await Promise.all(pending);
      this.restoreView_(project);
      // The correction panel shows the selected layer's correction as it is now.
      const selected = project.selected !== null ? found[project.selected] : found.find((l) => l);
      images.select(null);
      images.select(selected ?? images.layers()[0] ?? null);
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
      say(problems.length ? `プロジェクト「${name}」を開きました（開けなかったもの: ${problems.join('、')}）` : `プロジェクト「${name}」を開きました`);
      return true;
    } finally {
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
          found[i] = images.addService(await openRef(source.ref, this.options.serviceContext()));
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
          const added = await this.track_({ files: chosen, ...(set.url ? { url: set.url } : {}) }, () => this.options.openFiles(chosen));
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
