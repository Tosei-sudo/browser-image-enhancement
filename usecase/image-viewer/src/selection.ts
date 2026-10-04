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

/** Fires `change` whenever the selected features change (once for a change of many). */
export class Selection extends Observable {
  /** The selected features (an OpenLayers collection, so edit tools can work on it). */
  readonly features = new Collection<Feature>();
  private readonly source_ = new VectorSource<Feature>();
  private readonly set_ = new Set<Feature>();
  /** Inside {@link batch_}: the highlight and `change` wait for the end. */
  private batching_ = false;
  /** Features added or taken out during the batch. */
  private touched_ = 0;

  constructor(map: OlMap) {
    super();
    map.addLayer(new VectorLayer({ source: this.source_, style: highlight, zIndex: 20_000 }));
    this.features.on('add', (e) => {
      this.set_.add(e.element);
      if (this.batching_) return void this.touched_++;
      this.source_.addFeature(e.element);
      this.changed();
    });
    this.features.on('remove', (e) => {
      this.set_.delete(e.element);
      if (this.batching_) return void this.touched_++;
      if (this.source_.hasFeature(e.element)) this.source_.removeFeature(e.element);
      this.changed();
    });
  }

  has(feature: Feature): boolean {
    return this.set_.has(feature);
  }

  list(): Feature[] {
    return this.features.getArray().slice();
  }

  /** Selects exactly `features`. */
  set(features: Feature[]): void {
    const keep = new Set(features);
    this.batch_(() => {
      const drop = this.list().filter((f) => !keep.has(f));
      // Taking many out one by one is slow: start again instead.
      if (drop.length > 32) this.features.clear();
      else for (const f of drop) this.features.remove(f);
      for (const f of keep) if (!this.has(f)) this.features.push(f);
    });
  }

  /** Adds `features` to the selection. */
  add(features: Feature[]): void {
    this.batch_(() => {
      for (const f of features) if (!this.has(f)) this.features.push(f);
    });
  }

  /** Takes `features` out of the selection. */
  remove(features: Feature[]): void {
    const drop = new Set(features.filter((f) => this.has(f)));
    if (drop.size === 0) return;
    this.set(this.list().filter((f) => !drop.has(f)));
  }

  /** Adds `feature` to the selection, or takes it out. */
  toggle(feature: Feature): void {
    if (this.has(feature)) this.features.remove(feature);
    else this.features.push(feature);
  }

  clear(): void {
    this.set([]);
  }

  /** Runs `change` with one highlight update and one `change` event at the end (only if something changed). */
  private batch_(change: () => void): void {
    this.batching_ = true;
    this.touched_ = 0;
    try {
      change();
    } finally {
      this.batching_ = false;
    }
    if (this.touched_ === 0) return;
    this.source_.clear(true);
    this.source_.addFeatures(this.list());
    this.changed();
  }
}
