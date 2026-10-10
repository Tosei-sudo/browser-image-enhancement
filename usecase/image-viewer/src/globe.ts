/**
 * The 3D view (立体表示): a CesiumJS globe on the WGS 84 ellipsoid, loaded
 * only when it is first opened. It shows
 *
 * - every 2D layer as the 2D map draws it, draped over the ground
 *   (globe-tiles.ts: corrections, styles, labels, base maps…);
 * - the relief of the DEMs that are open (DTED, heights above mean sea level
 *   plus the EGM96 geoid), with a vertical exaggeration;
 * - the relief of GeoTIFF DEMs used as elevation data (geometric.ts);
 * - 3D Tiles tilesets by URL, or from a folder (local-tiles.ts);
 * - multipatch layers (multipatch.ts) as solid shapes;
 * - the viewshed from a clicked point (viewshed.ts), as a layer of the map,
 *   with buildings (multipatches, 3D Tiles) in the way if wished;
 * - measuring distances (with a profile and the line of sight) and areas on
 *   whatever is drawn (globe-measure.ts);
 * - a picture of the view (PNG), and its state for project files.
 *
 * Everything CesiumJS needs at run time is part of the site (vite.config.ts),
 * so the view works without a network.
 */
import '@cesium/engine/Source/Widget/CesiumWidget.css';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Event as CesiumEvent,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  Math as CesiumMath,
  PerspectiveFrustum,
  PrimitiveType,
  Rectangle,
} from '@cesium/core';
import {
  buildModuleUrl,
  Cesium3DTileset,
  CesiumWidget,
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  HeightReference,
  ImageryLayer,
  LabelStyle,
  PerInstanceColorAppearance,
  Primitive,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  VerticalOrigin,
  WebMercatorTilingScheme,
  type Entity,
  type ImageryProvider,
  type TerrainProvider,
} from '@cesium/engine';
import type OlMap from 'ol/Map.js';
import type Feature from 'ol/Feature.js';
import type { Extent } from 'ol/extent.js';
import { buffer } from 'ol/extent.js';
import { fromLonLat, transformExtent } from 'ol/proj.js';
import type { AnimationOptions } from 'ol/View.js';
import ImageLayer from 'ol/layer/Image.js';
import LayerGroup from 'ol/layer/Group.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Static from 'ol/source/ImageStatic.js';
import OlFeature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import { dataExtent, layerSignature, MapTileRenderer, tileHasData, type DataExtent } from './globe-tiles.js';
import { coversAny, elevationAt, geoidHeight, loadGeoid, type GeoidGrid } from './dem.js';
import type { Dted } from './dted.js';
import { heightRange, multiPatchOf, trianglesOf, type MultiPatch } from './multipatch.js';
import { gridAround, raiseByTriangles, runViewshed, viewshedPixels, visibleArea, type ViewshedGrid, type ViewshedOptions } from './viewshed.js';
import { GlobeMeasure, type GlobeMeasureMode, type MeasureResult } from './globe-measure.js';
import { drawProfile, profileCsv } from './profile-chart.js';
import { isLocalTiles, serveFolder } from './local-tiles.js';
import type { ImageList, ViewerService } from './images.js';
import type { Selection } from './selection.js';

/** What the 3D view uses of the viewer. */
export interface GlobeContext {
  map: OlMap;
  images: ImageList;
  selection: Selection;
  /** The DEM cells open now. */
  cells: () => Dted[];
  /** Shows a feature picked in 3D in the attribute table. */
  showFeature: (layer: ViewerService, feature: Feature) => void;
  say: (message: string) => void;
  /** Called when measuring starts or stops. */
  onMeasure?: (mode: 'distance' | 'area' | null) => void;
}

/** A camera position: degrees, metres above the ellipsoid, heading and pitch in degrees. */
export interface CameraPlace {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
}

/** How multipatch heights are placed. */
export type HeightMode = 'auto' | 'orthometric' | 'ground' | 'ellipsoid';

/** What a project file keeps of the 3D view. */
export interface GlobeState {
  /** Whether the 3D view was open. */
  open: boolean;
  camera: CameraPlace;
  terrain: boolean;
  exaggeration: number;
  heightMode: HeightMode;
  natural: boolean;
  /** 3D Tiles by URL (folders on the computer are not kept). */
  tilesets: Array<{ url: string; show: boolean }>;
}

const WEB_MERCATOR_HALF = 20037508.342789244;
/** Tiles of the 2D map are drawn in 2 × 2 blocks: one draw for four tiles. */
const BLOCK = 2;
const TILE = 256;
/** Tiles asked for beyond this many waiting are put off, so the ones in view now come first. */
const MAX_WAITING = 8;

/** The globe's tiles of the 2D map (Web Mercator, as OpenLayers draws). */
class MapImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly rectangle = this.tilingScheme.rectangle;
  readonly tileWidth = TILE;
  readonly tileHeight = TILE;
  readonly minimumLevel = 0;
  readonly maximumLevel = 22;
  readonly tileDiscardPolicy = undefined;
  readonly errorEvent = new CesiumEvent();
  readonly credit = undefined;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  private readonly blocks_ = new Map<string, Promise<HTMLCanvasElement>>();
  private waiting_ = 0;
  private disposed_ = false;

  constructor(
    private readonly renderer: MapTileRenderer,
    private readonly data: DataExtent,
    private readonly onTile: () => void,
  ) {}

  getTileCredits(): [] {
    return [];
  }

  pickFeatures(): undefined {
    return undefined;
  }

  dispose(): void {
    this.disposed_ = true;
    this.blocks_.clear();
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> | undefined {
    const extent = tileExtent(x, y, level);
    if (!tileHasData(this.data, buffer(extent, (extent[2] - extent[0]) * 0.1))) return Promise.resolve(emptyTile());
    const n = level === 0 ? 1 : BLOCK;
    const bx = x - (x % n);
    const by = y - (y % n);
    // Replaced by a newer drawing of the map: nothing more is drawn here, the tiles it has stay until it goes.
    if (this.disposed_) return Promise.resolve(emptyTile());
    const key = `${level}/${bx}/${by}`;
    let block = this.blocks_.get(key);
    if (!block) {
      if (this.waiting_ >= MAX_WAITING) return undefined;
      const first = tileExtent(bx, by, level);
      const size = first[2] - first[0];
      const blockExtent: Extent = [first[0], first[3] - size * n, first[0] + size * n, first[3]];
      this.waiting_++;
      block = this.renderer.render(blockExtent, TILE * n, TILE * n).finally(() => {
        this.waiting_--;
        this.onTile();
      });
      this.blocks_.set(key, block);
      // The block is kept for its other tiles a while, not for ever.
      if (this.blocks_.size > 64) this.blocks_.delete(this.blocks_.keys().next().value!);
    }
    return block.then((canvas) => {
      if (n === 1) return canvas;
      const w = canvas.width / n;
      const h = canvas.height / n;
      const tile = document.createElement('canvas');
      tile.width = w;
      tile.height = h;
      tile.getContext('2d')!.drawImage(canvas, (x - bx) * w, (y - by) * h, w, h, 0, 0, w, h);
      return tile;
    });
  }
}

let empty: HTMLCanvasElement | null = null;
function emptyTile(): HTMLCanvasElement {
  if (!empty) {
    empty = document.createElement('canvas');
    empty.width = empty.height = 1;
  }
  return empty;
}

/** A Web Mercator tile's extent (y = 0 at the top, as Cesium counts). */
function tileExtent(x: number, y: number, level: number): Extent {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** level;
  return [-WEB_MERCATOR_HALF + x * size, WEB_MERCATOR_HALF - (y + 1) * size, -WEB_MERCATOR_HALF + (x + 1) * size, WEB_MERCATOR_HALF - y * size];
}

/**
 * Relief from DTED cells: heights above mean sea level plus the geoid (heights
 * above the ellipsoid, as Cesium wants), the geoid alone (mean sea level)
 * where no cell covers.
 */
function demTerrain(cells: readonly Dted[], geoid: GeoidGrid): TerrainProvider {
  const size = 65;
  const scheme = new GeographicTilingScheme();
  return new CustomHeightmapTerrainProvider({
    width: size,
    height: size,
    tilingScheme: scheme,
    callback: (x, y, level) => {
      const r = scheme.tileXYToRectangle(x, y, level);
      const [w, s, e, n] = [r.west, r.south, r.east, r.north].map(CesiumMath.toDegrees);
      const covered = coversAny(cells, [w, s, e, n]);
      const heights = new Float32Array(size * size);
      for (let row = 0; row < size; row++) {
        const lat = n - ((n - s) * row) / (size - 1);
        for (let col = 0; col < size; col++) {
          const lon = w + ((e - w) * col) / (size - 1);
          heights[row * size + col] = (covered ? (elevationAt(cells, lon, lat) ?? 0) : 0) + geoidHeight(geoid, lon, lat);
        }
      }
      return heights;
    },
  });
}

/** One 3D Tiles tileset added by URL or from a folder. */
interface TilesetEntry {
  url: string;
  name: string;
  tileset: Cesium3DTileset;
  row: HTMLLIElement;
}

/** A viewshed shown on the map. */
interface ViewshedEntry {
  group: LayerGroup;
  marker: Entity;
}

export class Globe {
  readonly widget: CesiumWidget;
  private readonly renderer: MapTileRenderer;
  private imagery_: ImageryLayer[] = [];
  private natural_: ImageryLayer | null = null;
  private refreshTimer_ = 0;
  private dropTimer_ = 0;
  /** {@link layerSignature} when the layers were last drawn. */
  private drawn_ = '';
  /** The layers changed while tiles were being drawn. */
  private changedWhileBusy_ = false;
  private open_ = false;
  private cells_: Dted[] = [];
  private terrainOn_ = true;
  private heightMode_: HeightMode = 'auto';
  private patches_: Array<{ primitive: Primitive; ids: Array<{ layer: ViewerService; feature: Feature }> }> = [];
  private patchesKey_ = '';
  private readonly tilesets_: TilesetEntry[] = [];
  private viewshed_: ViewshedEntry | null = null;
  private picking_ = false;
  private geoid_: GeoidGrid | null = null;
  private readonly panel_: GlobePanel;
  private readonly measure_: GlobeMeasure;
  private readonly unwatch_: Array<() => void> = [];

  constructor(
    readonly container: HTMLElement,
    panel: HTMLElement,
    readonly context: GlobeContext,
  ) {
    this.renderer = new MapTileRenderer(context.map);
    // Changes seen while drawing are mostly the drawing's own (images, icons loading): only real ones count.
    this.renderer.onIdle = () => {
      if (!this.changedWhileBusy_) return;
      this.changedWhileBusy_ = false;
      if (layerSignature(context.map) !== this.drawn_) this.scheduleRefresh();
    };
    this.widget = new CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      scene3DOnly: true,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // The canvas can be read back (tests, saving a picture).
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
    });
    const scene = this.widget.scene;
    scene.globe.baseColor = Color.fromCssColorString('#c9d3dc');
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.showGroundAtmosphere = false;
    // The whole Earth from the bundled Natural Earth II, under the layers.
    void TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')).then((provider) => {
      this.natural_ = new ImageryLayer(provider, {});
      this.natural_.show = this.panel_.natural.checked;
      scene.imageryLayers.add(this.natural_, 0);
      scene.requestRender();
    });
    // Clicks: a feature of a multipatch layer, or the observer of a viewshed.
    const handler = new ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((e: { position: Cartesian2 }) => this.click_(e.position), ScreenSpaceEventType.LEFT_CLICK);
    // The 2D map's interactions must not see what happens on the globe.
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click', 'dblclick', 'contextmenu']) {
      container.addEventListener(type, (e) => e.stopPropagation());
    }
    // Its keyboard pan and zoom too; the page's own shortcuts still work.
    container.addEventListener('keydown', (e) => {
      if (/^(Arrow\w+|\+|-|=)$/.test(e.key)) e.stopPropagation();
    });
    this.panel_ = new GlobePanel(panel, this);
    this.measure_ = new GlobeMeasure({
      widget: this.widget,
      groundAt: (lon, lat) => (this.hasRelief() ? elevationAt(this.cells_, lon, lat) : null),
      geoidAt: (lon, lat) => (this.geoid_ ? geoidHeight(this.geoid_, lon, lat) : 0),
      refraction: () => this.panel_.viewshedSettings().refraction,
      onChange: (result) => this.panel_.showMeasure(result),
      say: context.say,
    });
    // Esc clears a measurement, or stops picking the observer.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.open_) return;
      if (this.measure_.result()) this.measure_.clear();
      else if (this.measure_.active()) this.setMeasure(null);
      if (this.picking_) this.setPicking(false);
    });
    scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
      // The newest layer of the 2D map has loaded what is in view: the ones it replaces can go.
      if (queued === 0) this.dropOldImagery_();
      this.panel_.loading(queued);
    });
    context.selection.on('change', () => this.highlight_());
  }

  isOpen(): boolean {
    return this.open_;
  }

  /** Shows the globe where the 2D map was looking. */
  open(): void {
    if (this.open_) return;
    const { map } = this.context;
    const view = map.getView();
    const size = map.getSize();
    const extent = size ? view.calculateExtent(size) : null;
    this.open_ = true;
    this.container.hidden = false;
    this.renderer.begin();
    this.hookView_();
    const group = map.getLayerGroup();
    const key = group.on('change', () => {
      if (this.renderer.busy()) this.changedWhileBusy_ = true;
      else this.scheduleRefresh();
    });
    this.unwatch_.push(() => group.un('change', key.listener));
    this.widget.resize();
    if (extent) this.flyTo(transformExtent(extent, view.getProjection(), 'EPSG:4326'), 0);
    this.refresh();
  }

  /** Back to 2D, looking where the camera looks. */
  async close(): Promise<void> {
    if (!this.open_) return;
    this.open_ = false;
    for (const off of this.unwatch_.splice(0)) off();
    clearTimeout(this.refreshTimer_);
    const at = this.twoDView_();
    for (const layer of this.imagery_.splice(0)) this.removeImagery_(layer);
    this.container.hidden = true;
    this.picking_ = false;
    this.setMeasure(null);
    this.panel_.update();
    await this.renderer.end(at ?? undefined);
  }

  /** Runs `fn` with the 2D map looking where the camera looks (saving a project reads the view). */
  async withTwoDView<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.open_) return fn();
    const at = this.twoDView_();
    await this.renderer.end(at ?? undefined);
    try {
      return await fn();
    } finally {
      if (this.open_) {
        this.renderer.begin();
        this.hookView_();
      }
    }
  }

  /** Redraws the layers of the 2D map soon (they changed). */
  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer_);
    this.refreshTimer_ = window.setTimeout(() => this.refresh(), 400);
  }

  /** Draws the 2D layers again, and brings the relief and multipatches up to date. */
  refresh(): void {
    if (!this.open_) return;
    clearTimeout(this.refreshTimer_);
    const scene = this.widget.scene;
    this.drawn_ = layerSignature(this.context.map);
    const provider = new MapImageryProvider(this.renderer, dataExtent(this.context.map), () => scene.requestRender());
    const layer = new ImageryLayer(provider as unknown as ImageryProvider, {});
    // The older drawings stop drawing, and go once the new one has loaded the view (or after a few seconds).
    for (const old of this.imagery_) (old.imageryProvider as unknown as MapImageryProvider).dispose();
    clearTimeout(this.dropTimer_);
    this.dropTimer_ = window.setTimeout(() => this.dropOldImagery_(), 5000);
    scene.imageryLayers.add(layer);
    this.imagery_.push(layer);
    void this.updateTerrain_();
    this.updatePatches_();
    this.panel_.update();
    scene.requestRender();
  }

  /** Where the camera is: degrees, metres above the ellipsoid, heading and pitch in degrees. */
  getCamera(): CameraPlace {
    const camera = this.widget.camera;
    const c = camera.positionCartographic;
    return {
      lon: CesiumMath.toDegrees(c.longitude),
      lat: CesiumMath.toDegrees(c.latitude),
      height: c.height,
      heading: CesiumMath.toDegrees(camera.heading),
      pitch: CesiumMath.toDegrees(camera.pitch),
    };
  }

  /** Puts the camera at `place`. */
  setCamera(place: CameraPlace): void {
    this.widget.camera.setView({
      destination: Cartesian3.fromDegrees(place.lon, place.lat, place.height),
      orientation: { heading: CesiumMath.toRadians(place.heading), pitch: CesiumMath.toRadians(place.pitch), roll: 0 },
    });
    this.widget.scene.requestRender();
  }

  /** Flies to `[west, south, east, north]` in degrees. */
  flyTo(extent: readonly number[], duration = 0.8): void {
    const [w, s, e, n] = [Math.max(-180, extent[0]), Math.max(-85, extent[1]), Math.min(180, extent[2]), Math.min(85, extent[3])];
    if (!(e > w && n > s)) return;
    const destination = Rectangle.fromDegrees(w, s, e, n);
    if (duration) this.widget.camera.flyTo({ destination, duration });
    else this.widget.camera.setView({ destination });
    this.widget.scene.requestRender();
  }

  // ----- the 2D map ---------------------------------------------------------

  private removeImagery_(layer: ImageryLayer): void {
    (layer.imageryProvider as unknown as MapImageryProvider).dispose?.();
    this.widget.scene.imageryLayers.remove(layer, true);
  }

  private dropOldImagery_(): void {
    while (this.imagery_.length > 1) this.removeImagery_(this.imagery_.shift()!);
  }

  /** "Zoom to the layer", "go to coordinates"… move the camera instead of the hidden 2D view. */
  private hookView_(): void {
    const view = this.context.map.getView();
    const projection = view.getProjection();
    const go = (extent: Extent) => this.flyTo(transformExtent(extent, projection, 'EPSG:4326'));
    const hooked = view as unknown as Record<string, unknown>;
    hooked.fit = (target: Extent | { getExtent(): Extent }) => go(Array.isArray(target) ? target : (target as { getExtent(): Extent }).getExtent());
    hooked.animate = (...args: Array<AnimationOptions | ((complete: boolean) => void)>) => {
      const options = args.find((a): a is AnimationOptions => typeof a === 'object');
      if (!options?.center) return;
      const resolution = options.resolution ?? (options.zoom !== undefined ? view.getResolutionForZoom(options.zoom) : 1);
      const canvas = this.widget.scene.canvas;
      const [hw, hh] = [(canvas.clientWidth * resolution) / 2, (canvas.clientHeight * resolution) / 2];
      go([options.center[0] - hw, options.center[1] - hh, options.center[0] + hw, options.center[1] + hh]);
    };
    this.unwatch_.push(() => {
      delete hooked.fit;
      delete hooked.animate;
    });
  }

  /** Where the camera looks, as a 2D view: the point in the middle of the screen and the scale there. */
  private twoDView_(): { center: number[]; resolution: number } | null {
    const scene = this.widget.scene;
    const camera = this.widget.camera;
    const canvas = scene.canvas;
    const middle = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const ray = camera.getPickRay(middle);
    const hit = ray && scene.globe.pick(ray, scene);
    if (!hit) return null;
    const c = Cartographic.fromCartesian(hit);
    const [lon, lat] = [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
    const distance = Cartesian3.distance(camera.positionWC, hit);
    const fovy = (camera.frustum as PerspectiveFrustum).fovy ?? CesiumMath.toRadians(60);
    const metres = (2 * distance * Math.tan(fovy / 2)) / Math.max(1, canvas.clientHeight);
    const projection = this.context.map.getView().getProjection();
    const center = fromLonLat([lon, lat], projection);
    // Web Mercator stretches by 1 / cos(latitude).
    const resolution = projection.getCode() === 'EPSG:3857' ? metres / Math.cos(c.latitude) : metres / (projection.getMetersPerUnit() ?? 1);
    return { center, resolution };
  }

  // ----- relief ---------------------------------------------------------------

  setTerrain(on: boolean): void {
    this.terrainOn_ = on;
    this.cells_ = [];
    void this.updateTerrain_();
    this.updatePatches_(true);
  }

  terrainOn(): boolean {
    return this.terrainOn_;
  }

  setExaggeration(value: number): void {
    this.widget.scene.verticalExaggeration = value;
    // Multipatches are drawn here, not by CesiumJS's exaggeration: they follow it so they stay on the ground.
    this.updatePatches_(true);
    this.widget.scene.requestRender();
  }

  exaggeration(): number {
    return this.widget.scene.verticalExaggeration;
  }

  /** Whether the relief of open DEMs is shown. */
  hasRelief(): boolean {
    return this.terrainOn_ && this.context.cells().length > 0;
  }

  private async updateTerrain_(): Promise<void> {
    const cells = this.terrainOn_ ? this.context.cells() : [];
    if (cells.length === this.cells_.length && cells.every((c, i) => c === this.cells_[i])) return;
    this.cells_ = cells;
    const scene = this.widget.scene;
    if (!cells.length) {
      scene.terrainProvider = new EllipsoidTerrainProvider();
    } else {
      try {
        this.geoid_ ??= await loadGeoid();
        scene.terrainProvider = demTerrain(cells, this.geoid_);
      } catch (error) {
        this.context.say(`起伏を表示できませんでした: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.updatePatches_(true);
    this.panel_.update();
    scene.requestRender();
  }

  /** Height of the ground above the ellipsoid where the relief is shown, else 0 (the ellipsoid is the ground). */
  private groundAt_(lon: number, lat: number): number {
    if (!this.hasRelief() || !this.geoid_) return 0;
    return (elevationAt(this.cells_, lon, lat) ?? 0) + geoidHeight(this.geoid_, lon, lat);
  }

  // ----- multipatches ---------------------------------------------------------

  setHeightMode(mode: HeightMode): void {
    this.heightMode_ = mode;
    this.updatePatches_(true);
  }

  heightMode(): HeightMode {
    return this.heightMode_;
  }

  /** Multipatch layers and how many shapes each has. */
  patchLayers(): Array<{ layer: ViewerService; count: number }> {
    const found: Array<{ layer: ViewerService; count: number }> = [];
    for (const layer of this.context.images.layers()) {
      if (layer.type !== 'service' || !layer.service.vector) continue;
      const count = layer.service.vector.source.getFeatures().filter((f) => multiPatchOf(f as Feature)).length;
      if (count) found.push({ layer, count });
    }
    return found;
  }

  private updatePatches_(force = false): void {
    const layers = this.patchLayers().filter(({ layer }) => layer.layer.getVisible());
    const key = layers.map(({ layer }) => `${layer.service.vector!.source.getRevision()}:${layer.layer.getOpacity()}:${layer.layer.getZIndex()}`).join('|');
    if (!force && key === this.patchesKey_) return;
    this.patchesKey_ = key;
    const primitives = this.widget.scene.primitives;
    for (const p of this.patches_.splice(0)) primitives.remove(p.primitive);
    for (const { layer } of layers) {
      const instances: GeometryInstance[] = [];
      const opacity = layer.layer.getOpacity();
      for (const f of layer.service.vector!.source.getFeatures() as Feature[]) {
        const shape = multiPatchOf(f);
        const geometry = shape && this.patchGeometry_(shape);
        if (!geometry) continue;
        const color = (this.context.selection.has(f) ? SELECTED : PATCH_COLOR).withAlpha(opacity);
        instances.push(new GeometryInstance({ geometry, id: { layer, feature: f }, attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) } }));
      }
      if (!instances.length) continue;
      const primitive = new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({ flat: false, translucent: opacity < 1, closed: false }),
        // Geometries made here cannot go to Cesium's workers.
        asynchronous: false,
      });
      this.patches_.push({ primitive: primitives.add(primitive), ids: instances.map((i) => i.id as { layer: ViewerService; feature: Feature }) });
    }
    this.widget.scene.requestRender();
  }

  /** Triangles of a shape (longitude, latitude, height above the ellipsoid; nine numbers a triangle), placed as the height mode says. */
  private placedTriangles_(shape: MultiPatch): Float64Array | null {
    const t = trianglesOf(shape);
    if (t.length < 9) return null;
    const [low] = heightRange(shape);
    const mode = this.heightMode_ === 'auto' ? (this.hasRelief() ? 'orthometric' : 'ground') : this.heightMode_;
    // Ground mode: the shape's lowest point on the ground under its first point.
    const base = mode === 'ground' ? this.groundAt_(t[0], t[1]) - low : 0;
    for (let i = 0; i < t.length; i += 3) {
      t[i + 2] += base;
      if (mode === 'orthometric' && this.geoid_) t[i + 2] += geoidHeight(this.geoid_, t[i], t[i + 1]);
    }
    return t;
  }

  /** Triangles of a shape at their heights, with a normal each (flat shaded). */
  private patchGeometry_(shape: MultiPatch): Geometry | null {
    const t = this.placedTriangles_(shape);
    if (!t) return null;
    const positions = new Float64Array(t.length);
    const scratch = new Cartesian3();
    const e = this.widget.scene.verticalExaggeration;
    for (let i = 0; i < t.length; i += 3) {
      Cartesian3.fromDegrees(t[i], t[i + 1], t[i + 2] * e, undefined, scratch);
      positions[i] = scratch.x;
      positions[i + 1] = scratch.y;
      positions[i + 2] = scratch.z;
    }
    const normals = new Float32Array(t.length);
    for (let i = 0; i < t.length; i += 9) {
      const ux = positions[i + 3] - positions[i];
      const uy = positions[i + 4] - positions[i + 1];
      const uz = positions[i + 5] - positions[i + 2];
      const vx = positions[i + 6] - positions[i];
      const vy = positions[i + 7] - positions[i + 1];
      const vz = positions[i + 8] - positions[i + 2];
      let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const l = Math.hypot(nx, ny, nz) || 1;
      [nx, ny, nz] = [nx / l, ny / l, nz / l];
      for (let k = 0; k < 3; k++) normals.set([nx, ny, nz], i + k * 3);
    }
    return new Geometry({
      attributes: {
        position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
        normal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals }),
      } as never,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(Array.from(positions)),
    });
  }

  /** Selected features in yellow. */
  private highlight_(): void {
    // The primitive lets its instances go once built: the ids are kept here.
    for (const { primitive, ids } of this.patches_) {
      if (!primitive.ready) continue;
      for (const id of ids) {
        const attributes = primitive.getGeometryInstanceAttributes(id);
        if (!attributes) continue;
        const color = (this.context.selection.has(id.feature) ? SELECTED : PATCH_COLOR).withAlpha(id.layer.layer.getOpacity());
        attributes.color = ColorGeometryInstanceAttribute.toValue(color);
      }
    }
    this.widget.scene.requestRender();
  }

  // ----- 3D Tiles -------------------------------------------------------------

  /** Adds a 3D Tiles tileset (the URL of its tileset.json) and flies to it, unless `fly` is false. */
  async addTileset(url: string, options: { name?: string; show?: boolean; fly?: boolean } = {}): Promise<boolean> {
    const { say } = this.context;
    const name = options.name ?? (url.replace(/\/tileset\.json(\?.*)?$/i, '').split('/').pop() || url);
    say(`${name} を読み込んでいます…`);
    try {
      const tileset = await Cesium3DTileset.fromUrl(url);
      tileset.show = options.show ?? true;
      this.widget.scene.primitives.add(tileset);
      const entry: TilesetEntry = { url, name, tileset, row: document.createElement('li') };
      this.tilesets_.push(entry);
      this.panel_.tilesetRow(entry, tileset.show, {
        zoom: () => void this.widget.camera.flyToBoundingSphere(tileset.boundingSphere, { duration: 0.8 }),
        remove: () => {
          this.widget.scene.primitives.remove(tileset);
          this.tilesets_.splice(this.tilesets_.indexOf(entry), 1);
          entry.row.remove();
          this.widget.scene.requestRender();
        },
        show: (on) => {
          tileset.show = on;
          this.widget.scene.requestRender();
        },
      });
      if (options.fly !== false) void this.widget.camera.flyToBoundingSphere(tileset.boundingSphere, { duration: 0.8 });
      say(`3D タイルを追加しました: ${name}`);
      return true;
    } catch (error) {
      say(`3D タイルを開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Adds the 3D Tiles of a folder on the computer (its files, each with its path in the folder). */
  async addTilesetFolder(files: readonly File[]): Promise<boolean> {
    try {
      const { url, name } = await serveFolder(files);
      return await this.addTileset(url, { name });
    } catch (error) {
      this.context.say(`3D タイルを開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  tilesets(): readonly string[] {
    return this.tilesets_.map((t) => t.url);
  }

  // ----- measuring --------------------------------------------------------------

  /** Measures distances or areas in 3D (null: stops). */
  setMeasure(mode: GlobeMeasureMode | null): void {
    if (mode && this.picking_) this.setPicking(false);
    this.measure_.setMode(mode);
    this.panel_.update();
    this.context.onMeasure?.(mode);
  }

  measureMode(): GlobeMeasureMode | null {
    // Asked by the panel before the tool is made.
    return (this.measure_ as GlobeMeasure | undefined)?.mode() ?? null;
  }

  /** The measurement made, for the tests. */
  measureResult(): MeasureResult | null {
    return this.measure_.result();
  }

  /** The measuring tool, for the tests. */
  get measure(): GlobeMeasure {
    return this.measure_;
  }

  // ----- pictures and project files --------------------------------------------

  /** The view as a PNG. */
  async picture(): Promise<Blob> {
    const scene = this.widget.scene;
    scene.render();
    return new Promise<Blob>((resolve, reject) => scene.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/png'));
  }

  /** Saves the view as a PNG file (a download). */
  async savePicture(): Promise<void> {
    try {
      const blob = await this.picture();
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `3d-${stamp}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      this.context.say(`3D 表示を ${a.download} として保存しました`);
    } catch (error) {
      this.context.say(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What a project file keeps of the 3D view. */
  state(): GlobeState {
    return {
      open: this.open_,
      camera: this.getCamera(),
      terrain: this.terrainOn_,
      exaggeration: this.widget.scene.verticalExaggeration,
      heightMode: this.heightMode_,
      natural: this.panel_.natural.checked,
      tilesets: this.tilesets_.filter((t) => !isLocalTiles(t.url)).map((t) => ({ url: t.url, show: t.tileset.show })),
    };
  }

  /** Brings back the settings and tilesets of a project file, and its camera unless `camera` is false (not whether it is open, which the caller decides). */
  async setState(state: GlobeState, camera = true): Promise<void> {
    this.panel_.setTerrain(state.terrain);
    this.setTerrain(state.terrain);
    this.panel_.setExaggeration(state.exaggeration);
    this.setExaggeration(state.exaggeration);
    this.panel_.setHeightMode(state.heightMode);
    this.setHeightMode(state.heightMode);
    this.panel_.natural.checked = state.natural;
    this.setNaturalEarth(state.natural);
    // The tilesets of the project replace those open.
    for (const t of [...this.tilesets_]) {
      this.widget.scene.primitives.remove(t.tileset);
      t.row.remove();
    }
    this.tilesets_.splice(0);
    await Promise.all(state.tilesets.map((t) => this.addTileset(t.url, { show: t.show, fly: false })));
    if (camera) this.setCamera(state.camera);
  }

  // ----- clicks and the viewshed ---------------------------------------------

  setPicking(on: boolean): void {
    if (on && this.measure_.active()) this.setMeasure(null);
    this.picking_ = on;
    this.container.classList.toggle('picking', on);
    this.panel_.update();
  }

  isPicking(): boolean {
    return this.picking_;
  }

  private click_(position: Cartesian2): void {
    const scene = this.widget.scene;
    if (this.measure_.active()) return;
    if (this.picking_) {
      const ray = this.widget.camera.getPickRay(position);
      const hit = ray && scene.globe.pick(ray, scene);
      if (!hit) return;
      const c = Cartographic.fromCartesian(hit);
      this.setPicking(false);
      void this.runViewshed(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude));
      return;
    }
    const picked = scene.pick(position) as { id?: { layer?: ViewerService; feature?: Feature } } | undefined;
    const id = picked?.id;
    if (id?.layer && id.feature) this.context.showFeature(id.layer, id.feature);
  }

  /** Computes the viewshed from `lon`, `lat` with the panel's settings and shows it. */
  async runViewshed(lon: number, lat: number): Promise<void> {
    const { say, cells } = this.context;
    const settings = this.panel_.viewshedSettings();
    const options: ViewshedOptions = { lon, lat, observerHeight: settings.observerHeight, targetHeight: settings.targetHeight, radius: settings.radius, refraction: settings.refraction };
    const open = cells();
    if (!open.length) {
      say('可視解析には標高データ（DTED）が必要です。先に開いてください');
      return;
    }
    say('可視解析: 標高を読み取っています…');
    try {
      const grid = gridAround(open, options);
      const obstacles = settings.obstacles ? await this.addObstacles_(grid) : null;
      const started = performance.now();
      const result = await runViewshed(grid, options, (done) => say(`可視解析: ${Math.round(done * 100)}%`));
      const area = visibleArea(grid, result);
      this.showViewshed_(grid, result, options);
      say(
        `可視解析: 観測点 ${lat.toFixed(5)}, ${lon.toFixed(5)}、見える範囲 ${(area / 1e6).toFixed(2)} km²（半径 ${(options.radius / 1000).toFixed(1)} km、${grid.width}×${grid.height} 点、${((performance.now() - started) / 1000).toFixed(1)} 秒` +
          (obstacles ? `、遮蔽物: ${obstacles}` : '') +
          '）',
      );
    } catch (error) {
      say(`可視解析できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Raises the grid's heights to the buildings standing on it: the shapes of
   * visible multipatch layers, and the 3D Tiles shown (their heights read from
   * what is drawn now, at up to {@link MAX_TILE_SAMPLES} points). Returns what
   * was counted in, for the message, or null when nothing was.
   */
  private async addObstacles_(grid: ViewshedGrid): Promise<string | null> {
    const found: string[] = [];
    const geoid = this.geoid_ ?? (this.geoid_ = await loadGeoid());
    // Multipatches: their triangles, at heights above sea level.
    let shapes = 0;
    let raised = 0;
    for (const { layer } of this.patchLayers()) {
      if (!layer.layer.getVisible()) continue;
      for (const f of layer.service.vector!.source.getFeatures() as Feature[]) {
        const shape = multiPatchOf(f);
        const t = shape && this.placedTriangles_(shape);
        if (!t) continue;
        for (let i = 0; i < t.length; i += 3) t[i + 2] -= geoidHeight(geoid, t[i], t[i + 1]);
        raised += raiseByTriangles(grid, t);
        shapes++;
      }
    }
    if (shapes) found.push(`マルチパッチ ${shapes.toLocaleString()} 件（${raised.toLocaleString()} 点）`);
    // 3D Tiles: the height of what is drawn over each point, where it stands above the ground.
    const scene = this.widget.scene;
    const shown = this.tilesets_.filter((t) => t.tileset.show);
    if (shown.length && scene.sampleHeightSupported) {
      const rects = shown.map((t) => Rectangle.fromBoundingSphere(t.tileset.boundingSphere));
      const inside = (lon: number, lat: number) => rects.some((r) => Rectangle.contains(r, Cartographic.fromDegrees(lon, lat)));
      // Every `step`-th point of the grid, so there are at most MAX_TILE_SAMPLES.
      let cells = 0;
      for (let r = 0; r < grid.height; r++) for (let c = 0; c < grid.width; c++) if (inside(grid.west + c * grid.dLon, grid.north - r * grid.dLat)) cells++;
      const step = Math.max(1, Math.ceil(Math.sqrt(cells / MAX_TILE_SAMPLES)));
      const exclude = shown.length < this.tilesets_.length ? this.tilesets_.filter((t) => !t.tileset.show).map((t) => t.tileset) : [];
      const e = scene.verticalExaggeration || 1;
      const ellipsoid = scene.globe.show;
      // Only objects: the ground is the DEM's.
      scene.globe.show = false;
      let samples = 0;
      let higher = 0;
      try {
        for (let r = 0; r < grid.height; r += step) {
          for (let c = 0; c < grid.width; c += step) {
            const lon = grid.west + c * grid.dLon;
            const lat = grid.north - r * grid.dLat;
            if (!inside(lon, lat)) continue;
            const h = scene.sampleHeight(Cartographic.fromDegrees(lon, lat), [...exclude, ...this.patches_.map((p) => p.primitive)]);
            samples++;
            if (h === undefined) continue;
            const top = h / e - geoidHeight(geoid, lon, lat);
            // The block of points this sample stands for.
            for (let rr = r; rr < Math.min(grid.height, r + step); rr++) {
              for (let cc = c; cc < Math.min(grid.width, c + step); cc++) {
                const k = rr * grid.width + cc;
                if (top > grid.heights[k] || Number.isNaN(grid.heights[k])) {
                  grid.heights[k] = top;
                  higher++;
                }
              }
            }
          }
          // Let the page breathe on big grids.
          if (r % (step * 64) === 0) await new Promise((resolve) => setTimeout(resolve));
        }
      } finally {
        scene.globe.show = ellipsoid;
        scene.requestRender();
      }
      if (samples) found.push(`3D タイル ${samples.toLocaleString()} 点${step > 1 ? `（${step} 点おき）` : ''}、${higher.toLocaleString()} 点が地面より高い`);
    }
    return found.length ? found.join('、') : null;
  }

  /** The result as a layer of the 2D map (so it shows in both views) and the observer as a marker. */
  private showViewshed_(grid: ReturnType<typeof gridAround>, result: Uint8Array, options: ViewshedOptions): void {
    this.clearViewshed();
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    canvas.getContext('2d')!.putImageData(new ImageData(viewshedPixels(result), grid.width, grid.height), 0, 0);
    const extent = [grid.west - grid.dLon / 2, grid.north - (grid.height - 0.5) * grid.dLat, grid.west + (grid.width - 0.5) * grid.dLon, grid.north + grid.dLat / 2];
    const observer = new OlFeature(new Point(fromLonLat([options.lon, options.lat], this.context.map.getView().getProjection())));
    const group = new LayerGroup({
      zIndex: 10_000,
      properties: { viewshed: true },
      layers: [
        new ImageLayer({ source: new Static({ url: canvas.toDataURL(), imageExtent: extent, projection: 'EPSG:4326', interpolate: false }) }),
        new VectorLayer({
          source: new VectorSource({ features: [observer] }),
          style: new Style({ image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#ffd400' }), stroke: new Stroke({ color: '#000', width: 2 }) }) }),
        }),
      ],
    });
    this.context.map.addLayer(group);
    const marker = this.widget.entities.add({
      position: Cartesian3.fromDegrees(options.lon, options.lat, options.observerHeight),
      point: { pixelSize: 10, color: Color.YELLOW, outlineColor: Color.BLACK, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: {
        text: '観測点',
        font: '14px sans-serif',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    this.viewshed_ = { group, marker };
    this.panel_.update();
  }

  hasViewshed(): boolean {
    return this.viewshed_ !== null;
  }

  clearViewshed(): void {
    if (!this.viewshed_) return;
    this.context.map.removeLayer(this.viewshed_.group);
    this.widget.entities.remove(this.viewshed_.marker);
    this.viewshed_ = null;
    this.panel_.update();
    this.widget.scene.requestRender();
  }

  setNaturalEarth(on: boolean): void {
    if (this.natural_) this.natural_.show = on;
    this.widget.scene.requestRender();
  }

  /** Where the cursor is, for the tests: the longitude and latitude under a pixel of the globe. */
  lonLatAt(x: number, y: number): [number, number] | null {
    const scene = this.widget.scene;
    const ray = this.widget.camera.getPickRay(new Cartesian2(x, y));
    const hit = ray && scene.globe.pick(ray, scene);
    if (!hit) return null;
    const c = Cartographic.fromCartesian(hit);
    return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
  }
}

/** 3D Tiles heights read for a viewshed at most. */
const MAX_TILE_SAMPLES = 40_000;
const PATCH_COLOR = Color.fromCssColorString('#e8e2d6');
const SELECTED = Color.fromCssColorString('#ffd400');

/** The 3D section of the side panel. */
class GlobePanel {
  readonly natural: HTMLInputElement;
  private readonly terrain_: HTMLInputElement;
  private readonly terrainText_: HTMLElement;
  private readonly exaggeration_: HTMLInputElement;
  private readonly exaggerationText_: HTMLOutputElement;
  private readonly tilesets_: HTMLUListElement;
  private readonly patchText_: HTMLElement;
  private readonly heightMode_: HTMLSelectElement;
  private readonly pick_: HTMLButtonElement;
  private readonly clear_: HTMLButtonElement;
  private readonly observer_: HTMLInputElement;
  private readonly target_: HTMLInputElement;
  private readonly radius_: HTMLInputElement;
  private readonly refraction_: HTMLInputElement;
  private readonly progress_: HTMLElement;
  private readonly obstacles_: HTMLInputElement;
  private readonly distance_: HTMLButtonElement;
  private readonly area_: HTMLButtonElement;
  private readonly measure_: HTMLElement;
  private readonly measureLines_: HTMLElement;
  private readonly profile_: HTMLElement;
  private readonly csv_: HTMLButtonElement;
  private csvText_ = '';

  constructor(
    private readonly element: HTMLElement,
    private readonly globe: Globe,
  ) {
    element.innerHTML = `
      <p class="globe-hint">ドラッグ: 移動 ／ 右ドラッグ・ホイール: 拡大縮小 ／ Ctrl + ドラッグ: 傾き・回転</p>
      <p class="globe-loading" hidden></p>
      <h3>地形</h3>
      <label class="globe-check"><input type="checkbox" name="terrain" checked /> 標高データで起伏を表示</label>
      <p class="globe-note" data-text="terrain"></p>
      <label class="globe-range">高さの強調 <input type="range" name="exaggeration" min="1" max="10" step="0.5" value="1" /> <output>×1</output></label>
      <h3>マルチパッチ</h3>
      <p class="globe-note" data-text="patches"></p>
      <label class="globe-field">高さの基準
        <select name="height-mode">
          <option value="auto">自動（起伏があれば標高、なければ地表から）</option>
          <option value="orthometric">標高（ジオイド高を足す）</option>
          <option value="ground">地表から（最も低い点を地表に）</option>
          <option value="ellipsoid">楕円体高（そのまま）</option>
        </select>
      </label>
      <h3>3D タイル</h3>
      <form class="globe-tileset">
        <input type="url" name="url" placeholder="tileset.json の URL" aria-label="3D タイルの URL" required />
        <button type="submit">追加</button>
      </form>
      <div class="globe-buttons">
        <button type="button" name="tiles-folder" title="tileset.json のあるフォルダを、パソコンから開きます">フォルダから開く…</button>
        <input type="file" name="tiles-files" webkitdirectory multiple hidden />
      </div>
      <ul class="globe-tilesets"></ul>
      <h3>計測</h3>
      <div class="globe-buttons">
        <button type="button" name="measure-distance" aria-pressed="false" title="点の間の斜距離・水平距離・高低差と断面図（D）">距離・断面</button>
        <button type="button" name="measure-area" aria-pressed="false" title="水平面積と周長（A）">面積</button>
      </div>
      <div class="globe-measure" hidden>
        <p class="globe-measure-lines"></p>
        <div class="globe-profile"></div>
        <div class="globe-buttons"><button type="button" name="profile-csv" hidden>断面を CSV で保存</button></div>
      </div>
      <h3>可視解析</h3>
      <div class="globe-viewshed">
        <label class="globe-field">観測者の高さ <span><input type="number" name="observer" value="1.6" min="0" step="0.1" /> m</span></label>
        <label class="globe-field">対象の高さ <span><input type="number" name="target" value="0" min="0" step="0.1" /> m</span></label>
        <label class="globe-field">半径 <span><input type="number" name="radius" value="5" min="0.1" max="100" step="0.1" /> km</span></label>
        <label class="globe-check" title="マルチパッチの建物と、表示中の 3D タイルの高さを地形に加えて判定します"><input type="checkbox" name="obstacles" checked /> 建物（マルチパッチ・3D タイル）も遮る</label>
        <details class="globe-more">
          <summary>詳細</summary>
          <label class="globe-field">大気差係数 <span><input type="number" name="refraction" value="0.13" min="0" max="1" step="0.01" /></span></label>
          <p class="globe-note">標高データの全点について、観測点からの視線をそのまま辿って判定します（R3 法）。距離は WGS 84 楕円体上、地球の丸みと大気の屈折を考慮します。3D タイルの高さは、いま表示されている詳しさで最大 4 万点読み取ります。</p>
        </details>
        <div class="globe-buttons">
          <button type="button" name="pick" aria-pressed="false">観測点をクリック</button>
          <button type="button" name="clear">結果を消去</button>
        </div>
      </div>
      <h3>表示</h3>
      <label class="globe-check"><input type="checkbox" name="natural" checked /> 地球全体の背景画像（Natural Earth）</label>
      <div class="globe-buttons"><button type="button" name="save-picture" title="いまの 3D 表示を PNG で保存します">画像として保存（PNG）</button></div>
    `;
    const q = <T extends Element>(selector: string) => element.querySelector<T & Element>(selector)!;
    this.natural = q<HTMLInputElement>('[name=natural]');
    this.terrain_ = q<HTMLInputElement>('[name=terrain]');
    this.terrainText_ = q<HTMLElement>('[data-text=terrain]');
    this.exaggeration_ = q<HTMLInputElement>('[name=exaggeration]');
    this.exaggerationText_ = q<HTMLOutputElement>('.globe-range output');
    this.tilesets_ = q<HTMLUListElement>('.globe-tilesets');
    this.patchText_ = q<HTMLElement>('[data-text=patches]');
    this.heightMode_ = q<HTMLSelectElement>('[name=height-mode]');
    this.pick_ = q<HTMLButtonElement>('[name=pick]');
    this.clear_ = q<HTMLButtonElement>('[name=clear]');
    this.observer_ = q<HTMLInputElement>('[name=observer]');
    this.target_ = q<HTMLInputElement>('[name=target]');
    this.radius_ = q<HTMLInputElement>('[name=radius]');
    this.refraction_ = q<HTMLInputElement>('[name=refraction]');
    this.progress_ = q<HTMLElement>('.globe-loading');
    this.obstacles_ = q<HTMLInputElement>('[name=obstacles]');
    this.distance_ = q<HTMLButtonElement>('[name=measure-distance]');
    this.area_ = q<HTMLButtonElement>('[name=measure-area]');
    this.measure_ = q<HTMLElement>('.globe-measure');
    this.measureLines_ = q<HTMLElement>('.globe-measure-lines');
    this.profile_ = q<HTMLElement>('.globe-profile');
    this.csv_ = q<HTMLButtonElement>('[name=profile-csv]');

    this.natural.addEventListener('change', () => globe.setNaturalEarth(this.natural.checked));
    this.terrain_.addEventListener('change', () => globe.setTerrain(this.terrain_.checked));
    this.exaggeration_.addEventListener('input', () => {
      const v = Number(this.exaggeration_.value);
      this.exaggerationText_.textContent = `×${v}`;
      globe.setExaggeration(v);
    });
    this.heightMode_.addEventListener('change', () => globe.setHeightMode(this.heightMode_.value as HeightMode));
    q<HTMLFormElement>('.globe-tileset').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = (e.target as HTMLFormElement).elements.namedItem('url') as HTMLInputElement;
      const url = input.value.trim();
      if (!url) return;
      input.value = '';
      void globe.addTileset(url);
    });
    const folder = q<HTMLInputElement>('[name=tiles-files]');
    q<HTMLButtonElement>('[name=tiles-folder]').addEventListener('click', () => folder.click());
    folder.addEventListener('change', () => {
      const files = [...(folder.files ?? [])];
      folder.value = '';
      if (files.length) void globe.addTilesetFolder(files);
    });
    this.distance_.addEventListener('click', () => globe.setMeasure(globe.measureMode() === 'distance' ? null : 'distance'));
    this.area_.addEventListener('click', () => globe.setMeasure(globe.measureMode() === 'area' ? null : 'area'));
    this.csv_.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([this.csvText_], { type: 'text/csv' }));
      a.download = 'profile.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    });
    q<HTMLButtonElement>('[name=save-picture]').addEventListener('click', () => void globe.savePicture());
    this.pick_.addEventListener('click', () => globe.setPicking(!globe.isPicking()));
    this.clear_.addEventListener('click', () => globe.clearViewshed());
    this.update();
  }

  /** The viewshed's settings as typed (metres). */
  viewshedSettings(): Omit<ViewshedOptions, 'lon' | 'lat'> & { obstacles: boolean } {
    const n = (input: HTMLInputElement, fallback: number) => (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback);
    return {
      obstacles: this.obstacles_.checked,
      observerHeight: Math.max(0, n(this.observer_, 1.6)),
      targetHeight: Math.max(0, n(this.target_, 0)),
      radius: Math.min(100, Math.max(0.1, n(this.radius_, 5))) * 1000,
      refraction: Math.min(1, Math.max(0, n(this.refraction_, 0.13))),
    };
  }

  /** Shows how many globe tiles are still loading. */
  loading(queued: number): void {
    this.progress_.hidden = queued === 0;
    this.progress_.textContent = `読み込み中…（残り ${queued} タイル）`;
  }

  setTerrain(on: boolean): void {
    this.terrain_.checked = on;
  }

  setExaggeration(value: number): void {
    this.exaggeration_.value = String(value);
    this.exaggerationText_.textContent = `×${value}`;
  }

  setHeightMode(mode: HeightMode): void {
    this.heightMode_.value = mode;
  }

  /** Shows a measurement (null: none yet). */
  showMeasure(result: MeasureResult | null): void {
    this.measure_.hidden = !result;
    this.measureLines_.textContent = result?.lines.join('\n') ?? '';
    const profile = result?.profile;
    if (profile) drawProfile(this.profile_, profile);
    else this.profile_.replaceChildren();
    this.csv_.hidden = !profile;
    this.csvText_ = profile ? profileCsv(profile) : '';
  }

  /** A row of the tileset list. */
  tilesetRow(entry: { url: string; name: string; row: HTMLLIElement }, shown: boolean, actions: { zoom: () => void; remove: () => void; show: (on: boolean) => void }): void {
    const { row } = entry;
    const show = document.createElement('input');
    show.type = 'checkbox';
    show.checked = shown;
    show.title = '表示';
    show.addEventListener('change', () => actions.show(show.checked));
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'globe-tileset-name';
    name.textContent = entry.name;
    name.title = `${isLocalTiles(entry.url) ? 'パソコンのフォルダ' : entry.url}（クリックで移動）`;
    name.addEventListener('click', actions.zoom);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '閉じる';
    remove.setAttribute('aria-label', `${name.textContent} を閉じる`);
    remove.addEventListener('click', actions.remove);
    row.append(show, name, remove);
    this.tilesets_.append(row);
  }

  update(): void {
    const cells = this.globe.context.cells();
    this.terrainText_.textContent = cells.length
      ? `標高データ: ${cells.map((c) => c.level).join('、')}（${cells.length} 枚）`
      : '標高データなし（DTED .dt0〜.dt2 を開くか、1 バンドの GeoTIFF を幾何補正の「標高データとして使う」にすると起伏を表示します）';
    const patches = this.globe.patchLayers();
    this.patchText_.textContent = patches.length
      ? patches.map(({ layer, count }) => `${layer.name}: ${count.toLocaleString()} 件`).join('、')
      : 'マルチパッチの Shapefile を開くと立体で表示します';
    this.pick_.setAttribute('aria-pressed', String(this.globe.isPicking()));
    this.pick_.textContent = this.globe.isPicking() ? '地図をクリックしてください（もう一度で中止）' : '観測点をクリック';
    this.clear_.disabled = !this.globe.hasViewshed();
    const mode = this.globe.measureMode();
    this.distance_.setAttribute('aria-pressed', String(mode === 'distance'));
    this.area_.setAttribute('aria-pressed', String(mode === 'area'));
  }
}
