/**
 * The notification centre of the image catalog watches (catalog-watch.ts):
 * the header's 「通知」 button with the number of unread notices, the panel
 * listing the images that newly matched a watch (open them, go to them) and
 * the watches themselves (on / off, delete), and the small dialog that makes
 * a watch from the catalog panel's conditions or from a point of the map.
 *
 * While a window of the viewer is open the watches are checked every
 * `watchInterval` minutes (config.json), and as it starts, for what came
 * while it was closed. The installed app also registers a Periodic Background
 * Sync, so the service worker checks with no window open, where the browser
 * offers it (Chrome and Edge, installed app, at times the browser chooses).
 * Desktop notifications are never used: the app icon's badge and this panel are.
 */
import type OlMap from 'ol/Map.js';
import type Feature from 'ol/Feature.js';
import type { Geometry } from 'ol/geom.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style } from 'ol/style.js';
import { transformExtent } from 'ol/proj.js';
import { fromExtent } from 'ol/geom/Polygon.js';
import { recordOf, roleLabels, timeText, type CatalogConfig, type CatalogRecord, type FieldTypes } from './catalog.js';
import {
  checkDue,
  deleteNotices,
  deleteWatch,
  listNotices,
  listWatches,
  markRead,
  putWatch,
  SYNC_TAG,
  updateBadge,
  WATCH_CHANNEL,
  type CatalogWatch,
  type EsriAsk,
  type WatchArea,
  type WatchConditions,
  type WatchNotice,
} from './catalog-watch.js';

export interface WatchPanelOptions {
  /** The catalogs of config.json (a watch of a catalog no longer listed still runs on what it kept). */
  catalogs: CatalogConfig[];
  /** How often the open viewer checks, in minutes. */
  interval: number;
  /** Asks the catalog (with the viewer's sign-in, when there is one). */
  ask: EsriAsk;
  /** Opens an image of a notice, as the catalog panel opens it; rejects (having said why) when it cannot. */
  open: (record: CatalogRecord, catalog: CatalogConfig) => Promise<void>;
  /** The features chosen on the map, for 「選択中の地物」. */
  selected: () => Feature[];
  /** The service worker's registration, for Periodic Background Sync (null without one). */
  registration: () => Promise<ServiceWorkerRegistration | null>;
  say: (message: string) => void;
}

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

/** Whether the installed app checks with no window open. */
export type BackgroundState = 'on' | 'off' | 'unsupported';

const highlight = new Style({ stroke: new Stroke({ color: '#f59e0b', width: 3 }), fill: new Fill({ color: 'rgba(245, 158, 11, 0.18)' }) });
const format = new EsriJSON();
const MINUTE = 60 * 1000;

/** A short description of a watch's conditions. */
export function conditionsText(watch: Pick<CatalogWatch, 'catalog' | 'conditions' | 'area'>): string {
  const { catalog, conditions: c, area } = watch;
  const parts: string[] = [catalog.label];
  if (area?.kind === 'point') parts.push(`地点 ${area.lat.toFixed(4)}, ${area.lon.toFixed(4)}`);
  else if (area) parts.push('範囲');
  else parts.push('範囲なし');
  if (c.sensor) parts.push(`${catalog.labels.sensor ?? roleLabels.sensor} ${c.sensor}`);
  if (c.maxAngle !== null) parts.push(`${catalog.labels.angle ?? roleLabels.angle} ${c.maxAngle}° 以下`);
  if (c.azimuthFrom !== null || c.azimuthTo !== null) parts.push(`${catalog.labels.azimuth ?? roleLabels.azimuth} ${c.azimuthFrom ?? 0}〜${c.azimuthTo ?? 360}°`);
  if (c.where.trim()) parts.push(c.where.trim());
  return parts.join(' ・ ');
}

/** An area of the map (in `projection`) as a watch area in longitude / latitude: a point, or the rings of a polygon (else its extent). */
export function areaOf(geometry: Geometry, projection: string): WatchArea | null {
  const g = geometry.clone().transform(projection, 'EPSG:4326');
  const type = g.getType();
  if (type === 'Point') {
    const [lon, lat] = (g as import('ol/geom.js').Point).getCoordinates();
    return { kind: 'point', lon, lat };
  }
  if (type === 'Polygon') return { kind: 'polygon', rings: (g as import('ol/geom.js').Polygon).getCoordinates() };
  if (type === 'MultiPolygon') return { kind: 'polygon', rings: (g as import('ol/geom.js').MultiPolygon).getCoordinates().flat() };
  const extent = g.getExtent();
  if (!extent.every(Number.isFinite)) return null;
  return { kind: 'polygon', rings: fromExtent(extent).getCoordinates() };
}

export class WatchPanel {
  readonly dialog: HTMLDialogElement;
  /** The footprint of the notice gone to, on the map while the panel is open. */
  readonly footprint = new VectorLayer({ source: new VectorSource<Feature>(), style: highlight, zIndex: 1001 });
  private readonly count_: HTMLElement;
  private readonly list_: HTMLElement;
  private readonly watches_: HTMLElement;
  private readonly watchSummary_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly background_: HTMLElement;
  private readonly create_: HTMLDialogElement;
  private notices_: WatchNotice[] = [];
  private watchList_: CatalogWatch[] = [];
  private backgroundState_: BackgroundState = 'unsupported';
  /** What the create dialog makes a watch of. */
  private pending_: { catalog: CatalogConfig; types: FieldTypes; conditions: WatchConditions; point: WatchArea | null } | null = null;

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly options: WatchPanelOptions,
  ) {
    button.hidden = options.catalogs.length === 0;
    button.innerHTML = '通知<span class="watch-count" hidden></span>';
    this.count_ = button.querySelector('.watch-count')!;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service watch-dialog';
    this.dialog.setAttribute('aria-labelledby', 'watch-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="watch-title">通知</h2>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <p class="service-status" role="status"></p>
      <div class="watch-notices catalog-results"><ul class="watch-list"></ul></div>
      <div class="service-actions catalog-actions">
        <button type="button" value="check" title="監視条件に合う新着画像を、いま画像カタログに問い合わせます">今すぐ確認</button>
        <button type="button" value="clear" title="通知をすべて消します（監視条件は残ります）">通知を消去</button>
        <button type="button" value="read" class="primary">すべて既読</button>
      </div>
      <details class="watch-more">
        <summary>監視条件</summary>
        <ul class="watch-watches"></ul>
        <p class="watch-background"></p>
      </details>`;
    document.body.append(this.dialog);
    this.list_ = this.dialog.querySelector('.watch-list')!;
    this.watches_ = this.dialog.querySelector('.watch-watches')!;
    this.watchSummary_ = this.dialog.querySelector('.watch-more summary')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.background_ = this.dialog.querySelector('.watch-background')!;
    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => map.removeLayer(this.footprint));
    this.dialog.querySelector('button[value=check]')!.addEventListener('click', () => void this.check(true));
    this.dialog.querySelector('button[value=read]')!.addEventListener('click', () => void markRead());
    this.dialog.querySelector('button[value=clear]')!.addEventListener('click', () => void deleteNotices());

    this.create_ = document.createElement('dialog');
    this.create_.className = 'add-service watch-create';
    this.create_.setAttribute('aria-labelledby', 'watch-create-title');
    this.create_.innerHTML = `
      <h2 id="watch-create-title">新着画像を監視</h2>
      <form method="dialog" class="service-form watch-form">
        <label class="wide">名前<input name="name" type="text" required autocomplete="off" /></label>
        <fieldset class="wide watch-areas">
          <legend>範囲</legend>
          <label class="check watch-point" hidden><input type="radio" name="area" value="point" /><span></span></label>
          <label class="check"><input type="radio" name="area" value="view" checked />いまの表示範囲</label>
          <label class="check watch-selected"><input type="radio" name="area" value="selected" />選択中の地物</label>
          <label class="check"><input type="radio" name="area" value="none" />指定しない</label>
        </fieldset>
        <p class="wide watch-conditions"></p>
        <p class="wide watch-note">登録したときにある画像は通知せず、これから入る画像だけを知らせます。</p>
        <div class="service-actions wide">
          <button type="button" value="cancel">キャンセル</button>
          <button type="submit" value="ok" class="primary">監視を始める</button>
        </div>
      </form>`;
    document.body.append(this.create_);
    this.create_.querySelector('button[value=cancel]')!.addEventListener('click', () => this.create_.close());
    this.create_.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.saveNew();
    });

    try {
      new BroadcastChannel(WATCH_CHANNEL).addEventListener('message', () => void this.refresh());
    } catch {
      // No BroadcastChannel: this window refreshes after its own changes only.
    }
    if (options.catalogs.length === 0) return;
    // As the viewer starts: what came while it was closed, then every interval while it is open.
    void this.refresh().then(() => this.check());
    setInterval(() => void this.check(), MINUTE);
    window.addEventListener('online', () => void this.check());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.check();
    });
  }

  open(): void {
    if (!this.map.getLayers().getArray().includes(this.footprint)) this.map.addLayer(this.footprint);
    this.dialog.show();
    void this.refresh();
  }

  close(): void {
    this.dialog.close();
  }

  /** The notices, newest first. */
  notices(): WatchNotice[] {
    return this.notices_;
  }

  watches(): CatalogWatch[] {
    return this.watchList_;
  }

  backgroundState(): BackgroundState {
    return this.backgroundState_;
  }

  /** Checks the watches that are due (all of them when `force`). */
  async check(force = false): Promise<void> {
    if (force) this.status_.textContent = '確認しています…';
    let added: number | null;
    try {
      added = await checkDue(this.options.ask, this.options.interval * MINUTE, force);
    } catch (error) {
      this.status_.textContent = `確認できませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    await this.refresh();
    if (added) this.options.say(`監視条件に合う新着画像が ${added} 件あります（「通知」）`);
    if (force) this.status_.textContent = added === null ? 'ほかのウィンドウが確認しています' : added ? `新着 ${added} 件` : '新着はありません';
  }

  /** Reads the watches and notices again and shows them. */
  async refresh(): Promise<void> {
    try {
      [this.watchList_, this.notices_] = await Promise.all([listWatches(), listNotices()]);
    } catch {
      this.status_.textContent = 'ブラウザの保存領域（IndexedDB）が使えないため、監視できません';
      return;
    }
    const unread = this.notices_.filter((n) => !n.read).length;
    this.count_.hidden = unread === 0;
    this.count_.textContent = unread > 99 ? '99+' : String(unread);
    this.button.title = unread ? `監視条件に合う新着画像が ${unread} 件あります` : '画像カタログの新着画像の通知と監視条件';
    void updateBadge();
    this.renderNotices();
    this.renderWatches();
    await this.syncBackground();
  }

  private renderNotices(): void {
    if (!this.notices_.length) {
      const empty = document.createElement('li');
      empty.className = 'watch-empty';
      empty.textContent = this.watchList_.length
        ? '新着画像はまだありません'
        : '監視条件がありません。「画像カタログ」で条件を決めて「この条件で監視…」を押すか、地図を右クリックして「この地点の新着画像を監視…」を選びます';
      this.list_.replaceChildren(empty);
      return;
    }
    this.list_.replaceChildren(
      ...this.notices_.map((notice) => {
        const li = document.createElement('li');
        li.className = notice.read ? 'watch-notice' : 'watch-notice unread';
        const text = document.createElement('div');
        text.className = 'watch-text';
        const title = document.createElement('strong');
        title.textContent = notice.imageId;
        const detail = document.createElement('span');
        detail.textContent = [timeText(notice.acquired), notice.sensor, notice.watchName].filter(Boolean).join(' ・ ');
        detail.title = `見つけた日時 ${timeText(notice.found)}`;
        text.append(title, detail);
        const go = document.createElement('button');
        go.type = 'button';
        go.textContent = '移動';
        go.addEventListener('click', () => this.goTo(notice));
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'primary';
        open.textContent = '開く';
        open.addEventListener('click', () => void this.openNotice(notice));
        li.append(text, go, open);
        return li;
      }),
    );
  }

  private renderWatches(): void {
    this.watchSummary_.textContent = `監視条件（${this.watchList_.length}）`;
    this.watches_.replaceChildren(
      ...this.watchList_.map((watch) => {
        const li = document.createElement('li');
        li.className = 'watch-watch';
        const on = document.createElement('input');
        on.type = 'checkbox';
        on.checked = watch.enabled;
        on.title = '監視する';
        on.setAttribute('aria-label', `${watch.name} を監視する`);
        on.addEventListener('change', () => void putWatch({ ...watch, enabled: on.checked }));
        const text = document.createElement('div');
        text.className = 'watch-text';
        const name = document.createElement('strong');
        name.textContent = watch.name;
        const detail = document.createElement('span');
        detail.textContent = conditionsText(watch);
        const state = document.createElement('span');
        state.className = watch.lastError ? 'watch-error' : 'watch-state';
        state.textContent = watch.lastError
          ? `確認できませんでした: ${watch.lastError}`
          : watch.lastChecked
            ? `最終確認 ${timeText(watch.lastChecked)}`
            : 'まだ確認していません';
        text.append(name, detail, state);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '削除';
        remove.title = 'この監視条件とその通知を消します';
        remove.addEventListener('click', () => void deleteWatch(watch.id));
        li.append(on, text, remove);
        return li;
      }),
    );
  }

  /** Registers (or drops) the installed app's Periodic Background Sync and says what checks when. */
  private async syncBackground(): Promise<void> {
    const every = `開いている間は ${this.options.interval} 分ごとと起動したときに確認します`;
    let state: BackgroundState = 'unsupported';
    try {
      const registration = await this.options.registration();
      const sync = (registration as (ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager }) | null)?.periodicSync;
      if (sync) {
        const permission = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName }).catch(() => null);
        const wanted = this.watchList_.some((w) => w.enabled);
        if (permission?.state === 'granted') {
          if (wanted) await sync.register(SYNC_TAG, { minInterval: this.options.interval * MINUTE });
          else if ((await sync.getTags()).includes(SYNC_TAG)) await sync.unregister(SYNC_TAG);
          state = 'on';
        } else state = 'off';
      }
    } catch {
      state = 'off';
    }
    this.backgroundState_ = state;
    this.background_.textContent =
      state === 'on'
        ? `${every}。アプリを閉じていても、ブラウザが動いていればブラウザが決める間隔（半日ほど）で確認し、アプリのアイコンのバッジで知らせます。`
        : state === 'off'
          ? `${every}。インストールしたアプリとして使うと、閉じている間もブラウザが決める間隔で確認できることがあります。`
          : `${every}。このブラウザは閉じている間の確認に対応していません（Chrome・Edge のインストールしたアプリのみ）。`;
  }

  /** Fits the view to a notice's footprint and outlines it. */
  goTo(notice: WatchNotice): void {
    const feature = this.featureOf(notice);
    const source = this.footprint.getSource()!;
    source.clear();
    const geometry = feature?.getGeometry();
    if (!feature || !geometry) return void this.options.say('この画像には範囲がありません');
    if (!this.map.getLayers().getArray().includes(this.footprint)) this.map.addLayer(this.footprint);
    source.addFeature(feature);
    this.map.getView().fit(geometry.getExtent(), { padding: [40, 40, 40, 40], maxZoom: 18, duration: 250 });
    if (!notice.read) void markRead([notice.id]);
  }

  /** Opens a notice's image as the catalog panel would, and marks it read. */
  async openNotice(notice: WatchNotice): Promise<void> {
    const catalog = this.catalogOf(notice);
    const feature = this.featureOf(notice);
    if (!catalog || !feature) return void this.options.say('この通知の画像カタログが見つかりません');
    const record = recordOf(feature, catalog.fields);
    if (!record.source) return void this.options.say(`${notice.imageId} には画像の場所がありません`);
    if (!notice.read) await markRead([notice.id]);
    this.options.say(`${notice.imageId} を開いています…`);
    await this.options.open(record, catalog).catch(() => undefined);
  }

  /** The catalog of a notice: config.json's of the same layer when it still lists it (fresh fields and token), else the one the watch kept. */
  private catalogOf(notice: WatchNotice): CatalogConfig | null {
    const kept = this.watchList_.find((w) => w.id === notice.watchId)?.catalog;
    return (kept && this.options.catalogs.find((c) => c.url === kept.url)) ?? kept ?? null;
  }

  private featureOf(notice: WatchNotice): Feature | null {
    try {
      return format.readFeature(notice.feature, { dataProjection: 'EPSG:4326', featureProjection: this.map.getView().getProjection() }) as Feature;
    } catch {
      return null;
    }
  }

  /**
   * Opens the dialog that makes a watch of `conditions` in `catalog`: over
   * the view, the chosen feature, `point` (a POI, preselected) or anywhere.
   */
  create(catalog: CatalogConfig, types: FieldTypes, conditions: WatchConditions, point: { lon: number; lat: number } | null = null): void {
    this.pending_ = { catalog, types, conditions, point: point ? { kind: 'point', ...point } : null };
    const form = this.create_.querySelector('form')!;
    const pointRow = form.querySelector<HTMLElement>('.watch-point')!;
    pointRow.hidden = !point;
    if (point) pointRow.querySelector('span')!.textContent = `この地点（${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}）`;
    const selected = this.options.selected().some((f) => f.getGeometry());
    form.querySelector<HTMLElement>('.watch-selected')!.hidden = !selected;
    (form.querySelector(`input[value=${point ? 'point' : 'view'}]`) as HTMLInputElement).checked = true;
    form.querySelector('.watch-conditions')!.textContent = `条件: ${conditionsText({ catalog, conditions, area: null }).split(' ・ ').filter((p) => p !== '範囲なし').join(' ・ ')}`;
    const name = form.elements.namedItem('name') as HTMLInputElement;
    name.value = [point ? `地点 ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}` : '', conditions.sensor].filter(Boolean).join(' ') || `監視 ${this.watchList_.length + 1}`;
    this.create_.showModal();
    name.select();
  }

  /** Makes the watch of the create dialog and checks it once (which notes the images already there). */
  private async saveNew(): Promise<void> {
    const pending = this.pending_;
    if (!pending) return;
    const form = this.create_.querySelector('form')!;
    const choice = (form.querySelector('input[name=area]:checked') as HTMLInputElement | null)?.value ?? 'view';
    const projection = this.map.getView().getProjection().getCode();
    let area: WatchArea | null = null;
    if (choice === 'point') area = pending.point;
    else if (choice === 'selected') {
      const geometry = this.options.selected().find((f) => f.getGeometry())?.getGeometry();
      area = geometry ? areaOf(geometry, projection) : null;
    } else if (choice === 'view') {
      const extent = transformExtent(this.map.getView().calculateExtent(this.map.getSize()), projection, 'EPSG:4326');
      const clamped = [Math.max(-180, extent[0]), Math.max(-90, extent[1]), Math.min(180, extent[2]), Math.min(90, extent[3])];
      area = { kind: 'polygon', rings: fromExtent(clamped).getCoordinates() };
    }
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim() || '監視';
    const watch: CatalogWatch = {
      id: crypto.randomUUID(),
      name,
      catalog: pending.catalog,
      types: pending.types,
      conditions: pending.conditions,
      area,
      enabled: true,
      created: Date.now(),
      lastChecked: null,
      seen: [],
    };
    this.create_.close();
    try {
      await putWatch(watch);
    } catch (error) {
      return void this.options.say(`監視条件を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.options.say(`「${name}」を監視します。新着画像は「通知」に出ます`);
    await this.check();
  }
}
