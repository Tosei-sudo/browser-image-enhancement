/**
 * The selected features of the selected vector layer, shared by the map and
 * the attribute table, and drawn highlighted above every layer.
 */
import Collection from 'ol/Collection.js';
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import Observable from 'ol/Observable.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';

const highlight = [
  new Style({
    stroke: new Stroke({ color: '#fff', width: 6 }),
    image: new Circle({ radius: 9, fill: new Fill({ color: '#fff' }) }),
  }),
  new Style({
    stroke: new Stroke({ color: '#00b7ff', width: 3 }),
    fill: new Fill({ color: '#00b7ff33' }),
    image: new Circle({ radius: 6, fill: new Fill({ color: '#00b7ff' }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
  }),
];

/** Fires `change` whenever the selected features change. */
export class Selection extends Observable {
  /** The selected features (an OpenLayers collection, so edit tools can work on it). */
  readonly features = new Collection<Feature>();
  private readonly source_ = new VectorSource<Feature>();

  constructor(map: OlMap) {
    super();
    map.addLayer(new VectorLayer({ source: this.source_, style: highlight, zIndex: 20_000 }));
    this.features.on('add', (e) => {
      this.source_.addFeature(e.element);
      this.changed();
    });
    this.features.on('remove', (e) => {
      if (this.source_.hasFeature(e.element)) this.source_.removeFeature(e.element);
      this.changed();
    });
  }

  has(feature: Feature): boolean {
    return this.features.getArray().includes(feature);
  }

  list(): Feature[] {
    return this.features.getArray().slice();
  }

  /** Selects exactly `features`. */
  set(features: Feature[]): void {
    const keep = new Set(features);
    for (const f of this.list()) if (!keep.has(f)) this.features.remove(f);
    for (const f of features) if (!this.has(f)) this.features.push(f);
  }

  /** Adds `feature` to the selection, or takes it out. */
  toggle(feature: Feature): void {
    if (this.has(feature)) this.features.remove(feature);
    else this.features.push(feature);
  }

  clear(): void {
    this.set([]);
  }
}
