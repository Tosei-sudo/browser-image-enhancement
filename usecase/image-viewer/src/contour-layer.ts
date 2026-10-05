/**
 * Contour lines of a DEM drawn on the map, just above the DEM's layer and
 * shown while it is. Lines are traced in a worker for what the view shows,
 * at about one post per two screen pixels, again after the view moves.
 * Every 5th line (index contour) is thicker and labelled with its height.
 */
import Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import LineString from 'ol/geom/LineString.js';
import type BaseLayer from 'ol/layer/Base.js';
import VectorLayer from 'ol/layer/Vector.js';
import { getTransform, transformExtent } from 'ol/proj.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import type { EventsKey } from 'ol/events.js';
import { unByKey } from 'ol/Observable.js';
import { isIndexContour, type ContourRequest, type ElevationGrid } from './contours.js';
import type { ContourMessage, ContourReply } from './contour-worker.js';

export interface ContourLayerOptions {
  /** Elevation between lines, metres. */
  interval: number;
  /** Called after each trace: how many lines are shown, and whether the interval was too fine to trace them all. */
  onTraced?: (lines: number, truncated: boolean) => void;
}

const LINE = new Style({ stroke: new Stroke({ color: 'rgba(122, 72, 24, 0.75)', width: 0.8 }) });
const INDEX = new Stroke({ color: 'rgba(122, 72, 24, 0.95)', width: 1.6 });

export class ContourLayer {
  readonly layer: VectorLayer<VectorSource<Feature<LineString>>>;
  private readonly source_ = new VectorSource<Feature<LineString>>();
  private readonly worker_: Worker;
  private readonly keys_: EventsKey[];
  private interval_: number;
  private request_ = 0;
  /** What the lines shown were traced for: posts, stride and interval. */
  private traced_: { window: number[]; stride: number; interval: number } | null = null;
  private readonly labels_ = new Map<number, Style>();

  constructor(
    private readonly map: OlMap,
    private readonly dem: BaseLayer,
    private readonly grid: ElevationGrid,
    private readonly options: ContourLayerOptions,
  ) {
    this.interval_ = options.interval;
    this.layer = new VectorLayer({
      source: this.source_,
      declutter: true,
      style: (feature) => this.style_(feature.get('level') as number),
      properties: { contours: true },
    });
    this.worker_ = new Worker(new URL('./contour-worker.ts', import.meta.url), { type: 'module' });
    this.worker_.onmessage = (e: MessageEvent<ContourReply>) => this.show_(e.data);
    this.worker_.postMessage({ grid } satisfies ContourMessage);
    this.follow_();
    this.keys_ = [
      dem.on('change:zIndex', () => this.follow_()),
      dem.on('change:visible', () => {
        this.follow_();
        this.update();
      }),
      map.on('moveend', () => this.update()),
    ];
    map.addLayer(this.layer);
    this.update();
  }

  interval(): number {
    return this.interval_;
  }

  setInterval(interval: number): void {
    if (interval === this.interval_) return;
    this.interval_ = interval;
    this.labels_.clear();
    this.update();
  }

  /** Traces the lines for the view unless the ones shown already cover it. */
  update(): void {
    if (!this.dem.getVisible()) return;
    const size = this.map.getSize();
    const view = this.map.getView();
    if (!size || !size[0] || !size[1]) return;
    const projection = view.getProjection();
    const [west, south, east, north] = transformExtent(view.calculateExtent(size), projection, 'EPSG:4326');
    const { width, height, spacing } = this.grid;
    const [dLon, dLat] = spacing;
    // Posts of the grid the view shows (with half a view more around it, so small moves need no new trace).
    const padX = (east - west) / 2;
    const padY = (north - south) / 2;
    const col = (lon: number) => (lon - this.grid.west) / dLon;
    const row = (lat: number) => (this.grid.north - lat) / dLat;
    const seen = [Math.floor(col(west)), Math.floor(row(north)), Math.ceil(col(east)), Math.ceil(row(south))];
    if (seen[2] < 0 || seen[3] < 0 || seen[0] > width - 1 || seen[1] > height - 1) {
      this.traced_ = null;
      this.source_.clear();
      return;
    }
    const stride = Math.max(1, Math.floor((2 * (north - south)) / size[1] / dLat));
    const t = this.traced_;
    const clamp = (w: number[]) => [Math.max(0, w[0]), Math.max(0, w[1]), Math.min(width - 1, w[2]), Math.min(height - 1, w[3])];
    const need = clamp(seen);
    if (t && t.stride === stride && t.interval === this.interval_ && t.window[0] <= need[0] && t.window[1] <= need[1] && t.window[2] >= need[2] && t.window[3] >= need[3]) return;
    // On the stride's lattice, so lines stay put as the view moves.
    const snap = (x: number) => Math.floor(x / stride) * stride;
    const window = clamp([snap(col(west - padX)), snap(row(north + padY)), Math.ceil(col(east + padX)), Math.ceil(row(south - padY))]) as ContourRequest['window'];
    const request: ContourRequest = { window, stride, interval: this.interval_ };
    this.traced_ = { window, stride, interval: this.interval_ };
    this.worker_.postMessage({ id: ++this.request_, request } satisfies ContourMessage);
  }

  dispose(): void {
    unByKey(this.keys_);
    this.worker_.terminate();
    this.map.removeLayer(this.layer);
    this.layer.dispose();
  }

  private show_(reply: ContourReply): void {
    if (reply.id !== this.request_) return;
    if (!reply.ok) {
      this.traced_ = null;
      return;
    }
    const toView = getTransform('EPSG:4326', this.map.getView().getProjection());
    const features = reply.lines.map(({ level, coordinates }) => {
      toView(coordinates as unknown as number[], coordinates as unknown as number[], 2);
      const feature = new Feature(new LineString(Array.from(coordinates), 'XY'));
      feature.set('level', level);
      return feature;
    });
    this.source_.clear(true);
    this.source_.addFeatures(features);
    this.options.onTraced?.(features.length, reply.truncated);
  }

  private follow_(): void {
    this.layer.setZIndex((this.dem.getZIndex() ?? 0) + 0.5);
    this.layer.setVisible(this.dem.getVisible());
  }

  private style_(level: number): Style {
    if (!isIndexContour(level, this.interval_)) return LINE;
    let style = this.labels_.get(level);
    if (!style) {
      style = new Style({
        stroke: INDEX,
        text: new Text({
          text: `${Number(level.toFixed(2))}`,
          placement: 'line',
          maxAngle: Math.PI / 6,
          font: '600 11px system-ui, sans-serif',
          fill: new Fill({ color: 'rgb(110, 60, 15)' }),
          stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.9)', width: 3 }),
        }),
      });
      this.labels_.set(level, style);
    }
    return style;
  }
}
