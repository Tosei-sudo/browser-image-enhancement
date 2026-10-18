/**
 * The clipboard and sharing:
 *
 * - Pasting (Ctrl+V anywhere but in a text field, or 「クリップボードから貼り付け」):
 *   shapes in the text (GeoJSON, WKT, KML, coordinates, a table from Excel;
 *   paste.ts reads them) become a temporary layer 「貼り付け」, zoomed to; a
 *   picture (a screenshot) opens as a picture without a projection. A URL is
 *   only opened (as a COG) when the person says so.
 * - Copying: the selected features as GeoJSON or WKT (the table's row menu;
 *   Ctrl+C on the map copies GeoJSON), and the view as a PNG picture.
 * - Sharing: 「共有…」 hands the view's link (and a picture of it) to the
 *   operating system's share sheet; what other apps share to the installed
 *   app (share-target.ts) opens like files chosen or text pasted.
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type Point from 'ol/geom/Point.js';
import type { MenuItem } from './context-menu.js';
import type { ImageList } from './images.js';
import { POINT_ZOOM } from './link-shapes.js';
import { askDialog } from './local-paths.js';
import { featuresToGeoJson, featuresToWkt, PASTE_TITLE, readPastedText, tableShapes, type PastedShapes, type PastedTable } from './paste.js';
import { crsPresets, targetCrs } from './processing/reproject.js';
import type { Selection } from './selection.js';
import { isShareId, SHARE_PARAM, takeShared } from './share-target.js';
import { recordOf, tempLayer, type TempStore } from './temp-layers.js';
import type { TargetCrs } from './vector-write.js';
import { drawView } from './view-export.js';

/** Picture types taken from the clipboard, with the extension the file gets. */
const PICTURE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** Largest picture or file taken from the clipboard (bytes). */
export const MAX_PASTE_FILE = 200 * 1024 * 1024;
/** Most files taken from one paste. */
const MAX_PASTE_FILES = 50;
const TOAST_MS = 5000;

export interface ClipboardOptions {
  images: ImageList;
  selection: Selection;
  tempStore: TempStore;
  say: (message: string) => void;
  /** Opens files as if chosen (pictures, GeoTIFFs, vector files, projects). */
  openFiles: (files: File[]) => Promise<void>;
  /** Opens a URL as a COG (or Esri image service); asked first. */
  openUrl: (url: string) => Promise<void>;
  /** Whether the 3D view is open (the picture of the view is of the 2D map). */
  in3d?: () => boolean;
  /** Writes the view into the address (`#view=`) before it is shared. */
  updateHash?: () => void;
  /** The menu's buttons. */
  buttons?: { paste?: HTMLButtonElement | null; copyView?: HTMLButtonElement | null; share?: HTMLButtonElement | null };
}

/** Whether the event happened while typing (a text field keeps the browser's own copy and paste). */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** Copies text: the async clipboard, else the old way. False when neither works. */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG にできませんでした'))), 'image/png'));
}

export class ClipboardTools {
  private readonly toast_ = document.createElement('div');
  private toastTimer_ = 0;

  constructor(
    private readonly map: OlMap,
    private readonly options: ClipboardOptions,
  ) {
    const toast = this.toast_;
    toast.className = 'clip-toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    (map.getTargetElement() ?? document.body).append(toast);

    const { paste, copyView, share } = options.buttons ?? {};
    paste?.addEventListener('click', () => void this.pasteFromClipboard());
    copyView?.addEventListener('click', () => void this.copyView());
    if (share) {
      share.hidden = typeof navigator.share !== 'function';
      share.addEventListener('click', () => void this.share());
    }

    // Ctrl+V: anywhere but in a text field (or a dialog, whose fields take what they need).
    document.addEventListener('paste', (e) => {
      if (e.defaultPrevented || typing(e.target) || (e.target instanceof Element && e.target.closest('dialog'))) return;
      const data = e.clipboardData;
      if (!data) return;
      const files = [...data.files];
      const text = data.getData('text/plain');
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      if (files.length) void this.takeFiles(files);
      else void this.takeText(text);
    });
    // Ctrl+C on the map (nothing else focused, no text selected): the selected features as GeoJSON.
    document.addEventListener('copy', (e) => {
      if (e.defaultPrevented || !e.clipboardData) return;
      // (The event goes to where the text caret is; what counts is that nothing is focused and no text is selected.)
      const focused = document.activeElement;
      const onMap = !focused || focused === document.body || this.map.getViewport().contains(focused);
      if (!onMap || window.getSelection()?.toString()) return;
      const features = options.selection.list();
      if (!features.length) return;
      const out = featuresToGeoJson(features, this.fields_());
      if ('error' in out) {
        options.say(out.error);
        return;
      }
      e.clipboardData.setData('text/plain', out.text);
      e.preventDefault();
      this.toast(`選択した地物 ${features.length.toLocaleString()} 件を GeoJSON でコピーしました`);
    });
  }

  /** A short message over the map (and in the status line). */
  toast(message: string): void {
    this.options.say(message);
    this.toast_.textContent = message;
    this.toast_.hidden = false;
    clearTimeout(this.toastTimer_);
    this.toastTimer_ = window.setTimeout(() => (this.toast_.hidden = true), TOAST_MS);
  }

  /** 「クリップボードから貼り付け」: a picture or text from the async clipboard. */
  async pasteFromClipboard(): Promise<void> {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      this.toast('このブラウザではクリップボードを読めません（地図の上で Ctrl+V を押してください）');
      return;
    }
    let text = '';
    const files: File[] = [];
    try {
      if (typeof clipboard.read === 'function') {
        for (const item of await clipboard.read()) {
          const picture = item.types.find((t) => t in PICTURE_TYPES);
          if (picture) {
            const blob = await item.getType(picture);
            files.push(new File([blob], `${PASTE_TITLE}.${PICTURE_TYPES[picture]}`, { type: picture }));
          } else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
        }
      } else text = await clipboard.readText();
    } catch {
      this.toast('クリップボードを読めませんでした（ブラウザが許可していません）。地図の上で Ctrl+V を押して貼り付けてください');
      return;
    }
    if (files.length) await this.takeFiles(files);
    else await this.takeText(text);
  }

  /** Pasted files: pictures open as pictures without a projection; other files as if chosen. */
  async takeFiles(files: File[]): Promise<void> {
    const kept = files.slice(0, MAX_PASTE_FILES).filter((f) => f.size <= MAX_PASTE_FILE);
    if (!kept.length) {
      this.toast(`貼り付けたファイルが大きすぎます（${MAX_PASTE_FILE / 1024 / 1024} MB まで）`);
      return;
    }
    // A screenshot has a name like image.png: call it 貼り付け.
    const named = kept.map((f) => (f.type in PICTURE_TYPES && /^image\.\w+$/i.test(f.name) ? new File([f], `${PASTE_TITLE}.${PICTURE_TYPES[f.type]}`, { type: f.type }) : f));
    const pictures = named.filter((f) => f.type in PICTURE_TYPES).length;
    this.toast(pictures === named.length ? `貼り付けた画像を開きます（位置情報なし）` : `貼り付けたファイル ${named.length} 件を開きます`);
    await this.options.openFiles(named);
  }

  /** Pasted (or shared) text: shapes become the temporary layer 「貼り付け」; a URL is opened only when the person says so. */
  async takeText(text: string, from = 'クリップボードから貼り付け'): Promise<void> {
    const pasted = readPastedText(text);
    if (pasted.kind === 'none') {
      this.toast(pasted.message);
      return;
    }
    if (pasted.kind === 'url') {
      const shown = pasted.url.length > 300 ? `${pasted.url.slice(0, 300)}…` : pasted.url;
      const opened = await askDialog()(`次の URL を画像（COG・Esri ImageServer）として開きますか？\n${shown}`, '開く', async () => {
        await this.options.openUrl(pasted.url).catch(() => {});
        return true;
      });
      if (!opened) this.options.say('URL は開きませんでした');
      return;
    }
    let shapes: PastedShapes;
    if (pasted.kind === 'table') {
      const choice = pasted.geographic ? { crs: undefined, x: pasted.x, y: pasted.y } : await askColumns(pasted);
      if (!choice) return void this.options.say('貼り付けをやめました');
      const made = tableShapes(pasted, choice.crs, choice.x, choice.y);
      if (made.kind === 'none') return void this.toast(made.message);
      shapes = made;
    } else shapes = pasted;
    await this.addShapes(shapes, from);
  }

  /** Shapes as the temporary layer 「貼り付け」, zoomed to. */
  async addShapes(shapes: PastedShapes, from: string): Promise<void> {
    const { images, tempStore, say } = this.options;
    const record = recordOf({ title: PASTE_TITLE, features: shapes.features, fields: shapes.fields }, `${from}（${shapes.what}）`);
    await tempStore.put(record).catch((error) => say(`ブラウザに保存できませんでした（このページを開いている間だけ残ります）: ${error instanceof Error ? error.message : String(error)}`));
    const service = tempLayer(record, tempStore);
    const entry = images.addService(service);
    if (shapes.color || shapes.labeled) {
      const spec = service.style!.get();
      if (shapes.color) spec.symbol = { ...spec.symbol, fill: shapes.color, stroke: shapes.color };
      if (shapes.labeled) spec.label = { ...spec.label, field: 'label' };
      service.style!.set(spec);
    }
    // Points alone are shown with their surroundings, not as close as the map goes.
    const pointsOnly = shapes.features.every((f) => ['Point', 'MultiPoint'].includes(f.getGeometry()?.getType() ?? ''));
    const only = shapes.features.length === 1 ? shapes.features[0].getGeometry() : null;
    if (only?.getType() === 'Point') this.map.getView().animate({ center: (only as Point).getCoordinates(), zoom: shapes.zoom ?? POINT_ZOOM, duration: 250 });
    else if (pointsOnly && service.extent) this.map.getView().fit(service.extent, { padding: [40, 40, 40, 40], maxZoom: shapes.zoom ?? POINT_ZOOM, duration: 250 });
    else void images.zoomTo(entry);
    const skipped = shapes.errors.length ? `（${shapes.errors.slice(0, 3).join(' / ')}）` : '';
    this.toast(`${shapes.what}として読み、図形 ${shapes.features.length.toLocaleString()} 個を一時レイヤー「${PASTE_TITLE}」に追加しました${skipped}`);
  }

  /** The row menu's copy items for `features` (the table's selected rows). */
  menuItems(features: Feature[]): MenuItem[] {
    const n = features.length;
    const several = n > 1 ? `選択中の ${n.toLocaleString()} 件を ` : '';
    return [
      { label: `${several}GeoJSON でコピー`, run: () => void this.copyGeoJson(features) },
      { label: `${several}WKT でコピー`, run: () => void this.copyWkt(features) },
    ];
  }

  /** Copies `features` as a GeoJSON FeatureCollection in WGS 84. */
  async copyGeoJson(features: Feature[]): Promise<void> {
    const out = featuresToGeoJson(features, this.fields_());
    if ('error' in out) return void this.options.say(out.error);
    if (await writeClipboardText(out.text)) this.toast(`地物 ${features.length.toLocaleString()} 件を GeoJSON でコピーしました`);
    else this.options.say('コピーできませんでした');
  }

  /** Copies the geometries of `features` as WKT in WGS 84, one per line. */
  async copyWkt(features: Feature[]): Promise<void> {
    const out = featuresToWkt(features);
    if ('error' in out) return void this.options.say(out.error);
    if (await writeClipboardText(out.text)) this.toast(`図形 ${out.count.toLocaleString()} 個を WKT でコピーしました（WGS 84・経度 緯度の順）`);
    else this.options.say('コピーできませんでした');
  }

  /** 「表示範囲の画像をコピー」: the map as drawn, as a PNG picture. */
  async copyView(): Promise<void> {
    const { say } = this.options;
    if (this.options.in3d?.()) return void say('3D 表示では使えません（「表示範囲を保存」で画像に保存できます）');
    if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
      return void say('このブラウザでは画像をコピーできません（「表示範囲を保存」で PNG に保存してください）');
    }
    say('表示範囲を描いています…');
    let skipped = 0;
    // The item is made on the click, its picture comes when drawn (so the browser still counts it as the click's).
    const png = drawView(this.map).then((drawn) => {
      skipped = drawn.skipped;
      return toPng(drawn.canvas);
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      this.toast(`表示範囲の画像をコピーしました${skipped ? `（${skipped} 枚のレイヤーは含められませんでした）` : ''}`);
    } catch (error) {
      say(`画像をコピーできませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 「共有…」: the view's link, with a picture of the view where the share sheet takes files. */
  async share(): Promise<void> {
    const { say, images } = this.options;
    if (typeof navigator.share !== 'function') return void say('このブラウザでは共有できません');
    this.options.updateHash?.();
    const url = location.href;
    const data: ShareData = { title: document.title, url };
    if (!this.options.in3d?.()) {
      try {
        const file = new File([await toPng((await drawView(this.map)).canvas)], '表示範囲.png', { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) data.files = [file];
      } catch {
        // The link alone.
      }
    }
    const local = images.layers().some((l) => (l.type === 'image' && !/^https?:/i.test(l.name)) || (l.type === 'service' && !l.service.ref));
    try {
      await navigator.share(data);
      say(`共有しました${local ? '（ローカルファイルのレイヤーはリンクに含まれません）' : ''}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') return void say('共有できませんでした（時間がかかりました）。もう一度「共有…」を押してください');
      say(`共有できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * What another app shared to the installed app (`?share=<id>`, from the
   * service worker): files open as if chosen, text and URLs as if pasted.
   * The parameter leaves the address at once; the share is taken after
   * `ready` (the layers opening at start).
   */
  async takeSharedFromAddress(ready: Promise<unknown>): Promise<void> {
    const params = new URLSearchParams(location.search);
    const id = params.get(SHARE_PARAM);
    if (id === null) return;
    params.delete(SHARE_PARAM);
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    if (!isShareId(id)) return;
    await ready;
    let shared;
    try {
      shared = await takeShared(id);
    } catch (error) {
      return void this.options.say(`共有されたものを読めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!shared) return void this.options.say('共有されたものはもう開いたか、見つかりません');
    if (shared.files.length) {
      this.toast(`共有されたファイル ${shared.files.length} 件を開きます`);
      await this.options.openFiles(shared.files);
    }
    // A link shared as text often comes as 「title\nurl」: the URL alone when there is one.
    let text = shared.url || shared.text;
    const link = /https?:\/\/\S+/.exec(text)?.[0];
    // (Not out of data such as GeoJSON or KML, which may hold URLs.)
    if (link && !/[{<]/.test(text)) text = link;
    if (text.trim()) await this.takeText(text, '共有');
    else if (!shared.files.length) this.options.say('共有されたものに開けるものがありません');
  }

  /** The fields of the selected vector layer (attributes copied in their order). */
  private fields_() {
    const layer = this.options.images.selectedLayer();
    return layer?.type === 'service' ? layer.service.vector?.fields : undefined;
  }
}

/** Asks which columns hold X and Y and their CRS, for a pasted table that does not name latitude and longitude. */
function askColumns(pasted: PastedTable): Promise<{ crs: TargetCrs; x: string; y: string } | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'add-service paste-columns';
    const title = document.createElement('h2');
    title.textContent = '貼り付けた表の座標';
    const hint = document.createElement('p');
    hint.className = 'processing-hint';
    hint.textContent = `${pasted.table.features.length.toLocaleString()} 行の表です。X（経度・東向き）と Y（緯度・北向き）の列と、値の座標系を選んでください。`;
    const select = (label: string, options: Array<[string, string]>, value: string | null) => {
      const wrap = document.createElement('label');
      wrap.className = 'wide';
      wrap.append(label);
      const s = document.createElement('select');
      s.setAttribute('aria-label', label);
      for (const [v, text] of options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = text;
        s.append(o);
      }
      if (value !== null) s.value = value;
      wrap.append(s);
      return { wrap, s };
    };
    const columns = pasted.table.fields.map((f): [string, string] => [f.name, f.name]);
    const x = select('X の列', columns, pasted.x);
    const y = select('Y の列', columns, pasted.y);
    const crs = select('値の座標系', [...crsPresets.map((p): [string, string] => [p.code, p.name]), ['', 'その他（EPSG コードを入力）']], pasted.suggested ?? 'EPSG:6677');
    const codeLabel = document.createElement('label');
    codeLabel.className = 'wide';
    codeLabel.append('EPSG コード');
    const code = document.createElement('input');
    code.type = 'text';
    code.placeholder = '例: 6677';
    code.setAttribute('aria-label', 'EPSG コード');
    codeLabel.append(code);
    const error = document.createElement('p');
    error.className = 'paste-error';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'service-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'キャンセル';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = '追加';
    actions.append(cancel, ok);
    dialog.append(title, hint, x.wrap, y.wrap, crs.wrap, codeLabel, error, actions);
    let answer: { crs: TargetCrs; x: string; y: string } | null = null;
    ok.addEventListener('click', () => {
      const chosen = (crs.s.value || code.value).trim();
      if (!chosen) return void (error.textContent = 'EPSG コードを入れてください');
      targetCrs(chosen)
        .then((target) => {
          answer = { crs: target, x: x.s.value, y: y.s.value };
          dialog.close();
        })
        .catch((e) => (error.textContent = e instanceof Error ? e.message : String(e)));
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}
