/**
 * The dashboard (ダッシュボード): the open layers summed up beside the map.
 *
 * - An overview of every layer: what it is and how many features it shows
 *   (out of how many).
 * - For one vector layer: counts (all, in the view, in the timeline's
 *   window, after the dashboard's filter, selected), features (or a sum or
 *   a mean of a number) per value of an attribute, the distribution of a
 *   number, and the count over time (by the timeline's time attribute).
 * - Where they are: a heatmap of the layer's features on the map.
 *
 * The charts filter the rest of the viewer: clicking a value (Ctrl / Shift:
 * several) or a range of the number shows only those features on the map,
 * in the 3D view and in the attribute table; clicking a step of the time
 * chart opens the timeline on it. Each chart counts the features the other
 * filters leave, and the value or range chosen stays marked.
 */
import Observable, { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import Feature, { type FeatureLike } from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import Point from 'ol/geom/Point.js';
import type Geometry from 'ol/geom/Geometry.js';
import HeatmapLayer from 'ol/layer/Heatmap.js';
import VectorSource from 'ol/source/Vector.js';
import { getCenter, intersects } from 'ol/extent.js';
import type { ImageList, ViewerLayer, ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';
import type { Timeline } from './timeline.js';
import { categoryValue, numberValue } from './vector-style.js';
import { addTime, floorTime, formatTime, stepAtLeast, stepsBetween, type TimeUnit } from './time.js';

/** What is summed per value of the attribute. */
export type Statistic = 'count' | 'sum' | 'mean';
const statisticNames: Record<Statistic, string> = { count: '件数', sum: '合計', mean: '平均' };

/** The dashboard's state, as saved in a project. */
export interface DashboardState {
  open: boolean;
  /** The layer summed up, by its place in the list (top first); null: the selected one. */
  layer: number | null;
  /** The attribute features are grouped by. */
  groupBy: string | null;
  statistic: Statistic;
  /** The number summed or averaged, and the one whose distribution is shown. */
  measure: string | null;
  /** The values chosen (the filter). */
  values: string[];
  /** The range of `measure` chosen (the filter). */
  range: [number, number] | null;
  /** Count only the features in the view. */
  inView: boolean;
  heatmap: boolean;
  /** Heatmap radius, pixels. */
  radius: number;
}

/** The most values listed; the rest go into 「その他」. */
const MAX_VALUES = 15;
const BINS = 20;

const OTHERS = '\u0000others';

/** A number as short text: `1,234`, `12.3`. */
function short(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const digits = Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : Math.abs(n) >= 1 ? 1 : 3;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Where a feature is, for the heatmap: points as they are, other shapes by their middle. */
function pointOf(geometry: Geometry | undefined): Point | null {
  if (!geometry) return null;
  const type = geometry.getType();
  if (type === 'Point') return geometry as Point;
  if (type === 'Polygon') return (geometry as unknown as { getInteriorPoint(): Point }).getInteriorPoint();
  const extent = geometry.getExtent();
  return Number.isFinite(extent[0]) ? new Point(getCenter(extent)) : null;
}

/**
 * The dashboard panel. It fires `change` when its filter changes, for the
 * attribute table.
 */
export class Dashboard extends Observable {
  readonly element: HTMLElement;
  private readonly body_: HTMLElement;
  private readonly overview_: HTMLElement;
  private readonly layerSelect_: HTMLSelectElement;
  private readonly tiles_: HTMLElement;
  private readonly groupSelect_: HTMLSelectElement;
  private readonly statSelect_: HTMLSelectElement;
  private readonly measureSelect_: HTMLSelectElement;
  private readonly categories_: HTMLElement;
  private readonly histogram_: HTMLElement;
  private readonly timeChart_: HTMLElement;
  private readonly heatmapBox_: HTMLInputElement;
  private readonly radiusInput_: HTMLInputElement;
  private readonly inViewBox_: HTMLInputElement;
  private readonly clearButton_: HTMLButtonElement;

  private open_ = false;
  /** The layer chosen in the list; null: follow the selected layer. */
  private pinned_: ViewerService | null = null;
  private layer_: ViewerService | null = null;
  private groupBy_: string | null = null;
  private statistic_: Statistic = 'count';
  private measure_: string | null = null;
  private values_ = new Set<string>();
  private range_: [number, number] | null = null;
  private inView_ = false;
  private readonly heatmap_: HeatmapLayer<Feature<Point>>;
  private readonly heatSource_ = new VectorSource<Feature<Point>>();
  private keys_: EventsKey[] = [];
  private frame_ = 0;
  private heatTimer_: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: {
      element: HTMLElement;
      /** The menu button that opens it (pressed while open). */
      button: HTMLButtonElement;
      timeline: Timeline;
      selection: Selection;
      say: (message: string) => void;
      /** Called when it opens or closes (the map changes size). */
      onToggle?: (open: boolean) => void;
    },
  ) {
    super();
    this.element = options.element;
    this.element.classList.add('dashboard');
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="dashboard-head">
        <h2>ダッシュボード</h2>
        <button type="button" data-action="close" class="dashboard-close" title="ダッシュボードを閉じる（B）。絞り込みも解除します" aria-label="ダッシュボードを閉じる">×</button>
      </div>
      <div class="dashboard-body">
        <section class="dashboard-overview" aria-label="レイヤーの概要"></section>
        <label class="dashboard-layer">集計するレイヤー <select aria-label="集計するレイヤー"></select></label>
        <div class="dashboard-detail">
          <div class="dashboard-tiles"></div>
          <div class="dashboard-tools">
            <label><input type="checkbox" name="in-view" /> 表示範囲内だけ集計</label>
            <label><input type="checkbox" name="heatmap" /> ヒートマップ</label>
            <label class="dashboard-radius" hidden>半径 <input type="range" name="radius" min="4" max="60" step="1" value="16" aria-label="ヒートマップの半径" /></label>
            <button type="button" data-action="clear" hidden>絞り込みを解除</button>
            <button type="button" data-action="select" title="絞り込んだ地物を選択します（属性テーブル・書き出し・プロセッシングで使えます）">地物を選択</button>
          </div>
          <section aria-labelledby="dashboard-category-title">
            <h3 id="dashboard-category-title">属性別</h3>
            <div class="dashboard-controls">
              <select name="group" aria-label="集計する属性"></select>
              <select name="statistic" aria-label="集計の方法"></select>
            </div>
            <div class="dashboard-categories" role="list"></div>
          </section>
          <section aria-labelledby="dashboard-measure-title">
            <h3 id="dashboard-measure-title">数値の分布</h3>
            <div class="dashboard-controls"><select name="measure" aria-label="数値の属性"></select></div>
            <div class="dashboard-histogram"></div>
          </section>
          <section aria-labelledby="dashboard-time-title">
            <h3 id="dashboard-time-title">時間の推移</h3>
            <div class="dashboard-time"></div>
          </section>
        </div>
        <p class="dashboard-empty">ベクターレイヤーを開くと、件数・属性別の集計・時間の推移・ヒートマップを表示します。</p>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.element.querySelector<T>(s)!;
    this.body_ = q('.dashboard-detail');
    this.overview_ = q('.dashboard-overview');
    this.layerSelect_ = q('.dashboard-layer select');
    this.tiles_ = q('.dashboard-tiles');
    this.groupSelect_ = q('select[name=group]');
    this.statSelect_ = q('select[name=statistic]');
    this.measureSelect_ = q('select[name=measure]');
    this.categories_ = q('.dashboard-categories');
    this.histogram_ = q('.dashboard-histogram');
    this.timeChart_ = q('.dashboard-time');
    this.heatmapBox_ = q('input[name=heatmap]');
    this.radiusInput_ = q('input[name=radius]');
    this.inViewBox_ = q('input[name=in-view]');
    this.clearButton_ = q('[data-action=clear]');
    for (const [k, v] of Object.entries(statisticNames)) this.statSelect_.add(new Option(v, k));

    q('[data-action=close]').addEventListener('click', () => this.setOpen(false));
    this.clearButton_.addEventListener('click', () => this.clearFilter());
    q('[data-action=select]').addEventListener('click', () => this.selectShown_());
    this.layerSelect_.addEventListener('change', () => {
      const i = Number(this.layerSelect_.value);
      const layer = this.images.layers()[i];
      this.pinned_ = this.layerSelect_.value === '' || layer?.type !== 'service' ? null : layer;
      this.setLayer_(this.pinned_ ?? this.followed_());
    });
    this.groupSelect_.addEventListener('change', () => {
      this.groupBy_ = this.groupSelect_.value || null;
      this.values_.clear();
      this.filterChanged_();
    });
    this.statSelect_.addEventListener('change', () => {
      this.statistic_ = this.statSelect_.value as Statistic;
      this.update();
    });
    this.measureSelect_.addEventListener('change', () => {
      this.measure_ = this.measureSelect_.value || null;
      this.range_ = null;
      this.filterChanged_();
    });
    this.inViewBox_.addEventListener('change', () => {
      this.inView_ = this.inViewBox_.checked;
      this.update();
    });
    this.heatmapBox_.addEventListener('change', () => this.setHeatmap(this.heatmapBox_.checked));
    this.radiusInput_.addEventListener('input', () => {
      const r = Number(this.radiusInput_.value);
      this.heatmap_.setRadius(r);
      this.heatmap_.setBlur(r * 1.5);
    });

    this.heatmap_ = new HeatmapLayer({ source: this.heatSource_, radius: 16, blur: 24, visible: false, zIndex: 10_000, className: 'ol-layer dashboard-heatmap' });
    map.addLayer(this.heatmap_);

    options.button.addEventListener('click', () => this.setOpen(!this.open_));
    options.timeline.on('change', () => this.update());
    options.selection.on('change', () => this.update());
    map.on('moveend', () => {
      if (this.open_) this.update();
    });
  }

  isOpen(): boolean {
    return this.open_;
  }

  /** Opens the dashboard, or closes it (its filter and heatmap go too). */
  setOpen(open: boolean): void {
    if (open === this.open_) return;
    this.open_ = open;
    this.element.hidden = !open;
    this.options.button.setAttribute('aria-pressed', String(open));
    if (open) this.setLayer_(this.pinned_ ?? this.followed_(), true);
    else this.applyFilter_();
    this.heatmap_.setVisible(open && this.heatmapBox_.checked);
    this.options.onToggle?.(open);
    this.update();
  }

  /** The layer summed up now. */
  layer(): ViewerService | null {
    return this.layer_;
  }

  /** Layers were added, removed or reordered, or another one was selected. */
  refresh(): void {
    if (this.pinned_ && !this.images.layers().includes(this.pinned_)) this.pinned_ = null;
    const next = this.pinned_ ?? this.followed_();
    if (next !== this.layer_) this.setLayer_(next);
    else this.update();
  }

  /** Shows the features with these values of the grouping attribute only (none: all). */
  setValues(values: readonly string[]): void {
    this.values_ = new Set(values);
    this.filterChanged_();
  }

  /** Shows the features whose number is in the range only (null: all). */
  setRange(range: [number, number] | null): void {
    this.range_ = range;
    this.filterChanged_();
  }

  /** Shows every feature again. */
  clearFilter(): void {
    this.values_.clear();
    this.range_ = null;
    this.filterChanged_();
  }

  setHeatmap(on: boolean): void {
    this.heatmapBox_.checked = on;
    this.element.querySelector<HTMLElement>('.dashboard-radius')!.hidden = !on;
    this.heatmap_.setVisible(this.open_ && on);
    this.update();
  }

  /** The heatmap's features (for the test). */
  heatmapFeatures(): number {
    return this.heatSource_.getFeatures().length;
  }

  /** The state, for a project. */
  getState(): DashboardState {
    const index = this.pinned_ ? this.images.layers().indexOf(this.pinned_) : -1;
    return {
      open: this.open_,
      layer: index >= 0 ? index : null,
      groupBy: this.groupBy_,
      statistic: this.statistic_,
      measure: this.measure_,
      values: [...this.values_].filter((v) => v !== OTHERS),
      range: this.range_,
      inView: this.inView_,
      heatmap: this.heatmapBox_.checked,
      radius: Number(this.radiusInput_.value),
    };
  }

  /** Puts the dashboard as saved in a project. */
  setState(state: Partial<DashboardState>): void {
    const layer = typeof state.layer === 'number' ? this.images.layers()[state.layer] : null;
    this.pinned_ = layer?.type === 'service' ? layer : null;
    if (state.statistic && state.statistic in statisticNames) this.statistic_ = state.statistic;
    if (typeof state.inView === 'boolean') {
      this.inView_ = state.inView;
      this.inViewBox_.checked = state.inView;
    }
    if (typeof state.radius === 'number') {
      this.radiusInput_.value = String(state.radius);
      this.heatmap_.setRadius(Number(this.radiusInput_.value));
      this.heatmap_.setBlur(Number(this.radiusInput_.value) * 1.5);
    }
    this.setLayer_(this.pinned_ ?? this.followed_());
    const fields = this.fields_();
    if (state.groupBy !== undefined && (state.groupBy === null || fields.some((f) => f.name === state.groupBy))) this.groupBy_ = state.groupBy;
    if (state.measure !== undefined && (state.measure === null || fields.some((f) => f.name === state.measure))) this.measure_ = state.measure;
    this.values_ = new Set(Array.isArray(state.values) ? state.values.map(String) : []);
    this.range_ = Array.isArray(state.range) && state.range.length === 2 && state.range.every(Number.isFinite) ? [state.range[0], state.range[1]] : null;
    if (typeof state.heatmap === 'boolean') this.setHeatmap(state.heatmap);
    if (typeof state.open === 'boolean') {
      if (state.open !== this.open_) this.setOpen(state.open);
    }
    this.filterChanged_();
  }

  /** Draws the panel again, on the next frame. */
  update(): void {
    if (this.frame_) return;
    this.frame_ = requestAnimationFrame(() => {
      this.frame_ = 0;
      if (this.open_) this.render_();
    });
  }

  // ---- the layer and the filter ----

  /** The selected layer, when it is a vector layer drawn on the map; else the top one. */
  private followed_(): ViewerService | null {
    const usable = (l: ViewerLayer | null): l is ViewerService => l?.type === 'service' && !!l.service.vector && !!l.service.style;
    const selected = this.images.selectedLayer();
    if (usable(selected)) return selected;
    if (usable(this.layer_) && this.images.layers().includes(this.layer_)) return this.layer_;
    return this.images.layers().find(usable) ?? null;
  }

  private fields_(): Field[] {
    return this.layer_?.service.vector?.fields.filter((f) => f.type !== 'oid') ?? [];
  }

  private setLayer_(layer: ViewerService | null, keep = false): void {
    if (layer === this.layer_ && keep) return this.update();
    // The filter belongs to the layer it was made on.
    if (this.layer_ && this.layer_ !== layer) this.layer_.service.style?.setFilter(null);
    unByKey(this.keys_);
    this.keys_ = [];
    const changed = layer !== this.layer_;
    this.layer_ = layer;
    if (changed) {
      this.values_.clear();
      this.range_ = null;
      this.groupBy_ = null;
      this.measure_ = null;
    }
    if (layer) {
      this.keys_.push(...[layer.service.vector!.source.on(['addfeature', 'removefeature', 'changefeature', 'clear'], () => this.update())].flat());
      const fields = this.fields_();
      const features = layer.service.vector!.source.getFeatures();
      // A grouping attribute of few values (text first), and a number.
      if (!this.groupBy_) {
        // Values that repeat: the fewest distinct values (2 to 50, fewer than the features), text before numbers.
        const sample = features.slice(0, 2000);
        const distinct = (f: Field) => new Set(sample.map((x) => categoryValue(x.get(f.name)))).size;
        const texts = fields.filter((f) => (f.type === 'string' || f.type === 'integer') && !/^(id|fid|objectid|gid)$/i.test(f.name));
        const ranked = texts
          .map((f) => ({ f, n: distinct(f) }))
          .filter(({ n }) => n > 1 && n <= 50 && n < sample.length)
          .sort((a, b) => Number(a.f.type !== 'string') - Number(b.f.type !== 'string') || a.n - b.n);
        this.groupBy_ = (texts.find((f) => f.codes?.length) ?? ranked[0]?.f)?.name ?? null;
      }
      if (!this.measure_) this.measure_ = fields.find((f) => (f.type === 'double' || f.type === 'integer') && !/^(id|fid|objectid|gid)$/i.test(f.name))?.name ?? null;
    }
    this.filterChanged_();
  }

  private filterChanged_(): void {
    this.applyFilter_();
    this.changed();
    this.update();
  }

  /** The filter of the values and range chosen; null when nothing is chosen. */
  private filter_(): ((f: FeatureLike) => boolean) | null {
    const group = this.groupBy_;
    const values = this.values_.size && group ? this.values_ : null;
    const listed = values?.has(OTHERS) ? this.listed_ : null;
    const measure = this.measure_;
    const range = this.range_ && measure ? this.range_ : null;
    if (!values && !range) return null;
    return (f) => {
      if (values) {
        const v = categoryValue(f.get(group!));
        if (!values.has(v) && !(listed && !listed.has(v))) return false;
      }
      if (range) {
        const n = numberValue(f.get(measure!));
        if (n === null || n < range[0] || n > range[1]) return false;
      }
      return true;
    };
  }

  /** The values listed by name in the chart (the rest are 「その他」). */
  private listed_ = new Set<string>();
  private applied_: ((f: FeatureLike) => boolean) | null = null;

  private applyFilter_(): void {
    const filter = this.open_ ? this.filter_() : null;
    this.applied_ = filter;
    this.layer_?.service.style?.setFilter(filter);
    this.clearButton_.hidden = !filter;
  }

  /** Whether a feature passes the dashboard's filter (always, while it is closed or for another layer). */
  passes(layer: ViewerLayer, feature: FeatureLike): boolean {
    return layer !== this.layer_ || !this.applied_ || this.applied_(feature);
  }

  /** Whether the dashboard filters `layer` now. */
  filters(layer: ViewerLayer): boolean {
    return layer === this.layer_ && !!this.applied_;
  }

  private selectShown_(): void {
    const layer = this.layer_;
    if (!layer) return;
    if (this.images.selectedLayer() !== layer) this.images.select(layer);
    const style = layer.service.style!;
    const features = layer.service.vector!.source.getFeatures().filter((f) => style.shows(f));
    this.options.selection.set(features);
    this.options.say(`${features.length.toLocaleString()} 件を選択しました`);
  }

  // ---- drawing ----

  private render_(): void {
    this.renderOverview_();
    this.renderLayerSelect_();
    const layer = this.layer_;
    this.body_.hidden = !layer;
    this.element.querySelector<HTMLElement>('.dashboard-empty')!.hidden = !!layer;
    if (!layer) {
      this.heatSource_.clear();
      return;
    }
    const all = layer.service.vector!.source.getFeatures();
    const style = layer.service.style!;
    const extent = this.map.getView().calculateExtent(this.map.getSize());
    const inView = (f: FeatureLike) => {
      const g = f.getGeometry();
      return !!g && intersects(g.getExtent(), extent);
    };
    const viewOk = this.inView_ ? inView : () => true;
    const timeOk = (f: FeatureLike) => style.inTime(f);
    const filter = this.applied_;
    const ok = (f: FeatureLike) => !filter || filter(f);

    // Each chart counts what the other filters leave.
    const base = all.filter((f) => viewOk(f) && timeOk(f));
    const shown = filter ? base.filter(ok) : base;
    const selected = this.options.selection.list().filter((f) => all.includes(f)).length;
    this.renderTiles_([
      ['地物', all.length],
      ['表示範囲内', all.filter(inView).length],
      ...(this.options.timeline.filters(layer) ? ([['期間内', all.filter(timeOk).length]] as Array<[string, number]>) : []),
      ...(filter ? ([['絞り込み後', shown.length]] as Array<[string, number]>) : []),
      ['選択中', selected],
    ]);

    this.renderCategories_(this.range_ && this.measure_ ? base.filter((f) => this.inRange_(f)) : base);
    this.renderHistogram_(this.values_.size && this.groupBy_ ? base.filter((f) => this.inValues_(f)) : base);
    this.renderTime_(all.filter((f) => viewOk(f) && ok(f)));
    this.scheduleHeatmap_(all.filter((f) => style.shows(f)));
  }

  private inValues_(f: FeatureLike): boolean {
    const v = categoryValue(f.get(this.groupBy_!));
    return this.values_.has(v) || (this.values_.has(OTHERS) && !this.listed_.has(v));
  }

  private inRange_(f: FeatureLike): boolean {
    const n = numberValue(f.get(this.measure_!));
    return n !== null && n >= this.range_![0] && n <= this.range_![1];
  }

  private renderOverview_(): void {
    const rows = this.images.layers().map((layer) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dashboard-overview-row';
      row.classList.toggle('current', layer === this.layer_);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = layer.name.replace(/^.*[/\\]/, '');
      name.title = layer.name;
      const what = document.createElement('span');
      what.className = 'what';
      const count = document.createElement('span');
      count.className = 'count';
      if (layer.type === 'service' && layer.service.vector) {
        const features = layer.service.vector.source.getFeatures();
        const style = layer.service.style;
        const n = style?.isFiltered() ? features.filter((f) => style.shows(f)).length : features.length;
        what.textContent = layer.service.badge ?? layer.service.ref?.kind.toUpperCase() ?? 'ベクター';
        count.textContent = n === features.length ? `${short(n)} 件` : `${short(n)} / ${short(features.length)} 件`;
      } else {
        what.textContent = layer.type === 'image' ? '画像' : (layer.service.ref?.kind.toUpperCase() ?? 'レイヤー');
        count.textContent = layer.layer.getVisible() ? '' : '非表示';
      }
      row.append(name, what, count);
      if (layer.type === 'service' && layer.service.vector && layer.service.style) {
        row.title = 'このレイヤーを集計します';
        row.addEventListener('click', () => {
          this.pinned_ = layer;
          this.setLayer_(layer);
        });
      } else row.disabled = true;
      return row;
    });
    const head = document.createElement('p');
    head.className = 'dashboard-overview-head';
    const vectors = this.images.layers().filter((l) => l.type === 'service' && l.service.vector).length;
    const pictures = this.images.layers().length - vectors;
    head.textContent = `レイヤー ${this.images.layers().length}（ベクター ${vectors}・画像など ${pictures}）`;
    this.overview_.replaceChildren(head, ...rows);
  }

  private renderLayerSelect_(): void {
    const options = [new Option('選択中のレイヤー', '')];
    this.images.layers().forEach((l, i) => {
      if (l.type === 'service' && l.service.vector && l.service.style) options.push(new Option(l.name, String(i)));
    });
    this.layerSelect_.replaceChildren(...options);
    this.layerSelect_.value = this.pinned_ ? String(this.images.layers().indexOf(this.pinned_)) : '';

    const fields = this.fields_();
    const group = [new Option('（なし）', ''), ...fields.map((f) => new Option(f.alias || f.name, f.name))];
    this.groupSelect_.replaceChildren(...group);
    this.groupSelect_.value = this.groupBy_ ?? '';
    const numbers = fields.filter((f) => f.type === 'double' || f.type === 'integer');
    this.measureSelect_.replaceChildren(new Option('（なし）', ''), ...numbers.map((f) => new Option(f.alias || f.name, f.name)));
    this.measureSelect_.value = this.measure_ ?? '';
    this.statSelect_.value = this.statistic_;
    // A sum or a mean needs a number.
    for (const o of this.statSelect_.options) o.disabled = o.value !== 'count' && !this.measure_;
    if (!this.measure_ && this.statistic_ !== 'count') this.statistic_ = this.statSelect_.value = 'count';
  }

  private renderTiles_(tiles: Array<[string, number]>): void {
    this.tiles_.replaceChildren(
      ...tiles.map(([label, n]) => {
        const tile = document.createElement('div');
        tile.className = 'dashboard-tile';
        const value = document.createElement('strong');
        value.textContent = short(n);
        const name = document.createElement('span');
        name.textContent = label;
        tile.append(value, name);
        tile.dataset.label = label;
        return tile;
      }),
    );
  }

  private renderCategories_(features: FeatureLike[]): void {
    const group = this.groupBy_;
    if (!group) {
      this.listed_ = new Set();
      this.categories_.replaceChildren(this.note_('属性を選ぶと、値ごとに集計します'));
      return;
    }
    const measure = this.statistic_ === 'count' ? null : this.measure_;
    const sums = new Map<string, { n: number; sum: number; count: number }>();
    for (const f of features) {
      const v = categoryValue(f.get(group));
      let s = sums.get(v);
      if (!s) sums.set(v, (s = { n: 0, sum: 0, count: 0 }));
      s.n++;
      if (measure) {
        const x = numberValue(f.get(measure));
        if (x !== null) {
          s.sum += x;
          s.count++;
        }
      }
    }
    const field = this.fields_().find((f) => f.name === group);
    const nameOf = (v: string) => (v === OTHERS ? 'その他' : v === '' ? '（空）' : (field?.codes?.find((c) => String(c.code) === v)?.name ?? v));
    const value = (s: { n: number; sum: number; count: number }) => (this.statistic_ === 'count' ? s.n : this.statistic_ === 'sum' ? s.sum : s.count ? s.sum / s.count : NaN);
    // The values chosen stay listed even when the other filters leave none of them.
    for (const v of this.values_) if (v !== OTHERS && !sums.has(v)) sums.set(v, { n: 0, sum: 0, count: 0 });
    let entries = [...sums.entries()].sort((a, b) => (value(b[1]) || 0) - (value(a[1]) || 0) || a[0].localeCompare(b[0]));
    if (entries.length > MAX_VALUES) {
      const kept = entries.slice(0, MAX_VALUES - 1);
      const rest = entries.slice(MAX_VALUES - 1);
      const others = rest.reduce((a, [, s]) => ({ n: a.n + s.n, sum: a.sum + s.sum, count: a.count + s.count }), { n: 0, sum: 0, count: 0 });
      entries = [...kept, [OTHERS, others]];
    }
    this.listed_ = new Set(entries.map(([v]) => v).filter((v) => v !== OTHERS));
    const most = Math.max(0, ...entries.map(([, s]) => Math.abs(value(s)) || 0)) || 1;
    const chosen = this.values_.size > 0;
    const rows = entries.map(([v, s]) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dashboard-bar';
      row.setAttribute('role', 'listitem');
      const on = this.values_.has(v);
      row.classList.toggle('chosen', on);
      row.classList.toggle('dimmed', chosen && !on);
      row.setAttribute('aria-pressed', String(on));
      row.dataset.value = v;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = nameOf(v);
      const track = document.createElement('span');
      track.className = 'track';
      const fill = document.createElement('span');
      fill.className = 'fill';
      fill.style.width = `${((Math.abs(value(s)) || 0) / most) * 100}%`;
      track.append(fill);
      const num = document.createElement('span');
      num.className = 'value';
      num.textContent = short(value(s));
      row.append(label, track, num);
      row.title = `${nameOf(v)}: ${statisticNames[this.statistic_]} ${short(value(s))}（${s.n.toLocaleString()} 件）— クリックで絞り込み、Ctrl / Shift で複数`;
      row.addEventListener('click', (e) => {
        const several = e.ctrlKey || e.metaKey || e.shiftKey;
        if (several) {
          if (on) this.values_.delete(v);
          else this.values_.add(v);
        } else if (on && this.values_.size === 1) this.values_.clear();
        else this.values_ = new Set([v]);
        this.filterChanged_();
      });
      return row;
    });
    this.categories_.replaceChildren(...(rows.length ? rows : [this.note_('地物がありません')]));
  }

  private renderHistogram_(features: FeatureLike[]): void {
    const measure = this.measure_;
    if (!measure) {
      this.histogram_.replaceChildren(this.note_('数値の属性がありません'));
      return;
    }
    const values: number[] = [];
    for (const f of features) {
      const n = numberValue(f.get(measure));
      if (n !== null) values.push(n);
    }
    if (!values.length) {
      this.histogram_.replaceChildren(this.note_('値がありません'));
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (this.range_) {
      min = Math.min(min, this.range_[0]);
      max = Math.max(max, this.range_[1]);
    }
    const width = max > min ? (max - min) / BINS : 1;
    const counts = new Array<number>(max > min ? BINS : 1).fill(0);
    for (const v of values) counts[Math.min(counts.length - 1, Math.floor((v - min) / width))]++;
    const most = Math.max(...counts) || 1;
    const sum = values.reduce((a, v) => a + v, 0);
    const columns = counts.map((c, i) => {
      const from = min + i * width;
      const to = i === counts.length - 1 ? max : min + (i + 1) * width;
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'dashboard-column';
      const on = !!this.range_ && this.range_[0] <= from && this.range_[1] >= to;
      col.classList.toggle('chosen', on);
      col.classList.toggle('dimmed', !!this.range_ && !on);
      col.style.setProperty('--h', `${(c / most) * 100}%`);
      col.title = `${short(from)} 〜 ${short(to)}: ${c.toLocaleString()} 件 — クリックで絞り込み、Shift で範囲を広げる`;
      col.setAttribute('aria-label', col.title);
      col.addEventListener('click', (e) => {
        if (e.shiftKey && this.range_) this.range_ = [Math.min(this.range_[0], from), Math.max(this.range_[1], to)];
        else this.range_ = on && this.range_![0] === from && this.range_![1] === to ? null : [from, to];
        this.filterChanged_();
      });
      return col;
    });
    const bars = document.createElement('div');
    bars.className = 'dashboard-columns';
    bars.append(...columns);
    const axis = document.createElement('div');
    axis.className = 'dashboard-axis';
    axis.append(Object.assign(document.createElement('span'), { textContent: short(min) }), Object.assign(document.createElement('span'), { textContent: short(max) }));
    const stats = this.note_(`件数 ${values.length.toLocaleString()}・最小 ${short(min)}・平均 ${short(sum / values.length)}・最大 ${short(max)}`);
    this.histogram_.replaceChildren(bars, axis, stats);
  }

  private renderTime_(features: FeatureLike[]): void {
    const layer = this.layer_!;
    const span = this.options.timeline.spanOf(layer);
    if (!span) {
      this.timeChart_.replaceChildren(this.note_('時間の属性がありません'));
      return;
    }
    const starts: number[] = [];
    for (const f of features) {
      const s = span(f);
      if (s) starts.push(s[0]);
    }
    if (!starts.length) {
      this.timeChart_.replaceChildren(this.note_('時間のある地物がありません'));
      return;
    }
    starts.sort((a, b) => a - b);
    const first = starts[0];
    const last = starts[starts.length - 1];
    const step = stepAtLeast(Math.max(1000, (last - first) / 40));
    const bins = stepsBetween(floorTime(first, step.unit, step.count), last, step, 400);
    const counts = new Array<number>(bins.length).fill(0);
    let j = 0;
    for (const t of starts) {
      while (j < bins.length - 1 && t >= bins[j + 1]) j++;
      counts[j]++;
    }
    const most = Math.max(...counts) || 1;
    const window = this.options.timeline.isOpen() ? this.options.timeline.effectiveWindow() : null;
    const unit: TimeUnit = step.unit === 'week' ? 'day' : step.unit;
    const columns = bins.map((b, i) => {
      const end = addTime(b, step.unit, step.count) - 1;
      const col = document.createElement('button');
      col.type = 'button';
      col.className = 'dashboard-column';
      const inside = !!window && b <= window[1] && end >= window[0];
      col.classList.toggle('chosen', inside);
      col.classList.toggle('dimmed', !!window && !inside);
      col.style.setProperty('--h', `${(counts[i] / most) * 100}%`);
      col.title = `${formatTime(b, unit)}: ${counts[i].toLocaleString()} 件 — クリックでタイムラインをこの期間に`;
      col.setAttribute('aria-label', col.title);
      col.addEventListener('click', () => this.options.timeline.focus(b, end, step.count === 1 ? step.unit : undefined));
      return col;
    });
    const bars = document.createElement('div');
    bars.className = 'dashboard-columns';
    bars.append(...columns);
    const axis = document.createElement('div');
    axis.className = 'dashboard-axis';
    axis.append(Object.assign(document.createElement('span'), { textContent: formatTime(first, unit) }), Object.assign(document.createElement('span'), { textContent: formatTime(last, unit) }));
    this.timeChart_.replaceChildren(bars, axis);
  }

  /** The heatmap follows the features shown, a little after they change (it is built anew). */
  private scheduleHeatmap_(features: FeatureLike[]): void {
    if (!this.heatmapBox_.checked) {
      if (this.heatSource_.getFeatures().length) this.heatSource_.clear();
      return;
    }
    if (this.heatTimer_) clearTimeout(this.heatTimer_);
    this.heatTimer_ = setTimeout(() => {
      this.heatTimer_ = null;
      const points: Array<Feature<Point>> = [];
      for (const f of features) {
        const p = pointOf(f.getGeometry() as Geometry | undefined);
        if (p) points.push(new Feature({ geometry: p }));
      }
      this.heatSource_.clear(true);
      this.heatSource_.addFeatures(points);
    }, 60);
  }

  private note_(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'dashboard-note';
    p.textContent = text;
    return p;
  }
}
