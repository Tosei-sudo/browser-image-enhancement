/**
 * 「移動目標撮像計画」: targets that move (ships, vehicles, anything with
 * position reports) from any point layer. The layer's attributes are mapped
 * to an id, a time, a course, a speed (and its unit) and a name — found by
 * name first, as the moving-object feeds find them — and each target is
 * carried on from its last report. 「存在予測を追加」 adds the circles where
 * each may be, every few hours, as a temporary layer; 「撮像計画の作成」
 * hands the targets to the imaging plan, which aims each pass at the circle
 * of its moment. A moving-object feed (AIS…) is used as it is, with its own
 * tracks.
 */
import Feature from 'ol/Feature.js';
import { LineString, Point, Polygon, type Geometry } from 'ol/geom.js';
import { fromLonLat, toLonLat } from 'ol/proj.js';
import { nameLabel } from './field-alias.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import { field, type ProcessingResult } from './processing/common.js';
import { wgs84 } from './vector-write.js';
import { DEFAULT_UNCERTAINTY, MAX_HORIZON, MAX_SHIPS, shipOf, type ShipState, type UncertaintyModel } from './imaging-plan-moving.js';
import { guessTargetFields, predictedPlaces, predictedTrack, speedUnits, targetsOf, type Report, type SpeedUnit, type TargetFields } from './moving-target.js';
import type { Track } from './moving.js';

export interface MovingTargetDialogOptions {
  /** The open vector layers, top first. */
  layers: () => ViewerService[];
  /** The tracks of a moving-object feed's layer; null for any other layer. */
  feedTracks: (layer: ViewerService) => Iterable<Track> | null;
  /** Opens a result as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  /** Plans the shots of the targets in the imaging plan. */
  plan: (targets: ShipState[], label: string) => void;
  say: (message: string) => void;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const ROLES: Array<[keyof TargetFields, string, string]> = [
  ['id', 'ID（目標ごとに同じ値）', '同じ値の報告を 1 つの目標の航跡として集約'],
  ['time', '時刻', 'なければすべて現在の報告とみなす'],
  ['course', '針路（度）', '北から時計回り。なければ最後の 2 報告から算出'],
  ['speed', '速力', 'なければ最後の 2 報告から算出'],
  ['name', '名前', '一覧と計画での目標の名前。なければ ID'],
];

export class MovingTargetDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly note_: HTMLElement;
  private layers_: ViewerService[] = [];

  constructor(
    button: HTMLButtonElement | null,
    private readonly selection: Selection,
    private readonly options: MovingTargetDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog moving-target-dialog';
    this.dialog.setAttribute('aria-labelledby', 'moving-target-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="moving-target-title">移動目標撮像計画</h2>
        <p class="wide processing-hint">航跡・位置報告のポイントレイヤーから、目標ごとに最後の報告の位置・針路・速力で将来位置を推測し、誤差の円（存在予測）とその撮像計画を作成。</p>
        <label class="wide">レイヤー<select name="layer" aria-label="レイヤー"></select></label>
        <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物だけ</span></label>
        <fieldset class="wide moving-target-fields"><legend>属性の対応づけ</legend>
          ${ROLES.map(([role, label, title]) => `<label title="${escape(title)}">${escape(label)}<select name="f-${role}" aria-label="${escape(label)}"></select></label>`).join('')}
          <label>速力の単位<select name="unit" aria-label="速力の単位">${(Object.keys(speedUnits) as SpeedUnit[]).map((u) => `<option value="${u}">${speedUnits[u]}</option>`).join('')}</select></label>
        </fieldset>
        <p class="wide processing-hint moving-target-feed" hidden>移動体のフィード。フィードの航跡（ID・時刻・針路・速力〔ノット〕）をそのまま使用。</p>
        <label>予測する長さ（時間）<input name="horizon" type="number" min="1" max="${MAX_HORIZON}" step="1" value="${MAX_HORIZON}" aria-label="予測する長さ" /></label>
        <label>存在予測の間隔（時間）<input name="step" type="number" min="0.25" max="72" step="any" value="6" aria-label="存在予測の間隔" /></label>
        <details class="wide pansharpen-more">
          <summary>誤差の広がり</summary>
          <div class="service-form">
            <label>報告時の誤差（km）<input name="base" type="number" min="0" step="any" value="${DEFAULT_UNCERTAINTY.base}" aria-label="報告時の誤差" /></label>
            <label>1 時間あたりの増加（km）<input name="perHour" type="number" min="0" step="any" value="${DEFAULT_UNCERTAINTY.perHour}" aria-label="1 時間あたりの増加" /></label>
            <label>航行距離に対する割合（%）<input name="share" type="number" min="0" max="100" step="any" value="${DEFAULT_UNCERTAINTY.share * 100}" aria-label="航行距離に対する割合" /></label>
            <p class="wide processing-hint">誤差の円の半径 = 報告時の誤差 + 経過時間 ×（1 時間あたりの増加 + 速力 × 割合）。変針・増減速の多い目標ほど大きく設定。</p>
          </div>
        </details>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="places">存在予測を追加</button>
        <button type="button" value="plan" class="primary">撮像計画の作成</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=places]')!.addEventListener('click', () => void this.addPlaces());
    this.dialog.querySelector('button[value=plan]')!.addEventListener('click', () => this.plan());
    this.select_('layer').addEventListener('change', () => this.listFields());
    this.form_.addEventListener('change', (e) => {
      if ((e.target as Element).getAttribute('name') !== 'layer') this.describe();
    });
    button?.addEventListener('click', () => this.open());
  }

  private select_(name: string): HTMLSelectElement {
    return this.form_.elements.namedItem(name) as HTMLSelectElement;
  }

  private number_(name: string, fallback: number): number {
    const v = Number((this.form_.elements.namedItem(name) as HTMLInputElement).value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  }

  open(): void {
    const before = this.layer()?.name;
    this.layers_ = this.options.layers();
    this.select_('layer').replaceChildren(...this.layers_.map((l, i) => new Option(`${l.name}（${l.service.vector!.source.getFeatures().length.toLocaleString()}）`, String(i))));
    const again = this.layers_.findIndex((l) => l.name === before);
    // A layer of points first: reports are points.
    const points = this.layers_.findIndex((l) => l.service.vector!.source.getFeatures().some((f) => f.getGeometry()?.getType() === 'Point'));
    this.select_('layer').value = String(again >= 0 ? again : Math.max(0, points));
    this.listFields();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** The chosen layer. */
  layer(): ViewerService | null {
    return this.layers_[Number(this.select_('layer').value)] ?? null;
  }

  /** Fills the attribute choices from the chosen layer, each set to the attribute found by name. */
  listFields(): void {
    const layer = this.layer();
    const feed = layer ? this.options.feedTracks(layer) !== null : false;
    this.dialog.querySelector<HTMLElement>('.moving-target-fields')!.hidden = feed;
    this.dialog.querySelector<HTMLElement>('.moving-target-feed')!.hidden = !feed;
    const keys = new Set<string>();
    for (const f of layer?.service.vector!.source.getFeatures().slice(0, 2000) ?? []) {
      const geometryName = f.getGeometryName();
      for (const [k, v] of Object.entries(f.getProperties())) if (k !== geometryName && (v === null || typeof v !== 'object')) keys.add(k);
    }
    const guess = guessTargetFields(keys);
    for (const [role] of ROLES) {
      const select = this.select_(`f-${role}`);
      select.replaceChildren(new Option('（なし）', ''), ...[...keys].map((k) => new Option(nameLabel(layer?.service.vector?.fields, k), k)));
      select.value = guess[role] ?? '';
    }
    // Speeds by name: sog and gs are knots; anything in km/h or m/s says so.
    const speed = (guess.speed ?? '').toLowerCase();
    this.select_('unit').value = /kmh|km_h|kph/.test(speed) ? 'kmh' : /ms$|m_s|mps/.test(speed) ? 'ms' : 'kn';
    this.describe();
  }

  /** What the form asks for: the attributes, the unit and how the guess grows uncertain. */
  private settings(): { fields: TargetFields; unit: SpeedUnit; model: UncertaintyModel; horizon: number; step: number } {
    const fields = Object.fromEntries(ROLES.map(([role]) => [role, this.select_(`f-${role}`).value || undefined])) as TargetFields;
    return {
      fields,
      unit: this.select_('unit').value as SpeedUnit,
      model: { base: this.number_('base', DEFAULT_UNCERTAINTY.base), perHour: this.number_('perHour', DEFAULT_UNCERTAINTY.perHour), share: this.number_('share', DEFAULT_UNCERTAINTY.share * 100) / 100 },
      horizon: Math.min(MAX_HORIZON, Math.max(1, this.number_('horizon', MAX_HORIZON))),
      step: Math.max(0.25, this.number_('step', 6)),
    };
  }

  /** The targets of the chosen layer (or its selected features); a reason when there are none. */
  targets(): ShipState[] | string {
    const layer = this.layer();
    if (!layer) return '航跡のポイントレイヤーを開く必要あり';
    const { fields, unit, model } = this.settings();
    const feed = this.options.feedTracks(layer);
    const selectedOnly = (this.form_.elements.namedItem('selectedOnly') as HTMLInputElement).checked;
    const source = layer.service.vector!.source;
    const chosen = selectedOnly ? this.selection.list().filter((f) => source.hasFeature(f)) : null;
    if (feed) {
      const ids = chosen ? new Set(chosen.map((f) => String(f.getId() ?? '').replace(/^moving:/, ''))) : null;
      const targets = [...feed].filter((t) => !ids || ids.has(t.id)).flatMap((t) => {
        const ship = shipOf(t);
        return ship ? [{ ...ship, model }] : [];
      });
      return targets.length ? targets : '位置報告のある目標なし';
    }
    if (!fields.id) return '目標ごとの ID になる属性を選択';
    const projection = 'EPSG:3857';
    const reports: Report[] = (chosen ?? source.getFeatures()).flatMap((f) => {
      const g = f.getGeometry();
      if (!(g instanceof Point)) return [];
      return [{ attributes: f.getProperties(), lonLat: toLonLat(g.getCoordinates(), projection) as [number, number] }];
    });
    if (!reports.length) return selectedOnly ? '選択中の地物にポイントなし' : 'このレイヤーにポイントなし（位置報告はポイントで読み込み）';
    const targets = targetsOf(reports, fields, unit, model);
    return targets.length ? targets : 'ID のある報告なし';
  }

  /** Says how many targets the form gives, and how many have no course or speed. */
  describe(): void {
    const targets = this.targets();
    if (typeof targets === 'string') return void (this.note_.textContent = targets);
    const still = targets.filter((t) => t.course === null || !t.speed).length;
    const latest = Math.max(...targets.map((t) => t.t));
    this.note_.textContent = `目標 ${targets.length.toLocaleString()} 件（最新の報告 ${new Date(latest).toLocaleString('ja-JP')}）${still ? `。うち ${still} 件は針路・速力が不明のため、その場に留まるとみなす` : ''}${targets.length > MAX_SHIPS ? `。撮像計画は最近報告のあった ${MAX_SHIPS} 件で作成` : ''}`;
  }

  /** The predicted places as a layer: a circle per target every few hours, and each target's predicted track. */
  placesLayer(): ProcessingResult | string {
    const targets = this.targets();
    if (typeof targets === 'string') return targets;
    const { horizon, step } = this.settings();
    const places = predictedPlaces(targets, -Infinity, horizon, step);
    const to = (c: [number, number]) => fromLonLat(c, 'EPSG:3857');
    const features: Feature<Geometry>[] = places.map(
      (p) =>
        new Feature<Geometry>({
          geometry: new Polygon([p.ring.map(to)]),
          kind: '存在予測',
          target_id: p.target.id,
          name: p.target.name,
          time: p.t,
          hours: Math.round(((p.t - p.target.t) / 3600000) * 100) / 100,
          radius_km: Math.round(p.radius * 100) / 100,
          course: p.target.course === null ? null : Math.round(p.target.course * 10) / 10,
          speed_kn: p.target.speed === null ? null : Math.round(p.target.speed * 10) / 10,
        }),
    );
    // The predicted track, unbroken at the antimeridian.
    for (const target of targets) {
      const track = predictedTrack(target, horizon);
      for (let i = 1; i < track.length; i++) if (Math.abs(track[i][0] - track[i - 1][0]) > 180) track[i] = [track[i][0] + (track[i][0] < track[i - 1][0] ? 360 : -360), track[i][1]];
      features.push(new Feature({ geometry: new LineString(track.map(to)), kind: '予測航跡', target_id: target.id, name: target.name, time: target.t, hours: horizon, radius_km: null, course: target.course, speed_kn: target.speed }));
    }
    return {
      title: '存在予測',
      features,
      fields: [
        field('kind', 'string', '種類'),
        field('target_id', 'string', '目標ID'),
        field('name', 'string', '名前'),
        field('time', 'date', '時刻'),
        field('hours', 'double', '報告からの時間'),
        field('radius_km', 'double', '誤差の半径km'),
        field('course', 'double', '針路'),
        field('speed_kn', 'double', '速力ノット'),
      ],
      crs: wgs84,
      geometryType: null,
    };
  }

  /** Adds the predicted places as a temporary layer. */
  async addPlaces(): Promise<void> {
    const result = this.placesLayer();
    if (typeof result === 'string') return void (this.note_.textContent = result);
    const n = result.features.filter((f) => f.get('kind') === '存在予測').length;
    await this.options.onResult(result, `存在予測 ${this.layer()?.name ?? ''}（${this.settings().horizon} 時間先まで）`);
    this.note_.textContent = `存在予測 ${n.toLocaleString()} 個の円と予測航跡をレイヤーに追加（時刻つき。タイムラインで時刻を合わせると、その時の存在予測だけを表示可能）`;
    this.options.say('存在予測をレイヤーに追加');
  }

  /** Hands the targets to the imaging plan. */
  plan(): void {
    const targets = this.targets();
    if (typeof targets === 'string') return void (this.note_.textContent = targets);
    this.dialog.close();
    this.options.plan(targets, this.layer()?.name ?? '移動目標');
  }
}
