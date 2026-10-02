import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLTileLayer from 'ol/layer/WebGLTile.js';
import OSM from 'ol/source/OSM.js';
import { transformExtent } from 'ol/proj.js';
import { register } from 'ol/proj/proj4.js';
import proj4 from 'proj4';
import { pipeline } from '../../src/index.js';
import EnhancedGeoTIFF from './enhanced-geotiff.js';
import { fixtureBlob } from './fixture.js';

// Sentinel-2 true color, Tokyo area, 2024-01-12 (cloud cover 0.1%). 8-bit RGB COG, public, CORS enabled.
const DEFAULT_URL =
  'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/54/S/UE/2024/1/S2A_54SUE_20240112_0_L2A/TCI.tif';

// Most imagery COGs are in UTM. Registering every WGS 84 / UTM zone up front
// lets OpenLayers reproject them onto the web map without a network lookup.
for (let zone = 1; zone <= 60; zone++) {
  proj4.defs(`EPSG:${32600 + zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
  proj4.defs(`EPSG:${32700 + zone}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
}
register(proj4);

const sliders = [
  { key: 'exposure', label: '露出 (EV)', min: -3, max: 3, step: 0.05, value: 0 },
  { key: 'brightness', label: '明るさ', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'contrast', label: 'コントラスト', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'gamma', label: 'ガンマ', min: 0.2, max: 3, step: 0.01, value: 1 },
  { key: 'inBlack', label: 'レベル 黒', min: 0, max: 0.5, step: 0.005, value: 0 },
  { key: 'inWhite', label: 'レベル 白', min: 0.5, max: 1, step: 0.005, value: 1 },
  { key: 'midGamma', label: 'レベル 中間', min: 0.2, max: 3, step: 0.01, value: 1 },
  { key: 'temperature', label: '色温度', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'saturation', label: '彩度', min: -1, max: 1, step: 0.01, value: 0 },
  { key: 'sharpen', label: 'シャープ 量', min: 0, max: 3, step: 0.05, value: 0 },
  { key: 'sharpenRadius', label: 'シャープ 半径', min: 0.3, max: 5, step: 0.1, value: 1 },
] as const;

type Key = (typeof sliders)[number]['key'];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inputs = {} as Record<Key, HTMLInputElement>;
const status = $<HTMLParagraphElement>('status');
const params = new URLSearchParams(location.search);
const useFixture = params.has('fixture');

for (const s of sliders) {
  const label = document.createElement('label');
  label.innerHTML = `<span>${s.label}</span><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}"><output>${s.value}</output>`;
  const input = label.querySelector('input')!;
  const out = label.querySelector('output')!;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    scheduleUpdate();
  });
  inputs[s.key] = input;
  $('sliders').append(label);
}

const v = (k: Key) => Number(inputs[k].value);

// DRA: stretch to the statistics of the visible area, before the manual corrections.
const draClip = $<HTMLInputElement>('draClip');
const draOptions = () => {
  const method = $<HTMLSelectElement>('draMethod').value as 'percentClip' | 'minMax' | 'standardDeviation';
  const clip = Number(draClip.value);
  return { method, lowPercent: clip, highPercent: clip, stdDevs: 2, linked: $<HTMLInputElement>('draLinked').checked };
};
const base = () => ($<HTMLInputElement>('dra').checked ? pipeline().autoStretch(draOptions()) : pipeline());

const current = () =>
  $<HTMLInputElement>('enabled').checked
    ? base()
        .exposure(v('exposure'))
        .brightness(v('brightness'))
        .contrast(v('contrast'))
        .gamma(v('gamma'))
        .levels({ inBlack: v('inBlack'), inWhite: v('inWhite'), gamma: v('midGamma') })
        .temperature(v('temperature'))
        .saturation(v('saturation'))
        .sharpen({ amount: v('sharpen'), radius: v('sharpenRadius') })
    : pipeline();

const cogLayer = new WebGLTileLayer({ opacity: 1 });
const map = new Map({
  target: 'map',
  layers: [new TileLayer({ source: new OSM() }), cogLayer],
  view: new View({ center: [0, 0], zoom: 2 }),
});

let source: EnhancedGeoTIFF;

function load() {
  const url = $<HTMLInputElement>('url').value.trim();
  source = new EnhancedGeoTIFF({
    sources: [useFixture || !url ? { blob: fixtureBlob() } : { url }],
    pipeline: current(),
    worker: $<HTMLInputElement>('worker').checked,
    loadMissingProjection: true,
  });
  cogLayer.setSource(source);
  source.getView().then(
    (opts) => {
      const projection = opts.projection ?? 'EPSG:4326';
      const extent = transformExtent(opts.extent!, projection, map.getView().getProjection());
      map.getView().fit(extent, { padding: [20, 20, 20, 20] });
    },
    (e: unknown) => (status.textContent = `読み込めませんでした: ${String(e)}`),
  );
}

// Slider moves are coalesced to one re-correction per frame.
let pending = 0;
function scheduleUpdate() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    source.resetStats();
    source.setPipeline(current());
    void source.updateDra(map);
  });
}

// DRA follows the view: new statistics whenever the map stops moving.
map.on('moveend', () => void source?.updateDra(map));

const fmt = (v: number) => (v * 255).toFixed(0);
function draText(): string {
  const stretch = source.getEffectivePipeline().ops.find((op) => op.op === 'stretch');
  if (!$<HTMLInputElement>('dra').checked || !stretch || stretch.op !== 'stretch') return '';
  const [r, g, b] = [0, 1, 2].map((c) => `${fmt(stretch.black[c])}–${fmt(stretch.white[c])}`);
  return ` · DRA 範囲 R ${r} / G ${g} / B ${b}`;
}

map.on('rendercomplete', () => {
  const { tiles, ms } = source.stats;
  if (tiles > 0) status.textContent = `補正したタイル ${tiles} 枚 · 1 枚あたり平均 ${(ms / tiles).toFixed(1)} ms（Worker の順番待ちを含む）${draText()}`;
});

$<HTMLInputElement>('url').value = useFixture ? '' : DEFAULT_URL;
$('load').addEventListener('click', load);
$('worker').addEventListener('change', load);
$('enabled').addEventListener('change', scheduleUpdate);
for (const id of ['dra', 'draMethod', 'draLinked']) $(id).addEventListener('change', scheduleUpdate);
draClip.addEventListener('input', () => {
  $('draClipOut').textContent = draClip.value;
  scheduleUpdate();
});
$('opacity').addEventListener('input', () => {
  const value = $<HTMLInputElement>('opacity').value;
  $('opacityOut').textContent = value;
  cogLayer.setOpacity(Number(value));
});
$('reset').addEventListener('click', () => {
  for (const s of sliders) {
    inputs[s.key].value = String(s.value);
    inputs[s.key].nextElementSibling!.textContent = String(s.value);
  }
  scheduleUpdate();
});

load();

// For the browser test.
const fitLonLat = (extent: number[]) =>
  map.getView().fit(transformExtent(extent, 'EPSG:4326', map.getView().getProjection()), { duration: 0 });
Object.assign(window, { example: { map, layer: cogLayer, get source() { return source; }, inputs, pipeline, fitLonLat } });
