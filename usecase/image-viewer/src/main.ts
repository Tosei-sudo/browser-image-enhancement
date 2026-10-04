/**
 * Image viewer: opens local pictures and GeoTIFFs, and COGs by URL, as layers
 * on an OpenLayers map, and corrects each one in the browser with
 * browser-image-enhancement (on the GPU where WebGL2 is available). Layers of
 * WMS, WMTS, WFS and Esri feature services can be added too: picture layers
 * are corrected like the images, vector layers show their attributes in a
 * table, and editable Esri layers can be edited. Shapefiles, GeoJSON and
 * GeoPackages open as vector layers with the same table, and can be edited too.
 */
import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import { register, setProjectionCodeLookup } from 'ol/proj/proj4.js';
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
import type Point from 'ol/geom/Point.js';
import DragBox from 'ol/interaction/DragBox.js';
import { platformModifierKeyOnly } from 'ol/events/condition.js';
import { ImageList, type ViewerImage, type ViewerLayer, type ViewerService } from './images.js';
import { PointTool } from './points.js';
import { MeasureTool } from './measure.js';
import { CoordinateMenu } from './coordinate-menu.js';
import { showBuildInfo } from './build-info.js';
import { JumpTo } from './jump.js';
import { acceptFiles, openFiles, type OpenFilesContext } from './open-files.js';
import { rsetOf, RsetIndicator, RsetProgress, rsetText } from './rset.js';
import { fileOf, hasFileAccess, onDroppedHandles, pickFiles, RecentFiles, RecentMenu } from './recent-files.js';
import { GeometricMode } from './geometric.js';
import { tiffInfo } from './satellite.js';
import { showInfo } from './info.js';
import { AddServiceDialog, openRef, paramToRef, refKey, refToParam } from './add-service.js';
import { BaseMapSwitch } from './basemap.js';
import { fetchFile, loadConfig, lookupUrl, type LayerConfig, type ViewerConfig } from './config.js';
import { Editor } from './editor.js';
import { ExportDialog } from './export-dialog.js';
import { editTargetOf } from './edit-session.js';
import { Selection } from './selection.js';
import { makeResizer } from './resize.js';
import { AttributeTable, type TableData } from './table.js';
import { MAX_FEATURES, type OpenContext, type ServiceLayer } from './services/index.js';
import { elevationRange } from './dem.js';
import { ProcessingDialog } from './processing-dialog.js';
import { browserStore, recordOf, tempLayer } from './temp-layers.js';
import { registerJapaneseCrs } from './processing/reproject.js';

// Most imagery COGs are in UTM: register every WGS 84 / UTM zone so they reproject without a network lookup.
for (let zone = 1; zone <= 60; zone++) {
  proj4.defs(`EPSG:${32600 + zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
  proj4.defs(`EPSG:${32700 + zone}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
}

// Site settings (base maps, projection registry…) from config.json, so they change without a rebuild.
const config = await loadConfig();
for (const [code, definition] of Object.entries(config.projections)) {
  try {
    proj4.defs(code, definition);
  } catch (error) {
    console.warn(`config.json: projections の「${code}」を登録できませんでした`, error);
  }
}
// Japanese CRSs (JGD2011 / JGD2000 / Tokyo, plane rectangular and UTM) for projecting vectors without a lookup.
registerJapaneseCrs();
register(proj4);
// Other projections are looked up in the configured registry (none when it is '').
setProjectionCodeLookup(async (code) => {
  if (!config.projectionLookup) throw new Error(`${code} の定義がありません（projectionLookup が未設定です）`);
  const response = await fetch(lookupUrl(config.projectionLookup, code));
  if (!response.ok) throw new Error(`${code} の定義を取得できませんでした: HTTP ${response.status}`);
  return response.text();
});

const status = document.getElementById('status')!;
showBuildInfo(document.getElementById('build')!);
const info = document.getElementById('info') as HTMLDListElement;
const empty = document.getElementById('empty')!;
const mapElement = document.getElementById('map')!;

// No base map: the images alone, on a checkerboard, like an ordinary image viewer.
// GeoTIFFs still keep their georeferencing, so overlapping ones line up.
const map = new Map({
  target: mapElement,
  view: new View({ center: [0, 0], zoom: 2 }),
});

// Drag the right edge of the layer panel to change its width.
const side = document.querySelector<HTMLElement>('.side')!;
makeResizer({
  handle: document.getElementById('side-resize')!,
  target: document.querySelector<HTMLElement>('.app')!,
  property: '--side-width',
  axis: 'x',
  size: () => side.getBoundingClientRect().width,
  min: () => 160,
  max: () => Math.max(160, window.innerWidth * 0.6),
  key: 'image-viewer.side-width',
  label: 'レイヤーパネルの幅',
  onResize: () => map.updateSize(),
});

// Whether layers can correct on the GPU; if not, the sources correct their tiles in workers.
const probe = new GpuCorrectedTileLayer();
const onGpu = probe.hasGpu();
probe.dispose();

const enhance = new EnhanceControl({ labels: enhanceLabelsJa, collapsed: false });
map.addControl(enhance);

const say = (message: string) => (status.textContent = message);
// Whether the selected image is drawn from its raw pixels or an RSET level, and the RSETs being made.
const rsetShown = new RsetIndicator(map);
const rsetProgress = new RsetProgress(mapElement);
const selection = new Selection(map);
const table = new AttributeTable(document.getElementById('table')!, map, selection, { say });
const editor = new Editor(map, selection, table, { say, onChange: () => showTable(images.selectedLayer()) });
const baseMap = new BaseMapSwitch(document.getElementById('basemap')!, map, config.baseMaps);

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
      // Deleting from the table starts editing the layer; the deletion waits for "保存" like any other edit.
      onDelete: editTargetOf(service)?.canDelete
        ? (features) => {
            if (!editor.start(layer)) return;
            showTable(layer);
            editor.deleteFeatures(features);
          }
        : undefined,
    });
  } else if (layer?.type === 'service' && service?.featureInfo) {
    table.show(featureInfo.get(layer) ?? null, '地図をクリックすると、その地点の属性を表示します');
  } else {
    table.show(null, layer?.type === 'service' ? 'このレイヤーには属性がありません' : 'WFS・Esri・ファイルのベクターレイヤーを選ぶと属性を表示します');
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
    void showInfo(info, layer, layerInfo(layer));
    rsetShown.setLayer(layer);
    geometry?.setShifting(false);
  },
  onRemove: (layer) => {
    if (layer.type === 'image') {
      points.removeImage(layer);
      geometry.remove(layer);
    } else if (editor.editing() === layer) editor.stop();
  },
  onChange: (list) => {
    empty.hidden = list.length > 0;
    updateLink();
  },
  onEdit: (layer) => {
    if (editor.start(layer)) showTable(layer);
  },
  onExport: (layer) => exporter.open(layer),
});
const exporter = new ExportDialog(selection, { say });

const points = new PointTool(map, images, {
  list: document.getElementById('points') as HTMLOListElement,
  add: document.getElementById('add-point') as HTMLButtonElement,
  save: document.getElementById('save-points') as HTMLButtonElement,
  say,
});

// Geodesic distance and area (in pixels on an ordinary picture). One click tool at a time.
const measure = new MeasureTool(map, images, {
  distance: document.getElementById('measure-distance') as HTMLButtonElement,
  area: document.getElementById('measure-area') as HTMLButtonElement,
  clear: document.getElementById('measure-clear') as HTMLButtonElement,
  say,
  onStart: () => points.setAdding(false),
});
document.getElementById('add-point')!.addEventListener('click', () => {
  if (points.isAdding()) measure.setMode(null);
});

// Right click: copy the coordinates of the point.
const coordinateMenu = new CoordinateMenu(map, images, { say });
// The header field: go to typed coordinates.
const jump = new JumpTo(map, document.getElementById('jump') as HTMLFormElement, { say });

// A click selects features of the selected vector layer (Ctrl / Shift: add to the selection),
// or asks a WMS layer what is there.
map.on('singleclick', (e) => {
  const layer = images.selectedLayer();
  if (points.isAdding() || measure.isActive() || editor.isDrawing() || layer?.type !== 'service') return;
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

// Ctrl (⌘ on a Mac) + drag: add the features in the box to the selection.
const boxSelect = new DragBox({ condition: platformModifierKeyOnly, className: 'ol-dragbox select-box' });
boxSelect.on('boxend', () => {
  const layer = images.selectedLayer();
  const vector = layer?.type === 'service' ? layer.service.vector : null;
  if (!vector) {
    say('範囲で選ぶには、ベクターレイヤーを選んでください');
    return;
  }
  const box = boxSelect.getGeometry();
  const extent = box.getExtent();
  const found: Feature[] = [];
  vector.source.forEachFeatureIntersectingExtent(extent, (f) => {
    // The box turns with the view: keep what really meets it.
    const g = f.getGeometry();
    if (!g) return;
    const inside = g.getType() === 'Point' ? box.intersectsCoordinate((g as Point).getCoordinates()) : box.intersectsExtent(g.getExtent()) && g.intersectsExtent(extent);
    if (inside) found.push(f as Feature);
  });
  selection.add(found);
  if (found[0]) table.scrollTo(found[0]);
  say(found.length ? `${found.length} 件を選択に加えました（選択 ${selection.list().length} 件）` : '範囲内に地物はありません');
});
map.addInteraction(boxSelect);

const serviceContext = (): OpenContext => ({ gpu: onGpu, say });

/** Adds a layer of a service (or a vector file) and zooms to it. */
function addService(service: ServiceLayer): void {
  const entry = images.addService(service);
  void images.zoomTo(entry);
  say(`${service.title} を追加しました`);
}

// Processing tools (buffers, lines from points, centroids, Voronoi / Thiessen, reprojection): results are
// temporary layers, kept in the browser until they are closed.
const tempStore = browserStore();
const processing = new ProcessingDialog(document.getElementById('processing') as HTMLButtonElement, selection, {
  layers: () => images.layers(),
  selected: () => images.selectedLayer(),
  say,
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザに保存できませんでした（このページを開いている間だけ残ります）: ${error instanceof Error ? error.message : String(error)}`));
    addService(tempLayer(record, tempStore));
  },
});

const addDialog = new AddServiceDialog(document.getElementById('add-service') as HTMLButtonElement, { onAdd: addService, context: serviceContext });

/** Keeps `?service=` (and `?base=`) in the address, so the view can be shared as a link. */
function updateLink(): void {
  const params = new URLSearchParams(location.search);
  params.delete('service');
  for (const l of [...images.layers()].reverse()) if (l.type === 'service' && l.service.ref) params.append('service', refToParam(l.service.ref));
  params.delete('base');
  // Only when it differs from config.json's default (`?base=` alone means none).
  if (baseMap.get() !== config.defaultBaseMap) params.set('base', baseMap.get());
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
  // Several files at once: Shapefiles, GeoJSON and GeoPackages as vector layers, GeoTIFFs get overviews.
  accept: acceptFiles,
  onFiles: (files) => void openFiles(files, fileContext()),
  // With the File System Access API the files are chosen as handles, remembered for 「最近」.
  onOpen: hasFileAccess() ? () => void pickAndOpen() : undefined,
  onLoad: (loaded: LoadedImage) => {
    showRset(images.add(loaded));
    status.textContent = `${loaded.name} を開きました`;
    // A COG opened by URL may be a satellite image with an RPC model.
    if (/^https?:/i.test(loaded.name)) {
      void tiffInfo(loaded.name)
        .then((found) => found.rpc && geometry.setSatellite(loaded.source, { rpc: found.rpc, from: loaded.name }))
        .catch(() => {});
    }
  },
  onError: (error, name) => {
    status.textContent = `${name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
  },
});
map.addControl(loader);

// Files opened through the File System Access API open again from 「最近」 after a reload.
const recent = hasFileAccess()
  ? new RecentMenu(new RecentFiles(), { open: (files) => void openFiles(files, fileContext()), say })
  : null;
if (recent) {
  document.getElementById('open')!.append(recent.button);
  onDroppedHandles(map.getViewport(), (handles) => void recent.remember(handles));
}

/** Chooses files with the File System Access picker, remembers them and opens them. */
async function pickAndOpen(): Promise<void> {
  let handles: FileSystemFileHandle[];
  try {
    handles = await pickFiles(acceptFiles);
  } catch {
    // Not allowed here (a cross-origin frame, a policy): the ordinary chooser still works.
    loader.openChooser();
    return;
  }
  if (!handles.length) return;
  const files = await Promise.all(handles.map(fileOf));
  void recent?.remember(handles);
  await openFiles(files, fileContext());
}

// Geometric correction: DTED elevation data, orthorectification of RPC images, moving the result by hand.
const geometry = new GeometricMode(map, images, loader, document.getElementById('geometry')!, {
  say,
  onChange: (image) => {
    if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
  },
  onPipeline: (p) => enhance.setPipeline(p),
});

/** What opening files needs: where they go, and how RSETs being made are shown. */
function fileContext(): OpenFilesContext {
  return {
    loader,
    addLayer: addService,
    say,
    geometry,
    rset: rsetProgress,
    onRsetMade: (source) => {
      const image = images.find(source);
      if (!image) return;
      showRset(image);
      if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
      rsetShown.update();
    },
  };
}

/** The tag in the list saying whether an image has an RSET, and whether the viewer made it. */
function showRset(image: ViewerImage): void {
  const state = rsetOf(image.source);
  const text = { generated: 'RSET生成', file: 'RSET', none: 'RSETなし' }[state.kind];
  images.setTag(image, { text, title: `RSET（縮小版）: ${rsetText(state)}`, className: `rset-${state.kind}` });
}

/** Rows the information panel adds for an image: its RSET, and what the geometric mode knows of it. */
function layerInfo(layer: ViewerLayer | null): Array<[string, string]> {
  if (layer?.type !== 'image') return geometryInfo(layer);
  return [['RSET', rsetText(rsetOf(layer.source))], ...geometryInfo(layer)];
}

/** Rows the information panel adds for elevation data, satellite images and orthorectified layers. */
function geometryInfo(layer: ViewerLayer | null): Array<[string, string]> {
  if (layer?.type !== 'image' || !geometry) return [];
  const dem = geometry.demOf(layer);
  if (dem) {
    const range = elevationRange(dem);
    const rows: Array<[string, string]> = [['標高データ', `${dem.level}（${(dem.spacing[1] * 3600).toFixed(0)}″ 間隔）`]];
    if (range) rows.push(['標高', `${range[0]}〜${range[1]} m`]);
    if (dem.verticalAccuracy !== null) rows.push(['垂直精度', `${dem.verticalAccuracy} m`]);
    return rows;
  }
  const satellite = geometry.satelliteOf(layer);
  if (satellite) return [['センサーモデル', 'RPC']];
  const ortho = geometry.orthoOf(layer);
  if (ortho) return [['オルソ補正', `${ortho.sourceName} から`]];
  return [];
}

// DRA follows the view for every image; the panel already does it for the selected one.
map.on('moveend', () => {
  for (const layer of images.layers()) {
    if (layer === images.selectedLayer()) continue;
    const target = layer.type === 'image' ? layer.source : layer.service.correction;
    if (target?.getPipeline().get('autoStretch')) void target.updateDra(map);
  }
});

// The layers in config.json open first (bottom first), then the link's: `?url=<COG>` (repeatable)
// opens COGs, `?service=` service layers and `?base=` a base map, so a view can be shared as a link.
const start = new URLSearchParams(location.search);
baseMap.set(start.get('base') ?? config.defaultBaseMap);

/** Opens one layer at start; failures are reported in the status line and the rest still open. */
async function openAtStart(layer: LayerConfig): Promise<void> {
  say(`${layer.url} を読み込んでいます…`);
  try {
    if (layer.type === 'cog') await loader.loadUrl(layer.url);
    else if (layer.type === 'file') await openFiles([await fetchFile(layer.url)], fileContext());
    else {
      const { type: kind, ...ref } = layer;
      addService(await openRef({ kind, ...ref }, serviceContext()));
    }
  } catch (error) {
    // The loader's onError has already said why a COG failed.
    if (layer.type !== 'cog') say(`${layer.url} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void (async () => {
  const opening: LayerConfig[] = [...config.layers];
  for (const url of start.getAll('url')) opening.push({ type: 'cog', url });
  // A shared link lists the service layers in config.json too: open those once.
  const fromConfig = new Set(config.layers.filter((l) => l.type !== 'cog' && l.type !== 'file').map((l) => refKey({ ...l, kind: l.type })));
  for (const ref of start.getAll('service').map(paramToRef)) {
    if (ref && !fromConfig.has(refKey(ref))) opening.push({ type: ref.kind, url: ref.url, layer: ref.layer, matrixSet: ref.matrixSet, format: ref.format });
  }
  for (const layer of opening) await openAtStart(layer);
  // The temporary layers of earlier visits, on top.
  const kept = await tempStore.list().catch(() => []);
  for (const record of kept) images.addService(tempLayer(record, tempStore));
  if (kept.length) say(`一時レイヤー ${kept.length} 件を復元しました`);
})();

// For the browser test and the console.
declare global {
  interface Window {
    viewer: {
      map: Map;
      images: ImageList;
      points: PointTool;
      measure: MeasureTool;
      loader: LoadImageControl;
      enhance: EnhanceControl;
      onGpu: boolean;
      selection: Selection;
      table: AttributeTable;
      editor: Editor;
      exporter: ExportDialog;
      boxSelect: DragBox;
      baseMap: BaseMapSwitch;
      config: ViewerConfig;
      addDialog: AddServiceDialog;
      coordinateMenu: CoordinateMenu;
      jump: JumpTo;
      geometry: GeometricMode;
      recent: RecentMenu | null;
      processing: ProcessingDialog;
    };
  }
}
window.viewer = { map, images, points, measure, loader, enhance, onGpu, selection, table, editor, exporter, boxSelect, baseMap, config, addDialog, coordinateMenu, jump, geometry, recent, processing };
