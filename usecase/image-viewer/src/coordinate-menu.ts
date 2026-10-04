/**
 * Right-click menu that copies the coordinates of the clicked point:
 * latitude / longitude, MGRS, UTM, the coordinates in the image's own CRS
 * (for a GeoTIFF in another CRS), and pixel coordinates when the point is on
 * an image. The image is the selected one when the point is on it, else the
 * topmost visible image under the point. On an ordinary picture, which has
 * no location, latitude / longitude are left out.
 */
import type OlMap from 'ol/Map.js';
import { containsCoordinate } from 'ol/extent.js';
import { get as getProjection, transform, transformExtent } from 'ol/proj.js';
import type { Coordinate } from 'ol/coordinate.js';
import type { ImageList, ViewerImage } from './images.js';
import { pixelOf } from './points.js';
import { formatLatLon, formatMgrs, formatUtm, utmEpsg, utmZone, type LonLat } from './coordinates.js';

/** One way to copy the point. */
export interface CoordinateItem {
  /** What the value is, e.g. `緯度, 経度` or `EPSG:32654`. */
  label: string;
  /** The text copied. */
  value: string;
}

export interface CoordinateMenuOptions {
  /** Shows a message to the user. */
  say: (message: string) => void;
}

export class CoordinateMenu {
  /** The menu element (hidden when closed). */
  readonly element = document.createElement('div');

  constructor(
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: CoordinateMenuOptions,
  ) {
    const menu = this.element;
    menu.className = 'coordinate-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '座標をコピー');
    menu.hidden = true;
    map.getViewport().append(menu);

    map.getViewport().addEventListener('contextmenu', (e) => {
      if (menu.contains(e.target as Node)) return;
      e.preventDefault();
      const rect = map.getViewport().getBoundingClientRect();
      void this.openAt([e.clientX - rect.left, e.clientY - rect.top]);
    });
    // Anything else closes it.
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target as Node)) this.close();
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
      else return;
      e.preventDefault();
    });
    map.on('movestart', () => this.close());
  }

  /** The ways to copy the map coordinate `at` (view projection). */
  async itemsAt(at: Coordinate): Promise<CoordinateItem[]> {
    const viewProjection = this.map.getView().getProjection();
    const image = await this.imageAt_(at);
    const items: CoordinateItem[] = [];
    let utm: string | null = null;
    if (image?.kind !== 'image') {
      const lonLat = transform(at, viewProjection, 'EPSG:4326') as LonLat;
      items.push({ label: '緯度, 経度', value: formatLatLon(lonLat) });
      const mgrs = formatMgrs(lonLat);
      if (mgrs) items.push({ label: 'MGRS', value: mgrs });
      const zone = utmZone(lonLat);
      const text = formatUtm(lonLat);
      if (zone !== null && text) {
        items.push({ label: 'UTM', value: text });
        utm = utmEpsg(zone, lonLat[1] >= 0);
      }
    }
    if (image?.kind === 'geotiff') {
      const view = await image.source.getView();
      const own = view.projection ? getProjection(view.projection) : null;
      const code = own?.getCode();
      // The image's own CRS, unless it is WGS 84 or the UTM zone already listed.
      if (own && code && code !== 'EPSG:4326' && code !== 'CRS:84' && code !== utm) {
        const [x, y] = transform(at, viewProjection, own);
        const digits = own.getUnits() === 'degrees' ? 6 : 2;
        items.push({ label: code, value: `${x.toFixed(digits)}, ${y.toFixed(digits)}` });
      }
    }
    if (image) {
      const [x, y] = await pixelOf(image, at, viewProjection);
      items.push({ label: '画素 (x, y)', value: `${x}, ${y}` });
    }
    return items;
  }

  /** Opens the menu at `pixel` (map viewport pixels). */
  async openAt(pixel: [number, number]): Promise<void> {
    const at = this.map.getCoordinateFromPixel(pixel);
    const items = await this.itemsAt(at);
    const menu = this.element;
    menu.replaceChildren(
      ...items.map((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        const label = document.createElement('span');
        label.className = 'coordinate-label';
        label.textContent = item.label;
        const value = document.createElement('span');
        value.className = 'coordinate-value';
        value.textContent = item.value;
        b.append(label, value);
        b.title = `${item.label} をコピー`;
        b.addEventListener('click', () => void this.copy_(item));
        return b;
      }),
    );
    menu.hidden = false;
    // Keep it inside the viewport.
    const [w, h] = this.map.getSize() ?? [0, 0];
    menu.style.left = `${Math.max(0, Math.min(pixel[0], w - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(pixel[1], h - menu.offsetHeight - 4))}px`;
    menu.querySelector('button')?.focus();
  }

  close(): void {
    this.element.hidden = true;
  }

  private async copy_(item: CoordinateItem): Promise<void> {
    this.close();
    try {
      await navigator.clipboard.writeText(item.value);
    } catch {
      // Without the async clipboard (an insecure origin, a denied permission): the old way.
      const area = document.createElement('textarea');
      area.value = item.value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) {
        this.options.say(`コピーできませんでした: ${item.value}`);
        return;
      }
    }
    this.options.say(`${item.label} をコピーしました: ${item.value}`);
  }

  /** The image the point is on: the selected one if it is on it, else the topmost visible one. */
  private async imageAt_(at: Coordinate): Promise<ViewerImage | null> {
    const selected = this.images.selected();
    const candidates = [...(selected ? [selected] : []), ...this.images.list().filter((i) => i !== selected && i.layer.getVisible())];
    for (const image of candidates) {
      const view = await image.source.getView().catch(() => null);
      if (!view?.extent) continue;
      const extent = transformExtent(view.extent, view.projection ?? 'EPSG:4326', this.map.getView().getProjection());
      if (containsCoordinate(extent, at)) return image;
    }
    return null;
  }
}
