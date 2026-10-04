/**
 * "Go to coordinates": a field in the header that reads latitude / longitude,
 * MGRS or UTM (see `parseCoordinate`), centers the map there and marks the
 * spot until the next jump.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import { fromLonLat } from 'ol/proj.js';
import { formatLatLon, parseCoordinate, type LonLat } from './coordinates.js';

export interface JumpOptions {
  /** Shows a message to the user. */
  say: (message: string) => void;
}

/** Zoom level the map goes to at least when jumping (about 2 m per pixel in Web Mercator). */
const JUMP_ZOOM = 16;

export class JumpTo {
  private readonly marker_ = new Feature<Point>();
  private readonly layer_: VectorLayer<VectorSource<Feature<Point>>>;

  constructor(
    private readonly map: OlMap,
    form: HTMLFormElement,
    private readonly options: JumpOptions,
  ) {
    this.layer_ = new VectorLayer({
      source: new VectorSource({ features: [this.marker_] }),
      zIndex: 10_001, // above images and points
      style: new Style({
        image: new Circle({ radius: 9, fill: new Fill({ color: '#2563eb33' }), stroke: new Stroke({ color: '#2563eb', width: 3 }) }),
      }),
      visible: false,
    });
    map.addLayer(this.layer_);
    const input = form.querySelector('input')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.jump(input.value)) input.select();
    });
  }

  /** Goes to the coordinate in `text`; false (with a message) when it cannot be read. */
  jump(text: string): LonLat | null {
    const lonLat = parseCoordinate(text);
    if (!lonLat) {
      this.options.say(`座標として読めませんでした: ${text}（緯度経度・MGRS・UTM に対応）`);
      return null;
    }
    const view = this.map.getView();
    const center = fromLonLat(lonLat, view.getProjection());
    this.marker_.setGeometry(new Point(center));
    this.layer_.setVisible(true);
    view.animate({ center, zoom: Math.max(view.getZoom() ?? 0, JUMP_ZOOM), duration: 300 });
    this.options.say(`移動しました: ${formatLatLon(lonLat)}`);
    return lonLat;
  }
}
