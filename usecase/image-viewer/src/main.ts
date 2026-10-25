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
  type EnhancedGeoTIFF,
  type LoadedImage,
} from 'browser-image-enhancement/openlayers';
import { intersects } from 'ol/extent.js';
import { transformExtent } from 'ol/proj.js';
import type Feature from 'ol/Feature.js';
import type Point from 'ol/geom/Point.js';
import DragBox from 'ol/interaction/DragBox.js';
import { platformModifierKeyOnly } from 'ol/events/condition.js';
import { ImageList, shortName, type ViewerImage, type ViewerLayer, type ViewerService } from './images.js';
import { PointTool } from './points.js';
import { MeasureTool } from './measure.js';
import { ShadowHeightTool } from './shadow-height.js';
import { CoordinateMenu, type PointAction } from './coordinate-menu.js';
import { CursorPosition } from './cursor-position.js';
import { showBuildInfo } from './build-info.js';
import { JumpTo } from './jump.js';
import { PlaceSearch } from './geocode.js';
import { Bookmarks } from './bookmarks.js';
import { glVector } from './gl-vector.js';
import { clearStreamedCopies, streaming } from './streamed-shapefile.js';
import { acceptFiles, openFiles, openImageFile, originOf, placeImage, type OpenFilesContext } from './open-files.js';
import { DataSources } from './data-sources.js';
import { isVectorName } from './vector-files.js';
import { isCsvName } from './csv.js';
import { GeorefDialog } from './georef-dialog.js';
import { describeGeoref, type Georef } from './georef.js';
import { StatusLine } from './status-line.js';
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
import { enableWindowMoving } from './move-windows.js';
import { enablePopOut } from './pop-out.js';
import type { MenuItem } from './context-menu.js';
import { DockLayout } from './dock.js';
import { enableDialogDocking, forgetFloated } from './dock-dialogs.js';
import { bindShortcuts, foldSections, Guide, HelpDialog, ToolMenu } from './shell.js';
import { Hints } from './help.js';
import { Theme } from './theme.js';
import { AttributeTable, type TableData } from './table.js';
import { MAX_FEATURES, readService, type OpenContext, type ServiceLayer, type ServiceRef } from './services/index.js';
import { IMAGE_CHOICE, isImageServerUrl, isMapServerUrl, MAP_CHOICE } from './services/esri-raster.js';
import { RasterRulesDialog } from './raster-rules-dialog.js';
import { elevationRange } from './dem.js';
import { NewLayerDialog } from './new-layer-dialog.js';
import { TessellateDialog } from './tessellate-dialog.js';
import { ProcessingDialog, tools as processingTools } from './processing-dialog.js';
import { bindPalette, buttonCommands, CommandPalette } from './command-palette.js';
import { ZonalDialog } from './zonal-dialog.js';
import { DetectDialog, SegmentTool } from './ai-tools.js';
import { TransferDialog } from './ai-transfer.js';
import { imageTime } from './timeline.js';
import type { ProcessingResult } from './processing/common.js';
import { PanSharpenDialog } from './pansharpen-dialog.js';
import { CompositeDialog } from './composite-dialog.js';
import { MosaicDialog } from './mosaic-dialog.js';
import { BandMathDialog } from './band-math-dialog.js';
import { ChangeDialog } from './change-dialog.js';
import { ClassifyDialog } from './classify-dialog.js';
import { AlignDialog } from './align-dialog.js';
import { Annotations } from './annotations.js';
import { PrintDialog } from './print-dialog.js';
import { ColorizeDialog } from './colorize-dialog.js';
import { ClassLegend } from './class-legend.js';
import { NoDataDialog } from './nodata-dialog.js';
import { ViewExportDialog } from './view-export.js';
import { browserStore, recordOf, tempLayer } from './temp-layers.js';
import { registerJapaneseCrs } from './processing/reproject.js';
import { GpDialog } from './gp-dialog.js';
import { openMapServer } from './services/esri-raster.js';
import { SwipeTool } from './swipe.js';
import { SplitView } from './split-view.js';
import { HistogramPanel } from './histogram-panel.js';
import { SpectralPanel } from './spectral.js';
import { ProjectControl } from './project.js';
import { WebMapDialogs } from './webmap-dialog.js';
import { onLaunchFiles, registerServiceWorker } from './pwa.js';
import { GlobeToggle } from './globe-panel.js';
import { CatalogPanel, catalogInfo } from './catalog-panel.js';
import { WatchPanel } from './watch-panel.js';
import { esriJson } from './services/esri.js';
import type { LonLat } from './coordinates.js';
import { sensorViewOf, timeText, type CatalogConfig, type CatalogRecord } from './catalog.js';
import { askDialog, LocalPaths } from './local-paths.js';
import { CellLinks } from './cell-links.js';
import { canSaveToFolder, saveFolder, SaveFolderDialog } from './save-folder.js';
import { results } from './result-store.js';
import { ResultSaveDialog } from './result-save-dialog.js';
import { ResultsDialog } from './results-dialog.js';
import { Timeline } from './timeline.js';
import { MovingDialog } from './moving-dialog.js';
import type { MovingLayer } from './moving-layer.js';
import type { Track } from './moving.js';
import { MatchDialog } from './moving-match-dialog.js';
import { Dashboard } from './dashboard.js';
import { ImagingPlanPanel } from './imaging-plan-panel.js';
import { startReminders } from './imaging-plan-remind.js';
import { SavedPlansPanel } from './imaging-plan-saved.js';
import { ObservationPanel } from './observation-panel.js';
import { EsriObservationStore, LocalObservationStore, type ObservationStore } from './observations.js';
import { EsriTaxonomyStore, LocalTaxonomyStore, type TaxonomyStore } from './taxonomy.js';
import { MovingTargetDialog } from './moving-target-dialog.js';
import { SatelliteTrackPanel } from './satellite-track-panel.js';
import { ScriptDialog } from './script-dialog.js';
import type { SavedScript } from './script/saved.js';
import type { SatellitePass3d } from './imaging-plan-3d.js';
import { applyLayout, collectLayout, type LayoutParts } from './layout.js';
import { POINT_ZOOM, hasShapes, linkOfShapes, readLinkShapes, shapeParamsOf, withoutShapes } from './link-shapes.js';
import { EmbedApi } from './embed.js';
import { layerId } from './script/api.js';
import { configureAuth } from './auth.js';
import { SignInMenu } from './auth-menu.js';
import { AuthLoadImageControl } from './auth-cog.js';
import { StacPanel } from './stac-panel.js';
import { PcSigner, signingFetch, stacInfo } from './stac.js';
import { ClipboardTools } from './clipboard.js';
import { createEmpty, extend, isEmpty, type Extent } from 'ol/extent.js';

// Most imagery COGs are in UTM: register every WGS 84 / UTM zone so they reproject without a network lookup.
for (let zone = 1; zone <= 60; zone++) {
  proj4.defs(`EPSG:${32600 + zone}`, `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`);
  proj4.defs(`EPSG:${32700 + zone}`, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
}

// Site settings (base maps, projection registry…) from config.json, so they change without a rebuild.
const config = await loadConfig();
// ArcGIS sign-in and the access rules (src/auth.ts), before anything is requested; this tab's sign-ins come back.
configureAuth({ portals: config.arcgisPortals, rules: config.authRules });
// Planetary Computer's blobs (a STAC catalog with "sign": "planetary-computer") are signed on each request,
// so the URLs kept in layer names, links and projects stay without the token, and open again later with a fresh one.
if (config.stacCatalogs.some((c) => c.sign === 'planetary-computer')) window.fetch = signingFetch(window.fetch.bind(window), new PcSigner());
for (const [code, definition] of Object.entries(config.projections)) {
  try {
    proj4.defs(code, definition);
  } catch (error) {
    console.warn(`config.json: projections の「${code}」の登録に失敗`, error);
  }
}
// Japanese CRSs (JGD2011 / JGD2000 / Tokyo, plane rectangular and UTM) for projecting vectors without a lookup.
registerJapaneseCrs();
register(proj4);
// Other projections are looked up in the configured registry (none when it is '').
setProjectionCodeLookup(async (code) => {
  if (!config.projectionLookup) throw new Error(`${code} の定義なし（projectionLookup が未設定）`);
  const response = await fetch(lookupUrl(config.projectionLookup, code));
  if (!response.ok) throw new Error(`${code} の定義の取得に失敗: HTTP ${response.status}`);
  return response.text();
});

const status = new StatusLine(document.getElementById('status')!);
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

// Dialogs move by their title, and the panels over the map by their background; a dialog also goes out into a window of its own.
enableWindowMoving();
enablePopOut();

const side = document.querySelector<HTMLElement>('.side')!;
foldSections(side);
// The panels around the map (layers, attribute tables, dashboard, docked dialogs) in left, right and bottom docks, as tabs.
const dock = new DockLayout(document.querySelector<HTMLElement>('.app')!, { onResize: () => requestAnimationFrame(() => map.updateSize()) });
dock.add({ id: 'layers', title: () => 'レイヤー', element: side, grip: document.getElementById('images-title'), home: 'left' });

// The shell: the click tools in one menu, a guide on the first visit, 「?」 for every shortcut.
const toolMenu = new ToolMenu(document.getElementById('tools-menu')!);
// 「表示」 in the menu: light, dark or the system's setting.
new Theme(document.getElementById('theme-choices')!);
// Opt-in help for those new to it: explanations beside the controls (off until turned on).
const hints = new Hints();
const guide = new Guide(mapElement, hints);
const help = new HelpDialog(guide, hints);
document.getElementById('help')!.addEventListener('click', () => help.open());
const press = (id: string) => () => document.getElementById(id)!.click();
bindShortcuts({
  '?': () => help.open(),
  o: () => document.querySelector<HTMLButtonElement>('#open .ol-load-image button')?.click(),
  '/': () => document.querySelector<HTMLInputElement>('#jump input')!.focus(),
  d: press('measure-distance'),
  a: press('measure-area'),
  h: press('shadow-height'),
  p: press('add-point'),
  '3': press('globe-toggle'),
  t: press('timeline-open'),
  b: press('dashboard-open'),
  m: () => bookmarks.add(),
  n: press('annotate'),
  c: press('split'),
});

// Whether layers can correct on the GPU; if not, the sources correct their tiles in workers.
const probe = new GpuCorrectedTileLayer();
const onGpu = probe.hasGpu();
probe.dispose();

const enhance = new EnhanceControl({ labels: enhanceLabelsJa, collapsed: false });
map.addControl(enhance);

const say = (message: string) => status.say(message);
/** Messages of files opening: summed up on the status line when many open together. */
const sayForFiles = (message: string) => status.sayForFiles(message);
// 「サインイン」 in the header, when config.json lists ArcGIS portals.
const signIn = new SignInMenu(document.getElementById('signin-menu')!, { say });
// Whether the selected image is drawn from its raw pixels or an RSET level, and the RSETs being made.
const rsetShown = new RsetIndicator(map);
const rsetProgress = new RsetProgress(mapElement);
const selection = new Selection(map);
/** Features of `layer` as a link (`?geom=` WKT), labeled as the layer's labels are: opened, it shows them as a temporary layer. */
const shapeLinkOf = (layer: ViewerLayer | null, features: Feature[]): string | null => {
  const service = layer?.type === 'service' ? layer.service : null;
  return linkOfShapes(location.href, features, { name: service?.title, labelField: service?.style?.get().label.field ?? null });
};
// URL and path values in attribute tables are links: images, services and vector files open on the map, the rest in a
// new tab; local paths through pathMappings and the folders allowed for them, like the image catalog's.
const cellLinks = new CellLinks({
  mappings: config.pathMappings,
  resolve: (path) => localPaths.resolve(path),
  openUrl: async (url) => {
    if (await openEsriUrl(url)) return;
    const name = new URL(url, document.baseURI).pathname;
    if (isVectorName(name) || isCsvName(name)) await project.openFiles([await fetchFile(url)]);
    else await loader.loadUrl(url);
  },
  openFiles: async (handles) => {
    const files = await Promise.all(handles.map(fileOf));
    void recent?.remember(handles);
    await project.openFiles(files);
  },
  say,
});
const table = new AttributeTable(document.getElementById('table')!, map, selection, {
  say,
  links: cellLinks,
  shapeLink: (features) => shapeLinkOf(images.selectedLayer(), features),
  // 「GeoJSON でコピー」・「WKT でコピー」.
  menuItems: (features) => clipboard.menuItems(features),
  onPin: () => {
    const layer = images.selectedLayer();
    if (layer) pinTable(layer);
  },
});
dock.add({ id: 'table', title: () => '属性テーブル', element: table.element, grip: table.heading, placeButton: (b) => table.heading.after(b), home: 'bottom' });

/** Attribute tables kept on one layer each (「固定」, or 「属性テーブルを表示」 of a layer's menu), by their id in the layout. */
const pinnedTables = new globalThis.Map<string, { layer: ViewerLayer; table: AttributeTable }>();
let pinnedCount = 0;

/** Opens a table kept on `layer` (or brings its open one to the front); `id`: its id in a saved layout. */
function pinTable(layer: ViewerLayer, id?: string): void {
  if (!id) {
    const open = [...pinnedTables].find(([, p]) => p.layer === layer);
    if (open) return dock.activate(open[0]);
  }
  while (!id || pinnedTables.has(id)) id = `table:${++pinnedCount}`;
  const element = document.createElement('section');
  element.className = 'table';
  element.setAttribute('aria-label', `属性テーブル: ${layer.name}`);
  const pinned = new AttributeTable(element, map, selection, {
    say,
    links: cellLinks,
    shapeLink: (features) => shapeLinkOf(layer, features),
    menuItems: (features) => clipboard.menuItems(features),
    heading: '属性',
  });
  pinnedTables.set(id, { layer, table: pinned });
  pinned.show(...tableDataOf(layer));
  const panelId = id;
  dock.add({ id, title: () => layer.name, element, grip: pinned.heading, placeButton: (b) => pinned.heading.after(b), close: () => unpinTable(panelId), home: 'bottom', homeWith: 'table' });
  dock.activate(id);
}

/** Closes a kept table. */
function unpinTable(id: string): void {
  const pinned = pinnedTables.get(id);
  if (!pinned) return;
  pinnedTables.delete(id);
  dock.remove(id, true);
  pinned.table.dispose();
  pinned.table.element.remove();
}
const editor = new Editor(map, selection, table, {
  say,
  onChange: () => showTable(images.selectedLayer()),
  // Drawing snaps to the vector layers shown, not only the edited one.
  snapSources: () =>
    images
      .layers()
      .filter((l): l is ViewerService => l.type === 'service' && images.isVisible(l) && !!l.service.vector)
      .map((l) => l.service.vector!.source),
});
const baseMap = new BaseMapSwitch(document.getElementById('basemap')!, map, config.baseMaps, { say, onChange: () => split?.refreshBase() });

/** Features found by the last WMS GetFeatureInfo, per layer. */
const featureInfo = new WeakMap<ViewerService, TableData>();

/** What the attribute table shows for a layer (and the kept tables for theirs). */
function showTable(layer: ViewerLayer | null): void {
  table.show(...tableDataOf(layer));
  for (const p of pinnedTables.values()) p.table.show(...tableDataOf(p.layer));
}

/** What an attribute table shows for `layer`: its features, or none with a message. */
function tableDataOf(layer: ViewerLayer | null): [data: TableData | null, message?: string] {
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
    return [{
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
    }];
  } else if (layer?.type === 'service' && service?.featureInfo) {
    return [featureInfo.get(layer) ?? null, '地図をクリックすると、その地点の属性を表示'];
  }
  return [null, layer?.type === 'service' ? 'このレイヤーには属性なし' : 'WFS・Esri・ファイルのベクターレイヤーを選ぶと属性を表示'];
}

/** Called when the open layers change (set by the panels made later). */
let imagesChanged = (): void => {};
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
    spectral?.setImage(layer?.type === 'image' ? layer : null);
  },
  onRemove: (layer) => {
    for (const [id, p] of pinnedTables) if (p.layer === layer) unpinTable(id);
    if (layer.type === 'image') {
      points.removeImage(layer);
      geometry.remove(layer);
    } else if (editor.editing() === layer) editor.stop();
  },
  onChange: (list) => {
    recognizeResults(list);
    timeline?.refresh();
    split?.refresh();
    dashboard?.refresh();
    imagesChanged();
    empty.hidden = list.length > 0;
    if (list.length && guide.isShown()) guide.close();
    updateLink();
    embed?.layersChanged();
    // A layer renamed: the tabs of its kept tables.
    if (pinnedTables.size) dock.refresh();
  },
  onEdit: (layer) => {
    if (editor.start(layer)) showTable(layer);
  },
  onExport: (layer) => exporter.open(layer),
  onStyle: (layer) => styler.open(layer),
  onGroupStyle: (group, layers) => styler.open(layers[0], { name: group.name, layers }),
  onColorize: (layer) => void colorize.open(layer),
  onRules: (layer) => rasterRules.open(layer),
  onGeoref: (layer) => georef.open(layer),
  onSave: (layer) => {
    const info = results.infoOf(layer);
    if (info) void resultSaver.open({ info, image: layer });
  },
  // An image from 「画像カタログ」: the catalog's images taken like it (same sensor, near angles, same ground).
  layerMenu: (layer) => {
    const from = layer.type === 'image' ? catalogRecords.get(layer) : undefined;
    const items: MenuItem[] = from ? [{ label: '類似画像の検索…', run: () => void catalogPanel.findSimilar(from.record, from.catalog) }] : [];
    // Its own table, kept beside the others (several layers' tables at once).
    if (layer.type === 'service' && (layer.service.vector || layer.service.featureInfo)) items.push({ label: '属性テーブルを表示', run: () => pinTable(layer) });
    return items;
  },
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
{
  const head = dashboard.element.querySelector<HTMLElement>('.dashboard-head h2');
  const close = dashboard.element.querySelector<HTMLElement>('[data-action=close]');
  dock.add({ id: 'dashboard', title: () => 'ダッシュボード', element: dashboard.element, grip: head, placeButton: (b) => (close ? close.before(b) : head?.after(b)), close: () => dashboard.setOpen(false), home: 'right' });
}
dock.sizeHandles({ left: document.getElementById('side-resize')!, right: document.getElementById('dashboard-resize')!, bottom: document.getElementById('bottom-resize')! });
// Every dialog can be docked too (its ◧ button), and opens where it was docked.
enableDialogDocking(dock);
document.getElementById('layout-reset')!.addEventListener('click', () => {
  forgetFloated();
  dock.reset();
});
/** The panels a project keeps the layout of. */
const layoutParts: LayoutParts = {
  app: document.querySelector<HTMLElement>('.app')!,
  side,
  table,
  timeline,
  dashboard,
  dock,
  // The kept tables, by their layers.
  tables: {
    list: () => [...pinnedTables].map(([id, p]) => ({ id, layer: p.layer })),
    set: (tables) => {
      for (const id of [...pinnedTables.keys()]) unpinTable(id);
      for (const t of tables) pinTable(t.layer, t.id);
    },
  },
  onResize: () => requestAnimationFrame(() => map.updateSize()),
};
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
// Side by side: two or four panes sharing the view, each after the first showing one layer over the base map.
const split = new SplitView(map, {
  app: layoutParts.app,
  images,
  baseLayers: () => baseMap.layers(),
  button: document.getElementById('split') as HTMLButtonElement,
  counts: document.getElementById('split-counts')!,
  say,
  onResize: () => {},
});
layoutParts.split = { view: split, layers: () => images.layers() };
layoutParts.layers = () => images.layers();
const histogramPanel = new HistogramPanel(map, { button: document.getElementById('histogram-open') as HTMLButtonElement, element: document.getElementById('histogram')! });
histogramPanel.setLayer(null);
// Every band's values at points clicked on the map, overlaid, for the selected image.
const spectral = new SpectralPanel(map, {
  button: document.getElementById('spectral-open') as HTMLButtonElement,
  element: document.getElementById('spectral')!,
  image: () => {
    const layer = images.selectedLayer();
    return layer?.type === 'image' ? layer : null;
  },
  idle: () => !measure.isActive() && !points.isAdding() && !annotations.isActive() && !aiSegment.isActive() && !observations.isActive(),
});
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
    shadowHeight.setActive(false);
    observations.setActive(false);
  },
});
// Height from a shadow: the foot and the tip of the shadow, with the Sun's elevation from the image or its time.
const shadowHeight: ShadowHeightTool = new ShadowHeightTool(map, images, {
  button: document.getElementById('shadow-height') as HTMLButtonElement,
  say,
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
    aiSegment.setActive(false);
    annotations.setActive(false);
    observations.setActive(false);
  },
});
document.getElementById('add-point')!.addEventListener('click', () => {
  if (points.isAdding()) shadowHeight.setActive(false);
  if (points.isAdding()) measure.setMode(null);
  if (points.isAdding()) aiSegment.setActive(false);
  if (points.isAdding()) annotations.setActive(false);
  if (points.isAdding()) observations.setActive(false);
});
// Notes drawn on the map (arrows, lines, boxes, text): kept in the browser and in projects, and printed.
const annotations: Annotations = new Annotations(map, {
  say,
  button: document.getElementById('annotate') as HTMLButtonElement,
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
    aiSegment.setActive(false);
    shadowHeight.setActive(false);
    observations.setActive(false);
  },
});

// Right click: copy the coordinates of the point.
// The latitude / longitude under the cursor at the bottom left; its notation is picked in the right-click menu.
const cursorPosition = new CursorPosition(map, { imageAt: (at): Promise<ViewerImage | null> => coordinateMenu.imageAt(at) });
const coordinateMenu: CoordinateMenu = new CoordinateMenu(map, images, {
  say,
  cursor: cursorPosition,
  actions: (): PointAction[] => [
    { label: 'この地点の撮像計画', title: '撮像計画を開き、この地点を対象に撮像機会を計算', run: (lonLat): void => void imagingPlan.planAt(lonLat) },
    ...(config.imageCatalogs.length
      ? [{ label: 'この地点の新着画像を監視…', title: 'この地点を写した画像が画像カタログに新しく入ったら、バッジと「通知」で通知', run: ([lon, lat]: LonLat): void => void catalogPanel.watchSearch({ lon, lat }) }]
      : []),
  ],
});
// The header field: go to typed coordinates.
const jump = new JumpTo(map, document.getElementById('jump') as HTMLFormElement, { say, places: new PlaceSearch(config.geocoders) });
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
  if (points.isAdding() || measure.isActive() || aiSegment.isActive() || annotations.isActive() || observations.isActive() || editor.isDrawing() || layer?.type !== 'service') return;
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
    say('属性を問い合わせ中…');
    service
      .featureInfo(e.coordinate, map)
      .then(({ features, fields }) => {
        featureInfo.set(layer, { title: `${layer.name}（クリック地点）`, fields, features: () => features });
        selection.set(features);
        if (images.selectedLayer() === layer) showTable(layer);
        say(features.length ? `地物 ${features.length} 件` : 'この地点に地物なし');
      })
      .catch((error) => say(`属性の取得に失敗: ${error instanceof Error ? error.message : String(error)}`));
  }
});

// Ctrl (⌘ on a Mac) + drag: add the features in the box to the selection.
const boxSelect = new DragBox({ condition: platformModifierKeyOnly, className: 'ol-dragbox select-box' });
boxSelect.on('boxend', () => {
  const layer = images.selectedLayer();
  const vector = layer?.type === 'service' ? layer.service.vector : null;
  if (!vector) {
    say('範囲選択にはベクターレイヤーの選択が必要');
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
  say(found.length ? `${found.length} 件を選択に追加（選択 ${selection.list().length} 件）` : '範囲内に地物なし');
});
map.addInteraction(boxSelect);

const serviceContext = (): OpenContext => ({ gpu: onGpu, say, rules: config.serviceRules, area: serviceArea, openRaster: (file, url) => project.openFiles([file], url) });

/** The area a service reads (OGC API, WCS): the view, or the selected features' extent. */
function serviceArea(which: 'view' | 'selection'): Extent | null {
  if (which === 'view') return map.getView().calculateExtent(map.getSize());
  const features = selection.list();
  if (!features.length) return null;
  const extent = createEmpty();
  for (const f of features) {
    const g = f.getGeometry();
    if (g) extend(extent, g.getExtent());
  }
  return isEmpty(extent) ? null : extent;
}

/** Adds a layer of a service (or a vector file) and zooms to it. */
function addService(service: ServiceLayer): void {
  const entry = images.addService(service);
  void images.zoomTo(entry);
  say(`${service.title} を追加`);
}

// Files as inputs of the processing tools (📂 next to a tool's layer choice), opened without adding them to the map.
const dataSources = new DataSources(images, {
  openFiles: (files) => openFiles(files, { ...fileContext(), fit: false }),
  openUrl: async (url) => {
    const name = new URL(url, document.baseURI).pathname;
    if (isVectorName(name) || isCsvName(name)) await openFiles([await fetchFile(url)], { ...fileContext(), fit: false });
    else await loader.loadUrl(url);
  },
  accept: acceptFiles,
  recent: () => recentFiles,
  remember: (handles) => void recent?.remember(handles),
  fileAccess: hasFileAccess(),
  say,
});

// Processing tools (buffers, lines from points, centroids, Voronoi / Thiessen, reprojection): results are
// temporary layers, kept in the browser until they are closed.
const tempStore = browserStore();
const rasterTools = [
  { id: 'band-math', label: 'バンド演算・指標（NDVI など）', open: () => void bandMath.open(), dialog: () => bandMath.dialog },
  { id: 'change', label: '変化抽出（2 時期の差・比）', open: () => void change.open(), dialog: () => change.dialog },
  { id: 'classify', label: '土地被覆分類（自動・学習ポリゴン）', open: () => classify.open(), dialog: () => classify.dialog },
  { id: 'align', label: '自動位置合わせ（基準画像への位置合わせ）', open: () => align.open(), dialog: () => align.dialog },
  { id: 'colorize', label: '単バンド画像の着色・色分け（カラースケール・区分・値ごと）', open: () => void colorize.open(), dialog: () => colorize.dialog },
  { id: 'nodata', label: 'ノーデータの透明化（黒い縁など）', open: () => noData.open(), dialog: () => noData.dialog },
  { id: 'georef', label: '投影を設定（座標系・ワールドファイル・四隅）', open: () => georef.open(), dialog: () => georef.dialog },
  { id: 'composite', label: 'RGB 合成（単バンド画像を R・G・B に）', open: () => void composite.open(), dialog: () => composite.dialog },
  { id: 'mosaic', label: 'モザイク（複数画像の接合）', open: () => void mosaic.open(), dialog: () => mosaic.dialog },
  { id: 'pansharpen', label: 'パンシャープン', open: () => panSharpen.open(), dialog: () => panSharpen.dialog },
  { id: 'zonal', label: 'ゾーン統計（ポリゴンごとの平均・最大など）', open: () => void zonal.open(), dialog: () => zonal.dialog },
  { id: 'tessellate', label: '格子の敷き詰め（正方形・六角形・三角形）', open: () => tessellateDialog.open(), dialog: () => tessellateDialog.dialog, vector: true },
];
const processing = new ProcessingDialog(document.getElementById('processing') as HTMLButtonElement, selection, {
  layers: () => images.inputs(),
  sources: dataSources,
  selected: () => images.selectedLayer(),
  say,
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    addService(tempLayer(record, tempStore));
  },
  rasterTools,
});
// Zonal statistics (from the processing dialog): each polygon's mean, max… of an image's bands, as a temporary layer.
const zonal = new ZonalDialog(selection, {
  layers: () => images.inputs(),
  sources: dataSources,
  selected: () => images.selectedLayer(),
  say,
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    addService(tempLayer(record, tempStore));
  },
});

// Server-side processing (ArcGIS GP services, OGC API – Processes): feature results are temporary layers too.
const gp = new GpDialog(document.getElementById('gp-open') as HTMLButtonElement | null, selection, {
  map,
  services: () => config.gpServices,
  layers: () => images.layers(),
  say,
  onFeatures: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
  openImage: async (url) => {
    try {
      await loader.loadUrl(url);
    } catch (error) {
      // Not a GeoTIFF: a picture (or anything else that opens as a file).
      if (/\.tiff?(?:[?#]|$)/i.test(url)) throw error;
      await project.openFiles([await fetchFile(url)], url);
    }
  },
  addMapServer: async (url, token) => addService(await openMapServer(url, { ...serviceContext(), token })),
});

// Ctrl+K: every tool by name — the bar's buttons and menus, the side panel's, and the processing tools.
const palette = new CommandPalette(() => [
  { id: 'open-file', label: 'ファイルを開く', detail: '画像・GeoTIFF・Shapefile・GeoJSON など', keys: 'O', run: () => document.querySelector<HTMLButtonElement>('#open .ol-load-image button')?.click() },
  { id: 'jump', label: '座標・地名へ移動', detail: '緯度経度・MGRS・UTM・地名・住所', keys: '/', run: () => document.querySelector<HTMLInputElement>('#jump input')!.focus() },
  { id: 'bookmark-add', label: '現在の表示をブックマークに追加', detail: 'ブックマーク', keys: 'M', run: () => bookmarks.add() },
  { id: 'help-topics', label: 'やりたいことから検索（ヘルプ）', detail: '操作の手順と、そのボタンの場所', run: () => help.open('topics') },
  { id: 'help-terms', label: '用語の説明（ヘルプ）', detail: 'バンド・DRA・オルソ補正などの言葉', run: () => help.open('terms') },
  { id: 'help-hints', label: hints.isEnabled() ? 'ボタンの説明を非表示' : 'ボタンの説明を表示（初心者向け）', detail: 'ヘルプ — マウスを乗せたボタンやスライダーの説明', run: () => hints.toggle() },
  ...buttonCommands(document.querySelectorAll('.bar, .side .analysis-tools, #metadata-open')).filter((c) => c.id !== 'palette-open'),
  ...processingTools.map((t) => ({ id: `processing:${t.id}`, label: t.label, detail: 'プロセッシング（ベクター）', run: () => processing.open(t.id) })),
  // The grid tool has a button of its own in ツール (listed with the bar's buttons).
  ...rasterTools.filter((t) => !('vector' in t)).map((t) => ({ id: `processing:${t.id}`, label: t.label, detail: 'プロセッシング（画像）', run: t.open })),
]);
bindPalette(palette);
document.getElementById('palette-open')!.addEventListener('click', () => palette.open());

/**
 * Shapes in a link (`?geom=`, `?line=`, `?polygon=`, `?geojson=`, or a
 * `web+imageviewer:` link handed to the installed app): one temporary layer,
 * zoomed to unless the link says where to look (`#view=`). Returns the layer
 * (null when no shape could be read), and what could not be read.
 */
async function addLinkShapes(params: URLSearchParams, zoom: boolean): Promise<{ layer: ViewerService | null; count: number; errors: string[] }> {
  if (!hasShapes(params)) return { layer: null, count: 0, errors: [] };
  const shapes = readLinkShapes(params);
  const skipped = shapes.errors.length ? `（読めなかったもの: ${shapes.errors.join(' / ')}）` : '';
  if (!shapes.features.length) {
    say(`リンクの図形の表示に失敗${skipped}`);
    return { layer: null, count: 0, errors: shapes.errors };
  }
  const record = recordOf({ title: shapes.title, features: shapes.features, fields: shapes.fields }, 'リンクから追加');
  await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
  const service = tempLayer(record, tempStore);
  const entry = images.addService(service);
  if (shapes.color || shapes.labeled) {
    const spec = service.style!.get();
    if (shapes.color) spec.symbol = { ...spec.symbol, fill: shapes.color, stroke: shapes.color };
    if (shapes.labeled) spec.label = { ...spec.label, field: 'label' };
    service.style!.set(spec);
  }
  if (zoom) {
    // Points alone (one, or a few close together) are shown with their surroundings, not as close as the map goes.
    const pointsOnly = shapes.features.every((f) => ['Point', 'MultiPoint'].includes(f.getGeometry()?.getType() ?? ''));
    const only = shapes.features.length === 1 ? shapes.features[0].getGeometry() : null;
    if (only?.getType() === 'Point') map.getView().animate({ center: (only as Point).getCoordinates(), zoom: shapes.zoom ?? POINT_ZOOM, duration: 250 });
    else if (pointsOnly) map.getView().fit(service.extent!, { padding: [40, 40, 40, 40], maxZoom: shapes.zoom ?? POINT_ZOOM, duration: 250 });
    else void images.zoomTo(entry);
  }
  const n = shapes.features.length;
  say(`リンクの図形 ${n.toLocaleString()} 個を一時レイヤー「${shapes.title}」に追加${skipped}`);
  return { layer: entry, count: n, errors: shapes.errors };
}

// New layers designed by the person (geometry type and attributes): empty temporary layers, drawn on at once.
const newLayer = new NewLayerDialog(document.getElementById('new-layer') as HTMLButtonElement, {
  layers: () => images.layers().filter((l): l is ViewerService => l.type === 'service'),
  say,
  onCreate: async (record, draw) => {
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    const entry = images.addService(tempLayer(record, tempStore));
    if (!editor.start(entry)) {
      say(`${record.title} を追加`);
      return;
    }
    showTable(entry);
    if (draw) {
      editor.setTool('add');
      say(`${record.title} を作成。地図のクリックで作図開始（属性は属性テーブルで入力、「保存」でブラウザに保存）`);
    }
  },
});

// Squares, hexagons or triangles over an area (drawn, a layer's features, the view): a temporary polygon layer.
const tessellateDialog = new TessellateDialog(document.getElementById('tessellate-open') as HTMLButtonElement, selection, {
  map,
  layers: () => images.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector),
  selected: () => {
    const layer = images.selectedLayer();
    return layer?.type === 'service' ? layer : null;
  },
  say,
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
    aiSegment.setActive(false);
    shadowHeight.setActive(false);
    annotations.setActive(false);
  },
});

// AI: models trained elsewhere (ONNX) run on the image: object detection over the view, and click segmentation.
const aiOptions = {
  models: config.aiModels,
  layers: () => images.layers(),
  selected: () => images.selectedLayer(),
  say,
  onResult: async (result: ProcessingResult, made: string) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
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
    shadowHeight.setActive(false);
    observations.setActive(false);
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

// Moving objects (config.json's movingFeeds, or by URL; history files): ships and aircraft as layers that follow the timeline,
// and AI detections checked against them.
const moving = new MovingDialog(document.getElementById('moving-open') as HTMLButtonElement, {
  map,
  images,
  feeds: config.movingFeeds,
  timeline,
  say,
  idle: () => !measure.isActive() && !points.isAdding() && !annotations.isActive() && !aiSegment.isActive() && !observations.isActive() && !editor.isDrawing(),
});
const movingMatch = new MatchDialog(document.getElementById('moving-match') as HTMLButtonElement, {
  layers: () => images.layers(),
  selected: () => images.selectedLayer(),
  feeds: () => moving.feeds(),
  say,
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    return images.addService(tempLayer(record, tempStore));
  },
});

// Saving the view: as drawn (PNG / GeoTIFF), or the selected GeoTIFF's samples under it.
const viewExport = new ViewExportDialog(document.getElementById('save-view') as HTMLButtonElement, map, images, { say });
// Printing: the view on a sheet with a title, scale bar, north arrow and legend, as a PDF or PNG.
// 「保存先…」: downloads, or a folder written into directly where the browser can.
const saveFolderDialog = canSaveToFolder() ? new SaveFolderDialog(saveFolder, { say }) : null;
if (saveFolderDialog) {
  const saveFolderButton = document.getElementById('save-folder') as HTMLButtonElement;
  const label = () =>
    void saveFolder.current().then((folder) => (saveFolderButton.textContent = folder ? `保存先: ${folder.name}…` : '保存先…'));
  saveFolder.onChange(label);
  label();
  saveFolderButton.hidden = false;
  saveFolderButton.addEventListener('click', () => void saveFolderDialog.open());
}
// Processing results: kept in the browser as they are made (result-store.ts), saved as COG or GeoTIFF from their row (⇩) or 「処理結果…」.
const resultSaver = new ResultSaveDialog({ say, chooseFolder: saveFolderDialog ? () => void saveFolderDialog.open() : undefined });
const resultsButton = document.getElementById('results-open') as HTMLButtonElement;
const resultsDialog = new ResultsDialog(images, {
  say,
  saver: resultSaver,
  open: async (file) => {
    const source = await openImageFile(file, fileContext());
    return (source && images.find(source)) ?? null;
  },
});
resultsButton.addEventListener('click', () => void resultsDialog.open());
const countResults = () =>
  void results
    .list()
    .then((kept) => (resultsButton.textContent = kept.length ? `処理結果（${kept.length}）…` : '処理結果…'))
    .catch(() => {});
results.onChange(countResults);
/** Layers opened from a result kept in the browser (by a project) are results again: their save button, their files. */
const checkedResults = new WeakSet<ViewerLayer>();
function recognizeResults(list: readonly ViewerLayer[]): void {
  for (const layer of list) {
    if (layer.type !== 'image' || checkedResults.has(layer)) continue;
    checkedResults.add(layer);
    const file = originOf(layer.source)?.file;
    if (!file || results.infoOf(layer)) continue;
    void results
      .recognize(file)
      .then(async (kept) => {
        if (!kept || results.infoOf(layer)) return;
        const files = await Promise.all(kept.files.map((name) => (name === file.name ? file : results.file(kept, name))));
        results.mark(layer, { tool: kept.tool, kept, files, categorical: kept.categorical });
        images.setBadge(layer, kept.tool);
      })
      .catch(() => {});
  }
}
results.onMark((image, info) => {
  images.setSavable(image, true);
  // Kept in the browser: a project names its file and opens it again.
  if (info.kept) project.adopt(image, [info.files[0]]);
  countResults();
});
void results.cleanUp().catch(() => {}).then(countResults);
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

const loader = new AuthLoadImageControl({
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
    const rule = applyImageRule(config.imageRules, loaded.name, loaded.source, sayForFiles);
    showRset(images.add(loaded));
    // Opening a link: back to its `#view=` before the fit to the image is drawn, so the view doesn't jump after.
    if (linkedView) bookmarks.applyHash(linkedView);
    status.sayForFiles(rule ? `${loaded.name} を表示（設定「${rule.label}」を適用）` : `${loaded.name} を表示`, 'done');
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
    status.sayForFiles(`${name} の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
  openFiles: (files, options) => openFiles(files, { ...fileContext(), ...options }),
  serviceContext,
  say,
  beginStatus: (total, label) => status.begin(total, label),
  remember: (handles) => void recent?.remember(handles),
  onChange: updateLink,
  globeState: () => globeToggle.state(),
  restoreGlobe: (state) => globeToggle.restore(state),
  isDem: (layer) => layer.type === 'image' && geometry.isGeoTiffDem(layer),
  useAsDem: (layer) => (layer.type === 'image' ? geometry.useAsDem(layer) : Promise.resolve(false)),
  layerTime: { get: (l) => timeline.layerState(l), set: (l, saved) => timeline.setLayerState(l, saved) },
  bookmarks: { get: () => bookmarks.get(), merge: (list) => bookmarks.merge(list) },
  scripts: { get: (): SavedScript[] => scripts.savedScripts(), add: (list: SavedScript[]): void => scripts.addSaved(list) },
  elevationServices: {
    get: () => geometry.elevationServiceRefs().map((s) => s.url),
    add: async (urls) => {
      for (const url of urls) await geometry.addElevationService(url, undefined, true);
    },
  },
  notes: { get: () => annotations.get(), set: (saved) => annotations.set(saved) },
  georef: { get: (layer) => originOf(layer.source)?.georef ?? null, apply: (layer, saved) => placeLayer(layer, saved) },
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
// ArcGIS Web Maps: opened from a portal or a JSON file, saved as JSON or to a portal.
const webMaps = new WebMapDialogs({
  map,
  images,
  baseMap,
  baseMaps: config.baseMaps,
  tempStore,
  bookmarks: { get: () => bookmarks.get(), merge: (list) => bookmarks.merge(list) },
  context: serviceContext,
  say,
  name: () => project.name(),
  onChange: updateLink,
});
document.getElementById('webmap-open')!.addEventListener('click', () => webMaps.open());
document.getElementById('webmap-save')!.addEventListener('click', () => webMaps.openSave());
document.getElementById('project-qgis-open')!.addEventListener('click', () => void project.chooseQgis());
document.getElementById('project-qgis-export')!.addEventListener('click', () => project.exportQgis());
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
  sources: dataSources,
  onPipeline: (p) => enhance.setPipeline(p),
  open: (file) => openImageFile(file, fileContext()),
});

// Coloring one-band images, and RGB composites of them (from the processing dialog): two dates in red and cyan show what changed.
const timeOfImage = async (image: ViewerImage) => (await imageTime(image))?.time ?? null;
const colorize = new ColorizeDialog(images, { say, timeOf: timeOfImage, onChange: () => updateLink() });
// The legend of images shown in color classes, on the map.
const classLegend = new ClassLegend(map, images);
// Band math (from the processing dialog): NDVI and other indices by name, or any expression over the bands.
const bandMath = new BandMathDialog(images, loader, { say, sources: dataSources, open: (file) => openImageFile(file, fileContext()) });
// Change detection (from the processing dialog): two dates compared, and what changed outlined as a temporary layer.
const change = new ChangeDialog(images, loader, {
  say,
  sources: dataSources,
  timeOf: (image) => timeOfImage(image),
  open: (file) => openImageFile(file, fileContext()),
  onPolygons: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
});
// Land cover classification (from the processing dialog): k-means, or training polygons by an attribute; classes in colors, areas, outlines.
const classify = new ClassifyDialog(images, loader, map, {
  say,
  sources: dataSources,
  open: (file) => openImageFile(file, fileContext()),
  onPolygons: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
});
// Automatic alignment (from the processing dialog): an image lined up with a reference by matching their texture.
const align = new AlignDialog(images, loader, { say, sources: dataSources, open: (file) => openImageFile(file, fileContext()) });
// Which pixels of an image are transparent: the file's no-data value and the usual fill values, the black collar, values typed.
const noData = new NoDataDialog(images, { say });
// Projections for images without one (pictures, scans, TIFFs without a CRS): world files, extents, corners; saved in projects.
const georef = new GeorefDialog(images, { say, apply: (image, placement) => placeLayer(image, placement) });

/** Shows `image` placed by `placement` (null: without a projection), on a new source with its settings. */
async function placeLayer(image: ViewerImage, placement: Georef | null): Promise<void> {
  await placeImage(image.source, placement, fileContext(), (source) => images.replaceSource(image, source));
  images.setKind(image, placement ? 'geotiff' : 'image');
  showRset(image);
  if (placement) await images.zoomTo(image);
  // The panels follow what it now is.
  if (images.selectedLayer() === image) {
    images.select(null);
    images.select(image);
  }
  updateLink();
}
const composite = new CompositeDialog(images, loader, {
  say,
  sources: dataSources,
  timeOf: timeOfImage,
  open: (file) => openImageFile(file, fileContext()),
});
// Mosaics (from the processing dialog): neighbouring scenes joined into one, the first in priority order on top.
const mosaic = new MosaicDialog(images, loader, {
  say,
  sources: dataSources,
  timeOf: timeOfImage,
  open: (file) => openImageFile(file, fileContext()),
});
// Every image tool's dialog now exists: each gets the processing dialog's 処理 choice, to change tools from there.
processing.addSwitchers();

// Image catalogs (config.json's imageCatalogs): search by date, sensor and angle, open the images found:
// COGs by URL, local paths through pathMappings (a URL, or a folder allowed in the browser).
/** What the catalog said of the images opened from it, for the information panel. */
const fromCatalog = new WeakMap<ViewerImage, Array<[string, string]>>();
/** The catalog ids of images opened from a catalog (written on what the AI tools find in them). */
const catalogIds = new WeakMap<ViewerImage, string>();
/** The catalog records of images opened from a catalog (for 「類似画像の検索」). */
const catalogRecords = new WeakMap<ViewerImage, { record: CatalogRecord; catalog: CatalogConfig }>();
const localPaths = new LocalPaths(config.pathMappings, { ask: askDialog() });
/** Notes what the catalog says of an image opened from it; its angles start the simple orthorectification. */
const openedFromCatalog = (image: ViewerImage, record: CatalogRecord, catalog: CatalogConfig) => {
  fromCatalog.set(image, catalogInfo(record, catalog));
  if (record.id) catalogIds.set(image, record.id);
  catalogRecords.set(image, { record, catalog });
  const view = sensorViewOf(record, catalog);
  if (view) geometry.suggestView(image.source, view);
  if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
};
const openCatalogUrl = async (url: string, record: CatalogRecord, catalog: CatalogConfig) => {
  const image = images.find(await loader.loadUrl(url));
  if (image) openedFromCatalog(image, record, catalog);
};
const openCatalogPath = config.pathMappings.length
  ? async (path: string, record: CatalogRecord, catalog: CatalogConfig): Promise<boolean> => {
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
  : undefined;
const catalogPanel = new CatalogPanel(document.getElementById('catalog-open') as HTMLButtonElement, map, config.imageCatalogs, {
  say,
  openUrl: openCatalogUrl,
  openPath: openCatalogPath,
  forgetFolders: config.pathMappings.some((m) => m.url === undefined) ? () => localPaths.forget() : undefined,
  watch: (catalog, types, conditions, point) => watchPanel.create(catalog, types, conditions, point),
});
// Watches of the catalogs: new images matching saved conditions, counted on the app's badge and listed in 「通知」.
const watchPanel = new WatchPanel(document.getElementById('watch-open') as HTMLButtonElement, map, {
  catalogs: config.imageCatalogs,
  interval: config.watchInterval,
  ask: (url, params, token) => esriJson(url, params, token, true),
  open: async (record, catalog) => {
    const source = record.source!;
    if (source.kind === 'url') await openCatalogUrl(source.url, record, catalog);
    else if (openCatalogPath) await openCatalogPath(source.path, record, catalog);
    else throw new Error('ローカルパスの画像は表示不可');
  },
  selected: () => selection.features.getArray(),
  registration: async () => ('serviceWorker' in navigator ? ((await navigator.serviceWorker.getRegistration()) ?? null) : null),
  say,
});

// STAC search (config.json's stacCatalogs, Earth Search by default): scenes by area, dates and cloud cover, opened as COGs.
// Band assets (red, green, blue) open as layers and go into the RGB composite dialog, ready to run.
const stac = new StacPanel(document.getElementById('stac-open') as HTMLButtonElement, map, config.stacCatalogs, {
  say,
  open: async (assets, item, catalog, rgb) => {
    const opened: ViewerImage[] = [];
    for (const { url, asset } of assets) {
      const image = images.find(await loader.loadUrl(url));
      if (!image) continue;
      fromCatalog.set(image, stacInfo(item, catalog, [asset], timeText));
      catalogIds.set(image, item.id);
      images.setBadge(image, asset.commonName || asset.key);
      if (images.selectedLayer() === image) void showInfo(info, image, layerInfo(image));
      opened.push(image);
    }
    if (rgb && opened.length === 3) await composite.open(opened);
  },
});

// Imaging plans (config.json's satelliteCatalogs, or pasted TLEs): when the satellites can next image a layer's features.
const imagingPlan = new ImagingPlanPanel(document.getElementById('plan-open') as HTMLButtonElement, map, config.satelliteCatalogs, {
  sensorCatalogs: config.sensorCatalogs,
  shipTrack: (id): Track | null => {
    for (const feed of moving.feeds() as MovingLayer[]) {
      const track = feed.store.tracks.get(id.slice('moving:'.length));
      if (track) return track;
    }
    return null;
  },
  layers: () => images.layers(),
  selection,
  say,
  onLayer: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
    say(`${made} をレイヤーとして追加`);
  },
  // In 3D the chosen pass stands up: its orbit, the satellite and its beam.
  onChosen: (): void => globeToggle.globe()?.updateSatellites(),
  view3d: (right): boolean => (globeToggle.isOpen() ? (globeToggle.globe()?.viewSatellite(right) ?? false) : false),
  cloudForecast: config.cloudForecast,
  stations: config.groundStations,
  planStores: config.planStores,
  storeAsk: (url, params, token) => esriJson(url, params, token, true),
  openSaved: (planId) => void savedPlans.open(planId),
});

// Moving targets from any layer of position reports: predicted places and their imaging plan.
const movingTargets = new MovingTargetDialog(document.getElementById('moving-target-open') as HTMLButtonElement, selection, {
  layers: () => images.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector && !l.service.tableOnly),
  feedTracks: (layer): Track[] | null => {
    const feed = (moving.feeds() as MovingLayer[]).find((m) => m.layer === layer.service.layer);
    return feed ? [...feed.store.tracks.values()] : null;
  },
  onResult: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
  },
  plan: (targets, label) => void imagingPlan.planMoving(targets, label),
  say,
});

// Imaging plans kept in Esri feature services (config.json's planStores), followed up in the image catalog.
const savedPlans = new SavedPlansPanel(map, {
  stores: config.planStores,
  catalogs: config.imageCatalogs,
  ask: (url, params, token) => esriJson(url, params, token, true),
  open: async (record, catalog) => {
    const source = record.source;
    if (!source) throw new Error('画像の場所なし');
    if (source.kind === 'url') await openCatalogUrl(source.url, record, catalog);
    else if (openCatalogPath) await openCatalogPath(source.path, record, catalog);
    else throw new Error('ローカルパスの画像は表示不可');
  },
  say,
});

// Observations (観測記録): when, where, what thing and what it is doing, image by image, and each thing's flow over time.
// Kept in Esri point layers (config.json's observationStores), else in the browser.
const observationStores: ObservationStore[] = [
  ...config.observationStores.map((c) => new EsriObservationStore(c, (url, params, token) => esriJson(url, params, token, true))),
  new LocalObservationStore(),
];
const taxonomyStores = new WeakMap<ObservationStore, TaxonomyStore>();
const observations = new ObservationPanel(map, document.getElementById('observe-open') as HTMLButtonElement, {
  stores: observationStores,
  vocabulary: (store) => {
    const own = config.observationStores.find((c) => c.label === store.label);
    return { kinds: own?.kinds ?? config.observationVocabulary.kinds, activities: own?.activities ?? config.observationVocabulary.activities, taxonomy: own?.taxonomy ?? config.observationVocabulary.taxonomy };
  },
  // A store's classification in its own Esri table when given (shared), else in this browser.
  taxonomyStore: (store) => {
    let kept = taxonomyStores.get(store);
    if (!kept) {
      const table = config.observationStores.find((c) => c.label === store.label)?.taxonomyTable;
      kept = table ? new EsriTaxonomyStore(table, (url, params, token) => esriJson(url, params, token, true), `${store.label}の分類テーブル`) : new LocalTaxonomyStore(store.label);
      taxonomyStores.set(store, kept);
    }
    return kept;
  },
  images: () => images.list(),
  selected: () => images.selected(),
  select: (image) => images.select(image),
  isVisible: (image) => images.isVisible(image),
  setVisible: (image, visible) => images.setVisible(image, visible),
  imageInfo: async (image) => {
    const view = await image.source.getView().catch(() => null);
    const box = view?.extent ? (transformExtent(view.extent, view.projection ?? 'EPSG:4326', 'EPSG:4326') as [number, number, number, number]) : null;
    const name = shortName(image.name);
    return { id: catalogIds.get(image) ?? name, name, time: (await imageTime(image))?.time ?? null, box: image.kind === 'geotiff' ? box : null };
  },
  onStart: () => {
    points.setAdding(false);
    measure.setMode(null);
    aiSegment.setActive(false);
    annotations.setActive(false);
    shadowHeight.setActive(false);
  },
  onLayer: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
    say(`${made} をレイヤーとして追加`);
  },
  say,
});
imagesChanged = () => {
  if (observations.dialog.open) void observations.refreshImages();
};

// Reminders of planned shots become notices of the notification centre a set time before them.
startReminders((n) => say(`撮像予定の通知 ${n} 件（「通知」）`));

// Satellite passes: the chosen satellites' ground tracks and what they can image, at a moment or over a period.
const satelliteTracks = new SatelliteTrackPanel(document.getElementById('track-open') as HTMLButtonElement, map, {
  satellites: () => imagingPlan.catalogSatellites(),
  say,
  onLayer: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    images.addService(tempLayer(record, tempStore));
    say(`${made} をレイヤーとして追加`);
  },
  onChange: (): void => globeToggle.globe()?.updateTracks(),
});

// Scripts (like arcpy): JavaScript run apart from the page, reaching the viewer only through its script functions.
/** Menu buttons a script may press (viewer.command): ones that open a panel or a tool, not ones that save or open files. */
const SCRIPT_COMMANDS = ['catalog-open', 'globe-toggle', 'add-service', 'measure-distance', 'measure-area', 'measure-clear', 'add-point', 'new-layer', 'processing', 'ai-detect', 'ai-segment', 'timeline-open', 'dashboard-open', 'plan-open', 'track-open', 'annotate', 'save-view', 'print', 'metadata-open', 'swipe', 'split', 'histogram-open', 'moving-open', 'stac-open'];
const scripts = new ScriptDialog(document.getElementById('script-open') as HTMLButtonElement, {
  map,
  layers: () => images.layers(),
  selectedLayer: () => images.selectedLayer(),
  selectLayer: (layer) => images.select(layer),
  zoomTo: (layer) => images.zoomTo(layer),
  selection,
  editor,
  say,
  addTempLayer: async (result, made) => {
    const record = recordOf(result, made);
    await tempStore.put(record).catch((error) => say(`ブラウザへの保存に失敗（このページを開いている間のみ保持）: ${error instanceof Error ? error.message : String(error)}`));
    return images.addService(tempLayer(record, tempStore));
  },
  openRaster: async (file) => {
    const source = await openImageFile(file, fileContext());
    return source ? (images.find(source) ?? null) : null;
  },
  satellites: () => imagingPlan.catalogSatellites(),
  // Everything else a script may do (src/script/automation.ts); the objects are made below, used only once a script runs.
  list: images,
  setCorrection: (layer, pipeline) => {
    const target = layer.type === 'image' ? layer.source : layer.service.correction;
    target?.setPipeline(pipeline);
    if (images.selectedLayer() === layer) enhance.setPipeline(pipeline);
  },
  setNoData: (image, value) => noData.set(image, value),
  setColorScale: (image, scale, blend) => colorize.set(image, scale, blend),
  baseMaps: () => config.baseMaps,
  baseMap: () => baseMap.get(),
  setBaseMap: (id) => baseMap.set(id),
  bookmarks: () => bookmarks,
  timeline: () => timeline,
  split: () => split,
  swipe: () => swipe,
  globe: async (open) => {
    await globeToggle.toggle(open);
    return globeToggle.isOpen();
  },
  setTheme: (theme) => document.querySelector<HTMLButtonElement>(`[data-theme-choice="${theme}"]`)?.click(),
  tools: () => [
    ...processingTools.map((t) => ({ id: t.id, label: t.label, dialog: processing.dialog, open: () => processing.open(t.id), run: () => processing.run() })),
    { id: 'band-math', label: 'バンド演算・指標（NDVI など）', dialog: bandMath.dialog, open: () => bandMath.open(), run: () => bandMath.run() },
    { id: 'change', label: '変化抽出（2 時期の差・比）', dialog: change.dialog, open: () => change.open(), run: () => change.run() },
    { id: 'classify', label: '土地被覆分類（自動・学習ポリゴン）', dialog: classify.dialog, open: () => classify.open(), run: () => classify.run() },
    { id: 'align', label: '自動位置合わせ（基準画像への位置合わせ）', dialog: align.dialog, open: () => align.open(), run: () => align.run() },
    { id: 'composite', label: 'RGB 合成（単バンド画像を R・G・B に）', dialog: composite.dialog, open: () => composite.open(), run: () => composite.run() },
    { id: 'mosaic', label: 'モザイク（複数画像の接合）', dialog: mosaic.dialog, open: () => mosaic.open(), run: () => mosaic.run() },
    { id: 'pansharpen', label: 'パンシャープン', dialog: panSharpen.dialog, open: () => panSharpen.open(), run: () => panSharpen.run() },
    { id: 'save-view', label: '表示範囲を保存（画像・GeoTIFF）', dialog: viewExport.dialog, open: () => viewExport.open(), run: () => viewExport.save() },
    { id: 'moving-match', label: 'AI 検出と照合（移動体）', dialog: movingMatch.dialog, open: () => movingMatch.open(), run: () => movingMatch.run() },
    { id: 'stac', label: 'STAC 検索', dialog: stac.dialog, open: () => stac.open(), run: () => stac.search() },
    { id: 'gp', label: 'サーバ処理（ArcGIS GP・OGC API – Processes）', dialog: gp.dialog, open: () => gp.open(), run: () => gp.run() },
    { id: 'webmap-open', label: 'ArcGIS Web マップを開く', dialog: webMaps.openDialog, open: () => webMaps.open(), run: () => webMaps.openTyped() },
    { id: 'tessellate', label: '格子の敷き詰め（正方形・六角形・三角形）', dialog: tessellateDialog.dialog, open: () => tessellateDialog.open(), run: () => tessellateDialog.run() },
    { id: 'moving-target', label: '移動目標撮像計画（存在予測・撮像計画）', dialog: movingTargets.dialog, open: () => movingTargets.open(), run: async () => movingTargets.plan() },
  ],
  commands: () =>
    SCRIPT_COMMANDS.flatMap((id) => {
      const button = document.getElementById(id) as HTMLButtonElement | null;
      return button && !button.hidden && !button.disabled ? [{ id, label: button.textContent?.trim() ?? id, press: () => button.click() }] : [];
    }),
  open: async (layer) => {
    if (layer.type === 'cog') {
      if (!(await openEsriUrl(layer.url))) await loader.loadUrl(layer.url);
    } else if (layer.type === 'file') await project.openFiles([await fetchFile(layer.url)], layer.url);
    else {
      const { type: kind, ...ref } = layer;
      const opened = await openRef({ kind, ...ref }, serviceContext());
      if (opened) addService(opened);
    }
  },
  serviceChoices: async (url, kind) => (await readService(url, kind)).choices,
  knownHosts: () => {
    const urls = [...config.layers.map((l) => l.url), ...config.baseMaps.map((b) => b.url), ...images.layers().map((l) => (l.type === 'service' ? l.service.ref?.url : undefined))];
    return urls.flatMap((u) => {
      try {
        return u ? [new URL(u, location.href).origin] : [];
      } catch {
        return [];
      }
    });
  },
  openFiles: (files) => project.openFiles(files),
});

/** What opening files needs: where they go, and how RSETs being made are shown. */
/** Which RSET to make first: images on the map in view, then the others, top of the list first; null once closed. */
function rsetRank(source: EnhancedGeoTIFF): number | null {
  const image = images.find(source);
  if (!image) return null;
  const order = images.layers().indexOf(image);
  const view = map.getView();
  const size = map.getSize();
  const grid = source.getTileGrid();
  const projection = source.getProjection();
  if (!size || !grid || !projection || !image.layer.getVisible()) return 100_000 + order;
  try {
    const extent = transformExtent(grid.getExtent(), projection, view.getProjection());
    return intersects(extent, view.calculateExtent(size)) ? order : 100_000 + order;
  } catch {
    return 100_000 + order;
  }
}

function fileContext(): OpenFilesContext {
  return {
    loader,
    addLayer: addService,
    say: sayForFiles,
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
    askGeoref: (source, side) => georef.openFor(source, side),
    rsetRank: (source) => rsetRank(source),
    // A TIFF without a projection is shown where pictures go, and marked as one.
    onUnplaced: (source) => {
      const image = images.find(source);
      if (!image || image.kind === 'image') return;
      images.setKind(image, 'image');
      if (images.selectedLayer() === image) {
        images.select(null);
        images.select(image);
      }
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
  const origin = originOf(layer.source);
  const placed: Array<[string, string]> = origin?.georef ? [['投影の設定', describeGeoref(origin.georef)]] : origin?.unplaced ? [['投影', 'なし（レイヤーの ⌖ で設定）']] : [];
  return [...(fromCatalog.get(layer) ?? []), ...fileInfoOf(layer.source), ...placed, ['RSET', rsetText(rsetOf(layer.source))], ...geometryInfo(layer)];
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
const twoDOnly = ['add-point', 'shadow-height', 'swipe', 'split', 'histogram-open', 'spectral-open'].map((id) => document.getElementById(id) as HTMLButtonElement);
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
    satelliteTracks: () => satelliteTracks.tracks3d(),
  },
  onToggle: (open) => {
    // The satellite tracks stand up in 3D on their own; draped on the globe too they would show twice.
    satelliteTracks.overlay.setVisible(!open);
    if (open) {
      measure.setMode(null);
      shadowHeight.setActive(false);
      points.setAdding(false);
      if (swipe.isActive()) swipe.setActive(false);
      if (split.getCount() > 1) split.setCount(1);
      if (histogramPanel.isOpen()) histogramPanel.setOpen(false);
      if (spectral.isOpen()) spectral.setOpen(false);
    }
    for (const b of twoDOnly) {
      b.disabled = open;
      if (open) b.dataset.title2d ??= b.title;
      b.title = open ? '3D 表示では使用不可（「3D」で 2D に復帰）' : (b.dataset.title2d ?? b.title);
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
  say(`${url} を読み込み中…`);
  try {
    const catalog = await readService(url, 'esri');
    const choice = catalog.choices.find((c) => c.name === IMAGE_CHOICE || c.name === MAP_CHOICE)!;
    const layer = await catalog.open(choice, serviceContext());
    if (layer) addService(layer);
  } catch (error) {
    say(`${url} の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}（トークンが必要なサービスは「サービスを追加」から）`);
    throw error;
  }
  return true;
}

/** Opens one layer at start, giving the service layer's ref; failures are reported in the status line and the rest still open. */
async function openAtStart(layer: LayerConfig): Promise<ServiceRef | undefined> {
  say(`${layer.url} を読み込み中…`);
  try {
    if (layer.type === 'cog') {
      if (!(await openEsriUrl(layer.url).catch(() => true))) await loader.loadUrl(layer.url);
    }
    else if (layer.type === 'file') await project.openFiles([await fetchFile(layer.url)], layer.url);
    else {
      const { type: kind, ...ref } = layer;
      const opened = await openRef({ kind, ...ref }, serviceContext());
      if (opened) addService(opened);
      return opened?.ref ?? undefined;
    }
  } catch (error) {
    // The loader's onError has already said why a COG failed.
    if (layer.type !== 'cog') say(`${layer.url} の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

// A link's `#view=` wins over where the layers opening at start would zoom to.
let linkedView: string | null = location.hash || null;
const started = (async () => {
  // A shared link (and the address kept over a reload) lists the service layers in config.json too: open those once.
  // They are known both as written in config.json and as opened, since opening fills in what the entry left out
  // (a WMTS matrix set and format, the service's own URL), and an address with them several times opens them once.
  const fromConfig = new Set<string>();
  for (const layer of config.layers) {
    const opened = await openAtStart(layer);
    if (layer.type !== 'cog' && layer.type !== 'file') fromConfig.add(refKey({ ...layer, kind: layer.type }));
    if (opened) fromConfig.add(refKey(opened));
  }
  const opening: LayerConfig[] = [];
  for (const url of start.getAll('url')) opening.push({ type: 'cog', url });
  for (const ref of start.getAll('service').map(paramToRef)) {
    if (ref && !fromConfig.has(refKey(ref))) opening.push({ type: ref.kind, url: ref.url, layer: ref.layer, matrixSet: ref.matrixSet, format: ref.format, settings: ref.settings, bbox: ref.bbox, filter: ref.filter });
  }
  for (const layer of opening) await openAtStart(layer);
  // Elevation services of config.json, ready for orthorectification and 3D.
  for (const service of config.elevationServices) await geometry.addElevationService(service.url, service.token, true);
  // The temporary layers of earlier visits, on top.
  const kept = await tempStore.list().catch(() => []);
  for (const record of kept) images.addService(tempLayer(record, tempStore));
  if (kept.length) say(`一時レイヤー ${kept.length} 件を復元`);
  // Shapes given in the link, on top of all; made into a layer once (a reload restores it), so they leave the address.
  const shapeParams = shapeParamsOf(location.search);
  if (hasShapes(shapeParams)) {
    await addLinkShapes(shapeParams, !linkedView);
    history.replaceState(history.state, '', `${location.pathname}${withoutShapes(location.search)}${location.hash}`);
  }
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
}, (url) => {
  // A link opened while the app is open (the manifest's launch_handler): its shapes join what is shown.
  const target = new URL(url);
  void started.then(() => addLinkShapes(shapeParamsOf(target.search), true));
});
void registerServiceWorker();

// Embedding (config.json's `embed`): pages of the allowed origins show the viewer in an iframe and drive it by postMessage.
const embed: EmbedApi | null = config.embed.allowedOrigins.length
  ? new EmbedApi(config.embed, { map, selection, handlers: (adapt) => scripts.handlers(adapt), addShapes: addLinkShapes, layerId, ready: started })
  : null;
// The clipboard and sharing: Ctrl+V (or the menu) pastes GeoJSON, WKT, KML, coordinates and tables from Excel as the
// temporary layer 「貼り付け」 and pictures as pictures; Ctrl+C copies the selected features as GeoJSON; 「共有…」 shares
// the view's link; and what other apps share to the installed app (manifest share_target, sw.js) opens.
const clipboard = new ClipboardTools(map, {
  images,
  selection,
  tempStore,
  say,
  openFiles: (files) => project.openFiles(files),
  openUrl: async (url) => {
    if (!(await openEsriUrl(url))) await loader.loadUrl(url);
  },
  in3d: () => globeToggle.isOpen(),
  updateHash: () => bookmarks.updateHash(),
  buttons: { paste: document.getElementById('clip-paste') as HTMLButtonElement, copyView: document.getElementById('clip-copy-view') as HTMLButtonElement, share: document.getElementById('clip-share') as HTMLButtonElement },
});
void clipboard.takeSharedFromAddress(started);

// For the browser test and the console.
declare global {
  interface Window {
    viewer: {
      map: Map;
      images: ImageList;
      points: PointTool;
      measure: MeasureTool;
      shadowHeight: ShadowHeightTool;
      loader: LoadImageControl;
      enhance: EnhanceControl;
      onGpu: boolean;
      selection: Selection;
      table: AttributeTable;
      dock: DockLayout;
      pinTable: (layer: ViewerLayer) => void;
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
      zonal: ZonalDialog;
      newLayer: NewLayerDialog;
      tessellate: TessellateDialog;
      panSharpen: PanSharpenDialog;
      colorize: ColorizeDialog;
      classLegend: ClassLegend;
      noData: NoDataDialog;
      georef: GeorefDialog;
      composite: CompositeDialog;
      mosaic: MosaicDialog;
      bandMath: BandMathDialog;
      change: ChangeDialog;
      classify: ClassifyDialog;
      align: AlignDialog;
      annotations: Annotations;
      print: PrintDialog;
      aiDetect: DetectDialog;
      aiSegment: SegmentTool;
      aiTransfer: TransferDialog;
      toolMenu: ToolMenu;
      guide: Guide;
      help: HelpDialog;
      hints: Hints;
      swipe: SwipeTool;
      split: SplitView;
      histogram: HistogramPanel;
      spectral: SpectralPanel;
      viewExport: ViewExportDialog;
      project: ProjectControl;
      rset: typeof rsetSettings;
      globe: GlobeToggle;
      catalog: CatalogPanel;
      watch: WatchPanel;
      timeline: Timeline;
      dashboard: Dashboard;
      imagingPlan: ImagingPlanPanel;
      savedPlans: SavedPlansPanel;
      observations: ObservationPanel;
      movingTargets: MovingTargetDialog;
      satelliteTracks: SatelliteTrackPanel;
      scripts: ScriptDialog;
      rasterRules: RasterRulesDialog;
      bookmarks: Bookmarks;
      signIn: SignInMenu;
      moving: MovingDialog;
      movingMatch: MatchDialog;
      stac: StacPanel;
      webMaps: WebMapDialogs;
    };
  }
}
window.viewer = { map, images, points, measure, shadowHeight, loader, enhance, onGpu, selection, table, dock, pinTable, editor, exporter, styler, metadata, boxSelect, baseMap, config, addDialog, coordinateMenu, jump, geometry, recent, processing, zonal, newLayer, tessellate: tessellateDialog, panSharpen, colorize, classLegend, noData, georef, composite, mosaic, bandMath, change, classify, align, annotations, print: printDialog, aiDetect, aiSegment, aiTransfer, toolMenu, guide, help, hints, swipe, split, histogram: histogramPanel, spectral, viewExport, project, rset: rsetSettings, globe: globeToggle, catalog: catalogPanel, watch: watchPanel, timeline, dashboard, imagingPlan, savedPlans, observations, movingTargets, satelliteTracks, scripts, rasterRules, bookmarks, signIn, moving, movingMatch, stac, webMaps };
