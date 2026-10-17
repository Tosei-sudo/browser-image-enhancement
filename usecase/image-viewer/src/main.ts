/**
 * Image viewer: opens local pictures and GeoTIFFs, and COGs by URL, as layers
 * on an OpenLayers map, and corrects each one in the browser with
 * browser-image-enhancement (on the GPU where WebGL2 is available). Layers of
 * WMS, WMTS, WFS and Esri feature services can be added too: picture layers
 * are corrected like the images, vector layers show their attributes in a
 * table, and editable Esri layers can be edited. Shapefiles, GeoJSON and
 * GeoPackages open as vector layers with the same table, and can be edited too.
 * Vector layers get symbols and labels of the user's choosing (style-dialog.ts).
 * What is open saves as a project file (project.ts), and the site installs as
 * an app that opens those files (pwa.ts).
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
import { CoordinateMenu, type PointAction } from './coordinate-menu.js';
import { CursorPosition } from './cursor-position.js';
import { showBuildInfo } from './build-info.js';
import { JumpTo } from './jump.js';
import { Bookmarks } from './bookmarks.js';
import { glVector } from './gl-vector.js';
import { clearStreamedCopies, streaming } from './streamed-shapefile.js';
import { acceptFiles, openFiles, openImageFile, type OpenFilesContext } from './open-files.js';
import { endBuilding, markBuilding, rsetOf, RsetIndicator, RsetProgress, rsetSettings, rsetText } from './rset.js';
import { fileOf, hasFileAccess, onDroppedHandles, pickFiles, RecentFiles, RecentMenu } from './recent-files.js';
import { GeometricMode } from './geometric.js';
import { tiffInfo } from './satellite.js';
import { showInfo } from './info.js';
import { fileInfoOf } from './nitf-tiff.js';
import { AddServiceDialog, openRef, paramToRef, refKey, refToParam } from './add-service.js';
import { BaseMapSwitch } from './basemap.js';
import { fetchFile, loadConfig, lookupUrl, type LayerConfig, type ViewerConfig } from './config.js';
import { Editor } from './editor.js';
import { applyImageRule } from './image-rules.js';
import { ExportDialog } from './export-dialog.js';
import { StyleDialog } from './style-dialog.js';
import { MetadataDialog } from './metadata.js';
import { editTargetOf } from './edit-session.js';
import { Selection } from './selection.js';
import { makeResizer } from './resize.js';
import { bindShortcuts, foldSections, Guide, HelpDialog, ToolMenu } from './shell.js';
import { AttributeTable, type TableData } from './table.js';
import { MAX_FEATURES, readService, type OpenContext, type ServiceLayer } from './services/index.js';
import { IMAGE_CHOICE, isImageServerUrl, isMapServerUrl, MAP_CHOICE } from './services/esri-raster.js';
import { RasterRulesDialog } from './raster-rules-dialog.js';
import { elevationRange } from './dem.js';
import { ProcessingDialog } from './processing-dialog.js';
import { DetectDialog, SegmentTool } from './ai-tools.js';
import { TransferDialog } from './ai-transfer.js';
import { imageTime } from './timeline.js';
import type { ProcessingResult } from './processing/common.js';
import { PanSharpenDialog } from './pansharpen-dialog.js';
import { CompositeDialog } from './composite-dialog.js';
import { MosaicDialog } from './mosaic-dialog.js';
import { BandMathDialog } from './band-math-dialog.js';
import { ChangeDialog } from './change-dialog.js';
import { AlignDialog } from './align-dialog.js';
import { Annotations } from './annotations.js';
import { PrintDialog } from './print-dialog.js';
import { ColorizeDialog } from './colorize-dialog.js';
import { NoDataDialog } from './nodata-dialog.js';
import { ViewExportDialog } from './view-export.js';
import { browserStore, recordOf, tempLayer } from './temp-layers.js';
import { registerJapaneseCrs } from './processing/reproject.js';
import { SwipeTool } from './swipe.js';
import { HistogramPanel } from './histogram-panel.js';
import { ProjectControl } from './project.js';
import { onLaunchFiles, registerServiceWorker } from './pwa.js';
import { GlobeToggle } from './globe-panel.js';
import { CatalogPanel, catalogInfo } from './catalog-panel.js';
import { sensorViewOf, type CatalogConfig, type CatalogRecord } from './catalog.js';
import { askDialog, LocalPaths } from './local-paths.js';
import { Timeline } from './timeline.js';
import { Dashboard } from './dashboard.js';
import { ImagingPlanPanel } from './imaging-plan-panel.js';
import type { SatellitePass3d } from './imaging-plan-3d.js';
import { applyLayout, collectLayout, type LayoutParts } from './layout.js';

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
const metadataButton = document.getElementById('metadata-open') as HTMLButtonElement;
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
foldSections(side);
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

// The shell: the click tools in one menu, a guide on the first visit, 「?」 for every shortcut.
const toolMenu = new ToolMenu(document.getElementById('tools-menu')!);
const guide = new Guide(mapElement);
const help = new HelpDialog(guide);
document.getElementById('help')!.addEventListener('click', () => help.open());
const press = (id: string) => () => document.getElementById(id)!.click();
bindShortcuts({
  '?': () => help.open(),
  o: () => document.querySelector<HTMLButtonElement>('#open .ol-load-image button')?.click(),
  '/': () => document.querySelector<HTMLInputElement>('#jump input')!.focus(),
  d: press('measure-distance'),
  a: press('measure-area'),
  p: press('add-point'),
  '3': press('globe-toggle'),
  t: press('timeline-open'),
  b: press('dashboard-open'),
  m: () => bookmarks.add(),
  n: press('annotate'),
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
const baseMap = new BaseMapSwitch(document.getElementById('basemap')!, map, config.baseMaps, { say });

/** Features found by the last WMS GetFeatureInfo, per layer. */
const featureInfo = new WeakMap<ViewerService, TableData>();

/** What the attribute table shows for a layer. */
function showTable(layer: ViewerLayer | null): void {
  const service = layer?.type === 'service' ? layer.service : null;
  const vector = service?.vector;
  if (layer?.type === 'service' && vector && service) {
    const notes = [
      vector.truncated ? `先頭 ${MAX_FEATURES.toLocaleString()} 件のみ` : '',
      vector.note ?? '',
      timeline.filters(layer) ? 'タイムラインの期間内のみ' : '',
      dashboard.filters(layer) ? 'ダッシュボードで絞り込み中' : '',
    ].filter(Boolean);
    const style = service.style;
    table.show({
      title: layer.name,
      fields: vector.fields,
      // What the map shows: the timeline's window and the dashboard's filter.
      features: () => (style?.isFiltered() ? vector.source.getFeatures().filter((f) => style.shows(f)) : vector.source.getFeatures()),
      note: notes.length ? notes.join('・') : undefined,
      watch: [vector.source, timeline, dashboard, ...(editor.session() ? [editor.session()!] : [])],
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
    selection.setLayer(layer?.layer ?? null);
    showTable(layer);
    dashboard?.refresh();
    void showInfo(info, layer, layerInfo(layer));
    // Our own TIFFs of plain pictures have nothing to tell: only GeoTIFFs get the dialog.
    metadataButton.hidden = layer?.type !== 'image' || layer.kind !== 'geotiff';
    rsetShown.setLayer(layer);
    geometry?.setShifting(false);
    // Swipe comparison and the histogram follow the selection.
    swipe?.setLayer(layer?.layer ?? null, layer?.name);
    histogramPanel?.setLayer(layer?.layer ?? null, () => target?.getColorMode() ?? null);
  },
  onRemove: (layer) => {
    if (layer.type === 'image') {
      points.removeImage(layer);
      geometry.remove(layer);
    } else if (editor.editing() === layer) editor.stop();
  },
  onChange: (list) => {
    timeline?.refresh();
    dashboard?.refresh();
    empty.hidden = list.length > 0;
    if (list.length && guide.isShown()) guide.close();
    updateLink();
  },
  onEdit: (layer) => {
    if (editor.start(layer)) showTable(layer);
  },
  onExport: (layer) => exporter.open(layer),
  onStyle: (layer) => styler.open(layer),
  onColorize: (layer) => void colorize.open(layer),
  onRules: (layer) => rasterRules.open(layer),
});
// The timeline: every layer with times on one axis, and a window of time that filters the map, the table and the 3D view.
const timeline: Timeline = new Timeline(images, {
  element: document.getElementById('timeline')!,
  button: document.getElementById('timeline-open') as HTMLButtonElement,
  say,
  onToggle: () => requestAnimationFrame(() => map.updateSize()),
});
// The dashboard: counts, values of attributes, numbers and times of a layer, and a heatmap; its charts filter the viewer too.
const dashboard: Dashboard = new Dashboard(map, images, {
  element: document.getElementById('dashboard')!,
  button: document.getElementById('dashboard-open') as HTMLButtonElement,
  timeline,
  selection,
  say,
  onToggle: () => requestAnimationFrame(() => map.updateSize()),
});
makeResizer({
  handle: document.getElementById('dashboard-resize')!,
  target: document.querySelector<HTMLElement>('.app')!,
  property: '--dash-width',
  axis: 'x',
  reverse: true,
  size: () => dashboard.element.getBoundingClientRect().width,
  min: () => 220,
  max: () => Math.max(220, window.innerWidth * 0.5),
  key: 'image-viewer.dash-width',
  label: 'ダッシュボードの幅',
  onResize: () => map.updateSize(),
});
/** The panels a project keeps the layout of. */
const layoutParts: LayoutParts = { app: document.querySelector<HTMLElement>('.app')!, side, table, timeline, dashboard, onResize: () => requestAnimationFrame(() => map.updateSize()) };
// The table's note says whether it is filtered; the 3D view drapes the map as filtered.
let tableNote = '';
const filtersChanged = () => {
  const layer = images.selectedLayer();
  const note = layer ? `${timeline.filters(layer)}${dashboard.filters(layer)}` : '';
  if (layer && note !== tableNote) showTable(layer);
  tableNote = note;
  globeToggle?.globe()?.scheduleRefresh();
};
timeline.on('change', filtersChanged);
dashboard.on('change', () => {
  filtersChanged();
  // The timeline's chart counts what the dashboard leaves.
  timeline.refresh();
});
const exporter = new ExportDialog(selection, { say });
const styler = new StyleDialog({ say, resolution: () => map.getView().getResolution() });
// Esri image and map services: which images (attribute conditions, order) and raster function, or which layers, are drawn.
const rasterRules = new RasterRulesDialog({
  map,
  say,
  onChange: (layer) => {
    updateLink();
    if (images.selectedLayer() === layer) void showInfo(info, layer, layerInfo(layer));
  },
  openImage: async (blob, name) => {
    await loader.loadFile(blob, name);
  },
});
const metadata = new MetadataDialog({ say });
// Comparison and analysis, tucked under the information: the selected layer on one side of a line, and its histogram.
const swipe = new SwipeTool(map, { button: document.getElementById('swipe') as HTMLButtonElement, say });
const histogramPanel = new HistogramPanel(map, { button: document.getElementById('histogram-open') as HTMLButtonElement, element: document.getElementById('histogram')! });
histogramPanel.setLayer(null);
metadataButton.addEventListener('click', () => {
  const layer = images.selectedLayer();
  if (layer?.type === 'image') void metadata.open(layer);
});

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
  onStart: () => {
    points.setAdding(false);
    aiSegment.setActive(false);
    annotations.setActive(false);
  },
});
document.getElementById('add-point')!.addEventListener('click', () => {
  if (points.isAdding()) measure.setMode(null);
  if (points.isAdding()) aiSegment.setActive(false);
  if (points.isAdding()) annotations.setActive(false);
});
// Notes drawn on the map (arrows, lines, boxes, text): kept in the browser and in projects, and printed.
const annotations: Annotations = new Annotations(map, {
  say,
  button: document.getElementById('annotate') as HTMLButtonElement,
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
    aiSegment.setActive(false);
  },
});

// Right click: copy the coordinates of the point.
// The latitude / longitude under the cursor at the bottom left; its notation is picked in the right-click menu.
const cursorPosition = new CursorPosition(map, { imageAt: (at): Promise<ViewerImage | null> => coordinateMenu.imageAt(at) });
const coordinateMenu: CoordinateMenu = new CoordinateMenu(map, images, {
  say,
  cursor: cursorPosition,
  actions: (): PointAction[] => [{ label: 'この地点で撮像計画を立てる', title: '撮像計画を開き、この地点を対象に撮像機会を計算します', run: (lonLat): void => void imagingPlan.planAt(lonLat) }],
});
// The header field: go to typed coordinates.
const jump = new JumpTo(map, document.getElementById('jump') as HTMLFormElement, { say });
// Named views (kept in the browser and in projects), and the view in the address (`#view=`) for links.
new ToolMenu(document.getElementById('bookmark-menu')!);
const bookmarks: Bookmarks = new Bookmarks(map, document.getElementById('bookmark-menu')!, {
  visibility: () => images.layers().map((l) => [l.name, images.isVisible(l)]),
  setVisibility: (visible) => {
    let changed = false;
    for (const l of images.layers()) {
      const on = visible.get(l.name);
      if (on === undefined || on === images.isVisible(l)) continue;
      images.setVisible(l, on);
      changed = true;
    }
    return changed;
  },
  say,
  hasLocalFiles: () => images.layers().some((l) => (l.type === 'image' && !/^https?:/i.test(l.name)) || (l.type === 'service' && !l.service.ref)),
});

// A click selects features of the selected vector layer (Ctrl / Shift: add to the selection),
// or asks a WMS layer what is there.
map.on('singleclick', (e) => {
  const layer = images.selectedLayer();
  if (points.isAdding() || measure.isActive() || aiSegment.isActive() || annotations.isActive() || editor.isDrawing() || layer?.type !== 'service') return;
  const service = layer.service;
  if (service.vector) {
    const hit = service.style?.onGpu()
      ? service.style.featureAt(map, e.pixel, 4)
      : map.forEachFeatureAtPixel(e.pixel, (f) => f as Feature, { layerFilter: (l) => l === service.layer, hitTolerance: 4 });
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

const serviceContext = (): OpenContext => ({ gpu: onGpu, say, rules: config.serviceRules });

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
  rasterTools: [
    { id: 'band-math', label: 'バンド演算・指標（NDVI など）', open: () => void bandMath.open() },
    { id: 'change', label: '変化抽出（2 時期の差・比）', open: () => void change.open() },
    { id: 'align', label: '自動位置合わせ（基準の画像に合わせる）', open: () => align.open() },
    { id: 'colorize', label: '単バンド画像の着色（赤・シアンなど）', open: () => void colorize.open() },
    { id: 'nodata', label: 'ノーデータの透明化（黒い縁など）', open: () => noData.open() },
    { id: 'composite', label: 'RGB 合成（単バンド画像を R・G・B に）', open: () => void composite.open() },
    { id: 'mosaic', label: 'モザイク（複数の画像をつなぐ）', open: () => void mosaic.open() },
    { id: 'pansharpen', label: 'パンシャープン', open: () => panSharpen.open() },
  ],
});

// AI: models trained elsewhere (ONNX) run on the image: object detection over the view, and click segmentation.
const aiOptions = {
  models: config.aiModels,
  layers: () => images.layers(),
  selected: () => images.selectedLayer(),
  say,
  onResult: async (result: ProcessingResult, made: string) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザに保存できませんでした（このページを開いている間だけ残ります）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
  // The catalog id (an image opened from 「画像カタログ」) and the acquisition time, written on what is found.
  imageInfo: async (layer: ViewerLayer) => ({
    id: layer.type === 'image' ? (catalogIds.get(layer) ?? null) : null,
    time: layer.type === 'image' ? ((await imageTime(layer))?.time ?? null) : null,
  }),
};
const aiDetect = new DetectDialog(document.getElementById('ai-detect') as HTMLButtonElement, map, aiOptions);
const aiSegment = new SegmentTool(document.getElementById('ai-segment') as HTMLButtonElement, map, {
  ...aiOptions,
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
  },
});
// The AI layers into a database (config.json's detectionOutputs): new and corrected features, attributes mapped by role.
const aiTransferButton = document.getElementById('ai-transfer') as HTMLButtonElement;
aiTransferButton.hidden = config.detectionOutputs.length === 0;
const aiTransfer = new TransferDialog(aiTransferButton, selection, {
  outputs: config.detectionOutputs,
  layers: () => images.layers(),
  selected: () => images.selectedLayer(),
  say,
});

// Saving the view: as drawn (PNG / GeoTIFF), or the selected GeoTIFF's samples under it.
const viewExport = new ViewExportDialog(document.getElementById('save-view') as HTMLButtonElement, map, images, { say });
// Printing: the view on a sheet with a title, scale bar, north arrow and legend, as a PDF or PNG.
const printDialog = new PrintDialog(document.getElementById('print') as HTMLButtonElement, map, images, {
  say,
  visible: (layer) => images.isVisible(layer),
  name: () => project.name(),
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
  labels: { ...loadImageLabelsJa, url: 'URL を開く（COG・Esri ImageServer）', urlPlaceholder: 'https://…/image.tif、…/ImageServer' },
  // An Esri image (or map) service URL opens as its picture layer.
  onUrl: (url) => openEsriUrl(url),
  sourceOptions: { loadMissingProjection: true, correctTiles: !onGpu },
  // An ordinary picture goes at the origin, one unit per pixel, wherever the view is.
  placement: ({ width, height }) => ({ extent: [-width / 2, -height / 2, width / 2, height / 2], epsg: 3857 }),
  // Several files at once: Shapefiles, GeoJSON and GeoPackages as vector layers, GeoTIFFs get overviews.
  accept: acceptFiles,
  onFiles: (files) => void project.openFiles(files),
  // With the File System Access API the files are chosen as handles, remembered for 「最近」.
  onOpen: hasFileAccess() ? () => void pickAndOpen() : undefined,
  onLoad: (loaded: LoadedImage) => {
    // config.json's imageRules: the correction and bands an image starts with, by its file name.
    const rule = applyImageRule(config.imageRules, loaded.name, loaded.source, say);
    showRset(images.add(loaded));
    // Opening a link: back to its `#view=` before the fit to the image is drawn, so the view doesn't jump after.
    if (linkedView) bookmarks.applyHash(linkedView);
    status.textContent = rule ? `${loaded.name} を開きました（設定「${rule.label}」を適用）` : `${loaded.name} を開きました`;
    // A COG opened by URL may be a satellite image with an RPC model, or one for the simple orthorectification.
    if (/^https?:/i.test(loaded.name)) {
      void tiffInfo(loaded.name)
        .then((found) => {
          if (found.rpc) geometry.setSatellite(loaded.source, { rpc: found.rpc, from: loaded.name });
          else if (found.georeferenced) geometry.setGeoreferenced(loaded.source, loaded.name, found.view);
        })
        .catch(() => {});
    }
  },
  onError: (error, name) => {
    status.textContent = `${name} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
  },
});
map.addControl(loader);

// Files opened through the File System Access API open again from 「最近」 after a reload.
const recentFiles = hasFileAccess() ? new RecentFiles() : null;
const recent = recentFiles ? new RecentMenu(recentFiles, { open: (files) => void project.openFiles(files), say }) : null;
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
  await project.openFiles(files);
}

// Projects: the open layers with their styles and corrections, the base map and the view, in one .ivproj file.
const project = new ProjectControl({
  map,
  images,
  loader,
  baseMap,
  tempStore,
  recent: recentFiles,
  openFiles: (files) => openFiles(files, fileContext()),
  serviceContext,
  say,
  remember: (handles) => void recent?.remember(handles),
  onChange: updateLink,
  globeState: () => globeToggle.state(),
  restoreGlobe: (state) => globeToggle.restore(state),
  isDem: (layer) => layer.type === 'image' && geometry.isGeoTiffDem(layer),
  useAsDem: (layer) => (layer.type === 'image' ? geometry.useAsDem(layer) : Promise.resolve(false)),
  layerTime: { get: (l) => timeline.layerState(l), set: (l, saved) => timeline.setLayerState(l, saved) },
  bookmarks: { get: () => bookmarks.get(), merge: (list) => bookmarks.merge(list) },
  elevationServices: {
    get: () => geometry.elevationServiceRefs().map((s) => s.url),
    add: async (urls) => {
      for (const url of urls) await geometry.addElevationService(url, undefined, true);
    },
  },
  notes: { get: () => annotations.get(), set: (saved) => annotations.set(saved) },
  layout: {
    collect: (indexOf) => collectLayout(layoutParts, indexOf),
    apply: (layout, listIndexOf) => applyLayout(layoutParts, layout, listIndexOf),
  },
});
new ToolMenu(document.getElementById('project-menu')!);
document.getElementById('project-open')!.addEventListener('click', () => void project.choose());
/** Saves the project; in 3D the view saved is where the camera looks. */
const saveProject = (as = false) => {
  const globe = globeToggle.globe();
  return globe ? globe.withTwoDView(() => project.save(as)) : project.save(as);
};
document.getElementById('project-save')!.addEventListener('click', () => void saveProject());
document.getElementById('project-save-as')!.addEventListener('click', () => void saveProject(true));
// Ctrl+S (⌘S): save the project rather than the page; with Shift, under another name.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void saveProject(e.shiftKey);
  }
});

// Geometric correction: DTED elevation data, orthorectification of RPC images, moving the result by hand.
const geometry = new GeometricMode(map, images, loader, document.getElementById('geometry')!, {
  say,
  onChange: (image) => {
    if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
    geometryChanged();
  },
  onPipeline: (p) => enhance.setPipeline(p),
  onSources: () => geometryChanged(),
});

// Pan-sharpening (from the processing dialog): a panchromatic and a multispectral image make a new layer.
const panSharpen = new PanSharpenDialog(map, images, loader, {
  say,
  onPipeline: (p) => enhance.setPipeline(p),
  open: (file) => openImageFile(file, fileContext()),
});

// Coloring one-band images, and RGB composites of them (from the processing dialog): two dates in red and cyan show what changed.
const timeOfImage = async (image: ViewerImage) => (await imageTime(image))?.time ?? null;
const colorize = new ColorizeDialog(images, { say, timeOf: timeOfImage, onChange: () => updateLink() });
// Band math (from the processing dialog): NDVI and other indices by name, or any expression over the bands.
const bandMath = new BandMathDialog(images, loader, { say, open: (file) => openImageFile(file, fileContext()) });
// Change detection (from the processing dialog): two dates compared, and what changed outlined as a temporary layer.
const change = new ChangeDialog(images, loader, {
  say,
  timeOf: (image) => timeOfImage(image),
  open: (file) => openImageFile(file, fileContext()),
  onPolygons: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザに保存できませんでした（このページを開いている間だけ残ります）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
});
// Automatic alignment (from the processing dialog): an image lined up with a reference by matching their texture.
const align = new AlignDialog(images, loader, { say, open: (file) => openImageFile(file, fileContext()) });
// Which pixels of an image are transparent: the file's no-data value and the usual fill values, the black collar, values typed.
const noData = new NoDataDialog(images, { say });
const composite = new CompositeDialog(images, loader, {
  say,
  timeOf: timeOfImage,
  open: (file) => openImageFile(file, fileContext()),
});
// Mosaics (from the processing dialog): neighbouring scenes joined into one, the first in priority order on top.
const mosaic = new MosaicDialog(images, loader, {
  say,
  timeOf: timeOfImage,
  open: (file) => openImageFile(file, fileContext()),
});

// Image catalogs (config.json's imageCatalogs): search by date, sensor and angle, open the images found:
// COGs by URL, local paths through pathMappings (a URL, or a folder allowed in the browser).
/** What the catalog said of the images opened from it, for the information panel. */
const fromCatalog = new WeakMap<ViewerImage, Array<[string, string]>>();
/** The catalog ids of images opened from a catalog (written on what the AI tools find in them). */
const catalogIds = new WeakMap<ViewerImage, string>();
const localPaths = new LocalPaths(config.pathMappings, { ask: askDialog() });
/** Notes what the catalog says of an image opened from it; its angles start the simple orthorectification. */
const openedFromCatalog = (image: ViewerImage, record: CatalogRecord, catalog: CatalogConfig) => {
  fromCatalog.set(image, catalogInfo(record, catalog));
  if (record.id) catalogIds.set(image, record.id);
  const view = sensorViewOf(record, catalog);
  if (view) geometry.suggestView(image.source, view);
  if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
};
const openCatalogUrl = async (url: string, record: CatalogRecord, catalog: CatalogConfig) => {
  const image = images.find(await loader.loadUrl(url));
  if (image) openedFromCatalog(image, record, catalog);
};
const catalogPanel = new CatalogPanel(document.getElementById('catalog-open') as HTMLButtonElement, map, config.imageCatalogs, {
  say,
  openUrl: openCatalogUrl,
  openPath: config.pathMappings.length
    ? async (path, record, catalog) => {
        const where = await localPaths.resolve(path);
        if (!where) return false;
        if (where.kind === 'url') {
          await openCatalogUrl(where.url, record, catalog);
          return true;
        }
        const files = await Promise.all(where.handles.map(fileOf));
        void recent?.remember(where.handles);
        const before = new Set(images.list());
        await project.openFiles(files);
        const image = images.list().find((i) => !before.has(i));
        if (image) openedFromCatalog(image, record, catalog);
        return true;
      }
    : undefined,
  forgetFolders: config.pathMappings.some((m) => m.url === undefined) ? () => localPaths.forget() : undefined,
});

// Imaging plans (config.json's satelliteCatalogs, or pasted TLEs): when the satellites can next image a layer's features.
const imagingPlan = new ImagingPlanPanel(document.getElementById('plan-open') as HTMLButtonElement, map, config.satelliteCatalogs, {
  layers: () => images.layers(),
  selection,
  say,
  onLayer: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザに保存できませんでした（このページを開いている間だけ残ります）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
    say(`${made} をレイヤーとして追加しました`);
  },
  // In 3D the chosen pass stands up: its orbit, the satellite and its beam.
  onChosen: (): void => globeToggle.globe()?.updateSatellites(),
  view3d: (right): boolean => (globeToggle.isOpen() ? (globeToggle.globe()?.viewSatellite(right) ?? false) : false),
});

/** What opening files needs: where they go, and how RSETs being made are shown. */
function fileContext(): OpenFilesContext {
  return {
    loader,
    addLayer: addService,
    say,
    geometry,
    rset: rsetProgress,
    onRsetBuilding: (source) => {
      const image = images.find(source);
      if (!image) return;
      markBuilding(source, image.layer, map);
      showRset(image);
      if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
      rsetShown.update();
    },
    onRsetMade: (source, replaces) => {
      if (replaces) endBuilding(replaces);
      const image = images.find(replaces ?? source);
      if (!image) {
        // Closed while its RSET was being made.
        if (source !== replaces) source.dispose();
        return;
      }
      if (replaces && source !== replaces) images.replaceSource(image, source);
      showRset(image);
      if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
      rsetShown.update();
    },
  };
}

/** The tag in the list saying whether an image has an RSET, and whether the viewer made it or it came from an .ovr file. */
function showRset(image: ViewerImage): void {
  const state = rsetOf(image.source);
  const text = { generated: 'RSET生成', external: 'RSET (OVR)', file: 'RSET', building: 'RSET生成中', none: 'RSETなし' }[state.kind];
  images.setTag(image, { text, title: `RSET（縮小版）: ${rsetText(state)}`, className: `rset-${state.kind}` });
}

/** Rows the information panel adds for an image: its RSET, and what the geometric mode knows of it. */
function layerInfo(layer: ViewerLayer | null): Array<[string, string]> {
  if (layer?.type !== 'image') return geometryInfo(layer);
  return [...(fromCatalog.get(layer) ?? []), ...fileInfoOf(layer.source), ['RSET', rsetText(rsetOf(layer.source))], ...geometryInfo(layer)];
}

/** Rows the information panel adds for elevation data, satellite images and orthorectified layers. */
function geometryInfo(layer: ViewerLayer | null): Array<[string, string]> {
  if (layer?.type !== 'image' || !geometry) return [];
  const dem = geometry.demOf(layer);
  if (dem) {
    const range = elevationRange(dem);
    const rows: Array<[string, string]> = [['標高データ', `${dem.level}（${(dem.spacing[1] * 3600).toFixed(0)}″ 間隔）`]];
    // DTED heights are whole metres; a GeoTIFF's or a service's, to a tenth.
    if (range) rows.push(['標高', `${range.map((h) => Math.round(h * 10) / 10).join('〜')} m`]);
    if (dem.verticalAccuracy !== null) rows.push(['垂直精度', `${dem.verticalAccuracy} m`]);
    return rows;
  }
  const satellite = geometry.satelliteOf(layer);
  if (satellite) return [['センサーモデル', 'RPC']];
  const view = geometry.geoImageOf(layer)?.view;
  if (view) return [['衛星の方向', `方位角 ${view.azimuth}°、仰角 ${view.elevation}°`]];
  const ortho = geometry.orthoOf(layer);
  if (ortho) return [['オルソ補正', `${ortho.sourceName} から`]];
  return [];
}

// The 3D view: the 2D layers draped over a WGS 84 globe, DEM relief, 3D Tiles, multipatches and the viewshed.
// The tools that work on the 2D view wait while it is open; measuring and saving the view work on the globe instead.
const twoDOnly = ['add-point', 'swipe', 'histogram-open'].map((id) => document.getElementById(id) as HTMLButtonElement);
const threeDMeasure = { 'measure-distance': 'distance', 'measure-area': 'area' } as const;
for (const [id, mode] of Object.entries(threeDMeasure)) {
  const button = document.getElementById(id) as HTMLButtonElement;
  // Before the 2D tool's own listener.
  button.addEventListener(
    'click',
    (e) => {
      const globe = globeToggle.isOpen() ? globeToggle.globe() : null;
      if (!globe) return;
      e.stopImmediatePropagation();
      globe.setMeasure(globe.measureMode() === mode ? null : mode);
    },
    { capture: true },
  );
}
document.getElementById('save-view')!.addEventListener(
  'click',
  (e) => {
    const globe = globeToggle.isOpen() ? globeToggle.globe() : null;
    if (!globe) return;
    e.stopImmediatePropagation();
    void globe.savePicture();
  },
  { capture: true },
);
const globeToggle = new GlobeToggle(map, {
  button: document.getElementById('globe-toggle') as HTMLButtonElement,
  section: document.getElementById('globe-section')!,
  panel: document.getElementById('globe')!,
  context: {
    map,
    images,
    selection,
    cells: () => geometry.cells(),
    elevationSources: () => geometry.elevationSources(),
    cellsFor: (lonLat, maxPosts) => geometry.cellsFor(lonLat, maxPosts),
    showFeature: (layer, feature) => {
      if (images.selectedLayer() !== layer) images.select(layer);
      selection.set([feature]);
      table.scrollTo(feature);
    },
    say,
    // The measuring buttons show the 3D tool's mode while 3D is open.
    onMeasure: (now) => {
      for (const [id, mode] of Object.entries(threeDMeasure)) document.getElementById(id)!.setAttribute('aria-pressed', String(now === mode));
    },
    satellitePasses: (): SatellitePass3d[] => imagingPlan.chosenPasses(),
  },
  onToggle: (open) => {
    if (open) {
      measure.setMode(null);
      points.setAdding(false);
      if (swipe.isActive()) swipe.setActive(false);
      if (histogramPanel.isOpen()) histogramPanel.setOpen(false);
    }
    for (const b of twoDOnly) {
      b.disabled = open;
      if (open) b.dataset.title2d ??= b.title;
      b.title = open ? '3D 表示では使えません（「3D」でもとに戻します）' : (b.dataset.title2d ?? b.title);
    }
    for (const id of Object.keys(threeDMeasure)) document.getElementById(id)!.setAttribute('aria-pressed', 'false');
  },
});
// A DEM opened or closed changes the relief.
const geometryChanged = () => globeToggle.globe()?.scheduleRefresh();

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
// `?vectorgl=always` / `never`: draw vector layers on the GPU whatever their size, or never (else only large ones).
const vectorGl = start.get('vectorgl');
if (vectorGl === 'always' || vectorGl === 'never') glVector.mode = vectorGl;
// `?shpstream=always` / `never`: read Shapefiles a view at a time whatever their size, or never (else only large ones).
const shpStream = start.get('shpstream');
if (shpStream === 'always' || shpStream === 'never') streaming.mode = shpStream;
// Browser copies of large Shapefiles left by an earlier visit.
void clearStreamedCopies();

/**
 * A URL typed in the open box (or given as `?url=`) that is an Esri image
 * service or map service: opened as its picture layer. False for any other URL.
 */
async function openEsriUrl(url: string): Promise<boolean> {
  if (!isImageServerUrl(url) && !isMapServerUrl(url)) return false;
  say(`${url} を読み込んでいます…`);
  try {
    const catalog = await readService(url, 'esri');
    const choice = catalog.choices.find((c) => c.name === IMAGE_CHOICE || c.name === MAP_CHOICE)!;
    addService(await catalog.open(choice, serviceContext()));
  } catch (error) {
    say(`${url} を開けませんでした: ${error instanceof Error ? error.message : String(error)}（トークンが必要なサービスは「サービスを追加」から開いてください）`);
    throw error;
  }
  return true;
}

/** Opens one layer at start; failures are reported in the status line and the rest still open. */
async function openAtStart(layer: LayerConfig): Promise<void> {
  say(`${layer.url} を読み込んでいます…`);
  try {
    if (layer.type === 'cog') {
      if (!(await openEsriUrl(layer.url).catch(() => true))) await loader.loadUrl(layer.url);
    }
    else if (layer.type === 'file') await project.openFiles([await fetchFile(layer.url)], layer.url);
    else {
      const { type: kind, ...ref } = layer;
      addService(await openRef({ kind, ...ref }, serviceContext()));
    }
  } catch (error) {
    // The loader's onError has already said why a COG failed.
    if (layer.type !== 'cog') say(`${layer.url} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A link's `#view=` wins over where the layers opening at start would zoom to.
let linkedView: string | null = location.hash || null;
const started = (async () => {
  const opening: LayerConfig[] = [...config.layers];
  for (const url of start.getAll('url')) opening.push({ type: 'cog', url });
  // A shared link lists the service layers in config.json too: open those once.
  const fromConfig = new Set(config.layers.filter((l) => l.type !== 'cog' && l.type !== 'file').map((l) => refKey({ ...l, kind: l.type })));
  for (const ref of start.getAll('service').map(paramToRef)) {
    if (ref && !fromConfig.has(refKey(ref))) opening.push({ type: ref.kind, url: ref.url, layer: ref.layer, matrixSet: ref.matrixSet, format: ref.format, settings: ref.settings });
  }
  for (const layer of opening) await openAtStart(layer);
  // Elevation services of config.json, ready for orthorectification and 3D.
  for (const service of config.elevationServices) await geometry.addElevationService(service.url, service.token, true);
  // The temporary layers of earlier visits, on top.
  const kept = await tempStore.list().catch(() => []);
  for (const record of kept) images.addService(tempLayer(record, tempStore));
  if (kept.length) say(`一時レイヤー ${kept.length} 件を復元しました`);
  if (linkedView) bookmarks.applyHash(linkedView);
  linkedView = null;
})();
bookmarks.applyHash();
// A project opened meanwhile replaces these layers once they are open.
project.setReady(started);

// The installed app opened with files from the operating system (a project, GeoTIFFs…): open them as if chosen.
onLaunchFiles((handles) => {
  void (async () => {
    const files = await Promise.all(handles.map(fileOf));
    void recent?.remember(handles.filter((h) => !/\.ivproj$/i.test(h.name)));
    await project.openFiles(files);
  })();
});
void registerServiceWorker();

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
      styler: StyleDialog;
      metadata: MetadataDialog;
      boxSelect: DragBox;
      baseMap: BaseMapSwitch;
      config: ViewerConfig;
      addDialog: AddServiceDialog;
      coordinateMenu: CoordinateMenu;
      jump: JumpTo;
      geometry: GeometricMode;
      recent: RecentMenu | null;
      processing: ProcessingDialog;
      panSharpen: PanSharpenDialog;
      colorize: ColorizeDialog;
      noData: NoDataDialog;
      composite: CompositeDialog;
      mosaic: MosaicDialog;
      bandMath: BandMathDialog;
      change: ChangeDialog;
      align: AlignDialog;
      annotations: Annotations;
      print: PrintDialog;
      aiDetect: DetectDialog;
      aiSegment: SegmentTool;
      aiTransfer: TransferDialog;
      toolMenu: ToolMenu;
      guide: Guide;
      help: HelpDialog;
      swipe: SwipeTool;
      histogram: HistogramPanel;
      viewExport: ViewExportDialog;
      project: ProjectControl;
      rset: typeof rsetSettings;
      globe: GlobeToggle;
      catalog: CatalogPanel;
      timeline: Timeline;
      dashboard: Dashboard;
      imagingPlan: ImagingPlanPanel;
      rasterRules: RasterRulesDialog;
      bookmarks: Bookmarks;
    };
  }
}
window.viewer = { map, images, points, measure, loader, enhance, onGpu, selection, table, editor, exporter, styler, metadata, boxSelect, baseMap, config, addDialog, coordinateMenu, jump, geometry, recent, processing, panSharpen, colorize, noData, composite, mosaic, bandMath, change, align, annotations, print: printDialog, aiDetect, aiSegment, aiTransfer, toolMenu, guide, help, swipe, histogram: histogramPanel, viewExport, project, rset: rsetSettings, globe: globeToggle, catalog: catalogPanel, timeline, dashboard, imagingPlan, rasterRules, bookmarks };
