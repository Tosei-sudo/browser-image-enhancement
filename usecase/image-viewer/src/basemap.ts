/**
 * The base map switch in the header: none (the checkerboard, as an image
 * viewer), GSI maps (standard, pale, photo) or OpenStreetMap, drawn below
 * every layer. Base maps are not corrected.
 */
import type OlMap from 'ol/Map.js';
import TileLayer from 'ol/layer/Tile.js';
import XYZ from 'ol/source/XYZ.js';

const gsi = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

export const baseMaps: Record<string, { label: string; url: string; attributions: string; maxZoom: number }> = {
  'gsi-std': { label: '地理院 標準', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
  'gsi-pale': { label: '地理院 淡色', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', attributions: gsi, maxZoom: 18 },
  'gsi-photo': { label: '地理院 写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', attributions: gsi, maxZoom: 18 },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attributions: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
};

/** A select that shows one base map, or none (value ''). */
export class BaseMapSwitch {
  readonly select: HTMLSelectElement;
  private layer_: TileLayer | null = null;

  constructor(
    target: HTMLElement,
    private readonly map: OlMap,
  ) {
    const label = document.createElement('label');
    label.className = 'basemap';
    this.select = document.createElement('select');
    this.select.append(new Option('背景なし', ''), ...Object.entries(baseMaps).map(([key, b]) => new Option(b.label, key)));
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
    const base = baseMaps[key];
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
