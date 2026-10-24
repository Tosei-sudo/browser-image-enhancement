/**
 * 「格子の敷き詰め」: squares, hexagons or triangles of any size over an
 * area, as a temporary polygon layer (see processing/tessellate.ts).
 *
 * The everyday choices are up front: the shape, its size, geodesic (metres
 * on the ground) or a projection (any EPSG code), the area — drawn on the
 * map (a box or a polygon, the default), the features of a layer, the view,
 * or typed bounds — and what happens to cells at its edge. The rest (size
 * by width or area, rotation, hexagon direction, where the lattice starts,
 * the layer's name, the cell limit) waits under 詳細設定.
 */
import type Map from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import Polygon, { fromExtent } from 'ol/geom/Polygon.js';
import Draw, { createBox } from 'ol/interaction/Draw.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style } from 'ol/style.js';
import { toLonLat, transformExtent } from 'ol/proj.js';
import { parseCoordinate, type LonLat } from './coordinates.js';
import { formatArea, formatLength, geodesicArea } from './geodesic.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { ProcessingResult } from './processing/common.js';
import { crsPresets, targetCrs } from './processing/reproject.js';
import { cellArea, isDegrees, sideForArea, sideForWidth, tessellate, type CellShape, type ClipMode, type GridOrigin } from './processing/tessellate.js';

export interface TessellateDialogOptions {
  map: Map;
  /** The open vector layers, top first. */
  layers: () => ViewerService[];
  /** The layer selected in the list. */
  selected: () => ViewerService | null;
  /** Opens the result as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  say: (message: string) => void;
  /** Called before drawing on the map, so other click tools stop. */
  onStart?: () => void;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

const shapeNames: Record<CellShape, string> = { square: '正方形', hexagon: '六角形', triangle: '三角形' };
const shapeIcons: Record<CellShape, string> = {
  square: '<rect x="3" y="3" width="14" height="14" />',
  hexagon: '<polygon points="1,10 5.5,2.2 14.5,2.2 19,10 14.5,17.8 5.5,17.8" />',
  triangle: '<polygon points="10,2 19,17.6 1,17.6" />',
};

/** Length units by name: metres in a unit (or degrees, for a CRS in degrees). */
const lengthUnits = { m: 1, km: 1000 } as const;
const areaUnits = { 'm2': 1, ha: 10_000, km2: 1_000_000 } as const;
const degreeUnits = { deg: 1, min: 1 / 60, sec: 1 / 3600 } as const;
const unitLabels: Record<string, string> = { m: 'm', km: 'km', m2: 'm²', ha: 'ha', km2: 'km²', deg: '度', min: '分', sec: '秒', deg2: '平方度' };

const areaStyle = new Style({ stroke: new Stroke({ color: '#0ea5e9', width: 2, lineDash: [6, 4] }), fill: new Fill({ color: 'rgba(14, 165, 233, 0.06)' }) });

export class TessellateDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly drawn_: HTMLElement;
  private readonly sizeNote_: HTMLElement;
  private readonly overlay_: VectorLayer<VectorSource<Feature>>;
  private area_: Geometry | null = null;
  private draw_: Draw | null = null;
  private layers_: ViewerService[] = [];

  constructor(
    button: HTMLButtonElement | null,
    private readonly selection: Selection,
    private readonly options: TessellateDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog tessellate-dialog';
    this.dialog.setAttribute('aria-labelledby', 'tessellate-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="tessellate-title">格子の敷き詰め</h2>
        <fieldset class="wide tessellate-shapes"><legend>形</legend>${(Object.keys(shapeNames) as CellShape[])
          .map(
            (s, i) =>
              `<label><input type="radio" name="shape" value="${s}"${i === 0 ? ' checked' : ''} /><svg viewBox="0 0 20 20" aria-hidden="true">${shapeIcons[s]}</svg><span>${shapeNames[s]}</span></label>`,
          )
          .join('')}</fieldset>
        <label>大きさ（辺の長さ）<input name="size" type="number" min="0" step="any" value="1000" required aria-label="大きさ" /></label>
        <label>単位<select name="unit" aria-label="単位"></select></label>
        <p class="wide processing-hint tessellate-size-note"></p>
        <label class="wide">敷き詰め方<select name="method" aria-label="敷き詰め方">
          <option value="geodesic">測地線（地表の距離、WGS 84 楕円体）</option>
          <option value="crs">投影法（座標系を選択）</option>
        </select></label>
        <div class="wide service-form tessellate-crs" hidden>
          <label class="wide">座標系<select name="preset" aria-label="座標系">${crsPresets
            .map((p) => `<option value="${escape(p.code)}"${p.code === 'EPSG:6677' ? ' selected' : ''}>${escape(p.name)}</option>`)
            .join('')}<option value="">その他（EPSG コードを入力）</option></select></label>
          <label class="wide tessellate-code" hidden>EPSG コード<input name="code" type="text" placeholder="例: 32654" aria-label="EPSG コード" /></label>
          <p class="wide processing-hint">その座標系の平面に、その単位（経緯度なら度）で配置。結果もこの座標系で書き出し。</p>
        </div>
        <label class="wide">範囲<select name="area" aria-label="範囲">
          <option value="drawn">地図に描いた範囲（四角・多角形）</option>
          <option value="layer">レイヤーの地物</option>
          <option value="view">今の表示範囲</option>
          <option value="bbox">座標で指定（経緯度）</option>
        </select></label>
        <div class="wide tessellate-draw">
          <button type="button" value="box">□ 四角を作図</button>
          <button type="button" value="polygon">⬠ 多角形を作図</button>
          <span class="tessellate-drawn"></span>
        </div>
        <div class="wide service-form tessellate-layer" hidden>
          <label class="wide">レイヤー<select name="layer" aria-label="レイヤー"></select></label>
          <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物だけ</span></label>
        </div>
        <label class="wide tessellate-bbox" hidden>西, 南, 東, 北（経度・緯度）<input name="bbox" type="text" placeholder="例: 139.70, 35.65, 139.80, 35.72" aria-label="範囲の座標" /></label>
        <label class="wide">範囲の端のセル<select name="clip" aria-label="範囲の端のセル">
          <option value="intersects">範囲にかかるセル（形を維持）</option>
          <option value="clip">範囲の形で切り取り</option>
          <option value="center">中心が範囲内のセルのみ</option>
          <option value="within">範囲に収まるセルのみ</option>
        </select></label>
        <details class="wide pansharpen-more">
          <summary>詳細設定</summary>
          <div class="service-form tessellate-more">
            <label>大きさの決め方<select name="sizeBy" aria-label="大きさの決め方">
              <option value="side">辺の長さ</option>
              <option value="width">幅（向かい合う辺の間・三角形は高さ）</option>
              <option value="area">面積</option>
            </select></label>
            <label>回転（度・時計回り）<input name="rotation" type="number" min="-360" max="360" step="any" value="0" aria-label="回転" /></label>
            <label>六角形の向き<select name="orientation" aria-label="六角形の向き"><option value="flat">辺が上（横に並ぶ）</option><option value="pointy">角が上（縦に並ぶ）</option></select></label>
            <label>格子の基準<select name="origin" aria-label="格子の基準">
              <option value="corner">範囲の左下</option>
              <option value="center">範囲の中心にセルを配置</option>
              <option value="crs">座標系の原点（投影法のとき）</option>
              <option value="point">指定した点</option>
            </select></label>
            <label class="wide tessellate-point" hidden>基準点（緯度経度・MGRS など）<input name="point" type="text" placeholder="例: 35.681, 139.767" aria-label="基準点" /></label>
            <label class="wide check"><input name="envelope" type="checkbox" /><span>範囲を外接する四角に変更</span></label>
            <label>レイヤー名<input name="title" type="text" placeholder="格子_正方形" aria-label="レイヤー名" /></label>
            <label>セルの上限<input name="maxCells" type="number" min="1" max="1000000" step="1" value="200000" aria-label="セルの上限" /></label>
            <p class="wide processing-hint">属性は id・行（row）・列（col）・ラベル（A1 など、左上から）・面積（m²、楕円体上）。「座標系の原点」や「指定した点」を基準にすると、別の範囲で作った格子とも継ぎ目が一致。</p>
          </div>
        </details>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.drawn_ = this.dialog.querySelector('.tessellate-drawn')!;
    this.sizeNote_ = this.dialog.querySelector('.tessellate-size-note')!;
    this.overlay_ = new VectorLayer({ source: new VectorSource<Feature>(), style: areaStyle, zIndex: 9000, visible: false });
    options.map.addLayer(this.overlay_);
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      if (!this.draw_) this.overlay_.setVisible(false);
    });
    this.run_.addEventListener('click', () => void this.run());
    this.dialog.querySelector('button[value=box]')!.addEventListener('click', () => this.startDrawing('box'));
    this.dialog.querySelector('button[value=polygon]')!.addEventListener('click', () => this.startDrawing('polygon'));
    this.form_.addEventListener('change', (e) => this.update_(e.target as Element));
    this.form_.addEventListener('input', (e) => {
      if ((e.target as Element).getAttribute('name') === 'size') this.describeSize_();
    });
    button?.addEventListener('click', () => this.open());
    this.fillUnits_();
  }

  private value_(name: string): string {
    const control = this.form_.elements.namedItem(name);
    if (control instanceof RadioNodeList) return control.value;
    return (control as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  }

  private control_<T extends HTMLElement = HTMLInputElement>(name: string): T {
    return this.form_.elements.namedItem(name) as unknown as T;
  }

  /** Opens the dialog; the drawn area stays from last time and shows on the map. */
  open(): void {
    this.note_.textContent = '';
    this.fillLayers_();
    // A polygon layer selected in the list, with features selected: offered as the area.
    const selected = this.options.selected();
    if (!this.area_ && selected && this.layers_.includes(selected) && this.selectedOf_(selected).length) {
      this.control_<HTMLSelectElement>('area').value = 'layer';
      this.control_<HTMLSelectElement>('layer').value = String(this.layers_.indexOf(selected));
    }
    this.update_(null);
    this.overlay_.setVisible(true);
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Features of `entry` that are selected. */
  private selectedOf_(entry: ViewerService): Feature[] {
    const source = entry.service.vector?.source;
    return source ? this.selection.list().filter((f) => source.hasFeature(f)) : [];
  }

  private fillLayers_(): void {
    const select = this.control_<HTMLSelectElement>('layer');
    const before = this.layers_[Number(select.value)];
    this.layers_ = this.options.layers().filter((l) => (l.service.vector?.source.getFeatures().length ?? 0) > 0);
    select.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    const keep = this.layers_.indexOf(before!);
    if (keep >= 0) select.value = String(keep);
  }

  /** Shows the controls the choices need, and keeps the units fitting the plane. */
  private update_(changed: Element | null): void {
    const name = changed?.getAttribute('name') ?? null;
    const method = this.value_('method');
    const area = this.value_('area');
    const origin = this.value_('origin');
    (this.dialog.querySelector('.tessellate-crs') as HTMLElement).hidden = method !== 'crs';
    (this.dialog.querySelector('.tessellate-code') as HTMLElement).hidden = this.value_('preset') !== '';
    (this.dialog.querySelector('.tessellate-draw') as HTMLElement).hidden = area !== 'drawn';
    (this.dialog.querySelector('.tessellate-layer') as HTMLElement).hidden = area !== 'layer';
    (this.dialog.querySelector('.tessellate-bbox') as HTMLElement).hidden = area !== 'bbox';
    (this.dialog.querySelector('.tessellate-point') as HTMLElement).hidden = origin !== 'point';
    const crsOrigin = this.control_<HTMLSelectElement>('origin').querySelector<HTMLOptionElement>('option[value=crs]')!;
    crsOrigin.disabled = method !== 'crs';
    if (crsOrigin.disabled && origin === 'crs') this.control_<HTMLSelectElement>('origin').value = 'corner';
    this.control_<HTMLSelectElement>('orientation').disabled = this.value_('shape') !== 'hexagon';
    if (name === null || ['method', 'preset', 'code', 'sizeBy'].includes(name)) this.fillUnits_();
    if (name === null || name === 'layer' || name === 'area') {
      const entry = this.layers_[Number(this.value_('layer'))];
      const count = entry ? this.selectedOf_(entry).length : 0;
      const only = this.control_('selectedOnly');
      only.checked = count > 0;
      only.disabled = count === 0;
      only.nextElementSibling!.textContent = `選択中の地物だけ（${count.toLocaleString()} 件）`;
    }
    const sizeLabel = this.control_('size').closest('label')!.firstChild!;
    sizeLabel.textContent = `大きさ（${{ side: '辺の長さ', width: '幅', area: '面積' }[this.value_('sizeBy') as 'side' | 'width' | 'area']}）`;
    this.control_('title').placeholder = `格子_${shapeNames[this.value_('shape') as CellShape]}`;
    this.drawn_.textContent = this.area_ ? `描いた範囲: ${formatArea(this.areaOfDrawn_())}` : '範囲の作図なし';
    this.describeSize_();
  }

  private areaOfDrawn_(): number {
    if (!(this.area_ instanceof Polygon)) return 0;
    const ring = this.area_.getCoordinates()[0].map((xy) => toLonLat(xy) as LonLat);
    return geodesicArea(ring.slice(0, -1)).area;
  }

  /** Whether the chosen plane is in degrees (a longitude / latitude CRS). */
  private degrees_(): boolean {
    if (this.value_('method') !== 'crs') return false;
    const code = (this.value_('preset') || this.value_('code')).trim();
    if (!code) return false;
    const full = /^\d+$/.test(code) ? `EPSG:${code}` : code.toUpperCase();
    try {
      return isDegrees(full);
    } catch {
      return false;
    }
  }

  /** The unit choices for the size: lengths or areas, metres or degrees. */
  private fillUnits_(): void {
    const select = this.control_<HTMLSelectElement>('unit');
    const byArea = this.value_('sizeBy') === 'area';
    const units = this.degrees_() ? (byArea ? ['deg2'] : Object.keys(degreeUnits)) : byArea ? Object.keys(areaUnits) : Object.keys(lengthUnits);
    const before = select.value;
    if ([...select.options].map((o) => o.value).join() === units.join()) return;
    select.replaceChildren(...units.map((u) => new Option(unitLabels[u], u)));
    if (units.includes(before)) select.value = before;
    else if (byArea && units.includes('ha')) select.value = 'ha';
    this.describeSize_();
  }

  /** The side length the size and unit give, in metres or degrees. */
  private side_(shape: CellShape): number {
    const raw = Number(this.value_('size'));
    const unit = this.value_('unit');
    const scale = (lengthUnits as Record<string, number>)[unit] ?? (areaUnits as Record<string, number>)[unit] ?? (degreeUnits as Record<string, number>)[unit] ?? 1;
    const value = raw * scale;
    const by = this.value_('sizeBy');
    return by === 'area' ? sideForArea(shape, value) : by === 'width' ? sideForWidth(shape, value) : value;
  }

  /** One line on what a cell will be: its side and area. */
  private describeSize_(): void {
    const shape = this.value_('shape') as CellShape;
    const side = this.side_(shape);
    if (!(side > 0) || !Number.isFinite(side)) {
      this.sizeNote_.textContent = '';
      return;
    }
    const area = cellArea(shape, side);
    this.sizeNote_.textContent = this.degrees_()
      ? `セル1つ: 辺 ${+side.toPrecision(6)} 度`
      : `セル1つ: 辺 ${formatLength(side)}・面積 ${formatArea(area)}${this.value_('method') === 'crs' ? '（座標系の平面上）' : ''}`;
  }

  /** Lets the person draw the area on the map (the dialog steps aside meanwhile). */
  startDrawing(kind: 'box' | 'polygon'): void {
    this.stopDrawing_();
    this.options.onStart?.();
    const source = new VectorSource<Feature>();
    const draw = kind === 'box' ? new Draw({ source, type: 'Circle', geometryFunction: createBox(), style: areaStyle }) : new Draw({ source, type: 'Polygon', style: areaStyle });
    this.draw_ = draw;
    this.dialog.close();
    this.overlay_.setVisible(true);
    this.options.map.addInteraction(draw);
    this.options.say(kind === 'box' ? '地図で四角の角を 2 か所クリック（Esc で取消）' : '地図をクリックして範囲の多角形を描き、最後の点をダブルクリック（Esc で取消）');
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.draw_ === draw) {
        e.stopPropagation();
        this.stopDrawing_();
        this.open();
      }
    };
    document.addEventListener('keydown', esc, true);
    draw.once('change:active', () => document.removeEventListener('keydown', esc, true));
    draw.on('drawend', (e) => {
      const geometry = e.feature.getGeometry()!;
      this.area_ = kind === 'box' ? fromExtent(geometry.getExtent()) : geometry.clone();
      const source = this.overlay_.getSource()!;
      source.clear();
      source.addFeature(new Feature(this.area_));
      this.control_<HTMLSelectElement>('area').value = 'drawn';
      // After this event, so the click that ended the shape picks nothing.
      setTimeout(() => {
        this.stopDrawing_();
        this.options.say('');
        this.open();
      }, 0);
    });
  }

  private stopDrawing_(): void {
    if (!this.draw_) return;
    this.draw_.setActive(false);
    this.options.map.removeInteraction(this.draw_);
    this.draw_ = null;
  }

  /** The area chosen, in the map's projection, and words for it. */
  private area(): { geometries: Geometry[]; what: string } {
    const how = this.value_('area');
    if (how === 'drawn') {
      if (!this.area_) throw new Error('地図に範囲を作図（「四角を作図」「多角形を作図」）');
      return { geometries: [this.area_], what: '描いた範囲' };
    }
    if (how === 'view') {
      const map = this.options.map;
      return { geometries: [fromExtent(map.getView().calculateExtent(map.getSize()))], what: '表示範囲' };
    }
    if (how === 'bbox') {
      const numbers = this.value_('bbox').split(/[\s,，、]+/).filter(Boolean).map(Number);
      if (numbers.length !== 4 || !numbers.every(Number.isFinite)) throw new Error('範囲の座標は「西, 南, 東, 北」の 4 つの数（経度・緯度）で入力');
      const [w, s, e, n] = numbers;
      if (!(e > w && n > s) || s < -90 || n > 90) throw new Error('範囲の座標は 西 < 東、南 < 北 、緯度は −90〜90 で指定');
      return { geometries: [fromExtent(transformExtent([w, s, e, n], 'EPSG:4326', 'EPSG:3857'))], what: `${w}, ${s}, ${e}, ${n}` };
    }
    const entry = this.layers_[Number(this.value_('layer'))];
    if (!entry) throw new Error('範囲に使うレイヤーを開く必要あり');
    const features = this.control_('selectedOnly').checked ? this.selectedOf_(entry) : entry.service.vector!.source.getFeatures();
    const geometries = features.flatMap((f) => {
      const g = f.getGeometry();
      return g ? [g] : [];
    });
    if (!geometries.length) throw new Error(`${entry.name} に形のある地物なし`);
    return { geometries, what: entry.name };
  }

  /** Lays the cells and adds them as a temporary layer. */
  async run(): Promise<void> {
    const shape = this.value_('shape') as CellShape;
    this.run_.disabled = true;
    this.note_.textContent = '格子を作成中…';
    // Let the message show before a long computation holds the page.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    try {
      let { geometries, what } = this.area();
      if (this.control_('envelope').checked) {
        const extent = geometries.reduce((e, g) => {
          const [a, b, c, d] = g.getExtent();
          return [Math.min(e[0], a), Math.min(e[1], b), Math.max(e[2], c), Math.max(e[3], d)];
        }, [Infinity, Infinity, -Infinity, -Infinity]);
        geometries = [fromExtent(extent)];
        what += 'の外接矩形';
      }
      const method = this.value_('method');
      const crs = method === 'crs' ? await targetCrs(this.value_('preset') || this.value_('code')) : null;
      const origin = this.value_('origin') as GridOrigin;
      let point: LonLat | undefined;
      if (origin === 'point') {
        point = parseCoordinate(this.value_('point')) ?? undefined;
        if (!point) throw new Error('基準点の読み込みに失敗（例: 35.681, 139.767）');
      }
      const side = this.side_(shape);
      const clip = this.value_('clip') as ClipMode;
      const result = tessellate(geometries, {
        shape,
        size: side,
        crs,
        rotation: Number(this.value_('rotation')) || 0,
        orientation: this.value_('orientation') as 'flat' | 'pointy',
        origin,
        point,
        clip,
        maxCells: Number(this.value_('maxCells')) || 200_000,
        title: this.value_('title').trim() || undefined,
      });
      if (!result.features.length) throw new Error('範囲にかかるセルなし');
      const size = crs && isDegrees(crs.projection) ? `${+side.toPrecision(6)} 度` : formatLength(side);
      const clipWords: Record<ClipMode, string> = { intersects: '', clip: '・切り取り', center: '・中心が範囲内', within: '・範囲内のみ' };
      const made = `格子（${shapeNames[shape]}、辺 ${size}、${crs ? crs.name : '測地線'}${clipWords[clip]}）（${what}）`;
      await this.options.onResult(result, made);
      this.dialog.close();
      const notes = (result.notes ?? []).filter((n) => !n.endsWith('作成'));
      this.options.say([`${result.title} を作成（${result.features.length.toLocaleString()} 個のセル、一時レイヤー）`, ...notes].join('。'));
    } catch (error) {
      this.note_.textContent = `格子の作成に失敗: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.run_.disabled = false;
    }
  }
}

