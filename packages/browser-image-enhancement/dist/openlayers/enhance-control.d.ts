import { Pipeline } from "../pipeline.js";
import EnhancedGeoTIFF from "./enhanced-geotiff.js";
import Control from "ol/control/Control.js";
import OlMap from "ol/Map.js";
import Layer from "ol/layer/Layer.js";
//#region src/openlayers/enhance-control.d.ts
/** Steps a slider can set: those with number parameters. */
export type SliderOp = 'brightness' | 'contrast' | 'exposure' | 'gamma' | 'saturation' | 'temperature' | 'levels' | 'sharpen';
/** One slider of an {@link EnhanceControl}. Ranges not given come from `opInfo`. */
export interface EnhanceSlider {
  /** The step the slider sets. */
  op: SliderOp;
  /** The parameter; default the step's main value (`opInfo[op].value`). Required for `levels`. */
  param?: string;
  /** Text before the slider. Default: the label for `op` or `op.param` in `labels`. */
  label?: string;
  /** Left end of the slider. */
  min?: number;
  /** Right end of the slider. */
  max?: number;
  /** Slider step. */
  step?: number;
  /** The neutral value, set by reset. Default: the parameter's default in `opInfo` (0 for the sharpen amount). */
  value?: number;
}
/** Texts of the control, by key. Slider labels use the step name (`exposure`) or `step.param` (`levels.inBlack`). */
export type EnhanceLabels = Record<string, string>;
/** English texts (the default). */
export declare const enhanceLabelsEn: EnhanceLabels;
/** Japanese texts. */
export declare const enhanceLabelsJa: EnhanceLabels;
/** The sliders shown when `sliders` is not given, with ranges that suit a slider. */
export declare const defaultEnhanceSliders: readonly EnhanceSlider[];
/** DRA settings of an {@link EnhanceControl}. */
export interface EnhanceDra {
  /** DRA on (an `autoStretch` step first in the pipeline). */
  enabled: boolean;
  /** How the range is found (see `AutoStretchOptions.method`). */
  method: 'percentClip' | 'minMax' | 'standardDeviation';
  /** Percent clipped at each end (`percentClip`). */
  clip: number;
  /** One range for R, G and B instead of one per channel. */
  linked: boolean;
}
/** Options for {@link EnhanceControl}. */
export interface EnhanceControlOptions {
  /**
   * The layer whose source is corrected (an {@link EnhancedGeoTIFF}). A new
   * source set on the layer, for example by a `LoadImageControl`, gets the
   * current correction. Also gives the opacity slider. The sliders replace
   * the pipeline the source was created with.
   */
  layer?: Layer;
  /** The source to correct, when there is no `layer`. */
  source?: EnhancedGeoTIFF;
  /** The sliders, in order. Default {@link defaultEnhanceSliders}. */
  sliders?: readonly EnhanceSlider[];
  /** Show the DRA settings (default true). */
  dra?: boolean;
  /** DRA settings at the start. Default: off, percent clip 0.5 %, not linked. */
  draSettings?: Partial<EnhanceDra>;
  /** Show an opacity slider for `layer` (default true). */
  opacity?: boolean;
  /** Texts; missing keys come from {@link enhanceLabelsEn}. {@link enhanceLabelsJa} has Japanese. */
  labels?: EnhanceLabels;
  /** Start with the panel closed (default true). */
  collapsed?: boolean;
  /** Add the default styles to the document (default true). */
  css?: boolean;
  /** Extra class names for the control element. */
  className?: string;
  /** Put the control in this element instead of the map's overlay container. */
  target?: HTMLElement | string;
  /** Called with the new pipeline after each change (at most once per frame). */
  onChange?: (p: Pipeline) => void;
}
/**
 * A map control with correction sliders for an {@link EnhancedGeoTIFF}. Fires
 * `change` after each new pipeline.
 *
 * @example
 * ```ts
 * const layer = new GpuCorrectedTileLayer({ source: new EnhancedGeoTIFF({ sources: [{ url }], correctTiles: false }) });
 * map.addLayer(layer);
 * map.addControl(new EnhanceControl({ layer, labels: enhanceLabelsJa }));
 * ```
 */
export default class EnhanceControl extends Control {
  private readonly layer_;
  private source_;
  private readonly rows_;
  private readonly labels_;
  private readonly onChange_?;
  private readonly panel_;
  private readonly toggle_;
  private readonly enabled_;
  private readonly dra_;
  private readonly draDefaults_;
  private pipeline_;
  private frame_;
  private mapKeys_;
  private sourceKeys_;
  constructor(options?: EnhanceControlOptions);
  /** The source being corrected: `source`, or the layer's source when it is an {@link EnhancedGeoTIFF}. */
  getSource(): EnhancedGeoTIFF | null;
  /** Corrects `source` instead (only when the control was not given a `layer`). */
  setSource(source: EnhancedGeoTIFF | null): void;
  /** The correction the sliders set now. */
  getPipeline(): Pipeline;
  /**
   * Moves the sliders (and DRA) to the values of `p`, for example a saved
   * preset (`Pipeline.fromJSON`). Steps without a slider are left out.
   */
  setPipeline(p: Pipeline): void;
  /** Puts every slider back to its neutral value (DRA to its starting settings). */
  reset(): void;
  /** Whether the panel is closed. */
  getCollapsed(): boolean;
  /** Opens (false) or closes (true) the panel. */
  setCollapsed(collapsed: boolean): void;
  setMap(map: OlMap | null): void;
  protected disposeInternal(): void;
  /** Gives a newly set source the current correction, and follows its color mode. */
  private bindSource_;
  private updateColorRows_;
  private setRow_;
  /** Slider moves are coalesced to one new pipeline per frame. */
  private schedule_;
  private apply_;
  private build_;
}
//#endregion
//# sourceMappingURL=enhance-control.d.ts.map