/**
 * Side by side comparison: the map area split into two or four panes that
 * share one view, so panning, zooming and rotating any of them moves them all,
 * and a cross follows the cursor in every pane. The first pane is the map
 * itself, with every layer and every tool; each other pane shows one layer of
 * the list (picked at its top) over the base map. A pane draws its own copy of
 * the layer from the same source, so tiles are not read again and an image's
 * correction, set on the panel, shows in every pane at once.
 */
import OlMap from 'ol/Map.js';
import Overlay from 'ol/Overlay.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type BaseLayer from 'ol/layer/Base.js';
import LayerGroup from 'ol/layer/Group.js';
import ImageLayer from 'ol/layer/Image.js';
import TileLayer from 'ol/layer/Tile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import type Layer from 'ol/layer/Layer.js';
import { unByKey } from 'ol/Observable.js';
import type { EventsKey } from 'ol/events.js';
import type { Coordinate } from 'ol/coordinate.js';
import { GpuCorrectedTileLayer } from 'browser-image-enhancement/openlayers';
import { shortName, type ImageList, type ViewerLayer } from './images.js';

/** How many panes: off (1), two or four. */
export type SplitCount = 1 | 2 | 4;

/** The comparison as kept in a project: the panes and the layer of each pane after the first (null: none). */
export interface SplitState {
  count: SplitCount;
  layers: (number | null)[];
}

/**
 * A copy of `layer` drawing from the same source, or null when it is of a kind
 * this does not copy (WebGL vectors, for one). A copy of an image follows its
 * correction, as the correction belongs to the source; a picture service's
 * correction object is shared.
 */
export function copyLayer(layer: BaseLayer): BaseLayer | null {
  if (layer instanceof LayerGroup) {
    const copies = layer.getLayers().getArray().map(copyLayer);
    if (copies.some((c) => !c)) {
      for (const c of copies) c?.dispose();
      return null;
    }
    return new LayerGroup({ layers: copies as BaseLayer[], opacity: layer.getOpacity(), visible: layer.getVisible(), extent: layer.getExtent() });
  }
  const common = { extent: layer.getExtent(), opacity: layer.getOpacity(), minResolution: layer.getMinResolution(), maxResolution: layer.getMaxResolution() };
  if (layer instanceof GpuCorrectedTileLayer) {
    const copy = new GpuCorrectedTileLayer({ source: layer.getSource() ?? undefined, correction: layer.getCorrection() ?? undefined, ...common });
    syncColor(layer, copy);
    return copy;
  }
  if (layer instanceof VectorTileLayer) {
    return new VectorTileLayer({ source: layer.getSource() ?? undefined, style: layer.getStyle(), className: (layer as Layer).getClassName(), declutter: layer.getDeclutter(), ...common });
  }
  if (layer instanceof VectorLayer) {
    return new VectorLayer({ source: layer.getSource() ?? undefined, style: layer.getStyle(), declutter: layer.getDeclutter(), ...common });
  }
  if (layer instanceof TileLayer) return new TileLayer({ source: layer.getSource() ?? undefined, className: (layer as Layer).getClassName(), ...common });
  if (layer instanceof ImageLayer) return new ImageLayer({ source: layer.getSource() ?? undefined, ...common });
  return null;
}

/** Gives `copy` the color scale and blend of `layer` (a one-band image shown in color). */
function syncColor(layer: GpuCorrectedTileLayer, copy: GpuCorrectedTileLayer): void {
  const scale = layer.getColorScale();
  if (scale !== copy.getColorScale()) copy.setColorScale(scale);
  if (layer.getBlendMode() !== copy.getBlendMode()) copy.setBlendMode(layer.getBlendMode());
}

/** Where the panes go: side by side when the map is wider than tall, else one above the other (two panes). */
export function splitDirection(size: [number, number]): 'columns' | 'rows' {
  return size[0] >= size[1] ? 'columns' : 'rows';
}

/** Whether {@link copyLayer} copies `layer` (without making the copy, which may take a WebGL context). */
export function canCopyLayer(layer: BaseLayer): boolean {
  if (layer instanceof LayerGroup) return layer.getLayers().getArray().every(canCopyLayer);
  return layer instanceof GpuCorrectedTileLayer || layer instanceof VectorTileLayer || layer instanceof VectorLayer || layer instanceof TileLayer || layer instanceof ImageLayer;
}

const canCopy = (layer: ViewerLayer) => canCopyLayer(layer.layer);

export interface SplitViewOptions {
  /** The grid element the map is in (`.app`); it gets the `split-2` / `split-4` classes. */
  app: HTMLElement;
  images: ImageList;
  /** The base map's layers now, copied into every pane. */
  baseLayers: () => readonly BaseLayer[];
  /** The on / off button and the 2 / 4 choice next to it. */
  button: HTMLButtonElement;
  counts: HTMLElement;
  say: (message: string) => void;
  /** Called after the panes change (the map has to update its size). */
  onResize: () => void;
}

/** One pane after the first. */
interface Pane {
  element: HTMLElement;
  select: HTMLSelectElement;
  map: OlMap;
  layer: ViewerLayer | null;
  copy: BaseLayer | null;
  base: BaseLayer[];
  cross: Overlay;
  /** Whether the person picked the pane's layer (else a newly opened layer may fill an empty pane). */
  chosen: boolean;
  cursorKeys: EventsKey[];
  layerKeys: EventsKey[];
}

/** The split panes over the map area. */
export class SplitView {
  private count_: SplitCount = 1;
  private panes_: Pane[] = [];
  private readonly element_: HTMLDivElement;
  private readonly label_: HTMLDivElement;
  private readonly mainCross_: Overlay;
  private readonly observer_: ResizeObserver;

  constructor(
    private readonly map: OlMap,
    private readonly options: SplitViewOptions,
  ) {
    this.element_ = document.createElement('div');
    this.element_.className = 'split-panes';
    this.element_.hidden = true;
    options.app.append(this.element_);
    this.label_ = document.createElement('div');
    this.label_.className = 'split-label';
    this.label_.textContent = 'すべてのレイヤー';
    this.label_.hidden = true;
    map.getTargetElement()?.append(this.label_);
    this.mainCross_ = crossOverlay();
    map.addOverlay(this.mainCross_);
    this.followCursor_(map, this.mainCross_);
    options.button.addEventListener('click', () => this.setCount(this.count_ === 1 ? 2 : 1));
    for (const b of options.counts.querySelectorAll<HTMLButtonElement>('button[data-count]')) {
      b.addEventListener('click', () => this.setCount(Number(b.dataset.count) as SplitCount));
    }
    this.observer_ = new ResizeObserver(() => {
      if (this.count_ > 1) this.layout_();
    });
    this.observer_.observe(options.app);
  }

  /** How many panes there are (1: off). */
  getCount(): SplitCount {
    return this.count_;
  }

  /** The layer each pane after the first shows. */
  paneLayers(): (ViewerLayer | null)[] {
    return this.panes_.map((p) => p.layer);
  }

  /** The pane maps (after the first), for tests. */
  paneMaps(): OlMap[] {
    return this.panes_.map((p) => p.map);
  }

  /** Splits the map into `count` panes (1 ends the comparison). `layers`: what the panes after the first show, else the next layers of the list. */
  setCount(count: SplitCount, layers?: (ViewerLayer | null)[]): void {
    const keep = layers ?? this.paneLayers();
    this.count_ = count;
    this.options.button.setAttribute('aria-pressed', String(count > 1));
    this.options.counts.hidden = count === 1;
    for (const b of this.options.counts.querySelectorAll<HTMLButtonElement>('button[data-count]')) {
      b.setAttribute('aria-checked', String(Number(b.dataset.count) === count));
    }
    while (this.panes_.length > count - 1) this.dispose_(this.panes_.pop()!);
    const list = this.options.images.layers().filter(canCopy);
    while (this.panes_.length < count - 1) {
      const i = this.panes_.length;
      // A layer given, else the one shown before, else the next one down the list (the map itself shows the top one).
      const wanted = layers ? (layers[i] ?? null) : keep[i] !== undefined ? keep[i] : (list[i + 1] ?? null);
      const pane = this.pane_(wanted && list.includes(wanted) ? wanted : null);
      pane.chosen = !!layers;
      this.panes_.push(pane);
    }
    this.element_.hidden = count === 1;
    this.label_.hidden = count === 1;
    this.layout_();
    this.refresh();
    if (count > 1) {
      const empty = this.panes_.every((p) => !p.layer);
      this.options.say(empty ? '並べて比較: 各画面の上で表示するレイヤーを選択可能（画像を2枚以上開くと自動で配置）' : `${count} 画面で並べて表示中。どの画面の操作も連動`);
    }
  }

  /** Follows the layer list: new names in the choices, and a closed layer leaves its pane. */
  refresh(): void {
    if (this.count_ === 1) return;
    const list = this.options.images.layers().filter(canCopy);
    this.panes_.forEach((pane, i) => {
      if (pane.layer && !list.includes(pane.layer)) this.show_(pane, null);
      // An image opened while the comparison is on fills the empty panes in list order.
      if (!pane.layer && !pane.chosen) {
        const next = list.find((l, j) => j > 0 && !this.panes_.some((p) => p.layer === l));
        if (next && i < list.length - 1) this.show_(pane, next);
      }
      pane.select.replaceChildren(new Option('（なし）', ''), ...list.map((l, i) => new Option(shortName(l.name), String(i))));
      pane.select.value = pane.layer ? String(list.indexOf(pane.layer)) : '';
    });
  }

  /** The base map changed: the panes copy it again. */
  refreshBase(): void {
    for (const pane of this.panes_) this.setBase_(pane);
  }

  /** The split as kept in a project; `indexOf` gives a layer's index in the project (-1: not saved). */
  getState(indexOf: (layer: ViewerLayer) => number): SplitState | null {
    if (this.count_ === 1) return null;
    return { count: this.count_, layers: this.panes_.map((p) => (p.layer && indexOf(p.layer) >= 0 ? indexOf(p.layer) : null)) };
  }

  /** Puts a project's split back; `layerOf` gives the open layer of a project index. */
  setState(state: SplitState | null | undefined, layerOf: (index: number) => ViewerLayer | null): void {
    const count = state && [1, 2, 4].includes(state.count) ? state.count : 1;
    for (const pane of this.panes_.splice(0)) this.dispose_(pane);
    this.setCount(count, count > 1 ? Array.from({ length: count - 1 }, (_, i) => (typeof state?.layers?.[i] === 'number' ? layerOf(state.layers[i]!) : null)) : undefined);
  }

  private pane_(layer: ViewerLayer | null): Pane {
    const element = document.createElement('div');
    element.className = 'split-pane';
    const head = document.createElement('label');
    head.className = 'split-pane-head';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `画面 ${this.panes_.length + 2} に表示するレイヤー`);
    head.append(select);
    const target = document.createElement('div');
    target.className = 'split-pane-map';
    element.append(target, head);
    this.element_.append(element);
    const map = new OlMap({ target, view: this.map.getView(), controls: [] });
    const cross = crossOverlay();
    map.addOverlay(cross);
    const pane: Pane = { element, select, map, layer: null, copy: null, base: [], cross, chosen: false, cursorKeys: this.followCursor_(map, cross), layerKeys: [] };
    select.addEventListener('change', () => {
      const list = this.options.images.layers().filter(canCopy);
      pane.chosen = true;
      this.show_(pane, select.value === '' ? null : (list[Number(select.value)] ?? null));
    });
    this.setBase_(pane);
    this.show_(pane, layer);
    return pane;
  }

  /** Puts a copy of `layer` (null: none) in the pane. */
  private show_(pane: Pane, layer: ViewerLayer | null): void {
    if (pane.copy) {
      pane.map.removeLayer(pane.copy);
      pane.copy.dispose();
    }
    unByKey(pane.layerKeys.splice(0));
    pane.layer = layer;
    pane.copy = layer ? copyLayer(layer.layer) : null;
    pane.element.classList.toggle('empty', !pane.copy);
    if (!pane.copy || !layer) return;
    pane.map.addLayer(pane.copy);
    // A one-band image's color scale, changed after the pane opened.
    const source = layer.layer;
    const copy = pane.copy;
    if (source instanceof GpuCorrectedTileLayer && copy instanceof GpuCorrectedTileLayer) {
      pane.layerKeys.push(source.on('change', () => syncColor(source, copy)));
    }
  }

  private setBase_(pane: Pane): void {
    for (const layer of pane.base) {
      pane.map.removeLayer(layer);
      layer.dispose();
    }
    pane.base = this.options
      .baseLayers()
      .map(copyLayer)
      .filter((l): l is BaseLayer => !!l);
    for (const layer of pane.base) {
      layer.setZIndex(-1);
      pane.map.addLayer(layer);
    }
    pane.element.classList.toggle('has-basemap', pane.base.length > 0);
  }

  private dispose_(pane: Pane): void {
    unByKey([...pane.cursorKeys, ...pane.layerKeys]);
    pane.map.setTarget(undefined);
    for (const layer of [...pane.base, ...(pane.copy ? [pane.copy] : [])]) layer.dispose();
    pane.map.dispose();
    pane.element.remove();
  }

  /** The panes' arrangement and the map's size. */
  private layout_(): void {
    const app = this.options.app;
    // The panes' element covers the whole map area.
    const box = this.element_.getBoundingClientRect();
    const direction = this.count_ === 2 && box.width > 0 ? splitDirection([box.width, box.height]) : 'columns';
    app.classList.toggle('split-2', this.count_ === 2);
    app.classList.toggle('split-4', this.count_ === 4);
    app.classList.toggle('split-rows', this.count_ === 2 && direction === 'rows');
    requestAnimationFrame(() => {
      this.map.updateSize();
      for (const pane of this.panes_) pane.map.updateSize();
      this.options.onResize();
    });
  }

  /** Shows the cursor of `map` as a cross in the other panes; returns the listener keys. */
  private followCursor_(map: OlMap, own: Overlay): EventsKey[] {
    const move = map.on('pointermove', (e: MapBrowserEvent) => {
      if (this.count_ === 1) return;
      this.showCross_(own, e.coordinate);
    });
    map.getViewport().addEventListener('pointerleave', () => this.showCross_(own, null));
    return [move];
  }

  /** Puts the cross at `at` in every pane but the one the cursor is in (`own`); null hides them. */
  private showCross_(own: Overlay, at: Coordinate | null): void {
    for (const cross of [this.mainCross_, ...this.panes_.map((p) => p.cross)]) {
      cross.setPosition(at && cross !== own ? at : undefined);
    }
  }
}

/** A small cross marking the cursor's place in the other panes. */
function crossOverlay(): Overlay {
  const element = document.createElement('div');
  element.className = 'split-cross';
  return new Overlay({ element, positioning: 'center-center', stopEvent: false });
}
