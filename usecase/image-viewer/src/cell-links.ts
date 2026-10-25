/**
 * Attribute values that are URLs or file paths, shown as links in the
 * attribute table. A click opens what the value names:
 *
 * - an http(s) URL in a new tab, except what the viewer shows itself
 *   (GeoTIFFs / COGs, Esri ImageServer and MapServer, vector files), which
 *   opens on the map (Ctrl / Shift / middle click still opens a tab);
 * - a local path (`\\nas\img\a.tif`, `Z:\…`, `file://…`, and `/…` paths
 *   under a `pathMappings` prefix) through `pathMappings` and the folders
 *   allowed for them, as the image catalog does (local-paths.ts): images and
 *   vector files open on the map, with the files beside them that go with
 *   them; pictures, PDFs and text open in a new tab.
 */
import { mappingFor, type PathMapping } from './local-paths.js';

/** What a cell's value links to. */
export type CellLink = { kind: 'url'; url: string; viewer: boolean } | { kind: 'path'; path: string; viewer: boolean };

/** Longest value taken as a link. */
const MAX_LENGTH = 4096;

/** Files the viewer opens on the map (not pictures without a place, which open in a tab). */
const VIEWER_FILE = /\.(tiff?|ntf|nitf|nsf|r0|sicd|jp2|j2k|shp|geojson|gpkg|kml|kmz|gpx|fgb|csv|tsv|dt[012]|ivproj)$/i;

/** URLs the viewer opens on the map. */
const VIEWER_URL = /\.(tiff?|geojson|kml|kmz|gpx|fgb|csv)$/i;

/** Esri image and map services (opened as layers). */
const ESRI_RASTER = /\/(ImageServer|MapServer)\/?$/i;

/** Whether `name` (a file name or a URL's path) opens on the map rather than in a tab. */
export function opensInViewer(name: string, url = false): boolean {
  return url ? VIEWER_URL.test(name) || ESRI_RASTER.test(name) : VIEWER_FILE.test(name);
}

/** The link in a cell's value, or null when it is not a URL or a path. `mappings`: config.json's `pathMappings`. */
export function linkOf(value: unknown, mappings: readonly PathMapping[] = []): CellLink | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_LENGTH || [...text].some((c) => c < ' ' || c === '\u007f')) return null;
  if (/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(text)) {
    let path: string;
    try {
      path = new URL(text).pathname;
    } catch {
      return null;
    }
    return { kind: 'url', url: text, viewer: opensInViewer(path, true) };
  }
  const local =
    /^file:\/\/./i.test(text) ||
    /^\\\\[^\\/\s]+[\\/]./.test(text) || // \\server\share\…
    /^[A-Za-z]:[\\/]/.test(text) || // C:\…
    (/^\/[^/]/.test(text) && mappingFor(mappings, text) !== null); // /mnt/… under a pathMappings prefix
  if (!local) return null;
  const name = text.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? '';
  return { kind: 'path', path: text, viewer: opensInViewer(name) };
}

/** MIME types a file opened in a tab may have; others are saved instead, so nothing runs as this site's page (HTML, SVG). */
const TAB_TYPE = /^(image\/(png|jpeg|gif|webp|bmp|avif)|application\/pdf|text\/plain|video\/[\w.+-]+|audio\/[\w.+-]+)$/;

/** MIME types by extension, for files the browser gives no type. */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/plain',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** The type a file is opened with in a tab, or null to save it instead. */
export function tabTypeOf(file: { name: string; type: string }): string | null {
  const type = (file.type || TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] || '').toLowerCase();
  return TAB_TYPE.test(type) ? type : null;
}

export interface CellLinkOptions {
  /** config.json's `pathMappings`. */
  mappings: readonly PathMapping[];
  /** Where a local path leads (LocalPaths.resolve): a URL, files, or null when the person cancelled. */
  resolve: (path: string) => Promise<{ kind: 'url'; url: string } | { kind: 'files'; handles: FileSystemFileHandle[] } | null>;
  /** Opens a URL on the map. */
  openUrl: (url: string) => Promise<void>;
  /** Opens files on the map (the first is the one named, the rest go with it). */
  openFiles: (handles: FileSystemFileHandle[]) => Promise<void>;
  say: (message: string) => void;
}

/** Opens the links of attribute cells. */
export class CellLinks {
  constructor(private readonly options: CellLinkOptions) {}

  /** The link in `value`, or null. */
  linkOf(value: unknown): CellLink | null {
    return linkOf(value, this.options.mappings);
  }

  /** Opens `link` (called from the click, so a new tab is allowed); `tab`: in a new tab even when the viewer could show it. */
  async open(link: CellLink, tab = false): Promise<void> {
    const { say } = this.options;
    try {
      if (link.kind === 'url') {
        if (link.viewer && !tab) await this.openUrl_(link.url);
        else openTab(link.url, say);
        return;
      }
      say(`${link.path} を読み込み中…`);
      const where = await this.options.resolve(link.path);
      if (!where) return say('キャンセル');
      if (where.kind === 'url') {
        if (link.viewer && !tab) await this.openUrl_(where.url);
        else openTab(where.url, say);
        return;
      }
      const [first] = where.handles;
      if (link.viewer && !tab) {
        await this.options.openFiles(where.handles);
        return;
      }
      const file = await first.getFile();
      const type = tabTypeOf(file);
      // Text is taken as UTF-8 (the browser would guess Latin-1).
      const url = URL.createObjectURL(type ? new Blob([file], { type: type === 'text/plain' ? 'text/plain;charset=utf-8' : type }) : file);
      // Kept a while: a PDF viewer reads it again when it is reloaded.
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
      if (type) openTab(url, say, file.name);
      else download(url, file.name, say, 'ブラウザで表示できない種類のファイル');
    } catch (error) {
      say(`${link.kind === 'url' ? link.url : link.path} の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async openUrl_(url: string): Promise<void> {
    this.options.say(`${url} を読み込み中…`);
    await this.options.openUrl(url);
  }
}

/** Opens `url` in a new tab; says so when the browser blocks it. */
function openTab(url: string, say: (message: string) => void, name?: string): void {
  const tab = window.open(url, '_blank');
  if (!tab) {
    // Blocked (the click was too long ago, after a folder was chosen): saved instead, or said.
    if (name) download(url, name, say, '新しいタブがブロックされたため');
    else say(`新しいタブがブロックされたため ${url} は未表示`);
    return;
  }
  tab.opener = null;
  say(`${name ?? url} を新しいタブで表示`);
}

function download(url: string, name: string, say: (message: string) => void, why: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  say(`${name} をダウンロード（${why}）`);
}
