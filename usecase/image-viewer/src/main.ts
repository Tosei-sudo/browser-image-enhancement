/**
 * Image viewer: opens local pictures and GeoTIFFs, and COGs by URL, as layers
 * on an OpenLayers map, and corrects each one in the browser with
 * browser-image-enhancement (on the GPU where WebGL2 is available). Layers of
 * WMS, WMTS, WFS and Esri feature services can be added too: picture layers
 * are corrected like the images, vector layers show their attributes in a
 * table, and editable Esri layers can be edited. Shapefiles and GeoJSON open
 * read-only as vector layers with the same table.
 */
import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
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
import type Feature from 'ol/Feature.js';
import { ImageList, type ViewerLayer, type ViewerService } from './images.js';
import { PointTool } from './points.js';
import { CoordinateMenu } from './coordinate-menu.js';
import { JumpTo } from './jump.js';
import { acceptFiles, openFiles } from './open-files.js';
import { showInfo } from './info.js';
import { AddServiceDialog, openRef, paramToRef, refToParam } from './add-service.js';
import { BaseMapSwitch } from './basemap.js';
import { Editor } from './editor.js';
import { Selection } from './selection.js';
import { AttributeTable, type TableData } from './table.js';
import { MAX_FEATURES, type OpenContext, type ServiceLayer } from './services/index.js';

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

// No base map: the images alone, on a checkerboard, like an ordinary image viewer.
// GeoTIFFs still keep their georeferencing, so overlapping ones line up.
const map = new Map({
  target: mapElement,
  view: new View({ center: [0, 0], zoom: 2 }),
});

// Whether layers can correct on the GPU; if not, the sources correct their tiles in workers.
const probe = new GpuCorrectedTileLayer();
const onGpu = probe.hasGpu();
probe.dispose();

const enhance = new EnhanceControl({ labels: enhanceLabelsJa, collapsed: false });
map.addControl(enhance);

const say = (message: string) => (status.textContent = message);
const selection = new Selection(map);
const table = new AttributeTable(document.getElementById('table')!, map, selection, { say });
const editor = new Editor(map, selection, table, { say, onChange: () => showTable(images.selectedLayer()) });
const baseMap = new BaseMapSwitch(document.getElementById('basemap')!, map);

/** Features found by the last WMS GetFeatureInfo, per layer. */
const featureInfo = new WeakMap<ViewerService, TableData>();

/** What the attribute table shows for a layer. */
function showTable(layer: ViewerLayer | null): void {
  const service = layer?.type === 'service' ? layer.service : null;
  const vector = service?.vector;
  if (layer?.type === 'service' && vector && service) {
    table.show({
      title: layer.name,
      fields: vector.fields,
      features: () => vector.source.getFeatures(),
      note: vector.truncated ? `先頭 ${MAX_FEATURES.toLocaleString()} 件のみ` : undefined,
      watch: [vector.source, ...(editor.session() ? [editor.session()!] : [])],
    });
  } else if (layer?.type === 'service' && service?.featureInfo) {
    table.show(featureInfo.get(layer) ?? null, '地図をクリックすると、その地点の属性を表示します');
  } else {
    table.show(null, layer?.type === 'service' ? 'このレイヤーには属性がありません' : 'WFS・Esri のレイヤーを選ぶと属性を表示します');
  }
}

const images = new ImageList(document.getElementById('images') as HTMLOListElement, map, {
  onSelect: (layer) => {
    // Each image (and picture service) keeps its own correction: show it in the panel.
    const target = layer?.type === 'image' ? layer.source : layer?.type === 'service' ? layer.service.correction : null;
    const saved = target?.getPipeline();
    enhance.setSource(target ?? null);
    if (saved) enhance.setPipeline(saved);
    mapElement.querySelector('.ol-enhance')?.classList.toggle('inactive', !target);
    selection.clear();
    showTable(layer);
    void showInfo(info, layer);
  },
  onRemove: (layer) => {
    if (layer.type === 'image') points.removeImage(layer);
    else if (editor.editing() === layer) editor.stop();
  },
  onChange: (list) => {
    empty.hidden = list.length > 0;
    updateLink();
  },
  onEdit: (layer) => {
    if (editor.start(layer)) showTable(layer);
  },
});

const points = new PointTool(map, images, {
  list: document.getElementById('points') as HTMLOListElement,
  add: document.getElementById('add-point') as HTMLButtonElement,
  save: document.getElementById('save-points') as HTMLButtonElement,
  say,
});

// Right click: copy the coordinates of the point.
const coordinateMenu = new CoordinateMenu(map, images, { say });
// The header field: go to typed coordinates.
const jump = new JumpTo(map, document.getElementById('jump') as HTMLFormElement, { say });

// A click selects features of the selected vector layer (Ctrl / Shift: add to the selection),
// or asks a WMS layer what is there.
map.on('singleclick', (e) => {
  const layer = images.selectedLayer();
  if (points.isAdding() || editor.isDrawing() || layer?.type !== 'service') return;
  const service = layer.service;
  if (service.vector) {
    const hit = map.forEachFeatureAtPixel(e.pixel, (f) => f as Feature, { layerFilter: (l) => l === service.layer, hitTolerance: 4 });
    const add = e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey;
    if (hit && add) selection.toggle(hit);
    else if (hit) selection.set([hit]);
    else if (!add) selection.clear();
    if (hit) table.scrollTo(hit);
  } else if (service.featureInfo) {
    say('属性を問い合わせています…');
    service
      .featureInfo(e.coordinate, map)
      .then(({ features, fields }) => {
        featureInfo.set(layer, { title: `${layer.name}（クリック地点）`, fields, features: () => features });
        selection.set(features);
        if (images.selectedLayer() === layer) showTable(layer);
        say(features.length ? `${features.length} 件の地物があります` : 'この地点に地物はありません');
      })
      .catch((error) => say(`属性を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`));
  }
});

const serviceContext = (): OpenContext => ({ gpu: onGpu, say });

/** Adds a layer of a service (or a vector file) and zooms to it. */
function addService(service: ServiceLayer): void {
  const entry = images.addService(service);
  void images.zoomTo(entry);
  say(`${service.title} を追加しました`);
}

const addDialog = new AddServiceDialog(document.getElementById('add-service') as HTMLButtonElement, { onAdd: addService, context: serviceContext });

/** Keeps `?service=` (and `?base=`) in the address, so the view can be shared as a link. */
function updateLink(): void {
  const params = new URLSearchParams(location.search);
  params.delete('service');
  for (const l of [...images.layers()].reverse()) if (l.type === 'service' && l.service.ref) params.append('service', refToParam(l.service.ref));
  params.delete('base');
  if (baseMap.get()) params.set('base', baseMap.get());
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}
baseMap.select.addEventListener('change', updateLink);

const loader = new LoadImageControl({
  target: 'open',
  labels: loadImageLabelsJa,
  sourceOptions: { loadMissingProjection: true, correctTiles: !onGpu },
  // An ordinary picture goes at the origin, one unit per pixel, wherever the view is.
  placement: ({ width, height }) => ({ extent: [-width / 2, -height / 2, width / 2, height / 2], epsg: 3857 }),
  // Several files at once: Shapefiles and GeoJSON as read-only layers, GeoTIFFs get overviews.
  accept: acceptFiles,
  onFiles: (files) => void openFiles(files, { loader, addLayer: addService, say }),
  onLoad: (loaded: LoadedImage) => {
    images.add(loaded);
    status.textContent = `${loaded.name} を開きました`;
  },
  onError: (error, name) => {
    status.textContent = `${name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
  },
});
map.addControl(loader);

// DRA follows the view for every image; the panel already does it for the selected one.
map.on('moveend', () => {
  for (const layer of images.layers()) {
    if (layer === images.selectedLayer()) continue;
    const target = layer.type === 'image' ? layer.source : layer.service.correction;
    if (target?.getPipeline().get('autoStretch')) void target.updateDra(map);
  }
});

// `?url=<COG>` (repeatable) opens COGs at start, `?service=` service layers and `?base=` a base map,
// so a view can be shared as a link.
const start = new URLSearchParams(location.search);
baseMap.set(start.get('base') ?? '');
for (const url of start.getAll('url')) {
  status.textContent = `${url} を読み込んでいます…`;
  void loader.loadUrl(url).catch(() => {});
}
void (async () => {
  for (const ref of start.getAll('service').map(paramToRef)) {
    if (!ref) continue;
    say(`${ref.url} を読み込んでいます…`);
    try {
      addService(await openRef(ref, serviceContext()));
    } catch (error) {
      say(`${ref.url} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
})();

// For the browser test and the console.
declare global {
  interface Window {
    viewer: {
      map: Map;
      images: ImageList;
      points: PointTool;
      loader: LoadImageControl;
      enhance: EnhanceControl;
      onGpu: boolean;
      selection: Selection;
      table: AttributeTable;
      editor: Editor;
      baseMap: BaseMapSwitch;
      addDialog: AddServiceDialog;
      coordinateMenu: CoordinateMenu;
      jump: JumpTo;
    };
  }
}
window.viewer = { map, images, points, loader, enhance, onGpu, selection, table, editor, baseMap, addDialog, coordinateMenu, jump };
