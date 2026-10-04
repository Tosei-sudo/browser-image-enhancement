/**
 * The list of open images: one GPU-corrected layer each, newest on top. A
 * row shows and hides its image, sets its opacity, moves it up or down,
 * zooms to it and closes it; clicking a row selects the image the
 * correction panel works on.
 */
import type OlMap from 'ol/Map.js';
import { transformExtent } from 'ol/proj.js';
import { GpuCorrectedTileLayer, type EnhancedGeoTIFF, type LoadedImage } from 'browser-image-enhancement/openlayers';

/** One open image. */
export interface ViewerImage {
  /** File name or URL. */
  name: string;
  /** `geotiff` when placed by its georeferencing, `image` when placed over the view. */
  kind: LoadedImage['kind'];
  source: EnhancedGeoTIFF;
  layer: GpuCorrectedTileLayer;
  /** The list row. */
  row: HTMLLIElement;
}

export interface ImageListOptions {
  /** Called when another image (or none) is selected. */
  onSelect: (image: ViewerImage | null) => void;
  /** Called when an image is closed, before its source is disposed. */
  onRemove?: (image: ViewerImage) => void;
  /** Called when images are added, removed or reordered. */
  onChange: (images: readonly ViewerImage[]) => void;
}

export class ImageList {
  /** Top first, as listed. */
  private images_: ViewerImage[] = [];
  private selected_: ViewerImage | null = null;

  constructor(
    private readonly element: HTMLOListElement,
    private readonly map: OlMap,
    private readonly options: ImageListOptions,
  ) {}

  /** The open images, top first. */
  list(): readonly ViewerImage[] {
    return this.images_;
  }

  selected(): ViewerImage | null {
    return this.selected_;
  }

  /** Adds a loaded image on top and selects it. */
  add({ source, name, kind }: LoadedImage): ViewerImage {
    const layer = new GpuCorrectedTileLayer({ source });
    this.map.addLayer(layer);
    const image: ViewerImage = { name, kind, source, layer, row: document.createElement('li') };
    this.buildRow_(image);
    this.images_.unshift(image);
    this.restack_();
    this.select(image);
    return image;
  }

  select(image: ViewerImage | null): void {
    if (image === this.selected_) return;
    this.selected_ = image;
    for (const i of this.images_) {
      i.row.classList.toggle('selected', i === image);
      i.row.setAttribute('aria-current', String(i === image));
    }
    this.options.onSelect(image);
  }

  /** Closes an image: its layer leaves the map and its source is disposed. */
  remove(image: ViewerImage): void {
    const index = this.images_.indexOf(image);
    if (index < 0) return;
    this.images_.splice(index, 1);
    if (this.selected_ === image) this.select(this.images_[Math.min(index, this.images_.length - 1)] ?? null);
    this.options.onRemove?.(image);
    this.map.removeLayer(image.layer);
    image.layer.dispose();
    image.source.dispose();
    this.restack_();
  }

  /** Moves an image `by` places toward the top (negative: toward the bottom). */
  move(image: ViewerImage, by: number): void {
    const from = this.images_.indexOf(image);
    const to = Math.max(0, Math.min(this.images_.length - 1, from - by));
    if (from < 0 || from === to) return;
    this.images_.splice(from, 1);
    this.images_.splice(to, 0, image);
    this.restack_();
  }

  /** Zooms the map to an image. */
  async zoomTo(image: ViewerImage): Promise<void> {
    const view = await image.source.getView();
    if (!view.extent) return;
    const target = this.map.getView();
    target.fit(transformExtent(view.extent, view.projection ?? 'EPSG:4326', target.getProjection()), { padding: [20, 20, 20, 20], duration: 250 });
  }

  /** Puts the rows and the layers' z-index in list order. */
  private restack_(): void {
    const n = this.images_.length;
    this.images_.forEach((image, i) => {
      image.layer.setZIndex(n - i);
      const up = image.row.querySelector<HTMLButtonElement>('[data-action=up]')!;
      const down = image.row.querySelector<HTMLButtonElement>('[data-action=down]')!;
      up.disabled = i === 0;
      down.disabled = i === n - 1;
    });
    this.element.replaceChildren(...this.images_.map((i) => i.row));
    this.options.onChange(this.images_);
  }

  private buildRow_(image: ViewerImage): void {
    const { row, layer } = image;
    row.className = 'image';

    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = true;
    visible.title = '表示';
    visible.setAttribute('aria-label', `${image.name} を表示`);
    visible.addEventListener('change', () => layer.setVisible(visible.checked));

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'name';
    name.textContent = shortName(image.name);
    name.title = image.name;
    name.addEventListener('click', () => this.select(image));

    const tools = document.createElement('span');
    tools.className = 'tools';
    const button = (action: string, text: string, label: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = action;
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', run);
      tools.append(b);
    };
    button('zoom', '⤢', 'この画像へ移動', () => void this.zoomTo(image));
    button('up', '↑', '上へ', () => this.move(image, 1));
    button('down', '↓', '下へ', () => this.move(image, -1));
    button('remove', '×', '閉じる', () => this.remove(image));

    const opacity = document.createElement('label');
    opacity.className = 'opacity';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.01';
    range.value = String(layer.getOpacity());
    range.addEventListener('input', () => layer.setOpacity(Number(range.value)));
    opacity.append('不透明度', range);

    row.append(visible, name, tools, opacity);
  }
}

/** The file name without its extension: `photo` for `photo.png` or `https://…/photo.tif?x`. */
export function baseName(name: string): string {
  return shortName(name).replace(/\.[^./\\]+$/, '');
}

/** The file name of a URL (without the query), or the name as given. */
function shortName(name: string): string {
  try {
    const url = new URL(name);
    return decodeURIComponent(url.pathname.split('/').pop() || url.host);
  } catch {
    return name;
  }
}
