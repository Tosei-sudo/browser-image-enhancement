/**
 * Bookmarks and shareable links ("ブックマーク"): the area shown, its rotation
 * and which layers are visible, kept under a name and brought back with one
 * click. The list lives in the browser and goes into project files too.
 *
 * The view itself is kept in the address as `#view=lat,lon,zoom[,rotation°]`
 * (with the `?service=` / `?url=` / `?base=` the viewer already writes), so
 * a copied link opens on the same place.
 */
import type OlMap from 'ol/Map.js';
import { fromLonLat, toLonLat, transform } from 'ol/proj.js';
import { formatLatLon } from './coordinates.js';
import type { ProjectView } from './project-file.js';

/** A named place to come back to. */
export interface Bookmark {
  id: string;
  name: string;
  view: ProjectView;
  /** Layers by name and whether each was visible; layers of other names are left alone. */
  layers?: Array<[name: string, visible: boolean]>;
}

/** The view written in the address: degrees, a zoom level, degrees clockwise. */
export interface HashView {
  lat: number;
  lon: number;
  zoom: number;
  rotation: number;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** `view=lat,lon,zoom[,rotation]` for the address (no `#`). */
export function writeHashView(v: HashView): string {
  const parts = [round(v.lat, 6), round(v.lon, 6), round(v.zoom, 2)];
  const rotation = round((((v.rotation % 360) + 360) % 360), 1);
  if (rotation && rotation !== 360) parts.push(rotation);
  return `view=${parts.join(',')}`;
}

/** The view of an address's hash (`#view=…`, among other `&`-joined parts), or null. */
export function readHashView(hash: string): HashView | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const text = params.get('view');
  if (!text) return null;
  const parts = text.split(',').map(Number);
  if (parts.length < 3 || parts.length > 4 || !parts.every(Number.isFinite)) return null;
  const [lat, lon, zoom, rotation = 0] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 540 || zoom < 0 || zoom > 30) return null;
  return { lat, lon, zoom, rotation };
}

/** `hash` with its view part replaced by `view` (or removed for null), the other parts kept. */
export function withHashView(hash: string, view: HashView | null): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  params.delete('view');
  const rest = params.toString();
  const parts = [view ? writeHashView(view) : '', rest].filter(Boolean);
  return parts.length ? `#${parts.join('&')}` : '';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The bookmarks of a project file or of the browser's store, as far as they can be read. */
export function readBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const list: Bookmark[] = [];
  for (const b of raw) {
    if (!isObject(b) || typeof b.name !== 'string' || !isObject(b.view)) continue;
    const v = b.view;
    if (typeof v.projection !== 'string' || !Array.isArray(v.center) || v.center.length !== 2 || !v.center.every(isNumber) || !isNumber(v.resolution) || v.resolution <= 0) continue;
    const bookmark: Bookmark = {
      id: typeof b.id === 'string' && b.id ? b.id : crypto.randomUUID(),
      name: b.name,
      view: { projection: v.projection, center: [v.center[0] as number, v.center[1] as number], resolution: v.resolution, rotation: isNumber(v.rotation) ? v.rotation : 0 },
    };
    if (Array.isArray(b.layers)) {
      bookmark.layers = b.layers.filter((l): l is [string, boolean] => Array.isArray(l) && typeof l[0] === 'string' && typeof l[1] === 'boolean').map(([n, on]) => [n, on]);
    }
    list.push(bookmark);
  }
  return list;
}

/** `into` with the bookmarks of `more` it has not got (by id), in order. */
export function mergeBookmarks(into: readonly Bookmark[], more: readonly Bookmark[]): Bookmark[] {
  const ids = new Set(into.map((b) => b.id));
  return [...into, ...more.filter((b) => !ids.has(b.id))];
}

const STORE_KEY = 'image-viewer.bookmarks';

function load(): Bookmark[] {
  try {
    return readBookmarks(JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function store(list: readonly Bookmark[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the list lasts for this page (and the project saved).
  }
}

export interface BookmarkOptions {
  /** The open layers by name, top first, and whether each is shown. */
  visibility: () => Array<[name: string, visible: boolean]>;
  /** Shows or hides the open layers of these names; true when one changed. */
  setVisibility: (visible: ReadonlyMap<string, boolean>) => boolean;
  say: (message: string) => void;
  /** Whether some open layer is a local file, which a link cannot carry. */
  hasLocalFiles?: () => boolean;
}

/**
 * The 「ブックマーク」 menu: add the view, copy the link, and the bookmarks,
 * each with rename and delete. Keeps the address's `#view=` up to date.
 */
export class Bookmarks {
  private list_: Bookmark[] = load();
  private readonly list: HTMLOListElement;
  private readonly empty: HTMLParagraphElement;

  constructor(
    private readonly map: OlMap,
    private readonly element: HTMLElement,
    private readonly options: BookmarkOptions,
  ) {
    const panel = element.querySelector<HTMLElement>('.menu-panel')!;
    const tools = document.createElement('div');
    tools.className = 'point-tools project-tools';
    const add = button('現在の表示を追加', '現在の表示範囲・回転・表示中のレイヤーを名前を付けて保存（M）');
    add.id = 'bookmark-add';
    add.dataset.key = 'M';
    add.dataset.keepOpen = '';
    add.addEventListener('click', () => this.add());
    const copy = button('リンクをコピー', '今の表示範囲とサービスのレイヤーを開くリンクをコピー');
    copy.id = 'bookmark-link';
    copy.addEventListener('click', () => void this.copyLink());
    tools.append(add, copy);
    const heading = document.createElement('p');
    heading.className = 'menu-heading';
    heading.textContent = 'ブックマーク';
    this.list = document.createElement('ol');
    this.list.className = 'bookmark-list';
    this.list.setAttribute('aria-label', 'ブックマーク');
    this.empty = document.createElement('p');
    this.empty.className = 'bookmark-empty';
    this.empty.textContent = 'ブックマークなし';
    panel.append(tools, heading, this.list, this.empty);
    this.render_();

    // The address follows the view.
    map.on('moveend', () => this.updateHash());
  }

  /** The bookmarks, in order. */
  get(): Bookmark[] {
    return this.list_.map((b) => structuredClone(b));
  }

  /** Replaces the bookmarks (a project opened with its own). */
  set(list: readonly Bookmark[]): void {
    this.list_ = list.map((b) => structuredClone(b));
    this.changed_();
  }

  /** Adds the bookmarks of a project the list has not got. */
  merge(list: readonly Bookmark[]): void {
    this.set(mergeBookmarks(this.list_, list));
  }

  /** Bookmarks the view under `name` (else a name to edit: the place's coordinates). */
  add(name?: string): Bookmark | null {
    const view = this.map.getView();
    const center = view.getCenter();
    const resolution = view.getResolution();
    if (!center || !resolution) return null;
    const projection = view.getProjection().getCode();
    const bookmark: Bookmark = {
      id: crypto.randomUUID(),
      name: name ?? formatLatLon(toLonLat(center, projection) as [number, number]),
      view: { projection, center: [center[0], center[1]], resolution, rotation: view.getRotation() },
      layers: this.options.visibility(),
    };
    this.list_.push(bookmark);
    this.changed_();
    this.options.say(`ブックマーク「${bookmark.name}」を追加`);
    if (name === undefined) this.rename_(bookmark.id);
    return bookmark;
  }

  /** Goes to a bookmark: its view, and the visibility of the layers it names. */
  go(id: string): boolean {
    const bookmark = this.list_.find((b) => b.id === id);
    if (!bookmark) return false;
    const view = this.map.getView();
    let center = bookmark.view.center;
    const code = view.getProjection().getCode();
    try {
      if (bookmark.view.projection !== code) center = transform(center, bookmark.view.projection, code) as [number, number];
    } catch {
      this.options.say(`ブックマーク「${bookmark.name}」の座標系（${bookmark.view.projection}）に移動失敗`);
      return false;
    }
    if (bookmark.layers) this.options.setVisibility(new Map(bookmark.layers));
    view.cancelAnimations();
    view.animate({ center, resolution: bookmark.view.resolution, rotation: bookmark.view.rotation, duration: 300 });
    this.options.say(`ブックマーク「${bookmark.name}」へ移動`);
    return true;
  }

  rename(id: string, name: string): void {
    const bookmark = this.list_.find((b) => b.id === id);
    if (!bookmark || !name.trim()) return;
    bookmark.name = name.trim();
    this.changed_();
  }

  remove(id: string): void {
    const bookmark = this.list_.find((b) => b.id === id);
    if (!bookmark) return;
    this.list_ = this.list_.filter((b) => b !== bookmark);
    this.changed_();
    this.options.say(`ブックマーク「${bookmark.name}」を削除`);
  }

  /** Writes the view into the address's `#view=`. */
  updateHash(): void {
    const view = this.map.getView();
    const center = view.getCenter();
    const zoom = view.getZoom();
    if (!center || zoom === undefined) return;
    const [lon, lat] = toLonLat(center, view.getProjection());
    const hash = withHashView(location.hash, { lat, lon, zoom, rotation: (view.getRotation() * 180) / Math.PI });
    if (hash !== location.hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  }

  /** Goes to the view of the address's `#view=`; false when it has none. */
  applyHash(hash = location.hash): boolean {
    const v = readHashView(hash);
    if (!v) return false;
    const view = this.map.getView();
    view.cancelAnimations();
    view.setCenter(fromLonLat([v.lon, v.lat], view.getProjection()));
    view.setZoom(v.zoom);
    view.setRotation((v.rotation * Math.PI) / 180);
    return true;
  }

  /** Copies the address (the view, the base map, URL and service layers). */
  async copyLink(): Promise<string> {
    this.updateHash();
    const link = location.href;
    const note = this.options.hasLocalFiles?.() ? '（ローカルファイルのレイヤーはリンクの対象外）' : '';
    try {
      await navigator.clipboard.writeText(link);
      this.options.say(`リンクをコピー${note}`);
    } catch {
      this.options.say(`リンクのコピーに失敗。アドレス欄からコピー${note}`);
    }
    return link;
  }

  private changed_(): void {
    store(this.list_);
    this.render_();
  }

  private render_(): void {
    this.list.replaceChildren(
      ...this.list_.map((b) => {
        const li = document.createElement('li');
        li.className = 'bookmark';
        li.dataset.id = b.id;
        const go = button(b.name, `${b.name} へ移動`);
        go.className = 'bookmark-go';
        go.addEventListener('click', () => this.go(b.id));
        const rename = button('✎', '名前を変更');
        rename.className = 'bookmark-icon';
        rename.setAttribute('aria-label', `${b.name} の名前を変更`);
        rename.dataset.keepOpen = '';
        rename.addEventListener('click', () => this.rename_(b.id));
        const remove = button('×', '削除');
        remove.className = 'bookmark-icon';
        remove.setAttribute('aria-label', `${b.name} を削除`);
        remove.dataset.keepOpen = '';
        remove.addEventListener('click', () => this.remove(b.id));
        li.append(go, rename, remove);
        return li;
      }),
    );
    this.empty.hidden = this.list_.length > 0;
  }

  /** Turns a bookmark's name into a field: Enter keeps it, Esc or leaving the field drops it. */
  private rename_(id: string): void {
    const li = this.list.querySelector<HTMLLIElement>(`li[data-id="${CSS.escape(id)}"]`);
    const bookmark = this.list_.find((b) => b.id === id);
    if (!li || !bookmark) return;
    const panel = this.element.querySelector<HTMLElement>('.menu-panel')!;
    if (panel.hidden) this.element.querySelector<HTMLButtonElement>('.menu-button')!.click();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = bookmark.name;
    input.className = 'bookmark-name';
    input.setAttribute('aria-label', 'ブックマークの名前');
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      if (keep) this.rename(id, input.value);
      else this.render_();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    li.querySelector('.bookmark-go')!.replaceWith(input);
    input.focus();
    input.select();
  }
}

function button(text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  return b;
}
