/**
 * The latitude / longitude (WGS 84, EPSG:4326) under the cursor, in small text
 * at the map's bottom left while the cursor is on the map. The notation
 * (decimal degrees, degrees / minutes / seconds, MGRS or UTM) is picked at the
 * bottom of the right-click menu and kept for the next visit. On an ordinary
 * picture, which has no location, nothing is shown.
 */
import type OlMap from 'ol/Map.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import { transform } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { ViewerImage } from './images.js';
import { formatDms, formatLatLon, formatMgrs, formatUtm, type LonLat } from './coordinates.js';

/** The notations the label can be written in. */
export const CURSOR_NOTATIONS = [
  { id: 'decimal', label: '10進', format: formatLatLon },
  { id: 'dms', label: '度分秒', format: formatDms },
  { id: 'mgrs', label: 'MGRS', format: formatMgrs },
  { id: 'utm', label: 'UTM', format: formatUtm },
] as const satisfies readonly { id: string; label: string; format: (lonLat: LonLat) => string | null }[];

export type CursorNotation = (typeof CURSOR_NOTATIONS)[number]['id'];

const STORAGE_KEY = 'image-viewer.cursor-notation';

export interface CursorPositionOptions {
  /** The image under a point, to leave out ordinary pictures (no location). */
  imageAt: (at: Coordinate) => Promise<ViewerImage | null>;
}

export class CursorPosition {
  /** The label (hidden while the cursor is off the map). */
  readonly element = document.createElement('div');
  private notation_: CursorNotation = 'decimal';
  private at_: Coordinate | null = null;
  private frame_ = 0;
  /** Counts updates, so a slow image lookup can't show an older point. */
  private seq_ = 0;

  constructor(
    private readonly map: OlMap,
    private readonly options: CursorPositionOptions,
  ) {
    const el = this.element;
    el.className = 'cursor-position';
    el.hidden = true;
    map.getTargetElement()?.append(el);
    try {
      const saved = CURSOR_NOTATIONS.find((n) => n.id === localStorage.getItem(STORAGE_KEY));
      if (saved) this.notation_ = saved.id;
    } catch {
      // No storage: decimal degrees.
    }

    map.on('pointermove', (e: MapBrowserEvent) => {
      this.at_ = e.coordinate;
      if (!this.frame_)
        this.frame_ = requestAnimationFrame(() => {
          this.frame_ = 0;
          void this.render_();
        });
    });
    map.getViewport().addEventListener('pointerleave', () => {
      this.at_ = null;
      this.seq_++;
      this.show_(false);
    });
  }

  /** The notation the label is written in. */
  get notation(): CursorNotation {
    return this.notation_;
  }

  set notation(id: CursorNotation) {
    this.notation_ = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Not kept, still switched.
    }
    void this.render_();
  }

  /** The text shown for `at` (view projection), or null to show nothing. */
  async textAt(at: Coordinate): Promise<string | null> {
    if ((await this.options.imageAt(at))?.kind === 'image') return null;
    const lonLat = transform(at, this.map.getView().getProjection(), 'EPSG:4326') as LonLat;
    if (!lonLat.every(Number.isFinite) || Math.abs(lonLat[1]) > 90) return null;
    // The map repeats the world sideways; show the longitude within ±180°.
    lonLat[0] = ((((lonLat[0] + 180) % 360) + 360) % 360) - 180;
    return CURSOR_NOTATIONS.find((n) => n.id === this.notation_)!.format(lonLat);
  }

  private async render_(): Promise<void> {
    const at = this.at_;
    const seq = ++this.seq_;
    const text = at ? await this.textAt(at) : null;
    if (seq !== this.seq_) return;
    this.show_(text !== null);
    if (text !== null) this.element.textContent = text;
  }

  private show_(shown: boolean): void {
    this.element.hidden = !shown;
    // Other labels at the bottom left (the RSET one) move up above it.
    this.map.getTargetElement()?.classList.toggle('cursor-shown', shown);
  }
}
