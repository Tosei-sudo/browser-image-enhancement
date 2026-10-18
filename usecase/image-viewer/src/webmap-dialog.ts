/**
 * 「ArcGIS Web マップを開く…」 and 「ArcGIS Web マップとして保存…」 (the
 * プロジェクト menu): a web map of a portal (by its item page, Map Viewer
 * link or item id) or a web map JSON file opened as the viewer's layers, and
 * what is open written as a web map, downloaded as .json or saved to a
 * portal as a new item or over the one opened (after asking).
 *
 * What the web map says is read in webmap.ts; here it is fetched, opened
 * with the service readers (services/*), and written back.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import LayerGroup from 'ol/layer/Group.js';
import TileLayer from 'ol/layer/Tile.js';
import type VectorLayer from 'ol/layer/Vector.js';
import XYZ from 'ol/source/XYZ.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import { transformExtent } from 'ol/proj.js';
import type { Extent } from 'ol/extent.js';
import type { BaseMapConfig } from './config.js';
import type { BaseMapSwitch } from './basemap.js';
import { styledVectorTiles } from './basemap.js';
import type { Bookmark } from './bookmarks.js';
import type { ImageList, ViewerLayer, ViewerService } from './images.js';
import { askDialog } from './local-paths.js';
import { esriJson, rendererStyle, toField, type EsriRenderer } from './services/esri.js';
import { projectionOf, readService, request, ServiceError, type Field, type OpenContext, type ServiceLayer, type ServiceRef } from './services/index.js';
import { tempLayer, type TempRecord, type TempStore } from './temp-layers.js';
import { LayerStyle } from './vector-style.js';
import { wgs84 } from './vector-write.js';
import {
  buildWebMap,
  collectionFeatures,
  DEFAULT_PORTAL,
  ESRI_RESOLUTION_PER_SCALE,
  esriScaleOfSpec,
  itemDataUrl,
  itemExtent,
  itemUrl,
  matchBaseMap,
  MAX_WEBMAP_READ,
  parseItemInput,
  planWebMap,
  portalRoot,
  specScaleOfEsri,
  styleOfRenderer,
  tokenAllowed,
  userContentUrl,
  type SaveInput,
  type SaveLayer,
  type WebMapExtent,
  type WebMapItemRef,
  type WebMapLayer,
  type WebMapPlan,
} from './webmap.js';

/**
 * The token sent with a request to `url` for a web map of `portal`: the one
 * typed, and only to the portal's host (or ArcGIS Online's hosted services).
 * Every token of this feature is looked up here, so a sign-in (OAuth) can
 * answer instead of the typed field.
 */
export async function tokenFor(url: string, portal: string | null, typed: string | undefined): Promise<string | undefined> {
  if (!typed || !portal) return undefined;
  return tokenAllowed(url, portal) ? typed : undefined;
}

export interface WebMapOptions {
  map: OlMap;
  images: ImageList;
  baseMap: BaseMapSwitch;
  baseMaps: readonly BaseMapConfig[];
  tempStore: TempStore;
  bookmarks: { get: () => Bookmark[]; merge: (list: Bookmark[]) => void };
  context: () => OpenContext;
  say: (message: string) => void;
  /** The project's name, the first title offered when saving. */
  name?: () => string | null;
  /** Called when layers or the base map were changed (to update the link). */
  onChange?: () => void;
}

/** What the viewer keeps of a layer opened from a web map, to write it back. */
interface Kept {
  /** The web map's JSON of a layer the viewer cannot make again (tiles, vector tiles). */
  json?: Record<string, unknown>;
  /** The web map's renderer, written while the layer keeps its own style. */
  renderer?: EsriRenderer;
  /** A layer of the web map's base map. */
  basemap?: boolean;
}

const PORTAL_KEY = 'image-viewer.webmap-portal';
const rememberedPortal = (): string => {
  try {
    return localStorage.getItem(PORTAL_KEY) ?? '';
  } catch {
    return '';
  }
};
const rememberPortal = (portal: string) => {
  try {
    localStorage.setItem(PORTAL_KEY, portal);
  } catch {
    // Not kept.
  }
};

/** The two dialogs, and what was opened last (to save over it). */
export class WebMapDialogs {
  readonly openDialog: HTMLDialogElement;
  readonly saveDialog: HTMLDialogElement;
  private readonly kept_ = new WeakMap<ServiceLayer, Kept>();
  /** The web map opened last: its item (when from a portal), title and base map. */
  private opened_: { item: WebMapItemRef | null; title: string; owner?: string; basemap: Record<string, unknown> | null } | null = null;
  private readonly openStatus_: HTMLElement;
  private readonly openResult_: HTMLUListElement;
  private readonly saveStatus_: HTMLElement;
  private readonly saveResult_: HTMLUListElement;

  constructor(private readonly options: WebMapOptions) {
    this.openDialog = document.createElement('dialog');
    this.openDialog.className = 'add-service webmap-dialog';
    this.openDialog.setAttribute('aria-labelledby', 'webmap-open-title');
    this.openDialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="webmap-open-title">ArcGIS Web マップを開く</h2>
        <label class="wide">アイテム<input name="item" type="text" placeholder="https://…/home/item.html?id=…、Map Viewer の URL、またはアイテム ID" aria-label="Web マップのアイテム" /></label>
        <details class="wide webmap-details"><summary>詳細（ポータル・トークン・ファイル）</summary>
          <div class="service-form">
            <label class="wide">ポータル（ID だけを入れたとき）<input name="portal" type="url" placeholder="${DEFAULT_PORTAL}" aria-label="ポータルの URL" /></label>
            <label class="wide">トークン（非公開のアイテム、任意）<input name="token" type="password" autocomplete="off" aria-label="ポータルのトークン" /></label>
            <label class="wide">JSON ファイルから開く<input name="file" type="file" accept=".json,application/json" aria-label="Web マップの JSON ファイル" /></label>
          </div>
        </details>
      </form>
      <p class="service-status" role="status"></p>
      <ul class="webmap-result"></ul>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="open" class="primary">開く</button>
      </div>`;
    this.saveDialog = document.createElement('dialog');
    this.saveDialog.className = 'add-service webmap-dialog';
    this.saveDialog.setAttribute('aria-labelledby', 'webmap-save-title');
    this.saveDialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="webmap-save-title">ArcGIS Web マップとして保存</h2>
        <label class="wide">タイトル<input name="title" type="text" aria-label="Web マップのタイトル" /></label>
        <label class="wide">タグ（カンマ区切り）<input name="tags" type="text" aria-label="タグ" /></label>
      </form>
      <p class="webmap-summary"></p>
      <ul class="webmap-result"></ul>
      <details class="webmap-details webmap-portal"><summary>ポータルに保存</summary>
        <div class="service-form">
          <label class="wide">ポータル<input name="portal" type="url" placeholder="${DEFAULT_PORTAL}" aria-label="保存先のポータル" /></label>
          <label class="wide">トークン<input name="token" type="password" autocomplete="off" aria-label="保存先のトークン" /></label>
          <label>ユーザー名（空欄: トークンの持ち主）<input name="user" type="text" aria-label="ユーザー名" /></label>
          <label>フォルダー（任意）<input name="folder" type="text" aria-label="フォルダー" /></label>
          <label class="wide check" hidden><input name="update" type="checkbox" /> <span class="update-text">開いた Web マップを上書きする</span></label>
          <button type="button" value="portal" class="wide">ポータルに保存…</button>
        </div>
      </details>
      <p class="service-status" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="download" class="primary">JSON をダウンロード</button>
      </div>`;
    document.body.append(this.openDialog, this.saveDialog);
    this.openStatus_ = this.openDialog.querySelector('.service-status')!;
    this.openResult_ = this.openDialog.querySelector('.webmap-result')!;
    this.saveStatus_ = this.saveDialog.querySelector('.service-status')!;
    this.saveResult_ = this.saveDialog.querySelector('.webmap-result')!;

    const form = this.openDialog.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.openTyped();
    });
    this.openDialog.querySelector('button[value=open]')!.addEventListener('click', () => void this.openTyped());
    this.openDialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.openDialog.close());
    this.field_(this.openDialog, 'file').addEventListener('change', () => {
      const file = this.field_(this.openDialog, 'file').files?.[0];
      if (file) void this.openFile(file);
    });
    this.saveDialog.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    this.saveDialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.saveDialog.close());
    this.saveDialog.querySelector('button[value=download]')!.addEventListener('click', () => this.download());
    this.saveDialog.querySelector('button[value=portal]')!.addEventListener('click', () => void this.saveToPortal());
  }

  private field_(dialog: HTMLDialogElement, name: string): HTMLInputElement {
    return dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  }

  /** Shows the open dialog. */
  open(): void {
    const portal = this.field_(this.openDialog, 'portal');
    if (!portal.value) portal.value = rememberedPortal();
    this.openStatus_.textContent = '';
    this.openResult_.replaceChildren();
    this.openDialog.showModal();
    this.field_(this.openDialog, 'item').focus();
  }

  /** Shows the save dialog, with what will be written. */
  openSave(): void {
    const title = this.field_(this.saveDialog, 'title');
    title.value = this.opened_?.title ?? this.options.name?.() ?? title.value ?? '';
    const portal = this.field_(this.saveDialog, 'portal');
    if (!portal.value) portal.value = this.opened_?.item?.portal ?? rememberedPortal();
    this.showUpdate_();
    this.saveStatus_.textContent = '';
    this.showSummary_(this.build_());
    this.saveDialog.showModal();
    title.focus();
  }

  /** Offers to save over the web map opened (or saved) last. */
  private showUpdate_(): void {
    const update = this.field_(this.saveDialog, 'update');
    const item = this.opened_?.item;
    update.closest('label')!.hidden = !item;
    update.checked = false;
    if (item) this.saveDialog.querySelector('.update-text')!.textContent = `開いた Web マップ（${item.id}）を上書きする`;
  }

  /** Opens what the item field names. */
  async openTyped(): Promise<void> {
    const text = this.field_(this.openDialog, 'item').value.trim();
    if (!text) {
      this.openStatus_.textContent = 'アイテムの URL か ID を入れてください（JSON ファイルは「詳細」から）';
      return;
    }
    const ref = parseItemInput(text, this.field_(this.openDialog, 'portal').value.trim() || DEFAULT_PORTAL);
    if (!ref) {
      this.openStatus_.textContent = 'アイテムの URL（…/home/item.html?id=…、…/apps/mapviewer/index.html?webmap=…）か 32 桁のアイテム ID を入れてください';
      return;
    }
    await this.run_(() => this.openItem(ref, this.field_(this.openDialog, 'token').value.trim() || undefined));
  }

  /** Opens a web map JSON file. */
  async openFile(file: File): Promise<void> {
    await this.run_(async () => {
      if (file.size > MAX_WEBMAP_READ) throw new ServiceError('ファイルが大きすぎます');
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new ServiceError('JSON として読めません');
      }
      const portal = portalRoot(this.field_(this.openDialog, 'portal').value) ?? null;
      return this.apply(planWebMap(json), { title: file.name.replace(/\.json$/i, ''), item: null, portal, token: this.field_(this.openDialog, 'token').value.trim() || undefined });
    });
  }

  private async run_(work: () => Promise<string>): Promise<void> {
    this.openStatus_.textContent = '読み込んでいます…';
    this.openResult_.replaceChildren();
    try {
      const summary = await work();
      this.openStatus_.textContent = summary;
      this.options.say(summary);
    } catch (error) {
      this.openStatus_.textContent = `開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Opens a web map item of a portal. */
  async openItem(ref: WebMapItemRef, typed?: string): Promise<string> {
    rememberPortal(ref.portal);
    const item = await esriJson<{ type?: string; title?: string; owner?: string; extent?: unknown }>(itemUrl(ref), {}, await tokenFor(itemUrl(ref), ref.portal, typed));
    if (item.type !== 'Web Map') throw new ServiceError(`Web マップのアイテムではありません（種類: ${item.type ?? '不明'}）`);
    const data = await readData(itemDataUrl(ref), await tokenFor(itemDataUrl(ref), ref.portal, typed));
    return this.apply(planWebMap(data), { title: item.title ?? ref.id, item: ref, owner: item.owner, portal: ref.portal, token: typed, itemExtent: itemExtent(item) });
  }

  /**
   * Opens what a web map holds: its base map (one of config.json's when it
   * is one, else its layers at the bottom), its layers in order, the view
   * and the bookmarks. Returns the summary; what could not be opened is listed in the dialog.
   */
  async apply(plan: WebMapPlan, from: { title: string; item: WebMapItemRef | null; owner?: string; portal: string | null; token?: string; itemExtent?: WebMapExtent | null }): Promise<string> {
    const { images, baseMap } = this.options;
    const problems = [...plan.unsupported];
    const notes: string[] = [];

    // The base map.
    const match = matchBaseMap(plan.basemap, this.options.baseMaps);
    let extra = plan.basemap.layers.filter((l) => l.reference);
    if (match) {
      baseMap.set(match.id);
      notes.push(`背景地図は「${match.label}」にしました`);
    } else if (plan.basemap.layers.length) {
      baseMap.set('');
      extra = plan.basemap.layers;
      notes.push(`背景地図「${plan.basemap.title}」はレイヤーとして下に追加しました`);
    }

    // Opened at once, added in order: bottom first, so the last is on top.
    const wanted: Array<WebMapLayer & { basemap?: boolean }> = [...extra.map((l) => ({ ...l, title: `背景: ${l.title}`, basemap: true })), ...plan.layers];
    const opened = await Promise.allSettled(wanted.map((l) => this.openLayer_(l, from)));
    let count = 0;
    opened.forEach((result, i) => {
      const spec = wanted[i];
      if (result.status === 'rejected') {
        problems.push({ title: spec.title, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
        return;
      }
      for (const service of result.value) {
        const kept = this.kept_.get(service) ?? {};
        if (spec.basemap) this.kept_.set(service, { ...kept, basemap: true });
        const entry = images.addService(service);
        images.setVisible(entry, spec.visible);
        images.setOpacity(entry, Math.round(spec.opacity * 100) / 100);
        if (!service.vector) limitScales(service.layer, spec.minScale, spec.maxScale);
        count++;
      }
    });
    this.opened_ = { item: from.item, title: from.title, owner: from.owner, basemap: match ? null : plan.basemap.source };

    // The view and the bookmarks.
    const extent = (await toMercator(plan.extent)) ?? (await toMercator(from.itemExtent ?? null));
    const { map } = this.options;
    if (extent) map.getView().fit(extent, { padding: [20, 20, 20, 20] });
    const bookmarks: Bookmark[] = [];
    for (const b of plan.bookmarks) {
      const e = await toMercator(b.extent);
      const size = map.getSize();
      if (!e || !size) continue;
      const resolution = map.getView().getResolutionForExtent(e, size);
      bookmarks.push({ id: crypto.randomUUID(), name: b.name, view: { projection: 'EPSG:3857', center: [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2], resolution, rotation: 0 } });
    }
    if (bookmarks.length) {
      this.options.bookmarks.merge(bookmarks);
      notes.push(`ブックマーク ${bookmarks.length} 件を追加しました`);
    }
    this.options.onChange?.();

    this.openResult_.replaceChildren(
      ...notes.map((n) => listItem(n, 'note')),
      ...problems.map((p) => listItem(`開けませんでした: ${p.title} — ${p.reason}`, 'problem')),
    );
    return `Web マップ「${from.title}」の ${count} レイヤーを開きました${problems.length ? `（${problems.length} レイヤーは開けませんでした）` : ''}`;
  }

  /** One layer of a web map as the viewer's layer, in the web map's style. */
  private async openLayer_(spec: WebMapLayer, from: { title: string; portal: string | null; token?: string }): Promise<ServiceLayer[]> {
    const context = this.options.context();
    if (spec.type === 'service') {
      const token = spec.esri ? await tokenFor(spec.ref.url, from.portal, from.token) : undefined;
      const service = await openService(spec.ref, context, token);
      // Named as the web map names it.
      service.title = spec.title;
      if (service.vector && service.style) this.styleFeatureLayer_(service, spec);
      return [service];
    }
    if (spec.type === 'tiles') {
      const layer = new TileLayer({ source: new XYZ({ urls: spec.urls, attributions: spec.attributions, maxZoom: 22, crossOrigin: 'anonymous' }) });
      const service = plainLayer(spec.title, layer, [['種類', 'タイル（Web マップ）'], ['URL', spec.urls[0]]]);
      this.kept_.set(service, { json: spec.source });
      return [service];
    }
    if (spec.type === 'vector-tiles') {
      const token = await tokenFor(spec.url, from.portal, from.token);
      const esri = /\/VectorTileServer\/?$/i.test(spec.url);
      const layers = await styledVectorTiles({ id: 'webmap', label: spec.title, type: esri ? 'esri' : 'style', url: spec.url, style: esri ? spec.style : undefined, attributions: '', maxZoom: 22, token });
      const layer = layers.length === 1 ? layers[0] : new LayerGroup({ layers });
      const service = plainLayer(spec.title, layer, [['種類', 'ベクタータイル（Web マップ）'], ['URL', spec.style ?? spec.url]]);
      this.kept_.set(service, { json: spec.source });
      return [service];
    }
    // A feature collection kept in the map: temporary layers (in the browser), one per part.
    const out: ServiceLayer[] = [];
    for (const part of spec.parts) {
      const projection = await projectionOf(`EPSG:${part.wkid}`);
      if (!projection) throw new ServiceError(`座標系 EPSG:${part.wkid} を読めません`);
      const features = collectionFeatures(part, projection.getCode());
      const fields = part.fields.map((f) => toField(f, true, new Set())).filter((f): f is Field => f !== null && f.type !== 'oid');
      const record: TempRecord = {
        id: crypto.randomUUID(),
        title: spec.parts.length > 1 && part.name ? `${spec.title}: ${part.name}` : spec.title,
        made: `ArcGIS Web マップ「${from.title}」`,
        created: Date.now(),
        fields,
        crs: wgs84,
        features: new GeoJSON().writeFeaturesObject(features),
      };
      await this.options.tempStore.put(record).catch(() => {});
      const service = tempLayer(record, this.options.tempStore);
      if (part.renderer || part.labelField) {
        const own = part.renderer ? rendererStyle(part.renderer, '') : undefined;
        const initial = part.renderer ? styleOfRenderer(part.renderer, part.labelField ?? null) : service.style!.get();
        if (!part.renderer) initial.label.field = part.labelField ?? null;
        const style = new LayerStyle(service.layer as VectorLayer, initial.mode === 'own' && !own ? service.style!.get() : initial, own);
        const dispose = service.dispose;
        service.style = style;
        service.dispose = () => {
          style.forget();
          dispose?.();
        };
        if (part.renderer) this.kept_.set(service, { renderer: part.renderer });
      }
      setSpecScales(service, spec.minScale, spec.maxScale);
      out.push(service);
    }
    return out;
  }

  /** A feature layer drawn by the web map's renderer and labels, and shown at its scales. */
  private styleFeatureLayer_(service: ServiceLayer, spec: Extract<WebMapLayer, { type: 'service' }>): void {
    if (spec.renderer || spec.labelField !== undefined) {
      const initial = spec.renderer ? styleOfRenderer(spec.renderer, spec.labelField ?? null) : service.style!.get();
      if (!spec.renderer) initial.label.field = spec.labelField ?? null;
      const own = spec.renderer ? rendererStyle(spec.renderer, spec.ref.url) : service.style!.own;
      service.style = new LayerStyle(service.layer as VectorLayer, initial, own);
      // Kept apart from the same layer opened without the web map.
      service.styleKey = `webmap:${spec.ref.url}#${spec.ref.settings?.where ?? ''}`;
      if (spec.renderer) this.kept_.set(service, { renderer: spec.renderer });
    }
    setSpecScales(service, spec.minScale, spec.maxScale);
  }

  // ---- Saving ----

  /** What is open as a web map. */
  private build_(): ReturnType<typeof buildWebMap> {
    const { images, map, baseMap } = this.options;
    const layers: SaveLayer[] = [];
    const basemapStillOpen = images.layers().some((l) => l.type === 'service' && this.kept_.get(l.service)?.basemap);
    for (const l of [...images.layers()].reverse()) {
      if (l.type === 'service' && this.kept_.get(l.service)?.basemap) continue;
      layers.push(this.saveLayer_(l));
    }
    const size = map.getSize();
    const view = map.getView();
    const extent = size ? (view.calculateExtent(size) as [number, number, number, number]) : null;
    const input: SaveInput = {
      title: this.title_(),
      layers,
      extent: view.getProjection().getCode() === 'EPSG:3857' ? extent : null,
      basemap: { config: this.options.baseMaps.find((b) => b.id === baseMap.get()), json: basemapStillOpen ? this.opened_?.basemap : null },
      bookmarks: this.options.bookmarks.get(),
      bookmarkExtent: (b) => {
        if (b.view.projection !== 'EPSG:3857' || !size) return null;
        const [x, y] = b.view.center;
        const [w, h] = [(size[0] * b.view.resolution) / 2, (size[1] * b.view.resolution) / 2];
        return [x - w, y - h, x + w, y + h];
      },
    };
    return buildWebMap(input);
  }

  private saveLayer_(l: ViewerLayer): SaveLayer {
    const common = { title: l.name, visible: this.options.images.isVisible(l), opacity: l.layer.getOpacity() };
    if (l.type === 'image') return { ...common, type: 'none', reason: '画像（COG・ファイル）は Web マップに書けません' };
    const service = (l as ViewerService).service;
    const kept = this.kept_.get(service);
    const spec = service.style?.get();
    const latitude = service.style?.latitude() ?? 0;
    const scales = spec
      ? { minScale: spec.minScale ? esriScaleOfSpec(spec.minScale, latitude) : null, maxScale: spec.maxScale ? esriScaleOfSpec(spec.maxScale, latitude) : null }
      : rasterScales(service.layer);
    if (kept?.json) return { ...common, ...scales, type: 'json', json: kept.json };
    if (service.ref) {
      const first = service.vector?.source.getFeatures().find((f) => f.getGeometry())?.getGeometry()?.getType();
      return { ...common, ...scales, type: 'ref', ref: service.ref, spec, geometryType: service.esri?.geometryType ?? first, renderer: kept?.renderer };
    }
    if (service.vector && !service.tableOnly) {
      if (service.vector.note) return { ...common, type: 'none', reason: 'すべての地物を読み込んでいないレイヤーです' };
      return { ...common, ...scales, type: 'features', features: service.vector.source.getFeatures(), fields: service.vector.fields, spec, renderer: kept?.renderer };
    }
    return { ...common, type: 'none', reason: service.tableOnly ? '表（ジオメトリなし）は書けません' : 'サービスの URL がありません' };
  }

  private title_(): string {
    return this.field_(this.saveDialog, 'title').value.trim() || this.opened_?.title || this.options.name?.() || 'Web マップ';
  }

  private showSummary_(result: ReturnType<typeof buildWebMap>): void {
    this.saveDialog.querySelector('.webmap-summary')!.textContent = result.included.length
      ? `${result.included.length} レイヤーを書きます: ${result.included.join('、')}`
      : '書けるレイヤーがありません（表示範囲と背景地図だけを書きます）';
    this.saveResult_.replaceChildren(...result.skipped.map((s) => listItem(`書けません: ${s.title} — ${s.reason}`, 'problem')));
  }

  /** Downloads the web map as a .json file. */
  download(): void {
    const result = this.build_();
    this.showSummary_(result);
    const blob = new Blob([JSON.stringify(result.json)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.title_().replace(/[\\/:*?"<>|]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    this.saveStatus_.textContent = `${a.download} を保存しました`;
  }

  /** Saves the web map to a portal (a new item, or over the one opened), after asking. */
  async saveToPortal(): Promise<void> {
    const status = this.saveStatus_;
    const portal = portalRoot(this.field_(this.saveDialog, 'portal').value || DEFAULT_PORTAL);
    const typed = this.field_(this.saveDialog, 'token').value.trim() || undefined;
    if (!portal) {
      status.textContent = 'ポータルの URL を入れてください';
      return;
    }
    const token = await tokenFor(`${portal}/sharing/rest`, portal, typed);
    if (!token) {
      status.textContent = 'ポータルに保存するにはトークンを入れてください（https のポータルのみ）';
      return;
    }
    try {
      status.textContent = 'ポータルを確かめています…';
      let user = this.field_(this.saveDialog, 'user').value.trim();
      if (!user) {
        const self = await esriJson<{ username?: string; user?: { username?: string } }>(`${portal}/sharing/rest/community/self`, {}, token);
        user = self.username ?? self.user?.username ?? '';
        if (!user) throw new ServiceError('トークンのユーザーが分かりません。ユーザー名を入れてください');
      }
      const folderName = this.field_(this.saveDialog, 'folder').value.trim();
      let folder: string | undefined;
      if (folderName) {
        const content = await esriJson<{ folders?: Array<{ id: string; title: string }> }>(userContentUrl(portal, user), {}, token);
        folder = content.folders?.find((f) => f.title === folderName || f.id === folderName)?.id;
        if (!folder) throw new ServiceError(`フォルダー「${folderName}」がありません`);
      }
      const item = this.opened_?.item;
      const update = this.field_(this.saveDialog, 'update').checked && item && item.portal === portal ? item : null;
      const result = this.build_();
      this.showSummary_(result);
      const title = this.title_();
      const tags = this.field_(this.saveDialog, 'tags').value.trim() || 'image-viewer';
      const message = update
        ? `${portal} の Web マップ（${update.id}）を「${title}」で上書きします（${result.included.length} レイヤー）。よろしいですか？`
        : `${portal} のユーザー ${user}${folderName ? ` のフォルダー「${folderName}」` : ''} に、Web マップ「${title}」を新しく作ります（${result.included.length} レイヤー）。よろしいですか？`;
      status.textContent = '';
      const saved = await askDialog()(message, update ? '上書きする' : '作成する', async () => {
        status.textContent = 'ポータルに書き込んでいます…';
        const extent = await wgs84Extent(this.options.map);
        const params: Record<string, string> = {
          title,
          tags,
          text: JSON.stringify(result.json),
          ...(extent ? { extent: extent.join(',') } : {}),
        };
        if (update) {
          const r = await esriJson<{ success?: boolean; id?: string }>(`${userContentUrl(portal, user)}/items/${update.id}/update`, params, token, true);
          if (r.success === false) throw new ServiceError('ポータルが更新を受け付けませんでした');
          return update.id;
        }
        const r = await esriJson<{ success?: boolean; id?: string }>(
          `${userContentUrl(portal, user, folder)}/addItem`,
          { ...params, type: 'Web Map', typeKeywords: 'ArcGIS Online,Explorer Web Map,Map,Online Map,Web Map' },
          token,
          true,
        );
        if (r.success === false || !r.id || !/^[0-9a-f]{32}$/i.test(r.id)) throw new ServiceError('ポータルがアイテムを作りませんでした');
        return r.id;
      });
      if (saved === null) {
        status.textContent = '保存しませんでした';
        return;
      }
      rememberPortal(portal);
      this.opened_ = { item: { portal, id: saved }, title, owner: user, basemap: this.opened_?.basemap ?? null };
      this.showUpdate_();
      const link = document.createElement('a');
      link.href = `${portal}/home/item.html?id=${saved}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = saved;
      status.replaceChildren(`${update ? '上書き保存' : '保存'}しました（アイテム `, link, '）');
      this.options.say(`Web マップ「${title}」をポータルに保存しました`);
    } catch (error) {
      status.textContent = `保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function listItem(text: string, className: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = className;
  li.textContent = text;
  return li;
}

/** The data of an item (the web map), JSON with a size limit; an `error` member becomes an error. */
async function readData(url: string, token?: string): Promise<unknown> {
  const params = new URLSearchParams({ f: 'json', ...(token ? { token } : {}) });
  const response = token ? await request(url, { method: 'POST', body: params, headers: { 'content-type': 'application/x-www-form-urlencoded' } }) : await request(`${url}?${params}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_WEBMAP_READ) throw new ServiceError('Web マップが大きすぎます');
  const text = await response.text();
  if (text.length > MAX_WEBMAP_READ) throw new ServiceError('Web マップが大きすぎます');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ServiceError('Web マップの内容が JSON ではありません');
  }
  const error = (json as { error?: { code?: number; message?: string } } | null)?.error;
  if (error) throw new ServiceError(error.code === 498 || error.code === 499 || error.code === 403 ? 'このアイテムにはトークン（権限）が必要です' : `ポータルがエラーを返しました: ${error.message ?? ''}`);
  return json;
}

/** Opens one layer of a service as a link would, with a token for Esri services. */
async function openService(ref: ServiceRef, context: OpenContext, token?: string): Promise<ServiceLayer> {
  const catalog = await readService(ref.url, ref.kind, token);
  const choice = catalog.choices.find((c) => c.name === ref.layer) ?? (ref.kind === 'esri' && catalog.choices.length === 1 ? catalog.choices[0] : undefined);
  if (!choice) throw new ServiceError(`レイヤー ${ref.layer} がサービスにありません`);
  const matrixSet = ref.matrixSet && choice.matrixSets?.includes(ref.matrixSet) ? ref.matrixSet : undefined;
  const format = ref.format && choice.formats?.includes(ref.format) ? ref.format : undefined;
  const layer = await catalog.open(choice, { ...context, token }, { matrixSet, format, settings: ref.settings });
  // Only coverages open as images (null); a web map holds none of those.
  if (!layer) throw new ServiceError(`レイヤー ${ref.layer} は画像として開きました`);
  return layer;
}

/** A layer the service readers do not make (tiles, vector tiles of a web map). */
function plainLayer(title: string, layer: BaseLayer, info: Array<[string, string]>): ServiceLayer {
  return { ref: null, badge: 'Web マップ', title, layer, correction: null, vector: null, extent: null, info };
}

/** A vector layer's scale range (Esri scales) into its style. */
function setSpecScales(service: ServiceLayer, minScale: number | null, maxScale: number | null): void {
  const style = service.style;
  if (!style || (minScale === null && maxScale === null)) return;
  const latitude = style.latitude() ?? 0;
  const spec = style.get();
  spec.minScale = minScale ? specScaleOfEsri(minScale, latitude) : null;
  spec.maxScale = maxScale ? specScaleOfEsri(maxScale, latitude) : null;
  style.set(spec, false);
}

/** A picture layer's scale range (Esri scales) as resolutions. */
function limitScales(layer: BaseLayer, minScale: number | null, maxScale: number | null): void {
  if (minScale) layer.setMaxResolution(minScale * ESRI_RESOLUTION_PER_SCALE);
  if (maxScale) layer.setMinResolution(maxScale * ESRI_RESOLUTION_PER_SCALE);
}

/** A picture layer's resolutions as Esri scales. */
function rasterScales(layer: BaseLayer): { minScale: number | null; maxScale: number | null } {
  const max = layer.getMaxResolution();
  const min = layer.getMinResolution();
  return { minScale: Number.isFinite(max) ? Math.round(max / ESRI_RESOLUTION_PER_SCALE) : null, maxScale: min > 0 ? Math.round(min / ESRI_RESOLUTION_PER_SCALE) : null };
}

/** A web map's extent in Web Mercator, or null when its spatial reference cannot be read. */
async function toMercator(e: WebMapExtent | null): Promise<Extent | null> {
  if (!e) return null;
  const projection = await projectionOf(`EPSG:${e.wkid}`);
  if (!projection) return null;
  const out = transformExtent([e.xmin, e.ymin, e.xmax, e.ymax], projection, 'EPSG:3857');
  return out.every(Number.isFinite) ? out : null;
}

/** The view in degrees, for the item's extent. */
async function wgs84Extent(map: OlMap): Promise<number[] | null> {
  const size = map.getSize();
  if (!size) return null;
  const view = map.getView();
  const e = transformExtent(view.calculateExtent(size), view.getProjection(), 'EPSG:4326');
  return e.every(Number.isFinite) ? e.map((v) => Math.round(v * 1e6) / 1e6) : null;
}
