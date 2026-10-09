/**
 * The 3D view (立体表示): a CesiumJS globe on the WGS 84 ellipsoid, loaded
 * only when it is first opened. It shows
 *
 * - every 2D layer as the 2D map draws it, draped over the ground
 *   (globe-tiles.ts: corrections, styles, labels, base maps…);
 * - the relief of the DEMs that are open (DTED, heights above mean sea level
 *   plus the EGM96 geoid), with a vertical exaggeration;
 * - 3D Tiles tilesets by URL;
 * - multipatch layers (multipatch.ts) as solid shapes;
 * - the viewshed from a clicked point (viewshed.ts), as a layer of the map.
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
import { gridAround, runViewshed, viewshedPixels, visibleArea, type ViewshedOptions } from './viewshed.js';
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
    const key = `${level}/${bx}/${by}`;
    let block = this.blocks_.get(key);
    if (!block) {
      if (this.waiting_ >= MAX_WAITING || this.disposed_) return undefined;
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

/** One 3D Tiles tileset added by URL. */
interface TilesetEntry {
  url: string;
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
  /** {@link layerSignature} when the layers were last drawn. */
  private drawn_ = '';
  /** The layers changed while tiles were being drawn. */
  private changedWhileBusy_ = false;
  private open_ = false;
  private cells_: Dted[] = [];
  private terrainOn_ = true;
  private heightMode_: HeightMode = 'auto';
  private patches_: Primitive[] = [];
  private patchesKey_ = '';
  private readonly tilesets_: TilesetEntry[] = [];
  private viewshed_: ViewshedEntry | null = null;
  private picking_ = false;
  private geoid_: GeoidGrid | null = null;
  private readonly panel_: GlobePanel;
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
    this.widget.scene.requestRender();
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
    for (const p of this.patches_.splice(0)) primitives.remove(p);
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
      this.patches_.push(primitives.add(primitive));
    }
    this.widget.scene.requestRender();
  }

  /** Triangles of a shape at their heights, with a normal each (flat shaded). */
  private patchGeometry_(shape: MultiPatch): Geometry | null {
    const t = trianglesOf(shape);
    if (t.length < 9) return null;
    const [low] = heightRange(shape);
    const mode = this.heightMode_ === 'auto' ? (this.hasRelief() ? 'orthometric' : 'ground') : this.heightMode_;
    // Ground mode: the shape's lowest point on the ground under its first point.
    const base = mode === 'ground' ? this.groundAt_(t[0], t[1]) - low : 0;
    const positions = new Float64Array(t.length);
    const scratch = new Cartesian3();
    for (let i = 0; i < t.length; i += 3) {
      const [lon, lat, z] = [t[i], t[i + 1], t[i + 2]];
      let h = z + base;
      if (mode === 'orthometric') h += this.geoid_ ? geoidHeight(this.geoid_, lon, lat) : 0;
      Cartesian3.fromDegrees(lon, lat, h, undefined, scratch);
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
    for (const primitive of this.patches_) {
      if (!primitive.ready) continue;
      for (const instance of primitive.geometryInstances as GeometryInstance[]) {
        const id = instance.id as { layer: ViewerService; feature: Feature };
        const attributes = primitive.getGeometryInstanceAttributes(id);
        if (!attributes) continue;
        const color = (this.context.selection.has(id.feature) ? SELECTED : PATCH_COLOR).withAlpha(id.layer.layer.getOpacity());
        attributes.color = ColorGeometryInstanceAttribute.toValue(color);
      }
    }
    this.widget.scene.requestRender();
  }

  // ----- 3D Tiles -------------------------------------------------------------

  /** Adds a 3D Tiles tileset (the URL of its tileset.json) and flies to it. */
  async addTileset(url: string): Promise<void> {
    const { say } = this.context;
    say(`${url} を読み込んでいます…`);
    try {
      const tileset = await Cesium3DTileset.fromUrl(url);
      this.widget.scene.primitives.add(tileset);
      const entry: TilesetEntry = { url, tileset, row: document.createElement('li') };
      this.tilesets_.push(entry);
      this.panel_.tilesetRow(entry, {
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
      void this.widget.camera.flyToBoundingSphere(tileset.boundingSphere, { duration: 0.8 });
      say(`3D タイルを追加しました: ${url}`);
    } catch (error) {
      say(`3D タイルを開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  tilesets(): readonly string[] {
    return this.tilesets_.map((t) => t.url);
  }

  // ----- clicks and the viewshed ---------------------------------------------

  setPicking(on: boolean): void {
    this.picking_ = on;
    this.container.classList.toggle('picking', on);
    this.panel_.update();
  }

  isPicking(): boolean {
    return this.picking_;
  }

  private click_(position: Cartesian2): void {
    const scene = this.widget.scene;
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
    const options: ViewshedOptions = { lon, lat, ...settings };
    const open = cells();
    if (!open.length) {
      say('可視解析には標高データ（DTED）が必要です。先に開いてください');
      return;
    }
    say('可視解析: 標高を読み取っています…');
    try {
      const grid = gridAround(open, options);
      const started = performance.now();
      const result = await runViewshed(grid, options, (done) => say(`可視解析: ${Math.round(done * 100)}%`));
      const area = visibleArea(grid, result);
      this.showViewshed_(grid, result, options);
      say(
        `可視解析: 観測点 ${lat.toFixed(5)}, ${lon.toFixed(5)}、見える範囲 ${(area / 1e6).toFixed(2)} km²（半径 ${(options.radius / 1000).toFixed(1)} km、${grid.width}×${grid.height} 点、${((performance.now() - started) / 1000).toFixed(1)} 秒）`,
      );
    } catch (error) {
      say(`可視解析できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      <ul class="globe-tilesets"></ul>
      <h3>可視解析</h3>
      <div class="globe-viewshed">
        <label class="globe-field">観測者の高さ <span><input type="number" name="observer" value="1.6" min="0" step="0.1" /> m</span></label>
        <label class="globe-field">対象の高さ <span><input type="number" name="target" value="0" min="0" step="0.1" /> m</span></label>
        <label class="globe-field">半径 <span><input type="number" name="radius" value="5" min="0.1" max="100" step="0.1" /> km</span></label>
        <details class="globe-more">
          <summary>詳細</summary>
          <label class="globe-field">大気差係数 <span><input type="number" name="refraction" value="0.13" min="0" max="1" step="0.01" /></span></label>
          <p class="globe-note">標高データ（DTED）の全点について、観測点からの視線をそのまま辿って判定します（R3 法）。距離は WGS 84 楕円体上、地球の丸みと大気の屈折を考慮します。</p>
        </details>
        <div class="globe-buttons">
          <button type="button" name="pick" aria-pressed="false">観測点をクリック</button>
          <button type="button" name="clear">結果を消去</button>
        </div>
      </div>
      <h3>表示</h3>
      <label class="globe-check"><input type="checkbox" name="natural" checked /> 地球全体の背景画像（Natural Earth）</label>
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
    this.pick_.addEventListener('click', () => globe.setPicking(!globe.isPicking()));
    this.clear_.addEventListener('click', () => globe.clearViewshed());
    this.update();
  }

  /** The viewshed's settings as typed (metres). */
  viewshedSettings(): Omit<ViewshedOptions, 'lon' | 'lat'> {
    const n = (input: HTMLInputElement, fallback: number) => (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback);
    return {
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

  /** A row of the tileset list. */
  tilesetRow(entry: { url: string; row: HTMLLIElement }, actions: { zoom: () => void; remove: () => void; show: (on: boolean) => void }): void {
    const { row } = entry;
    const show = document.createElement('input');
    show.type = 'checkbox';
    show.checked = true;
    show.title = '表示';
    show.addEventListener('change', () => actions.show(show.checked));
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'globe-tileset-name';
    name.textContent = entry.url.replace(/\/tileset\.json(\?.*)?$/i, '').split('/').pop() || entry.url;
    name.title = `${entry.url}（クリックで移動）`;
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
      : '標高データなし（DTED .dt0〜.dt2 を開くと起伏を表示します）';
    const patches = this.globe.patchLayers();
    this.patchText_.textContent = patches.length
      ? patches.map(({ layer, count }) => `${layer.name}: ${count.toLocaleString()} 件`).join('、')
      : 'マルチパッチの Shapefile を開くと立体で表示します';
    this.pick_.setAttribute('aria-pressed', String(this.globe.isPicking()));
    this.pick_.textContent = this.globe.isPicking() ? '地図をクリックしてください（もう一度で中止）' : '観測点をクリック';
    this.clear_.disabled = !this.globe.hasViewshed();
  }
}
