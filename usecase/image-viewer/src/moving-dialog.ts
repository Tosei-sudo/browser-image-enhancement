/**
 * 「移動体（AIS・ADS-B）」: connects feeds of ships and aircraft (those of
 * config.json's `movingFeeds`, or one by URL) and opens history files (CSV /
 * GeoJSON with a time column), each as a layer (moving-layer.ts). The fields
 * are found by name; 「詳細」 sets them by hand, with the kind of symbol, the
 * polling interval and how long tracks are drawn and objects kept.
 *
 * 「撮影時刻に合わせる」 opens the timeline at the selected image's
 * acquisition time, so the feeds show where every object was when it was
 * taken. Clicking an object shows its latest attributes in a small popup.
 */
import type OlMap from 'ol/Map.js';
import Overlay from 'ol/Overlay.js';
import type { ImageList, ViewerLayer, ViewerService } from './images.js';
import { defaultSettings, MovingLayer, type MovingSettings } from './moving-layer.js';
import { feedTypeOf, feedTypes, feedUrl, historyRows, MOVING_ROLES, movingKinds, movingRoles, utcText, type FeedConfig, type FeedType, type FieldMap, type MovingKind } from './moving.js';
import { imageTime, type Timeline } from './timeline.js';

export interface MovingDialogOptions {
  map: OlMap;
  images: ImageList;
  /** config.json's `movingFeeds`. */
  feeds: readonly FeedConfig[];
  timeline: Timeline;
  say: (message: string) => void;
  /** Whether a click on the map is free (no tool is using it), for the popup. */
  idle: () => boolean;
}

/** How long the timeline's window is when set to an acquisition time: the half hour up to it. */
const ALIGN_WINDOW = 30 * 60_000;

export class MovingDialog {
  readonly dialog: HTMLDialogElement;
  private readonly preset_: HTMLSelectElement;
  private readonly url_: HTMLInputElement;
  private readonly type_: HTMLSelectElement;
  private readonly kind_: HTMLSelectElement;
  private readonly interval_: HTMLInputElement;
  private readonly trail_: HTMLInputElement;
  private readonly stale_: HTMLInputElement;
  private readonly remove_: HTMLInputElement;
  private readonly file_: HTMLInputElement;
  private readonly list_: HTMLElement;
  private readonly note_: HTMLElement;
  private readonly roles_ = new Map<string, HTMLInputElement>();
  private readonly layers_ = new Map<MovingLayer, ViewerService>();
  private readonly popup_: Overlay;
  private readonly popupBody_: HTMLElement;
  private listTimer_: ReturnType<typeof setTimeout> | null = null;

  constructor(
    button: HTMLButtonElement | null,
    private readonly options: MovingDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service moving-dialog';
    this.dialog.setAttribute('aria-labelledby', 'moving-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="moving-title">移動体（AIS・ADS-B）</h2>
        <label class="moving-preset">登録済みのフィード<select name="preset" aria-label="登録済みのフィード"></select></label>
        <span></span>
        <button type="button" value="preset">接続</button>
        <label>URL<input name="url" type="url" placeholder="wss://… / https://…/StreamServer / https://…/positions.json" aria-label="フィードの URL" /></label>
        <label>方式<select name="type" aria-label="方式"><option value="auto">自動（URL から）</option>${Object.entries(feedTypes)
          .map(([v, l]) => `<option value="${v}">${l}</option>`)
          .join('')}</select></label>
        <button type="button" value="url">接続</button>
        <div class="wide moving-file">
          <button type="button" value="file">履歴ファイルを開く…</button>
          <span class="processing-hint">CSV（時刻・緯度・経度の列）か GeoJSON。タイムラインで時刻を動かすと、その時刻の位置を補間して表示します。</span>
          <input type="file" accept=".csv,.tsv,.txt,.geojson,.json" hidden />
        </div>
        <details class="wide moving-details">
          <summary>詳細（種別・間隔・航跡・属性の対応）</summary>
          <div class="moving-settings">
            <label>種別<select name="kind" aria-label="種別"><option value="auto">自動</option>${Object.entries(movingKinds)
              .map(([v, l]) => `<option value="${v}">${l}</option>`)
              .join('')}</select></label>
            <label>ポーリング間隔（秒）<input name="interval" type="number" min="2" step="1" value="10" /></label>
            <label>航跡（分）<input name="trail" type="number" min="0" step="1" placeholder="自動" /></label>
            <label>薄くする（分）<input name="stale" type="number" min="0" step="1" placeholder="自動" /></label>
            <label>消す（分）<input name="remove" type="number" min="1" step="1" placeholder="自動" /></label>
          </div>
          <p class="processing-hint">属性名（空欄は自動。入れ子は MetaData.MMSI のように . でつなぐ）</p>
          <div class="moving-settings moving-roles"></div>
        </details>
      </form>
      <h3 class="moving-heading">表示中のフィード</h3>
      <ul class="moving-list"></ul>
      <p class="service-status moving-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="align" title="選んだ画像の撮影時刻でタイムラインを開き、その時刻の位置を表示します">撮影時刻に合わせる</button>
        <button type="button" value="live" title="タイムラインを閉じて、最新の位置に戻します">ライブに戻す</button>
        <button type="button" value="cancel">閉じる</button>
      </div>`;
    document.body.append(this.dialog);
    const form = this.dialog.querySelector('form')!;
    const el = <T extends Element>(name: string) => form.elements.namedItem(name) as unknown as T;
    this.preset_ = el('preset');
    this.url_ = el('url');
    this.type_ = el('type');
    this.kind_ = el('kind');
    this.interval_ = el('interval');
    this.trail_ = el('trail');
    this.stale_ = el('stale');
    this.remove_ = el('remove');
    this.file_ = this.dialog.querySelector('input[type=file]')!;
    this.list_ = this.dialog.querySelector('.moving-list')!;
    this.note_ = this.dialog.querySelector('.moving-note')!;
    const roles = this.dialog.querySelector('.moving-roles')!;
    for (const role of MOVING_ROLES) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.name = `role-${role}`;
      input.placeholder = '自動';
      input.setAttribute('aria-label', `${movingRoles[role]}の属性`);
      label.append(movingRoles[role], input);
      roles.append(label);
      this.roles_.set(role, input);
    }
    this.preset_.replaceChildren(...options.feeds.map((f, i) => new Option(`${f.label}（${feedTypes[f.type]}）`, String(i))));
    this.dialog.querySelector<HTMLElement>('.moving-preset')!.hidden = !options.feeds.length;
    this.dialog.querySelector<HTMLButtonElement>('button[value=preset]')!.hidden = !options.feeds.length;
    this.dialog.querySelector('button[value=preset]')!.addEventListener('click', () => {
      const feed = options.feeds[Number(this.preset_.value)];
      if (feed) this.connect(feed);
    });
    this.dialog.querySelector('button[value=url]')!.addEventListener('click', () => this.connectUrl_());
    this.url_.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.connectUrl_();
      }
    });
    this.dialog.querySelector('button[value=file]')!.addEventListener('click', () => this.file_.click());
    this.file_.addEventListener('change', () => {
      const file = this.file_.files?.[0];
      this.file_.value = '';
      if (file) void this.openHistory(file);
    });
    this.dialog.querySelector('button[value=align]')!.addEventListener('click', () => void this.alignToImage());
    this.dialog.querySelector('button[value=live]')!.addEventListener('click', () => this.live());
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    button?.addEventListener('click', () => this.open());

    // The popup of a clicked object.
    const popup = document.createElement('div');
    popup.className = 'moving-popup';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'moving-popup-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '閉じる');
    this.popupBody_ = document.createElement('div');
    popup.append(close, this.popupBody_);
    this.popup_ = new Overlay({ element: popup, positioning: 'bottom-center', offset: [0, -14], stopEvent: true });
    close.addEventListener('click', () => this.popup_.setPosition(undefined));
    options.map.addOverlay(this.popup_);
    options.map.on('singleclick', (e) => {
      if (!this.layers_.size || !options.idle()) return;
      let found: { layer: MovingLayer; feature: import('ol/Feature.js').FeatureLike } | null = null;
      options.map.forEachFeatureAtPixel(
        e.pixel,
        (feature, layer) => {
          const moving = [...this.layers_.keys()].find((m) => m.layer === layer);
          if (moving) found = { layer: moving, feature };
          return !!moving;
        },
        { hitTolerance: 4, layerFilter: (l) => l.get('moving') === true },
      );
      if (found) this.showPopup_((found as { layer: MovingLayer }).layer, (found as { feature: import('ol/Feature.js').FeatureLike }).feature, e.coordinate);
      else this.popup_.setPosition(undefined);
    });
  }

  /** Opens the dialog. */
  open(): void {
    this.refreshList_();
    this.note_.textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** The feed layers open now. */
  feeds(): MovingLayer[] {
    const open = new Set(this.options.images.layers());
    for (const [layer, entry] of this.layers_) if (!open.has(entry)) this.layers_.delete(layer);
    return [...this.layers_.keys()];
  }

  /** The list entry of a feed layer. */
  entryOf(layer: MovingLayer): ViewerService | null {
    return this.layers_.get(layer) ?? null;
  }

  /** The feed layer of a list entry, if it is one. */
  feedOf(entry: ViewerLayer | null): MovingLayer | null {
    return this.feeds().find((m) => this.layers_.get(m) === entry) ?? null;
  }

  /** What 「詳細」 says: fields by role, the kind, the interval and the times. */
  private details_(): { fields: FieldMap; kind?: MovingKind; interval?: number; settings: Partial<MovingSettings> } {
    const fields: FieldMap = {};
    for (const [role, input] of this.roles_) if (input.value.trim()) fields[role as keyof FieldMap] = input.value.trim();
    const minutes = (input: HTMLInputElement) => (input.value.trim() !== '' && Number(input.value) >= 0 ? Number(input.value) : undefined);
    const settings: Partial<MovingSettings> = {};
    const trail = minutes(this.trail_);
    const stale = minutes(this.stale_);
    const remove = minutes(this.remove_);
    if (trail !== undefined) settings.trailMinutes = trail;
    if (stale !== undefined) settings.staleMinutes = stale;
    if (remove !== undefined) settings.removeMinutes = Math.max(remove, 0.1);
    const interval = Number(this.interval_.value);
    return {
      fields,
      ...(this.kind_.value === 'ship' || this.kind_.value === 'aircraft' ? { kind: this.kind_.value } : {}),
      ...(interval >= 2 ? { interval } : {}),
      settings,
    };
  }

  private connectUrl_(): void {
    const text = this.url_.value.trim();
    if (!text) {
      this.note_.textContent = 'URL を入れてください';
      return;
    }
    const type = this.type_.value === 'auto' ? feedTypeOf(text) : (this.type_.value as FeedType);
    try {
      feedUrl(text, type, location.href);
    } catch (error) {
      this.note_.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    let label = text;
    try {
      label = new URL(text, location.href).host || text;
    } catch {
      // The URL was checked above.
    }
    this.connect({ label, type, url: text });
  }

  /** Connects a feed (with 「詳細」's settings over its own) and adds its layer. */
  connect(feed: FeedConfig): MovingLayer {
    const details = this.details_();
    const merged: FeedConfig = {
      ...feed,
      fields: { ...feed.fields, ...details.fields },
      ...(details.kind ? { kind: details.kind } : {}),
      ...(feed.type === 'poll' && details.interval && details.interval !== 10 ? { interval: details.interval } : {}),
    };
    const layer = new MovingLayer({ feed: merged, settings: details.settings, say: this.options.say, onChange: () => this.scheduleList_() });
    this.add_(layer);
    this.options.say(`${feed.label} に接続しています`);
    return layer;
  }

  /** Opens a history file (CSV / GeoJSON) as a layer and zooms to it. */
  async openHistory(file: File): Promise<MovingLayer | null> {
    let rows;
    try {
      rows = historyRows(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (error) {
      this.note_.textContent = `${file.name} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
    const details = this.details_();
    const layer = new MovingLayer({
      feed: { label: file.name, type: 'poll', url: file.name, fields: details.fields, ...(details.kind ? { kind: details.kind } : {}) },
      settings: details.settings,
      history: true,
      say: this.options.say,
      onChange: () => this.scheduleList_(),
    });
    layer.addRows(rows);
    if (!layer.store.tracks.size) {
      layer.close();
      this.note_.textContent = `${file.name} に位置がありませんでした${layer.statusDetail ? `（${layer.statusDetail}）` : ''}`;
      return null;
    }
    const entry = this.add_(layer);
    const range = layer.store.range()!;
    const text = `${file.name}: ${layer.store.tracks.size.toLocaleString()} 件・${layer.store.fixCount.toLocaleString()} 点（${utcText(range[0])} 〜 ${utcText(range[1])}）`;
    this.note_.textContent = text;
    this.options.say(text);
    void this.options.images.zoomTo(entry);
    return layer;
  }

  private add_(layer: MovingLayer): ViewerService {
    const entry = this.options.images.addService(layer.service);
    this.layers_.set(layer, entry);
    // Shown at the timeline's time when it is open already.
    if (this.options.timeline.isOpen()) this.options.timeline.refresh();
    this.refreshList_();
    return entry;
  }

  /**
   * Opens the timeline at the selected image's acquisition time (else the
   * first image whose time is known): the feeds show where everything was then.
   */
  async alignToImage(): Promise<number | null> {
    const images = this.options.images;
    const selected = images.selectedLayer();
    const candidates = [...(selected?.type === 'image' ? [selected] : []), ...images.list().filter((l) => l !== selected)];
    for (const image of candidates) {
      const found = await imageTime(image).catch(() => null);
      if (!found) continue;
      this.alignTo(found.time);
      const text = `${image.name} の撮影時刻（${utcText(found.time)}）の位置を表示しています`;
      this.note_.textContent = text;
      this.options.say(text);
      return found.time;
    }
    const text = '撮影時刻の分かる画像がありません（タイムラインの「設定」で画像の撮影日時を入れられます）';
    this.note_.textContent = text;
    this.options.say(text);
    return null;
  }

  /** Shows every feed at `t` (the timeline's window ends there), and sets the time at once. */
  alignTo(t: number): void {
    this.options.timeline.focus(t - ALIGN_WINDOW, t);
    // The timeline hands the time to its layers a little later; the feeds take it now.
    for (const layer of this.feeds()) layer.setTime(t);
    this.refreshList_();
  }

  /** Back to the latest positions: the timeline closes. */
  live(): void {
    this.options.timeline.setOpen(false);
    for (const layer of this.feeds()) layer.setTime(null);
    this.note_.textContent = '最新の位置を表示しています';
    this.refreshList_();
  }

  private scheduleList_(): void {
    if (this.listTimer_ || !this.dialog.open) return;
    this.listTimer_ = setTimeout(() => {
      this.listTimer_ = null;
      this.refreshList_();
    }, 300);
  }

  /** A row per feed: its name, state, counts and fields, with 「切断」. */
  private refreshList_(): void {
    const rows = this.feeds().map((layer) => {
      const li = document.createElement('li');
      li.className = 'moving-row';
      const name = document.createElement('strong');
      name.textContent = layer.feed.label;
      const kind = document.createElement('span');
      kind.className = 'badge';
      kind.textContent = layer.kindText();
      const state = document.createElement('span');
      state.className = 'moving-state';
      state.textContent = layer.statusText();
      const fields = document.createElement('span');
      fields.className = 'moving-fields';
      fields.textContent = MOVING_ROLES.filter((r) => layer.mapping[r])
        .map((r) => `${movingRoles[r].replace(/（.*）/, '')}=${layer.mapping[r]}`)
        .join('、');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = layer.history ? '閉じる' : '切断';
      remove.addEventListener('click', () => {
        const entry = this.layers_.get(layer);
        if (entry) this.options.images.remove(entry);
        this.layers_.delete(layer);
        this.refreshList_();
      });
      li.append(kind, name, state, remove, fields);
      return li;
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'moving-empty';
      li.textContent = 'まだありません。登録済みのフィードか URL で接続するか、履歴ファイルを開いてください。';
      rows.push(li);
    }
    this.list_.replaceChildren(...rows);
  }

  /** The popup: the object's latest attributes. */
  private showPopup_(layer: MovingLayer, feature: import('ol/Feature.js').FeatureLike, coordinate: number[]): void {
    const track = layer.trackOf(feature);
    if (!track) return;
    const title = document.createElement('strong');
    title.textContent = track.name ? `${track.name}（${track.id}）` : track.id;
    const table = document.createElement('table');
    const row = (k: string, v: unknown) => {
      if (v === null || v === undefined || v === '') return;
      const tr = table.insertRow();
      const th = document.createElement('th');
      th.textContent = k;
      const td = tr.insertCell();
      td.textContent = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v);
      tr.prepend(th);
    };
    row('状態', feature.get('state'));
    row('時刻', feature.get('time'));
    row('緯度', feature.get('lat'));
    row('経度', feature.get('lon'));
    row('方位', track.heading);
    row('針路', track.course);
    row('速度', feature.get('speed'));
    row('種別', track.kind);
    for (const [k, v] of Object.entries(track.attrs).slice(0, 24)) row(k, v);
    const source = document.createElement('p');
    source.className = 'moving-popup-source';
    source.textContent = layer.feed.label;
    this.popupBody_.replaceChildren(title, table, source);
    this.popup_.setPosition(coordinate);
  }
}

/** The default times of each kind, for the README and tests. */
export const movingDefaults = { ship: defaultSettings('ship'), aircraft: defaultSettings('aircraft') };
