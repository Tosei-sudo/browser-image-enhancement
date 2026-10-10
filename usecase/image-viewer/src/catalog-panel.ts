/**
 * The 「画像カタログ」 panel: searches an image catalog (catalog.ts) by when
 * the images were taken, sensor, angle and the map's view, lists them with
 * their footprints on the map, and opens the chosen ones. COGs open by URL;
 * images the catalog knows only by a local path open through config.json's
 * pathMappings (local-paths.ts), and their paths can be copied.
 *
 * The everyday search is the first lines of the form; registration dates and
 * a free SQL condition wait under 「詳細条件」, and the list sorts by any column.
 */
import type OlMap from 'ol/Map.js';
import type Feature from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import { createEmpty, extend, isEmpty } from 'ol/extent.js';
import {
  emptySearch,
  readCatalogLayer,
  roleLabels,
  searchCatalog,
  sensorsOf,
  sortRecords,
  timeText,
  type CatalogConfig,
  type CatalogLayerInfo,
  type CatalogRecord,
  type CatalogSearch,
  type SortKey,
} from './catalog.js';

export interface CatalogPanelOptions {
  /** Opens a COG of the catalog; rejects (having said why) when it cannot. */
  openUrl: (url: string, record: CatalogRecord, catalog: CatalogConfig) => Promise<void>;
  /**
   * Opens an image known by a local path (config.json's pathMappings); false
   * when the person cancelled, and throws with the reason when it cannot.
   * Without it, local paths can only be copied.
   */
  openPath?: (path: string, record: CatalogRecord, catalog: CatalogConfig) => Promise<boolean>;
  /** Forgets the folders allowed for local paths (shown when given). */
  forgetFolders?: () => Promise<void>;
  say: (message: string) => void;
}

const footprint = new Style({ stroke: new Stroke({ color: '#2563eb', width: 1.5 }), fill: new Fill({ color: 'rgba(37, 99, 235, 0.04)' }) });
const chosenStyle = (label: string) =>
  new Style({
    stroke: new Stroke({ color: '#f59e0b', width: 3 }),
    fill: new Fill({ color: 'rgba(245, 158, 11, 0.18)' }),
    text: new Text({ text: label, font: '12px sans-serif', overflow: true, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
  });

/** The column a list header sorts by, with its heading. */
interface Column {
  key: SortKey;
  label: string;
  text: (r: CatalogRecord) => string;
}

export class CatalogPanel {
  readonly dialog: HTMLDialogElement;
  /** The footprints of the listed images, on the map while the panel is open. */
  readonly footprints = new VectorLayer({ source: new VectorSource<Feature>(), style: footprint, zIndex: 1000 });
  private readonly form_: HTMLFormElement;
  private readonly catalogs_: HTMLSelectElement;
  private readonly sensor_: HTMLSelectElement;
  private readonly sensorText_: HTMLInputElement;
  private readonly status_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly open_: HTMLButtonElement;
  private readonly zoom_: HTMLButtonElement;
  private readonly copy_: HTMLButtonElement;
  /** Undefined only when config.json lists no catalog (the button is hidden then). */
  private catalog_: CatalogConfig;
  private layer_: Promise<CatalogLayerInfo> | null = null;
  private records_: CatalogRecord[] = [];
  private readonly chosen_ = new Set<CatalogRecord>();
  private anchor_: CatalogRecord | null = null;
  private sort_: { key: SortKey; descending: boolean } = { key: 'acquired', descending: true };
  private searching_ = 0;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly catalogs: CatalogConfig[],
    private readonly options: CatalogPanelOptions,
  ) {
    this.catalog_ = catalogs[0];
    // Without a catalog in config.json there is nothing to search: no button.
    button.hidden = catalogs.length === 0;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service catalog-dialog';
    this.dialog.setAttribute('aria-labelledby', 'catalog-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="catalog-title">画像カタログ</h2>
        <select name="catalog" aria-label="カタログ" ${catalogs.length > 1 ? '' : 'hidden'}></select>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <form class="service-form catalog-form">
        <label class="catalog-days">撮像日<span><input name="acquiredFrom" type="date" aria-label="撮像日（から）" /> 〜 <input name="acquiredTo" type="date" aria-label="撮像日（まで）" /></span></label>
        <label class="catalog-sensor">センサー<select name="sensor"><option value="">すべて</option></select><input name="sensorText" type="text" placeholder="すべて" hidden /></label>
        <label class="catalog-angle">角度（以下）<input name="maxAngle" type="number" min="0" max="90" step="any" placeholder="制限なし" /></label>
        <label class="check catalog-view"><input name="inView" type="checkbox" checked />表示範囲内のみ</label>
        <details class="catalog-more wide">
          <summary>詳細条件</summary>
          <div class="catalog-more-body">
            <label class="catalog-days">登録日<span><input name="registeredFrom" type="date" aria-label="登録日（から）" /> 〜 <input name="registeredTo" type="date" aria-label="登録日（まで）" /></span></label>
            <label class="wide">条件（SQL）<input name="where" type="text" placeholder="例: CLOUD &lt; 20" autocomplete="off" /></label>
            <button type="button" class="catalog-forget" hidden title="ローカルパスの画像のために許可したフォルダを忘れます。次に開くときに選び直します">フォルダの許可を消去</button>
          </div>
        </details>
        <button type="submit" class="primary catalog-search">検索</button>
      </form>
      <p class="service-status" role="status"></p>
      <div class="catalog-results"><table class="catalog-table"><thead></thead><tbody></tbody></table></div>
      <div class="service-actions catalog-actions">
        <button type="button" value="copy" disabled title="選んだ画像のローカルパスをコピーします">パスをコピー</button>
        <button type="button" value="zoom" disabled>範囲へ移動</button>
        <button type="button" value="open" class="primary" disabled>開く</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.catalogs_ = this.dialog.querySelector('select[name=catalog]')!;
    this.sensor_ = this.form_.elements.namedItem('sensor') as HTMLSelectElement;
    this.sensorText_ = this.form_.elements.namedItem('sensorText') as HTMLInputElement;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.table_ = this.dialog.querySelector('table')!;
    this.open_ = this.dialog.querySelector('button[value=open]')!;
    this.zoom_ = this.dialog.querySelector('button[value=zoom]')!;
    this.copy_ = this.dialog.querySelector('button[value=copy]')!;

    catalogs.forEach((c, i) => this.catalogs_.add(new Option(c.label, String(i))));
    this.catalogs_.addEventListener('change', () => this.useCatalog(this.catalogs[Number(this.catalogs_.value)]));
    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => map.removeLayer(this.footprints));
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.search();
    });
    this.open_.addEventListener('click', () => void this.openChosen());
    this.zoom_.addEventListener('click', () => this.zoomToChosen());
    this.copy_.addEventListener('click', () => void this.copyPaths());
    const forget = this.dialog.querySelector<HTMLButtonElement>('.catalog-forget')!;
    forget.hidden = !options.forgetFolders;
    forget.addEventListener('click', () => {
      void options.forgetFolders?.().then(() => options.say('フォルダの許可を消去しました。次にローカルパスの画像を開くときに選び直します'));
    });
    this.table_.tBodies[0].addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.openChosen();
    });

    // A click on a footprint picks its image (Ctrl / Shift: adds it).
    map.on('singleclick', (e) => {
      if (!this.dialog.open) return;
      const hits = map.getFeaturesAtPixel(e.pixel, { layerFilter: (l) => l === this.footprints, hitTolerance: 2 }) as Feature[];
      if (!hits.length) return;
      // The smallest footprint is the one meant when they overlap.
      const area = (f: Feature) => {
        const [x0, y0, x1, y1] = f.getGeometry()!.getExtent();
        return (x1 - x0) * (y1 - y0);
      };
      const hit = hits.sort((a, b) => area(a) - area(b))[0];
      const record = this.records_.find((r) => r.feature === hit);
      if (!record) return;
      const add = e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey;
      this.choose(record, add ? 'toggle' : 'only');
      this.rowOf(record)?.scrollIntoView({ block: 'nearest' });
    });
    if (this.catalog_) this.useCatalog(this.catalog_);
  }

  /** Shows the panel (non-modal, so the map can still be moved) with the footprints of the last search. */
  open(): void {
    if (!this.catalog_) return;
    if (!this.map.getLayers().getArray().includes(this.footprints)) this.map.addLayer(this.footprints);
    this.dialog.show();
    // The first visit lists what is in view at once.
    if (!this.records_.length && !this.searching_) void this.search();
  }

  close(): void {
    this.dialog.close();
  }

  /** The records listed, in the list's order. */
  records(): CatalogRecord[] {
    return this.records_;
  }

  /** The records chosen in the list. */
  chosen(): CatalogRecord[] {
    return this.records_.filter((r) => this.chosen_.has(r));
  }

  /** Switches to another catalog: its sensors, its columns, no results. */
  useCatalog(catalog: CatalogConfig): void {
    this.catalog_ = catalog;
    this.layer_ = null;
    this.setRecords([]);
    this.status_.textContent = '';
    const { fields } = catalog;
    const show = (selector: string, on: boolean) => ((this.form_.querySelector<HTMLElement>(selector)!.hidden = !on), undefined);
    show('.catalog-days', Boolean(fields.acquired));
    show('.catalog-more .catalog-days', Boolean(fields.registered));
    show('.catalog-sensor', Boolean(fields.sensor));
    show('.catalog-angle', Boolean(fields.angle));
    const angle = this.form_.querySelector('.catalog-angle')!;
    angle.firstChild!.textContent = `${catalog.labels.angle ?? roleLabels.angle}（以下）`;
    this.sensor_.replaceChildren(new Option('すべて', ''));
    this.sensor_.hidden = false;
    this.sensorText_.hidden = true;
    if (fields.sensor) {
      void sensorsOf(catalog).then((sensors) => {
        if (this.catalog_ !== catalog) return;
        for (const s of sensors) this.sensor_.add(new Option(s, s));
        // A service that cannot list its values: type the sensor instead.
        this.sensor_.hidden = sensors.length === 0;
        this.sensorText_.hidden = sensors.length > 0;
      });
    }
    this.renderHead();
  }

  /** What the form asks for. */
  searchOf(): CatalogSearch {
    const value = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).value;
    const angle = value('maxAngle');
    return {
      ...emptySearch,
      acquiredFrom: value('acquiredFrom'),
      acquiredTo: value('acquiredTo'),
      registeredFrom: value('registeredFrom'),
      registeredTo: value('registeredTo'),
      sensor: this.sensor_.hidden ? this.sensorText_.value.trim() : this.sensor_.value,
      maxAngle: angle === '' ? null : Number(angle),
      where: value('where'),
    };
  }

  /** Searches the catalog with the form's conditions and lists what it finds. */
  async search(): Promise<void> {
    const catalog = this.catalog_;
    const turn = ++this.searching_;
    const inView = (this.form_.elements.namedItem('inView') as HTMLInputElement).checked;
    const view = this.map.getView();
    this.status_.textContent = '検索しています…';
    try {
      this.layer_ ??= readCatalogLayer(catalog);
      const layer = await this.layer_;
      const projection = view.getProjection();
      const extent = inView ? view.calculateExtent(this.map.getSize()) : null;
      const result = await searchCatalog(catalog, layer, this.searchOf(), extent ? { extent, projection } : null, projection);
      if (turn !== this.searching_ || catalog !== this.catalog_) return;
      this.setRecords(sortRecords(result.records, this.sort_.key, this.sort_.descending));
      const local = result.records.filter((r) => r.source?.kind === 'path').length;
      const shown = result.records.length;
      this.status_.textContent =
        shown === 0
          ? '条件に合う画像はありません'
          : `${result.total !== null && result.total > shown ? `${result.total.toLocaleString()} 件中 新しい ${shown.toLocaleString()} 件` : `${shown.toLocaleString()} 件`}${
              local ? `（うちローカルパスのみ ${local} 件）` : ''
            }。行を選んで「開く」（ダブルクリックでも開きます）`;
    } catch (error) {
      if (turn !== this.searching_) return;
      this.layer_ = null;
      this.status_.textContent = `検索できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (turn === this.searching_) this.searching_ = 0;
    }
  }

  private columns(): Column[] {
    const { fields, labels, columns } = this.catalog_;
    const all: Array<Column | null> = [
      fields.acquired ? { key: 'acquired', label: labels.acquired ?? roleLabels.acquired, text: (r) => timeText(r.acquired) } : null,
      fields.sensor ? { key: 'sensor', label: labels.sensor ?? roleLabels.sensor, text: (r) => r.sensor } : null,
      fields.angle ? { key: 'angle', label: labels.angle ?? roleLabels.angle, text: (r) => (r.angle === null ? '' : `${Math.round(r.angle * 10) / 10}°`) } : null,
      fields.id ? { key: 'id', label: labels.id ?? roleLabels.id, text: (r) => r.id } : null,
      fields.registered ? { key: 'registered', label: labels.registered ?? roleLabels.registered, text: (r) => timeText(r.registered) } : null,
      ...columns.map(
        (c): Column => ({
          key: `column:${c.field}`,
          label: c.label,
          text: (r) => {
            const v = r.feature.get(c.field);
            return v === null || v === undefined ? '' : String(v);
          },
        }),
      ),
    ];
    return all.filter((c): c is Column => c !== null);
  }

  private renderHead(): void {
    const row = document.createElement('tr');
    for (const column of this.columns()) {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      const on = this.sort_.key === column.key;
      button.textContent = `${column.label}${on ? (this.sort_.descending ? ' ▼' : ' ▲') : ''}`;
      button.title = `${column.label}で並べ替え`;
      th.setAttribute('aria-sort', on ? (this.sort_.descending ? 'descending' : 'ascending') : 'none');
      button.addEventListener('click', () => {
        this.sort_ = { key: column.key, descending: on ? !this.sort_.descending : column.key === 'acquired' || column.key === 'registered' };
        this.setRecords(sortRecords(this.records_, this.sort_.key, this.sort_.descending), true);
      });
      th.append(button);
      row.append(th);
    }
    const th = document.createElement('th');
    th.textContent = '形式';
    row.append(th);
    this.table_.tHead!.replaceChildren(row);
  }

  private setRecords(records: CatalogRecord[], keepChosen = false): void {
    this.records_ = records;
    if (!keepChosen) {
      this.chosen_.clear();
      this.anchor_ = null;
    }
    const source = this.footprints.getSource()!;
    source.clear();
    source.addFeatures(records.map((r) => r.feature));
    this.renderHead();
    const columns = this.columns();
    this.table_.tBodies[0].replaceChildren(
      ...records.map((record) => {
        const row = document.createElement('tr');
        row.tabIndex = -1;
        for (const column of columns) {
          const td = document.createElement('td');
          td.textContent = column.text(record);
          row.append(td);
        }
        const kind = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `catalog-kind ${record.source?.kind ?? 'none'}`;
        badge.textContent = record.source?.kind === 'url' ? 'COG' : record.source?.kind === 'path' ? 'ローカル' : 'なし';
        badge.title = record.source?.kind === 'url' ? record.source.url : record.source?.kind === 'path' ? `${record.source.path}${this.options.openPath ? '' : '（ローカルパスは開けません。パスをコピーできます）'}` : '画像の場所がありません';
        kind.append(badge);
        row.append(kind);
        row.addEventListener('click', (e) => {
          this.choose(record, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'only');
          row.focus();
        });
        row.addEventListener('dblclick', () => {
          this.choose(record, 'only');
          void this.openChosen();
        });
        return row;
      }),
    );
    this.update();
  }

  private rowOf(record: CatalogRecord): HTMLTableRowElement | undefined {
    return this.table_.tBodies[0].rows[this.records_.indexOf(record)];
  }

  /** Chooses `record` alone, adds or removes it, or chooses the rows from the last one chosen to it. */
  choose(record: CatalogRecord, how: 'only' | 'toggle' | 'range' = 'only'): void {
    if (how === 'range' && this.anchor_) {
      const [a, b] = [this.records_.indexOf(this.anchor_), this.records_.indexOf(record)].sort((x, y) => x - y);
      this.chosen_.clear();
      for (const r of this.records_.slice(a, b + 1)) this.chosen_.add(r);
    } else if (how === 'toggle') {
      if (this.chosen_.has(record)) this.chosen_.delete(record);
      else this.chosen_.add(record);
      this.anchor_ = record;
    } else {
      this.chosen_.clear();
      this.chosen_.add(record);
      this.anchor_ = record;
    }
    this.update();
  }

  /** The rows, footprints and buttons after the choice changed. */
  private update(): void {
    this.records_.forEach((r, i) => {
      const on = this.chosen_.has(r);
      this.table_.tBodies[0].rows[i]?.classList.toggle('chosen', on);
      this.table_.tBodies[0].rows[i]?.setAttribute('aria-selected', String(on));
      r.feature.setStyle(on ? chosenStyle(r.id) : undefined);
    });
    const chosen = this.chosen();
    const openable = chosen.filter((r) => r.source?.kind === 'url' || (r.source?.kind === 'path' && this.options.openPath)).length;
    this.open_.disabled = openable === 0;
    this.open_.textContent = chosen.length > 1 ? `開く（${openable}）` : '開く';
    this.zoom_.disabled = chosen.length === 0;
    this.copy_.disabled = !chosen.some((r) => r.source?.kind === 'path');
  }

  /**
   * Opens the chosen images one after another: COGs by URL, local paths
   * through config.json's pathMappings (where the browser can open them).
   */
  async openChosen(): Promise<void> {
    const chosen = this.chosen().filter((r) => r.source && (r.source.kind === 'url' || this.options.openPath));
    let opened = 0;
    let failed = '';
    for (const record of chosen) {
      const source = record.source!;
      this.options.say(`${record.id || '画像'} を開いています…`);
      try {
        if (source.kind === 'url') await this.options.openUrl(source.url, record, this.catalog_);
        else if (!(await this.options.openPath!(source.path, record, this.catalog_))) {
          this.options.say('キャンセルしました');
          return;
        }
        opened++;
      } catch (error) {
        // openUrl has said why; a local path says it here.
        if (source.kind === 'path') this.options.say((failed = `${record.id || source.path} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (failed && chosen.length > 1) this.options.say(`${opened} / ${chosen.length} 件を開きました。${failed}`);
  }

  /** Fits the view to the chosen footprints. */
  zoomToChosen(): void {
    const extent = createEmpty();
    for (const r of this.chosen()) {
      const g = r.feature.getGeometry();
      if (g) extend(extent, g.getExtent());
    }
    if (!isEmpty(extent)) this.map.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 18, duration: 250 });
  }

  /** Copies the local paths of the chosen images, one per line. */
  async copyPaths(): Promise<void> {
    const paths = this.chosen().flatMap((r) => (r.source?.kind === 'path' ? [r.source.path] : []));
    if (!paths.length) return;
    try {
      await navigator.clipboard.writeText(paths.join('\n'));
      this.options.say(`ローカルパス ${paths.length} 件をコピーしました`);
    } catch {
      this.options.say(`コピーできませんでした: ${paths.join(' ')}`);
    }
  }
}

/** Rows of the information panel for an image opened from a catalog. */
export function catalogInfo(record: CatalogRecord, catalog: CatalogConfig): Array<[string, string]> {
  const { fields, labels } = catalog;
  const rows: Array<[string, string]> = [['カタログ', catalog.label]];
  if (fields.id && record.id) rows.push([labels.id ?? roleLabels.id, record.id]);
  if (fields.acquired && record.acquired !== null) rows.push([labels.acquired ?? roleLabels.acquired, timeText(record.acquired)]);
  if (fields.registered && record.registered !== null) rows.push([labels.registered ?? roleLabels.registered, timeText(record.registered)]);
  if (fields.sensor && record.sensor) rows.push([labels.sensor ?? roleLabels.sensor, record.sensor]);
  if (fields.angle && record.angle !== null) rows.push([labels.angle ?? roleLabels.angle, `${record.angle}°`]);
  for (const c of catalog.columns) {
    const v = record.feature.get(c.field);
    if (v !== null && v !== undefined && v !== '') rows.push([c.label, String(v)]);
  }
  return rows;
}
