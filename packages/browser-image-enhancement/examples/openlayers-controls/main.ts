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
} from '../../src/openlayers/index.js';
import { fixtureBlob } from '../openlayers-cog/fixture.js';

// Most imagery COGs are in UTM: register every WGS 84 / UTM zone so they reproject without a network lookup.
for (let zone = 1; zone <= 60; zone++) {
  proj4.defs(`EPSG:${32600 + zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
  proj4.defs(`EPSG:${32700 + zone}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
}
register(proj4);

const status = document.getElementById('status')!;

// The image layer: corrected on the GPU when the map is drawn (in workers without WebGL2).
const layer = new GpuCorrectedTileLayer();
const map = new Map({
  target: 'map',
  layers: [new TileLayer({ source: new OSM() }), layer],
  view: new View({ center: [15540000, 4257000], zoom: 9 }),
});

const loader = new LoadImageControl({
  layer,
  labels: loadImageLabelsJa,
  sourceOptions: { loadMissingProjection: true },
  onLoad: ({ name, kind }) => {
    status.textContent = `${name} を開きました（${kind === 'geotiff' ? 'GeoTIFF の位置情報で配置' : '表示範囲の中央に配置'}）`;
  },
  onError: (error, name) => {
    status.textContent = `${name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
  },
});
const enhance = new EnhanceControl({ layer, labels: enhanceLabelsJa, collapsed: false });
map.addControl(loader);
map.addControl(enhance);

// `?fixture` opens a small GeoTIFF made in the page (no network needed).
if (new URLSearchParams(location.search).has('fixture')) void loader.loadFile(fixtureBlob(), 'fixture.tif');

// For the browser test.
Object.assign(window, { example: { map, layer, loader, enhance } });
