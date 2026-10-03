/**
 * Image viewer: opens local pictures and GeoTIFFs, and COGs by URL, as layers
 * on an OpenLayers map, and corrects each one in the browser with
 * browser-image-enhancement (on the GPU where WebGL2 is available).
 */
import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import {
  EnhanceControl,
  enhanceLabelsJa,
  GpuCorrectedTileLayer,
  LoadImageControl,
  loadImageLabelsJa,
  type LoadedImage,
} from 'browser-image-enhancement/openlayers';
import { ImageList } from './images.js';
import { showInfo } from './info.js';

// Most imagery COGs are in UTM: register every WGS 84 / UTM zone so they reproject without a network lookup.
for (let zone = 1; zone <= 60; zone++) {
  proj4.defs(`EPSG:${32600 + zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
  proj4.defs(`EPSG:${32700 + zone}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
}
register(proj4);

const status = document.getElementById('status')!;
const info = document.getElementById('info') as HTMLDListElement;
const empty = document.getElementById('empty')!;
const mapElement = document.getElementById('map')!;

const basemap = new TileLayer({ source: new OSM(), className: 'basemap' });
const map = new Map({
  target: mapElement,
  layers: [basemap],
  view: new View({ center: [15540000, 4257000], zoom: 9 }),
});

// Without a base map the images are shown on a plain background, like an ordinary image viewer.
const basemapToggle = document.getElementById('basemap') as HTMLInputElement;
const setBasemap = (visible: boolean) => {
  basemap.setVisible(visible);
  mapElement.classList.toggle('no-basemap', !visible);
};
basemapToggle.addEventListener('change', () => setBasemap(basemapToggle.checked));
setBasemap(basemapToggle.checked);

// Whether layers can correct on the GPU; if not, the sources correct their tiles in workers.
const probe = new GpuCorrectedTileLayer();
const onGpu = probe.hasGpu();
probe.dispose();

const enhance = new EnhanceControl({ labels: enhanceLabelsJa, collapsed: false });
map.addControl(enhance);

const images = new ImageList(document.getElementById('images') as HTMLOListElement, map, {
  onSelect: (image) => {
    // Each image keeps its own correction: show it in the panel.
    const saved = image?.source.getPipeline();
    enhance.setSource(image?.source ?? null);
    if (saved) enhance.setPipeline(saved);
    void showInfo(info, image);
  },
  onChange: (list) => {
    empty.hidden = list.length > 0;
  },
});

const loader = new LoadImageControl({
  target: 'open',
  labels: loadImageLabelsJa,
  sourceOptions: { loadMissingProjection: true, correctTiles: !onGpu },
  onLoad: (loaded: LoadedImage) => {
    images.add(loaded);
    status.textContent = `${loaded.name} を開きました（${loaded.kind === 'geotiff' ? 'GeoTIFF の位置情報で配置' : '表示範囲の中央に配置'}）`;
  },
  onError: (error, name) => {
    status.textContent = `${name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
  },
});
map.addControl(loader);

// DRA follows the view for every image; the panel already does it for the selected one.
map.on('moveend', () => {
  for (const image of images.list()) {
    if (image !== images.selected() && image.source.getPipeline().get('autoStretch')) void image.source.updateDra(map);
  }
});

// `?url=<COG>` (repeatable) opens COGs at start, so a view can be shared as a link.
for (const url of new URLSearchParams(location.search).getAll('url')) {
  status.textContent = `${url} を読み込んでいます…`;
  void loader.loadUrl(url).catch(() => {});
}

// For the browser test and the console.
declare global {
  interface Window {
    viewer: { map: Map; images: ImageList; loader: LoadImageControl; enhance: EnhanceControl; onGpu: boolean };
  }
}
window.viewer = { map, images, loader, enhance, onGpu };
