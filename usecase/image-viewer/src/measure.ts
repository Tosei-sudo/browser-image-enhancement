/**
 * Measuring on the map: in distance mode clicks put the vertices of a path
 * (double click ends it), in area mode those of a polygon. Lengths and areas
 * are geodesic, on the WGS 84 ellipsoid (see `geodesic.ts`), and the lines
 * are drawn along the geodesics, so a long one curves on the Web Mercator
 * map as it does on the Earth. Measurements stay on the map until cleared;
 * Esc drops the one being drawn.
 *
 * An ordinary picture has no location: when it is the selected layer, the
 * measurement is in pixels of that picture instead.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import LineString from 'ol/geom/LineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Draw from 'ol/interaction/Draw.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { transform } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { FeatureLike } from 'ol/Feature.js';
import type { ImageList, ViewerImage } from './images.js';
import type { LonLat } from './coordinates.js';
import { formatArea, formatLength, geodesicArea, geodesicLength, geodesicPath } from './geodesic.js';

export type MeasureMode = 'distance' | 'area';

/** What a measurement is in: metres on the ellipsoid, or pixels of a picture (view units per pixel). */
type Unit = { kind: 'geodesic' } | { kind: 'pixel'; resolution: number };

/** The result of a measurement. */
export interface Measurement {
  mode: MeasureMode;
  /** `geodesic`: metres and m²; `pixel`: pixels of the picture. */
  unit: 'geodesic' | 'pixel';
  /** Length of the path, or perimeter of the polygon. */
  length: number;
  /** Area of the polygon (0 for a path). */
  area: number;
  /** As shown on the map, e.g. `12.346 km` or `3.25 ha（周長 812.4 m）`. */
  text: string;
}

export interface MeasureToolOptions {
  /** The distance mode toggle. */
  distance: HTMLButtonElement;
  /** The area mode toggle. */
  area: HTMLButtonElement;
  /** Removes every measurement. */
  clear: HTMLButtonElement;
  /** Shows a message to the user. */
  say: (message: string) => void;
  /** Called when a mode is turned on, so other click tools can step aside. */
  onStart?: () => void;
}

const COLOR = '#ffcc00';
const HALO = '#000a';

export class MeasureTool {
  private readonly source_ = new VectorSource<Feature<Geometry>>();
  private readonly layer_: VectorLayer<VectorSource<Feature<Geometry>>>;
  private mode_: MeasureMode | null = null;
  private draw_: Draw | null = null;
  /** The unit of the measurement being drawn. */
  private unit_: Unit = { kind: 'geodesic' };
  /** Pixel size of each picture, once read. */
  private readonly resolutions_ = new WeakMap<ViewerImage, number>();

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: MeasureToolOptions,
  ) {
    this.layer_ = new VectorLayer({
      source: this.source_,
      zIndex: 10_001, // above the images and the points
      style: (feature) => this.style_(feature, feature.get('unit') as Unit, true),
    });
    map.addLayer(this.layer_);
    this.source_.on(['addfeature', 'clear'], () => this.update_());

    options.distance.addEventListener('click', () => this.setMode(this.mode_ === 'distance' ? null : 'distance'));
    options.area.addEventListener('click', () => this.setMode(this.mode_ === 'area' ? null : 'area'));
    options.clear.addEventListener('click', () => this.clear());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.draw_) this.draw_.abortDrawing();
    });
    this.update_();
  }

  /** The mode turned on, or null. */
  mode(): MeasureMode | null {
    return this.mode_;
  }

  isActive(): boolean {
    return this.mode_ !== null;
  }

  /** Turns a mode on (null: off). */
  setMode(mode: MeasureMode | null): void {
    if (this.draw_) {
      this.map.removeInteraction(this.draw_);
      this.draw_ = null;
    }
    this.mode_ = mode;
    this.options.distance.setAttribute('aria-pressed', String(mode === 'distance'));
    this.options.area.setAttribute('aria-pressed', String(mode === 'area'));
    this.map.getViewport().classList.toggle('measuring', mode !== null);
    if (!mode) return;
    this.options.onStart?.();

    const draw = new Draw({
      type: mode === 'distance' ? 'LineString' : 'Polygon',
      source: this.source_,
      style: (feature) => this.style_(feature, this.unit_, false),
      stopClick: true,
    });
    draw.on('drawstart', () => {
      this.unit_ = this.unitNow_();
    });
    draw.on('drawend', (e) => {
      const feature = e.feature as Feature<Geometry>;
      feature.set('unit', this.unit_);
      const result = this.measure(feature.getGeometry()!, this.unit_);
      this.options.say(`${mode === 'distance' ? '距離' : '面積'}: ${result.text}`);
    });
    this.draw_ = draw;
    this.map.addInteraction(draw);
    void this.prepare_();
    this.options.say(
      mode === 'distance'
        ? 'クリックで点を置き、ダブルクリックで終わります（測地線の長さ。Esc で取り消し）'
        : 'クリックで頂点を置き、ダブルクリックで終わります（楕円体上の面積。Esc で取り消し）',
    );
  }

  /** Removes every measurement. */
  clear(): void {
    this.draw_?.abortDrawing();
    this.source_.clear();
  }

  /** The finished measurements, oldest first. */
  list(): Measurement[] {
    return this.source_.getFeatures().map((f) => this.measure(f.getGeometry()!, f.get('unit') as Unit));
  }

  /** Measures a path or polygon in view coordinates. */
  measure(geometry: Geometry, unit: Unit = { kind: 'geodesic' }): Measurement {
    const pixel = unit.kind === 'pixel';
    const kind = pixel ? 'pixel' : 'geodesic';
    if (geometry instanceof Polygon) {
      const ring = geometry.getCoordinates()[0]?.slice(0, -1) ?? [];
      let area: number;
      let length: number;
      if (pixel) {
        ({ area, length } = planar(ring));
        area /= unit.resolution ** 2;
        length /= unit.resolution;
      } else {
        ({ area, perimeter: length } = geodesicArea(this.lonLats_(ring)));
      }
      const text = pixel ? `${round(area)} px²（周長 ${round(length)} px）` : `${formatArea(area)}（周長 ${formatLength(length)}）`;
      return { mode: 'area', unit: kind, length, area, text };
    }
    const path = (geometry as LineString).getCoordinates();
    const length = pixel ? planar(path, false).length / unit.resolution : geodesicLength(this.lonLats_(path));
    return { mode: 'distance', unit: kind, length, area: 0, text: pixel ? `${round(length)} px` : formatLength(length) };
  }

  /** Pixel measurements on a selected ordinary picture; geodesic everywhere else. */
  private unitNow_(): Unit {
    const image = this.images.selected();
    if (image?.kind === 'image' && this.images.selectedLayer() === image) {
      return { kind: 'pixel', resolution: this.resolutions_.get(image) ?? 1 };
    }
    return { kind: 'geodesic' };
  }

  /** Reads the pixel size of the selected picture before the first click. */
  private async prepare_(): Promise<void> {
    const image = this.images.selected();
    if (image?.kind !== 'image' || this.resolutions_.has(image)) return;
    const view = await image.source.getView();
    const grid = image.source.getTileGrid()?.getResolutions();
    this.resolutions_.set(image, grid?.length ? Math.min(...grid) : (view.resolution ?? 1));
  }

  private lonLats_(coordinates: Coordinate[]): LonLat[] {
    const projection = this.map.getView().getProjection();
    return coordinates.map((c) => transform(c, projection, 'EPSG:4326') as LonLat);
  }

  private fromLonLats_(lonLats: LonLat[]): Coordinate[] {
    const projection = this.map.getView().getProjection();
    return lonLats.map((c) => transform(c, 'EPSG:4326', projection));
  }

  /** The line as drawn: along the geodesics, unless in pixels. */
  private drawn_(geometry: LineString | Polygon, unit: Unit): LineString | Polygon {
    if (unit.kind === 'pixel') return geometry;
    if (geometry instanceof Polygon) {
      const ring = geometry.getCoordinates()[0]?.slice(0, -1) ?? [];
      return new Polygon([this.fromLonLats_(geodesicPath(this.lonLats_(ring), true))]);
    }
    return new LineString(this.fromLonLats_(geodesicPath(this.lonLats_(geometry.getCoordinates()))));
  }

  private style_(feature: FeatureLike, unit: Unit, done: boolean): Style[] {
    const geometry = feature.getGeometry();
    if (geometry instanceof Point) {
      // The cursor while drawing.
      return [new Style({ image: new Circle({ radius: 4, fill: new Fill({ color: COLOR }), stroke: new Stroke({ color: HALO, width: 1.5 }) }) })];
    }
    if (!(geometry instanceof LineString || geometry instanceof Polygon)) return [];
    // The outline Draw keeps beside a polygon being drawn: the polygon's own style draws it.
    if (geometry instanceof LineString && this.mode_ === 'area' && !done) return [];
    const drawn = this.drawn_(geometry, unit);
    const dash = done ? undefined : [8, 6];
    const styles = [
      new Style({ geometry: drawn, stroke: new Stroke({ color: HALO, width: 5 }) }),
      new Style({ geometry: drawn, stroke: new Stroke({ color: COLOR, width: 2.5, lineDash: dash }), fill: new Fill({ color: '#ffcc0026' }) }),
    ];
    const coordinates = geometry instanceof Polygon ? (geometry.getCoordinates()[0] ?? []) : geometry.getCoordinates();
    if (coordinates.length < 2 || (geometry instanceof Polygon && coordinates.length < 4)) return styles;
    const { text } = this.measure(geometry, unit);
    const at = geometry instanceof Polygon ? geometry.getInteriorPoint() : new Point(coordinates.at(-1)!);
    styles.push(
      new Style({
        geometry: at,
        text: new Text({
          text,
          offsetY: geometry instanceof Polygon ? 0 : -16,
          font: '600 13px system-ui, sans-serif',
          fill: new Fill({ color: '#fff' }),
          backgroundFill: new Fill({ color: '#000b' }),
          padding: [2, 5, 2, 5],
          overflow: true,
        }),
      }),
    );
    // Vertices of finished measurements.
    if (done) {
      const vertices = geometry instanceof Polygon ? coordinates.slice(0, -1) : coordinates;
      styles.push(new Style({ geometry: new MultiPoint(vertices), image: new Circle({ radius: 3.5, fill: new Fill({ color: COLOR }), stroke: new Stroke({ color: HALO, width: 1.5 }) }) }));
    }
    return styles;
  }

  private update_(): void {
    this.options.clear.disabled = this.source_.getFeatures().length === 0;
  }
}

/** Length of a path (or perimeter of a ring when `closed`) and area of the ring, in view units. */
function planar(points: Coordinate[], closed = true): { length: number; area: number } {
  let length = 0;
  let twice = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (i + 1 < n || closed) {
      length += Math.hypot(b[0] - a[0], b[1] - a[1]);
      twice += a[0] * b[1] - b[0] * a[1];
    }
  }
  return { length, area: Math.abs(twice) / 2 };
}

function round(n: number): string {
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}
