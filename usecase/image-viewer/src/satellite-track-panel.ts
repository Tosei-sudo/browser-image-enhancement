/**
 * The 「衛星パス」 panel: the ground track of the chosen satellites and what
 * each can image (撮像可能範囲: the band its off-nadir angles reach, on the
 * sides it can look to), at a moment (the pass around it, with the satellite
 * where it is then) or over a period, on the map and in the 3D view. Several
 * satellites show at once, each in its own colour. The satellites are the
 * imaging plan's (config.json's satelliteCatalogs, or the samples), and TLEs
 * can be pasted.
 *
 * The everyday form is the satellites and the time; how long around the
 * moment, a smaller off-nadir limit, daylight, time marks and pasted TLEs
 * wait under 「詳細」.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style.js';
import { LineString, MultiLineString, MultiPolygon, Point, Polygon } from 'ol/geom.js';
import { createEmpty, extend, isEmpty } from 'ol/extent.js';
import { fromLonLat } from 'ol/proj.js';
import { builtInDefaults, satellitesFromText, type SatelliteSpec } from './imaging-plan.js';
import { localText } from './imaging-plan-panel.js';
import { bandRings, sampleAt, satelliteTrack, track3d, wrapLine, wrapPolygon, type SatelliteTrack, type Track3d } from './satellite-track.js';
import { field, type ProcessingResult } from './processing/common.js';
import { wgs84 } from './vector-write.js';

export interface TrackPanelOptions {
  /** The satellites to choose from (the imaging plan's catalog, or its samples). */
  satellites: () => Promise<SatelliteSpec[]>;
  say: (message: string) => void;
  /** Adds the tracks and reach as a layer. */
  onLayer: (result: ProcessingResult, made: string) => void;
  /** Called when what is drawn changes (for the 3D view). */
  onChange?: () => void;
}

/** The longest period drawn. */
export const MAX_DAYS = 7;
/** The colours of the satellites, in the order they are chosen. */
export const TRACK_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5'];
/** Minutes between time marks, the smallest giving at most this many marks on a track. */
const MAX_TICKS = 48;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

interface Listed {
  sat: SatelliteSpec;
  key: string;
  box: HTMLInputElement;
  label: HTMLLabelElement;
}

const pad = (n: number) => String(n).padStart(2, '0');
const inputText = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const round = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);
const keyOf = (sat: SatelliteSpec) => `${sat.source}\n${sat.id}`;

const styleOf = (feature: Feature): Style | Style[] => {
  const color = String(feature.get('color') ?? '#2563eb');
  switch (feature.get('kind')) {
    case 'track':
      return new Style({ stroke: new Stroke({ color, width: 2 }) });
    case 'reach':
      return new Style({ stroke: new Stroke({ color: `${color}99`, width: 1 }), fill: new Fill({ color: `${color}2e` }) });
    case 'tick':
      return new Style({
        image: new Circle({ radius: 3, fill: new Fill({ color }), stroke: new Stroke({ color: '#fff', width: 1 }) }),
        text: new Text({ text: String(feature.get('label') ?? ''), font: '11px sans-serif', offsetX: 6, textAlign: 'left', fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
      });
    case 'satellite':
      return new Style({
        image: new Circle({ radius: 7, stroke: new Stroke({ color: '#fff', width: 2 }), fill: new Fill({ color }) }),
        text: new Text({ text: String(feature.get('label') ?? ''), font: '600 12px sans-serif', offsetY: -16, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }),
        zIndex: 10,
      });
    default:
      return [];
  }
};

/** Minutes between time marks for a track of `minutes`. */
export function tickMinutes(minutes: number): number {
  return TICK_STEPS.find((m) => minutes / m <= MAX_TICKS) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

export class SatelliteTrackPanel {
  readonly dialog: HTMLDialogElement;
  /** The tracks on the map while the panel is open. */
  readonly overlay = new VectorLayer({ source: new VectorSource<Feature>(), style: (f) => styleOf(f as Feature), zIndex: 1000, declutter: true });
  private readonly form_: HTMLFormElement;
  private readonly list_: HTMLElement;
  private readonly count_: HTMLElement;
  private readonly filter_: HTMLInputElement;
  private readonly status_: HTMLElement;
  private readonly table_: HTMLTableElement;
  private readonly layer_: HTMLButtonElement;
  private readonly zoom_: HTMLButtonElement;
  private catalog_: SatelliteSpec[] = [];
  private loaded_: Promise<void> | null = null;
  private listed_: Listed[] = [];
  /** Each satellite's colour, kept while it stays chosen. */
  private readonly colors_ = new Map<string, string>();
  private tracks_: Array<{ track: SatelliteTrack; color: string }> = [];
  private timer_ = 0;
  private live_ = 0;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly options: TrackPanelOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service track-dialog';
    this.dialog.setAttribute('aria-labelledby', 'track-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="track-title">衛星パス</h2>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <form class="service-form track-form">
        <fieldset class="plan-sats track-sats wide">
          <legend>衛星 <span class="track-count"></span> <button type="button" value="none">解除</button></legend>
          <input type="search" name="filter" placeholder="名前で絞り込み" aria-label="衛星を名前で絞り込み" hidden />
          <div class="plan-sats-list track-list"></div>
        </fieldset>
        <label>表示<select name="mode"><option value="at">時点</option><option value="range">期間</option></select></label>
        <label class="track-at">時刻<span class="track-time"><input name="at" type="datetime-local" step="60" /><button type="button" value="now" title="現在時刻にします">今</button></span></label>
        <label class="track-range" hidden>開始<input name="from" type="datetime-local" step="60" /></label>
        <label class="track-range" hidden>終了<input name="to" type="datetime-local" step="60" /></label>
        <details class="catalog-more wide track-more">
          <summary>詳細</summary>
          <div class="track-more-body">
            <label class="track-at">前後の時間<select name="window"><option value="5">5 分</option><option value="15" selected>15 分</option><option value="50">50 分（約半周）</option><option value="100">100 分（約 1 周）</option></select></label>
            <label title="空欄は各衛星の最大オフナディア角">オフナディア角（以下）<input name="maxOffNadir" type="number" min="0" max="80" step="any" placeholder="衛星の上限" /></label>
            <label title="光学衛星の撮像可能範囲を、衛星直下の太陽高度がこの値以上の所だけにします（SAR は常に表示）">日照条件<select name="daylight"><option value="">考慮しない</option><option value="10">光学衛星は日中のみ（太陽高度 10° 以上）</option><option value="0">光学衛星は日中のみ（太陽高度 0° 以上）</option></select></label>
            <label class="check"><input name="ticks" type="checkbox" checked />軌跡に時刻を表示</label>
            <label class="check track-at"><input name="live" type="checkbox" />現在時刻に合わせ続ける（30 秒ごと）</label>
            <label class="wide">TLE を貼り付けて追加<textarea name="tle" rows="3" placeholder="ISS (ZARYA)&#10;1 25544U 98067A   …&#10;2 25544  51.6416 …" spellcheck="false"></textarea></label>
            <div class="plan-pasted wide">
              <label>最大オフナディア角<input name="pasteMax" type="number" min="0" max="80" step="any" value="${builtInDefaults.maxOffNadir}" /></label>
              <label>最小オフナディア角<input name="pasteMin" type="number" min="0" max="80" step="any" value="0" /></label>
              <label>向き<select name="pasteSide"><option value="both">左右</option><option value="right">右のみ</option><option value="left">左のみ</option></select></label>
              <label class="check"><input name="pasteSar" type="checkbox" />SAR</label>
            </div>
          </div>
        </details>
      </form>
      <p class="service-status" role="status"></p>
      <div class="catalog-results track-results" hidden><table class="catalog-table track-table"><thead><tr><th></th><th>衛星</th><th class="track-pos-head">位置</th><th>高度</th><th>軌道</th><th>撮像可能範囲</th></tr></thead><tbody></tbody></table></div>
      <div class="service-actions catalog-actions">
        <button type="button" value="layer" disabled title="軌跡と撮像可能範囲をレイヤーとして追加します">レイヤーとして追加</button>
        <button type="button" value="zoom" class="primary" disabled>範囲へ移動</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.list_ = this.dialog.querySelector('.track-list')!;
    this.count_ = this.dialog.querySelector('.track-count')!;
    this.filter_ = this.dialog.querySelector('input[name=filter]')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.table_ = this.dialog.querySelector('table')!;
    this.layer_ = this.dialog.querySelector('button[value=layer]')!;
    this.zoom_ = this.dialog.querySelector('button[value=zoom]')!;

    button.addEventListener('click', () => (this.dialog.open ? this.close() : this.open()));
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => {
      map.removeLayer(this.overlay);
      this.setLive(false);
      this.options.onChange?.();
    });
    this.form_.addEventListener('submit', (e) => e.preventDefault());
    this.form_.addEventListener('change', (e) => {
      const name = (e.target as HTMLInputElement).name;
      if (name === 'filter') return;
      if (name === 'mode') this.showMode();
      if (name === 'live') this.setLive((e.target as HTMLInputElement).checked);
      if (['tle', 'pasteMax', 'pasteMin', 'pasteSide', 'pasteSar'].includes(name)) this.listSats();
      this.schedule();
    });
    this.form_.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.name === 'filter') this.applyFilter();
      else if (target.type === 'datetime-local' || target.type === 'number') this.schedule();
    });
    this.dialog.querySelector('button[value=now]')!.addEventListener('click', () => {
      this.input('at').value = inputText(Date.now());
      this.schedule();
    });
    this.dialog.querySelector('.track-sats button[value=none]')!.addEventListener('click', () => {
      for (const l of this.listed_) l.box.checked = false;
      this.countSats();
      this.schedule();
    });
    this.layer_.addEventListener('click', () => this.addLayer());
    this.zoom_.addEventListener('click', () => this.zoomTo());
  }

  /** Shows the panel (non-modal, so the map stays usable). */
  open(): void {
    if (!this.map.getLayers().getArray().includes(this.overlay)) this.map.addLayer(this.overlay);
    const now = Date.now();
    if (!this.input('at').value) this.input('at').value = inputText(now);
    if (!this.input('from').value) this.input('from').value = inputText(now);
    if (!this.input('to').value) this.input('to').value = inputText(now + 86400000);
    this.dialog.show();
    void this.load().then(() => this.draw());
  }

  close(): void {
    this.dialog.close();
  }

  /** The satellites listed, and whether each is chosen. */
  satellites(): Array<{ sat: SatelliteSpec; checked: boolean }> {
    return this.listed_.map((l) => ({ sat: l.sat, checked: l.box.checked }));
  }

  /** Chooses the satellites named (or with these ids) and draws them. */
  choose(names: string[]): void {
    for (const l of this.listed_) l.box.checked = names.includes(l.sat.name) || names.includes(l.sat.id);
    this.countSats();
    this.draw();
  }

  /** Shows the satellites at a moment (ms), or over a period. */
  setTime(at: number | { from: number; to: number }): void {
    const mode = this.form_.elements.namedItem('mode') as HTMLSelectElement;
    if (typeof at === 'number') {
      mode.value = 'at';
      this.input('at').value = inputText(at);
    } else {
      mode.value = 'range';
      this.input('from').value = inputText(at.from);
      this.input('to').value = inputText(at.to);
    }
    this.showMode();
    this.draw();
  }

  /** The tracks drawn now. */
  tracks(): Array<{ track: SatelliteTrack; color: string }> {
    return this.tracks_;
  }

  /** The tracks for the 3D view; none while the panel is closed. */
  tracks3d(): Track3d[] {
    if (!this.dialog.open) return [];
    const at = this.moment();
    return this.tracks_.map(({ track, color }) =>
      track3d(track, color, at === null ? undefined : { index: sampleAt(track, at), label: `${track.sat.name}\n${localText(at)}` }),
    );
  }

  private input(name: string): HTMLInputElement {
    return this.form_.elements.namedItem(name) as HTMLInputElement;
  }

  /** The moment shown (in the 「時点」 mode), else null. */
  private moment(): number | null {
    if ((this.form_.elements.namedItem('mode') as HTMLSelectElement).value !== 'at') return null;
    const ms = new Date(this.input('at').value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  private showMode(): void {
    const range = (this.form_.elements.namedItem('mode') as HTMLSelectElement).value === 'range';
    for (const el of this.dialog.querySelectorAll<HTMLElement>('.track-at')) el.hidden = range;
    for (const el of this.dialog.querySelectorAll<HTMLElement>('.track-range')) el.hidden = !range;
    this.dialog.querySelector('.track-pos-head')!.textContent = range ? '開始時の位置' : '位置';
    if (range) this.setLive(false);
  }

  private setLive(on: boolean): void {
    clearInterval(this.live_);
    this.live_ = 0;
    this.input('live').checked = on;
    if (!on) return;
    const tick = () => {
      this.input('at').value = inputText(Date.now());
      this.draw();
    };
    tick();
    this.live_ = window.setInterval(tick, 30000);
  }

  private async load(): Promise<void> {
    this.loaded_ ??= (async () => {
      this.status_.textContent = '衛星を読んでいます…';
      try {
        this.catalog_ = await this.options.satellites();
        this.listSats();
      } catch (error) {
        this.loaded_ = null;
        this.status_.textContent = `衛星を読めませんでした: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
    return this.loaded_;
  }

  /** The satellites pasted in the TLE box. */
  private pasted(): SatelliteSpec[] {
    const number = (name: string, fallback: number) => {
      const v = Number(this.input(name).value);
      return Number.isFinite(v) && v >= 0 ? v : fallback;
    };
    const max = number('pasteMax', builtInDefaults.maxOffNadir) || builtInDefaults.maxOffNadir;
    return satellitesFromText(this.input('tle').value, {
      ...builtInDefaults,
      maxOffNadir: max,
      minOffNadir: Math.min(max, number('pasteMin', 0)),
      lookSide: (this.form_.elements.namedItem('pasteSide') as HTMLSelectElement).value as SatelliteSpec['lookSide'],
      sar: this.input('pasteSar').checked,
    });
  }

  /** Lists the satellites with checkboxes, keeping which were chosen (pasted ones start chosen). */
  private listSats(): void {
    const before = new Map(this.listed_.map((l) => [l.key, l.box.checked]));
    const first = !this.listed_.length;
    const pasted = this.pasted();
    const all = [...this.catalog_, ...pasted];
    this.listed_ = [...all]
      .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
      .map((sat) => {
        const key = keyOf(sat);
        const box = document.createElement('input');
        box.type = 'checkbox';
        // At first only a few satellites (the samples) start chosen, so something shows at once.
        box.checked = before.get(key) ?? (pasted.includes(sat) || (first && all.length <= 2));
        const label = document.createElement('label');
        label.className = 'check';
        const swatch = document.createElement('i');
        swatch.className = 'track-swatch';
        const note = document.createElement('small');
        const side = sat.lookSide === 'both' ? '左右' : sat.lookSide === 'right' ? '右' : '左';
        note.textContent = `${sat.minOffNadir > 0 ? `${round(sat.minOffNadir)}〜` : ''}${round(sat.maxOffNadir)}°・${side}${sat.sar ? '・SAR' : ''}`;
        label.title = sat.source;
        label.append(box, swatch, document.createTextNode(sat.name), note);
        box.addEventListener('change', () => {
          this.countSats();
          this.schedule();
        });
        return { sat, key, box, label };
      });
    this.list_.replaceChildren(...this.listed_.map((l) => l.label));
    this.filter_.hidden = this.listed_.length <= 8;
    this.applyFilter();
    this.countSats();
  }

  private applyFilter(): void {
    const words = this.filter_.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const l of this.listed_) {
      const text = `${l.sat.name} ${l.sat.id} ${l.sat.series}`.toLowerCase();
      // Chosen ones stay in sight.
      l.label.hidden = !l.box.checked && !words.every((w) => text.includes(w));
    }
  }

  private countSats(): void {
    const chosen = this.listed_.filter((l) => l.box.checked);
    this.count_.textContent = `（${chosen.length} / ${this.listed_.length}）`;
    // Colours: kept while chosen, the first free one for a newly chosen satellite.
    for (const key of [...this.colors_.keys()]) if (!chosen.some((l) => l.key === key)) this.colors_.delete(key);
    for (const l of chosen) {
      if (this.colors_.has(l.key)) continue;
      const used = new Set(this.colors_.values());
      this.colors_.set(l.key, TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[this.colors_.size % TRACK_COLORS.length]);
    }
    for (const l of this.listed_) {
      const swatch = l.label.querySelector<HTMLElement>('.track-swatch')!;
      swatch.style.background = this.colors_.get(l.key) ?? 'transparent';
    }
  }

  private schedule(): void {
    clearTimeout(this.timer_);
    this.timer_ = window.setTimeout(() => this.draw(), 150);
  }

  /** The period to draw (ms), with a note when it was shortened; a problem (text) when it cannot be read. */
  private period(): { from: number; to: number; note: string; at: number | null } | string {
    const at = this.moment();
    if ((this.form_.elements.namedItem('mode') as HTMLSelectElement).value === 'at') {
      if (at === null) return '時刻を入れてください';
      const minutes = Number((this.form_.elements.namedItem('window') as HTMLSelectElement).value) || 15;
      return { from: at - minutes * 60000, to: at + minutes * 60000, note: '', at };
    }
    const from = new Date(this.input('from').value).getTime();
    let to = new Date(this.input('to').value).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) return '開始と終了を入れてください';
    if (to <= from) return '終了は開始より後にしてください';
    let note = '';
    if (to - from > MAX_DAYS * 86400000) {
      to = from + MAX_DAYS * 86400000;
      note = `（期間は最長 ${MAX_DAYS} 日。${localText(to)} までを表示）`;
    }
    return { from, to, note, at: null };
  }

  /** Works out and draws the chosen satellites' tracks. */
  draw(): void {
    clearTimeout(this.timer_);
    const source = this.overlay.getSource()!;
    source.clear();
    this.tracks_ = [];
    const chosen = this.listed_.filter((l) => l.box.checked);
    const period = this.period();
    if (!this.listed_.length) {
      this.status_.textContent = '衛星がありません。「詳細」で TLE を貼り付けて追加できます';
    } else if (!chosen.length) {
      this.status_.textContent = '表示する衛星を選んでください（複数選べます）';
    } else if (typeof period === 'string') {
      this.status_.textContent = period;
    } else {
      const max = Number(this.input('maxOffNadir').value);
      const daylight = (this.form_.elements.namedItem('daylight') as HTMLSelectElement).value;
      const failed: string[] = [];
      for (const l of chosen) {
        const track = satelliteTrack(l.sat, period.from, period.to, {
          ...(period.at !== null ? { step: 10 } : {}),
          ...(this.input('maxOffNadir').value !== '' && Number.isFinite(max) ? { maxOffNadir: max } : {}),
          ...(daylight !== '' ? { minSun: Number(daylight) } : {}),
        });
        if (track && track.times.length > 1) this.tracks_.push({ track, color: this.colors_.get(l.key)! });
        else failed.push(l.sat.name);
      }
      for (const { track, color } of this.tracks_) this.drawTrack(track, color, period.at);
      const when = period.at !== null ? `${localText(period.at)} 前後 ${Math.round((period.to - period.at) / 60000)} 分` : `${localText(period.from)} 〜 ${localText(period.to)}`;
      this.status_.textContent = `${this.tracks_.length} 機の軌跡と撮像可能範囲（${when}）${period.note}${failed.length ? `。軌道を計算できなかった衛星: ${failed.join('、')}` : ''}`;
    }
    this.listRows(typeof period === 'string' ? null : period.at);
    this.layer_.disabled = !this.tracks_.length;
    this.zoom_.disabled = !this.tracks_.length;
    this.options.onChange?.();
  }

  private drawTrack(track: SatelliteTrack, color: string, at: number | null): void {
    const source = this.overlay.getSource()!;
    const projection = this.map.getView().getProjection();
    const to = (c: [number, number]) => fromLonLat(c, projection);
    const name = track.sat.name;
    for (const band of track.bands) {
      for (const ring of bandRings(band)) for (const part of wrapPolygon(ring)) source.addFeature(new Feature({ kind: 'reach', color, satellite: name, geometry: new Polygon([part.map(to)]) }));
    }
    for (const part of wrapLine(track.track)) source.addFeature(new Feature({ kind: 'track', color, satellite: name, geometry: new LineString(part.map(to)) }));
    if ((this.form_.elements.namedItem('ticks') as HTMLInputElement).checked) {
      const minutes = tickMinutes((track.to - track.from) / 60000);
      const every = minutes * 60000;
      const long = track.to - track.from > 86400000;
      let next = Math.ceil(track.from / every) * every;
      track.times.forEach((t, i) => {
        if (t < next) return;
        next += every;
        if (at !== null && Math.abs(t - at) < every / 2) return;
        const text = localText(t);
        source.addFeature(new Feature({ kind: 'tick', color, label: long ? text.slice(5) : text.slice(11), geometry: new Point(to(track.track[i])) }));
      });
    }
    const i = at === null ? 0 : sampleAt(track, at);
    if (i >= 0) {
      source.addFeature(
        new Feature({ kind: 'satellite', color, label: at === null ? `${name}（開始）` : `${name} ${localText(track.times[i]).slice(11)}`, satellite: name, geometry: new Point(to(track.track[i])) }),
      );
    }
  }

  /** One row a satellite: where it is (at the moment, or at the start), its height, which way it goes, and its reach. */
  private listRows(at: number | null): void {
    const body = this.table_.tBodies[0];
    body.replaceChildren();
    for (const { track, color } of this.tracks_) {
      const i = at === null ? 0 : sampleAt(track, at);
      const [lon, lat] = track.track[i];
      const row = body.insertRow();
      const swatch = document.createElement('i');
      swatch.className = 'track-swatch';
      swatch.style.background = color;
      row.insertCell().append(swatch);
      const reach = track.offNadir.min > 0 ? `${round(track.offNadir.min)}〜${round(track.offNadir.max)}°` : `${round(track.offNadir.max)}° 以下`;
      const side = track.sat.lookSide === 'both' ? '左右' : track.sat.lookSide === 'right' ? '右' : '左';
      for (const text of [track.sat.name, `${round(lat, 3)}, ${round(lon, 3)}`, `${round(track.heights[i] / 1000, 0)} km`, track.ascending[i] ? '北行' : '南行', `${reach}・${side}`]) row.insertCell().textContent = text;
      row.title = 'クリックでこの衛星へ移動';
      row.addEventListener('click', () => this.zoomTo(track));
    }
    this.dialog.querySelector<HTMLElement>('.track-results')!.hidden = !this.tracks_.length;
  }

  /** Fits the view to the tracks drawn (or one satellite's), beside the panel. */
  zoomTo(track?: SatelliteTrack): void {
    const extent = createEmpty();
    for (const f of this.overlay.getSource()!.getFeatures()) {
      if (track && f.get('satellite') !== track.sat.name) continue;
      // At a moment, one satellite: where it is and the pass around it.
      if (f.get('kind') === 'tick') continue;
      extend(extent, f.getGeometry()!.getExtent());
    }
    if (isEmpty(extent)) return;
    const map = this.map.getTargetElement().getBoundingClientRect();
    const panel = this.dialog.getBoundingClientRect();
    // Beside the panel, unless it leaves too little of the map.
    const right = this.dialog.open && panel.left > map.left + map.width * 0.4 ? Math.max(60, map.right - panel.left + 40) : 60;
    this.map.getView().fit(extent, { padding: [60, right, 60, 60], duration: 300, maxZoom: 9 });
  }

  /** The tracks and reach drawn now as a layer: per satellite one line feature and one area feature. */
  trackLayer(): ProcessingResult | null {
    if (!this.tracks_.length) return null;
    return trackFeatures(this.tracks_.map((t) => t.track));
  }

  private addLayer(): void {
    const result = this.trackLayer();
    if (!result) return;
    const first = this.tracks_[0].track;
    this.options.onLayer(result, `衛星パス ${localText(first.from)} 〜 ${localText(first.to)}（${this.tracks_.length} 機）`);
  }
}

/** Tracks as a layer: per satellite its ground track (lines) and what it can image (areas). */
export function trackFeatures(tracks: readonly SatelliteTrack[]): ProcessingResult {
  const features: Feature[] = [];
  const to = (c: [number, number]) => fromLonLat(c, 'EPSG:3857');
  for (const track of tracks) {
    const base = {
      satellite: track.sat.name,
      satellite_id: track.sat.id,
      start: track.from,
      end: track.to,
      min_off_nadir: Math.round(track.offNadir.min * 100) / 100,
      max_off_nadir: Math.round(track.offNadir.max * 100) / 100,
    };
    const lines = wrapLine(track.track).map((p) => p.map(to));
    if (lines.length) features.push(new Feature({ ...base, kind: '地上軌跡', geometry: new MultiLineString(lines) }));
    const rings = track.bands.flatMap((b) => bandRings(b).flatMap(wrapPolygon)).map((r) => [r.map(to)]);
    if (rings.length) features.push(new Feature({ ...base, kind: '撮像可能範囲', geometry: new MultiPolygon(rings) }));
  }
  return {
    title: '衛星パス',
    features,
    fields: [
      field('kind', 'string', '種類'),
      field('satellite', 'string', '衛星'),
      field('satellite_id', 'string', '衛星ID'),
      field('start', 'date', '開始'),
      field('end', 'date', '終了'),
      field('min_off_nadir', 'double', '最小オフナディア角'),
      field('max_off_nadir', 'double', '最大オフナディア角'),
    ],
    crs: wgs84,
  };
}
