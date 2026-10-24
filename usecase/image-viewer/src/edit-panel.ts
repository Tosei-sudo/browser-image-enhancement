/**
 * The edit toolbar's number panel, under it, shown only when asked for:
 * while drawing, a vertex at a typed coordinate (latitude and longitude,
 * MGRS, UTM, or X/Y in a projected CRS such as a JGD2011 plane rectangular
 * zone), or at a length and bearing from the last one; a rectangle from a
 * corner and its width and height; a circle or regular polygon from its
 * centre and radius. For the selected features: moving by metres or to a
 * coordinate, turning by an angle, and a parallel copy at a distance.
 */
import { getTransform, toLonLat, type ProjectionLike } from 'ol/proj.js';
import type Projection from 'ol/proj/Projection.js';
import { formatLatLon, parseCoordinate, type LonLat } from './coordinates.js';
import { formatLength } from './geodesic.js';
import { crsPresets } from './processing/reproject.js';
import { projectionOf } from './services/common.js';

type Coordinate = number[];

/** What the panel is for: drawing a kind of shape, or an operation on the selection. */
export type PanelMode = 'point' | 'line' | 'polygon' | 'rectangle' | 'circle' | 'regular' | 'move' | 'rotate' | 'offset';

/** What the panel's buttons do; coordinates are in the map's projection, lengths in metres on the ground, angles in degrees clockwise. */
export interface PanelActions {
  /** A point, or the next vertex, at `at`. */
  place(at: Coordinate): void;
  /** The next vertex `length` metres from the last one, heading `bearing`. */
  extend(length: number, bearing: number): void;
  /** Takes back the last vertex. */
  back(): void;
  /** Ends the line or polygon being drawn. */
  finish(): void;
  rectangle(corner: Coordinate, width: number, height: number, angle: number): void;
  /** A circle (`sides` null) or regular polygon. */
  regular(centre: Coordinate, radius: number, sides: number | null, angle: number): void;
  moveBy(east: number, north: number): void;
  moveTo(at: Coordinate): void;
  rotate(degrees: number): void;
  offset(metres: number): void;
  close(): void;
  say(message: string): void;
}

/** Japan's plane rectangular zones (JGD2011 and JGD2000), whose surveyors write X (north) before Y (east). */
function isPlaneZone(code: string): boolean {
  const n = Number(/^EPSG:(\d+)$/.exec(code)?.[1]);
  return (n >= 6669 && n <= 6687) || (n >= 2443 && n <= 2461);
}

/**
 * A coordinate typed in a notation or CRS of the person's choice: one field
 * for latitude/longitude, MGRS and UTM, or two for X and Y in a projected
 * CRS (pasting `x, y` into the first fills both).
 */
export class CoordinateField {
  readonly element: HTMLElement;
  private readonly crs_: HTMLSelectElement;
  private readonly text_: HTMLInputElement;
  private readonly first_: HTMLInputElement;
  private readonly second_: HTMLInputElement;
  private readonly code_: HTMLInputElement;
  private readonly firstLabel_: HTMLElement;
  private readonly secondLabel_: HTMLElement;

  constructor(
    label: string,
    private readonly mapProjection: () => ProjectionLike,
    onEnter: () => void,
  ) {
    const element = (this.element = document.createElement('div'));
    element.className = 'edit-coordinate';
    const name = document.createElement('span');
    name.className = 'edit-label';
    name.textContent = label;
    const input = (aria: string, placeholder = '', className = '') => {
      const i = document.createElement('input');
      i.type = 'text';
      i.setAttribute('aria-label', aria);
      i.placeholder = placeholder;
      i.className = className;
      i.autocomplete = 'off';
      i.spellcheck = false;
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          onEnter();
        }
      });
      return i;
    };
    this.text_ = input(`${label}（緯度経度・MGRS・UTM）`, '35.6812, 139.7671 / 54SUE… / 54N 386543 3950123', 'edit-coordinate-text');
    this.first_ = input(`${label} X`, '', 'edit-number');
    this.second_ = input(`${label} Y`, '', 'edit-number');
    this.code_ = input(`${label}の EPSG コード`, 'EPSG コード', 'edit-number');
    // `x, y` pasted or typed into the first field goes into both.
    this.first_.addEventListener('input', () => {
      const parts = this.first_.value.trim().split(/[\s,，、]+/);
      if (parts.length === 2 && parts.every((p) => p !== '' && Number.isFinite(Number(p)))) {
        this.first_.value = parts[0];
        this.second_.value = parts[1];
        this.second_.focus();
      }
    });
    this.firstLabel_ = document.createElement('span');
    this.secondLabel_ = document.createElement('span');
    this.crs_ = document.createElement('select');
    this.crs_.setAttribute('aria-label', `${label}の座標系`);
    this.crs_.className = 'edit-crs';
    this.crs_.add(new Option('緯度経度・MGRS・UTM', 'auto'));
    for (const p of crsPresets) if (p.code !== 'EPSG:4326') this.crs_.add(new Option(p.name, p.code));
    this.crs_.add(new Option('その他（EPSG コード）', 'other'));
    this.crs_.addEventListener('change', () => {
      CoordinateField.lastCrs = this.crs_.value;
      this.update_();
    });
    this.crs_.value = CoordinateField.lastCrs;
    if (this.crs_.selectedIndex < 0) this.crs_.value = 'auto';
    const pair = (l: HTMLElement, i: HTMLInputElement) => {
      const wrap = document.createElement('label');
      wrap.className = 'edit-pair';
      wrap.append(l, i);
      return wrap;
    };
    element.append(name, this.text_, pair(this.firstLabel_, this.first_), pair(this.secondLabel_, this.second_), this.code_, this.crs_);
    this.update_();
  }

  /** The CRS chosen last, for the next field (the same person keeps typing in one). */
  static lastCrs = 'auto';

  focus(): void {
    (this.crs_.value === 'auto' ? this.text_ : this.first_).focus();
  }

  /** The coordinate typed, in the map's projection; null (and why, to the person) when it cannot be read. */
  async read(say: (message: string) => void): Promise<Coordinate | null> {
    const to = this.mapProjection();
    if (this.crs_.value === 'auto') {
      const lonLat = parseCoordinate(this.text_.value);
      if (!lonLat) {
        say(this.text_.value.trim() ? `座標の読み込みに失敗: ${this.text_.value.trim()}` : '座標を入力');
        return null;
      }
      return getTransform('EPSG:4326', to)(lonLat);
    }
    const projection = await this.projection_();
    if (!projection) {
      say('座標系が不明。EPSG コードを確認');
      return null;
    }
    const a = Number(this.first_.value.trim());
    const b = Number(this.second_.value.trim());
    if (this.first_.value.trim() === '' || this.second_.value.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) {
      say('X と Y を数値で入力');
      return null;
    }
    // Plane rectangular zones: X is north, Y is east.
    const xy = isPlaneZone(projection.getCode()) ? [b, a] : [a, b];
    return getTransform(projection, to)(xy);
  }

  /** Shows `at` (map projection) in the chosen notation. */
  async set(at: Coordinate): Promise<void> {
    const from = this.mapProjection();
    if (this.crs_.value === 'auto') {
      this.text_.value = formatLatLon(toLonLat(at, from) as LonLat);
      return;
    }
    const projection = await this.projection_();
    if (!projection) return;
    const [x, y] = getTransform(from, projection)(at);
    const digits = projection.getUnits() === 'degrees' ? 7 : 3;
    const [a, b] = isPlaneZone(projection.getCode()) ? [y, x] : [x, y];
    this.first_.value = a.toFixed(digits);
    this.second_.value = b.toFixed(digits);
  }

  private async projection_(): Promise<Projection | null> {
    const value = this.crs_.value;
    const code = value === 'other' ? this.code_.value.trim().replace(/^(?:EPSG\s*:\s*)?(\d+)$/i, 'EPSG:$1') : value;
    if (!/^EPSG:\d+$/.test(code)) return null;
    return projectionOf(code).catch(() => null);
  }

  private update_(): void {
    const value = this.crs_.value;
    const auto = value === 'auto';
    this.text_.hidden = !auto;
    for (const i of [this.first_, this.second_]) (i.parentElement as HTMLElement | null)?.toggleAttribute('hidden', auto);
    this.code_.hidden = value !== 'other';
    const plane = isPlaneZone(value);
    const degrees = /^EPSG:(4612|6668|4301)$/.test(value);
    this.firstLabel_.textContent = plane ? 'X（北）' : degrees ? '経度' : 'X（東）';
    this.secondLabel_.textContent = plane ? 'Y（東）' : degrees ? '緯度' : 'Y（北）';
    this.first_.setAttribute('aria-label', this.firstLabel_.textContent);
    this.second_.setAttribute('aria-label', this.secondLabel_.textContent);
  }
}

/** A labelled number field; Enter runs `onEnter`. */
function numberField(label: string, unit: string, onEnter: () => void, value = ''): { element: HTMLLabelElement; read: () => number | null; input: HTMLInputElement } {
  const element = document.createElement('label');
  element.className = 'edit-pair';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'edit-number';
  input.value = value;
  input.setAttribute('aria-label', label);
  input.autocomplete = 'off';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      onEnter();
    }
  });
  const name = document.createElement('span');
  name.textContent = label;
  const after = document.createElement('span');
  after.className = 'edit-unit';
  after.textContent = unit;
  element.append(name, input, after);
  return {
    element,
    input,
    read: () => {
      const text = input.value.normalize('NFKC').trim().replace(/[−]/g, '-');
      if (text === '') return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    },
  };
}

function button(text: string, run: () => void, title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', run);
  return b;
}

function row(...children: HTMLElement[]): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'edit-row';
  r.append(...children);
  return r;
}

const titles: Record<PanelMode, string> = {
  point: '数値入力: 点',
  line: '数値入力: 線',
  polygon: '数値入力: 面',
  rectangle: '数値入力: 矩形',
  circle: '数値入力: 円',
  regular: '数値入力: 正多角形',
  move: '移動',
  rotate: '回転',
  offset: '平行線（オフセット）',
};

export class EditPanel {
  readonly element: HTMLElement;
  private mode_: PanelMode | null = null;
  /** The field the base point of a rectangle, circle or polygon goes into when it is clicked on the map. */
  private base_: CoordinateField | null = null;
  private readout_: HTMLElement | null = null;
  /** The sides of a regular polygon, kept for the next one. */
  sides = 6;

  constructor(
    private readonly projection: () => ProjectionLike,
    private readonly actions: PanelActions,
  ) {
    const element = (this.element = document.createElement('div'));
    element.className = 'edit-panel';
    element.setAttribute('role', 'group');
    element.hidden = true;
  }

  mode(): PanelMode | null {
    return this.mode_;
  }

  /** Shows the form for `mode` (null: hides the panel). */
  show(mode: PanelMode | null): void {
    if (mode === this.mode_ && !this.element.hidden) return;
    this.mode_ = mode;
    this.base_ = null;
    this.readout_ = null;
    this.element.replaceChildren();
    this.element.hidden = mode === null;
    if (!mode) return;
    this.element.setAttribute('aria-label', titles[mode]);
    const head = document.createElement('div');
    head.className = 'edit-panel-head';
    const title = document.createElement('strong');
    title.textContent = titles[mode];
    const close = button('×', () => this.actions.close(), '閉じる');
    close.setAttribute('aria-label', '閉じる');
    close.className = 'edit-panel-close';
    head.append(title, close);
    this.element.append(head, ...this.form_(mode));
  }

  /** Puts the point clicked on the map into the base point field (a rectangle's corner, a circle's centre). */
  setBase(at: Coordinate): void {
    void this.base_?.set(at);
  }

  /** What the line being drawn has just now (the edge to the pointer), for the person to read. */
  setReadout(text: string): void {
    if (this.readout_) this.readout_.textContent = text;
  }

  private form_(mode: PanelMode): HTMLElement[] {
    const a = this.actions;
    const say = (m: string) => a.say(m);
    const need = (value: number | null, what: string): value is number => {
      if (value === null) say(`${what}を数値で入力`);
      return value !== null;
    };
    switch (mode) {
      case 'point':
      case 'line':
      case 'polygon': {
        const at = new CoordinateField(mode === 'point' ? '位置' : '頂点', this.projection, () => void place());
        const place = async () => {
          const c = await at.read(say);
          if (c) a.place(c);
        };
        const rows = [row(at.element, button(mode === 'point' ? '点を配置' : '頂点を配置', () => void place()))];
        if (mode !== 'point') {
          const extend = () => {
            const l = length.read();
            const b = bearing.read();
            if (need(l, '長さ') && need(b, '方位')) a.extend(l, b);
          };
          const length = numberField('長さ', 'm', extend);
          const bearing = numberField('方位', '°', extend);
          bearing.input.title = '北から時計回りの角度（東が 90°）';
          rows.push(row(length.element, bearing.element, button('延長', extend, '直前の頂点からこの長さと方位で次の頂点を配置')));
          const readout = (this.readout_ = document.createElement('span'));
          readout.className = 'edit-readout';
          readout.setAttribute('aria-live', 'off');
          rows.push(row(readout, button('1 点戻す', () => a.back(), 'Backspace'), button('確定', () => a.finish(), 'Enter・ダブルクリック')));
        }
        setTimeout(() => at.focus());
        return rows;
      }
      case 'rectangle': {
        const corner = (this.base_ = new CoordinateField('角', this.projection, () => void make()));
        const make = async () => {
          const w = width.read();
          const h = height.read();
          if (!need(w, '幅') || !need(h, '高さ')) return;
          const c = await corner.read(say);
          if (c) a.rectangle(c, w, h, angle.read() ?? 0);
        };
        const width = numberField('幅', 'm', () => void make());
        width.input.title = '角から右（東）へ。負の値は左へ';
        const height = numberField('高さ', 'm', () => void make());
        height.input.title = '角から上（北）へ。負の値は下へ';
        const angle = numberField('角度', '°', () => void make(), '0');
        angle.input.title = '時計回りに回す角度';
        setTimeout(() => corner.focus());
        return [row(corner.element), row(width.element, height.element, angle.element, button('作成', () => void make())), this.hint_('角は地図のクリックでも入力可')];
      }
      case 'circle':
      case 'regular': {
        const centre = (this.base_ = new CoordinateField('中心', this.projection, () => void make()));
        const make = async () => {
          const r = radius.read();
          if (!need(r, '半径')) return;
          if (r <= 0) return say('半径は正の値で入力');
          let n: number | null = null;
          if (sides) {
            n = sides.read();
            if (n === null || !Number.isInteger(n) || n < 3 || n > 360) return say('辺の数は 3〜360 の整数で入力');
            this.sides = n;
          }
          const c = await centre.read(say);
          if (c) a.regular(c, r, n, angle?.read() ?? 0);
        };
        const radius = numberField('半径', 'm', () => void make());
        const sides = mode === 'regular' ? numberField('辺の数', '', () => void make(), String(this.sides)) : null;
        const angle = mode === 'regular' ? numberField('角度', '°', () => void make(), '0') : null;
        if (angle) angle.input.title = '最初の頂点の方位（北から時計回り）';
        setTimeout(() => centre.focus());
        return [
          row(centre.element),
          row(radius.element, ...(sides && angle ? [sides.element, angle.element] : []), button('作成', () => void make())),
          this.hint_('中心は地図のクリックでも入力可'),
        ];
      }
      case 'move': {
        const by = () => {
          const e = east.read() ?? 0;
          const n = north.read() ?? 0;
          if (e === 0 && n === 0) return say('動かす距離を入力');
          a.moveBy(e, n);
        };
        const east = numberField('東へ', 'm', by);
        east.input.title = '負の値は西へ';
        const north = numberField('北へ', 'm', by);
        north.input.title = '負の値は南へ';
        const to = new CoordinateField('移動先', this.projection, () => void moveTo());
        const moveTo = async () => {
          const c = await to.read(say);
          if (c) a.moveTo(c);
        };
        setTimeout(() => east.input.focus());
        return [row(east.element, north.element, button('ずらし', by)), row(to.element, button('中心をここへ', () => void moveTo())), this.hint_('選択中の地物を移動')];
      }
      case 'rotate': {
        const turn = () => {
          const d = degrees.read();
          if (need(d, '角度')) a.rotate(d);
        };
        const degrees = numberField('角度', '°', turn);
        degrees.input.title = '時計回り。負の値は反時計回り';
        setTimeout(() => degrees.input.focus());
        return [row(degrees.element, button('回転', turn)), this.hint_('選択中の地物を、その中心のまわりに時計回りに回転')];
      }
      case 'offset': {
        const make = () => {
          const d = distance.read();
          if (!need(d, '距離')) return;
          if (d === 0) return say('距離は 0 以外で入力');
          a.offset(d);
        };
        const distance = numberField('距離', 'm', make);
        setTimeout(() => distance.input.focus());
        return [row(distance.element, button('作成', make)), this.hint_('線は進む向きの左が正・右が負、面は外側が正・内側が負')];
      }
    }
  }

  private hint_(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'edit-hint';
    p.textContent = text;
    return p;
  }
}

/** The edge being drawn for people: `123.45 m・方位 45.0°`. */
export function edgeText(distance: number, bearing: number): string {
  return `${formatLength(distance)}・方位 ${bearing.toFixed(1)}°`;
}
