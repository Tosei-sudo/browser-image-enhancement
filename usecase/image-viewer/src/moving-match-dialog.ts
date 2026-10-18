/**
 * 「AI 検出と照合」: checks detections (AI results, or any point / polygon
 * layer) against a moving-object feed. For each detection, the nearest
 * object where it was at the detection's time (the image's acquisition
 * time: the detection's `image_time`, a chosen image's, or as typed) within
 * a time window and a distance. Like zonal statistics, the result is a copy
 * of the detections with columns added (ais_status, ais_id, ais_name,
 * ais_dist_m, ais_dt_s) as a temporary layer, coloured by the match:
 * unmatched detections (ships no AIS reports, say) in red.
 */
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import type LineString from 'ol/geom/LineString.js';
import type Polygon from 'ol/geom/Polygon.js';
import type MultiPolygon from 'ol/geom/MultiPolygon.js';
import { getCenter } from 'ol/extent.js';
import { toLonLat } from 'ol/proj.js';
import type { ViewerImage, ViewerLayer, ViewerService } from './images.js';
import type { MovingLayer } from './moving-layer.js';
import { matchDetections, utcText, type MatchPoint } from './moving.js';
import { attributesOf, copyFields, field, type ProcessingResult } from './processing/common.js';
import { parseTime } from './time.js';
import { imageTime } from './timeline.js';

/** The values of `ais_status`. */
export const MATCHED = '一致';
export const UNMATCHED = 'なし';
export const NO_TIME = '時刻なし';

export interface MatchDialogOptions {
  layers: () => readonly ViewerLayer[];
  selected: () => ViewerLayer | null;
  /** The feed layers open now. */
  feeds: () => MovingLayer[];
  /** Opens the result as a temporary layer, returning its entry. */
  onResult: (result: ProcessingResult, made: string) => Promise<ViewerService>;
  say: (message: string) => void;
}

/** A point standing for a detection, in the map's projection: the point, a polygon's inside point, a line's middle. */
function anchorOf(geometry: Geometry | undefined): number[] | null {
  if (!geometry) return null;
  switch (geometry.getType()) {
    case 'Point':
      return (geometry as unknown as { getCoordinates(): number[] }).getCoordinates();
    case 'Polygon':
      return (geometry as Polygon).getInteriorPoint().getCoordinates().slice(0, 2);
    case 'MultiPolygon':
      return (geometry as MultiPolygon).getInteriorPoints().getCoordinates()[0]?.slice(0, 2) ?? null;
    case 'LineString':
      return (geometry as LineString).getCoordinateAt(0.5);
    default:
      return getCenter(geometry.getExtent());
  }
}

/** Whether `entry` holds points or polygons (detections). */
function hasShapes(entry: ViewerService): boolean {
  return (entry.service.vector?.source.getFeatures() ?? []).some((f) => /Point|Polygon/.test(f.getGeometry()?.getType() ?? ''));
}

export class MatchDialog {
  readonly dialog: HTMLDialogElement;
  private readonly layer_: HTMLSelectElement;
  private readonly feed_: HTMLSelectElement;
  private readonly timeFrom_: HTMLSelectElement;
  private readonly image_: HTMLSelectElement;
  private readonly manual_: HTMLInputElement;
  private readonly window_: HTMLInputElement;
  private readonly distance_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private layers_: ViewerService[] = [];
  private feeds_: MovingLayer[] = [];
  private images_: ViewerImage[] = [];

  constructor(
    button: HTMLButtonElement | null,
    private readonly options: MatchDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog moving-match-dialog';
    this.dialog.setAttribute('aria-labelledby', 'moving-match-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="moving-match-title">AI 検出と照合</h2>
        <label class="wide">検出レイヤー<select name="layer" aria-label="検出レイヤー"></select></label>
        <label class="wide">移動体のフィード<select name="feed" aria-label="移動体のフィード"></select></label>
        <label>時刻<select name="timeFrom" aria-label="照合する時刻">
          <option value="field">各検出の撮像日時（image_time）</option>
          <option value="image">画像の撮影時刻</option>
          <option value="manual">日時を入力</option>
        </select></label>
        <label data-for="image">画像<select name="image" aria-label="画像"></select></label>
        <label data-for="manual">日時（UTC）<input name="manual" type="datetime-local" step="1" aria-label="照合する日時" /></label>
        <label>時間の幅（± 分）<input name="window" type="number" min="0" step="1" value="10" /></label>
        <label>距離（m）<input name="distance" type="number" min="1" step="1" value="500" /></label>
        <p class="wide processing-hint">検出の時刻に各移動体がいた位置（前後の報告から補間）が距離内にあれば、近いものと一致とします。結果は検出の写しに ais_status（一致・なし）・ais_id・ais_name・ais_dist_m・ais_dt_s を足した一時レイヤーで、一致しない検出は赤で表示します。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    const form = this.dialog.querySelector('form')!;
    const el = <T>(name: string) => form.elements.namedItem(name) as unknown as T;
    this.layer_ = el('layer');
    this.feed_ = el('feed');
    this.timeFrom_ = el('timeFrom');
    this.image_ = el('image');
    this.manual_ = el('manual');
    this.window_ = el('window');
    this.distance_ = el('distance');
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    form.addEventListener('change', () => this.update_());
    button?.addEventListener('click', () => void this.open());
  }

  /** Opens the dialog, with the selected detection layer chosen. */
  async open(): Promise<void> {
    const all = this.options.layers();
    this.feeds_ = this.options.feeds();
    const feedLayers = new Set(this.feeds_.map((f) => f.service));
    this.layers_ = all.filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector && !feedLayers.has(l.service) && hasShapes(l));
    this.images_ = all.filter((l): l is ViewerImage => l.type === 'image');
    this.layer_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    this.feed_.replaceChildren(...this.feeds_.map((f, i) => new Option(`${f.feed.label}（${f.store.tracks.size.toLocaleString()} 件）`, String(i))));
    this.image_.replaceChildren(...this.images_.map((l, i) => new Option(l.name, String(i))));
    const selected = this.options.selected();
    if (selected?.type === 'service' && this.layers_.includes(selected)) this.layer_.value = String(this.layers_.indexOf(selected));
    if (selected?.type === 'image' && this.images_.includes(selected)) this.image_.value = String(this.images_.indexOf(selected));
    this.note_.textContent = '';
    this.update_(true);
    if (!this.dialog.open) this.dialog.showModal();
  }

  private layer(): ViewerService | null {
    return this.layers_[Number(this.layer_.value)] ?? null;
  }

  /** The time source shown, and whether there is something to run. */
  private update_(choose = false): void {
    const entry = this.layer();
    const hasField = !!entry?.service.vector?.fields.some((f) => f.name === 'image_time');
    if (choose) this.timeFrom_.value = hasField ? 'field' : this.images_.length ? 'image' : 'manual';
    for (const label of this.dialog.querySelectorAll<HTMLElement>('label[data-for]')) label.hidden = label.dataset.for !== this.timeFrom_.value;
    const missing = !entry
      ? 'ポイントかポリゴンのレイヤー（AI の検出結果など）を開いてください'
      : !this.feeds_.length
        ? '移動体のフィードか履歴ファイルを開いてください（ツール →「移動体（AIS・ADS-B）…」）'
        : this.timeFrom_.value === 'image' && !this.images_.length
          ? '画像を開いてください'
          : this.timeFrom_.value === 'manual' && !this.manual_.value
            ? '日時を入れてください'
            : '';
    this.note_.textContent = missing;
    this.run_.disabled = !!missing;
  }

  /** Checks every detection and opens the result. */
  async run(): Promise<ViewerService | null> {
    const entry = this.layer();
    const feed = this.feeds_[Number(this.feed_.value)];
    if (!entry || !feed) return null;
    const windowMs = Math.max(0, Number(this.window_.value) || 0) * 60_000;
    const distance = Math.max(1, Number(this.distance_.value) || 500);
    let fixed: number | null = null;
    if (this.timeFrom_.value === 'image') {
      const image = this.images_[Number(this.image_.value)];
      fixed = image ? ((await imageTime(image).catch(() => null))?.time ?? null) : null;
      if (fixed === null) {
        this.note_.textContent = 'この画像の撮影時刻が分かりません（タイムラインの「設定」で入れられます）';
        return null;
      }
    } else if (this.timeFrom_.value === 'manual') {
      fixed = parseTime(`${this.manual_.value}Z`);
      if (fixed === null) {
        this.note_.textContent = '日時を読めません';
        return null;
      }
    }
    const features = entry.service.vector!.source.getFeatures().filter((f) => /Point|Polygon|LineString/.test(f.getGeometry()?.getType() ?? ''));
    const points: MatchPoint[] = [];
    const kept: Feature[] = [];
    for (const f of features) {
      const at = anchorOf(f.getGeometry());
      if (!at) continue;
      const [lon, lat] = toLonLat(at);
      const own = fixed ?? parseTime(f.get('image_time'), 'date') ?? parseTime(f.get('image_time'));
      points.push({ lon, lat, t: own });
      kept.push(f);
    }
    const matches = matchDetections(points, feed.store.tracks.values(), { window: windowMs, distance });
    let matched = 0;
    let noTime = 0;
    const out = kept.map((f, i) => {
      const m = matches[i];
      const status = points[i].t === null ? NO_TIME : m ? MATCHED : UNMATCHED;
      if (status === MATCHED) matched++;
      if (status === NO_TIME) noTime++;
      const copy = new Feature({
        ...attributesOf(f),
        ais_status: status,
        ais_id: m?.id ?? null,
        ais_name: m?.name ?? null,
        ais_dist_m: m ? Math.round(m.distance * 10) / 10 : null,
        ais_dt_s: m ? Math.round(m.dt) : null,
      });
      copy.setGeometry(f.getGeometry()!.clone());
      return copy;
    });
    const added = ['ais_status', 'ais_id', 'ais_name', 'ais_dist_m', 'ais_dt_s'];
    const fields = [
      ...copyFields(entry.service.vector!.fields).filter((f) => !added.includes(f.name)),
      field('ais_status', 'string', '照合'),
      field('ais_id', 'string', '一致した ID'),
      field('ais_name', 'string', '一致した名前'),
      field('ais_dist_m', 'double', '距離（m）'),
      field('ais_dt_s', 'integer', '時刻の差（秒）'),
    ];
    const unmatched = out.length - matched - noTime;
    const notes = [`一致 ${matched.toLocaleString()} 件・なし ${unmatched.toLocaleString()} 件${noTime ? `・時刻なし ${noTime.toLocaleString()} 件` : ''}`];
    if (fixed !== null) notes.push(`時刻 ${utcText(fixed)} ± ${windowMs / 60_000} 分`);
    const result: ProcessingResult = { title: `${entry.name}（${feed.feed.label} と照合）`, features: out, fields, notes };
    const made = `AI 検出と照合（${feed.feed.label}、${distance} m・± ${windowMs / 60_000} 分）`;
    const opened = await this.options.onResult(result, made);
    // Unmatched in red, matched in green.
    const style = opened.service.style;
    if (style) {
      const spec = style.get();
      style.set({
        ...spec,
        mode: 'categorized',
        field: 'ais_status',
        categories: [
          { value: UNMATCHED, color: '#e03131', visible: true },
          { value: MATCHED, color: '#2f9e44', visible: true },
          { value: NO_TIME, color: '#868e96', visible: true },
        ],
        othersVisible: true,
      });
    }
    this.dialog.close();
    this.options.say(`${result.title} を作成しました。${notes.join('。')}`);
    return opened;
  }
}
