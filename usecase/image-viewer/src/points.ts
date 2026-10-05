/**
 * Points on the images: in add mode a click on the selected image puts a
 * point there; points are named and deleted in the list and dragged on the
 * map, and all of them are saved as one GeoJSON file. Each feature has two
 * properties: `image` (the image's file name without extension) and `name`.
 *
 * Coordinates: a GeoTIFF's points are saved as longitude / latitude (WGS 84,
 * as GeoJSON expects); an ordinary picture has no location, so its points are
 * saved as pixel coordinates (x right, y down from the top-left corner).
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Translate from 'ol/interaction/Translate.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { containsCoordinate, type Extent } from 'ol/extent.js';
import { transform, transformExtent } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import { baseName, type ImageList, type ViewerImage } from './images.js';

/** One point. */
export interface ViewerPoint {
  name: string;
  image: ViewerImage;
  feature: Feature<Point>;
  /** The list row. */
  row: HTMLLIElement;
}

/** A point as saved: the GeoJSON feature. */
export interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { image: string; name: string };
}

export interface PointToolOptions {
  /** The list of points. */
  list: HTMLOListElement;
  /** The "add points" toggle. */
  add: HTMLButtonElement;
  /** The save button. */
  save: HTMLButtonElement;
  /** Shows a message to the user. */
  say: (message: string) => void;
}

export class PointTool {
  private readonly source_ = new VectorSource<Feature<Point>>();
  private readonly layer_: VectorLayer<VectorSource<Feature<Point>>>;
  private readonly translate_: Translate;
  private points_: ViewerPoint[] = [];
  private adding_ = false;
  private count_ = 0;

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: PointToolOptions,
  ) {
    this.layer_ = new VectorLayer({
      source: this.source_,
      zIndex: 10_000, // above every image
      style: (feature) => pointStyle(String(feature.get('name') ?? '')),
    });
    map.addLayer(this.layer_);

    // Drag a point to move it (it stays on its own image).
    this.translate_ = new Translate({ layers: [this.layer_] });
    let from: Coordinate | null = null;
    this.translate_.on('translatestart', (e) => {
      from = (e.features.item(0) as Feature<Point>).getGeometry()!.getCoordinates();
    });
    this.translate_.on('translateend', (e) => {
      const feature = e.features.item(0) as Feature<Point>;
      const point = this.points_.find((p) => p.feature === feature);
      if (point && from && !this.inside_(point.image, feature.getGeometry()!.getCoordinates())) {
        feature.getGeometry()!.setCoordinates(from);
        options.say('ポイントは元の画像の範囲内にしか動かせません');
      }
      from = null;
    });
    map.addInteraction(this.translate_);

    map.on('singleclick', (e) => {
      if (this.adding_) void this.addAt(e.coordinate);
    });
    options.add.addEventListener('click', () => this.setAdding(!this.adding_));
    options.save.addEventListener('click', () => this.download());
    this.update_();
  }

  /** The points, in the order they were made. */
  list(): readonly ViewerPoint[] {
    return this.points_;
  }

  isAdding(): boolean {
    return this.adding_;
  }

  /** Turns add mode on or off: on, a click on the selected image adds a point. */
  setAdding(adding: boolean): void {
    this.adding_ = adding;
    this.options.add.setAttribute('aria-pressed', String(adding));
    this.map.getViewport().classList.toggle('adding-points', adding);
    if (adding) this.options.say(this.images.selected() ? '選択中の画像をクリックするとポイントを追加します' : '先に画像を開いてください');
  }

  /** Adds a point on the selected image at `coordinate` (view projection); null when it is not on that image. */
  async addAt(coordinate: Coordinate, name?: string): Promise<ViewerPoint | null> {
    const image = this.images.selected();
    if (!image) {
      this.options.say('先に画像を開いてください');
      return null;
    }
    if (!(await this.insideAsync_(image, coordinate))) {
      this.options.say(`ポイントは選択中の画像（${baseName(image.name)}）の上に置いてください`);
      return null;
    }
    const feature = new Feature({ geometry: new Point(coordinate), name: name ?? `ポイント${++this.count_}` });
    this.source_.addFeature(feature);
    const point: ViewerPoint = { name: feature.get('name'), image, feature, row: document.createElement('li') };
    this.points_.push(point);
    this.buildRow_(point);
    this.update_();
    // Name it right away (opening the list's section if it is folded).
    const fold = this.options.list.closest('details');
    if (fold) fold.open = true;
    const input = point.row.querySelector('input')!;
    input.focus();
    input.select();
    return point;
  }

  remove(point: ViewerPoint): void {
    const i = this.points_.indexOf(point);
    if (i < 0) return;
    this.points_.splice(i, 1);
    this.source_.removeFeature(point.feature);
    this.update_();
  }

  /** Removes the points of an image (when it is closed). */
  removeImage(image: ViewerImage): void {
    for (const p of this.points_.filter((p) => p.image === image)) this.remove(p);
  }

  /** The points as a GeoJSON FeatureCollection. */
  async toGeoJSON(): Promise<{ type: 'FeatureCollection'; features: PointFeature[] }> {
    const projection = this.map.getView().getProjection();
    const features: PointFeature[] = [];
    for (const p of this.points_) {
      const at = p.feature.getGeometry()!.getCoordinates();
      let coordinates: [number, number];
      if (p.image.kind === 'geotiff') {
        const [lon, lat] = transform(at, projection, 'EPSG:4326');
        coordinates = [round(lon, 8), round(lat, 8)];
      } else {
        coordinates = await pixelOf(p.image, at, projection);
      }
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { image: baseName(p.image.name), name: p.name } });
    }
    return { type: 'FeatureCollection', features };
  }

  /** Saves the points as `points.geojson`. */
  async download(): Promise<void> {
    if (this.points_.length === 0) {
      this.options.say('保存するポイントがありません');
      return;
    }
    const json = JSON.stringify(await this.toGeoJSON(), null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/geo+json' }));
    a.download = 'points.geojson';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
    this.options.say(`${this.points_.length} 件のポイントを points.geojson に保存しました`);
  }

  private inside_(image: ViewerImage, coordinate: Coordinate): boolean {
    const extent = this.extents_.get(image);
    return !!extent && containsCoordinate(extent, coordinate);
  }

  /** Image extents in the view projection, cached once read. */
  private readonly extents_ = new WeakMap<ViewerImage, Extent>();

  private async insideAsync_(image: ViewerImage, coordinate: Coordinate): Promise<boolean> {
    if (!this.extents_.has(image)) {
      const view = await image.source.getView();
      if (!view.extent) return false;
      this.extents_.set(image, transformExtent(view.extent, view.projection ?? 'EPSG:4326', this.map.getView().getProjection()));
    }
    return this.inside_(image, coordinate);
  }

  private update_(): void {
    this.options.list.replaceChildren(...this.points_.map((p) => p.row));
    this.options.save.disabled = this.points_.length === 0;
  }

  private buildRow_(point: ViewerPoint): void {
    const { row, feature } = point;
    row.className = 'point';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = point.name;
    name.setAttribute('aria-label', 'ポイント名称');

    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
    });
    const image = document.createElement('span');
    image.className = 'point-image';
    image.textContent = baseName(point.image.name);
    image.title = point.image.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '削除';
    remove.setAttribute('aria-label', `${point.name} を削除`);
    remove.addEventListener('click', () => this.remove(point));
    name.addEventListener('input', () => {
      point.name = name.value;
      feature.set('name', name.value);
      remove.setAttribute('aria-label', `${name.value} を削除`);
    });
    row.append(name, remove, image);
  }
}

/** Pixel coordinates (x right, y down from the top-left) of `at` on an image. */
export async function pixelOf(image: ViewerImage, at: Coordinate, projection: import('ol/proj/Projection.js').default): Promise<[number, number]> {
  const view = await image.source.getView();
  const own = view.projection ?? 'EPSG:3857';
  const [x, y] = transform(at, projection, own);
  const extent = view.extent!;
  const grid = image.source.getTileGrid()?.getResolutions();
  const resolution = grid?.length ? Math.min(...grid) : (view.resolution ?? 1);
  return [round((x - extent[0]) / resolution, 2), round((extent[3] - y) / resolution, 2)];
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pointStyle(name: string): Style {
  return new Style({
    image: new Circle({ radius: 6, fill: new Fill({ color: '#ff3b30' }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
    text: new Text({
      text: name,
      offsetY: -14,
      font: '600 12px system-ui, sans-serif',
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: '#000c', width: 3 }),
    }),
  });
}
