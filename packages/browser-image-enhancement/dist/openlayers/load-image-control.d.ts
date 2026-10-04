import EnhancedGeoTIFF, { EnhancedGeoTIFFOptions } from "./enhanced-geotiff.js";
import { Extent } from "ol/extent.js";
import Control from "ol/control/Control.js";
import BaseEvent from "ol/events/Event.js";
import OlMap from "ol/Map.js";
import Layer from "ol/layer/Layer.js";
//#region src/openlayers/load-image-control.d.ts
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
export declare class LoadImageEvent extends BaseEvent {
  /** What was loaded (`load`). */
  readonly loaded: LoadedImage | null;
  /** Why it failed (`error`). */
  readonly error: unknown;
  /** File name or URL. */
  readonly name: string;
  constructor(type: 'load' | 'error',
  /** What was loaded (`load`). */
  loaded: LoadedImage | null,
  /** Why it failed (`error`). */
  error?: unknown,
  /** File name or URL. */
  name?: string);
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
export declare const loadImageLabelsEn: LoadImageLabels;
/** Japanese texts. */
export declare const loadImageLabelsJa: LoadImageLabels;
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
   * else corrected in workers. Images deeper than 8 bits (16-bit, float) are
   * read raw (`normalize: 'auto'`) and stretched band by band from their own
   * values, cutting 2 % at each end like QGIS's default
   * (`rawStretch: { lowPercent: 2, highPercent: 2 }`).
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
  placement?: (size: {
    width: number;
    height: number;
  }, map: OlMap) => ImagePlacement;
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
  /**
   * Called instead of the file chooser when the open button is pressed, for
   * choosing files another way (for example `showOpenFilePicker`, to keep the
   * file handles). Call {@link LoadImageControl.openChooser} to fall back to
   * the chooser, and `loadFile` or your `onFiles` with the files chosen.
   */
  onOpen?: () => void;
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
  private readonly options_;
  private readonly file_;
  private undrop_;
  private busy_;
  constructor(options?: LoadImageControlOptions);
  /** Opens the browser's file chooser, as the open button does without `onOpen`. */
  openChooser(): void;
  /** Whether a load is in progress. */
  isLoading(): boolean;
  /**
   * Loads a GeoTIFF, or an ordinary picture placed over the view. Resolves
   * with the new source once it is on the layer (and the map fitted to it).
   */
  loadFile(file: Blob, name?: string): Promise<EnhancedGeoTIFF>;
  /** Loads a COG (or any GeoTIFF the server allows range requests on) from `url`. */
  loadUrl(url: string): Promise<EnhancedGeoTIFF>;
  setMap(map: OlMap | null): void;
  /** Chosen or dropped files: to `onFiles`, else the first one is opened. */
  private takeFiles_;
  protected disposeInternal(): void;
  private track_;
  private show_;
}
/** The default placement: centered on the view, 80 % of it, keeping the picture's shape. */
export declare function placeOverView(size: {
  width: number;
  height: number;
}, map: OlMap): ImagePlacement;
//#endregion
//# sourceMappingURL=load-image-control.d.ts.map