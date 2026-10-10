/**
 * The 「撮像計画」 panel: when can the satellites of a catalog (config.json's
 * satelliteCatalogs, imaging-plan.ts) next take a picture of the features of
 * a layer, the selected features, or a point clicked on the map? It lists the
 * opportunities in time order; choosing one draws its ground track, how far
 * the satellite can reach and the scenes that cover the target. For areas
 * (polygons) each pass shows how much of it it covers, and 「組み合わせ」
 * strings passes of all the satellites together until the whole is covered,
 * keeping each satellite's interval between shots and its daily limit. The list
 * saves as CSV, and the scenes can be added as a layer (with their times, so
 * the timeline and table work on them).
 *
 * The everyday form is the target, the period and an off-nadir limit; which
 * satellites, daylight, pasted TLEs and the like wait under 「詳細条件」.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { LineString, MultiPolygon, Point, Polygon, type Geometry } from 'ol/geom.js';
import { createEmpty, extend, getCenter, isEmpty } from 'ol/extent.js';
import { fromLonLat, transform } from 'ol/proj.js';
import type { Selection } from './selection.js';
import type { ViewerLayer, ViewerService } from './images.js';
import { esriJson } from './services/esri.js';
import { download } from './local-edit.js';
import { field, type ProcessingResult } from './processing/common.js';
import { wgs84 } from './vector-write.js';
import {
  builtInDefaults,
  coverPlan,
  SAMPLE_SOURCE,
  sampleSatellites,
  passShapes,
  satelliteOf,
  satellitesFromText,
  tleEpoch,
  type CoverPlan,
  type Opportunity,
  type PlanOptions,
  type PlanResult,
  type PlanTarget,
  type SatelliteCatalogConfig,
  type SatelliteSpec,
} from './imaging-plan.js';
import type { PlanJob } from './imaging-plan-worker.js';

export interface PlanPanelOptions {
  /** The layers of the viewer, for the target. */
  layers: () => readonly ViewerLayer[];
  selection: Selection;
  say: (message: string) => void;
  /** Adds the planned scenes as a layer. */
  onLayer: (result: ProcessingResult, made: string) => void;
}

/** The most features planned one by one. */
export const MAX_TARGETS = 200;
/** The most points of an area used for its width. */
const MAX_POINTS = 256;
/** About how many cells sample an area (fewer when the polygons fill little of their extent). */
const CELLS = 600;
/** A TLE older than this many days is marked in the list. */
const OLD_TLE = 14;

/** Reads the satellites of a catalog. */
export async function loadSatellites(catalog: SatelliteCatalogConfig): Promise<{ satellites: SatelliteSpec[]; problems: string[] }> {
  const json = await esriJson<{ features?: Array<{ attributes: Record<string, unknown> }>; exceededTransferLimit?: boolean }>(
    `${catalog.url}/query`,
    { where: catalog.where ?? '1=1', outFields: '*', returnGeometry: 'false' },
    catalog.token,
    true,
  );
  const satellites: SatelliteSpec[] = [];
  const problems: string[] = [];
  for (const f of json.features ?? []) {
    const sat = satelliteOf(f.attributes ?? {}, catalog);
    if (typeof sat === 'string') problems.push(sat);
    else satellites.push(sat);
  }
  if (json.exceededTransferLimit) problems.push(`衛星が多すぎるため、先頭 ${satellites.length} 機だけを読みました`);
  return { satellites, problems };
}

/** Up to `max` of `items`, evenly spread. */
function spreadOut<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]);
}

/** The vertices of a geometry (in WGS 84) as longitude, latitude pairs. */
function verticesOf(geometry: Geometry): Array<[number, number]> {
  const flat = (geometry as Geometry & { getFlatCoordinates?: () => number[]; getStride?: () => number }).getFlatCoordinates?.();
  const stride = (geometry as Geometry & { getStride?: () => number }).getStride?.() ?? 2;
  if (!flat) return [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += stride) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** A target for features (in `projection`): one feature, or several planned as one area. */
export function targetOf(features: Feature[], projection: string, label: string): PlanTarget | null {
  const points: Array<[number, number]> = [];
  const extent = createEmpty();
  let center: [number, number] | null = null;
  const areas: Array<Polygon | MultiPolygon> = [];
  for (const feature of features) {
    const geometry = feature.getGeometry()?.clone().transform(projection, 'EPSG:4326');
    if (!geometry) continue;
    extend(extent, geometry.getExtent());
    if (geometry instanceof Polygon || geometry instanceof MultiPolygon) areas.push(geometry);
    points.push(...verticesOf(geometry));
    // One polygon: aim inside it (its middle can fall outside a bent one).
    if (features.length === 1 && geometry instanceof Polygon) center = geometry.getInteriorPoint().getCoordinates().slice(0, 2) as [number, number];
  }
  if (isEmpty(extent)) return null;
  center ??= getCenter(extent) as [number, number];
  const unique = points.length === 1 ? [] : spreadOut(points, MAX_POINTS);
  const cells = cellsOf(areas);
  return { label, center, points: unique, ...(cells.length ? { cells } : {}) };
}

/**
 * Points evenly spread inside polygons (in WGS 84), about {@link CELLS} of
 * them: a grid over their extent, square on the ground, keeping the points
 * inside. A grid finer by half is tried while too few fall inside (thin or
 * scattered polygons).
 */
export function cellsOf(areas: Array<Polygon | MultiPolygon>): Array<[number, number]> {
  if (!areas.length) return [];
  const extent = createEmpty();
  for (const a of areas) extend(extent, a.getExtent());
  const [w, s, e, n] = extent;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const width = Math.max((e - w) * k, 1e-9);
  const height = Math.max(n - s, 1e-9);
  let step = Math.sqrt((width * height) / CELLS);
  let cells: Array<[number, number]> = [];
  for (let tries = 0; tries < 4; tries++) {
    cells = [];
    const nx = Math.max(1, Math.round(width / step));
    const ny = Math.max(1, Math.round(height / step));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c: [number, number] = [w + ((e - w) * (i + 0.5)) / nx, s + ((n - s) * (j + 0.5)) / ny];
        if (areas.some((a) => a.intersectsCoordinate(c))) cells.push(c);
      }
    }
    if (cells.length >= CELLS / 4) break;
    step /= 2;
  }
  return spreadOut(cells, CELLS * 4);
}

/** A feature's name for the list: a name-like attribute, its id, or its number. */
function nameOf(feature: Feature, index: number): string {
  for (const key of ['name', 'NAME', 'Name', '名称', 'title', 'TITLE']) {
    const v = feature.get(key);
    if (v !== null && v !== undefined && v !== '') return String(v);
  }
  const id = feature.getId();
  return id === undefined ? `地物 ${index + 1}` : String(id);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A time in local time, `2026/10/11 10:23`. */
export function localText(ms: number, seconds = false): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}
/** A time for a datetime-local input. */
const inputText = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const round = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);
const sideText = (op: Opportunity) => `${op.side === 'right' ? '右' : '左'}・${op.ascending ? '北行' : '南行'}`;
const percent = (v: number) => (v >= 0.995 ? '100%' : `${Math.max(v > 0 ? 1 : 0, Math.round(v * 100))}%`);
/** How much of the target a pass covers: a share for an area, scenes for a point or line. */
const coverText = (op: Opportunity, sat: SatelliteSpec) =>
  op.cells
    ? op.coverage >= 0.995
      ? '全域'
      : percent(op.coverage)
    : op.width === 0
      ? '1 シーン'
      : op.strips === 1
        ? `1 シーン（幅 ${round(op.width, 0)} km）`
        : `${op.strips} シーン（幅 ${round(op.width, 0)} km ／ 観測幅 ${round(sat.swath)} km）`;
const coverTitle = (op: Opportunity, sat: SatelliteSpec) =>
  op.cells
    ? `この回の ${sat.scenesPerPass} シーン（観測幅 ${round(sat.swath)} km）で対象の ${percent(op.coverage)} を撮像。対象の幅 ${round(op.width, 0)} km を覆うには ${op.strips} シーン分`
    : '';

/** The CSV of a plan's opportunities (with a BOM, for spreadsheets). */
export function planCsv(ops: Opportunity[], sats: SatelliteSpec[], targets: PlanTarget[]): string {
  const cell = (v: unknown) => {
    const text = String(v ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const combined = ops.some((op) => op.cumulative !== undefined);
  const head = [
    '日時（UTC）',
    '日時（ローカル）',
    '衛星',
    '衛星ID',
    '対象',
    '経度',
    '緯度',
    'オフナディア角',
    '入射角',
    '方向',
    '軌道',
    '太陽高度',
    '幅km',
    'シーン数',
    '被覆率%',
    ...(combined ? ['追加%', '累計%'] : []),
    'TLE経過日数',
  ];
  const rows = ops.map((op) => {
    const sat = sats[op.satellite];
    const t = targets[op.target];
    return [
      new Date(op.time).toISOString().replace(/\.\d+Z$/, 'Z'),
      localText(op.time, true),
      sat.name,
      sat.id,
      t.label,
      round(t.center[0], 6),
      round(t.center[1], 6),
      round(op.offNadir, 2),
      round(op.incidence, 2),
      op.side === 'right' ? '右' : '左',
      op.ascending ? '北行' : '南行',
      round(op.sunElevation, 1),
      round(op.width, 1),
      op.strips,
      round(op.coverage * 100, 1),
      ...(combined ? [round((op.gain ?? 0) * 100, 1), round((op.cumulative ?? 0) * 100, 1)] : []),
      round(op.tleAge, 1),
    ];
  });
  return `\ufeff${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** What one listed satellite is, for its checkbox. */
interface Listed {
  sat: SatelliteSpec;
  box: HTMLInputElement;
}

type SortKey = 'time' | 'satellite' | 'target' | 'offNadir' | 'side' | 'sun' | 'cover' | 'gain' | 'cumulative';

const overlayStyle = (feature: Feature): Style | Style[] => {
  switch (feature.get('kind')) {
    case 'target':
      return new Style({
        stroke: new Stroke({ color: '#f97316', width: 2 }),
        fill: new Fill({ color: 'rgba(249, 115, 22, 0.08)' }),
        image: new Circle({ radius: 6, stroke: new Stroke({ color: '#fff', width: 2 }), fill: new Fill({ color: '#f97316' }) }),
      });
    case 'track':
      return new Style({ stroke: new Stroke({ color: '#475569', width: 2, lineDash: [8, 6] }) });
    case 'reach':
      return new Style({ stroke: new Stroke({ color: '#0ea5e9', width: 1.5, lineDash: [3, 4] }) });
    case 'scene':
      return new Style({ stroke: new Stroke({ color: '#2563eb', width: 2 }), fill: new Fill({ color: 'rgba(37, 99, 235, 0.25)' }) });
    case 'step':
      // The other passes of a combination, numbered in time order.
      return new Style({
        stroke: new Stroke({ color: '#7c3aed', width: 1.5, lineDash: [6, 4] }),
        fill: new Fill({ color: 'rgba(124, 58, 237, 0.12)' }),
        text: new Text({
          text: String(feature.get('label') ?? ''),
          font: 'bold 13px sans-serif',
          overflow: true,
          fill: new Fill({ color: '#4c1d95' }),
          stroke: new Stroke({ color: '#fff', width: 3 }),
        }),
      });
    case 'satellite':
      return new Style({
        image: new Circle({ radius: 7, stroke: new Stroke({ color: '#fff', width: 2 }), fill: new Fill({ color: '#1e3a5f' }) }),
        text: new Text({
          text: String(feature.get('label') ?? ''),
          font: '12px sans-serif',
          offsetY: -16,
          fill: new Fill({ color: '#111' }),
          stroke: new Stroke({ color: '#fff', width: 3 }),
        }),
      });
    default:
      return [];
  }
};

export class ImagingPlanPanel {
  readonly dialog: HTMLDialogElement;
  /** Targets and the chosen pass, on the map while the panel is open. */
  readonly overlay = new VectorLayer({ source: new VectorSource<Feature>(), style: (f) => overlayStyle(f as Feature), zIndex: 1001 });
  private readonly form_: HTMLFormElement;
  private readonly catalogs_: HTMLSelectElement;
  private readonly target_: HTMLSelectElement;
  private readonly sats_: HTMLElement;
  private readonly satsSummary_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly firstOnly_: HTMLInputElement;
  private readonly view_: HTMLSelectElement;
  private readonly goal_: HTMLInputElement;
  private readonly csv_: HTMLButtonElement;
  private readonly layer_: HTMLButtonElement;
  private readonly zoom_: HTMLButtonElement;
  private catalog_: SatelliteCatalogConfig | null;
  private loaded_: Promise<void> | null = null;
  private catalogSats_: SatelliteSpec[] = [];
  private listed_: Listed[] = [];
  /** The point clicked on the map, when the target is one. */
  private clicked_: [number, number] | null = null;
  private worker_: Worker | null = null;
  /** The last plan: what was planned and what was found. */
  private plan_: { sats: SatelliteSpec[]; targets: PlanTarget[]; result: PlanResult; options: PlanOptions } | null = null;
  /** The combination of the last plan, for the goal it was made for. */
  private cover_: { goal: number; plans: CoverPlan[] } | null = null;
  private shown_: Opportunity[] = [];
  private chosen_: Opportunity | null = null;
  private sort_: { key: SortKey; descending: boolean } = { key: 'time', descending: false };

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly catalogs: SatelliteCatalogConfig[],
    private readonly options: PlanPanelOptions,
  ) {
    this.catalog_ = catalogs[0] ?? null;
    // Without a catalog in config.json, two fixed sample satellites stand in, so the panel can be tried at once.
    if (!this.catalog_) this.catalogSats_ = sampleSatellites();
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service plan-dialog';
    this.dialog.setAttribute('aria-labelledby', 'plan-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="plan-title">撮像計画</h2>
        <select name="catalog" aria-label="衛星カタログ" ${catalogs.length > 1 ? '' : 'hidden'}></select>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <form class="service-form plan-form">
        <label class="plan-target">対象<select name="target"></select></label>
        <label>開始<input name="start" type="datetime-local" /></label>
        <label>期間<select name="days"><option value="1">1 日</option><option value="3">3 日</option><option value="7" selected>7 日</option><option value="14">14 日</option><option value="30">30 日</option></select></label>
        <label>オフナディア角（以下）<input name="maxOffNadir" type="number" min="0" max="80" step="any" placeholder="衛星の上限" /></label>
        <details class="catalog-more wide plan-more">
          <summary>詳細条件</summary>
          <div class="plan-more-body">
            <fieldset class="plan-sats">
              <legend>衛星 <span class="plan-sats-count"></span> <button type="button" value="all">すべて</button> <button type="button" value="none">解除</button></legend>
              <div class="plan-sats-list"></div>
            </fieldset>
            <div class="plan-options">
              <label>日照条件<select name="daylight"><option value="optical">光学衛星は日中のみ</option><option value="none">考慮しない</option></select></label>
              <label>太陽高度（以上）<input name="minSun" type="number" min="-18" max="90" step="any" value="10" /></label>
              <label class="check"><input name="each" type="checkbox" checked />地物ごとに計算</label>
              <label class="wide">TLE を貼り付けて追加<textarea name="tle" rows="3" placeholder="ISS (ZARYA)&#10;1 25544U 98067A   …&#10;2 25544  51.6416 …" spellcheck="false"></textarea></label>
              <div class="plan-pasted wide">
                <label>最大オフナディア角<input name="pasteMax" type="number" min="0" max="80" step="any" value="${builtInDefaults.maxOffNadir}" /></label>
                <label>観測幅（km）<input name="pasteSwath" type="number" min="0.1" step="any" value="${builtInDefaults.swath}" /></label>
                <label>撮像間隔（分）<input name="pasteGap" type="number" min="0" step="any" value="0" title="1 回撮像してから次に撮像できるまでの時間。0 は制約なし" /></label>
                <label>1 日の上限（回）<input name="pastePerDay" type="number" min="0" step="1" value="0" title="24 時間に撮像できる回数。0 は制約なし" /></label>
                <label class="check"><input name="pasteSar" type="checkbox" />SAR（夜間も撮像）</label>
              </div>
            </div>
          </div>
        </details>
        <button type="submit" class="primary catalog-search">計算</button>
      </form>
      <p class="service-status" role="status"></p>
      <div class="plan-view" hidden>
        <select name="view" aria-label="表示">
          <option value="all">すべての機会</option>
          <option value="cover">組み合わせ（全域を最短で）</option>
        </select>
        <label class="plan-goal" hidden title="面の対象をどこまで覆えば完了とするか">目標<input name="goal" type="number" min="10" max="100" step="1" value="95" />%</label>
        <label class="check plan-first"><input type="checkbox" name="firstOnly" />衛星・対象ごとに最初の機会のみ</label>
      </div>
      <div class="catalog-results"><table class="catalog-table plan-table"><thead></thead><tbody></tbody></table></div>
      <div class="service-actions catalog-actions">
        <button type="button" value="csv" disabled title="一覧を CSV で保存します">CSV 保存</button>
        <button type="button" value="layer" disabled title="撮像範囲をレイヤーとして追加します（撮像時刻つき。タイムラインで絞り込めます）">レイヤーとして追加</button>
        <button type="button" value="zoom" class="primary" disabled>範囲へ移動</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.catalogs_ = this.dialog.querySelector('select[name=catalog]')!;
    this.target_ = this.form_.elements.namedItem('target') as HTMLSelectElement;
    this.sats_ = this.dialog.querySelector('.plan-sats-list')!;
    this.satsSummary_ = this.dialog.querySelector('.plan-sats-count')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.table_ = this.dialog.querySelector('table')!;
    this.firstOnly_ = this.dialog.querySelector('input[name=firstOnly]')!;
    this.view_ = this.dialog.querySelector('select[name=view]')!;
    this.goal_ = this.dialog.querySelector('input[name=goal]')!;
    this.csv_ = this.dialog.querySelector('button[value=csv]')!;
    this.layer_ = this.dialog.querySelector('button[value=layer]')!;
    this.zoom_ = this.dialog.querySelector('button[value=zoom]')!;

    catalogs.forEach((c, i) => this.catalogs_.add(new Option(c.label, String(i))));
    this.catalogs_.addEventListener('change', () => {
      this.catalog_ = this.catalogs[Number(this.catalogs_.value)];
      this.loaded_ = null;
      void this.loadCatalog();
    });
    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => {
      map.removeLayer(this.overlay);
      this.worker_?.terminate();
      this.worker_ = null;
    });
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run();
    });
    this.target_.addEventListener('change', () => this.showTargets());
    this.dialog.querySelector('.plan-sats button[value=all]')!.addEventListener('click', () => this.checkAll(true));
    this.dialog.querySelector('.plan-sats button[value=none]')!.addEventListener('click', () => this.checkAll(false));
    this.sats_.addEventListener('change', () => this.countSats());
    for (const name of ['tle', 'pasteMax', 'pasteSwath', 'pasteGap', 'pastePerDay', 'pasteSar']) (this.form_.elements.namedItem(name) as HTMLInputElement).addEventListener('change', () => this.listSats());
    this.firstOnly_.addEventListener('change', () => this.render());
    this.view_.addEventListener('change', () => this.showView());
    this.goal_.addEventListener('change', () => this.showView());
    this.csv_.addEventListener('click', () => this.saveCsv());
    this.layer_.addEventListener('click', () => this.addLayer());
    this.zoom_.addEventListener('click', () => this.zoomToChosen());
    options.selection.on('change', () => {
      if (this.dialog.open) this.listTargets();
    });

    // While the target is 「地図でクリックした地点」, a click on the map sets it.
    map.on('singleclick', (e) => {
      if (!this.dialog.open || this.target_.value !== 'click') return;
      const projection = map.getView().getProjection();
      this.clicked_ = transform(e.coordinate, projection, 'EPSG:4326') as [number, number];
      this.showTargets();
      this.status_.textContent = `地点 ${round(this.clicked_[1], 5)}, ${round(this.clicked_[0], 5)} を対象にしました。「計算」で撮像機会を探します`;
    });
  }

  /** Shows the panel (non-modal, so the map stays usable). */
  open(): void {
    if (!this.map.getLayers().getArray().includes(this.overlay)) this.map.addLayer(this.overlay);
    const start = this.form_.elements.namedItem('start') as HTMLInputElement;
    if (!start.value) start.value = inputText(Date.now());
    this.listTargets();
    this.dialog.show();
    if (!this.catalog_) {
      if (!this.listed_.length) this.listSats();
      if (!this.plan_) {
        this.status_.textContent =
          'config.json に衛星カタログ（satelliteCatalogs）がないので、サンプル衛星 2 機（光学・SAR。実在の衛星ではありません）で計算します。「詳細条件」で TLE を貼り付けて追加できます';
      }
    } else void this.loadCatalog();
  }

  close(): void {
    this.dialog.close();
  }

  /** The satellites listed (catalog and pasted), and whether each is checked. */
  satellites(): Array<{ sat: SatelliteSpec; checked: boolean }> {
    return this.listed_.map((l) => ({ sat: l.sat, checked: l.box.checked }));
  }

  /** The opportunities listed, in the list's order. */
  opportunities(): Opportunity[] {
    return this.shown_;
  }

  private async loadCatalog(): Promise<void> {
    const catalog = this.catalog_;
    if (!catalog) return;
    this.loaded_ ??= (async () => {
      this.status_.textContent = '衛星カタログを読んでいます…';
      try {
        const { satellites, problems } = await loadSatellites(catalog);
        if (catalog !== this.catalog_) return;
        this.catalogSats_ = satellites;
        this.listSats();
        this.status_.textContent = `${catalog.label}: ${satellites.length} 機${problems.length ? `（読めなかったもの ${problems.length} 件: ${problems.slice(0, 3).join('、')}${problems.length > 3 ? ' …' : ''}）` : ''}。対象と期間を選んで「計算」`;
      } catch (error) {
        this.loaded_ = null;
        this.status_.textContent = `衛星カタログを読めませんでした: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    return this.loaded_;
  }

  /** The satellites pasted in the TLE box. */
  private pasted(): SatelliteSpec[] {
    const value = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).value;
    const max = Number(value('pasteMax'));
    const swath = Number(value('pasteSwath'));
    const gap = Number(value('pasteGap'));
    const perDay = Number(value('pastePerDay'));
    return satellitesFromText(value('tle'), {
      ...builtInDefaults,
      maxOffNadir: Number.isFinite(max) && max > 0 ? max : builtInDefaults.maxOffNadir,
      swath: Number.isFinite(swath) && swath > 0 ? swath : builtInDefaults.swath,
      minInterval: Number.isFinite(gap) && gap > 0 ? gap : 0,
      maxPerDay: Number.isFinite(perDay) && perDay > 0 ? Math.round(perDay) : 0,
      sar: (this.form_.elements.namedItem('pasteSar') as HTMLInputElement).checked,
    });
  }

  /** Lists the satellites with checkboxes, keeping what was unchecked. */
  private listSats(): void {
    const unchecked = new Set(this.listed_.filter((l) => !l.box.checked).map((l) => `${l.sat.source}\n${l.sat.id}`));
    const now = Date.now();
    this.listed_ = [...this.catalogSats_, ...this.pasted()].map((sat) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !unchecked.has(`${sat.source}\n${sat.id}`);
      return { sat, box };
    });
    this.sats_.replaceChildren(
      ...this.listed_.map(({ sat, box }) => {
        const label = document.createElement('label');
        label.className = 'check';
        const age = (now - tleEpoch(sat)) / 86400000;
        const facts = [`最大 ${round(sat.maxOffNadir)}°`, sat.minOffNadir > 0 ? `最小 ${round(sat.minOffNadir)}°` : '', `幅 ${round(sat.swath)} km`, sat.scenesPerPass > 1 ? `1 パス ${sat.scenesPerPass} シーン` : '', sat.minInterval > 0 ? `間隔 ${round(sat.minInterval)} 分` : '', sat.maxPerDay > 0 ? `1 日 ${sat.maxPerDay} 回` : '', sat.lookSide === 'both' ? '' : sat.lookSide === 'right' ? '右向き' : '左向き', sat.sar ? 'SAR' : '光学']
          .filter(Boolean)
          .join('・');
        const note = document.createElement('small');
        note.textContent = facts;
        label.title = sat.source === SAMPLE_SOURCE ? 'サンプル（決め打ちの軌道。実在の衛星ではありません）' : `${sat.source}${Number.isNaN(age) ? '' : `・TLE ${round(age, 0)} 日前`}`;
        label.append(box, document.createTextNode(sat.name), note);
        if (sat.source !== SAMPLE_SOURCE && Math.abs(age) > OLD_TLE) {
          const old = document.createElement('span');
          old.className = 'plan-old';
          old.textContent = 'TLE 古い';
          old.title = `TLE の元期が ${round(age, 0)} 日前です。予測がずれることがあります`;
          label.append(old);
        }
        return label;
      }),
    );
    this.countSats();
  }

  private checkAll(on: boolean): void {
    for (const l of this.listed_) l.box.checked = on;
    this.countSats();
  }

  private countSats(): void {
    const on = this.listed_.filter((l) => l.box.checked).length;
    this.satsSummary_.textContent = `（${on} / ${this.listed_.length}）`;
  }

  /** The vector layers that can be targets. */
  private vectorLayers(): ViewerService[] {
    return this.options.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector && !l.service.tableOnly);
  }

  /** Fills the target choice: the selected features, each vector layer, a clicked point. */
  listTargets(): void {
    const before = this.target_.value;
    const selected = this.options.selection.list().length;
    const options = [
      ...(selected ? [new Option(`選択中の地物（${selected}）`, 'selection')] : []),
      ...this.vectorLayers().map((l, i) => new Option(`${l.name}（${l.service.vector!.source.getFeatures().length.toLocaleString()}）`, `layer:${i}`)),
      new Option('地図でクリックした地点', 'click'),
    ];
    this.target_.replaceChildren(...options);
    this.target_.value = options.some((o) => o.value === before) ? before : options[0].value;
    this.showTargets();
  }

  /** The targets the form asks for (in WGS 84), or the reason there are none. */
  targets(): PlanTarget[] | string {
    const choice = this.target_.value;
    const projection = this.map.getView().getProjection().getCode();
    if (choice === 'click') {
      if (!this.clicked_) return '地図をクリックして地点を指定してください';
      return [{ label: `${round(this.clicked_[1], 5)}, ${round(this.clicked_[0], 5)}`, center: this.clicked_, points: [] }];
    }
    let features: Feature[];
    let name: string;
    if (choice === 'selection') {
      features = this.options.selection.list();
      name = '選択中の地物';
    } else {
      const layer = this.vectorLayers()[Number(choice.slice('layer:'.length))];
      if (!layer) return '対象のレイヤーがありません';
      features = layer.service.vector!.source.getFeatures();
      name = layer.name;
    }
    features = features.filter((f) => f.getGeometry());
    if (!features.length) return '対象に図形がありません';
    const each = (this.form_.elements.namedItem('each') as HTMLInputElement).checked;
    if (!each || features.length === 1) {
      const t = targetOf(features, projection, features.length === 1 ? nameOf(features[0], 0) : name);
      return t ? [t] : '対象に図形がありません';
    }
    if (features.length > MAX_TARGETS) return `地物が ${features.length.toLocaleString()} 件あります。${MAX_TARGETS} 件以下を選択するか、「詳細条件」の「地物ごとに計算」を外してまとめて計算してください`;
    return features.flatMap((f, i) => {
      const t = targetOf([f], projection, nameOf(f, i));
      return t ? [t] : [];
    });
  }

  /** Draws the targets (and the chosen pass) on the map. */
  private showTargets(): void {
    const source = this.overlay.getSource()!;
    source.clear();
    const targets = this.targets();
    if (typeof targets !== 'string') {
      const projection = this.map.getView().getProjection();
      const choice = this.target_.value;
      if (choice === 'click') source.addFeature(new Feature({ kind: 'target', target: 0, geometry: new Point(transform(this.clicked_!, 'EPSG:4326', projection)) }));
      else {
        // The features themselves, outlined.
        const features = choice === 'selection' ? this.options.selection.list() : (this.vectorLayers()[Number(choice.slice(6))]?.service.vector!.source.getFeatures() ?? []);
        const each = (this.form_.elements.namedItem('each') as HTMLInputElement).checked;
        features
          .filter((f) => f.getGeometry())
          .slice(0, 2000)
          .forEach((f, i) => source.addFeature(new Feature({ kind: 'target', target: each ? i : 0, geometry: f.getGeometry()!.clone() })));
      }
    }
    if (this.chosen_ && this.plan_) this.drawPass(this.chosen_);
  }

  /** What the form asks for. */
  planOptions(): PlanOptions {
    const value = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).value;
    const start = value('start') ? new Date(value('start')).getTime() : Date.now();
    const days = Number(value('days')) || 7;
    const cap = value('maxOffNadir');
    const sun = Number(value('minSun'));
    return {
      start,
      end: start + days * 86400000,
      maxOffNadir: cap === '' ? null : Number(cap),
      daylight: value('daylight') === 'none' ? 'none' : 'optical',
      minSunElevation: Number.isFinite(sun) ? sun : 10,
    };
  }

  /** Plans the checked satellites over the targets, in a worker. */
  async run(): Promise<void> {
    if (this.catalog_) await this.loadCatalog();
    const sats = this.listed_.filter((l) => l.box.checked).map((l) => l.sat);
    const targets = this.targets();
    if (typeof targets === 'string') return void (this.status_.textContent = targets);
    if (!sats.length) {
      this.dialog.querySelector<HTMLDetailsElement>('.plan-more')!.open = true;
      this.status_.textContent = this.listed_.length ? '衛星を選んでください（詳細条件）' : '衛星がありません。衛星カタログを確認するか、「詳細条件」に TLE を貼り付けてください';
      return;
    }
    const options = this.planOptions();
    this.worker_?.terminate();
    const worker = new Worker(new URL('./imaging-plan-worker.ts', import.meta.url), { type: 'module' });
    this.worker_ = worker;
    this.status_.textContent = `${sats.length} 機 × ${targets.length} 対象を計算しています…`;
    const result = await new Promise<PlanResult | string>((resolve) => {
      worker.onmessage = (e: MessageEvent<{ progress?: number; result?: PlanResult; error?: string }>) => {
        if (e.data.progress !== undefined) this.status_.textContent = `${sats.length} 機 × ${targets.length} 対象を計算しています… ${Math.round(e.data.progress * 100)}%`;
        else resolve(e.data.result ?? e.data.error ?? '計算できませんでした');
      };
      worker.onerror = (e) => resolve(e.message || '計算できませんでした');
      worker.postMessage({ satellites: sats, targets, options } satisfies PlanJob);
    });
    worker.terminate();
    if (this.worker_ !== worker) return;
    this.worker_ = null;
    if (typeof result === 'string') return void (this.status_.textContent = `計算できませんでした: ${result}`);
    this.plan_ = { sats, targets, result, options };
    this.cover_ = null;
    this.dialog.querySelector<HTMLElement>('.plan-view')!.hidden = result.opportunities.length === 0;
    // An area no single pass covers: start with the combination that covers it.
    const best = new Map<number, number>();
    for (const op of result.opportunities) if (op.cells) best.set(op.target, Math.max(best.get(op.target) ?? 0, op.coverage));
    this.view_.value = [...best.values()].some((c) => c < 0.95) ? 'cover' : 'all';
    this.showView();
  }

  /** Whether the list is the combination rather than every opportunity. */
  private combining(): boolean {
    return this.view_.value === 'cover';
  }

  /** The combination of the last plan for the goal in the form (made again when the goal changes). */
  coverPlans(): CoverPlan[] {
    const plan = this.plan_!;
    const goal = Math.min(1, Math.max(0.1, (Number(this.goal_.value) || 95) / 100));
    if (this.cover_?.goal !== goal) this.cover_ = { goal, plans: coverPlan(plan.result.opportunities, plan.targets, plan.sats, goal) };
    return this.cover_.plans;
  }

  /** Lists the last plan in the chosen view, with what it found in the status line. */
  private showView(): void {
    const plan = this.plan_;
    if (!plan) return;
    const combining = this.combining();
    this.goal_.closest('label')!.hidden = !combining;
    this.firstOnly_.closest('label')!.hidden = combining;
    // A column the view does not have sorts by time instead.
    if (combining ? this.sort_.key === 'cover' : this.sort_.key === 'gain' || this.sort_.key === 'cumulative') this.sort_ = { key: 'time', descending: false };
    this.chosen_ = null;
    this.render();
    const { sats, targets, result } = plan;
    const problems = result.problems.length ? `（計算できなかった衛星: ${result.problems.join('、')}）` : '';
    const first = result.opportunities[0];
    if (!first) {
      this.status_.textContent = `期間内に撮像できる機会はありません。期間を延ばすか、オフナディア角の制限・日照条件を見直してください${problems}`;
    } else if (!combining) {
      this.status_.textContent = `${result.opportunities.length.toLocaleString()} 回。最短は ${localText(first.time)}（${sats[first.satellite].name}、オフナディア角 ${round(first.offNadir)}°）。行を選ぶと地図に軌道と撮像範囲を表示します${problems}`;
    } else {
      const plans = this.coverPlans();
      const done = plans.filter((p) => p.done !== null);
      const blocked = plans.reduce((n, p) => n + p.blocked, 0);
      const line = (p: CoverPlan) =>
        `${targets[p.target].label}: ${p.steps.length} パスで ${percent(p.coverage)}${p.done !== null ? `（${localText(p.done)} 完了）` : '（期間内に目標に届きません）'}`;
      const summary =
        plans.length <= 3
          ? plans.map(line).join('、')
          : `${plans.length} 対象のうち ${done.length} 対象が期間内に完了${done.length ? `（最後は ${localText(Math.max(...done.map((p) => p.done!)))}）` : ''}`;
      this.status_.textContent = `${summary}。${blocked ? `撮像間隔・1 日の上限のため見送ったパス ${blocked} 回。` : ''}行を選ぶと、その回と同じ対象の他の回（番号つき）を地図に表示します${problems}`;
    }
    if (this.shown_.length) this.choose(this.shown_[0]);
  }

  private columns(): Array<{ key: SortKey; label: string; text: (op: Opportunity) => string; title?: (op: Opportunity) => string }> {
    const plan = this.plan_!;
    const many = plan.targets.length > 1;
    return [
      { key: 'time', label: '日時', text: (op) => localText(op.time) },
      {
        key: 'satellite',
        label: '衛星',
        text: (op) => plan.sats[op.satellite].name,
        title: (op) => `${plan.sats[op.satellite].source}・TLE ${round(op.tleAge, 0)} 日${plan.sats[op.satellite].source !== SAMPLE_SOURCE && Math.abs(op.tleAge) > OLD_TLE ? '（古い TLE。予測がずれることがあります）' : ''}`,
      },
      ...(many ? [{ key: 'target' as const, label: '対象', text: (op: Opportunity) => plan.targets[op.target].label }] : []),
      { key: 'offNadir', label: 'オフナディア角', text: (op) => `${round(op.offNadir)}°`, title: (op) => `入射角 ${round(op.incidence)}°・距離 ${round(op.range, 0)} km` },
      { key: 'side', label: '方向', text: sideText, title: () => '衛星の進行方向に対して対象が右か左か、北行（昇交）か南行（降交）か' },
      { key: 'sun', label: '太陽高度', text: (op) => `${round(op.sunElevation, 0)}°` },
      ...(this.combining()
        ? [
            { key: 'gain' as const, label: '追加', text: (op: Opportunity) => `+${percent(op.gain ?? 0)}`, title: () => 'この回で新たに撮像できる対象の割合' },
            { key: 'cumulative' as const, label: '累計', text: (op: Opportunity) => percent(op.cumulative ?? 0), title: () => 'この回までに撮像できた対象の割合' },
          ]
        : [{ key: 'cover' as const, label: '被覆', text: (op: Opportunity) => coverText(op, plan.sats[op.satellite]), title: (op: Opportunity) => coverTitle(op, plan.sats[op.satellite]) }]),
    ];
  }

  private sorted(): Opportunity[] {
    const plan = this.plan_!;
    let ops = this.combining() ? this.coverPlans().flatMap((p) => p.steps) : plan.result.opportunities;
    if (!this.combining() && this.firstOnly_.checked) {
      const seen = new Set<string>();
      ops = ops.filter((op) => {
        const key = `${op.satellite}:${op.target}`;
        return seen.has(key) ? false : (seen.add(key), true);
      });
    }
    const value = (op: Opportunity): number | string => {
      switch (this.sort_.key) {
        case 'satellite':
          return plan.sats[op.satellite].name;
        case 'target':
          return plan.targets[op.target].label;
        case 'offNadir':
          return op.offNadir;
        case 'side':
          return sideText(op);
        case 'sun':
          return op.sunElevation;
        case 'cover':
          return op.cells ? op.coverage : op.strips * 1e6 + op.width;
        case 'gain':
          return op.gain ?? 0;
        case 'cumulative':
          return op.target * 10 + (op.cumulative ?? 0);
        default:
          return op.time;
      }
    };
    return [...ops].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ja', { numeric: true });
      return (this.sort_.descending ? -order : order) || a.time - b.time;
    });
  }

  /** Lists the opportunities of the last plan. */
  private render(): void {
    if (!this.plan_) return;
    const columns = this.columns();
    const head = document.createElement('tr');
    for (const column of columns) {
      const th = document.createElement('th');
      const button = document.createElement('button');
      button.type = 'button';
      const on = this.sort_.key === column.key;
      button.textContent = `${column.label}${on ? (this.sort_.descending ? ' ▼' : ' ▲') : ''}`;
      button.title = `${column.label}で並べ替え`;
      th.setAttribute('aria-sort', on ? (this.sort_.descending ? 'descending' : 'ascending') : 'none');
      button.addEventListener('click', () => {
        this.sort_ = { key: column.key, descending: on ? !this.sort_.descending : false };
        this.render();
      });
      th.append(button);
      head.append(th);
    }
    this.table_.tHead!.replaceChildren(head);
    this.shown_ = this.sorted();
    this.table_.tBodies[0].replaceChildren(
      ...this.shown_.map((op) => {
        const row = document.createElement('tr');
        row.tabIndex = -1;
        for (const column of columns) {
          const td = document.createElement('td');
          td.textContent = column.text(op);
          if (column.title) td.title = column.title(op);
          if (!td.title) td.removeAttribute('title');
          if (column.key === 'satellite' && this.plan_!.sats[op.satellite].source !== SAMPLE_SOURCE && Math.abs(op.tleAge) > OLD_TLE) td.classList.add('plan-old-cell');
          row.append(td);
        }
        row.addEventListener('click', () => {
          this.choose(op);
          row.focus();
        });
        row.addEventListener('dblclick', () => this.zoomToChosen());
        return row;
      }),
    );
    this.update();
  }

  /** Chooses an opportunity: its row, and its pass on the map. */
  choose(op: Opportunity): void {
    this.chosen_ = op;
    this.showTargets();
    this.update();
  }

  private update(): void {
    this.shown_.forEach((op, i) => {
      const row = this.table_.tBodies[0].rows[i];
      row?.classList.toggle('chosen', op === this.chosen_);
      row?.setAttribute('aria-selected', String(op === this.chosen_));
    });
    const any = this.shown_.length > 0;
    this.csv_.disabled = !any;
    this.layer_.disabled = !any;
    this.zoom_.disabled = !this.chosen_;
  }

  /** Draws the ground track, reach, scenes and position of an opportunity. */
  private drawPass(op: Opportunity): void {
    const plan = this.plan_!;
    const sat = plan.sats[op.satellite];
    const shapes = passShapes(sat, plan.targets[op.target], op);
    if (!shapes) return;
    const projection = this.map.getView().getProjection();
    const to = (c: [number, number]) => fromLonLat(c, projection);
    const source = this.overlay.getSource()!;
    // Lines that cross the antimeridian are cut there, so they do not sweep across the map.
    const lines = (coords: Array<[number, number]>) => {
      const parts: Array<Array<[number, number]>> = [[]];
      coords.forEach((c, i) => {
        if (i > 0 && Math.abs(c[0] - coords[i - 1][0]) > 180) parts.push([]);
        parts[parts.length - 1].push(c);
      });
      return parts.filter((p) => p.length > 1);
    };
    for (const part of lines(shapes.track)) source.addFeature(new Feature({ kind: 'track', geometry: new LineString(part.map(to)) }));
    for (const edge of shapes.reach) for (const part of lines(edge)) source.addFeature(new Feature({ kind: 'reach', geometry: new LineString(part.map(to)) }));
    for (const ring of shapes.scenes) source.addFeature(new Feature({ kind: 'scene', geometry: new Polygon([ring.map(to)]) }));
    if (this.combining()) {
      // The other passes of the same target's combination, numbered, so what each adds can be seen.
      const steps = this.coverPlans()[op.target]?.steps ?? [];
      steps.forEach((step, i) => {
        if (step.time === op.time && step.satellite === op.satellite) return;
        const other = passShapes(plan.sats[step.satellite], plan.targets[step.target], step);
        for (const ring of other?.scenes ?? []) source.addFeature(new Feature({ kind: 'step', label: String(i + 1), geometry: new Polygon([ring.map(to)]) }));
      });
    }
    source.addFeature(new Feature({ kind: 'satellite', label: `${sat.name} ${localText(op.time).slice(5)}`, geometry: new Point(to(shapes.position)) }));
  }

  /** Fits the view to the chosen opportunity's target, scenes and satellite (or the combination's passes), beside the panel. */
  zoomToChosen(): void {
    const op = this.chosen_;
    if (!op || !this.plan_) return;
    const extent = createEmpty();
    for (const f of this.overlay.getSource()!.getFeatures()) {
      const kind = f.get('kind');
      // A combination shows the target and all its passes; one pass, also where the satellite is.
      const shown = kind === 'scene' || kind === 'step' || (kind === 'satellite' && !this.combining()) || (kind === 'target' && f.get('target') === op.target);
      if (shown) extend(extent, f.getGeometry()!.getExtent());
    }
    if (isEmpty(extent)) return;
    // The panel covers the right of the map: keep what is shown to the left of it.
    const map = this.map.getTargetElement().getBoundingClientRect();
    const panel = this.dialog.getBoundingClientRect();
    const right = this.dialog.open && panel.left > map.left + 200 ? Math.max(60, map.right - panel.left + 40) : 60;
    this.map.getView().fit(extent, { padding: [60, right, 60, 60], maxZoom: 13, duration: 250 });
  }

  /** Saves the listed opportunities as CSV. */
  saveCsv(): void {
    if (!this.plan_ || !this.shown_.length) return;
    const { sats, targets, options } = this.plan_;
    const day = (ms: number) => localText(ms).slice(0, 10).replaceAll('/', '');
    download(`imaging-plan_${day(options.start)}-${day(options.end)}.csv`, planCsv(this.shown_, sats, targets), 'text/csv');
    this.options.say(`撮像機会 ${this.shown_.length} 件を CSV で保存しました`);
  }

  /** The listed opportunities' scenes as a layer: one feature per opportunity, with its time and angles. */
  planLayer(): ProcessingResult | null {
    if (!this.plan_ || !this.shown_.length) return null;
    const { sats, targets } = this.plan_;
    const features: Feature[] = [];
    for (const op of this.shown_) {
      const sat = sats[op.satellite];
      const shapes = passShapes(sat, targets[op.target], op);
      if (!shapes) continue;
      const rings = shapes.scenes.map((ring) => [ring.map((c) => fromLonLat(c, 'EPSG:3857'))]);
      features.push(
        new Feature({
          geometry: rings.length === 1 ? new Polygon(rings[0]) : new MultiPolygon(rings),
          time: op.time,
          satellite: sat.name,
          satellite_id: sat.id,
          target: targets[op.target].label,
          off_nadir: Math.round(op.offNadir * 100) / 100,
          incidence: Math.round(op.incidence * 100) / 100,
          side: op.side === 'right' ? '右' : '左',
          pass: op.ascending ? '北行' : '南行',
          sun: Math.round(op.sunElevation * 10) / 10,
          scenes: op.strips,
          coverage: Math.round(op.coverage * 1000) / 10,
          ...(op.cumulative !== undefined ? { gain: Math.round((op.gain ?? 0) * 1000) / 10, cumulative: Math.round(op.cumulative * 1000) / 10 } : {}),
        }),
      );
    }
    return {
      title: '撮像計画',
      features,
      fields: [
        field('time', 'date', '撮像日時'),
        field('satellite', 'string', '衛星'),
        field('satellite_id', 'string', '衛星ID'),
        field('target', 'string', '対象'),
        field('off_nadir', 'double', 'オフナディア角'),
        field('incidence', 'double', '入射角'),
        field('side', 'string', '方向'),
        field('pass', 'string', '軌道'),
        field('sun', 'double', '太陽高度'),
        field('scenes', 'integer', 'シーン数'),
        field('coverage', 'double', '被覆率%'),
        ...(this.combining() ? [field('gain', 'double', '追加%'), field('cumulative', 'double', '累計%')] : []),
      ],
      crs: wgs84,
    };
  }

  private addLayer(): void {
    const result = this.planLayer();
    if (!result || !this.plan_) return;
    const { options } = this.plan_;
    this.options.onLayer(result, `撮像計画 ${localText(options.start)} から ${Math.round((options.end - options.start) / 86400000)} 日（${result.features.length} 回）`);
  }
}

