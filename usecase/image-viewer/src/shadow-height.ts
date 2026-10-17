/**
 * Height from a shadow (影から高さを測る): click the foot of a building, a
 * tower or a tree, then the tip of its shadow; the height is the shadow's
 * length times the tangent of the Sun's elevation.
 *
 * Both clicks are on the ground, so the length is right in an orthorectified
 * image whatever the satellite's viewing angle (the top of the building leans
 * away in an oblique view, its shadow on the ground does not). The ground is
 * taken as flat between the two points.
 *
 * The Sun's elevation and azimuth come, best first, from what the image says
 * (GDAL metadata items such as SUN_ELEVATION, Maxar's MEANSUNEL, Planet's
 * sun_elevation, NITF USE00A), else from when it was taken (see
 * `imageTime`) and where the foot is, else as typed. With an azimuth, a
 * guide shows which way the shadow falls and the second click snaps onto it.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { transform } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { FeatureLike } from 'ol/Feature.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { GeoTIFFImage } from 'geotiff';
import type { ImageList, ViewerImage } from './images.js';
import type { LonLat } from './coordinates.js';
import { formatLength, geodesicLength } from './geodesic.js';
import { sunAngles } from './imaging-plan.js';
import { imageTime, imageTimeOrigins } from './timeline.js';

/** The Sun as seen when the image was taken, in degrees. */
export interface Sun {
  elevation: number;
  /** Clockwise from north; null when unknown (then shadows are not snapped). */
  azimuth: number | null;
}

/** Where the Sun's angles came from. */
export type SunOrigin = { kind: 'metadata'; item: string } | { kind: 'time'; time: number; origin: string } | { kind: 'manual' };

/** One shadow measured. */
export interface ShadowMeasurement {
  /** The foot and the tip of the shadow, as longitude / latitude (view coordinates for a picture). */
  foot: Coordinate;
  tip: Coordinate;
  /** Length of the shadow and the height: metres, or pixels on a picture without a location. */
  shadow: number;
  height: number;
  unit: 'm' | 'px';
  sunElevation: number;
  sunAzimuth: number | null;
}

/** Item names of GDAL metadata that hold the Sun's elevation (or zenith) and azimuth, best first. */
const ELEVATION = [/^(mean_?)?sun_?el(evation)?(_angle)?$/i, /^nitf_use00a_sun_el$/i, /sun_?elev|solar_?elev|sun_?el\b|sunel/i];
const ZENITH = [/^(mean_?)?(sun|solar)_?zenith(_angle)?$/i, /(sun|solar)_?zen/i];
const AZIMUTH = [/^(mean_?)?sun_?az(imuth)?(_angle)?$/i, /^nitf_use00a_sun_az$/i, /sun_?azi|solar_?azi|sun_?az\b|sunaz/i];

/** The first item whose name matches one of `patterns` (in their order) and whose value is a number. */
function itemValue(items: ReadonlyArray<[string, string]>, patterns: readonly RegExp[]): { name: string; value: number } | null {
  for (const re of patterns) {
    for (const [name, raw] of items) {
      if (!re.test(name)) continue;
      const value = Number(raw.trim().split(/[\s,]+/)[0]);
      if (raw.trim() && Number.isFinite(value)) return { name, value };
    }
  }
  return null;
}

/** The Sun's angles in GDAL metadata (TIFF tag 42112), or null when it does not say. */
export function sunFromGdalMetadata(xml: string): (Sun & { item: string }) | null {
  const items: Array<[string, string]> = [];
  for (const m of xml.matchAll(/<Item\b[^>]*\bname="([^"]+)"[^>]*>([^<]*)<\/Item>/g)) items.push([m[1], m[2]]);
  const el = itemValue(items, ELEVATION);
  const zenith = el ? null : itemValue(items, ZENITH);
  const elevation = el ? el.value : zenith ? 90 - zenith.value : NaN;
  // NITF writes 999.9 when it does not know.
  if (!Number.isFinite(elevation) || elevation <= 0 || elevation > 90) return null;
  const az = itemValue(items, AZIMUTH);
  const azimuth = az && az.value >= 0 && az.value <= 360 ? az.value % 360 : null;
  return { elevation, azimuth, item: (el ?? zenith)!.name };
}

/** Height of what casts a shadow of `shadow` length with the Sun `elevation` degrees up. */
export function heightFromShadow(shadow: number, elevation: number): number {
  return shadow * Math.tan((elevation * Math.PI) / 180);
}

/** Which way shadows fall: away from the Sun, clockwise from north. */
export function shadowAzimuth(sunAzimuth: number): number {
  return (sunAzimuth + 180) % 360;
}

/** A point `metres` from `lonLat` toward `azimuth` (degrees), close enough for the few metres a direction needs. */
export function stepToward([lon, lat]: LonLat, azimuth: number, metres: number): LonLat {
  const a = (azimuth * Math.PI) / 180;
  const perDegree = 111_320;
  return [lon + (Math.sin(a) * metres) / (perDegree * Math.cos((lat * Math.PI) / 180)), lat + (Math.cos(a) * metres) / perDegree];
}

/** `tip` moved onto the ray from `from` along `direction` (view coordinates): the nearest point of the ray. */
export function snapToRay(from: Coordinate, direction: Coordinate, tip: Coordinate): Coordinate {
  const len = Math.hypot(direction[0], direction[1]);
  if (!len) return tip;
  const ux = direction[0] / len;
  const uy = direction[1] / len;
  const t = Math.max(0, (tip[0] - from[0]) * ux + (tip[1] - from[1]) * uy);
  return [from[0] + ux * t, from[1] + uy * t];
}

/** The GDAL metadata of an image, if it has any. */
async function gdalMetadataOf(image: ViewerImage): Promise<string | null> {
  let tiff: GeoTIFFImage | undefined;
  try {
    tiff = (image.source.getTiffImages() as GeoTIFFImage[][])[0]?.[0];
  } catch {
    return null;
  }
  const fd = tiff?.fileDirectory as { hasTag?: (t: number) => boolean; loadValue?: (t: number) => Promise<unknown> } | undefined;
  if (!fd?.hasTag?.(42112) || !fd.loadValue) return null;
  const v = await fd.loadValue(42112).catch(() => null);
  return typeof v === 'string' ? v : null;
}

export interface ShadowHeightOptions {
  /** The tool's toggle. */
  button: HTMLButtonElement;
  say: (message: string) => void;
  /** Called when the tool is turned on, so other click tools can step aside. */
  onStart?: () => void;
}

const COLOR = '#ff8a00';
const HALO = '#000a';
const GUIDE = 80; // pixels of the guide line on the screen

export class ShadowHeightTool {
  readonly panel: HTMLElement;
  private readonly source_ = new VectorSource<Feature>();
  private readonly layer_: VectorLayer<VectorSource<Feature>>;
  private readonly elevation_: HTMLInputElement;
  private readonly azimuth_: HTMLInputElement;
  private readonly time_: HTMLInputElement;
  private readonly snap_: HTMLInputElement;
  private readonly originText_: HTMLElement;
  private readonly list_: HTMLOListElement;
  private readonly clear_: HTMLButtonElement;
  private active_ = false;
  /** The foot clicked, waiting for the tip. */
  private foot_: Coordinate | null = null;
  private readonly guide_ = new Feature<LineString>();
  private readonly cursor_ = new Feature<LineString>();
  private sun_: Sun | null = null;
  private sunOrigin_: SunOrigin | null = null;
  /** The image the Sun was read for. */
  private readFor_: ViewerImage | null | undefined = undefined;
  /** The time the Sun is computed from, when not from the metadata. */
  private when_: { time: number; origin: string } | null = null;
  private readonly measurements_: ShadowMeasurement[] = [];

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: ShadowHeightOptions,
  ) {
    this.layer_ = new VectorLayer({ source: this.source_, zIndex: 10_001, style: (f) => this.style_(f) });
    this.panel = document.createElement('div');
    this.panel.className = 'shadow-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', '影から高さを測る');
    this.panel.innerHTML = `
      <div class="shadow-row"><strong>影から高さを測る</strong><span class="shadow-hint">根元、影の先端の順にクリック</span></div>
      <div class="shadow-row">
        <label>太陽高度 <input type="number" name="elevation" min="0.1" max="90" step="0.1" inputmode="decimal" aria-label="太陽高度（度）">°</label>
        <label>方位 <input type="number" name="azimuth" min="0" max="360" step="0.1" inputmode="decimal" aria-label="太陽の方位（度、北から時計回り）">°</label>
        <label class="shadow-snap"><input type="checkbox" name="snap" checked> 影の向きに合わせる</label>
      </div>
      <p class="shadow-origin" role="status"></p>
      <details class="shadow-more">
        <summary>撮影日時から計算</summary>
        <label>撮影日時（UTC） <input type="datetime-local" name="time" step="1" aria-label="撮影日時（UTC）"></label>
      </details>
      <ol class="shadow-list" aria-label="測った高さ"></ol>
      <div class="shadow-row">
        <button type="button" value="clear">消去</button>
        <button type="button" value="close">終了</button>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => this.panel.querySelector<T>(s)!;
    this.elevation_ = q('input[name=elevation]');
    this.azimuth_ = q('input[name=azimuth]');
    this.time_ = q('input[name=time]');
    this.snap_ = q('input[name=snap]');
    this.originText_ = q('.shadow-origin');
    this.list_ = q('.shadow-list');
    this.clear_ = q('button[value=clear]');
    this.clear_.addEventListener('click', () => this.clear());
    q('button[value=close]').addEventListener('click', () => this.setActive(false));
    const typed = () => {
      const elevation = Number(this.elevation_.value);
      const azimuth = this.azimuth_.value.trim() === '' ? null : Number(this.azimuth_.value);
      this.setSun(elevation > 0 && elevation <= 90 ? { elevation, azimuth: azimuth !== null && Number.isFinite(azimuth) ? azimuth % 360 : null } : null);
    };
    this.elevation_.addEventListener('change', typed);
    this.azimuth_.addEventListener('change', typed);
    this.time_.addEventListener('change', () => {
      const t = Date.parse(`${this.time_.value}Z`);
      this.when_ = Number.isFinite(t) ? { time: t, origin: imageTimeOrigins.manual } : null;
      this.fromTime_(this.foot_ ?? this.map.getView().getCenter() ?? null);
    });
    this.snap_.addEventListener('change', () => this.source_.changed());
    (map.getViewport().parentElement ?? document.body).append(this.panel);

    options.button.addEventListener('click', () => this.setActive(!this.active_));
    map.on('singleclick', (e) => {
      if (this.active_) void this.click_(e.coordinate);
    });
    map.on('pointermove', (e: MapBrowserEvent) => {
      if (this.active_ && this.foot_) this.cursor_.setGeometry(new LineString([this.foot_, this.tipFor_(e.coordinate)]));
    });
    map.getView().on('change:resolution', () => this.updateGuide_());
    document.addEventListener('keydown', (e) => {
      if (!this.active_ || e.key !== 'Escape' || (e.target as HTMLElement).closest?.('dialog')) return;
      if (this.foot_) this.dropFoot_();
      else this.setActive(false);
    });
    this.update_();
  }

  isActive(): boolean {
    return this.active_;
  }

  setActive(active: boolean): void {
    if (active === this.active_) return;
    this.active_ = active;
    this.options.button.setAttribute('aria-pressed', String(active));
    this.panel.hidden = !active;
    this.map.getViewport().classList.toggle('measuring', active);
    this.dropFoot_();
    if (active) {
      this.options.onStart?.();
      this.map.addLayer(this.layer_);
      void this.prepare_();
      this.options.say('建物などの根元をクリックし、次に影の先端をクリックします（Esc で取り消し）');
    } else {
      this.map.removeLayer(this.layer_);
    }
  }

  /** The Sun the heights are worked out with (null: not known yet). */
  sun(): Sun | null {
    return this.sun_;
  }

  /** Sets the Sun's angles by hand (null: unknown). */
  setSun(sun: Sun | null): void {
    this.sun_ = sun;
    this.sunOrigin_ = sun ? { kind: 'manual' } : null;
    this.showSun_();
  }

  /** The heights measured, oldest first. */
  list(): ShadowMeasurement[] {
    return [...this.measurements_];
  }

  /** Measures the shadow from `foot` to `tip` (view coordinates); null while the Sun is unknown. */
  measure(foot: Coordinate, tip: Coordinate): ShadowMeasurement | null {
    if (!this.sun_) return null;
    const pixel = this.pixelSize_();
    const projection = this.map.getView().getProjection();
    const shadow = pixel ? Math.hypot(tip[0] - foot[0], tip[1] - foot[1]) / pixel : geodesicLength([foot, tip].map((c) => transform(c, projection, 'EPSG:4326') as LonLat));
    return {
      foot: pixel ? foot : transform(foot, projection, 'EPSG:4326'),
      tip: pixel ? tip : transform(tip, projection, 'EPSG:4326'),
      shadow,
      height: heightFromShadow(shadow, this.sun_.elevation),
      unit: pixel ? 'px' : 'm',
      sunElevation: this.sun_.elevation,
      sunAzimuth: this.sun_.azimuth,
    };
  }

  /** Removes every height measured. */
  clear(): void {
    this.measurements_.length = 0;
    this.source_.clear();
    this.dropFoot_();
    this.update_();
  }

  /** Reads the Sun for the selected image: its metadata, else (at the first click) when it was taken. */
  private async prepare_(): Promise<void> {
    const image = this.images.selected();
    if (this.readFor_ === image && this.sun_) return;
    this.readFor_ = image;
    if (this.sunOrigin_?.kind !== 'manual') {
      this.sun_ = null;
      this.sunOrigin_ = null;
    }
    this.when_ = null;
    if (image) {
      const xml = await gdalMetadataOf(image);
      const fromMetadata = xml ? sunFromGdalMetadata(xml) : null;
      if (fromMetadata) {
        this.sun_ = { elevation: fromMetadata.elevation, azimuth: fromMetadata.azimuth };
        this.sunOrigin_ = { kind: 'metadata', item: fromMetadata.item };
      } else {
        const when = await imageTime(image).catch(() => null);
        if (when) this.when_ = { time: when.time, origin: imageTimeOrigins[when.origin] };
        if (this.sunOrigin_?.kind !== 'manual') this.fromTime_(this.map.getView().getCenter() ?? null);
      }
    }
    if (this.when_) this.time_.value = new Date(this.when_.time).toISOString().slice(0, 19);
    this.showSun_();
  }

  /** The Sun at `at` (view coordinates) at the time known, if any. */
  private fromTime_(at: Coordinate | null): void {
    if (!this.when_ || !at || this.pixelSize_()) {
      this.showSun_();
      return;
    }
    const lonLat = transform(at, this.map.getView().getProjection(), 'EPSG:4326') as LonLat;
    const { elevation, azimuth } = sunAngles(lonLat, this.when_.time);
    this.sun_ = elevation > 0 ? { elevation, azimuth } : null;
    this.sunOrigin_ = { kind: 'time', ...this.when_ };
    this.showSun_();
    if (elevation <= 0) this.options.say(`その日時は太陽が地平線の下です（太陽高度 ${elevation.toFixed(1)}°）`);
  }

  private showSun_(): void {
    const sun = this.sun_;
    this.elevation_.value = sun ? sun.elevation.toFixed(2) : '';
    this.azimuth_.value = sun?.azimuth != null ? sun.azimuth.toFixed(2) : '';
    const o = this.sunOrigin_;
    this.originText_.textContent = !sun
      ? '太陽高度が分かりません。入力するか、撮影日時を入れてください'
      : o?.kind === 'metadata'
        ? `画像のメタデータ（${o.item}）から`
        : o?.kind === 'time'
          ? `撮影日時 ${new Date(o.time).toISOString().slice(0, 19).replace('T', ' ')} UTC（${o.origin}）と位置から計算`
          : '手入力';
    this.snap_.disabled = sun?.azimuth == null;
    this.updateGuide_();
  }

  private async click_(at: Coordinate): Promise<void> {
    if (!this.foot_) {
      if (this.readFor_ !== this.images.selected()) await this.prepare_();
      // The Sun computed from the time at the foot itself.
      if (this.sunOrigin_?.kind === 'time' || (!this.sun_ && this.when_)) this.fromTime_(at);
      if (!this.sun_) {
        this.options.say('太陽高度が分かりません。パネルに太陽高度か撮影日時を入れてください');
        return;
      }
      this.foot_ = at;
      this.source_.addFeature(this.guide_);
      this.source_.addFeature(this.cursor_);
      this.cursor_.setGeometry(new LineString([at, at]));
      this.updateGuide_();
      this.options.say('影の先端をクリックしてください（Esc で取り消し）');
      return;
    }
    const tip = this.tipFor_(at);
    const foot = this.foot_;
    const resolution = this.map.getView().getResolution() ?? 1;
    if (Math.hypot(tip[0] - foot[0], tip[1] - foot[1]) < resolution) {
      const toward = this.sun_?.azimuth != null && this.snap_.checked ? `（影は方位 ${shadowAzimuth(this.sun_.azimuth).toFixed(0)}° の向きに落ちます）` : '';
      this.options.say(`根元と同じ所です。影の先端をクリックしてください${toward}`);
      return;
    }
    const m = this.measure(foot, tip);
    this.dropFoot_();
    if (!m) return;
    this.measurements_.push(m);
    const feature = new Feature({ geometry: new LineString([foot, tip]) });
    feature.set('label', `高さ ${this.format_(m.height, m.unit)}`);
    this.source_.addFeature(feature);
    this.update_();
    this.options.say(`高さ ${this.format_(m.height, m.unit)}（影 ${this.format_(m.shadow, m.unit)}、太陽高度 ${m.sunElevation.toFixed(1)}°）`);
  }

  /** Where the second click goes: onto the shadow's direction when snapping. */
  private tipFor_(at: Coordinate): Coordinate {
    const direction = this.direction_();
    return this.foot_ && direction && this.snap_.checked ? snapToRay(this.foot_, direction, at) : at;
  }

  /** The direction shadows fall in view coordinates at the foot, or null when the azimuth is unknown. */
  private direction_(): Coordinate | null {
    const azimuth = this.sun_?.azimuth;
    if (!this.foot_ || azimuth == null || this.pixelSize_()) return null;
    const projection = this.map.getView().getProjection();
    const lonLat = transform(this.foot_, projection, 'EPSG:4326') as LonLat;
    const step = transform(stepToward(lonLat, shadowAzimuth(azimuth), 10), 'EPSG:4326', projection);
    return [step[0] - this.foot_[0], step[1] - this.foot_[1]];
  }

  private updateGuide_(): void {
    const direction = this.direction_();
    if (!this.foot_ || !direction) {
      this.guide_.setGeometry(undefined);
      return;
    }
    const len = Math.hypot(direction[0], direction[1]);
    const reach = GUIDE * (this.map.getView().getResolution() ?? 1);
    this.guide_.setGeometry(new LineString([this.foot_, [this.foot_[0] + (direction[0] / len) * reach, this.foot_[1] + (direction[1] / len) * reach]]));
  }

  private dropFoot_(): void {
    this.foot_ = null;
    if (this.source_.hasFeature(this.guide_)) this.source_.removeFeature(this.guide_);
    if (this.source_.hasFeature(this.cursor_)) this.source_.removeFeature(this.cursor_);
  }

  /** View units per pixel of the selected picture without a location; null for anything on the Earth. */
  private pixelSize_(): number | null {
    const image = this.images.selected();
    if (image?.kind !== 'image' || this.images.selectedLayer() !== image) return null;
    const grid = image.source.getTileGrid()?.getResolutions();
    return grid?.length ? Math.min(...grid) : 1;
  }

  private format_(value: number, unit: 'm' | 'px'): string {
    return unit === 'px' ? `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })} px` : value < 1000 ? `${value.toFixed(1)} m` : formatLength(value);
  }

  private update_(): void {
    this.clear_.disabled = this.measurements_.length === 0;
    this.list_.replaceChildren(
      ...this.measurements_.map((m) => {
        const li = document.createElement('li');
        li.textContent = `${this.format_(m.height, m.unit)}（影 ${this.format_(m.shadow, m.unit)}・太陽高度 ${m.sunElevation.toFixed(1)}°）`;
        return li;
      }),
    );
    this.list_.hidden = this.measurements_.length === 0;
  }

  private style_(feature: FeatureLike): Style[] {
    const geometry = feature.getGeometry();
    if (!(geometry instanceof LineString)) return [];
    if (feature === this.guide_) {
      return [new Style({ stroke: new Stroke({ color: HALO, width: 3.5 }) }), new Style({ stroke: new Stroke({ color: '#fff', width: 1.5, lineDash: [5, 5] }) })];
    }
    const done = feature !== this.cursor_;
    const [foot, tip] = geometry.getCoordinates();
    const styles = [
      new Style({ stroke: new Stroke({ color: HALO, width: 5 }) }),
      new Style({ stroke: new Stroke({ color: COLOR, width: 2.5, lineDash: done ? undefined : [8, 6] }) }),
      new Style({ geometry: new Point(foot), image: new Circle({ radius: 4, fill: new Fill({ color: COLOR }), stroke: new Stroke({ color: HALO, width: 1.5 }) }) }),
      new Style({ geometry: new Point(tip), image: new Circle({ radius: 3, fill: new Fill({ color: '#fff' }), stroke: new Stroke({ color: HALO, width: 1.5 }) }) }),
    ];
    let label = feature.get('label') as string | undefined;
    if (!done && this.foot_) {
      const m = this.measure(foot, tip);
      label = m && m.shadow > 0 ? `高さ ${this.format_(m.height, m.unit)}` : undefined;
    }
    if (label) {
      styles.push(
        new Style({
          geometry: new Point(foot),
          text: new Text({
            text: label,
            offsetY: -16,
            font: '600 13px system-ui, sans-serif',
            fill: new Fill({ color: '#fff' }),
            backgroundFill: new Fill({ color: '#000b' }),
            padding: [2, 5, 2, 5],
            overflow: true,
          }),
        }),
      );
    }
    return styles;
  }
}
