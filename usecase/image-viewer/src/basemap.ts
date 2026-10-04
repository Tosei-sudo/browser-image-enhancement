/**
 * The base map switch in the header: none (the checkerboard, as an image
 * viewer) or one of the base maps in `config.json` (by default GSI standard,
 * pale and photo, and OpenStreetMap), drawn below every layer. Base maps are
 * not corrected.
 */
import type OlMap from 'ol/Map.js';
import TileLayer from 'ol/layer/Tile.js';
import XYZ from 'ol/source/XYZ.js';
import type { BaseMapConfig } from './config.js';

/** A select that shows one base map, or none (value ''). */
export class BaseMapSwitch {
  readonly select: HTMLSelectElement;
  private layer_: TileLayer | null = null;

  constructor(
    target: HTMLElement,
    private readonly map: OlMap,
    private readonly baseMaps: readonly BaseMapConfig[],
  ) {
    const label = document.createElement('label');
    label.className = 'basemap';
    this.select = document.createElement('select');
    this.select.append(new Option('背景なし', ''), ...baseMaps.map((b) => new Option(b.label, b.id)));
    this.select.addEventListener('change', () => this.set(this.select.value));
    label.append('背景地図', this.select);
    target.append(label);
  }

  /** Shows the base map `key` ('' for none). */
  set(key: string): void {
    if (this.layer_) {
      this.map.removeLayer(this.layer_);
      this.layer_.dispose();
      this.layer_ = null;
    }
    const base = this.baseMaps.find((b) => b.id === key);
    this.select.value = base ? key : '';
    this.map.getTargetElement()?.classList.toggle('has-basemap', !!base);
    if (!base) return;
    this.layer_ = new TileLayer({ source: new XYZ({ url: base.url, attributions: base.attributions, maxZoom: base.maxZoom }), zIndex: -1 });
    this.map.addLayer(this.layer_);
  }

  get(): string {
    return this.select.value;
  }
}
