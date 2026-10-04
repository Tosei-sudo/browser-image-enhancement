/**
 * The edit toolbar for an editable layer (an Esri layer, or a GeoJSON,
 * Shapefile or GeoPackage file), over the map: add features (drawn as the
 * layer's geometry type, or a chosen one when the file allows any), reshape them (drag a vertex; drag a
 * selected feature to move it), delete the selected ones, undo, discard,
 * and save. Only the tools the layer allows are shown. Leaving with unsaved
 * edits asks first, and so does closing the page.
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import type Geometry from 'ol/geom/Geometry.js';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import Translate from 'ol/interaction/Translate.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import type LineString from 'ol/geom/LineString.js';
import type Point from 'ol/geom/Point.js';
import type Polygon from 'ol/geom/Polygon.js';
import { EditSession, editTargetOf, type DrawableType } from './edit-session.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { AttributeTable } from './table.js';

/** What is drawn for each type: one point, line or polygon (multi types get it as their only part). */
const drawnAs: Record<DrawableType, 'Point' | 'LineString' | 'Polygon'> = {
  Point: 'Point',
  MultiPoint: 'Point',
  LineString: 'LineString',
  MultiLineString: 'LineString',
  Polygon: 'Polygon',
  MultiPolygon: 'Polygon',
};

/** A drawn geometry as the layer's type. */
function asLayerType(geometry: Geometry, type: DrawableType): Geometry {
  if (type === 'MultiPoint' && geometry.getType() === 'Point') return new MultiPoint([(geometry as Point).getCoordinates()]);
  if (type === 'MultiLineString' && geometry.getType() === 'LineString') return new MultiLineString([(geometry as LineString).getCoordinates()]);
  if (type === 'MultiPolygon' && geometry.getType() === 'Polygon') return new MultiPolygon([(geometry as Polygon).getCoordinates()]);
  return geometry;
}

type Tool = 'select' | 'add' | 'reshape';

export class Editor {
  private session_: EditSession | null = null;
  private entry_: ViewerService | null = null;
  private tool_: Tool = 'select';
  private draw_: Draw | null = null;
  private modify_: Modify | null = null;
  private translate_: Translate | null = null;
  private readonly bar_: HTMLElement;
  private readonly buttons_: Record<string, HTMLButtonElement> = {};
  private readonly title_: HTMLElement;
  /** The geometry type to draw, for files that hold any. */
  private readonly kind_: HTMLSelectElement;
  private saving_ = false;

  constructor(
    private readonly map: OlMap,
    private readonly selection: Selection,
    private readonly table: AttributeTable,
    private readonly options: { say: (message: string) => void; onChange?: () => void },
  ) {
    this.bar_ = document.createElement('div');
    this.bar_.className = 'edit-bar';
    this.bar_.setAttribute('role', 'toolbar');
    this.bar_.setAttribute('aria-label', '編集');
    this.bar_.hidden = true;
    this.title_ = document.createElement('span');
    this.title_.className = 'edit-title';
    this.bar_.append(this.title_);
    const button = (key: string, text: string, run: () => void, toggle = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.tool = key;
      if (toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', run);
      this.bar_.append(b);
      this.buttons_[key] = b;
    };
    this.kind_ = document.createElement('select');
    this.kind_.className = 'edit-kind';
    this.kind_.title = '追加する図形';
    this.kind_.setAttribute('aria-label', '追加する図形');
    for (const [value, text] of [
      ['Point', '点'],
      ['LineString', '線'],
      ['Polygon', '面'],
    ]) this.kind_.add(new Option(text, value));
    this.kind_.addEventListener('change', () => this.tool_ === 'add' && this.setTool('add'));
    this.bar_.append(this.kind_);
    button('add', '追加', () => this.setTool(this.tool_ === 'add' ? 'select' : 'add'), true);
    button('reshape', '形状編集', () => this.setTool(this.tool_ === 'reshape' ? 'select' : 'reshape'), true);
    button('delete', '削除', () => this.deleteSelected());
    button('undo', '元に戻す', () => this.session_?.undo());
    button('discard', '破棄', () => this.discard());
    button('save', '保存', () => void this.save());
    button('end', '編集終了', () => this.stop());
    // Clicks on the toolbar must not reach the map (they would draw a feature under it).
    map.getOverlayContainerStopEvent().append(this.bar_);

    window.addEventListener('beforeunload', (e) => {
      if (this.session_?.count()) e.preventDefault();
    });
    selection.on('change', () => this.update_());
  }

  /** The layer being edited, or null. */
  editing(): ViewerService | null {
    return this.entry_;
  }

  session(): EditSession | null {
    return this.session_;
  }

  /** Whether a map click belongs to the edit tools (adding) rather than to selecting. */
  isDrawing(): boolean {
    return this.tool_ === 'add';
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
    this.buttons_.add.hidden = !target.canCreate;
    this.kind_.hidden = !target.canCreate || target.geometryType !== null;
    this.buttons_.reshape.hidden = !target.canUpdate;
    this.buttons_.delete.hidden = !target.canDelete;
    this.bar_.hidden = false;
    entry.row.classList.add('editing');
    this.table.setSession(this.session_);
    this.setTool('select');
    this.options.say(`${entry.name} を編集できます。変更は「保存」を押すまで${target.savedTo}に書き込まれません`);
    return true;
  }

  /** Ends editing; with unsaved edits, asks whether to throw them away. Returns false when the person keeps editing. */
  stop(): boolean {
    const session = this.session_;
    if (!session) return true;
    if (session.count() > 0 && !confirm(`未保存の変更が ${session.count()} 件あります。破棄して編集を終了しますか？`)) return false;
    session.discard();
    this.setTool('select');
    this.entry_?.row.classList.remove('editing');
    this.entry_ = null;
    this.session_ = null;
    this.bar_.hidden = true;
    this.table.setSession(null);
    this.options.onChange?.();
    return true;
  }

  setTool(tool: Tool): void {
    for (const i of [this.draw_, this.modify_, this.translate_]) if (i) this.map.removeInteraction(i);
    this.draw_ = this.modify_ = this.translate_ = null;
    this.tool_ = tool;
    const session = this.session_;
    if (session && tool === 'add') {
      const type = session.target.geometryType ?? (this.kind_.value as DrawableType);
      this.draw_ = new Draw({ type: drawnAs[type] });
      this.draw_.on('drawend', (e) => {
        const feature = e.feature as Feature;
        feature.setGeometry(asLayerType(feature.getGeometry()!, type));
        session.add(feature);
        this.selection.set([feature]);
        this.table.setMode('selected');
        this.table.focusRow(feature);
        this.options.say(`地物を追加しました。属性テーブルで属性を入力し、「保存」で${session.target.savedTo}に書き込みます`);
      });
      this.map.addInteraction(this.draw_);
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
    this.map.getViewport().classList.toggle('drawing', tool === 'add');
    this.update_();
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
      this.options.say('削除する地物を地図か属性テーブルで選んでください');
      return false;
    }
    const to = session.target.savedTo;
    if (!confirm(`${features.length} 件の地物を削除しますか？（「保存」を押すまで${to}からは消えません）`)) return false;
    this.selection.remove(features);
    session.delete(features);
    this.options.say(`${features.length} 件を削除しました。「保存」で${to}に反映します（「元に戻す」で戻せます）`);
    return true;
  }

  discard(): void {
    const session = this.session_;
    if (!session || session.count() === 0) return;
    if (!confirm(`未保存の変更 ${session.count()} 件をすべて破棄しますか？`)) return;
    session.discard();
    this.options.say('未保存の変更を破棄しました');
  }

  async save(): Promise<void> {
    const session = this.session_;
    if (!session || this.saving_ || session.count() === 0) return;
    this.saving_ = true;
    this.update_();
    this.options.say('保存しています…');
    try {
      const { saved, failed, note } = await session.save();
      this.options.say(
        failed.length === 0
          ? `${saved} 件の変更を保存しました${note ? `（${note}）` : ''}`
          : `${saved} 件を保存し、${failed.length} 件は保存できませんでした（${failed[0].message}）。保存できなかった行は赤で示しています`,
      );
    } catch (error) {
      this.options.say(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving_ = false;
      this.update_();
    }
  }

  private update_(): void {
    const session = this.session_;
    if (!session) return;
    const count = session.count();
    for (const key of ['add', 'reshape'] as const) this.buttons_[key].setAttribute('aria-pressed', String(this.tool_ === key));
    this.buttons_.delete.disabled = this.selection.list().length === 0;
    this.buttons_.undo.disabled = !session.canUndo();
    this.buttons_.discard.disabled = count === 0;
    this.buttons_.save.disabled = count === 0 || this.saving_;
    this.buttons_.save.textContent = count ? `保存 (${count})` : '保存';
  }
}
