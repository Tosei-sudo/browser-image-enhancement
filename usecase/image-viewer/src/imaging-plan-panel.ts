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
import PointerInteraction from 'ol/interaction/Pointer.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
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
  scenesTaken,
  shiftScene,
  trackPlace,
  type CoverPlan,
  type GroundStation,
  type Opportunity,
  type PlanOptions,
  type PlanResult,
  type PlanTarget,
  type SatelliteCatalogConfig,
  type SatelliteSpec,
} from './imaging-plan.js';
import type { PlanJob } from './imaging-plan-worker.js';
import { satellitePass3d, type SatellitePass3d } from './imaging-plan-3d.js';
import { collator } from './table-text.js';
import { SatelliteTree } from './satellite-tree.js';
import { drawTimeline } from './imaging-plan-timeline.js';
import { addReminders, clearReminders, loadReminders, planIcs } from './imaging-plan-remind.js';
import { applyClouds, fetchClouds, placesFor, type CloudForecastConfig } from './imaging-plan-weather.js';
import { addShots, newPlanId, shotFeatures, type PlanStoreConfig, type StoreAsk } from './imaging-plan-store.js';
import { repeatPairs, stereoPairs, type PlanPair } from './imaging-plan-pairs.js';
import { boxOf, cellTargets, gridCells, hoursText, revisitColor, revisitStats, type RevisitCell, type RevisitStats } from './imaging-plan-revisit.js';

export interface PlanPanelOptions {
  /** The layers of the viewer, for the target. */
  layers: () => readonly ViewerLayer[];
  selection: Selection;
  say: (message: string) => void;
  /** Adds the planned scenes as a layer. */
  onLayer: (result: ProcessingResult, made: string) => void;
  /** Called when the chosen opportunity changes (for the 3D view). */
  onChosen?: () => void;
  /** Shows the chosen pass in the 3D view (`right` pixels covered by the panel) instead of fitting the map; false when the 3D view is closed. */
  view3d?: (right: number) => boolean;
  /** Where cloud cover forecasts come from (asked only once turned on); null or absent hides the choice. */
  cloudForecast?: CloudForecastConfig | null;
  /** Ground stations, for when each shot can be sent down; none hides the column. */
  stations?: GroundStation[];
  /** Esri layers plans are saved to; none hides 「保存・追跡…」. */
  planStores?: PlanStoreConfig[];
  /** Asks a plan layer (with the viewer's sign-in). */
  storeAsk?: StoreAsk;
  /** Opens the saved plans (on one plan when given). */
  openSaved?: (planId?: string) => void;
}

/** Where the panel remembers whether cloud forecasts are on. */
const CLOUD_KEY = 'image-viewer-plan-cloud';

/**
 * The most features planned one by one: about 4 s for 20 satellites over 7
 * days (the work grows with features × satellites × days).
 */
export const MAX_TARGETS = 2000;
/** The most opportunities listed as rows (the CSV and the layer take them all). */
const MAX_ROWS = 2000;
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
    for (const p of verticesOf(geometry)) points.push(p);
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
/** An attribute value as a priority number, or null when it is not a number. */
export function priorityOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nameOf(feature: Feature, index: number, field = ''): string {
  for (const key of [...(field ? [field] : []), 'name', 'NAME', 'Name', '名称', 'title', 'TITLE']) {
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
const coverText = (op: Opportunity) =>
  op.cells
    ? op.coverage >= 0.995
      ? '全域'
      : percent(op.coverage)
    : op.width === 0 && op.frames <= 1
      ? '1 シーン'
      : op.strips * op.frames === 1
        ? `1 シーン（幅 ${round(op.width, 0)} km）`
        : `${op.strips * op.frames} シーン（${op.strips > 1 ? `横 ${op.strips}` : ''}${op.strips > 1 && op.frames > 1 ? ' × ' : ''}${op.frames > 1 ? `パス方向 ${op.frames}` : ''}）`;
const coverTitle = (op: Opportunity, sat: SatelliteSpec) =>
  op.cells
    ? `この回は ${scenesTaken(op, sat)} シーン（観測幅 ${round(sat.swath)} km × シーン長 ${round(sat.length)} km をパス方向に連続、1 パス最大 ${sat.scenesPerPass} シーン）で対象の ${percent(op.coverage)} を撮像。対象全体は横 ${op.strips} 列 × パス方向 ${op.frames} 枚`
    : op.strips * op.frames > 1
      ? `幅 ${round(op.width, 0)} km ÷ 観測幅 ${round(sat.swath)} km で横に ${op.strips} 列、長さ ${round(op.length, 0)} km ÷ シーン長 ${round(sat.length)} km でパス方向に ${op.frames} 枚`
      : '';

/** The CSV of a plan's opportunities (with a BOM, for spreadsheets). */
export function planCsv(ops: Opportunity[], sats: SatelliteSpec[], targets: PlanTarget[], stations: readonly GroundStation[] = []): string {
  const cell = (v: unknown) => {
    const text = String(v ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const combined = ops.some((op) => op.cumulative !== undefined);
  const prioritized = targets.some((t) => t.priority !== undefined);
  const clouded = ops.some((op) => op.cloud !== undefined);
  const downlinked = stations.length > 0;
  const paired = ops.some((op) => op.pair);
  const head = [
    '日時（UTC）',
    '日時（ローカル）',
    '発注期限（ローカル）',
    '衛星',
    '衛星ID',
    '対象',
    ...(prioritized ? ['優先度'] : []),
    '経度',
    '緯度',
    'オフナディア角',
    '入射角',
    '方向',
    '軌道',
    '太陽高度',
    '幅km',
    '長さkm',
    'シーン数',
    '被覆率%',
    ...(clouded ? ['雲量予報%'] : []),
    ...(downlinked ? ['受信見込み（ローカル）', '地上局'] : []),
    ...(combined ? ['追加%', '累計%', 'シーン番号', '同じシーンの地点数'] : []),
    ...(paired ? ['2回目（UTC）', '2回目の衛星', '2回目のオフナディア角', '2回目の入射角', '交会角', 'B/H', '垂直基線m', '間隔日'] : []),
    'TLE経過日数',
  ];
  const rows = ops.map((op) => {
    const sat = sats[op.satellite];
    const t = targets[op.target];
    return [
      new Date(op.time).toISOString().replace(/\.\d+Z$/, 'Z'),
      localText(op.time, true),
      sat.leadTime > 0 ? localText(op.time - sat.leadTime * 3600000, true) : '',
      sat.name,
      sat.id,
      t.label,
      ...(prioritized ? [t.priorityText ?? ''] : []),
      round(t.center[0], 6),
      round(t.center[1], 6),
      round(op.offNadir, 2),
      round(op.incidence, 2),
      op.side === 'right' ? '右' : '左',
      op.ascending ? '北行' : '南行',
      round(op.sunElevation, 1),
      round(op.width, 1),
      round(op.length, 1),
      op.strips * op.frames,
      round(op.coverage * 100, 1),
      ...(clouded ? [op.cloud ?? ''] : []),
      ...(downlinked ? [op.downlink ? localText(op.downlink.time, true) : '', op.downlink ? (stations[op.downlink.station]?.name ?? '') : ''] : []),
      ...(combined ? [round((op.gain ?? 0) * 100, 1), round((op.cumulative ?? 0) * 100, 1), op.shot ?? '', op.shotTargets ?? ''] : []),
      ...(paired && op.pair
        ? [
            new Date(op.pair.b.time).toISOString().replace(/\.\d+Z$/, 'Z'),
            sats[op.pair.b.satellite].name,
            round(op.pair.b.offNadir, 2),
            round(op.pair.b.incidence, 2),
            round(op.pair.convergence, 2),
            round(op.pair.bh, 3),
            Math.round(op.pair.baseline),
            round(op.pair.days, 2),
          ]
        : paired
          ? ['', '', '', '', '', '', '', '']
          : []),
      round(op.tleAge, 1),
    ];
  });
  return `\ufeff${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

type SortKey = 'time' | 'satellite' | 'target' | 'priority' | 'offNadir' | 'side' | 'sun' | 'cloud' | 'downlink' | 'cover' | 'gain' | 'cumulative' | 'shot' | 'second' | 'angle' | 'baseline' | 'days';

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
    case 'revisit': {
      // A cell of the revisit map, coloured by its longest wait.
      const [r, g, b] = feature.get('color') as [number, number, number];
      return new Style({
        stroke: new Stroke({ color: `rgba(${r}, ${g}, ${b}, 0.9)`, width: 1 }),
        fill: new Fill({ color: `rgba(${r}, ${g}, ${b}, ${feature.get('chosen') ? 0.6 : 0.35})` }),
        text: new Text({ text: String(feature.get('label') ?? ''), font: '11px sans-serif', fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
      });
    }
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
  private readonly status_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly firstOnly_: HTMLInputElement;
  private readonly view_: HTMLSelectElement;
  private readonly goal_: HTMLInputElement;
  private readonly share_: HTMLInputElement;
  private readonly csv_: HTMLButtonElement;
  private readonly layer_: HTMLButtonElement;
  private readonly zoom_: HTMLButtonElement;
  private readonly remind_: HTMLButtonElement;
  private readonly timeline_: HTMLInputElement;
  private readonly timelineHost_: HTMLElement;
  private readonly cloud_: HTMLInputElement;
  private readonly maxCloud_: HTMLInputElement;
  /** The scene being dragged on the map: the opportunity as it was, and where the drag began in its orbit's frame. */
  private drag_: { op: Opportunity; origin: Opportunity; from: [number, number] } | null = null;
  private catalog_: SatelliteCatalogConfig | null;
  private loaded_: Promise<void> | null = null;
  private catalogSats_: SatelliteSpec[] = [];
  /** The satellites (catalog and pasted) as a checklist: kind → series → satellite. */
  private readonly tree_: SatelliteTree;
  /** The point clicked on the map, when the target is one. */
  private clicked_: [number, number] | null = null;
  private worker_: Worker | null = null;
  /** The last plan: what was planned and what was found. */
  private plan_: { sats: SatelliteSpec[]; targets: PlanTarget[]; result: PlanResult; options: PlanOptions } | null = null;
  /** The pairs of the last plan in a pair view, for the conditions they were found with. */
  private pairs_: { key: string; pairs: PlanPair[] } | null = null;
  /** The revisit map of the last plan: its grid, how often each cell is seen, and the cell chosen. */
  private revisit_: { size: number; cells: RevisitCell[]; stats: RevisitStats[]; chosen: number | null } | null = null;
  /** The combination of the last plan, for the goal it was made for. */
  private cover_: { goal: number; share: boolean; plans: CoverPlan[] } | null = null;
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
              <div class="plan-conds wide">
                <label title="地表から見た衛星の視線と鉛直のなす角。範囲をそろえると見え方（SAR の明るさ・建物の倒れ込み）がそろいます">入射角<span class="plan-range"><input name="minIncidence" type="number" min="0" max="89" step="any" placeholder="下限" aria-label="入射角の下限" />〜<input name="maxIncidence" type="number" min="0" max="89" step="any" placeholder="上限" aria-label="入射角の上限" />°</span></label>
                <label title="北へ進むパス（昇交）か南へ進むパス（降交）か">軌道<select name="pass"><option value="">北行・南行</option><option value="ascending">北行のみ</option><option value="descending">南行のみ</option></select></label>
                <label title="衛星の進行方向に対して、どちら側を見るか">向き<select name="side"><option value="">左右とも</option><option value="right">右のみ</option><option value="left">左のみ</option></select></label>
              </div>
              <div class="plan-cloud wide" hidden>
                <label class="check" title="光学衛星の撮像機会ごとに、その時刻・地点の雲量予報（16 日先まで）を出します。対象の位置を予報サービスへ送ります"><input name="cloud" type="checkbox" />雲量予報（<span class="plan-cloud-label"></span>）</label>
                <label>雲量（以下）<input name="maxCloud" type="number" min="0" max="100" step="1" placeholder="—" />%</label>
              </div>
              <label class="check"><input name="each" type="checkbox" checked />地物ごとに計算</label>
              <label class="plan-name" title="一覧・CSV・レイヤーで対象の名前に使う属性。自動は name・名称 などを探し、なければ ID">名前の属性<select name="nameField"><option value="">自動</option></select></label>
              <label class="plan-priority" title="組み合わせで、優先度の高い地物から衛星の撮像を割り当てます（撮像間隔・1 日の上限で取り合いになるとき、高い方が先に撮れます）">優先度の属性<select name="priority"><option value="">なし</option></select></label>
              <label class="plan-priority">優先する値<select name="priorityOrder"><option value="small">小さいほど優先（1 が最優先）</option><option value="large">大きいほど優先</option></select></label>
              <label class="wide">TLE を貼り付けて追加<textarea name="tle" rows="3" placeholder="ISS (ZARYA)&#10;1 25544U 98067A   …&#10;2 25544  51.6416 …" spellcheck="false"></textarea></label>
              <div class="plan-pasted wide">
                <label>最大オフナディア角<input name="pasteMax" type="number" min="0" max="80" step="any" value="${builtInDefaults.maxOffNadir}" /></label>
                <label>観測幅（km）<input name="pasteSwath" type="number" min="0.1" step="any" value="${builtInDefaults.swath}" /></label>
                <label>撮像間隔（分）<input name="pasteGap" type="number" min="0" step="any" value="0" title="1 回撮像してから次に撮像できるまでの時間。0 は制約なし" /></label>
                <label>1 日の上限（回）<input name="pastePerDay" type="number" min="0" step="1" value="0" title="24 時間に撮像できる回数。0 は制約なし" /></label>
                <label>発注リード（時間）<input name="pasteLead" type="number" min="0" step="any" value="0" title="何時間先の撮像からオーダーできるか。それより近い機会は除きます。0 は制約なし" /></label>
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
          <option value="stereo">ステレオペア</option>
          <option value="repeat">干渉ペア（同じ軌道・SAR）</option>
          <option value="revisit">再訪間隔マップ</option>
        </select>
        <span class="plan-pair-stereo" hidden title="2 回の撮像の視線のなす角（交会角）。15〜45° が DSM・建物の高さに向きます">交会角<input name="stereoMin" type="number" min="1" max="90" step="1" value="15" aria-label="交会角の下限" />〜<input name="stereoMax" type="number" min="1" max="90" step="1" value="45" aria-label="交会角の上限" />°・<input name="stereoDays" type="number" min="0.01" max="60" step="any" value="7" aria-label="日数の上限" />日以内<label class="check"><input name="stereoSeries" type="checkbox" checked />同じシリーズ</label></span>
        <span class="plan-pair-repeat" hidden title="同じ衛星（シリーズ）が同じ軌道（北行・南行、向き、入射角、方位）で戻ってきた 2 回">入射角の差<input name="repeatIncidence" type="number" min="0.01" max="10" step="any" value="1" aria-label="入射角の差の上限" />°以内・基線<input name="repeatBaseline" type="number" min="1" step="any" placeholder="制限なし" aria-label="垂直基線の上限" />m以下<label class="check" title="同じシリーズの衛星（同じ軌道のコンステレーション）同士もペアにします"><input name="repeatSeries" type="checkbox" />同じシリーズ</label></span>
        <span class="plan-revisit-opts" hidden title="対象を囲む範囲をこの数 × この数のセルに分け、セルごとに撮像機会の間隔を求めます">格子<input name="revisitGrid" type="number" min="2" max="30" step="1" value="10" aria-label="格子の数" />×</span>
        <label class="plan-goal" hidden title="面の対象をどこまで覆えば完了とするか">目標<input name="goal" type="number" min="10" max="100" step="1" value="95" />%</label>
        <label class="check plan-share" hidden title="同じパスで 1 シーン（観測幅 × シーン長）に収まる地点を、1 回の撮像でまとめて撮ります"><input type="checkbox" name="share" checked />近い地点を 1 シーンにまとめる</label>
        <label class="check plan-first"><input type="checkbox" name="firstOnly" />衛星・対象ごとに最初の機会のみ</label>
        <label class="check plan-tl-toggle" title="衛星ごとの撮像を時間軸に並べます（薄い帯は撮像間隔で次を撮れない時間）"><input type="checkbox" name="timeline" />タイムライン</label>
      </div>
      <div class="plan-timeline" hidden></div>
      <div class="catalog-results"><table class="catalog-table plan-table"><thead></thead><tbody></tbody></table></div>
      <div class="plan-remind" hidden>
        <label>撮像の<input name="remindMinutes" type="number" min="0" max="1440" step="1" value="30" aria-label="何分前" />分前</label>
        <button type="button" value="notify" title="一覧の撮像（組み合わせではシーンごと）の前に、ヘッダーの「通知」とアプリのバッジで知らせます（このビューアを開いている間）">通知を設定</button>
        <button type="button" value="ics" title="一覧の撮像を予定表（iCalendar .ics）で保存します。Outlook などに取り込めます（設定した分前のアラームつき）">予定表 (.ics)</button>
        <button type="button" value="unnotify" title="設定したすべての撮像の通知を解除します">通知を解除</button>
        <span class="plan-remind-count"></span>
      </div>
      <div class="plan-save" hidden>
        <label>計画名<input name="planName" type="text" autocomplete="off" /></label>
        <select name="planStore" aria-label="保存先"></select>
        <button type="button" value="save" title="一覧の撮像（組み合わせではシーンごと）を保存先のフィーチャーサービスに保存します。撮像時刻を過ぎると、画像カタログで撮れたかを確かめられます">保存先に保存</button>
        <button type="button" value="saved" title="保存した計画を開き、撮像されたかを確かめます">保存した計画…</button>
      </div>
      <div class="service-actions catalog-actions">
        <button type="button" value="store" hidden title="計画をフィーチャーサービスに保存し、撮れたかを追跡します">保存・追跡…</button>
        <button type="button" value="remind" disabled title="撮像の前に通知する・予定表（.ics）に保存する">予定・通知…</button>
        <button type="button" value="csv" disabled title="一覧を CSV で保存します">CSV 保存</button>
        <button type="button" value="layer" disabled title="撮像範囲をレイヤーとして追加します（撮像時刻つき。タイムラインで絞り込めます）">レイヤーとして追加</button>
        <button type="button" value="zoom" class="primary" disabled>範囲へ移動</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.catalogs_ = this.dialog.querySelector('select[name=catalog]')!;
    this.target_ = this.form_.elements.namedItem('target') as HTMLSelectElement;
    this.tree_ = new SatelliteTree(this.dialog.querySelector('.plan-sats-list')!, this.dialog.querySelector('.plan-sats-count'));
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.table_ = this.dialog.querySelector('table')!;
    this.firstOnly_ = this.dialog.querySelector('input[name=firstOnly]')!;
    this.view_ = this.dialog.querySelector('select[name=view]')!;
    this.goal_ = this.dialog.querySelector('input[name=goal]')!;
    this.share_ = this.dialog.querySelector('input[name=share]')!;
    this.csv_ = this.dialog.querySelector('button[value=csv]')!;
    this.layer_ = this.dialog.querySelector('button[value=layer]')!;
    this.zoom_ = this.dialog.querySelector('button[value=zoom]')!;
    this.remind_ = this.dialog.querySelector('button[value=remind]')!;
    this.timeline_ = this.dialog.querySelector('input[name=timeline]')!;
    this.timelineHost_ = this.dialog.querySelector('.plan-timeline')!;
    this.cloud_ = this.dialog.querySelector('input[name=cloud]')!;
    this.maxCloud_ = this.dialog.querySelector('input[name=maxCloud]')!;
    if (options.cloudForecast) {
      this.dialog.querySelector<HTMLElement>('.plan-cloud')!.hidden = false;
      this.dialog.querySelector('.plan-cloud-label')!.textContent = options.cloudForecast.label;
      try {
        this.cloud_.checked = localStorage.getItem(CLOUD_KEY) === '1';
      } catch {
        // Storage blocked: off.
      }
    }
    this.cloud_.addEventListener('change', () => {
      try {
        localStorage.setItem(CLOUD_KEY, this.cloud_.checked ? '1' : '0');
      } catch {
        // Storage blocked: remembered for this page only.
      }
      if (this.cloud_.checked) void this.loadClouds();
      else if (this.plan_) {
        for (const op of this.plan_.result.opportunities) delete op.cloud;
        this.cover_ = null;
        this.render();
      }
    });
    this.maxCloud_.addEventListener('change', () => {
      this.cover_ = null;
      if (this.plan_) this.render();
    });

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
      // The 3D view drops the passes with the 2D overlay.
      this.options.onChosen?.();
    });
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run();
    });
    this.target_.addEventListener('change', () => {
      this.listPriorityFields();
      this.showTargets();
    });
    (this.form_.elements.namedItem('each') as HTMLInputElement).addEventListener('change', () => this.listPriorityFields());
    (this.form_.elements.namedItem('nameField') as HTMLSelectElement).addEventListener('change', () => this.relabel());
    this.dialog.querySelector('.plan-sats button[value=all]')!.addEventListener('click', () => this.tree_.checkAll(true));
    this.dialog.querySelector('.plan-sats button[value=none]')!.addEventListener('click', () => this.tree_.checkAll(false));
    for (const name of ['tle', 'pasteMax', 'pasteSwath', 'pasteGap', 'pastePerDay', 'pasteLead', 'pasteSar']) (this.form_.elements.namedItem(name) as HTMLInputElement).addEventListener('change', () => this.listSats());
    this.firstOnly_.addEventListener('change', () => this.render());
    this.view_.addEventListener('change', () => this.showView());
    for (const name of ['stereoMin', 'stereoMax', 'stereoDays', 'stereoSeries', 'repeatIncidence', 'repeatBaseline', 'repeatSeries', 'revisitGrid'])
      this.dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!.addEventListener('change', () => this.showView());
    this.goal_.addEventListener('change', () => this.showView());
    this.share_.addEventListener('change', () => this.showView());
    this.csv_.addEventListener('click', () => this.saveCsv());
    this.layer_.addEventListener('click', () => this.addLayer());
    this.zoom_.addEventListener('click', () => this.zoomToChosen());
    this.timeline_.addEventListener('change', () => this.drawTimeline());
    new ResizeObserver(() => this.drawTimeline()).observe(this.timelineHost_);
    const remind = this.dialog.querySelector<HTMLElement>('.plan-remind')!;
    this.remind_.addEventListener('click', () => {
      remind.hidden = !remind.hidden;
      this.countReminders();
    });
    this.dialog.querySelector('button[value=notify]')!.addEventListener('click', () => this.setReminders());
    this.dialog.querySelector('button[value=ics]')!.addEventListener('click', () => this.saveIcs());
    this.dialog.querySelector('button[value=unnotify]')!.addEventListener('click', () => {
      clearReminders();
      this.countReminders();
      this.options.say('撮像の通知をすべて解除しました');
    });
    map.addInteraction(this.dragInteraction());
    const stores = options.planStores ?? [];
    const storeButton = this.dialog.querySelector<HTMLButtonElement>('button[value=store]')!;
    const saveRow = this.dialog.querySelector<HTMLElement>('.plan-save')!;
    const storeSelect = saveRow.querySelector<HTMLSelectElement>('select[name=planStore]')!;
    stores.forEach((st, i) => storeSelect.add(new Option(st.label, String(i))));
    storeSelect.hidden = stores.length < 2;
    storeButton.hidden = stores.length === 0;
    storeButton.addEventListener('click', () => {
      saveRow.hidden = !saveRow.hidden;
      const name = saveRow.querySelector<HTMLInputElement>('input[name=planName]')!;
      if (!name.value && this.plan_) name.value = `撮像計画 ${localText(this.plan_.options.start).slice(0, 10)}`;
    });
    saveRow.querySelector('button[value=save]')!.addEventListener('click', () => void this.saveToStore());
    saveRow.querySelector('button[value=saved]')!.addEventListener('click', () => options.openSaved?.());
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
    // The chosen pass comes back in the 3D view too.
    if (this.chosen_) this.options.onChosen?.();
    if (!this.catalog_) {
      if (!this.tree_.items().length) this.listSats();
      if (!this.plan_) {
        this.status_.textContent =
          'config.json に衛星カタログ（satelliteCatalogs）がないので、サンプル衛星 2 機（光学・SAR。実在の衛星ではありません）で計算します。「詳細条件」で TLE を貼り付けて追加できます';
      }
    } else void this.loadCatalog();
  }

  close(): void {
    this.dialog.close();
  }

  /** Opens the panel with the point `lonLat` (WGS 84) as the target and plans it (the map's right-click menu). */
  async planAt(lonLat: [number, number]): Promise<void> {
    if (!this.dialog.open) this.open();
    this.clicked_ = lonLat;
    this.target_.value = 'click';
    this.showTargets();
    await this.run();
  }

  /** The satellites listed (catalog and pasted), and whether each is checked. */
  satellites(): Array<{ sat: SatelliteSpec; checked: boolean }> {
    return this.tree_.items().map((l) => ({ sat: l.sat, checked: l.box.checked }));
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
    const lead = Number(value('pasteLead'));
    return satellitesFromText(value('tle'), {
      ...builtInDefaults,
      maxOffNadir: Number.isFinite(max) && max > 0 ? max : builtInDefaults.maxOffNadir,
      swath: Number.isFinite(swath) && swath > 0 ? swath : builtInDefaults.swath,
      minInterval: Number.isFinite(gap) && gap > 0 ? gap : 0,
      maxPerDay: Number.isFinite(perDay) && perDay > 0 ? Math.round(perDay) : 0,
      leadTime: Number.isFinite(lead) && lead > 0 ? lead : 0,
      sar: (this.form_.elements.namedItem('pasteSar') as HTMLInputElement).checked,
    });
  }

  /** Lists the satellites (catalog and pasted) in the tree, keeping what was unchecked; new ones start checked. */
  private listSats(): void {
    this.tree_.set([...this.catalogSats_, ...this.pasted()]);
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
    this.listPriorityFields();
    this.showTargets();
  }

  /** Names the targets of the last plan again by the chosen attribute (no new calculation), and lists them. */
  private relabel(): void {
    const plan = this.plan_;
    if (!plan) return;
    const targets = this.targets();
    // Only when the form still asks for the same targets.
    if (typeof targets === 'string' || targets.length !== plan.targets.length || targets.some((t, i) => t.center.join() !== plan.targets[i].center.join())) return;
    plan.targets = plan.targets.map((t, i) => ({ ...t, label: targets[i].label }));
    this.render();
  }

  /** The features of the chosen target (null for a clicked point). */
  private chosenFeatures(): Feature[] | null {
    const choice = this.target_.value;
    if (choice === 'click') return null;
    if (choice === 'selection') return this.options.selection.list();
    return this.vectorLayers()[Number(choice.slice('layer:'.length))]?.service.vector!.source.getFeatures() ?? [];
  }

  /**
   * Fills the attribute choices from the target's features: the name (any
   * attribute) and the priority (attributes that hold numbers, shown when
   * planning features one by one).
   */
  listPriorityFields(): void {
    const select = this.form_.elements.namedItem('priority') as HTMLSelectElement;
    const before = select.value;
    const features = this.chosenFeatures() ?? [];
    const each = (this.form_.elements.namedItem('each') as HTMLInputElement).checked;
    const fields = new Set<string>();
    const all = new Set<string>();
    for (const f of features.slice(0, 2000)) {
      const geometryName = f.getGeometryName();
      for (const [key, v] of Object.entries(f.getProperties())) {
        if (key === geometryName || (v !== null && typeof v === 'object')) continue;
        all.add(key);
        if (priorityOf(v) !== null) fields.add(key);
      }
    }
    // The name: any attribute, or 自動 (name, 名称… else the ID).
    const names = this.form_.elements.namedItem('nameField') as HTMLSelectElement;
    const named = names.value;
    names.replaceChildren(new Option('自動', ''), ...[...all].map((k) => new Option(k, k)));
    names.value = all.has(named) ? named : '';
    names.closest('label')!.hidden = !all.size;
    select.replaceChildren(new Option('なし', ''), ...[...fields].sort((a, b) => a.localeCompare(b, 'ja')).map((k) => new Option(k, k)));
    select.value = fields.has(before) ? before : (([...fields].find((k) => /priority|優先/i.test(k)) ?? '') as string);
    const shown = each && features.length > 1 && fields.size > 0;
    for (const label of this.dialog.querySelectorAll<HTMLElement>('.plan-priority')) label.hidden = !shown;
  }

  /** The targets the form asks for (in WGS 84), or the reason there are none. */
  targets(): PlanTarget[] | string {
    const choice = this.target_.value;
    const projection = this.map.getView().getProjection().getCode();
    if (choice === 'click') {
      if (!this.clicked_) return '地図をクリックして地点を指定してください';
      return [{ label: `${round(this.clicked_[1], 5)}, ${round(this.clicked_[0], 5)}`, center: this.clicked_, points: [] }];
    }
    let name: string;
    if (choice === 'selection') name = '選択中の地物';
    else {
      const layer = this.vectorLayers()[Number(choice.slice('layer:'.length))];
      if (!layer) return '対象のレイヤーがありません';
      name = layer.name;
    }
    let features = this.chosenFeatures()!;
    const nameField = (this.form_.elements.namedItem('nameField') as HTMLSelectElement).value;
    features = features.filter((f) => f.getGeometry());
    if (!features.length) return '対象に図形がありません';
    const each = (this.form_.elements.namedItem('each') as HTMLInputElement).checked;
    if (!each || features.length === 1) {
      const t = targetOf(features, projection, features.length === 1 ? nameOf(features[0], 0, nameField) : name);
      return t ? [t] : '対象に図形がありません';
    }
    if (features.length > MAX_TARGETS) return `地物が ${features.length.toLocaleString()} 件あります。${MAX_TARGETS} 件以下を選択するか、「詳細条件」の「地物ごとに計算」を外してまとめて計算してください`;
    const field = (this.form_.elements.namedItem('priority') as HTMLSelectElement).value;
    const sign = (this.form_.elements.namedItem('priorityOrder') as HTMLSelectElement).value === 'large' ? 1 : -1;
    return features.flatMap((f, i) => {
      const t = targetOf([f], projection, nameOf(f, i, nameField));
      if (!t) return [];
      const v = field ? priorityOf(f.get(field)) : null;
      return [v === null ? t : { ...t, priority: sign * v, priorityText: String(f.get(field)) }];
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
        const features = this.chosenFeatures() ?? [];
        const each = (this.form_.elements.namedItem('each') as HTMLInputElement).checked;
        features
          .filter((f) => f.getGeometry())
          .slice(0, MAX_TARGETS)
          .forEach((f, i) => source.addFeature(new Feature({ kind: 'target', target: each ? i : 0, geometry: f.getGeometry()!.clone() })));
      }
    }
    if (this.revisit_ && this.view_.value === 'revisit' && this.plan_) this.drawRevisit();
    if (this.chosen_ && this.plan_) this.drawPass(this.chosen_);
  }

  /** What the form asks for. */
  planOptions(): PlanOptions {
    const value = (name: string) => (this.form_.elements.namedItem(name) as HTMLInputElement).value;
    const start = value('start') ? new Date(value('start')).getTime() : Date.now();
    const days = Number(value('days')) || 7;
    const cap = value('maxOffNadir');
    const sun = Number(value('minSun'));
    const angle = (name: string) => (value(name) === '' || !Number.isFinite(Number(value(name))) ? null : Number(value(name)));
    const pass = value('pass');
    const side = value('side');
    return {
      start,
      end: start + days * 86400000,
      maxOffNadir: cap === '' ? null : Number(cap),
      daylight: value('daylight') === 'none' ? 'none' : 'optical',
      minSunElevation: Number.isFinite(sun) ? sun : 10,
      now: Date.now(),
      minIncidence: angle('minIncidence'),
      maxIncidence: angle('maxIncidence'),
      pass: pass === 'ascending' || pass === 'descending' ? pass : null,
      side: side === 'left' || side === 'right' ? side : null,
      ...(this.options.stations?.length ? { stations: this.options.stations } : {}),
    };
  }

  /** Plans the checked satellites over the targets, in a worker. */
  async run(): Promise<void> {
    if (this.catalog_) await this.loadCatalog();
    const sats = this.tree_.checked();
    const targets = this.targets();
    if (typeof targets === 'string') return void (this.status_.textContent = targets);
    if (!sats.length) {
      this.dialog.querySelector<HTMLDetailsElement>('.plan-more')!.open = true;
      this.status_.textContent = this.tree_.items().length ? '衛星を選んでください（詳細条件）' : '衛星がありません。衛星カタログを確認するか、「詳細条件」に TLE を貼り付けてください';
      return;
    }
    const options = this.planOptions();
    this.worker_?.terminate();
    const { worker, result: planned } = startPlan(sats, targets, options, (done) => {
      this.status_.textContent = `${sats.length} 機 × ${targets.length} 対象を計算しています… ${Math.round(done * 100)}%`;
    });
    this.worker_ = worker;
    this.status_.textContent = `${sats.length} 機 × ${targets.length} 対象を計算しています…`;
    const result = await planned;
    if (this.worker_ !== worker) return;
    this.worker_ = null;
    if (typeof result === 'string') return void (this.status_.textContent = `計算できませんでした: ${result}`);
    this.plan_ = { sats, targets, result, options };
    this.cover_ = null;
    this.pairs_ = null;
    this.revisit_ = null;
    this.dialog.querySelector<HTMLElement>('.plan-view')!.hidden = result.opportunities.length === 0;
    // An area no single pass covers: start with the combination that covers it.
    const best = new Map<number, number>();
    for (const op of result.opportunities) if (op.cells) best.set(op.target, Math.max(best.get(op.target) ?? 0, op.coverage));
    this.view_.value = [...best.values()].some((c) => c < 0.95) ? 'cover' : 'all';
    this.showView();
    if (this.cloud_.checked && this.options.cloudForecast) await this.loadClouds();
  }

  /** Asks the forecast service for the cloud cover of the last plan's optical shots, and lists them with it. */
  async loadClouds(): Promise<void> {
    const plan = this.plan_;
    const config = this.options.cloudForecast;
    if (!plan || !config) return;
    const { sats, targets, result } = plan;
    const places = placesFor(result.opportunities, sats, targets);
    if (!places.length) return void (this.status_.textContent = `${this.status_.textContent}（雲量予報は 16 日先までの光学衛星の機会だけです）`);
    const before = this.status_.textContent;
    this.status_.textContent = `${config.label} に雲量予報を問い合わせています…`;
    try {
      const forecasts = await fetchClouds(config, places);
      if (this.plan_ !== plan) return;
      const n = applyClouds(result.opportunities, sats, targets, forecasts);
      this.cover_ = null;
      this.pairs_ = null;
      if (this.view_.value === 'revisit') return void (this.status_.textContent = `${before}（雲量予報 ${n} 回分: ${config.label}）`);
      this.render();
      this.status_.textContent = `${before}（雲量予報 ${n} 回分: ${config.label}）`;
    } catch (error) {
      this.status_.textContent = `${before}（雲量予報を取得できませんでした: ${error instanceof Error ? error.message : String(error)}）`;
    }
  }

  /** The largest cloud cover asked for (percent), or null for any. */
  private maxCloud(): number | null {
    const v = this.maxCloud_.value;
    return v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  }

  /** The last plan's opportunities that pass the cloud cover asked for (those without a forecast stay). */
  private candidates(): Opportunity[] {
    const ops = this.plan_?.result.opportunities ?? [];
    const max = this.maxCloud();
    return max === null ? ops : ops.filter((op) => op.cloud === undefined || op.cloud <= max);
  }

  /** Whether the list is the combination rather than every opportunity. */
  private combining(): boolean {
    return this.view_.value === 'cover';
  }

  /** The pair view shown: stereo or repeat pairs; null in the other views. */
  private pairing(): 'stereo' | 'repeat' | null {
    const v = this.view_.value;
    return v === 'stereo' || v === 'repeat' ? v : null;
  }

  /** The pairs of the last plan for the conditions in the form (found again when they change). */
  pairs(): PlanPair[] {
    const plan = this.plan_!;
    const kind = this.pairing();
    const num = (name: string, fallback: number | null) => {
      const v = this.dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!.value;
      return v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? fallback : Number(v);
    };
    const checked = (name: string) => this.dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!.checked;
    const options =
      kind === 'stereo'
        ? { minAngle: num('stereoMin', 15)!, maxAngle: num('stereoMax', 45)!, maxDays: num('stereoDays', 7)!, sameSeries: checked('stereoSeries') }
        : { maxIncidence: num('repeatIncidence', 1)!, maxAzimuth: 2, maxBaseline: num('repeatBaseline', null), sameSeries: checked('repeatSeries') };
    const key = `${kind}:${JSON.stringify(options)}:${this.maxCloud()}`;
    if (this.pairs_?.key !== key) {
      const ops = this.candidates();
      const pairs =
        kind === 'stereo'
          ? stereoPairs(ops, plan.sats, plan.targets, options as Parameters<typeof stereoPairs>[3])
          : repeatPairs(ops, plan.sats, plan.targets, options as Parameters<typeof repeatPairs>[3]);
      this.pairs_ = { key, pairs };
    }
    return this.pairs_.pairs;
  }

  /** The combination of the last plan for the goal in the form (made again when the goal changes). */
  coverPlans(): CoverPlan[] {
    const plan = this.plan_!;
    const goal = Math.min(1, Math.max(0.1, (Number(this.goal_.value) || 95) / 100));
    const share = this.share_.checked;
    if (this.cover_?.goal !== goal || this.cover_.share !== share) this.cover_ = { goal, share, plans: coverPlan(this.candidates(), plan.targets, plan.sats, goal, undefined, share) };
    return this.cover_.plans;
  }

  /** Lists the last plan in the chosen view, with what it found in the status line. */
  private showView(): void {
    const plan = this.plan_;
    if (!plan) return;
    const combining = this.combining();
    const pairing = this.pairing();
    const revisit = this.view_.value === 'revisit';
    this.goal_.closest('label')!.hidden = !combining;
    // Sharing scenes is for points: shown when there are two or more.
    this.share_.closest('label')!.hidden = !combining || plan.targets.filter((t) => !t.cells?.length).length < 2;
    this.firstOnly_.closest('label')!.hidden = combining || !!pairing || revisit;
    this.timeline_.closest('label')!.hidden = revisit;
    this.dialog.querySelector<HTMLElement>('.plan-pair-stereo')!.hidden = pairing !== 'stereo';
    this.dialog.querySelector<HTMLElement>('.plan-pair-repeat')!.hidden = pairing !== 'repeat';
    this.dialog.querySelector<HTMLElement>('.plan-revisit-opts')!.hidden = !revisit;
    this.chosen_ = null;
    this.options.onChosen?.();
    if (revisit) return void this.showRevisit();
    // A column the view does not have sorts by time instead.
    if (!this.columns().some((c) => c.key === this.sort_.key)) this.sort_ = { key: 'time', descending: false };
    this.render();
    this.showTargets();
    const { sats, targets, result } = plan;
    const problems =
      (result.problems.length ? `（計算できなかった衛星: ${result.problems.join('、')}）` : '') +
      (result.tooSoon ? `（発注リードタイムに間に合わない機会 ${result.tooSoon} 回を除きました）` : '');
    const first = result.opportunities[0];
    if (!first) {
      this.status_.textContent = `期間内に撮像できる機会はありません。期間を延ばすか、オフナディア角・入射角・軌道・向きの制限や日照条件を見直してください${problems}`;
    } else if (pairing) {
      const pairs = this.pairs();
      const what = pairing === 'stereo' ? 'ステレオペア' : '干渉ペア';
      const hint = pairing === 'stereo' ? '交会角・日数の条件を緩めるか、オフナディア角の上限を上げてください' : 'SAR 衛星を選び、期間を回帰日数より長くするか、入射角の差の条件を緩めてください';
      this.status_.textContent = pairs.length
        ? `${what} ${pairs.length.toLocaleString()} 組。最初の 2 回目は ${localText(pairs[0][pairing === 'stereo' ? 'b' : 'a'].time)}。行を選ぶと 1 回目（青）と 2 回目（番号 2）の撮像範囲を地図に表示します${problems}`
        : `条件に合う${what}はありません。${hint}${problems}`;
    } else if (!combining) {
      this.status_.textContent = `${result.opportunities.length.toLocaleString()} 回。最短は ${localText(first.time)}（${sats[first.satellite].name}、オフナディア角 ${round(first.offNadir)}°）。行を選ぶと地図に軌道と撮像範囲を表示します（撮像範囲はドラッグで動かせます）${problems}`;
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
      // Scenes taken in all, and those that take several points at once.
      const shots = new Map<number, number>();
      for (const step of plans.flatMap((p) => p.steps)) if (step.shot !== undefined) shots.set(step.shot, step.shotTargets ?? 1);
      const shared = [...shots.values()].filter((n) => n > 1);
      const scenes = plans.length > 1 ? `全 ${shots.size} シーン${shared.length ? `（うち ${shared.length} シーンで ${shared.reduce((a, b) => a + b, 0)} 地点をまとめて撮像）` : ''}。` : '';
      const ranked = new Set(targets.map((t) => t.priority)).size > 1 ? '優先度の高い対象から撮像を割り当てました。' : '';
      this.status_.textContent = `${summary}。${scenes}${ranked}${blocked ? `撮像間隔・1 日の上限のため見送ったパス ${blocked} 回。` : ''}行を選ぶと、その回と同じ対象の他の回（番号つき）を地図に表示します${problems}`;
    }
    if (this.shown_.length) this.choose(this.shown_[0]);
  }

  private columns(): Array<{ key: SortKey; label: string; text: (op: Opportunity) => string; title?: (op: Opportunity) => string }> {
    const plan = this.plan_!;
    const many = plan.targets.length > 1;
    return [
      {
        key: 'time',
        label: '日時',
        text: (op) => `${localText(op.time)}${op.adjusted ? ' ✎' : ''}`,
        title: (op) =>
          [plan.sats[op.satellite].leadTime > 0 ? `発注期限 ${localText(op.time - plan.sats[op.satellite].leadTime * 3600000)}` : '', op.adjusted ? '撮像範囲を地図で動かしました（✎）' : ''].filter(Boolean).join('・'),
      },
      {
        key: 'satellite',
        label: '衛星',
        text: (op) => plan.sats[op.satellite].name,
        title: (op) => `${plan.sats[op.satellite].source}・TLE ${round(op.tleAge, 0)} 日${plan.sats[op.satellite].source !== SAMPLE_SOURCE && Math.abs(op.tleAge) > OLD_TLE ? '（古い TLE。予測がずれることがあります）' : ''}`,
      },
      ...(many ? [{ key: 'target' as const, label: '対象', text: (op: Opportunity) => plan.targets[op.target].label }] : []),
      ...(many && plan.targets.some((t) => t.priority !== undefined)
        ? [{ key: 'priority' as const, label: '優先度', text: (op: Opportunity) => plan.targets[op.target].priorityText ?? '', title: () => '対象の優先度（属性の値）。並べ替えると優先度の高い順' }]
        : []),
      { key: 'offNadir', label: 'オフナディア角', text: (op) => `${round(op.offNadir)}°`, title: (op) => `入射角 ${round(op.incidence)}°・距離 ${round(op.range, 0)} km` },
      { key: 'side', label: '方向', text: sideText, title: () => '衛星の進行方向に対して対象が右か左か、北行（昇交）か南行（降交）か' },
      { key: 'sun', label: '太陽高度', text: (op) => `${round(op.sunElevation, 0)}°` },
      ...(plan.result.opportunities.some((op) => op.cloud !== undefined)
        ? [{ key: 'cloud' as const, label: '雲量', text: (op: Opportunity) => (op.cloud === undefined ? '—' : `${op.cloud}%`), title: (op: Opportunity) => (op.cloud === undefined ? (plan.sats[op.satellite].sar ? 'SAR は雲を通して撮像します' : '予報の範囲外（16 日先まで）') : `${this.options.cloudForecast?.label ?? ''} の雲量予報`) }]
        : []),
      ...(plan.options.stations?.length
        ? [
            {
              key: 'downlink' as const,
              label: '受信見込み',
              text: (op: Opportunity) => (op.downlink ? localText(op.downlink.time) : '1 日以内なし'),
              title: (op: Opportunity) =>
                op.downlink ? `${plan.options.stations![op.downlink.station]?.name ?? ''}・撮像から ${Math.round((op.downlink.time - op.time) / 60000)} 分（衛星が地上局の上に来る時刻。データの処理・配信の時間は含みません）` : '撮像から 24 時間以内に地上局の上を通りません',
            },
          ]
        : []),
      ...(this.pairing() ? this.pairColumns() : []),
      ...(this.pairing()
        ? []
        : this.combining()
        ? [
            { key: 'gain' as const, label: '追加', text: (op: Opportunity) => `+${percent(op.gain ?? 0)}`, title: () => 'この回で新たに撮像できる対象の割合' },
            { key: 'cumulative' as const, label: '累計', text: (op: Opportunity) => percent(op.cumulative ?? 0), title: () => 'この回までに撮像できた対象の割合' },
            ...(many
              ? [
                  {
                    key: 'shot' as const,
                    label: 'シーン',
                    text: (op: Opportunity) => `#${op.shot ?? ''}${(op.shotTargets ?? 1) > 1 ? `（${op.shotTargets} 地点）` : ''}`,
                    title: (op: Opportunity) => ((op.shotTargets ?? 1) > 1 ? `この ${op.shotTargets} 地点は 1 回の撮像（1 シーン）でまとめて撮れます` : ''),
                  },
                ]
              : []),
          ]
        : [{ key: 'cover' as const, label: '被覆', text: (op: Opportunity) => coverText(op), title: (op: Opportunity) => coverTitle(op, plan.sats[op.satellite]) }]),
    ];
  }

  /** The columns of a pair view: the second shot, how the two looks relate, and the days between. */
  private pairColumns(): Array<{ key: SortKey; label: string; text: (op: Opportunity) => string; title?: (op: Opportunity) => string }> {
    const plan = this.plan_!;
    const second = (op: Opportunity) => op.pair!.b;
    return [
      {
        key: 'second',
        label: '2 回目',
        text: (op) => `${localText(second(op).time)} ${plan.sats[second(op).satellite].name}`,
        title: (op) => `オフナディア角 ${round(second(op).offNadir)}°・入射角 ${round(second(op).incidence)}°・${sideText(second(op))}`,
      },
      this.pairing() === 'stereo'
        ? { key: 'angle', label: '交会角', text: (op) => `${round(op.pair!.convergence)}°`, title: (op) => `B/H ${round(op.pair!.bh, 2)}（2 回の視線のなす角。大きいほど高さの精度が上がり、大きすぎると対応づけにくくなります）` }
        : { key: 'baseline', label: '垂直基線', text: (op) => `${Math.round(op.pair!.baseline).toLocaleString()} m`, title: (op) => `入射角の差 ${round(Math.abs(second(op).incidence - op.incidence), 2)}°（基線が短いほど干渉しやすく、長いほど地形の高さに敏感です）` },
      { key: 'days', label: '間隔', text: (op) => hoursText(op.pair!.days * 24), title: () => '1 回目から 2 回目までの時間' },
    ];
  }

  private sorted(): Opportunity[] {
    const plan = this.plan_!;
    let ops = this.pairing() ? this.pairs().map((pair) => ({ ...pair.a, pair })) : this.combining() ? this.coverPlans().flatMap((p) => p.steps) : this.candidates();
    if (!this.combining() && !this.pairing() && this.firstOnly_.checked) {
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
        case 'priority':
          return -(plan.targets[op.target].priority ?? -Infinity);
        case 'offNadir':
          return op.offNadir;
        case 'side':
          return sideText(op);
        case 'sun':
          return op.sunElevation;
        case 'cloud':
          return op.cloud ?? 1000;
        case 'downlink':
          return op.downlink?.time ?? Infinity;
        case 'cover':
          return op.cells ? op.coverage : op.strips * op.frames * 1e6 + op.width;
        case 'gain':
          return op.gain ?? 0;
        case 'cumulative':
          return op.target * 10 + (op.cumulative ?? 0);
        case 'shot':
          return op.shot ?? 0;
        case 'second':
          return op.pair?.b.time ?? 0;
        case 'angle':
          return op.pair?.convergence ?? 0;
        case 'baseline':
          return op.pair?.baseline ?? 0;
        case 'days':
          return op.pair?.days ?? 0;
        default:
          return op.time;
      }
    };
    return [...ops].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
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
    const rest = this.shown_.length - MAX_ROWS;
    const more = document.createElement('tr');
    if (rest > 0) {
      const td = document.createElement('td');
      td.colSpan = columns.length;
      td.className = 'plan-more-rows';
      td.textContent = `ほか ${rest.toLocaleString()} 件（並べ替えると先頭が変わります。CSV とレイヤーにはすべて入ります）`;
      more.append(td);
    }
    this.table_.tBodies[0].replaceChildren(
      ...this.shown_.slice(0, MAX_ROWS).map((op) => {
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
      ...(rest > 0 ? [more] : []),
    );
    this.update();
    this.drawTimeline();
  }

  /** The revisit map of the last plan: planned again over a grid of cells around the targets (in a worker), then listed and drawn. */
  private async showRevisit(): Promise<void> {
    const plan = this.plan_!;
    const size = Math.max(2, Math.min(30, Math.round(Number(this.dialog.querySelector<HTMLInputElement>('input[name=revisitGrid]')!.value) || 10)));
    this.shown_ = [];
    this.timelineHost_.hidden = true;
    if (this.revisit_?.size !== size) {
      this.revisit_ = null;
      this.table_.tHead!.replaceChildren();
      this.table_.tBodies[0].replaceChildren();
      this.update();
      this.showTargets();
      const cells = gridCells(boxOf(plan.targets), size);
      this.worker_?.terminate();
      const { worker, result: planned } = startPlan(plan.sats, cellTargets(cells), { ...plan.options, stations: [] }, (done) => {
        this.status_.textContent = `再訪間隔を ${cells.length} セルで計算しています… ${Math.round(done * 100)}%`;
      });
      this.worker_ = worker;
      this.status_.textContent = `再訪間隔を ${cells.length} セルで計算しています…`;
      const result = await planned;
      if (this.worker_ !== worker) return;
      this.worker_ = null;
      if (this.plan_ !== plan || this.view_.value !== 'revisit') return;
      if (typeof result === 'string') return void (this.status_.textContent = `計算できませんでした: ${result}`);
      this.revisit_ = { size, cells, stats: revisitStats(result.opportunities, cells.length, plan.options.start, plan.options.end), chosen: null };
    }
    this.renderRevisit();
    this.showTargets();
    const stats = this.revisit_!.stats;
    const seen = stats.filter((s) => s.count > 0);
    const worst = Math.max(...stats.map((s) => s.maxGap));
    const days = (plan.options.end - plan.options.start) / 86400000;
    this.status_.textContent = seen.length
      ? `${stats.length} セルのうち ${seen.length} セルで撮像機会があります。最長の待ちは ${hoursText(worst)}、平均で ${round(seen.reduce((n, s) => n + s.count, 0) / stats.length / days, 2)} 回/日（緑ほど早く撮れ、赤ほど待ちます）。行を選ぶとセルを示します`
      : `この期間、範囲内のどのセルにも撮像機会がありません。期間を延ばすか条件を見直してください`;
  }

  /** Lists the revisit map's cells, longest wait first. */
  private renderRevisit(): void {
    const revisit = this.revisit_!;
    const head = document.createElement('tr');
    for (const label of ['セル', '回数', '平均間隔', '最長の待ち']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    this.table_.tHead!.replaceChildren(head);
    const order = revisit.stats.map((_, i) => i).sort((a, b) => revisit.stats[b].maxGap - revisit.stats[a].maxGap || a - b);
    this.table_.tBodies[0].replaceChildren(
      ...order.slice(0, MAX_ROWS).map((i) => {
        const s = revisit.stats[i];
        const row = document.createElement('tr');
        row.tabIndex = -1;
        row.classList.toggle('chosen', revisit.chosen === i);
        for (const text of [`${i + 1}`, `${s.count}`, hoursText(s.meanGap), hoursText(s.maxGap)]) {
          const td = document.createElement('td');
          td.textContent = text;
          row.append(td);
        }
        row.title = `中心 ${round(revisit.cells[i].center[1], 4)}, ${round(revisit.cells[i].center[0], 4)}`;
        row.addEventListener('click', () => {
          revisit.chosen = i;
          for (const r of this.table_.tBodies[0].rows) r.classList.toggle('chosen', r === row);
          this.showTargets();
          row.focus();
        });
        row.addEventListener('dblclick', () => this.map.getView().animate({ center: fromLonLat(revisit.cells[i].center, this.map.getView().getProjection()), duration: 250 }));
        return row;
      }),
    );
    this.update();
    this.csv_.disabled = false;
    this.layer_.disabled = false;
  }

  /** Draws the revisit map's cells, coloured by their longest wait. */
  private drawRevisit(): void {
    const revisit = this.revisit_!;
    const projection = this.map.getView().getProjection();
    const longest = Math.max(...revisit.stats.map((s) => s.maxGap));
    const many = revisit.cells.length > 144;
    const source = this.overlay.getSource()!;
    revisit.cells.forEach((cell, i) => {
      const s = revisit.stats[i];
      source.addFeature(
        new Feature({
          kind: 'revisit',
          color: revisitColor(s, longest),
          chosen: revisit.chosen === i,
          label: many && revisit.chosen !== i ? '' : s.count ? hoursText(s.maxGap) : 'なし',
          geometry: new Polygon([cell.ring.map((c) => fromLonLat(c, projection))]),
        }),
      );
    });
  }

  /** Chooses an opportunity: its row, and its pass on the map. */
  choose(op: Opportunity): void {
    this.chosen_ = op;
    this.showTargets();
    this.update();
    this.drawTimeline();
    this.options.onChosen?.();
  }

  /** Draws the timeline of the listed shots (when it is asked for). */
  private drawTimeline(): void {
    const plan = this.plan_;
    const on = this.timeline_.checked && !!plan && this.shown_.length > 0;
    this.timelineHost_.hidden = !on;
    if (!on || !plan) return;
    const many = plan.targets.length > 1;
    drawTimeline(this.timelineHost_, {
      ops: this.shown_,
      sats: plan.sats,
      start: plan.options.start,
      end: plan.options.end,
      chosen: this.chosen_,
      title: (op) => `${localText(op.time)} ${plan.sats[op.satellite].name}${many ? ` → ${plan.targets[op.target].label}` : ''}・オフナディア角 ${round(op.offNadir)}°`,
      onPick: (op) => {
        this.choose(op);
        const i = this.shown_.indexOf(op);
        if (i >= 0 && i < MAX_ROWS) this.table_.tBodies[0].rows[i]?.scrollIntoView({ block: 'nearest' });
      },
    });
  }

  /**
   * Dragging the chosen pass's scenes (blue) on the map moves them along and
   * across the track, within what the satellite can reach; the row's angles
   * and coverage follow, and so do the CSV, the layer and the calendar.
   */
  private dragInteraction(): PointerInteraction {
    const lonLatOf = (e: MapBrowserEvent) => transform(e.coordinate, this.map.getView().getProjection(), 'EPSG:4326') as [number, number];
    const onScene = (e: MapBrowserEvent) =>
      this.map.forEachFeatureAtPixel(e.pixel, (f) => (f.get('kind') === 'scene' ? true : undefined), { layerFilter: (l) => l === this.overlay, hitTolerance: 2 }) ?? false;
    let pointer = false;
    return new PointerInteraction({
      handleDownEvent: (e) => {
        const op = this.chosen_;
        const plan = this.plan_;
        if (!this.dialog.open || !op || !plan || !onScene(e)) return false;
        const from = trackPlace(plan.sats[op.satellite], op.time, lonLatOf(e));
        if (!from) return false;
        this.drag_ = { op, origin: { ...op }, from };
        return true;
      },
      handleDragEvent: (e) => {
        const drag = this.drag_;
        const plan = this.plan_;
        if (!drag || !plan) return;
        const sat = plan.sats[drag.op.satellite];
        const at = trackPlace(sat, drag.op.time, lonLatOf(e));
        if (!at) return;
        const moved = shiftScene(drag.origin, sat, plan.targets[drag.op.target], at[0] - drag.from[0], at[1] - drag.from[1], plan.options);
        delete drag.op.scene;
        Object.assign(drag.op, moved);
        this.showTargets();
      },
      handleUpEvent: () => {
        const drag = this.drag_;
        this.drag_ = null;
        if (!drag || !this.plan_) return false;
        this.render();
        this.options.onChosen?.();
        const op = drag.op;
        this.status_.textContent = `撮像範囲を動かしました: オフナディア角 ${round(op.offNadir)}°・入射角 ${round(op.incidence)}°・${op.cells ? `被覆 ${percent(op.coverage)}` : op.coverage ? '対象を含みます' : '対象から外れています'}`;
        return false;
      },
      handleMoveEvent: (e) => {
        if (!this.dialog.open || !this.chosen_) return;
        const over = onScene(e);
        if (over === pointer) return;
        pointer = over;
        this.map.getTargetElement().style.cursor = over ? 'move' : '';
      },
    });
  }

  /** Says how many reminders are set. */
  private countReminders(): void {
    const n = loadReminders().filter((r) => r.time > Date.now()).length;
    this.dialog.querySelector('.plan-remind-count')!.textContent = n ? `通知予定 ${n} 件` : '';
  }

  private remindMinutes(): number {
    const v = Number((this.dialog.querySelector('input[name=remindMinutes]') as HTMLInputElement).value);
    return Number.isFinite(v) && v >= 0 ? Math.min(1440, v) : 30;
  }

  /** Sets reminders before the listed shots. */
  setReminders(): number {
    const plan = this.plan_;
    if (!plan || !this.shown_.length) return 0;
    const n = addReminders(this.shown_, plan.sats, plan.targets, this.remindMinutes(), (op) => passShapes(plan.sats[op.satellite], plan.targets[op.target], op)?.scenes ?? []);
    this.countReminders();
    this.options.say(n ? `撮像 ${n} 件の ${this.remindMinutes()} 分前に「通知」で知らせます（このビューアを開いている間）` : 'これから先の撮像がないため、通知は設定しませんでした');
    return n;
  }

  /** Saves the listed shots to the chosen plan layer; resolves with the plan's id (null when nothing was saved). */
  async saveToStore(): Promise<string | null> {
    const plan = this.plan_;
    const stores = this.options.planStores ?? [];
    const ask = this.options.storeAsk;
    const row = this.dialog.querySelector<HTMLElement>('.plan-save')!;
    const store = stores[Number(row.querySelector<HTMLSelectElement>('select[name=planStore]')!.value) || 0];
    if (!plan || !this.shown_.length || !store || !ask) return null;
    const nameInput = row.querySelector<HTMLInputElement>('input[name=planName]')!;
    const name = nameInput.value.trim() || `撮像計画 ${localText(plan.options.start).slice(0, 10)}`;
    const id = newPlanId();
    const features = shotFeatures(this.shown_, plan.sats, plan.targets, (op) => passShapes(plan.sats[op.satellite], plan.targets[op.target], op)?.scenes ?? [], { id, name }, store.fields);
    this.status_.textContent = `${store.label} に ${features.length} 回の撮像を保存しています…`;
    try {
      const { saved, failed } = await addShots(store, ask, features);
      this.status_.textContent = `「${name}」を ${store.label} に保存しました（${saved} 回${failed.length ? `。保存できなかったもの ${failed.length} 回: ${failed[0]}` : ''}）。「保存した計画…」で撮れたかを確かめられます`;
      this.options.say(`撮像計画「${name}」を保存しました`);
      return saved ? id : null;
    } catch (error) {
      this.status_.textContent = `保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  /** Saves the listed shots as an iCalendar file. */
  saveIcs(): void {
    const plan = this.plan_;
    if (!plan || !this.shown_.length) return;
    const day = (ms: number) => localText(ms).slice(0, 10).replaceAll('/', '');
    download(`imaging-plan_${day(plan.options.start)}-${day(plan.options.end)}.ics`, planIcs(this.shown_, plan.sats, plan.targets, this.remindMinutes()), 'text/calendar');
    this.options.say('撮像の予定を予定表（.ics）で保存しました');
  }

  /** The chosen pass for the 3D view, and in a combination the other passes over the same target; none while the panel is closed. */
  chosenPasses(): SatellitePass3d[] {
    const op = this.chosen_;
    const plan = this.plan_;
    if (!op || !plan || !this.dialog.open) return [];
    const passes = [satellitePass3d(plan.sats[op.satellite], plan.targets[op.target], op, true)];
    if (op.pair) passes.push(satellitePass3d(plan.sats[op.pair.b.satellite], plan.targets[op.pair.b.target], op.pair.b, false));
    if (this.combining()) {
      for (const step of this.coverPlans()[op.target]?.steps ?? []) {
        if (step.time === op.time && step.satellite === op.satellite) continue;
        passes.push(satellitePass3d(plan.sats[step.satellite], plan.targets[step.target], step, false));
      }
    }
    return passes.filter((p): p is SatellitePass3d => p !== null);
  }

  private update(): void {
    this.shown_.slice(0, MAX_ROWS).forEach((op, i) => {
      const row = this.table_.tBodies[0].rows[i];
      row?.classList.toggle('chosen', op === this.chosen_);
      row?.setAttribute('aria-selected', String(op === this.chosen_));
    });
    const any = this.shown_.length > 0;
    this.csv_.disabled = !any;
    this.remind_.disabled = !any;
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
    if (op.pair) {
      // The pair's second shot, numbered 2.
      const rings = passShapes(plan.sats[op.pair.b.satellite], plan.targets[op.pair.b.target], op.pair.b)?.scenes ?? [];
      rings.forEach((ring, k) => source.addFeature(new Feature({ kind: 'step', label: k === Math.floor(rings.length / 2) ? '2' : '', geometry: new Polygon([ring.map(to)]) })));
    }
    if (this.combining()) {
      // The other passes of the same target's combination, numbered, so what each adds can be seen.
      const steps = this.coverPlans()[op.target]?.steps ?? [];
      steps.forEach((step, i) => {
        if (step.time === op.time && step.satellite === op.satellite) return;
        const other = passShapes(plan.sats[step.satellite], plan.targets[step.target], step);
        // Its number once, on the middle scene, so scenes in a row along the pass do not repeat it.
        const rings = other?.scenes ?? [];
        rings.forEach((ring, k) => source.addFeature(new Feature({ kind: 'step', label: k === Math.floor(rings.length / 2) ? String(i + 1) : '', geometry: new Polygon([ring.map(to)]) })));
      });
    }
    source.addFeature(new Feature({ kind: 'satellite', label: `${sat.name} ${localText(op.time).slice(5)}`, geometry: new Point(to(shapes.position)) }));
  }

  /** Fits the view to the chosen opportunity's target, scenes and satellite (or the combination's passes), beside the panel. */
  zoomToChosen(): void {
    const op = this.chosen_;
    if (!op || !this.plan_) return;
    // The panel covers the right of the map: keep what is shown to the left of it.
    const map = this.map.getTargetElement().getBoundingClientRect();
    const panel = this.dialog.getBoundingClientRect();
    const right = this.dialog.open && panel.left > map.left + 200 ? Math.max(60, map.right - panel.left + 40) : 60;
    if (this.options.view3d?.(right - 60)) return;
    const extent = createEmpty();
    for (const f of this.overlay.getSource()!.getFeatures()) {
      const kind = f.get('kind');
      // A combination shows the target and all its passes; one pass, also where the satellite is.
      const shown = kind === 'scene' || kind === 'step' || (kind === 'satellite' && !this.combining()) || (kind === 'target' && f.get('target') === op.target);
      if (shown) extend(extent, f.getGeometry()!.getExtent());
    }
    if (isEmpty(extent)) return;
    this.map.getView().fit(extent, { padding: [60, right, 60, 60], maxZoom: 13, duration: 250 });
  }

  /** Saves the listed opportunities as CSV. */
  saveCsv(): void {
    if (this.plan_ && this.revisit_ && this.view_.value === 'revisit') {
      download('revisit.csv', revisitCsv(this.revisit_.cells, this.revisit_.stats), 'text/csv');
      return void this.options.say(`再訪間隔 ${this.revisit_.cells.length} セルを CSV で保存しました`);
    }
    if (!this.plan_ || !this.shown_.length) return;
    const { sats, targets, options } = this.plan_;
    const day = (ms: number) => localText(ms).slice(0, 10).replaceAll('/', '');
    download(`imaging-plan_${day(options.start)}-${day(options.end)}.csv`, planCsv(this.shown_, sats, targets, options.stations ?? []), 'text/csv');
    this.options.say(`撮像機会 ${this.shown_.length} 件を CSV で保存しました`);
  }

  /** The listed opportunities' scenes as a layer: one feature per opportunity, with its time and angles. */
  planLayer(): ProcessingResult | null {
    if (this.plan_ && this.revisit_ && this.view_.value === 'revisit') return revisitFeatures(this.revisit_.cells, this.revisit_.stats);
    if (!this.plan_ || !this.shown_.length) return null;
    const { sats, targets, options } = this.plan_;
    return planFeatures(this.shown_, sats, targets, this.combining(), options.stations ?? []);
  }

  /** The satellites of the catalog (loaded when first asked), or the samples without one. */
  async catalogSatellites(): Promise<SatelliteSpec[]> {
    if (this.catalog_) await this.loadCatalog();
    return this.catalogSats_.slice();
  }

  private addLayer(): void {
    const result = this.planLayer();
    if (!result || !this.plan_) return;
    const { options } = this.plan_;
    if (this.view_.value === 'revisit') return this.options.onLayer(result, `再訪間隔 ${localText(options.start)} から ${Math.round((options.end - options.start) / 86400000)} 日`);
    this.options.onLayer(result, `撮像計画 ${localText(options.start)} から ${Math.round((options.end - options.start) / 86400000)} 日（${result.features.length} 回）`);
  }
}

/** Opportunities' scenes as a layer: one feature per opportunity, with its time and angles. */
export function planFeatures(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], combined: boolean, stations: readonly GroundStation[] = []): ProcessingResult {
  const clouded = ops.some((op) => op.cloud !== undefined);
  const paired = ops.some((op) => op.pair);
  const features: Feature[] = [];
  for (const op of ops) {
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
        scenes: shapes.scenes.length,
        coverage: Math.round(op.coverage * 1000) / 10,
        ...(clouded ? { cloud: op.cloud ?? null } : {}),
        ...(stations.length ? { downlink: op.downlink?.time ?? null, station: op.downlink ? (stations[op.downlink.station]?.name ?? null) : null } : {}),
        ...(paired
          ? {
              pair_time: op.pair?.b.time ?? null,
              pair_satellite: op.pair ? sats[op.pair.b.satellite].name : null,
              convergence: op.pair ? Math.round(op.pair.convergence * 100) / 100 : null,
              bh: op.pair ? Math.round(op.pair.bh * 1000) / 1000 : null,
              baseline: op.pair ? Math.round(op.pair.baseline) : null,
              days: op.pair ? Math.round(op.pair.days * 100) / 100 : null,
            }
          : {}),
        ...(op.cumulative !== undefined ? { gain: Math.round((op.gain ?? 0) * 1000) / 10, cumulative: Math.round(op.cumulative * 1000) / 10, shot: op.shot, shot_targets: op.shotTargets } : {}),
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
      ...(clouded ? [field('cloud', 'double', '雲量予報%')] : []),
      ...(stations.length ? [field('downlink', 'date', '受信見込み'), field('station', 'string', '地上局')] : []),
      ...(paired
        ? [field('pair_time', 'date', '2回目'), field('pair_satellite', 'string', '2回目の衛星'), field('convergence', 'double', '交会角'), field('bh', 'double', 'B/H'), field('baseline', 'double', '垂直基線m'), field('days', 'double', '間隔日')]
        : []),
      ...(combined ? [field('gain', 'double', '追加%'), field('cumulative', 'double', '累計%'), field('shot', 'integer', 'シーン番号'), field('shot_targets', 'integer', '同じシーンの地点数')] : []),
    ],
    crs: wgs84,
  };
}

/** The revisit map's cells as a layer: one square per cell, with how often it is seen. */
export function revisitFeatures(cells: readonly RevisitCell[], stats: readonly RevisitStats[]): ProcessingResult {
  const hours = (h: number | null) => (h === null ? null : Math.round(h * 10) / 10);
  return {
    title: '再訪間隔',
    features: cells.map(
      (cell, i) =>
        new Feature({
          geometry: new Polygon([cell.ring.map((c) => fromLonLat(c, 'EPSG:3857'))]),
          cell: i + 1,
          count: stats[i].count,
          mean_gap_h: hours(stats[i].meanGap),
          max_gap_h: hours(stats[i].maxGap),
        }),
    ),
    fields: [field('cell', 'integer', 'セル'), field('count', 'integer', '回数'), field('mean_gap_h', 'double', '平均間隔（時間）'), field('max_gap_h', 'double', '最長の待ち（時間）')],
    crs: wgs84,
  };
}

/** The revisit map's cells as CSV (with a BOM, for spreadsheets). */
export function revisitCsv(cells: readonly RevisitCell[], stats: readonly RevisitStats[]): string {
  const hours = (h: number | null) => (h === null ? '' : round(h, 1));
  const rows = cells.map((cell, i) => [i + 1, round(cell.center[0], 6), round(cell.center[1], 6), stats[i].count, hours(stats[i].meanGap), hours(stats[i].maxGap)]);
  return `\ufeff${[['セル', '経度', '緯度', '回数', '平均間隔（時間）', '最長の待ち（時間）'], ...rows].map((r) => r.join(',')).join('\r\n')}\r\n`;
}

/**
 * Plans `sats` over `targets` in a worker; `worker` stops it (terminate),
 * `result` is the plan or why it could not be made.
 */
export function startPlan(
  sats: SatelliteSpec[],
  targets: PlanTarget[],
  options: PlanOptions,
  onProgress?: (done: number) => void,
): { worker: Worker; result: Promise<PlanResult | string> } {
  const worker = new Worker(new URL('./imaging-plan-worker.ts', import.meta.url), { type: 'module' });
  const result = new Promise<PlanResult | string>((resolve) => {
    worker.onmessage = (e: MessageEvent<{ progress?: number; result?: PlanResult; error?: string }>) => {
      if (e.data.progress !== undefined) onProgress?.(e.data.progress);
      else resolve(e.data.result ?? e.data.error ?? '計算できませんでした');
    };
    worker.onerror = (e) => resolve(e.message || '計算できませんでした');
    worker.postMessage({ satellites: sats, targets, options } satisfies PlanJob);
  }).finally(() => worker.terminate());
  return { worker, result };
}
