/**
 * OpenLayers control that loads an image onto the map: a GeoTIFF / COG from a
 * local file or a URL, placed where its georeferencing says, or an ordinary
 * picture (PNG, JPEG, WebP, ...), placed over the current view. Files can also
 * be dropped on the map. Every image becomes an {@link EnhancedGeoTIFF}, so
 * the {@link EnhanceControl}, DRA and the GPU layer work the same on both.
 */
import Control from 'ol/control/Control.js';
import BaseEvent from 'ol/events/Event.js';
import type OlMap from 'ol/Map.js';
import type Layer from 'ol/layer/Layer.js';
import { getCenter, getHeight, getWidth, type Extent } from 'ol/extent.js';
import { transformExtent } from 'ol/proj.js';
import { unByKey } from 'ol/Observable.js';
import { toImageData } from '../io.js';
import EnhancedGeoTIFF, { type EnhancedGeoTIFFOptions } from './enhanced-geotiff.js';
import GpuCorrectedTileLayer from './gpu-layer.js';
import { imageToGeoTIFF } from './geotiff-writer.js';
import { addControlStyles, iconButton } from './control-styles.js';

/** What was loaded. */
export interface LoadedImage {
  /** The new source. */
  source: EnhancedGeoTIFF;
  /** File name or URL. */
  name: string;
  /** `geotiff` when the file had its own georeferencing, `image` when it was placed over the view. */
  kind: 'geotiff' | 'image';
}

/** Fired by {@link LoadImageControl}: `load` with {@link LoadImageEvent.loaded}, `error` with {@link LoadImageEvent.error}. */
export class LoadImageEvent extends BaseEvent {
  constructor(
    type: 'load' | 'error',
    /** What was loaded (`load`). */
    readonly loaded: LoadedImage | null,
    /** Why it failed (`error`). */
    readonly error: unknown = null,
    /** File name or URL. */
    readonly name = loaded?.name ?? '',
  ) {
    super(type);
  }
}

/** Where an ordinary picture goes: an extent in the coordinates of `epsg`. */
export interface ImagePlacement {
  /** `[minX, minY, maxX, maxY]` of the picture. */
  extent: Extent;
  /** EPSG code of `extent`. */
  epsg: number;
}

/** Texts of {@link LoadImageControl}, by key. */
export type LoadImageLabels = Record<'open' | 'url' | 'urlPlaceholder' | 'load', string>;

/** English texts (the default). */
export const loadImageLabelsEn: LoadImageLabels = {
  open: 'Open an image or GeoTIFF',
  url: 'Open a COG URL',
  urlPlaceholder: 'https://…/image.tif',
  load: 'Open',
};

/** Japanese texts. */
export const loadImageLabelsJa: LoadImageLabels = {
  open: '画像または GeoTIFF を開く',
  url: 'COG の URL を開く',
  urlPlaceholder: 'https://…/image.tif',
  load: '開く',
};

/** Options for {@link LoadImageControl}. */
export interface LoadImageControlOptions {
  /**
   * The layer that shows the image: each loaded image becomes its source (the
   * previous source is disposed). Without it, use `onLoad` to show the source.
   */
  layer?: Layer;
  /**
   * Options for the new {@link EnhancedGeoTIFF}. By default the pipeline of the
   * layer's previous source is kept, and tiles are left as read when the layer
   * is a {@link GpuCorrectedTileLayer} with WebGL2 (the layer corrects them),
   * else corrected in workers.
   */
  sourceOptions?: Omit<EnhancedGeoTIFFOptions, 'sources'>;
  /** Zoom the map to the loaded image (default true). */
  fit?: boolean;
  /** Show the button for a COG URL (default true). */
  url?: boolean;
  /** Accept files dropped on the map (default true). */
  drop?: boolean;
  /** The file chooser's `accept`. Default: TIFF files and images. */
  accept?: string;
  /**
   * Where an ordinary picture (one without georeferencing) goes. Default:
   * centered on the view, 80 % of its size, keeping the picture's shape.
   */
  placement?: (size: { width: number; height: number }, map: OlMap) => ImagePlacement;
  /** Texts; missing keys come from {@link loadImageLabelsEn}. {@link loadImageLabelsJa} has Japanese. */
  labels?: Partial<LoadImageLabels>;
  /** Add the default styles to the document (default true). */
  css?: boolean;
  /** Extra class names for the control element. */
  className?: string;
  /** Put the control in this element instead of the map's overlay container. */
  target?: HTMLElement | string;
  /**
   * Takes the files chosen or dropped instead of the control: the chooser
   * then accepts several files at once, and the handler decides what to open
   * (for example call `loadFile` for each image and read other files itself).
   */
  onFiles?: (files: File[]) => void;
  /** Called after an image is loaded (also fired as a `load` event). */
  onLoad?: (loaded: LoadedImage) => void;
  /** Called when an image cannot be loaded (also fired as an `error` event). */
  onError?: (error: unknown, name: string) => void;
}

/**
 * A map control that opens images and GeoTIFFs (file chooser, URL, or drag
 * and drop) as {@link EnhancedGeoTIFF} sources.
 *
 * @example
 * ```ts
 * const layer = new GpuCorrectedTileLayer();
 * map.addLayer(layer);
 * map.addControl(new LoadImageControl({ layer }));
 * map.addControl(new EnhanceControl({ layer }));
 * ```
 */
export default class LoadImageControl extends Control {
  private readonly options_: LoadImageControlOptions;
  private readonly file_: HTMLInputElement;
  private undrop_: Array<() => void> = [];
  private busy_ = 0;

  constructor(options: LoadImageControlOptions = {}) {
    const element = document.createElement('div');
    super({ element, target: options.target });
    if (options.css !== false) addControlStyles();
    this.options_ = options;
    element.className = `ol-load-image ol-unselectable ol-control${options.className ? ` ${options.className}` : ''}`;
    const t = { ...loadImageLabelsEn, ...options.labels };

    this.file_ = document.createElement('input');
    this.file_.type = 'file';
    this.file_.accept = options.accept ?? '.tif,.tiff,image/*';
    this.file_.hidden = true;
    this.file_.multiple = !!options.onFiles;
    this.file_.addEventListener('change', () => {
      const files = Array.from(this.file_.files ?? []);
      this.file_.value = '';
      this.takeFiles_(files);
    });
    const open = iconButton(t.open, FOLDER_ICON);
    open.addEventListener('click', () => this.file_.click());
    element.append(open, this.file_);

    if (options.url !== false) {
      const toggle = iconButton(t.url, LINK_ICON);
      const form = document.createElement('form');
      form.hidden = true;
      const input = document.createElement('input');
      input.type = 'url';
      input.required = true;
      input.placeholder = t.urlPlaceholder;
      input.setAttribute('aria-label', t.url);
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = t.load;
      form.append(input, submit);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        form.hidden = !form.hidden;
        toggle.setAttribute('aria-expanded', String(!form.hidden));
        if (!form.hidden) input.focus();
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = input.value.trim();
        if (url) void this.loadUrl(url).then(() => (form.hidden = true), () => {});
      });
      element.append(toggle, form);
    }
  }

  /** Whether a load is in progress. */
  isLoading(): boolean {
    return this.busy_ > 0;
  }

  /**
   * Loads a GeoTIFF, or an ordinary picture placed over the view. Resolves
   * with the new source once it is on the layer (and the map fitted to it).
   */
  async loadFile(file: Blob, name = file instanceof File ? file.name : 'image'): Promise<EnhancedGeoTIFF> {
    return this.track_(name, async () => {
      if (await isTiff(file)) return this.show_({ blob: file }, name, 'geotiff');
      const map = this.getMap();
      if (!map) throw new Error('Add the control to a map before loading an ordinary image (it is placed over the view).');
      const image = await toImageData(file);
      const place = this.options_.placement ?? placeOverView;
      const { extent, epsg } = place({ width: image.width, height: image.height }, map);
      return this.show_({ blob: imageToGeoTIFF(image, { extent, epsg }) }, name, 'image');
    });
  }

  /** Loads a COG (or any GeoTIFF the server allows range requests on) from `url`. */
  async loadUrl(url: string): Promise<EnhancedGeoTIFF> {
    return this.track_(url, () => this.show_({ url }, url, 'geotiff'));
  }

  override setMap(map: OlMap | null): void {
    this.undrop_.forEach((off) => off());
    this.undrop_ = [];
    super.setMap(map);
    if (!map || this.options_.drop === false) return;
    const viewport = map.getViewport();
    const over = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      viewport.classList.add('ol-load-image-drop');
    };
    const leave = () => viewport.classList.remove('ol-load-image-drop');
    const drop = (e: DragEvent) => {
      leave();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      this.takeFiles_(files);
    };
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      viewport.addEventListener(type, fn);
      this.undrop_.push(() => viewport.removeEventListener(type, fn));
    };
    on('dragenter', over);
    on('dragover', over);
    on('dragleave', leave);
    on('drop', drop);
  }

  /** Chosen or dropped files: to `onFiles`, else the first one is opened. */
  private takeFiles_(files: File[]): void {
    if (this.options_.onFiles) {
      if (files.length) this.options_.onFiles(files);
    } else if (files[0]) {
      void this.loadFile(files[0]).catch(() => {});
    }
  }

  protected override disposeInternal(): void {
    this.undrop_.forEach((off) => off());
    this.undrop_ = [];
    super.disposeInternal();
  }

  private async track_(name: string, load: () => Promise<EnhancedGeoTIFF>): Promise<EnhancedGeoTIFF> {
    this.busy_++;
    this.element.classList.add('ol-load-image-busy');
    this.element.setAttribute('aria-busy', 'true');
    try {
      return await load();
    } catch (error) {
      this.options_.onError?.(error, name);
      this.dispatchEvent(new LoadImageEvent('error', null, error, name));
      throw error;
    } finally {
      if (--this.busy_ === 0) {
        this.element.classList.remove('ol-load-image-busy');
        this.element.removeAttribute('aria-busy');
      }
    }
  }

  private async show_(from: { url: string } | { blob: Blob }, name: string, kind: LoadedImage['kind']): Promise<EnhancedGeoTIFF> {
    const layer = this.options_.layer;
    const previous = layer?.getSource();
    const onGpu = layer instanceof GpuCorrectedTileLayer && layer.hasGpu();
    const source = new EnhancedGeoTIFF({
      pipeline: previous instanceof EnhancedGeoTIFF ? previous.getPipeline() : undefined,
      correctTiles: !onGpu,
      ...this.options_.sourceOptions,
      sources: [from],
    });
    let view;
    try {
      view = await viewOf(source);
    } catch (error) {
      source.dispose();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (layer) {
      // Read the source again: another load may have replaced it while this one was reading.
      const current = layer.getSource();
      layer.setSource(source);
      if (current && current !== source) current.dispose();
    }
    const map = this.getMap();
    if (map && this.options_.fit !== false && view.extent) {
      const target = map.getView();
      const extent = transformExtent(view.extent, view.projection ?? 'EPSG:4326', target.getProjection());
      target.fit(extent, { padding: [20, 20, 20, 20], duration: 0 });
    }
    const loaded: LoadedImage = { source, name, kind };
    this.options_.onLoad?.(loaded);
    this.dispatchEvent(new LoadImageEvent('load', loaded));
    return source;
  }
}

/**
 * The source's view, or its error. OpenLayers' `getView()` never settles when
 * the GeoTIFF cannot be read (a 404, CORS, not a TIFF): the source only goes
 * to the `error` state.
 */
function viewOf(source: EnhancedGeoTIFF): ReturnType<EnhancedGeoTIFF['getView']> {
  return new Promise((resolve, reject) => {
    const failed = () => {
      if (source.getState() !== 'error') return false;
      unByKey(key);
      reject(source.getError() ?? new Error('The GeoTIFF could not be read.'));
      return true;
    };
    const key = source.on('change', failed);
    if (failed()) return;
    source.getView().then(
      (view) => {
        unByKey(key);
        resolve(view);
      },
      (error) => {
        unByKey(key);
        reject(error);
      },
    );
  });
}

/** The default placement: centered on the view, 80 % of it, keeping the picture's shape. */
export function placeOverView(size: { width: number; height: number }, map: OlMap): ImagePlacement {
  const view = map.getView();
  const mapSize = map.getSize() ?? [512, 512];
  const projection = view.getProjection();
  let extent = view.calculateExtent(mapSize);
  let epsg = epsgCode(projection.getCode());
  if (epsg === null) {
    // A projection without an EPSG code: place the picture in Web Mercator instead.
    extent = transformExtent(extent, projection, 'EPSG:3857');
    epsg = 3857;
  }
  const scale = Math.min((0.8 * getWidth(extent)) / size.width, (0.8 * getHeight(extent)) / size.height);
  const [cx, cy] = getCenter(extent);
  const w = (size.width * scale) / 2;
  const h = (size.height * scale) / 2;
  return { extent: [cx - w, cy - h, cx + w, cy + h], epsg };
}

function epsgCode(code: string): number | null {
  if (code === 'CRS:84') return 4326;
  const m = /^(?:EPSG:|urn:ogc:def:crs:EPSG:[^:]*:|http:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)(\d+)$/.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  // OpenLayers' aliases of Web Mercator; GeoTIFF keys are 16-bit, so larger codes cannot be written.
  if (n === 900913 || n === 102100 || n === 102113) return 3857;
  return n <= 65535 ? n : null;
}

/** TIFF magic number: "II*\0" or "MM\0*" (BigTIFF has 43 in place of 42). */
async function isTiff(file: Blob): Promise<boolean> {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return (b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 42 || b[3] === 43));
}

const FOLDER_ICON = 'M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.5 2h7.5A1.5 1.5 0 0 1 18 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 15.5z';
const LINK_ICON = 'M8.5 11.5l3-3M7 9.5l-1.6 1.6a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.6-1.6a2.5 2.5 0 0 0-3.5-3.5L9.5 7';
