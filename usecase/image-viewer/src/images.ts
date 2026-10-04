/**
 * The list of layers: open images (one GPU-corrected layer each) and layers
 * of services, newest on top. A row shows and hides its layer, sets its
 * opacity, moves it up or down, zooms to it and closes it; clicking a row
 * selects the layer the correction panel (images, WMS, WMTS) or the
 * attribute table (WFS, Esri) works on.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import { transformExtent } from 'ol/proj.js';
import { GpuCorrectedTileLayer, type EnhancedGeoTIFF, type LoadedImage } from 'browser-image-enhancement/openlayers';
import { serviceNames, type ServiceLayer } from './services/index.js';
import { editTargetOf } from './edit-session.js';

/** One open image. */
export interface ViewerImage {
  type: 'image';
  /** File name or URL. */
  name: string;
  /** `geotiff` when placed by its georeferencing, `image` when placed over the view. */
  kind: LoadedImage['kind'];
  source: EnhancedGeoTIFF;
  layer: GpuCorrectedTileLayer;
  /** The list row. */
  row: HTMLLIElement;
}

/** One layer of a service. */
export interface ViewerService {
  type: 'service';
  /** The layer's title. */
  name: string;
  service: ServiceLayer;
  layer: BaseLayer;
  /** The list row. */
  row: HTMLLIElement;
}

/** A row of the list. */
export type ViewerLayer = ViewerImage | ViewerService;

export interface ImageListOptions {
  /** Called when another layer (or none) is selected. */
  onSelect: (layer: ViewerLayer | null) => void;
  /** Called when a layer is closed, before its source is disposed. */
  onRemove?: (layer: ViewerLayer) => void;
  /** Called when layers are added, removed or reordered. */
  onChange: (layers: readonly ViewerLayer[]) => void;
  /** Called by the edit button of an editable layer (Esri, or a file). */
  onEdit?: (layer: ViewerService) => void;
  /** Called by the export button of a vector layer. */
  onExport?: (layer: ViewerService) => void;
}

export class ImageList {
  /** Top first, as listed. */
  private images_: ViewerLayer[] = [];
  private selected_: ViewerLayer | null = null;

  constructor(
    private readonly element: HTMLOListElement,
    private readonly map: OlMap,
    private readonly options: ImageListOptions,
  ) {}

  /** The open image showing `source`. */
  find(source: EnhancedGeoTIFF): ViewerImage | undefined {
    return this.list().find((i) => i.source === source);
  }

  /** The open images, top first. */
  list(): readonly ViewerImage[] {
    return this.images_.filter((l): l is ViewerImage => l.type === 'image');
  }

  /** Every layer, images and services, top first. */
  layers(): readonly ViewerLayer[] {
    return this.images_;
  }

  /** The selected image (null when none, or when a service layer is selected). */
  selected(): ViewerImage | null {
    return this.selected_?.type === 'image' ? this.selected_ : null;
  }

  /** The selected layer, image or service. */
  selectedLayer(): ViewerLayer | null {
    return this.selected_;
  }

  /** Adds a loaded image on top and selects it. */
  add({ source, name, kind }: LoadedImage): ViewerImage {
    const layer = new GpuCorrectedTileLayer({ source });
    this.map.addLayer(layer);
    const image: ViewerImage = { type: 'image', name, kind, source, layer, row: document.createElement('li') };
    this.buildRow_(image);
    this.images_.unshift(image);
    this.restack_();
    this.select(image);
    return image;
  }

  /** Adds a layer of a service on top and selects it. */
  addService(service: ServiceLayer): ViewerService {
    this.map.addLayer(service.layer);
    const entry: ViewerService = { type: 'service', name: service.title, service, layer: service.layer, row: document.createElement('li') };
    this.buildRow_(entry);
    this.images_.unshift(entry);
    this.restack_();
    this.select(entry);
    return entry;
  }

  /** Shows a tag on an image's row, after its opacity (with a tooltip and an extra class), or removes it with null. */
  setTag(image: ViewerImage, tag: { text: string; title: string; className?: string } | null): void {
    let el = image.row.querySelector<HTMLSpanElement>('.tag');
    if (!tag) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('span');
      image.row.querySelector('.opacity')!.append(el);
    }
    el.className = `tag${tag.className ? ` ${tag.className}` : ''}`;
    el.textContent = tag.text;
    el.title = tag.title;
  }

  /** Marks an image's row with a short badge (such as `DEM`), or removes it with null. */
  setBadge(image: ViewerImage, text: string | null): void {
    const name = image.row.querySelector<HTMLButtonElement>('.name')!;
    let badge = name.querySelector<HTMLSpanElement>('.badge');
    if (text === null) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      name.prepend(badge);
    }
    badge.textContent = text;
  }

  select(image: ViewerLayer | null): void {
    if (image === this.selected_) return;
    this.selected_ = image;
    for (const i of this.images_) {
      i.row.classList.toggle('selected', i === image);
      i.row.setAttribute('aria-current', String(i === image));
    }
    this.options.onSelect(image);
  }

  /** Closes a layer: it leaves the map and its source is disposed. */
  remove(image: ViewerLayer): void {
    const index = this.images_.indexOf(image);
    if (index < 0) return;
    this.images_.splice(index, 1);
    if (this.selected_ === image) this.select(this.images_[Math.min(index, this.images_.length - 1)] ?? null);
    this.options.onRemove?.(image);
    this.map.removeLayer(image.layer);
    image.layer.dispose();
    if (image.type === 'image') image.source.dispose();
    else image.service.dispose?.();
    this.restack_();
  }

  /** Moves a layer `by` places toward the top (negative: toward the bottom). */
  move(image: ViewerLayer, by: number): void {
    const from = this.images_.indexOf(image);
    const to = Math.max(0, Math.min(this.images_.length - 1, from - by));
    if (from < 0 || from === to) return;
    this.images_.splice(from, 1);
    this.images_.splice(to, 0, image);
    this.restack_();
  }

  /** Zooms the map to a layer. */
  async zoomTo(image: ViewerLayer): Promise<void> {
    if (image.type === 'service') {
      const extent = image.service.extent ?? image.service.vector?.source.getExtent();
      if (extent && Number.isFinite(extent[0])) this.map.getView().fit(extent, { padding: [20, 20, 20, 20], duration: 250, maxZoom: 18 });
      return;
    }
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

  private buildRow_(image: ViewerLayer): void {
    const { row, layer } = image;
    row.className = 'image';
    if (image.type === 'service') row.dataset.kind = image.service.ref?.kind ?? 'file';

    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = true;
    visible.title = '表示';
    visible.setAttribute('aria-label', `${image.name} を表示`);
    visible.addEventListener('change', () => layer.setVisible(visible.checked));

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'name';
    name.textContent = image.type === 'image' ? shortName(image.name) : image.name;
    const ref = image.type === 'service' ? image.service.ref : null;
    name.title = image.type === 'image' ? image.name : ref ? `${serviceNames[ref.kind]}: ${ref.url}` : image.service.editTarget ? image.name : `${image.name}（読み取り専用）`;
    name.addEventListener('click', () => this.select(image));
    if (image.type === 'service') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = image.service.badge ?? (ref?.kind === 'esri' ? 'Esri' : (ref?.kind.toUpperCase() ?? ''));
      name.prepend(badge);
    }

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
    if (image.type === 'service' && editTargetOf(image.service) && this.options.onEdit) {
      button('edit', '✎', '編集', () => {
        this.select(image);
        this.options.onEdit!(image);
      });
    }
    if (image.type === 'service' && image.service.vector && !image.service.tableOnly && this.options.onExport) {
      button('export', '⇩', '書き出し（GeoJSON・Shapefile・GeoPackage）', () => {
        this.select(image);
        this.options.onExport!(image);
      });
    }
    button('zoom', '⤢', image.type === 'image' ? 'この画像へ移動' : 'このレイヤーへ移動', () => void this.zoomTo(image));
    button('up', '↑', '上へ', () => this.move(image, 1));
    button('down', '↓', '下へ', () => this.move(image, -1));
    button('remove', '×', '閉じる', () => {
      const warning = image.type === 'service' ? image.service.closeWarning : undefined;
      if (!warning || confirm(warning)) this.remove(image);
    });

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
