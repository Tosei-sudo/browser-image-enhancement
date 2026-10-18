/**
 * The 「STAC 検索」 panel: searches a STAC API (config.json's `stacCatalogs`,
 * Earth Search by default) by the map's view or a drawn box, the dates and
 * the cloud cover, lists the scenes with their thumbnails and footprints, and
 * opens the chosen ones as COGs: the true color asset (`visual`) when there
 * is one, else the red, green and blue assets as an RGB composite, or any
 * asset chosen. Further pages come by the API's `next` link. A static
 * catalog, collection or item opens by its URL under 「詳細」.
 *
 * In the image catalog panel's look (catalog-panel.ts): non-modal at the
 * right, so the map can still be moved.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Polygon, { fromExtent } from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import { createEmpty, extend, isEmpty, type Extent } from 'ol/extent.js';
import { transformExtent } from 'ol/proj.js';
import { timeText } from './catalog.js';
import {
  assetPresets,
  defaultChoice,
  fetchStac,
  matchesSearch,
  nextPage,
  parseCollections,
  PcSigner,
  searchStac,
  walkStatic,
  type AssetChoice,
  type AssetPreset,
  type NextLink,
  type StacAsset,
  type StacCatalogConfig,
  type StacItem,
  type StacRequest,
  type StacSearch,
} from './stac.js';

export interface StacPanelOptions {
  /**
   * Opens the assets of an item (signed URLs): one, or three as red, green
   * and blue (`rgb`). Rejects (having said why) when it cannot.
   */
  open: (assets: Array<{ url: string; asset: StacAsset }>, item: StacItem, catalog: StacCatalogConfig, rgb: boolean) => Promise<void>;
  say: (message: string) => void;
}

const footprint = new Style({ stroke: new Stroke({ color: '#0d9488', width: 1.5 }), fill: new Fill({ color: 'rgba(13, 148, 136, 0.04)' }) });
const hoverStyle = new Style({ stroke: new Stroke({ color: '#0d9488', width: 3 }), fill: new Fill({ color: 'rgba(13, 148, 136, 0.15)' }) });
const areaStyle = new Style({ stroke: new Stroke({ color: '#7c3aed', width: 2, lineDash: [6, 4] }), fill: new Fill({ color: 'rgba(124, 58, 237, 0.05)' }) });
const chosenStyle = (label: string) =>
  new Style({
    stroke: new Stroke({ color: '#f59e0b', width: 3 }),
    fill: new Fill({ color: 'rgba(245, 158, 11, 0.18)' }),
    text: new Text({ text: label, font: '12px sans-serif', overflow: true, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
  });

/** Items per page. */
const PAGE = 50;
/** Most items listed (pages are no longer loaded beyond this). */
const MAX_LISTED = 2000;

interface Row {
  item: StacItem;
  feature: Feature;
}

export class StacPanel {
  readonly dialog: HTMLDialogElement;
  /** The footprints of the listed items (and the drawn box), on the map while the panel is open. */
  readonly footprints = new VectorLayer({ source: new VectorSource<Feature>(), style: footprint, zIndex: 1000 });
  private readonly form_: HTMLFormElement;
  private readonly catalogs_: HTMLSelectElement;
  private readonly collections_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly more_: HTMLButtonElement;
  private readonly open_: HTMLButtonElement;
  private readonly zoom_: HTMLButtonElement;
  private readonly asset_: HTMLSelectElement;
  private readonly assetRow_: HTMLElement;
  private readonly bands_: HTMLSelectElement[];
  private catalog_: StacCatalogConfig;
  private rows_: Row[] = [];
  private readonly chosen_ = new Set<Row>();
  private anchor_: Row | null = null;
  private presets_: AssetPreset[] = [];
  private next_: { link: NextLink; request: StacRequest } | null = null;
  private matched_: number | null = null;
  private turn_ = 0;
  private busy_ = false;
  private area_: Feature<Polygon> | null = null;
  private draw_: Draw | null = null;
  private readonly signer_ = new PcSigner();
  private collectionsOf_: StacCatalogConfig | null = null;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly catalogs: StacCatalogConfig[],
    private readonly options: StacPanelOptions,
  ) {
    this.catalog_ = catalogs[0];
    // `"stacCatalogs": []`: nothing to search, nothing leaves the page.
    button.hidden = catalogs.length === 0;
    // Its menu group goes too when it holds nothing else.
    const group = button.parentElement;
    if (button.hidden && group?.classList.contains('point-tools') && group.children.length === 1) {
      group.hidden = true;
      if (group.previousElementSibling?.matches('.menu-heading')) (group.previousElementSibling as HTMLElement).hidden = true;
    }
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service stac-dialog';
    this.dialog.setAttribute('aria-labelledby', 'stac-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="stac-title">STAC 検索</h2>
        <select name="catalog" aria-label="STAC カタログ" ${catalogs.length > 1 ? '' : 'hidden'}></select>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <form class="service-form catalog-form stac-form">
        <label class="catalog-days">撮像日<span><input name="from" type="date" aria-label="撮像日（から）" /> 〜 <input name="to" type="date" aria-label="撮像日（まで）" /></span></label>
        <label class="stac-cloud">雲量（以下）<span><input name="maxCloud" type="number" min="0" max="100" step="any" placeholder="制限なし" /> %</span></label>
        <label class="stac-area">範囲<span><select name="area"><option value="view">表示範囲</option><option value="drawn">描いた四角</option><option value="any">指定なし</option></select><button type="button" class="stac-draw" title="地図をドラッグして範囲の四角を描きます">描く</button></span></label>
        <button type="submit" class="primary catalog-search">検索</button>
        <fieldset class="wide stac-collections" hidden><legend>コレクション</legend><div class="stac-collection-list"></div></fieldset>
        <details class="catalog-more wide">
          <summary>詳細</summary>
          <div class="catalog-more-body">
            <label>1 ページの件数<select name="limit"><option>20</option><option selected>${PAGE}</option><option>100</option></select></label>
            <span></span>
            <label class="wide">静的カタログ・コレクション・アイテムの URL<span class="stac-static"><input name="staticUrl" type="url" placeholder="https://…/catalog.json" autocomplete="off" /><button type="button" class="stac-load">読み込む</button></span></label>
          </div>
        </details>
      </form>
      <p class="service-status" role="status"></p>
      <div class="catalog-results"><table class="catalog-table stac-table">
        <thead><tr><th>画像</th><th>撮像日時</th><th>雲量</th><th>コレクション</th><th>ID</th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button type="button" class="stac-more" hidden>さらに読み込む</button>
      <div class="stac-assets" hidden>
        <label>開くもの<select name="asset" aria-label="開くアセット"></select></label>
        <span class="stac-bands" hidden>${['赤', '緑', '青'].map((c) => `<select aria-label="${c}" name="band-${c}"></select>`).join('')}</span>
      </div>
      <div class="service-actions catalog-actions">
        <button type="button" value="zoom" disabled>範囲へ移動</button>
        <button type="button" value="open" class="primary" disabled>開く</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.catalogs_ = this.dialog.querySelector('select[name=catalog]')!;
    this.collections_ = this.dialog.querySelector('.stac-collections')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.table_ = this.dialog.querySelector('table')!;
    this.more_ = this.dialog.querySelector('.stac-more')!;
    this.open_ = this.dialog.querySelector('button[value=open]')!;
    this.zoom_ = this.dialog.querySelector('button[value=zoom]')!;
    this.asset_ = this.dialog.querySelector('select[name=asset]')!;
    this.assetRow_ = this.dialog.querySelector('.stac-assets')!;
    this.bands_ = [...this.dialog.querySelectorAll<HTMLSelectElement>('.stac-bands select')];

    catalogs.forEach((c, i) => this.catalogs_.add(new Option(c.label, String(i))));
    this.catalogs_.addEventListener('change', () => this.useCatalog(this.catalogs[Number(this.catalogs_.value)]));
    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => {
      this.stopDrawing();
      map.removeLayer(this.footprints);
    });
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search();
    });
    const area = this.form_.elements.namedItem('area') as HTMLSelectElement;
    area.addEventListener('change', () => {
      if (area.value === 'drawn' && !this.area_) this.startDrawing();
    });
    this.dialog.querySelector('.stac-draw')!.addEventListener('click', () => this.startDrawing());
    this.dialog.querySelector('.stac-load')!.addEventListener('click', () => void this.loadStatic());
    (this.form_.elements.namedItem('staticUrl') as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void this.loadStatic();
    });
    this.more_.addEventListener('click', () => void this.loadMore());
    this.open_.addEventListener('click', () => void this.openChosen());
    this.zoom_.addEventListener('click', () => this.zoomToChosen());
    this.asset_.addEventListener('change', () => this.showBands());
    this.table_.tBodies[0].addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.openChosen();
    });

    // A click on a footprint picks its item (Ctrl / Shift: adds it).
    map.on('singleclick', (e) => {
      if (!this.dialog.open || this.draw_) return;
      const hits = map.getFeaturesAtPixel(e.pixel, { layerFilter: (l) => l === this.footprints, hitTolerance: 2 }) as Feature[];
      const area = (f: Feature) => {
        const [x0, y0, x1, y1] = f.getGeometry()!.getExtent();
        return (x1 - x0) * (y1 - y0);
      };
      // The smallest footprint is the one meant when they overlap.
      const row = hits
        .sort((a, b) => area(a) - area(b))
        .map((f) => this.rows_.find((r) => r.feature === f))
        .find(Boolean);
      if (!row) return;
      const add = e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey;
      this.choose(row, add ? 'toggle' : 'only');
      this.rowOf(row)?.scrollIntoView({ block: 'nearest' });
    });
    if (this.catalog_) this.useCatalog(this.catalog_);
  }

  /** Shows the panel (non-modal) with the footprints of the last search. */
  open(): void {
    if (!this.catalog_) return;
    if (!this.map.getLayers().getArray().includes(this.footprints)) this.map.addLayer(this.footprints);
    this.dialog.show();
    void this.loadCollections();
    // The first visit lists what is in view at once.
    if (!this.rows_.length && !this.busy_) void this.search();
  }

  close(): void {
    this.dialog.close();
  }

  /** The items listed, in the list's order. */
  items(): StacItem[] {
    return this.rows_.map((r) => r.item);
  }

  /** The items chosen in the list. */
  chosen(): StacItem[] {
    return this.rows_.filter((r) => this.chosen_.has(r)).map((r) => r.item);
  }

  /** Switches to another catalog: its collections, no results. */
  useCatalog(catalog: StacCatalogConfig): void {
    this.catalog_ = catalog;
    this.turn_++;
    this.busy_ = false;
    this.setRows([]);
    this.next_ = null;
    this.status_.textContent = '';
    this.collectionChoices(catalog.collections.map((id) => ({ id, title: id })), true);
    if (this.dialog.open) void this.loadCollections();
  }

  /** Lists the API's collections when config.json names none (unchecked: every collection is searched). */
  private async loadCollections(): Promise<void> {
    const catalog = this.catalog_;
    if (catalog.collections.length || this.collectionsOf_ === catalog) return;
    this.collectionsOf_ = catalog;
    try {
      const url = `${new URL(catalog.url, document.baseURI).href.replace(/\/+$/, '')}/collections`;
      const list = parseCollections(await fetchStac({ url, method: 'GET' }, catalog, document.baseURI));
      if (this.catalog_ === catalog) this.collectionChoices(list, false);
    } catch {
      // A static catalog, or an API without /collections: every collection then.
    }
  }

  private collectionChoices(list: Array<{ id: string; title: string }>, checked: boolean): void {
    const box = this.collections_.querySelector('div')!;
    box.replaceChildren(
      ...list.map((c) => {
        const label = document.createElement('label');
        label.className = 'check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'collection';
        input.value = c.id;
        input.checked = checked;
        label.title = c.id;
        label.append(input, c.title);
        return label;
      }),
    );
    this.collections_.hidden = list.length === 0;
  }

  /** What the form asks for. */
  searchOf(): StacSearch {
    const value = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).value;
    const cloud = value('maxCloud');
    return {
      bbox: this.bbox(),
      from: value('from'),
      to: value('to'),
      maxCloud: cloud === '' || !Number.isFinite(Number(cloud)) ? null : Number(cloud),
      collections: [...this.collections_.querySelectorAll<HTMLInputElement>('input[name=collection]:checked')].map((c) => c.value),
      limit: Number(value('limit')) || PAGE,
    };
  }

  /** The area searched in degrees (west, south, east, north): the view, the drawn box, or none. */
  private bbox(): [number, number, number, number] | null {
    const how = (this.form_.elements.namedItem('area') as HTMLSelectElement).value;
    const view = this.map.getView();
    let extent: Extent | null = null;
    if (how === 'view') extent = view.calculateExtent(this.map.getSize());
    else if (how === 'drawn' && this.area_) extent = this.area_.getGeometry()!.getExtent();
    if (!extent || extent.some((v) => !Number.isFinite(v))) return null;
    const [w, s, e, n] = transformExtent(extent, view.getProjection(), 'EPSG:4326');
    // The whole world (or more): no area.
    if (e - w >= 360) return null;
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    return [clamp(w, 180), clamp(s, 90), clamp(e, 180), clamp(n, 90)];
  }

  /** Lets the person drag a box on the map as the area searched; the search follows. */
  startDrawing(): void {
    this.stopDrawing();
    const source = new VectorSource<Feature>();
    const draw = new Draw({ source, type: 'Circle', geometryFunction: createBox(), style: areaStyle });
    this.draw_ = draw;
    this.map.addInteraction(draw);
    this.status_.textContent = '地図をドラッグして範囲の四角を描いてください（Esc でやめます）';
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.draw_ === draw) {
        e.stopPropagation();
        this.stopDrawing();
        this.status_.textContent = '';
      }
    };
    document.addEventListener('keydown', esc, true);
    draw.once('change:active', () => document.removeEventListener('keydown', esc, true));
    draw.on('drawend', (e) => {
      const footprints = this.footprints.getSource()!;
      if (this.area_) footprints.removeFeature(this.area_);
      this.area_ = new Feature(fromExtent(e.feature.getGeometry()!.getExtent()));
      this.area_.setStyle(areaStyle);
      footprints.addFeature(this.area_);
      (this.form_.elements.namedItem('area') as HTMLSelectElement).value = 'drawn';
      // After this event, so the click that ended the box picks nothing.
      setTimeout(() => {
        this.stopDrawing();
        void this.search();
      }, 0);
    });
  }

  private stopDrawing(): void {
    if (!this.draw_) return;
    this.draw_.setActive(false);
    this.map.removeInteraction(this.draw_);
    this.draw_ = null;
  }

  /** Searches the catalog with the form's conditions and lists the first page. */
  async search(): Promise<void> {
    const catalog = this.catalog_;
    if (!catalog) return;
    const turn = ++this.turn_;
    this.busy_ = true;
    this.status_.textContent = '検索しています…';
    this.more_.hidden = true;
    try {
      const { page, request } = await searchStac(catalog, this.searchOf(), document.baseURI);
      if (turn !== this.turn_) return;
      this.next_ = page.next ? { link: page.next, request } : null;
      this.matched_ = page.matched;
      this.setRows(page.items);
      this.sayCount();
    } catch (error) {
      if (turn !== this.turn_) return;
      this.status_.textContent = `検索できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (turn === this.turn_) this.busy_ = false;
    }
  }

  /** Adds the next page to the list. */
  async loadMore(): Promise<void> {
    const next = this.next_;
    if (!next || this.busy_) return;
    const catalog = this.catalog_;
    const turn = ++this.turn_;
    this.busy_ = true;
    this.more_.disabled = true;
    this.status_.textContent = '読み込んでいます…';
    try {
      const { page, request } = await nextPage(catalog, next.link, next.request, document.baseURI);
      if (turn !== this.turn_) return;
      const known = new Set(this.rows_.map((r) => `${r.item.collection}/${r.item.id}`));
      this.next_ = page.next ? { link: page.next, request } : null;
      this.setRows([...this.items(), ...page.items.filter((i) => !known.has(`${i.collection}/${i.id}`))], true);
      this.sayCount();
    } catch (error) {
      if (turn !== this.turn_) return;
      this.status_.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.more_.disabled = false;
      if (turn === this.turn_) this.busy_ = false;
    }
  }

  private sayCount(): void {
    const shown = this.rows_.length;
    if (this.rows_.length >= MAX_LISTED) this.next_ = null;
    this.more_.hidden = !this.next_;
    const total = this.matched_ !== null && this.matched_ > shown ? `${this.matched_.toLocaleString()} 件中 ${shown.toLocaleString()} 件` : `${shown.toLocaleString()} 件`;
    this.status_.textContent = shown === 0 ? '条件に合うシーンはありません' : `${total}。行を選んで「開く」（ダブルクリックでも開きます）`;
  }

  /** Reads a static catalog, collection or item by URL and lists its items that match the dates, cloud cover and collections. */
  async loadStatic(url = (this.form_.elements.namedItem('staticUrl') as HTMLInputElement).value.trim()): Promise<void> {
    if (!url) return;
    let absolute: string;
    try {
      absolute = new URL(url, document.baseURI).href;
      if (!/^https?:$/.test(new URL(absolute).protocol)) throw new Error();
    } catch {
      this.status_.textContent = 'http(s) の URL を入力してください';
      return;
    }
    const turn = ++this.turn_;
    this.busy_ = true;
    this.more_.hidden = true;
    this.status_.textContent = '読み込んでいます…';
    // The configured catalog's headers go only to its own origin (fetchStac checks).
    const catalog = this.catalog_;
    try {
      const { items, truncated } = await walkStatic(absolute, (u) => fetchStac({ url: u, method: 'GET' }, catalog, document.baseURI));
      if (turn !== this.turn_) return;
      const search = this.searchOf();
      const found = items.filter((i) => matchesSearch(i, { ...search, collections: [] }));
      found.sort((a, b) => (b.time ?? -Infinity) - (a.time ?? -Infinity));
      this.next_ = null;
      this.matched_ = null;
      this.setRows(found);
      this.more_.hidden = true;
      this.status_.textContent =
        `静的カタログから ${items.length.toLocaleString()} 件${truncated ? '（上限まで）' : ''}` +
        (found.length < items.length ? `、撮像日・雲量に合うのは ${found.length.toLocaleString()} 件` : '') +
        (found.length ? '。行を選んで「開く」' : '');
      // The items may be anywhere: show them all.
      const extent = createEmpty();
      for (const r of this.rows_) extend(extent, r.feature.getGeometry()!.getExtent());
      if (!isEmpty(extent)) this.map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 14, duration: 250 });
    } catch (error) {
      if (turn !== this.turn_) return;
      this.status_.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (turn === this.turn_) this.busy_ = false;
    }
  }

  /** The footprint of an item on the map, in the view's projection. */
  private featureOf(item: StacItem): Feature {
    const projection = this.map.getView().getProjection();
    const polygons = item.polygons.map((rings) => new Polygon(rings).transform('EPSG:4326', projection) as Polygon);
    const geometry = polygons.length === 1 ? polygons[0] : new MultiPolygon(polygons.map((p) => p.getCoordinates()));
    return new Feature(geometry);
  }

  private setRows(items: StacItem[], keepChosen = false): void {
    const old = new Map(this.rows_.map((r) => [r.item, r]));
    // Items without a footprint are still listed, with an empty geometry.
    this.rows_ = items.map((item) => old.get(item) ?? { item, feature: this.featureOf(item) });
    if (!keepChosen) {
      this.chosen_.clear();
      this.anchor_ = null;
    } else for (const r of [...this.chosen_]) if (!this.rows_.includes(r)) this.chosen_.delete(r);
    const source = this.footprints.getSource()!;
    source.clear();
    source.addFeatures(this.rows_.map((r) => r.feature));
    if (this.area_) source.addFeature(this.area_);
    this.table_.tBodies[0].replaceChildren(...this.rows_.map((row) => this.rowElement(row)));
    this.update();
  }

  private rowElement(row: Row): HTMLTableRowElement {
    const { item } = row;
    const tr = document.createElement('tr');
    tr.tabIndex = -1;
    const thumb = document.createElement('td');
    thumb.className = 'stac-thumb';
    if (item.thumbnail) {
      // Only http(s) images (stac.ts checks), as a plain picture: nothing of it runs, no referrer goes with it.
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.width = 40;
      img.height = 40;
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = item.thumbnail;
      thumb.append(img);
    }
    const cells = [item.time === null ? '' : timeText(item.time), item.cloud === null ? '' : `${Math.round(item.cloud * 10) / 10} %`, item.collection, item.id];
    tr.append(
      thumb,
      ...cells.map((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        return td;
      }),
    );
    if (!defaultChoice(item)) {
      tr.classList.add('stac-none');
      tr.title = '開ける GeoTIFF（COG）のアセットがありません';
    }
    tr.addEventListener('click', (e) => {
      this.choose(row, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'only');
      tr.focus();
    });
    tr.addEventListener('dblclick', () => {
      this.choose(row, 'only');
      void this.openChosen();
    });
    // Pointing at a row shows its footprint.
    tr.addEventListener('mouseenter', () => {
      if (!this.chosen_.has(row)) row.feature.setStyle(hoverStyle);
    });
    tr.addEventListener('mouseleave', () => {
      if (!this.chosen_.has(row)) row.feature.setStyle(undefined);
    });
    return tr;
  }

  private rowOf(row: Row): HTMLTableRowElement | undefined {
    return this.table_.tBodies[0].rows[this.rows_.indexOf(row)];
  }

  /** Chooses the `index`th item alone (for scripts and tests). */
  chooseIndex(index: number): void {
    const row = this.rows_[index];
    if (row) this.choose(row, 'only');
  }

  /** Chooses `row` alone, adds or removes it, or chooses the rows from the last one chosen to it. */
  private choose(row: Row, how: 'only' | 'toggle' | 'range' = 'only'): void {
    if (how === 'range' && this.anchor_) {
      const [a, b] = [this.rows_.indexOf(this.anchor_), this.rows_.indexOf(row)].sort((x, y) => x - y);
      this.chosen_.clear();
      for (const r of this.rows_.slice(a, b + 1)) this.chosen_.add(r);
    } else if (how === 'toggle') {
      if (this.chosen_.has(row)) this.chosen_.delete(row);
      else this.chosen_.add(row);
      this.anchor_ = row;
    } else {
      this.chosen_.clear();
      this.chosen_.add(row);
      this.anchor_ = row;
    }
    this.update();
  }

  /** The rows, footprints, asset choices and buttons after the choice changed. */
  private update(): void {
    this.rows_.forEach((r, i) => {
      const on = this.chosen_.has(r);
      this.table_.tBodies[0].rows[i]?.classList.toggle('chosen', on);
      this.table_.tBodies[0].rows[i]?.setAttribute('aria-selected', String(on));
      r.feature.setStyle(on ? chosenStyle(r.item.id) : undefined);
    });
    const chosen = this.chosen();
    const openable = chosen.filter((i) => defaultChoice(i)).length;
    this.open_.disabled = openable === 0;
    this.open_.textContent = chosen.length > 1 ? `開く（${openable}）` : '開く';
    this.zoom_.disabled = chosen.length === 0;
    // One item: what to open from it.
    const one = chosen.length === 1 ? chosen[0] : null;
    this.presets_ = one ? assetPresets(one) : [];
    this.assetRow_.hidden = this.presets_.length === 0;
    if (!one) return;
    const previous = this.asset_.value;
    this.asset_.replaceChildren(...this.presets_.map((p) => new Option(p.label, p.id)));
    const bandAssets = this.presets_.filter((p) => p.id.startsWith('asset:'));
    if (bandAssets.length >= 2) this.asset_.add(new Option('バンドを選んで合成…', 'custom'));
    if ([...this.asset_.options].some((o) => o.value === previous)) this.asset_.value = previous;
    for (const [b, select] of this.bands_.entries()) {
      const keep = select.value;
      select.replaceChildren(...bandAssets.map((p) => new Option(p.label, p.id)));
      const common = ['red', 'green', 'blue'][b];
      const guess = bandAssets.find((p) => p.choice.kind === 'single' && p.choice.asset.commonName === common) ?? bandAssets[Math.min(b, bandAssets.length - 1)];
      select.value = [...select.options].some((o) => o.value === keep) ? keep : (guess?.id ?? '');
    }
    this.showBands();
  }

  private showBands(): void {
    (this.dialog.querySelector('.stac-bands') as HTMLElement).hidden = this.asset_.value !== 'custom';
  }

  /** What to open of `item`: the choice in the panel when it is the only one chosen, else its default. */
  private choiceOf(item: StacItem, alone: boolean): AssetChoice | null {
    if (!alone) return defaultChoice(item);
    if (this.asset_.value === 'custom') {
      const assets = this.bands_.map((s) => this.presets_.find((p) => p.id === s.value)?.choice);
      if (assets.every((c) => c?.kind === 'single')) return { kind: 'rgb', assets: assets.map((c) => (c as { asset: StacAsset }).asset) as [StacAsset, StacAsset, StacAsset] };
    }
    return this.presets_.find((p) => p.id === this.asset_.value)?.choice ?? defaultChoice(item);
  }

  /** Opens the chosen items one after another. */
  async openChosen(): Promise<void> {
    const chosen = this.chosen();
    const catalog = this.catalog_;
    let opened = 0;
    let failed = '';
    for (const item of chosen) {
      const choice = this.choiceOf(item, chosen.length === 1);
      if (!choice) continue;
      const assets = choice.kind === 'single' ? [choice.asset] : choice.assets;
      this.options.say(`${item.id} を開いています…`);
      try {
        const signed = await Promise.all(assets.map(async (asset) => ({ asset, url: catalog.sign === 'planetary-computer' ? await this.signer_.sign(asset.href, item.collection) : asset.href })));
        await this.options.open(signed, item, catalog, choice.kind === 'rgb');
        opened++;
      } catch (error) {
        failed = `${item.id} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
        this.options.say(failed);
      }
    }
    if (failed && chosen.length > 1) this.options.say(`${opened} / ${chosen.length} 件を開きました。${failed}`);
  }

  /** Fits the view to the chosen footprints. */
  zoomToChosen(): void {
    const extent = createEmpty();
    for (const r of this.rows_) if (this.chosen_.has(r)) extend(extent, r.feature.getGeometry()!.getExtent());
    if (!isEmpty(extent)) this.map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 18, duration: 250 });
  }
}
