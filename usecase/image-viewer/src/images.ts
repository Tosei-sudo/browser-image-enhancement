/**
 * The list of layers: open images (one GPU-corrected layer each) and layers
 * of services, newest on top. A row shows and hides its layer, sets its
 * opacity, moves it up or down, zooms to it and closes it; clicking a row
 * selects the layer the correction panel (images, WMS, WMTS) or the
 * attribute table (WFS, Esri) works on.
 *
 * Layers can be kept in groups (one level): a group's row folds its layers
 * away, shows and hides them together, sets their opacity and moves and
 * closes them as one. Files opened together come in a group of their own
 * (see {@link ImageList.beginBatch}), where adding many layers redraws the
 * list once a frame rather than once a layer.
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import { transformExtent } from 'ol/proj.js';
import { GpuCorrectedTileLayer, type EnhancedGeoTIFF, type LoadedImage } from 'browser-image-enhancement/openlayers';
import { serviceNames, type ServiceLayer } from './services/index.js';
import { editTargetOf } from './edit-session.js';
import { getShift, setShift } from './shift.js';
import { ContextMenu, type MenuItem } from './context-menu.js';

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

/** Layers kept together in the list: shown, hidden, moved and closed as one. */
export interface LayerGroup {
  readonly id: string;
  name: string;
  /** Whether its layers are folded away in the list. */
  collapsed: boolean;
  /** Whether its layers are drawn (each also needs its own check box on). */
  visible: boolean;
  /** The group's row: its header, then its layers' rows. */
  readonly row: HTMLLIElement;
}

/** The parts of a group's row. */
interface GroupParts {
  visible: HTMLInputElement;
  toggle: HTMLButtonElement;
  name: HTMLSpanElement;
  count: HTMLSpanElement;
  opacity: HTMLInputElement;
  tag: HTMLSpanElement;
  list: HTMLOListElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
}

/** Layers being added together (see {@link ImageList.beginBatch}). */
interface Batch {
  /** Whether layers go into a group (from the second one on). */
  grouping: boolean;
  name: string;
  collapsed: boolean;
  group: LayerGroup | null;
  added: ViewerLayer[];
}

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
  /** Called by the style button of a vector layer. */
  onStyle?: (layer: ViewerService) => void;
  /** Called by the color button of an image (color scale and blend, colorize-dialog.ts). */
  onColorize?: (layer: ViewerImage) => void;
  /** Called by the display rules button of an Esri image or map service layer. */
  onRules?: (layer: ViewerService) => void;
  /** Called by the projection button of an image without a projection (georef-dialog.ts). */
  onGeoref?: (layer: ViewerImage) => void;
}

export class ImageList {
  /** Top first, as listed. */
  private images_: ViewerLayer[] = [];
  private selected_: ViewerLayer | null = null;
  /** Layers the timeline hides (outside its window), whatever their check box says. */
  private readonly timeHidden_ = new Set<ViewerLayer>();
  private groups_: LayerGroup[] = [];
  private readonly groupOf_ = new Map<ViewerLayer, LayerGroup>();
  private readonly parts_ = new WeakMap<LayerGroup, GroupParts>();
  private batch_: Batch | null = null;
  /** A redraw of the list waiting for the next frame (while a batch adds layers). */
  private pendingRestack_ = 0;
  private menu_: ContextMenu | null = null;

  constructor(
    private readonly element: HTMLOListElement,
    private readonly map: OlMap,
    private readonly options: ImageListOptions,
  ) {
    // Layers shown only at some scales are dimmed in the list where they are not drawn.
    map.on('moveend', () => this.images_.forEach((l) => this.markScale_(l)));
  }

  /** Dims the row of a layer the map does not draw at this scale (its style's scale range). */
  private markScale_(entry: ViewerLayer): void {
    const resolution = this.map.getView().getResolution();
    const layer = entry.layer;
    const out = resolution !== undefined && (resolution < layer.getMinResolution() || resolution >= layer.getMaxResolution());
    entry.row.classList.toggle('out-of-scale', out);
    // An image is only limited while its RSET is made (see rset.ts).
    const why = entry.type === 'image' ? 'RSET の生成中は、拡大したときだけ表示します' : 'この縮尺では表示されません（スタイルの「縮尺で表示を切り替える」）';
    entry.row.title = out ? why : '';
  }

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
    // Limited while its RSET is made (see rset.ts).
    layer.on('change:maxResolution', () => this.markScale_(image));
    this.buildRow_(image);
    this.added_(image);
    return image;
  }

  /** Puts a new layer on top (of the batch's group, while one adds layers) and selects it, or leaves the selection to the batch's end. */
  private added_(layer: ViewerLayer): void {
    const batch = this.batch_;
    if (!batch) {
      this.images_.unshift(layer);
      this.restack_();
      this.select(layer);
      return;
    }
    batch.added.push(layer);
    if (batch.grouping && !batch.group && batch.added.length >= 2) {
      batch.group = this.makeGroup_(batch.name, batch.collapsed);
      // The first layer goes into it where it was.
      this.groupOf_.set(batch.added[0], batch.group);
    }
    if (batch.group) {
      this.groupOf_.set(layer, batch.group);
      const top = this.images_.findIndex((l) => this.groupOf_.get(l) === batch.group);
      this.images_.splice(top < 0 ? 0 : top, 0, layer);
      this.applyVisible_(layer);
    } else {
      this.images_.unshift(layer);
    }
    this.restackSoon_();
  }

  /**
   * Shows `source` on the image's layer in place of its source (the same
   * image read another way: with the RSET made for it), which is disposed.
   * The correction, the bands shown, the DRA lock, a fixed raw stretch and a shift go with it.
   */
  replaceSource(image: ViewerImage, source: EnhancedGeoTIFF): void {
    const old = image.source;
    source.setPipeline(old.getPipeline());
    const select = old.getSelect();
    if (select) void source.setSelect(select).catch(() => {});
    source.setDraLocked(old.isDraLocked());
    const stretch = old.getFixedRawStretch();
    if (stretch) source.setRawStretch(stretch);
    const [dx, dy] = getShift(old);
    if (dx || dy) setShift(source, [dx, dy]);
    const noData = old.getNoData();
    if (!noData.auto || noData.values.length) void source.setNoData(noData).catch(() => {});
    image.source = source;
    image.layer.setSource(source);
    old.dispose();
    // The correction panel, histogram and the rest follow the new source.
    if (this.selected_ === image) this.options.onSelect(image);
  }

  /**
   * Marks an image as placed by its georeferencing (`geotiff`) or put where
   * pictures go without a projection (`image`); the latter's row offers to
   * set one.
   */
  setKind(image: ViewerImage, kind: ViewerImage['kind']): void {
    image.kind = kind;
    const button = image.row.querySelector<HTMLButtonElement>('button[data-action=georef]');
    if (button) button.hidden = kind !== 'image';
  }

  /** Adds a layer of a service on top and selects it. */
  addService(service: ServiceLayer): ViewerService {
    // The symbols and labels chosen the last time this layer was open.
    service.style?.restore(styleKeyOf(service));
    this.map.addLayer(service.layer);
    const entry: ViewerService = { type: 'service', name: service.title, service, layer: service.layer, row: document.createElement('li') };
    this.buildRow_(entry);
    service.layer.on(['change:minResolution', 'change:maxResolution'], () => this.markScale_(entry));
    this.markScale_(entry);
    this.added_(entry);
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
    this.timeHidden_.delete(image);
    const group = this.groupOf_.get(image);
    this.groupOf_.delete(image);
    // A group goes with its last layer (not one still opening its files).
    if (group && !this.members(group).length && this.batch_?.group !== group) this.groups_ = this.groups_.filter((g) => g !== group);
    if (this.selected_ === image) this.select(this.images_[Math.min(index, this.images_.length - 1)] ?? null);
    this.options.onRemove?.(image);
    this.map.removeLayer(image.layer);
    image.layer.dispose();
    if (image.type === 'image') image.source.dispose();
    else image.service.dispose?.();
    this.restack_();
  }

  /**
   * Moves a layer `by` places toward the top (negative: toward the bottom):
   * within its group, or past whole groups when it is in none.
   */
  move(image: ViewerLayer, by: number): void {
    const group = this.groupOf_.get(image);
    if (!group) {
      this.moveBlock_(image, by);
      return;
    }
    const members = this.members(group);
    const from = members.indexOf(image);
    const to = Math.max(0, Math.min(members.length - 1, from - by));
    if (from < 0 || from === to) return;
    const at = this.images_.indexOf(members[0]);
    members.splice(from, 1);
    members.splice(to, 0, image);
    const rest = this.images_.filter((l) => this.groupOf_.get(l) !== group);
    rest.splice(at, 0, ...members);
    this.images_ = rest;
    this.restack_();
  }

  /** Moves a layer in no group, or a whole group, `by` places among the list's top-level rows. */
  private moveBlock_(item: ViewerLayer | LayerGroup, by: number): void {
    const blocks = this.blocks_();
    const from = blocks.findIndex((b) => (Array.isArray(b) ? this.groupOf_.get(b[0]) === item : b === item));
    const to = Math.max(0, Math.min(blocks.length - 1, from - by));
    if (from < 0 || from === to) return;
    const [block] = blocks.splice(from, 1);
    blocks.splice(to, 0, block);
    this.images_ = blocks.flat();
    this.restack_();
  }

  /** The list's top-level rows, top first: a layer in no group, or the layers of a group. */
  private blocks_(): Array<ViewerLayer | ViewerLayer[]> {
    const blocks: Array<ViewerLayer | ViewerLayer[]> = [];
    const seen = new Set<LayerGroup>();
    for (const l of this.images_) {
      const group = this.groupOf_.get(l);
      if (!group) blocks.push(l);
      else if (!seen.has(group)) {
        seen.add(group);
        blocks.push(this.images_.filter((m) => this.groupOf_.get(m) === group));
      }
    }
    return blocks;
  }

  /** The groups, top first. */
  groups(): readonly LayerGroup[] {
    const order: LayerGroup[] = [];
    for (const l of this.images_) {
      const group = this.groupOf_.get(l);
      if (group && !order.includes(group)) order.push(group);
    }
    // A group still waiting for its first layers is on top.
    return [...this.groups_.filter((g) => !order.includes(g)), ...order];
  }

  /** The group a layer is in, if any. */
  groupOf(layer: ViewerLayer): LayerGroup | null {
    return this.groupOf_.get(layer) ?? null;
  }

  /** A group's layers, top first. */
  members(group: LayerGroup): ViewerLayer[] {
    return this.images_.filter((l) => this.groupOf_.get(l) === group);
  }

  /** Puts `layers` (in no group) in a new group, where the top one of them is. */
  createGroup(layers: readonly ViewerLayer[], name = '新しいグループ', collapsed = false): LayerGroup {
    const group = this.makeGroup_(name, collapsed);
    const members = this.images_.filter((l) => layers.includes(l));
    if (members.length) {
      const before = this.images_.indexOf(members[0]);
      for (const l of members) {
        const was = this.groupOf_.get(l);
        this.groupOf_.set(l, group);
        if (was && !this.members(was).length) this.dropGroup_(was);
      }
      const rest = this.images_.filter((l) => !members.includes(l));
      rest.splice(before, 0, ...members);
      this.images_ = rest;
      members.forEach((l) => this.applyVisible_(l));
    }
    this.restack_();
    return group;
  }

  /** Takes a layer out of its group (it goes just above the group) or puts it on top of `group`. */
  setGroup(layer: ViewerLayer, group: LayerGroup | null): void {
    const was = this.groupOf_.get(layer);
    if (was === (group ?? undefined) || !this.images_.includes(layer)) return;
    this.images_ = this.images_.filter((l) => l !== layer);
    const next = group ?? was;
    if (group) this.groupOf_.set(layer, group);
    else this.groupOf_.delete(layer);
    const top = this.images_.findIndex((l) => this.groupOf_.get(l) === next);
    this.images_.splice(top < 0 ? 0 : top, 0, layer);
    if (was && !this.members(was).length) this.dropGroup_(was);
    this.applyVisible_(layer);
    this.restack_();
  }

  /** Lets a group's layers go: they stay where they are, in no group. */
  ungroup(group: LayerGroup): void {
    const members = this.members(group);
    for (const l of members) this.groupOf_.delete(l);
    this.dropGroup_(group);
    members.forEach((l) => this.applyVisible_(l));
    this.restack_();
  }

  /** Closes every layer of a group, and the group. */
  removeGroup(group: LayerGroup): void {
    const members = this.members(group);
    // Not selecting each next one as the selected one closes.
    const moveOff = !!this.selected_ && members.includes(this.selected_);
    if (moveOff) this.select(null);
    for (const l of members) this.remove(l);
    this.dropGroup_(group);
    this.restack_();
    if (moveOff) this.select(this.images_[0] ?? null);
  }

  private dropGroup_(group: LayerGroup): void {
    this.groups_ = this.groups_.filter((g) => g !== group);
    if (this.batch_?.group === group) this.batch_.group = null;
  }

  /** Moves a group `by` places toward the top (negative: toward the bottom) among the list's top-level rows. */
  moveGroup(group: LayerGroup, by: number): void {
    this.moveBlock_(group, by);
  }

  renameGroup(group: LayerGroup, name: string): void {
    group.name = name.trim() || group.name;
    const parts = this.parts_.get(group)!;
    parts.name.textContent = group.name;
    parts.visible.setAttribute('aria-label', `グループ ${group.name} を表示`);
    this.options.onChange(this.images_);
  }

  /** Shows or hides a group's layers (those whose own check box is on). */
  setGroupVisible(group: LayerGroup, visible: boolean): void {
    group.visible = visible;
    this.parts_.get(group)!.visible.checked = visible;
    group.row.classList.toggle('group-hidden', !visible);
    for (const l of this.members(group)) this.applyVisible_(l);
  }

  /** Folds a group's layers away in the list, or shows them. */
  setGroupCollapsed(group: LayerGroup, collapsed: boolean): void {
    group.collapsed = collapsed;
    const parts = this.parts_.get(group)!;
    parts.list.hidden = collapsed;
    parts.toggle.textContent = collapsed ? '▸' : '▾';
    parts.toggle.setAttribute('aria-expanded', String(!collapsed));
    group.row.classList.toggle('collapsed', collapsed);
  }

  /** Sets the opacity of every layer of a group. */
  setGroupOpacity(group: LayerGroup, opacity: number): void {
    for (const l of this.members(group)) this.setOpacity(l, opacity);
    this.parts_.get(group)!.opacity.value = String(opacity);
  }

  /** Shows a short note on a group's row (how far its files have opened), or removes it with null. */
  setGroupNote(group: LayerGroup, text: string | null): void {
    const tag = this.parts_.get(group)!.tag;
    tag.hidden = !text;
    tag.textContent = text ?? '';
  }

  /** Zooms the map to all of a group's layers. */
  async zoomToGroup(group: LayerGroup, duration = 250): Promise<void> {
    let all: number[] | null = null;
    for (const l of this.members(group)) {
      const extent = await this.extentOf_(l).catch(() => null);
      if (!extent || !Number.isFinite(extent[0])) continue;
      all = all ? [Math.min(all[0], extent[0]), Math.min(all[1], extent[1]), Math.max(all[2], extent[2]), Math.max(all[3], extent[3])] : [...extent];
    }
    if (all) this.map.getView().fit(all, { padding: [20, 20, 20, 20], duration, maxZoom: 18 });
  }

  /**
   * Starts adding layers together (files opened at once): from the second
   * one on they go into a new group named `name` (made at once with
   * `group`, to show how far the files have got; folded with `collapsed`),
   * the list is redrawn once a frame, and nothing is selected until
   * {@link endBatch}. With `grouping` false the layers go into no group
   * (a project opening, which has its own groups). Returns false, and
   * changes nothing, while another batch is going.
   */
  beginBatch(name: string, { collapsed = false, group = false, grouping = true }: { collapsed?: boolean; group?: boolean; grouping?: boolean } = {}): boolean {
    if (this.batch_) return false;
    this.batch_ = { grouping, name, collapsed, group: null, added: [] };
    if (group && grouping) {
      this.batch_.group = this.makeGroup_(name, collapsed);
      this.restack_();
    }
    return true;
  }

  /** The group of the batch going on, once it has one. */
  batchGroup(): LayerGroup | null {
    return this.batch_?.group ?? null;
  }

  /**
   * Ends the batch: a group left with fewer than two layers is let go, and
   * the last layer added is selected. Returns the group, if one is kept, and
   * the layers added that are still open.
   */
  endBatch(): { group: LayerGroup | null; added: ViewerLayer[] } {
    const batch = this.batch_;
    if (!batch) return { group: null, added: [] };
    this.batch_ = null;
    let group = batch.group;
    if (group && !this.groups_.includes(group)) group = null;
    if (group && this.members(group).length < 2) {
      this.ungroup(group);
      group = null;
    }
    if (group) this.setGroupNote(group, null);
    this.restack_();
    const added = batch.added.filter((l) => this.images_.includes(l));
    const last = added[added.length - 1];
    if (last) this.select(last);
    return { group, added };
  }

  /**
   * Puts the layers in the order given (top first); layers left out keep
   * their order below them.
   */
  arrange(order: readonly ViewerLayer[]): void {
    const first = order.filter((l) => this.images_.includes(l));
    this.images_ = [...first, ...this.images_.filter((l) => !first.includes(l))];
    this.restack_();
  }

  /** Shows or hides a layer, as its check box does. */
  setVisible(image: ViewerLayer, visible: boolean): void {
    image.row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = visible;
    this.applyVisible_(image);
  }

  /** Draws a layer when its check box and its group's are on, and the timeline does not hide it. */
  private applyVisible_(image: ViewerLayer): void {
    const group = this.groupOf_.get(image);
    image.layer.setVisible(this.isVisible(image) && (!group || group.visible) && !this.timeHidden_.has(image));
  }

  /** Whether a layer's check box is on (it may still be hidden by the timeline). */
  isVisible(image: ViewerLayer): boolean {
    return image.row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked;
  }

  /** Hides a layer outside the timeline's window (its check box stays as the user left it), or shows it again. */
  setTimeHidden(image: ViewerLayer, hidden: boolean): void {
    if (hidden === this.timeHidden_.has(image)) return;
    if (hidden) this.timeHidden_.add(image);
    else this.timeHidden_.delete(image);
    image.row.classList.toggle('time-out', hidden);
    image.row.querySelector<HTMLInputElement>('input[type=checkbox]')!.title = hidden ? '表示（タイムラインの期間外のため隠れています）' : '表示';
    this.applyVisible_(image);
  }

  /** Sets a layer's opacity (0–1), as its slider does. */
  setOpacity(image: ViewerLayer, opacity: number): void {
    image.layer.setOpacity(opacity);
    image.row.querySelector<HTMLInputElement>('.opacity input')!.value = String(opacity);
  }

  /** Zooms the map to a layer. */
  async zoomTo(image: ViewerLayer): Promise<void> {
    const extent = await this.extentOf_(image);
    if (extent && Number.isFinite(extent[0])) this.map.getView().fit(extent, { padding: [20, 20, 20, 20], duration: 250, ...(image.type === 'service' ? { maxZoom: 18 } : {}) });
  }

  /** Where a layer is, in the map's projection (null when it does not say). */
  private async extentOf_(image: ViewerLayer): Promise<number[] | null> {
    if (image.type === 'service') return image.service.extent ?? image.service.vector?.source.getExtent() ?? null;
    const view = await image.source.getView();
    if (!view.extent) return null;
    return transformExtent(view.extent, view.projection ?? 'EPSG:4326', this.map.getView().getProjection());
  }

  /** Puts the rows and the layers' z-index in list order (a group's layers together, in its row). */
  private restack_(): void {
    if (this.pendingRestack_) cancelAnimationFrame(this.pendingRestack_);
    this.pendingRestack_ = 0;
    const blocks = this.blocks_();
    this.images_ = blocks.flat();
    this.setZIndexes_();
    const enable = (up: HTMLButtonElement, down: HTMLButtonElement, first: boolean, last: boolean) => {
      up.disabled = first;
      down.disabled = last;
    };
    const buttons = (row: HTMLElement) => [row.querySelector<HTMLButtonElement>('[data-action=up]')!, row.querySelector<HTMLButtonElement>('[data-action=down]')!] as const;
    const rows: HTMLLIElement[] = [];
    // A group still waiting for its first layers, on top.
    for (const group of this.groups()) {
      if (this.images_.some((l) => this.groupOf_.get(l) === group)) break;
      const parts = this.parts_.get(group)!;
      parts.count.textContent = '0';
      parts.list.replaceChildren();
      enable(parts.up, parts.down, true, true);
      rows.push(group.row);
    }
    blocks.forEach((block, b) => {
      const first = b === 0;
      const last = b === blocks.length - 1;
      if (!Array.isArray(block)) {
        enable(...buttons(block.row), first, last);
        rows.push(block.row);
        return;
      }
      const group = this.groupOf_.get(block[0])!;
      const parts = this.parts_.get(group)!;
      enable(parts.up, parts.down, first, last);
      block.forEach((l, i) => enable(...buttons(l.row), i === 0, i === block.length - 1));
      parts.count.textContent = String(block.length);
      parts.list.replaceChildren(...block.map((l) => l.row));
      rows.push(group.row);
    });
    this.element.replaceChildren(...rows);
    this.options.onChange(this.images_);
  }

  private setZIndexes_(): void {
    const n = this.images_.length;
    this.images_.forEach((image, i) => image.layer.setZIndex(n - i));
  }

  /** Redraws the list at the next frame (many layers being added); the map draws them in order at once. */
  private restackSoon_(): void {
    this.setZIndexes_();
    if (!this.pendingRestack_) this.pendingRestack_ = requestAnimationFrame(() => this.restack_());
  }

  /** A new group, not yet in the list. */
  private makeGroup_(name: string, collapsed: boolean): LayerGroup {
    const row = document.createElement('li');
    const group: LayerGroup = { id: crypto.randomUUID(), name, collapsed: false, visible: true, row };
    row.className = 'layer-group';
    const head = document.createElement('div');
    head.className = 'group-head';

    const visible = document.createElement('input');
    visible.type = 'checkbox';
    visible.checked = true;
    visible.title = 'グループを表示';
    visible.setAttribute('aria-label', `グループ ${name} を表示`);
    visible.addEventListener('change', () => this.setGroupVisible(group, visible.checked));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-toggle';
    toggle.title = '開く・たたむ';
    toggle.addEventListener('click', () => this.setGroupCollapsed(group, !group.collapsed));

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'group-name';
    title.title = 'クリックで開く・たたむ、ダブルクリックで名前を変更';
    const label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = name;
    const count = document.createElement('span');
    count.className = 'group-count';
    const tag = document.createElement('span');
    tag.className = 'tag group-note';
    tag.hidden = true;
    title.append(label, count, tag);
    title.addEventListener('click', (e) => {
      // The second click of a double click renames instead.
      if (e.detail <= 1) this.setGroupCollapsed(group, !group.collapsed);
    });
    title.addEventListener('dblclick', () => {
      this.setGroupCollapsed(group, !group.collapsed);
      this.askName_(group);
    });

    const tools = document.createElement('span');
    tools.className = 'tools';
    const button = (action: string, text: string, tip: string, run: (b: HTMLButtonElement) => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = action;
      b.textContent = text;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      b.addEventListener('click', () => run(b));
      tools.append(b);
      return b;
    };
    button('zoom', '⤢', 'このグループへ移動', () => void this.zoomToGroup(group));
    const up = button('up', '↑', 'グループを上へ', () => this.moveGroup(group, 1));
    const down = button('down', '↓', 'グループを下へ', () => this.moveGroup(group, -1));
    button('menu', '⋯', 'グループのメニュー（名前の変更・解除など）', (b) => {
      const r = b.getBoundingClientRect();
      this.openGroupMenu_(group, r.left, r.bottom);
    });
    button('remove', '×', 'グループを閉じる（中のレイヤーもすべて閉じます）', () => {
      const n = this.members(group).length;
      if (n <= 1 || confirm(`グループ「${group.name}」の ${n} 件のレイヤーをすべて閉じますか？`)) this.removeGroup(group);
    });

    const opacityLabel = document.createElement('label');
    opacityLabel.className = 'opacity';
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.01';
    opacity.value = '1';
    opacity.addEventListener('input', () => this.setGroupOpacity(group, Number(opacity.value)));
    opacityLabel.append('不透明度', opacity);
    opacity.title = '中のレイヤーすべての不透明度';

    head.append(visible, toggle, title, tools, opacityLabel);
    head.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
      this.openGroupMenu_(group, e.clientX, e.clientY);
    });
    const list = document.createElement('ol');
    list.className = 'group-layers';
    row.append(head, list);
    this.parts_.set(group, { visible, toggle, name: label, count, opacity, tag, list, up, down });
    this.groups_.push(group);
    this.setGroupCollapsed(group, collapsed);
    return group;
  }

  /** Asks for a group's new name. */
  private askName_(group: LayerGroup): void {
    const name = prompt('グループの名前', group.name);
    if (name !== null) this.renameGroup(group, name);
  }

  private contextMenu_(): ContextMenu {
    return (this.menu_ ??= new ContextMenu('レイヤーのメニュー'));
  }

  private openGroupMenu_(group: LayerGroup, x: number, y: number): void {
    const items: MenuItem[] = [
      { label: '名前を変更…', run: () => this.askName_(group) },
      { label: '中のレイヤーをすべて表示', run: () => this.members(group).forEach((l) => this.setVisible(l, true)) },
      { label: '中のレイヤーをすべて隠す', run: () => this.members(group).forEach((l) => this.setVisible(l, false)) },
      { label: 'グループを解除（レイヤーは残す）', run: () => this.ungroup(group) },
      { label: 'グループを閉じる（中のレイヤーもすべて閉じる）', danger: true, run: () => this.removeGroup(group) },
    ];
    this.contextMenu_().open(items, x, y);
  }

  private openLayerMenu_(layer: ViewerLayer, x: number, y: number): void {
    const current = this.groupOf_.get(layer);
    const items: MenuItem[] = [{ label: '新しいグループに入れる…', run: () => this.askNewGroup_(layer) }];
    for (const group of this.groups()) {
      if (group !== current) items.push({ label: `グループ「${group.name}」に入れる`, run: () => this.setGroup(layer, group) });
    }
    if (current) items.push({ label: `グループ「${current.name}」から出す`, run: () => this.setGroup(layer, null) });
    this.contextMenu_().open(items, x, y);
  }

  /** Puts a layer in a new group, named by the person. */
  private askNewGroup_(layer: ViewerLayer): void {
    const name = prompt('新しいグループの名前', '新しいグループ');
    if (name === null) return;
    this.createGroup([layer], name.trim() || '新しいグループ');
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
    visible.addEventListener('change', () => this.applyVisible_(image));

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
    if (image.type === 'service' && image.service.style && !image.service.tableOnly && this.options.onStyle) {
      button('style', '◐', 'スタイル・ラベル', () => {
        this.select(image);
        this.options.onStyle!(image);
      });
    }
    if (image.type === 'image' && this.options.onColorize) {
      button('colorize', '◐', '着色（カラースケール・重ね方）', () => {
        this.select(image);
        this.options.onColorize!(image);
      });
    }
    if (image.type === 'service' && image.service.raster && this.options.onRules) {
      button('rules', '⚙', image.service.raster.kind === 'image' ? '表示ルール（属性の条件・並び順・ラスター関数）' : '表示ルール（レイヤーの表示と条件）', () => {
        this.select(image);
        this.options.onRules!(image);
      });
    }
    if (image.type === 'image' && this.options.onGeoref) {
      button('georef', '⌖', '投影を設定（この画像には座標系がありません）', () => {
        this.select(image);
        this.options.onGeoref!(image);
      });
      tools.lastElementChild!.toggleAttribute('hidden', image.kind !== 'image');
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
    // Groups: into a new one, into another, out of its own.
    row.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
      this.openLayerMenu_(image, e.clientX, e.clientY);
    });
  }
}

/** The name a layer's style is kept under: its service and layer, or its file. */
export function styleKeyOf(service: ServiceLayer): string {
  if (service.styleKey) return service.styleKey;
  if (service.ref) return `${service.ref.kind}:${service.ref.url}#${service.ref.layer}`;
  return `file:${service.badge ?? ''}:${service.title}`;
}

/**
 * The name of a group of files opened together: what their names begin
 * with (`LC08_L1TP_107035` of `LC08_L1TP_107035_B4.TIF`, …), else when they
 * were opened.
 */
export function groupNameOf(names: readonly string[], now = new Date()): string {
  const stems = names.map((n) => baseName(n));
  let prefix = stems[0] ?? '';
  for (const s of stems) while (prefix && !s.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  // Not half a word (`tokyo-2024` of `tokyo-2024-01`, `tokyo-2024-02`), when the names have words.
  const word = /[\p{L}\p{N}]/u;
  if (word.test(prefix.slice(-1)) && stems.some((s) => word.test(s.charAt(prefix.length))) && /[\s_\-.(（[]/u.test(prefix)) prefix = prefix.replace(/[\p{L}\p{N}]+$/u, '');
  prefix = prefix.replace(/[\s_\-.(（[]+$/u, '');
  if (prefix.length >= 3) return prefix;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `開いたファイル ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** The file name without its extension: `photo` for `photo.png` or `https://…/photo.tif?x`. */
export function baseName(name: string): string {
  return shortName(name).replace(/\.[^./\\]+$/, '');
}

/** The file name of a URL (without the query), or the name as given. */
export function shortName(name: string): string {
  try {
    const url = new URL(name);
    return decodeURIComponent(url.pathname.split('/').pop() || url.host);
  } catch {
    return name;
  }
}
