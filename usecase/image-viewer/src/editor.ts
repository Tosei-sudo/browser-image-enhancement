/**
 * The edit toolbar for an editable layer (an Esri layer, a WFS-T layer, a
 * temporary layer, or a GeoJSON, Shapefile or GeoPackage file), over the
 * map: add features (drawn as the layer's geometry type, or a chosen one
 * when the file allows any; polygons also as rectangles, circles and
 * regular polygons), reshape them (drag a vertex, drag an edge to add one,
 * Alt+click to remove one; drag a selected feature to move it), delete the
 * selected ones, undo and redo, discard, and save. Drawing snaps to the
 * vertices and edges of the layers shown.
 *
 * 「その他」 holds what is needed now and then: typing coordinates and
 * lengths while drawing (the number panel, see edit-panel.ts), duplicating,
 * moving and turning by numbers, parallel lines, splitting and merging.
 * Only the tools the layer allows are shown. A table (rows without
 * geometry, an Esri standalone table) gets 「行を追加」 instead of drawing,
 * and of 「その他」 only duplicating. Leaving with unsaved edits
 * asks first, and so does closing the page.
 */
import Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type Geometry from 'ol/geom/Geometry.js';
import type LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Draw, { createBox, createRegularPolygon, type GeometryFunction } from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import Snap from 'ol/interaction/Snap.js';
import Translate from 'ol/interaction/Translate.js';
import type VectorSource from 'ol/source/Vector.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import type { LonLat } from './coordinates.js';
import {
  CIRCLE_SIDES,
  familyOf,
  fitToType,
  mergeGeometries,
  moveBy,
  moveTo,
  offsetGeometry,
  polygonOf,
  rectangleRing,
  regularRing,
  rotateBy,
  splitGeometry,
} from './edit-geometry.js';
import { EditPanel, edgeText, type PanelMode } from './edit-panel.js';
import { EditSession, editTargetOf, type DrawableType, type SaveOutcome } from './edit-session.js';
import { geodesicDestination, geodesicInverse } from './geodesic.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { AttributeTable } from './table.js';

/** A drawn geometry as the layer's type (a multi type gets it as its only part). */
export function asLayerType(geometry: Geometry, type: DrawableType): Geometry {
  return fitToType(geometry, type) ?? geometry;
}

/** What can be drawn: the geometry types, and shapes drawn as polygons. */
export type DrawKind = 'Point' | 'LineString' | 'Polygon' | 'Rectangle' | 'Circle' | 'RegularPolygon';

const kindNames: Array<[DrawKind, string]> = [
  ['Point', '点'],
  ['LineString', '線'],
  ['Polygon', '面'],
  ['Rectangle', '矩形'],
  ['Circle', '円'],
  ['RegularPolygon', '正多角形'],
];

/** The kinds a layer of `type` can take (any type: all). */
export function kindsFor(type: DrawableType | null): DrawKind[] {
  const family = type ? familyOf(type) : null;
  if (family === 'point') return ['Point'];
  if (family === 'line') return ['LineString'];
  if (family === 'polygon') return ['Polygon', 'Rectangle', 'Circle', 'RegularPolygon'];
  return kindNames.map(([k]) => k);
}

const panelModeOf: Record<DrawKind, PanelMode> = {
  Point: 'point',
  LineString: 'line',
  Polygon: 'polygon',
  Rectangle: 'rectangle',
  Circle: 'circle',
  RegularPolygon: 'regular',
};

type Tool = 'select' | 'add' | 'reshape' | 'split';

/** Most features snapped to, over all layers. */
const SNAP_LIMIT = 20_000;

export interface EditorOptions {
  say: (message: string) => void;
  onChange?: () => void;
  /** Other layers' features to snap to (the edited layer's own always are). */
  snapSources?: () => VectorSource<Feature>[];
}

export class Editor {
  private session_: EditSession | null = null;
  private entry_: ViewerService | null = null;
  private tool_: Tool = 'select';
  private draw_: Draw | null = null;
  private modify_: Modify | null = null;
  private translate_: Translate | null = null;
  private snaps_: Snap[] = [];
  /** The feature being drawn (until it ends or is given up). */
  private sketch_: Feature | null = null;
  private readonly bar_: HTMLElement;
  private readonly buttons_: Record<string, HTMLButtonElement> = {};
  private readonly title_: HTMLElement;
  /** What to draw, when the layer takes more than one kind. */
  private readonly kind_: HTMLSelectElement;
  private readonly more_: HTMLElement;
  private readonly menu_: HTMLElement;
  private readonly panel_: EditPanel;
  /** Whether the number panel shows while drawing. */
  private numeric_ = false;
  private snap_ = true;
  private saving_ = false;

  constructor(
    private readonly map: OlMap,
    private readonly selection: Selection,
    private readonly table: AttributeTable,
    private readonly options: EditorOptions,
  ) {
    this.bar_ = document.createElement('div');
    this.bar_.className = 'edit-bar';
    this.bar_.setAttribute('role', 'toolbar');
    this.bar_.setAttribute('aria-label', '編集');
    this.bar_.hidden = true;
    this.title_ = document.createElement('span');
    this.title_.className = 'edit-title';
    this.bar_.append(this.title_);
    const button = (key: string, text: string, run: () => void, { toggle = false, title = '', into = this.bar_ } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.tool = key;
      if (title) b.title = title;
      if (toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', run);
      into.append(b);
      this.buttons_[key] = b;
      return b;
    };
    this.kind_ = document.createElement('select');
    this.kind_.className = 'edit-kind';
    this.kind_.title = '追加する図形';
    this.kind_.setAttribute('aria-label', '追加する図形');
    this.kind_.addEventListener('change', () => (this.tool_ === 'add' ? this.setTool('add') : this.update_()));
    this.bar_.append(this.kind_);
    button('add', '追加', () => (this.session_?.target.noGeometry ? this.addRow() : this.setTool(this.tool_ === 'add' ? 'select' : 'add')), { toggle: true });
    button('reshape', '形状編集', () => this.setTool(this.tool_ === 'reshape' ? 'select' : 'reshape'), {
      toggle: true,
      title: '頂点をドラッグで移動・辺をドラッグで頂点を追加・Alt+クリックで頂点を削除・選んだ地物をドラッグで移動',
    });
    button('delete', '削除', () => this.deleteSelected());
    button('undo', '元に戻す', () => this.undo(), { title: 'Ctrl+Z' });
    button('redo', 'やり直し', () => this.redo(), { title: 'Ctrl+Y・Ctrl+Shift+Z' });

    // 「その他」: what is needed now and then.
    this.more_ = document.createElement('div');
    this.more_.className = 'edit-more';
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.textContent = 'その他 ▾';
    moreButton.setAttribute('aria-haspopup', 'menu');
    moreButton.setAttribute('aria-expanded', 'false');
    this.buttons_.more = moreButton;
    this.menu_ = document.createElement('div');
    this.menu_.className = 'edit-menu';
    this.menu_.setAttribute('role', 'menu');
    this.menu_.hidden = true;
    const item = (key: string, text: string, run: () => void, title = '') => {
      const b = button(key, text, () => {
        this.closeMenu_();
        run();
      }, { title, into: this.menu_ });
      b.setAttribute('role', 'menuitem');
      return b;
    };
    const check = (key: string, text: string, run: () => void, title = '') => {
      const b = item(key, text, run, title);
      b.setAttribute('role', 'menuitemcheckbox');
      b.setAttribute('aria-checked', 'false');
    };
    check('numeric', '数値入力', () => this.setNumeric(!this.numeric_), '描くときに座標・長さ・方位・幅と高さ・半径を入力');
    check('snap', 'スナップ', () => this.setSnap(!this.snap_), '作図・形状変更時に、表示中のレイヤーの頂点や辺へ吸着');
    item('duplicate', '複製', () => this.duplicate(), '選んだ地物（ほかのレイヤーのものも）をこのレイヤーに複製');
    item('move', '移動…', () => this.openPanel_('move'), '選択した地物を距離か座標で移動');
    item('rotate', '回転…', () => this.openPanel_('rotate'), '選択した地物を角度で回転');
    item('offset', '平行線…', () => this.openPanel_('offset'), '選択した線や面から、距離を指定して平行な線・面を作成');
    item('split', '分割', () => this.setTool('split'), '選択した線や面を、地図に描いた線で分割');
    item('merge', '結合', () => this.mergeSelected(), '選択した地物を 1 つに結合');
    moreButton.addEventListener('click', () => (this.menu_.hidden ? this.openMenu_() : this.closeMenu_()));
    this.more_.append(moreButton, this.menu_);
    this.bar_.append(this.more_);
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu_.hidden && !this.more_.contains(e.target as Node)) this.closeMenu_();
    });
    this.menu_.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeMenu_();
        moreButton.focus();
      }
    });

    button('discard', '破棄', () => this.discard());
    button('save', '保存', () => void this.save());
    button('end', '編集終了', () => this.stop());

    const view = () => this.map.getView().getProjection();
    this.panel_ = new EditPanel(view, {
      say: (m) => this.options.say(m),
      place: (at) => this.place_(at),
      extend: (length, bearing) => this.extend_(length, bearing),
      back: () => this.draw_?.removeLastPoint(),
      finish: () => this.finish_(),
      rectangle: (corner, width, height, angle) => {
        const ring = rectangleRing(toLonLat(corner, view()) as LonLat, width, height, angle);
        this.addShape_(polygonOf(ring, view()));
      },
      regular: (centre, radius, sides, angle) => {
        const ring = regularRing(toLonLat(centre, view()) as LonLat, radius, sides ?? CIRCLE_SIDES, angle);
        this.addShape_(polygonOf(ring, view()));
      },
      moveBy: (east, north) => this.transformSelected_('移動', (geometries) => moveBy(geometries, view(), east, north)),
      moveTo: (at) => this.transformSelected_('移動', (geometries) => moveTo(geometries, at)),
      rotate: (degrees) => this.transformSelected_('回転', (geometries) => rotateBy(geometries, degrees)),
      offset: (metres) => this.offsetSelected(metres),
      close: () => {
        if (this.panel_.mode() && ['move', 'rotate', 'offset'].includes(this.panel_.mode()!)) this.panel_.show(null);
        else this.setNumeric(false);
        this.update_();
      },
    });
    this.bar_.append(this.panel_.element);
    // Clicks on the toolbar must not reach the map (they would draw a feature under it).
    map.getOverlayContainerStopEvent().append(this.bar_);

    window.addEventListener('beforeunload', (e) => {
      if (this.session_?.count()) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => this.key_(e));
    selection.on('change', () => this.update_());
  }

  /** The layer being edited, or null. */
  editing(): ViewerService | null {
    return this.entry_;
  }

  session(): EditSession | null {
    return this.session_;
  }

  /** Whether a map click belongs to the edit tools (adding, cutting) rather than to selecting. */
  isDrawing(): boolean {
    return this.tool_ === 'add' || this.tool_ === 'split';
  }

  /** What is drawn when adding. */
  kind(): DrawKind {
    return this.kind_.value as DrawKind;
  }

  setKind(kind: DrawKind): void {
    if (![...this.kind_.options].some((o) => o.value === kind)) return;
    this.kind_.value = kind;
    if (this.tool_ === 'add') this.setTool('add');
    else this.update_();
  }

  /** Starts editing an editable layer (another layer's editing ends first). */
  start(entry: ViewerService): boolean {
    if (this.entry_ === entry) return true;
    const target = editTargetOf(entry.service);
    const vector = entry.service.vector;
    if (!target || !vector) return false;
    if (this.entry_ && !this.stop()) return false;
    this.entry_ = entry;
    this.session_ = new EditSession(target, vector.source, vector.fields);
    this.session_.on('change', () => {
      this.update_();
      this.options.onChange?.();
    });
    this.title_.textContent = `編集中: ${entry.name}`;
    const kinds = kindsFor(target.geometryType);
    const kept = this.kind_.value as DrawKind;
    this.kind_.replaceChildren(...kindNames.filter(([k]) => kinds.includes(k)).map(([k, name]) => new Option(name, k)));
    this.kind_.value = kinds.includes(kept) ? kept : kinds[0];
    const rows = !!target.noGeometry;
    this.buttons_.add.hidden = !target.canCreate;
    this.buttons_.add.textContent = rows ? '行を追加' : '追加';
    if (rows) this.buttons_.add.removeAttribute('aria-pressed');
    else this.buttons_.add.setAttribute('aria-pressed', 'false');
    this.kind_.hidden = rows || !target.canCreate || kinds.length < 2;
    this.buttons_.reshape.hidden = rows || !target.canUpdate;
    this.buttons_.delete.hidden = !target.canDelete;
    for (const key of ['duplicate', 'offset']) this.buttons_[key].hidden = !target.canCreate;
    for (const key of ['move', 'rotate']) this.buttons_[key].hidden = !target.canUpdate;
    // Splitting and merging change one feature and add (or delete) others.
    this.buttons_.split.hidden = !(target.canUpdate && target.canCreate) || familyOf(target.geometryType ?? 'Polygon') === 'point';
    this.buttons_.merge.hidden = !(target.canUpdate && target.canDelete);
    this.buttons_.numeric.hidden = !target.canCreate;
    // A table has nothing on the map to draw, reshape, move or snap to: of 「その他」, duplicating rows only.
    if (rows) for (const key of ['move', 'rotate', 'offset', 'split', 'merge', 'numeric', 'snap']) this.buttons_[key].hidden = true;
    else this.buttons_.snap.hidden = false;
    this.more_.hidden = rows && !target.canCreate;
    this.bar_.hidden = false;
    entry.row.classList.add('editing');
    this.table.setSession(this.session_);
    this.setTool('select');
    this.options.say(`${entry.name} を編集可能。変更は「保存」まで${target.savedTo}に未反映`);
    return true;
  }

  /** Ends editing; with unsaved edits, asks whether to throw them away. Returns false when the person keeps editing. */
  stop(): boolean {
    const session = this.session_;
    if (!session) return true;
    if (session.count() > 0 && !confirm(`未保存の変更 ${session.count()} 件。破棄して編集を終了しますか？`)) return false;
    session.discard();
    this.setTool('select');
    this.panel_.show(null);
    this.closeMenu_();
    this.entry_?.row.classList.remove('editing');
    this.entry_ = null;
    this.session_ = null;
    this.bar_.hidden = true;
    this.table.setSession(null);
    this.options.onChange?.();
    return true;
  }

  setTool(tool: Tool): void {
    for (const i of [this.draw_, this.modify_, this.translate_, ...this.snaps_]) if (i) this.map.removeInteraction(i);
    this.draw_ = this.modify_ = this.translate_ = null;
    this.snaps_ = [];
    this.sketch_ = null;
    this.tool_ = tool;
    const session = this.session_;
    if (session && tool === 'split' && !this.splittable_()) {
      this.options.say('分割する線か面を 1 つ選んでから「分割」を選択');
      this.tool_ = tool = 'select';
    }
    if (session && tool === 'add') {
      const kind = this.kind();
      const type = session.target.geometryType;
      this.draw_ = this.drawFor_(kind);
      this.draw_.on('drawend', (e) => {
        this.sketch_ = null;
        this.addDrawn_(e.feature as Feature, type);
      });
      this.map.addInteraction(this.draw_);
      if (this.numeric_) this.panel_.show(panelModeOf[kind]);
    } else if (session && tool === 'split') {
      this.draw_ = this.drawFor_('LineString');
      this.draw_.on('drawend', (e) => {
        this.sketch_ = null;
        const knife = (e.feature as Feature).getGeometry() as LineString;
        // After the event: the drawn line must not be added anywhere, and the tool goes back.
        setTimeout(() => {
          this.splitSelected(knife);
          this.setTool('select');
        });
      });
      this.map.addInteraction(this.draw_);
      this.options.say('分割線を地図に作図（ダブルクリックか Enter で終了、Esc で取消）');
    } else if (session && tool === 'reshape') {
      // Drag a selected feature to move it; drag a vertex or an edge of any feature to reshape it.
      this.translate_ = new Translate({ features: this.selection.features });
      this.modify_ = new Modify({ source: session.source });
      let before = new Map<Feature, Geometry | undefined>();
      const start = (features: Feature[]) => (before = new Map(features.map((f) => [f, f.getGeometry()?.clone()])));
      this.translate_.on('translatestart', (e) => start(e.features.getArray() as Feature[]));
      this.translate_.on('translateend', () => session.reshaped(before));
      this.modify_.on('modifystart', (e) => start(e.features.getArray() as Feature[]));
      this.modify_.on('modifyend', () => session.reshaped(before));
      this.map.addInteraction(this.translate_);
      this.map.addInteraction(this.modify_);
    }
    // The number panel belongs to drawing; the forms for the selection (move, rotate, offset) stay until closed, but not while drawing or cutting.
    const forSelection = ['move', 'rotate', 'offset'].includes(this.panel_.mode() ?? '');
    if (this.isDrawing() ? !(tool === 'add' && this.numeric_) : !forSelection) this.panel_.show(null);
    // Snapping goes after the interactions it serves.
    if (session && this.snap_ && tool !== 'select') {
      // Snap indexes every edge it is given up front: layers past a limit (all together) are left out.
      let left = SNAP_LIMIT;
      const sources = [session.source, ...(this.options.snapSources?.() ?? []).filter((s) => s !== session.source)].filter((source) => {
        left -= source.getFeatures().length;
        return left >= 0;
      });
      this.snaps_ = sources.map((source) => new Snap({ source }));
      for (const snap of this.snaps_) this.map.addInteraction(snap);
    }
    this.map.getViewport().classList.toggle('drawing', this.isDrawing());
    this.update_();
  }

  /** Shows or hides the number panel while drawing. */
  setNumeric(on: boolean): void {
    this.numeric_ = on;
    if (on && this.tool_ !== 'add' && this.session_?.target.canCreate) this.setTool('add');
    else if (this.tool_ === 'add') this.panel_.show(on ? panelModeOf[this.kind()] : null);
    this.update_();
  }

  setSnap(on: boolean): void {
    this.snap_ = on;
    this.setTool(this.tool_);
  }

  undo(): void {
    if (this.sketch_) this.draw_?.removeLastPoint();
    else this.session_?.undo();
  }

  redo(): void {
    if (!this.sketch_) this.session_?.redo();
  }

  /** Adds an empty row to a table (the template's values), selected and ready for input in the attribute table. */
  addRow(): Feature | null {
    const session = this.session_;
    if (!session?.target.canCreate) return null;
    const row = new Feature();
    session.add(row);
    this.selection.set([row]);
    this.table.setMode('selected');
    this.table.focusRow(row);
    this.options.say(`行を追加。属性テーブルで値を入力し、「保存」で${session.target.savedTo}に書き込み`);
    return row;
  }

  /** Deletes the selected features (after asking). */
  deleteSelected(): void {
    this.deleteFeatures(this.selection.list());
  }

  /** Deletes `features` of the layer being edited (after asking); returns whether they were deleted. */
  deleteFeatures(list: Feature[]): boolean {
    const session = this.session_;
    const features = list.filter((f) => session?.source.hasFeature(f));
    if (!session || features.length === 0) {
      this.options.say('削除する地物を地図か属性テーブルで選択');
      return false;
    }
    const to = session.target.savedTo;
    if (!confirm(`${features.length} 件の地物を削除しますか？（「保存」まで${to}からは削除されず）`)) return false;
    this.selection.remove(features);
    session.delete(features);
    this.options.say(`${features.length} 件を削除。「保存」で${to}に反映（「元に戻す」で復元可）`);
    return true;
  }

  /**
   * Copies the selected features into the layer being edited, in place
   * (move them after): its own, or another layer's whose geometry fits, with
   * the attributes the two layers share. The copies are selected.
   */
  duplicate(): Feature[] {
    const session = this.session_;
    if (!session) return [];
    const type = session.target.geometryType;
    const editable = new Set(session.fields.filter((f) => f.editable).map((f) => f.name));
    const copies: Feature[] = [];
    let skipped = 0;
    session.group(() => {
      for (const feature of this.selection.list()) {
        const source = feature.getGeometry();
        // A table's rows: the attributes only.
        const geometry = session.target.noGeometry ? undefined : source && fitToType(source.clone(), type);
        if (!geometry && !session.target.noGeometry) {
          skipped++;
          continue;
        }
        const attributes = Object.fromEntries(Object.entries(feature.getProperties()).filter(([name]) => editable.has(name) && name !== feature.getGeometryName()));
        const copy = new Feature(geometry ?? undefined);
        session.add(copy, attributes);
        copies.push(copy);
      }
    });
    if (!copies.length) {
      this.options.say(skipped ? 'このレイヤーの図形の種類に合わないため複製不可' : '複製する地物を地図か属性テーブルで選択');
      return [];
    }
    this.selection.set(copies);
    this.table.setMode('selected');
    if (session.target.noGeometry) this.options.say(`${copies.length} 行を複製`);
    else this.options.say(`${copies.length} 件を複製（同じ位置に配置。「移動…」か「形状編集」のドラッグで移動可能）${skipped ? `。${skipped} 件は図形の種類が合わず複製対象外` : ''}`);
    return copies;
  }

  /** A parallel copy of each selected line or polygon, `metres` away (lines: left positive; polygons: outward). */
  offsetSelected(metres: number): Feature[] {
    const session = this.session_;
    if (!session) return [];
    const projection = this.map.getView().getProjection();
    const type = session.target.geometryType;
    const made: Feature[] = [];
    session.group(() => {
      for (const feature of this.selection.list()) {
        const g = feature.getGeometry();
        const offset = g && offsetGeometry(g, projection, metres);
        const geometry = offset && fitToType(offset, type);
        if (!geometry) continue;
        const copy = new Feature(geometry);
        session.add(copy);
        made.push(copy);
      }
    });
    if (!made.length) {
      this.options.say('平行線を作る線か面を選択（縮めて消える面や、レイヤーに合わない図形は作成不可）');
      return [];
    }
    this.selection.set(made);
    this.table.setMode('selected');
    this.options.say(`${made.length} 件の平行線（オフセット）を作成`);
    return made;
  }

  /** Cuts the selected line or polygon along `knife`: it keeps the first piece, and the others become new features with its attributes. */
  splitSelected(knife: LineString): Feature[] {
    const session = this.session_;
    const [feature] = this.selection.list().filter((f) => session?.source.hasFeature(f));
    const geometry = feature?.getGeometry();
    if (!session || !feature || !geometry) {
      this.options.say('分割する線か面を 1 つ選択');
      return [];
    }
    const pieces = splitGeometry(geometry, knife)?.map((g) => fitToType(g, session.target.geometryType));
    if (!pieces || pieces.some((p) => !p)) {
      this.options.say('分割失敗。線か面を横切るように作図');
      return [];
    }
    const editable = new Set(session.fields.filter((f) => f.editable).map((f) => f.name));
    const attributes = Object.fromEntries(Object.entries(feature.getProperties()).filter(([name]) => editable.has(name) && name !== feature.getGeometryName()));
    const result = [feature];
    session.group(() => {
      const before = new Map([[feature, geometry.clone()]]);
      feature.setGeometry(pieces[0]!);
      session.reshaped(before);
      for (const piece of pieces.slice(1)) {
        const f = new Feature(piece!);
        session.add(f, attributes);
        result.push(f);
      }
    });
    this.selection.set(result);
    this.table.setMode('selected');
    this.options.say(`${result.length} つに分割（属性は元の地物から複写）`);
    return result;
  }

  /** Merges the selected features of the layer into the first of them; the others are deleted. */
  mergeSelected(): Feature | null {
    const session = this.session_;
    const features = this.selection.list().filter((f) => session?.source.hasFeature(f));
    if (!session || features.length < 2) {
      this.options.say('結合する地物を 2 つ以上選択（Ctrl+クリックで追加）');
      return null;
    }
    const merged = mergeGeometries(features.map((f) => f.getGeometry()!).filter(Boolean));
    const geometry = merged && fitToType(merged, session.target.geometryType);
    if (!geometry) {
      this.options.say(
        merged ? '結合結果が離れた複数の部分になるため、このレイヤー（単一の図形）には格納不可。マルチ型のレイヤーで結合' : '同じ種類（点・線・面）の地物だけ結合可能',
      );
      return null;
    }
    const [keep, ...rest] = features;
    session.group(() => {
      const before = new Map([[keep, keep.getGeometry()?.clone()]]);
      keep.setGeometry(geometry);
      session.reshaped(before);
      session.delete(rest);
    });
    this.selection.set([keep]);
    this.options.say(`${features.length} 件を 1 つに結合（属性は最初の地物のもの）`);
    return keep;
  }

  discard(): void {
    const session = this.session_;
    if (!session || session.count() === 0) return;
    if (!confirm(`未保存の変更 ${session.count()} 件をすべて破棄しますか？`)) return;
    session.discard();
    this.options.say('未保存の変更を破棄');
  }

  /** Saves the unsaved edits; returns what was saved (null when there was nothing to save, or a save is under way). */
  async save(): Promise<SaveOutcome | null> {
    const session = this.session_;
    if (!session || this.saving_ || session.count() === 0) return null;
    this.saving_ = true;
    this.update_();
    this.options.say('保存中…');
    try {
      const outcome = await session.save();
      const { saved, failed, note } = outcome;
      this.options.say(
        failed.length === 0
          ? `${saved} 件の変更を保存${note ? `（${note}）` : ''}`
          : `${saved} 件を保存し、${failed.length} 件は保存失敗（${failed[0].message}）。保存失敗の行は赤で表示`,
      );
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.say(`保存失敗: ${message}`);
      return { saved: 0, failed: [{ feature: null, message }] };
    } finally {
      this.saving_ = false;
      this.update_();
    }
  }

  /** The Draw interaction for a kind; rectangles and circles are drawn by their corner or centre and a second click. */
  private drawFor_(kind: DrawKind): Draw {
    let draw: Draw;
    if (kind === 'Rectangle' || kind === 'Circle' || kind === 'RegularPolygon') {
      const shape: GeometryFunction = kind === 'Rectangle' ? createBox() : createRegularPolygon(kind === 'Circle' ? CIRCLE_SIDES : this.panel_.sides);
      draw = new Draw({ type: 'Circle', geometryFunction: shape });
    } else draw = new Draw({ type: kind as 'Point' | 'LineString' | 'Polygon' });
    draw.on('drawstart', (e) => {
      this.sketch_ = e.feature as Feature;
      if (kind === 'Rectangle' || kind === 'Circle' || kind === 'RegularPolygon') {
        const start = this.sketchCoordinates_()[0];
        if (start) this.panel_.setBase(start);
      }
      this.sketch_.getGeometry()?.on('change', () => this.readout_());
    });
    draw.on('drawabort', () => {
      this.sketch_ = null;
      this.panel_.setReadout('');
    });
    return draw;
  }

  /** A drawn feature into the layer, as its type. */
  private addDrawn_(feature: Feature, type: DrawableType | null): void {
    const session = this.session_;
    if (!session) return;
    const geometry = feature.getGeometry()!;
    feature.setGeometry(type ? asLayerType(geometry, type) : geometry);
    session.add(feature);
    this.selection.set([feature]);
    this.table.setMode('selected');
    this.table.focusRow(feature);
    this.panel_.setReadout('');
    this.options.say(`地物を追加。属性テーブルで属性を入力し、「保存」で${session.target.savedTo}に書き込み`);
  }

  /** A shape made from numbers (rectangle, circle): any drawing under way is given up for it. */
  private addShape_(geometry: Geometry): void {
    if (this.sketch_) this.draw_?.abortDrawing();
    this.addDrawn_(new Feature(geometry), this.session_?.target.geometryType ?? null);
  }

  /**
   * The vertices of the shape being drawn, the last one following the
   * pointer. Draw keeps them to itself (`sketchCoords_`), and has no other
   * way to tell where the last vertex is.
   */
  private sketchVertices_(): number[][] {
    const draw = this.draw_ as unknown as { sketchCoords_?: number[][] | number[][][]; mode_?: string } | null;
    const coords = draw?.sketchCoords_;
    if (!this.sketch_ || !coords) return [];
    return (draw!.mode_ === 'Polygon' ? (coords as number[][][])[0] : (coords as number[][])) ?? [];
  }

  /** The vertices placed so far in the shape being drawn (the one following the pointer left out). */
  private sketchCoordinates_(): number[][] {
    return this.sketchVertices_().slice(0, -1);
  }

  /** A typed point: a point feature, or the next vertex of the line or polygon (the first starts it). */
  private place_(at: number[]): void {
    const session = this.session_;
    if (!session) return;
    if (this.tool_ !== 'add') this.setTool('add');
    const kind = this.kind();
    if (kind === 'Point') {
      this.addShape_(new Point(at));
      return;
    }
    if (kind !== 'LineString' && kind !== 'Polygon') {
      this.panel_.setBase(at);
      return;
    }
    this.draw_?.appendCoordinates([at]);
    this.readout_();
  }

  /** The next vertex `length` metres from the last one, heading `bearing`. */
  private extend_(length: number, bearing: number): void {
    const last = this.sketchCoordinates_().at(-1);
    if (!last) {
      this.options.say('始点が未配置（地図のクリックか座標で配置）');
      return;
    }
    const projection = this.map.getView().getProjection();
    const next = geodesicDestination(toLonLat(last, projection) as LonLat, bearing, length);
    this.place_(fromLonLat(next, projection));
  }

  /** Ends the line or polygon being drawn, when it has enough vertices. */
  private finish_(): void {
    const placed = this.sketchCoordinates_().length;
    const need = this.kind() === 'Polygon' ? 3 : 2;
    if (!this.sketch_ || placed < need) {
      this.options.say(`確定には頂点 ${need} 点以上が必要`);
      return;
    }
    // Draw drops the vertex under the pointer itself.
    this.draw_?.finishDrawing();
  }

  /** The edge to the pointer, in the number panel. */
  private readout_(): void {
    if (!this.numeric_) return;
    const all = this.sketchVertices_();
    const coords = all.slice(0, -1);
    const last = coords.at(-1);
    const pointer = all.at(-1);
    if (!last || !pointer) return this.panel_.setReadout('');
    const projection = this.map.getView().getProjection();
    const { distance, bearing } = geodesicInverse(toLonLat(last, projection) as LonLat, toLonLat(pointer, projection) as LonLat);
    this.panel_.setReadout(`${coords.length} 点・いまの辺 ${edgeText(distance, bearing)}`);
  }

  /** Changes the selected features of the layer as one undoable step. */
  private transformSelected_(what: string, change: (geometries: Geometry[]) => void): void {
    const session = this.session_;
    const features = this.selection.list().filter((f) => session?.source.hasFeature(f) && f.getGeometry());
    if (!session || !features.length) {
      this.options.say(`${what}する地物を地図か属性テーブルで選択`);
      return;
    }
    const before = new Map(features.map((f) => [f, f.getGeometry()!.clone()]));
    const geometries = features.map((f) => f.getGeometry()!.clone());
    change(geometries);
    features.forEach((f, i) => f.setGeometry(geometries[i]));
    session.reshaped(before);
    this.options.say(`${features.length} 件を${what}`);
  }

  private splittable_(): boolean {
    const session = this.session_;
    const features = this.selection.list().filter((f) => session?.source.hasFeature(f));
    const family = features[0] && familyOf(features[0].getGeometry()?.getType() ?? '');
    return features.length === 1 && (family === 'line' || family === 'polygon');
  }

  private openPanel_(mode: PanelMode): void {
    if (this.tool_ === 'add' || this.tool_ === 'split') this.setTool('select');
    this.panel_.show(mode);
    if (!this.selection.list().some((f) => this.session_?.source.hasFeature(f))) this.options.say('地図か属性テーブルで地物を選んでから実行');
  }

  private openMenu_(): void {
    this.update_();
    this.menu_.hidden = false;
    this.buttons_.more.setAttribute('aria-expanded', 'true');
    (this.menu_.querySelector('button:not([hidden]):not(:disabled)') as HTMLButtonElement | null)?.focus();
  }

  private closeMenu_(): void {
    this.menu_.hidden = true;
    this.buttons_.more?.setAttribute('aria-expanded', 'false');
  }

  /** Keys while editing: undo / redo; while drawing, Backspace takes back a vertex, Enter ends, Esc gives up. */
  private key_(e: KeyboardEvent): void {
    if (!this.session_ || e.isComposing || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], dialog')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
    } else if (!ctrl && this.sketch_ && e.key === 'Backspace') {
      e.preventDefault();
      this.draw_?.removeLastPoint();
    } else if (!ctrl && this.sketch_ && e.key === 'Enter') {
      e.preventDefault();
      this.finish_();
    } else if (!ctrl && e.key === 'Escape' && (this.sketch_ || this.tool_ === 'split')) {
      if (this.sketch_) this.draw_?.abortDrawing();
      else this.setTool('select');
    }
  }

  private update_(): void {
    const session = this.session_;
    if (!session) return;
    const count = session.count();
    for (const key of ['add', 'reshape'] as const) if (this.buttons_[key].hasAttribute('aria-pressed')) this.buttons_[key].setAttribute('aria-pressed', String(this.tool_ === key));
    const own = this.selection.list().filter((f) => session.source.hasFeature(f));
    const any = this.selection.list().length > 0;
    this.buttons_.delete.disabled = own.length === 0;
    this.buttons_.undo.disabled = !session.canUndo() && !this.sketch_;
    this.buttons_.redo.disabled = !session.canRedo();
    this.buttons_.discard.disabled = count === 0;
    this.buttons_.save.disabled = count === 0 || this.saving_;
    this.buttons_.save.textContent = count ? `保存 (${count})` : '保存';
    this.buttons_.numeric.setAttribute('aria-checked', String(this.numeric_));
    this.buttons_.snap.setAttribute('aria-checked', String(this.snap_));
    this.buttons_.duplicate.disabled = !any;
    for (const key of ['move', 'rotate', 'offset']) this.buttons_[key].disabled = own.length === 0;
    this.buttons_.split.disabled = !this.splittable_();
    this.buttons_.merge.disabled = own.length < 2;
  }
}
