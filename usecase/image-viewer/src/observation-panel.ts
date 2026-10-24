/**
 * The 「観測記録」 panel: what is seen in each image recorded as
 * observations (observations.ts) — click the map where a thing is, say what
 * it is and what it is doing, Enter. The image, its time, the place and the
 * record's own times are filled in by themselves.
 *
 * Many images go quickly: ◀ ▶ (PageUp / PageDown) step through the open
 * images in order of acquisition time (whatever order they were opened or
 * recorded in), optionally showing only that one; the things recorded in the
 * images before (or after) show as hollow marks, and one click (or
 * 「すべてまだある」) records them as still there, 「いない」 as gone.
 *
 * 「モノ」 lists the things; choosing one shows its flow: the spans it stayed
 * doing one thing, where it moved and when it went, in a strip, a table and
 * a track on the map. Rename and merge wait under its 「詳細」, CSV and a
 * layer of everything under the panel's.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import type { FeatureLike } from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Translate from 'ol/interaction/Translate.js';
import Collection from 'ol/Collection.js';
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style.js';
import { LineString, Point } from 'ol/geom.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { boundingExtent, buffer, containsCoordinate } from 'ol/extent.js';
import type { ViewerImage } from './images.js';
import { field, type ProcessingResult } from './processing/common.js';
import { download } from './local-edit.js';
import {
  carriedInto,
  carryOvers,
  flowOf,
  flows,
  living,
  localTime,
  newObjectId,
  newObservationId,
  nextName,
  observationsCsv,
  timeKey,
  type CarryOver,
  type ObjectFlow,
  type Observation,
  type ObservationStore,
  type ObservationVocabulary,
} from './observations.js';

/** What the panel knows of an image. */
export interface ObservedImage {
  id: string;
  name: string;
  time: number | null;
  /** Its footprint, longitude / latitude box, when known. */
  box: [number, number, number, number] | null;
}

export interface ObservationPanelOptions {
  /** Where records can be kept (the first is used at first). */
  stores: ObservationStore[];
  /** The kinds and activities offered for a store. */
  vocabulary: (store: ObservationStore) => ObservationVocabulary;
  /** The open images. */
  images: () => readonly ViewerImage[];
  selected: () => ViewerImage | null;
  select: (image: ViewerImage) => void;
  isVisible: (image: ViewerImage) => boolean;
  setVisible: (image: ViewerImage, visible: boolean) => void;
  /** The image's id (catalog id, else file name), time and footprint. */
  imageInfo: (image: ViewerImage) => Promise<ObservedImage>;
  /** Recording started: other click tools stop. */
  onStart?: () => void;
  /** Adds a layer made of the records. */
  onLayer: (result: ProcessingResult, made: string) => void;
  say: (message: string) => void;
}

/** Colours of the kinds, in the order they come. */
const PALETTE = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
const ACTIVITY_COLORS = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#e11d48'];

const HINT = 'モノのある所をクリックしてください（白抜きの印は「まだある」）';
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);

export class ObservationPanel {
  readonly dialog: HTMLDialogElement;
  /** The records, the marks and the chosen thing's track, while the panel is open. */
  readonly overlay = new VectorLayer({ source: new VectorSource<Feature>(), style: (f) => this.styleOf_(f), zIndex: 1001 });
  private readonly status_: HTMLElement;
  private readonly imageSelect_: HTMLSelectElement;
  private readonly only_: HTMLInputElement;
  private readonly timeRow_: HTMLElement;
  private readonly timeInput_: HTMLInputElement;
  private readonly record_: HTMLButtonElement;
  private readonly carry_: HTMLElement;
  private readonly carryAll_: HTMLButtonElement;
  private readonly form_: HTMLFormElement;
  private readonly chips_: HTMLElement;
  private readonly tabs_: HTMLButtonElement[];
  private readonly head_: HTMLTableSectionElement;
  private readonly body_: HTMLTableSectionElement;
  private readonly flow_: HTMLElement;
  private readonly deleted_: HTMLInputElement;
  private readonly filter_: HTMLInputElement;
  private readonly storeSelect_: HTMLSelectElement;
  private readonly lists_: { objects: HTMLDataListElement; kinds: HTMLDataListElement; activities: HTMLDataListElement };
  private readonly translate_: Translate;
  private readonly movable_ = new Collection<Feature>();

  private store_: ObservationStore;
  private records_: Observation[] = [];
  private loaded_: Promise<void> | null = null;
  private info_ = new WeakMap<ViewerImage, ObservedImage>();
  /** Times typed for images that do not say (by image id). */
  private readonly manualTimes_ = new Map<string, number>();
  private ordered_: Array<{ image: ViewerImage; info: ObservedImage }> = [];
  private current_: { image: ViewerImage; info: ObservedImage } | null = null;
  private tab_: 'image' | 'objects' = 'image';
  private chosen_: string | null = null;
  private active_ = false;
  /** The place clicked, and the record edited or the thing carried over, while the form is open. */
  private pending_: { lon: number; lat: number; editing: Observation | null; from: Observation | null } | null = null;
  /** Visibility of the images before 「この画像だけ表示」. */
  private shown_: Map<ViewerImage, boolean> | null = null;
  private last_ = { kind: '', activity: '' };
  private carried_: CarryOver[] = [];

  constructor(
    private readonly map: OlMap,
    button: HTMLButtonElement | null,
    private readonly options: ObservationPanelOptions,
  ) {
    this.store_ = options.stores[0];
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service obs-dialog';
    this.dialog.setAttribute('aria-labelledby', 'obs-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="obs-title">観測記録</h2>
        <select name="store" aria-label="保存先" title="記録の保存先"></select>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <div class="obs-image">
        <button type="button" value="prev" title="前の画像（撮像日時の順、PageUp）" aria-label="前の画像">◀</button>
        <select name="image" aria-label="画像"></select>
        <button type="button" value="next" title="次の画像（撮像日時の順、PageDown）" aria-label="次の画像">▶</button>
        <label class="check" title="他の画像を隠して、この画像だけを地図に表示します"><input type="checkbox" name="only" />この画像だけ</label>
      </div>
      <label class="obs-time" hidden>撮像日時が分かりません。入力してください<input type="datetime-local" name="imageTime" step="60" /></label>
      <div class="obs-actions">
        <button type="button" value="record" class="primary" aria-pressed="false" title="地図をクリックした所に、この画像の観測を記録します（R）">クリックで記録</button>
        <span class="obs-carry"></span>
        <button type="button" value="carry-all" hidden title="前後の画像で記録したモノ（白抜きの印）を、この画像にもまだあるとしてまとめて記録します">すべて「まだある」</button>
      </div>
      <form class="service-form obs-form" hidden>
        <label>モノ<input name="object" list="obs-objects" autocomplete="off" placeholder="空欄で新しいモノ" /></label>
        <label>種別<input name="kind" list="obs-kinds" autocomplete="off" /></label>
        <div class="obs-chips wide" role="radiogroup" aria-label="活動"></div>
        <label>活動<input name="activity" list="obs-activity-list" autocomplete="off" /></label>
        <label>備考<input name="note" autocomplete="off" /></label>
        <div class="service-actions wide">
          <button type="submit" class="primary">記録（Enter）</button>
          <button type="button" value="absent" title="このモノはこの画像ではもういない（見当たらない）と記録します">いない</button>
          <button type="button" value="delete" title="この記録を削除します（「詳細」の「削除した記録も表示」から戻せます）">削除</button>
          <button type="button" value="cancel">やめる（Esc）</button>
        </div>
      </form>
      <p class="service-status" role="status"></p>
      <div class="obs-tabs" role="tablist">
        <button type="button" role="tab" value="image" aria-selected="true">この画像 <span></span></button>
        <button type="button" role="tab" value="objects" aria-selected="false">モノ <span></span></button>
      </div>
      <div class="catalog-results obs-list"><table class="catalog-table"><thead></thead><tbody></tbody></table></div>
      <section class="obs-flow" hidden></section>
      <details class="catalog-more">
        <summary>詳細</summary>
        <div class="catalog-more-body">
          <label>モノを絞り込み<input type="search" name="filter" placeholder="名前・ID・種別・活動" /></label>
          <label class="check"><input type="checkbox" name="deleted" />削除した記録も表示</label>
          <div class="service-actions wide">
            <button type="button" value="reload" title="保存先から記録を読み直します">読み直す</button>
            <button type="button" value="csv" title="すべての記録（モノ・撮像日時の順）を CSV に保存します">CSV に保存</button>
            <button type="button" value="layer" title="記録をポイント、モノの流れをラインの一時レイヤーにします（属性テーブル・タイムライン・書き出しで使えます）">レイヤーにする</button>
          </div>
        </div>
      </details>
      <datalist id="obs-objects"></datalist><datalist id="obs-kinds"></datalist><datalist id="obs-activity-list"></datalist>`;
    document.body.append(this.dialog);
    const $ = <T extends Element>(s: string) => this.dialog.querySelector<T>(s)!;
    this.status_ = $('.service-status');
    this.storeSelect_ = $('select[name=store]');
    this.imageSelect_ = $('select[name=image]');
    this.only_ = $('input[name=only]');
    this.timeRow_ = $('.obs-time');
    this.timeInput_ = $('input[name=imageTime]');
    this.record_ = $('button[value=record]');
    this.carry_ = $('.obs-carry');
    this.carryAll_ = $('button[value=carry-all]');
    this.form_ = $('.obs-form');
    this.chips_ = $('.obs-chips');
    this.tabs_ = [...this.dialog.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    this.head_ = $('.obs-list thead');
    this.body_ = $('.obs-list tbody');
    this.flow_ = $('.obs-flow');
    this.deleted_ = $('input[name=deleted]');
    this.filter_ = $('input[name=filter]');
    this.lists_ = { objects: $('#obs-objects'), kinds: $('#obs-kinds'), activities: $('#obs-activity-list') };

    options.stores.forEach((s, i) => this.storeSelect_.add(new Option(s.label, String(i))));
    this.storeSelect_.hidden = options.stores.length < 2;
    this.storeSelect_.addEventListener('change', () => {
      this.store_ = options.stores[Number(this.storeSelect_.value)] ?? options.stores[0];
      this.closeForm_();
      void this.reload();
    });
    button?.addEventListener('click', () => void this.open());
    $('.catalog-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.closed_());
    $('button[value=prev]').addEventListener('click', () => void this.step(-1));
    $('button[value=next]').addEventListener('click', () => void this.step(1));
    this.imageSelect_.addEventListener('change', () => {
      const entry = this.ordered_[Number(this.imageSelect_.value)];
      if (entry) void this.goTo(entry.image);
    });
    this.only_.addEventListener('change', () => this.applyOnly_());
    this.timeInput_.addEventListener('change', () => void this.setImageTime_());
    this.record_.addEventListener('click', () => this.setActive(!this.active_));
    this.carryAll_.addEventListener('click', () => void this.carryAll());
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit_(true);
    });
    $('button[value=absent]').addEventListener('click', () => void this.submit_(false));
    $('button[value=delete]').addEventListener('click', () => {
      const editing = this.pending_?.editing;
      if (editing) void this.remove([editing]);
    });
    $('button[value=cancel]').addEventListener('click', () => this.closeForm_());
    for (const tab of this.tabs_) tab.addEventListener('click', () => this.setTab(tab.value as 'image' | 'objects'));
    this.deleted_.addEventListener('change', () => this.render_());
    this.filter_.addEventListener('input', () => this.render_());
    $('button[value=reload]').addEventListener('click', () => void this.reload());
    $('button[value=csv]').addEventListener('click', () => this.saveCsv());
    $('button[value=layer]').addEventListener('click', () => this.toLayers());
    this.form_.querySelector<HTMLInputElement>('input[name=object]')!.addEventListener('change', () => this.objectTyped_());

    // Keys: PageUp / PageDown step through the images, R records, 1–9 pick an activity, Esc closes the form.
    this.dialog.addEventListener('keydown', (e) => this.key_(e));
    document.addEventListener('keydown', (e) => {
      if (!this.dialog.open || this.dialog.contains(e.target as Node)) return;
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable=true], dialog')) return;
      this.key_(e);
    });

    this.translate_ = new Translate({ features: this.movable_ });
    this.translate_.on('translateend', (e) => {
      const feature = e.features.item(0) as Feature<Point> | undefined;
      const record = feature?.get('record') as Observation | undefined;
      if (!feature || !record) return;
      const [lon, lat] = toLonLat(feature.getGeometry()!.getCoordinates());
      void this.saveRecords_([{ ...record, lon, lat, updatedAt: Date.now() }], `${record.objectName} の場所を直しました`);
    });
    this.translate_.setActive(false);
    map.addInteraction(this.translate_);
    map.on('singleclick', (e) => {
      if (!this.active_ || !this.dialog.open) return;
      const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f as Feature, { layerFilter: (l) => l === this.overlay, hitTolerance: 6 });
      const [lon, lat] = toLonLat(e.coordinate);
      this.clicked_(lon, lat, hit ?? null);
    });
  }

  /** The records loaded (deleted ones too). */
  records(): readonly Observation[] {
    return this.records_;
  }

  /** Every thing's flow. */
  flows(): ObjectFlow[] {
    return flows(this.records_);
  }

  /** The image recorded now. */
  current(): ObservedImage | null {
    return this.current_?.info ?? null;
  }

  /** What may still be there in this image. */
  carried(): readonly CarryOver[] {
    return this.carried_;
  }

  isActive(): boolean {
    return this.active_;
  }

  /** Turns 「クリックで記録」 on or off. */
  setActive(on: boolean, quiet = false): void {
    if (on && !this.current_) {
      this.say_('先に画像を開いてください');
      on = false;
    }
    if (on === this.active_) return;
    this.active_ = on;
    if (on) this.options.onStart?.();
    this.record_.setAttribute('aria-pressed', String(on));
    this.record_.textContent = on ? '記録中（クリック）' : 'クリックで記録';
    this.translate_.setActive(on);
    this.map.getViewport().classList.toggle('observing', on);
    if (!on) this.closeForm_();
    else if (!quiet) this.say_(HINT);
  }

  /** Opens the panel on the selected image (or the first one). */
  async open(): Promise<void> {
    if (!this.map.getLayers().getArray().includes(this.overlay)) this.map.addLayer(this.overlay);
    if (!this.dialog.open) this.dialog.show();
    this.loaded_ ??= this.reload();
    await Promise.all([this.loaded_, this.refreshImages()]);
    if (this.current_ && !this.active_) {
      this.setActive(true, true);
      this.status_.textContent += `。${HINT}`;
    }
  }

  /** Reads the records again from the store. */
  async reload(): Promise<void> {
    this.say_(`${this.store_.label} から読み込んでいます…`);
    try {
      this.records_ = await this.store_.load();
      this.say_(`${this.store_.label}: ${living(this.records_).length} 件の記録、${flows(this.records_).length} のモノ`);
    } catch (error) {
      this.records_ = [];
      this.say_(`${this.store_.label} から読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.render_();
  }

  /** The open images again (call when they change): in order of acquisition time. */
  async refreshImages(): Promise<void> {
    const list = this.options.images();
    const entries = await Promise.all(
      list.map(async (image) => {
        let info = this.info_.get(image);
        if (!info) {
          info = await this.options.imageInfo(image).catch(() => ({ id: image.name, name: image.name, time: null, box: null }));
          this.info_.set(image, info);
        }
        const manual = this.manualTimes_.get(info.id);
        return { image, info: info.time === null && manual !== undefined ? { ...info, time: manual } : info };
      }),
    );
    this.ordered_ = entries.sort((a, b) => (a.info.time ?? Infinity) - (b.info.time ?? Infinity) || a.info.name.localeCompare(b.info.name));
    if (this.shown_) for (const image of this.shown_.keys()) if (!list.includes(image)) this.shown_.delete(image);
    const selected = this.options.selected();
    const keep = this.current_ && this.ordered_.find((e) => e.image === this.current_!.image);
    this.current_ = keep ?? this.ordered_.find((e) => e.image === selected) ?? this.ordered_[0] ?? null;
    if (!this.current_) this.setActive(false);
    this.imageSelect_.replaceChildren(
      ...this.ordered_.map((e, i) => new Option(`${e.info.time !== null ? localTime(e.info.time) : '日時不明'}  ${e.info.name}`, String(i), false, e === this.current_)),
    );
    if (!this.ordered_.length) this.imageSelect_.add(new Option('画像を開いてください', ''));
    this.applyOnly_();
    this.render_();
  }

  /** Records on `image` from now on. */
  async goTo(image: ViewerImage): Promise<void> {
    if (!this.ordered_.some((e) => e.image === image)) await this.refreshImages();
    const entry = this.ordered_.find((e) => e.image === image);
    if (!entry) return;
    this.closeForm_();
    this.current_ = entry;
    this.imageSelect_.value = String(this.ordered_.indexOf(entry));
    if (this.options.selected() !== image) this.options.select(image);
    this.applyOnly_();
    this.render_();
  }

  /** The next (or previous) image in time. */
  async step(by: number): Promise<void> {
    if (!this.ordered_.length) return;
    const at = this.current_ ? this.ordered_.indexOf(this.current_) : -1;
    const next = this.ordered_[Math.min(this.ordered_.length - 1, Math.max(0, at + by))];
    if (next && next !== this.current_) await this.goTo(next.image);
  }

  /** Shows a tab. */
  setTab(tab: 'image' | 'objects'): void {
    this.tab_ = tab;
    for (const t of this.tabs_) t.setAttribute('aria-selected', String(t.value === tab));
    this.render_();
  }

  /** Shows a thing's flow (null: none). */
  choose(objectId: string | null): void {
    this.chosen_ = objectId;
    if (objectId && this.tab_ !== 'objects') this.setTab('objects');
    else this.render_();
  }

  /** Records every carried-over thing as still there in this image. */
  async carryAll(): Promise<void> {
    const image = this.current_?.info;
    if (!image || !this.carried_.length) return;
    const now = Date.now();
    const made = this.carried_.map((c) => carriedInto(c.from, image, now));
    await this.saveRecords_(made, `${made.length} のモノを「まだある」として記録しました`);
  }

  /** Records a carried-over thing in this image: still there (with changes), or gone. */
  async carry(objectId: string, present = true, changes: Partial<Observation> = {}): Promise<void> {
    const image = this.current_?.info;
    const c = this.carried_.find((x) => x.from.objectId === objectId);
    if (!image || !c) return;
    const record = carriedInto(c.from, image, Date.now(), { present, ...(present ? {} : { activity: '' }), ...changes });
    await this.saveRecords_([record], `${record.objectName} を${present ? '「まだある」' : '「いない」'}として記録しました`);
  }

  /** Records a new observation (as the form does), for scripts and tests. */
  async add(values: { lon: number; lat: number; object?: string; kind?: string; activity?: string; note?: string; present?: boolean }): Promise<Observation | null> {
    const image = this.current_?.info;
    if (!image) return null;
    const record = this.recordFrom_(image, values.lon, values.lat, null, null, { object: values.object ?? '', kind: values.kind ?? this.last_.kind, activity: values.activity ?? this.last_.activity, note: values.note ?? '' }, values.present ?? true);
    await this.saveRecords_([record], `${record.objectName} を記録しました`);
    return record;
  }

  /** Deletes records (kept, marked, where the store does). */
  async remove(list: readonly Observation[]): Promise<void> {
    if (!list.length) return;
    try {
      const marked = await this.store_.remove(list);
      const ids = new Set(list.map((o) => o.id));
      const kept = new Map(marked.map((o) => [o.id, o]));
      this.records_ = this.records_.flatMap((o) => (ids.has(o.id) ? (kept.has(o.id) ? [kept.get(o.id)!] : []) : [o]));
      this.closeForm_();
      this.say_(`${list.length} 件の記録を削除しました`);
    } catch (error) {
      this.say_(`削除できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.render_();
  }

  /** Brings deleted records back. */
  async restore(list: readonly Observation[]): Promise<void> {
    const now = Date.now();
    await this.saveRecords_(list.map((o) => ({ ...o, deletedAt: null, updatedAt: now })), `${list.length} 件の記録を戻しました`);
  }

  /** Renames a thing in all its records. */
  async rename(objectId: string, name: string, kind?: string): Promise<void> {
    const now = Date.now();
    const list = this.records_.filter((o) => o.objectId === objectId).map((o) => ({ ...o, objectName: name, ...(kind !== undefined ? { kind } : {}), updatedAt: now }));
    await this.saveRecords_(list, `モノの名前を「${name}」にしました`);
  }

  /** Makes `from`'s records `into`'s (the same thing recorded as two). */
  async merge(from: string, into: string): Promise<void> {
    if (from === into) return;
    const target = flowOf(living(this.records_).filter((o) => o.objectId === into));
    const now = Date.now();
    const list = this.records_.filter((o) => o.objectId === from).map((o) => ({ ...o, objectId: into, objectName: target.name, kind: target.kind || o.kind, updatedAt: now }));
    this.chosen_ = into;
    await this.saveRecords_(list, `${list.length} 件の記録を「${target.name}」にまとめました`);
  }

  /** Saves the records as CSV. */
  saveCsv(): void {
    const list = this.deleted_.checked ? this.records_ : living(this.records_);
    if (!list.length) return this.say_('記録がありません');
    const d = new Date();
    download(`observations_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`, observationsCsv(list), 'text/csv');
  }

  /** Adds the records as a point layer and the flows as a line layer. */
  toLayers(): void {
    const list = living(this.records_);
    if (!list.length) return this.say_('記録がありません');
    const points = list.map((o) => {
      const f = new Feature(new Point(fromLonLat([o.lon, o.lat])));
      f.setProperties({ obs_id: o.id, object_id: o.objectId, object: o.objectName, kind: o.kind, activity: o.activity, present: o.present ? 'あり' : 'なし', image_time: o.imageTime, image_id: o.imageId, image: o.imageName, note: o.note, created_at: o.createdAt, updated_at: o.updatedAt });
      return f;
    });
    this.options.onLayer(
      {
        title: '観測記録',
        features: points,
        fields: [
          field('obs_id', 'string', '観測ID'),
          field('object_id', 'string', 'モノID'),
          field('object', 'string', 'モノ'),
          field('kind', 'string', '種別'),
          field('activity', 'string', '活動'),
          field('present', 'string', '有無'),
          field('image_time', 'date', '撮像日時'),
          field('image_id', 'string', '画像ID'),
          field('image', 'string', '画像'),
          field('note', 'string', '備考'),
          field('created_at', 'date', '登録日時'),
          field('updated_at', 'date', '更新日時'),
        ],
      },
      '観測記録',
    );
    const lines = flows(list)
      .map((flow) => {
        const seen = flow.observations.filter((o) => o.present);
        if (seen.length < 2) return null;
        const f = new Feature(new LineString(seen.map((o) => fromLonLat([o.lon, o.lat]))));
        f.setProperties({ object_id: flow.objectId, object: flow.name, kind: flow.kind, first: flow.first, last: flow.last, images: flow.seen, distance_m: Math.round(flow.distance), activity: flow.activity });
        return f;
      })
      .filter((f): f is Feature<LineString> => f !== null);
    if (lines.length) {
      this.options.onLayer(
        {
          title: '観測の流れ',
          features: lines,
          fields: [
            field('object_id', 'string', 'モノID'),
            field('object', 'string', 'モノ'),
            field('kind', 'string', '種別'),
            field('first', 'date', '初出'),
            field('last', 'date', '最終'),
            field('images', 'integer', '画像数'),
            field('distance_m', 'double', '移動距離（m）'),
            field('activity', 'string', '最新の活動'),
          ],
        },
        '観測の流れ',
      );
    }
  }

  // ---- inside ----

  private say_(message: string): void {
    this.status_.textContent = message;
  }

  private closed_(): void {
    this.setActive(false);
    this.closeForm_();
    if (this.only_.checked) {
      this.only_.checked = false;
      this.applyOnly_();
    }
    this.map.removeLayer(this.overlay);
  }

  private key_(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const inText = (e.target as HTMLElement)?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea, select');
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      void this.step(e.key === 'PageDown' ? 1 : -1);
    } else if (e.key === 'Escape' && !this.form_.hidden) {
      e.preventDefault();
      e.stopPropagation();
      this.closeForm_();
    } else if (!inText && /^[1-9]$/.test(e.key) && !this.form_.hidden) {
      const chip = this.chips_.querySelectorAll<HTMLButtonElement>('button')[Number(e.key) - 1];
      if (chip) {
        e.preventDefault();
        chip.click();
      }
    } else if (!inText && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      this.setActive(!this.active_);
    }
  }

  private vocabulary_(): ObservationVocabulary {
    return this.options.vocabulary(this.store_);
  }

  /** The current image's footprint test. */
  private inside_(): ((lon: number, lat: number) => boolean) | undefined {
    const box = this.current_?.info.box;
    if (!box) return undefined;
    const [w, s, e, n] = box;
    return (lon, lat) => lon >= w && lon <= e && lat >= s && lat <= n;
  }

  private applyOnly_(): void {
    const images = this.options.images();
    if (this.only_.checked && this.current_) {
      this.shown_ ??= new Map(images.map((i) => [i, this.options.isVisible(i)]));
      for (const i of images) {
        if (!this.shown_.has(i)) this.shown_.set(i, this.options.isVisible(i));
        this.options.setVisible(i, i === this.current_.image);
      }
    } else if (this.shown_) {
      for (const [i, v] of this.shown_) if (images.includes(i)) this.options.setVisible(i, v);
      this.shown_ = null;
    }
  }

  private async setImageTime_(): Promise<void> {
    const entry = this.current_;
    const t = this.timeInput_.value ? new Date(this.timeInput_.value).getTime() : NaN;
    if (!entry || !Number.isFinite(t)) return;
    this.manualTimes_.set(entry.info.id, t);
    // The records made without a time get it.
    const now = Date.now();
    const timeless = this.records_.filter((o) => o.imageId === entry.info.id && o.imageTime === null).map((o) => ({ ...o, imageTime: t, updatedAt: now }));
    await this.refreshImages();
    if (timeless.length) await this.saveRecords_(timeless, `${timeless.length} 件の記録に撮像日時を入れました`);
  }

  /** A click on the map while recording. */
  private clicked_(lon: number, lat: number, hit: Feature | null): void {
    const role = hit?.get('role');
    const record = hit?.get('record') as Observation | undefined;
    if (role === 'obs' && record) return this.openForm_(record.lon, record.lat, record, null);
    if (role === 'ghost' && record) return this.openForm_(record.lon, record.lat, null, record);
    this.openForm_(lon, lat, null, null);
  }

  /** Opens the form for a new record at a place, a record to change, or a thing carried over. */
  private openForm_(lon: number, lat: number, editing: Observation | null, from: Observation | null): void {
    this.pending_ = { lon, lat, editing, from };
    const source = editing ?? from;
    const input = (name: string) => this.form_.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    input('object').value = source ? source.objectName : '';
    input('kind').value = source ? source.kind : this.last_.kind || this.vocabulary_().kinds[0] || '';
    input('activity').value = source ? source.activity : this.last_.activity;
    input('note').value = editing ? editing.note : '';
    this.form_.querySelector<HTMLButtonElement>('button[value=delete]')!.hidden = !editing;
    this.form_.querySelector<HTMLButtonElement>('button[value=absent]')!.hidden = !source;
    this.form_.querySelector<HTMLButtonElement>('button[type=submit]')!.textContent = editing ? '更新（Enter）' : from ? 'まだある（Enter）' : '記録（Enter）';
    this.form_.hidden = false;
    this.renderChips_();
    this.drawMarks_();
    // A new thing gets its name typed; a known one is saved with Enter (or 1–9 picks its activity first).
    (source ? this.form_.querySelector<HTMLButtonElement>('button[type=submit]')! : input('object')).focus({ preventScroll: true });
  }

  private closeForm_(): void {
    if (!this.pending_ && this.form_.hidden) return;
    this.pending_ = null;
    this.form_.hidden = true;
    this.drawMarks_();
  }

  /** A known thing's name typed: its kind and latest activity come with it. */
  private objectTyped_(): void {
    const name = this.form_.querySelector<HTMLInputElement>('input[name=object]')!.value.trim();
    const flow = this.flowByName_(name);
    if (!flow) return;
    this.form_.querySelector<HTMLInputElement>('input[name=kind]')!.value = flow.kind;
    const activity = this.form_.querySelector<HTMLInputElement>('input[name=activity]')!;
    if (!activity.value) activity.value = flow.activity;
    this.renderChips_();
  }

  private flowByName_(name: string): ObjectFlow | null {
    if (!name) return null;
    const all = flows(this.records_);
    return all.find((f) => f.name === name) ?? all.find((f) => f.objectId === name) ?? null;
  }

  /** The record the form says. */
  private recordFrom_(image: ObservedImage, lon: number, lat: number, editing: Observation | null, from: Observation | null, values: { object: string; kind: string; activity: string; note: string }, present: boolean): Observation {
    const now = Date.now();
    const name = values.object.trim();
    const kind = values.kind.trim();
    const activity = present ? values.activity.trim() : '';
    if (editing) {
      // The same thing unless another one's name was typed.
      const other = name && name !== editing.objectName ? this.flowByName_(name) : null;
      return { ...editing, objectId: other ? other.objectId : editing.objectId, objectName: other ? other.name : name || editing.objectName, kind, activity, present, note: values.note, lon, lat, updatedAt: now };
    }
    const known = from && (!name || name === from.objectName) ? { objectId: from.objectId, name: from.objectName } : this.flowByName_(name) ? { objectId: this.flowByName_(name)!.objectId, name: this.flowByName_(name)!.name } : null;
    return {
      id: newObservationId(),
      imageId: image.id,
      imageName: image.name,
      imageTime: image.time,
      objectId: known?.objectId ?? newObjectId(),
      objectName: known?.name ?? (name || nextName(kind, new Set(flows(this.records_).map((f) => f.name)))),
      kind,
      activity,
      present,
      note: values.note,
      lon,
      lat,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  private async submit_(present: boolean): Promise<void> {
    const image = this.current_?.info;
    const pending = this.pending_;
    if (!image || !pending) return;
    const value = (name: string) => this.form_.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value;
    const values = { object: value('object'), kind: value('kind'), activity: value('activity'), note: value('note') };
    const record = this.recordFrom_(image, pending.lon, pending.lat, pending.editing, pending.from, values, present);
    this.last_ = { kind: record.kind, activity: present ? record.activity : this.last_.activity };
    this.closeForm_();
    await this.saveRecords_([record], `${record.objectName}${present ? (record.activity ? `（${record.activity}）` : '') : '（いない）'}を${pending.editing ? '更新' : '記録'}しました`);
  }

  /** Saves records in the store and in the list. */
  private async saveRecords_(list: Observation[], done: string): Promise<void> {
    if (!list.length) return;
    try {
      await this.store_.save(list);
      const byId = new Map(list.map((o) => [o.id, o]));
      this.records_ = [...this.records_.map((o) => byId.get(o.id) ?? o), ...list.filter((o) => !this.records_.some((r) => r.id === o.id))];
      this.say_(done);
    } catch (error) {
      this.say_(`${this.store_.label} に保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.render_();
  }

  private renderChips_(): void {
    const activity = this.form_.querySelector<HTMLInputElement>('input[name=activity]')!;
    const used = new Set(living(this.records_).map((o) => o.activity).filter(Boolean));
    const words = [...new Set([...this.vocabulary_().activities, ...used])].slice(0, 9);
    this.chips_.replaceChildren(
      ...words.map((w, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(activity.value === w));
        b.title = `${w}（${i + 1}）`;
        b.textContent = `${i + 1} ${w}`;
        b.addEventListener('click', () => {
          activity.value = w;
          this.renderChips_();
        });
        return b;
      }),
    );
  }

  private render_(): void {
    const image = this.current_?.info ?? null;
    this.timeRow_.hidden = !image || image.time !== null;
    const all = this.deleted_.checked ? this.records_ : living(this.records_);
    this.carried_ = image ? carryOvers(this.records_, image, this.inside_()) : [];
    this.carry_.textContent = this.carried_.length ? `前後の画像から ${this.carried_.length} のモノ` : '';
    this.carryAll_.hidden = !this.carried_.length;
    const here = image ? all.filter((o) => o.imageId === image.id).sort((a, b) => a.objectName.localeCompare(b.objectName, 'ja')) : [];
    const objects = flows(this.records_);
    this.tabs_[0].querySelector('span')!.textContent = String(here.filter((o) => o.deletedAt === null).length);
    this.tabs_[1].querySelector('span')!.textContent = String(objects.length);
    // What the form offers.
    const vocabulary = this.vocabulary_();
    const options = (list: HTMLDataListElement, values: Iterable<string>) => list.replaceChildren(...[...new Set(values)].filter(Boolean).map((v) => new Option(v)));
    options(this.lists_.objects, objects.map((f) => f.name));
    options(this.lists_.kinds, [...vocabulary.kinds, ...objects.map((f) => f.kind)]);
    options(this.lists_.activities, [...vocabulary.activities, ...living(this.records_).map((o) => o.activity)]);
    if (this.tab_ === 'image') this.renderImage_(here);
    else this.renderObjects_(objects);
    this.renderFlow_();
    this.drawMarks_();
  }

  private row_(cells: Array<string | Node>, onClick?: () => void, className = ''): HTMLTableRowElement {
    const tr = document.createElement('tr');
    if (className) tr.className = className;
    for (const c of cells) {
      const td = document.createElement('td');
      td.append(c);
      tr.append(td);
    }
    if (onClick) tr.addEventListener('click', (e) => !(e.target as HTMLElement).closest('button') && onClick());
    return tr;
  }

  private setHead_(...names: string[]): void {
    const tr = document.createElement('tr');
    for (const n of names) {
      const th = document.createElement('th');
      th.textContent = n;
      tr.append(th);
    }
    this.head_.replaceChildren(tr);
  }

  private button_(label: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', run);
    return b;
  }

  private renderImage_(here: Observation[]): void {
    this.setHead_('モノ', '種別', '活動', '備考', '更新', '');
    const rows: HTMLTableRowElement[] = here.map((o) =>
      this.row_(
        [o.objectName, o.kind, o.present ? o.activity : 'いない', o.note, localTime(o.updatedAt), o.deletedAt !== null ? this.button_('戻す', '削除した記録を戻します', () => void this.restore([o])) : this.button_('流れ', 'このモノの流れを見ます', () => this.choose(o.objectId))],
        () => {
          if (o.deletedAt !== null) return;
          this.openForm_(o.lon, o.lat, o, null);
          this.center_(o);
        },
        o.deletedAt !== null ? 'obs-deleted' : '',
      ),
    );
    for (const c of this.carried_) {
      const actions = document.createElement('span');
      actions.className = 'obs-row-actions';
      actions.append(this.button_('まだある', 'この画像にもまだあるとして記録します', () => void this.carry(c.from.objectId, true)), this.button_('いない', 'この画像ではもういないと記録します', () => void this.carry(c.from.objectId, false)));
      rows.push(
        this.row_([c.from.objectName, c.from.kind, `${c.from.activity}（${c.side === 'before' ? '前' : '後'}の画像 ${localTime(c.from.imageTime)}）`, '', '', actions], () => {
          if (!this.active_) this.setActive(true);
          this.openForm_(c.from.lon, c.from.lat, null, c.from);
          this.center_(c.from);
        }, 'obs-ghost'),
      );
    }
    if (!rows.length) rows.push(this.row_([this.current_ ? 'まだ記録がありません。「クリックで記録」で地図をクリックしてください' : '画像を開いてください']));
    this.body_.replaceChildren(...rows);
  }

  private renderObjects_(objects: ObjectFlow[]): void {
    this.setHead_('モノ', '種別', '最新', '初出', '最終', '画像');
    const q = this.filter_.value.trim().toLowerCase();
    const shown = q ? objects.filter((f) => [f.name, f.objectId, f.kind, ...f.observations.map((o) => o.activity)].some((v) => v.toLowerCase().includes(q))) : objects;
    const rows = shown.map((f) => {
      const tr = this.row_([f.name, f.kind, f.present ? f.activity : 'いない', localTime(f.first), localTime(f.last), String(f.seen)], () => this.choose(this.chosen_ === f.objectId ? null : f.objectId));
      tr.setAttribute('aria-selected', String(f.objectId === this.chosen_));
      tr.addEventListener('dblclick', () => this.fitFlow_(f));
      return tr;
    });
    if (!rows.length) rows.push(this.row_([objects.length ? '当てはまるモノがありません' : 'まだ記録がありません']));
    this.body_.replaceChildren(...rows);
  }

  /** The chosen thing's flow: summary, strip, steps and its own 「詳細」. */
  private renderFlow_(): void {
    const records = this.chosen_ ? living(this.records_).filter((o) => o.objectId === this.chosen_) : [];
    this.flow_.hidden = this.tab_ !== 'objects' || !records.length;
    if (this.flow_.hidden) return this.flow_.replaceChildren();
    const flow = flowOf(records);
    const title = document.createElement('h3');
    title.textContent = `${flow.name}（${flow.kind || '種別なし'}・${flow.objectId}）`;
    const summary = document.createElement('p');
    summary.className = 'obs-summary';
    summary.textContent = `${localTime(flow.first)} 〜 ${localTime(flow.last)}・${flow.seen} 画像で確認・移動 ${km(flow.distance)}・最新: ${flow.present ? flow.activity || '活動の記録なし' : 'いない'}`;
    const strip = this.strip_(flow);
    const table = document.createElement('table');
    table.className = 'catalog-table obs-steps';
    table.innerHTML = '<thead><tr><th>期間</th><th>活動</th><th>画像</th><th>移動</th></tr></thead><tbody></tbody>';
    table.tBodies[0].append(
      ...flow.steps.map((s) =>
        this.row_(
          [s.from === s.to ? localTime(s.from) : `${localTime(s.from)} 〜 ${localTime(s.to)}`, s.present ? s.activity || '—' : 'いない', String(s.count), s.moved !== null && s.moved > 0 ? km(s.moved) : ''],
          () => void this.openRecord_(s.observations[0]),
          s.present ? '' : 'obs-absent',
        ),
      ),
    );
    // Rename and merge: corrections, out of the way.
    const more = document.createElement('details');
    more.className = 'catalog-more obs-flow-more';
    more.innerHTML = `<summary>このモノの詳細</summary><div class="catalog-more-body">
      <label>名前<input name="rename" autocomplete="off" /></label>
      <label>種別<input name="rekind" list="obs-kinds" autocomplete="off" /></label>
      <label class="wide">同じモノとしてまとめる<select name="merge"><option value="">まとめる先のモノ…</option></select></label>
      <div class="service-actions wide"><button type="button" value="apply">名前・種別を変える</button><button type="button" value="merge">まとめる</button><button type="button" value="fit">範囲へ移動</button><button type="button" value="delete-all">このモノの記録を削除</button></div></div>`;
    more.querySelector<HTMLInputElement>('input[name=rename]')!.value = flow.name;
    more.querySelector<HTMLInputElement>('input[name=rekind]')!.value = flow.kind;
    const merge = more.querySelector<HTMLSelectElement>('select[name=merge]')!;
    for (const f of flows(this.records_)) if (f.objectId !== flow.objectId) merge.add(new Option(`${f.name}（${f.kind}・${localTime(f.last)}）`, f.objectId));
    more.querySelector('button[value=apply]')!.addEventListener('click', () => void this.rename(flow.objectId, more.querySelector<HTMLInputElement>('input[name=rename]')!.value.trim() || flow.name, more.querySelector<HTMLInputElement>('input[name=rekind]')!.value.trim()));
    more.querySelector('button[value=merge]')!.addEventListener('click', () => merge.value && void this.merge(flow.objectId, merge.value));
    more.querySelector('button[value=fit]')!.addEventListener('click', () => this.fitFlow_(flow));
    const removeAll = more.querySelector<HTMLButtonElement>('button[value=delete-all]')!;
    removeAll.addEventListener('click', () => {
      // Two steps, so one click never deletes a thing's records.
      if (removeAll.dataset.armed !== '1') {
        removeAll.dataset.armed = '1';
        removeAll.textContent = 'もう一度押すと削除';
        return;
      }
      void this.remove(flow.observations);
    });
    const open = this.flow_.querySelector<HTMLDetailsElement>('.obs-flow-more')?.open ?? false;
    more.open = open && this.flow_.dataset.object === flow.objectId;
    this.flow_.dataset.object = flow.objectId;
    this.flow_.replaceChildren(title, summary, strip, table, more);
  }

  /** The flow along time: a bar per step, coloured by activity, the images as ticks. */
  private strip_(flow: ObjectFlow): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'obs-strip');
    svg.setAttribute('viewBox', '0 0 1000 34');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    // The last record stands for a stretch as long as the mean gap between records, so the last step shows.
    const gap = flow.observations.length > 1 ? (flow.last - flow.first) / (flow.observations.length - 1) : 0;
    const span = Math.max(1, flow.last + gap - flow.first);
    const x = (t: number) => (flow.first === flow.last ? 500 : 10 + ((t - flow.first) / span) * 980);
    const activities = [...new Set(flow.steps.map((s) => s.activity))];
    const label: string[] = [];
    flow.steps.forEach((s, i) => {
      const next = flow.steps[i + 1];
      const from = x(s.from);
      // A step lasts until the next one starts.
      const to = next ? x(next.from) : Math.max(x(s.to + gap), from + 6);
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(from));
      rect.setAttribute('y', '6');
      rect.setAttribute('width', String(Math.max(6, to - from)));
      rect.setAttribute('height', '14');
      rect.setAttribute('rx', '3');
      rect.setAttribute('class', s.present ? 'obs-step' : 'obs-step absent');
      if (s.present) rect.setAttribute('fill', ACTIVITY_COLORS[activities.indexOf(s.activity) % ACTIVITY_COLORS.length]);
      const tip = document.createElementNS(ns, 'title');
      tip.textContent = `${s.present ? s.activity || '—' : 'いない'}: ${localTime(s.from)}${s.to !== s.from ? ` 〜 ${localTime(s.to)}` : ''}`;
      rect.append(tip);
      svg.append(rect);
      label.push(tip.textContent);
    });
    for (const o of flow.observations) {
      const tick = document.createElementNS(ns, 'rect');
      tick.setAttribute('x', String(x(timeKey(o)) - 1));
      tick.setAttribute('y', '22');
      tick.setAttribute('width', '2');
      tick.setAttribute('height', '8');
      tick.setAttribute('class', 'obs-tick');
      svg.append(tick);
    }
    svg.setAttribute('aria-label', label.join('、'));
    return svg;
  }

  /** Goes to a record's image and opens it in the form. */
  private async openRecord_(o: Observation): Promise<void> {
    const entry = this.ordered_.find((e) => e.info.id === o.imageId);
    if (entry && entry !== this.current_) await this.goTo(entry.image);
    this.center_(o);
    if (entry) {
      if (!this.active_) this.setActive(true);
      this.openForm_(o.lon, o.lat, o, null);
    } else this.say_(`この記録の画像（${o.imageName || o.imageId}）は開いていません`);
  }

  private center_(o: Observation): void {
    const view = this.map.getView();
    const at = fromLonLat([o.lon, o.lat]);
    const extent = view.calculateExtent(this.map.getSize());
    if (!containsCoordinate(buffer(extent, -(extent[2] - extent[0]) * 0.1), at)) view.animate({ center: at, duration: 200 });
  }

  private fitFlow_(flow: ObjectFlow): void {
    const coords = flow.observations.map((o) => fromLonLat([o.lon, o.lat]));
    const extent = boundingExtent(coords);
    this.map.getView().fit(buffer(extent, 200), { padding: [60, 60, 60, 60], maxZoom: 18, duration: 250 });
  }

  /** The marks on the map: this image's records, the things carried over, the chosen flow and the clicked place. */
  private drawMarks_(): void {
    const source = this.overlay.getSource()!;
    source.clear();
    this.movable_.clear();
    const image = this.current_?.info;
    const features: Feature[] = [];
    const chosen = this.chosen_ ? living(this.records_).filter((o) => o.objectId === this.chosen_) : [];
    if (chosen.length && this.tab_ === 'objects') {
      const flow = flowOf(chosen);
      const seen = flow.observations.filter((o) => o.present);
      if (seen.length > 1) features.push(new Feature({ geometry: new LineString(seen.map((o) => fromLonLat([o.lon, o.lat]))), role: 'track' }));
      for (const o of flow.observations) features.push(new Feature({ geometry: new Point(fromLonLat([o.lon, o.lat])), role: 'step', label: `${localTime(o.imageTime).slice(5)}${o.present ? '' : '（いない）'}`, present: o.present }));
    }
    if (image) {
      for (const c of this.carried_) features.push(new Feature({ geometry: new Point(fromLonLat([c.from.lon, c.from.lat])), role: 'ghost', record: c.from, kind: c.from.kind, label: c.from.objectName }));
      for (const o of living(this.records_)) {
        if (o.imageId !== image.id) continue;
        const f = new Feature({ geometry: new Point(fromLonLat([o.lon, o.lat])), role: 'obs', record: o, kind: o.kind, label: `${o.objectName}${o.present ? (o.activity ? `・${o.activity}` : '') : '（いない）'}`, present: o.present, editing: this.pending_?.editing?.id === o.id });
        features.push(f);
        this.movable_.push(f);
      }
    }
    const p = this.pending_;
    if (p && !p.editing) features.push(new Feature({ geometry: new Point(fromLonLat([p.lon, p.lat])), role: 'pending' }));
    source.addFeatures(features);
  }

  private colorOf_(kind: string): string {
    const kinds = [...new Set([...this.vocabulary_().kinds, ...flows(this.records_).map((f) => f.kind)])];
    const i = kinds.indexOf(kind);
    return PALETTE[(i < 0 ? kinds.length : i) % PALETTE.length];
  }

  private styleOf_(f: FeatureLike): Style | Style[] {
    const role = f.get('role');
    const label = (text: string, offsetY = -16) => new Text({ text, font: '600 12px sans-serif', offsetY, overflow: true, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) });
    switch (role) {
      case 'obs': {
        const color = this.colorOf_(String(f.get('kind') ?? ''));
        return new Style({
          image: f.get('present')
            ? new Circle({ radius: f.get('editing') ? 9 : 7, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 2 }) })
            : new RegularShape({ points: 4, radius: 8, angle: Math.PI / 4, stroke: new Stroke({ color, width: 3 }) }),
          text: label(String(f.get('label') ?? '')),
          zIndex: 3,
        });
      }
      case 'ghost': {
        const color = this.colorOf_(String(f.get('kind') ?? ''));
        return new Style({
          image: new Circle({ radius: 7, fill: new Fill({ color: 'rgba(255,255,255,0.35)' }), stroke: new Stroke({ color, width: 2, lineDash: [3, 3] }) }),
          text: new Text({ text: String(f.get('label') ?? ''), font: '12px sans-serif', offsetY: -16, fill: new Fill({ color: '#555' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
          zIndex: 2,
        });
      }
      case 'track':
        return [new Style({ stroke: new Stroke({ color: '#fff', width: 5 }) }), new Style({ stroke: new Stroke({ color: '#111', width: 2, lineDash: [6, 4] }) })];
      case 'step':
        return new Style({
          image: new Circle({ radius: 3, fill: new Fill({ color: f.get('present') ? '#111' : '#dc2626' }) }),
          text: new Text({ text: String(f.get('label') ?? ''), font: '11px sans-serif', offsetY: 14, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
          zIndex: 1,
        });
      case 'pending':
        return new Style({ image: new RegularShape({ points: 4, radius: 10, radius2: 0, stroke: new Stroke({ color: '#e11d48', width: 2 }) }), zIndex: 4 });
      default:
        return [];
    }
  }
}
