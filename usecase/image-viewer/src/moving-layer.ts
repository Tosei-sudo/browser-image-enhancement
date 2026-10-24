/**
 * A layer of moving objects: one feed (or history file) drawn as ship or
 * aircraft symbols turned to their heading, with their track of the last
 * minutes, a label (name, else id) when zoomed in, faded when their last
 * report is old and gone when it is older still. It goes into the layer list
 * like other vector layers, with its objects in the attribute table.
 *
 * It follows the timeline through its time (`ServiceLayer.time`, as WMS
 * layers do): while the timeline is open the objects stand where they were
 * at the window's end, interpolated from what the feed has sent so far (or
 * the history file holds); closed, a live feed shows the latest reports.
 */
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { fromLonLat } from 'ol/proj.js';
import { Fill, Icon, Stroke, Style, Text } from 'ol/style.js';
import type { FeatureLike } from 'ol/Feature.js';
import type { Field, ServiceLayer } from './services/index.js';
import { connectFeed, feedStatuses, type FeedConnection, type FeedStatus } from './moving-feeds.js';
import {
  canPlace,
  detectFields,
  displayUrl,
  feedTypes,
  guessKind,
  movingKinds,
  positionAt,
  readRecord,
  recordsOf,
  trailOf,
  TrackStore,
  utcText,
  type FeedConfig,
  type FieldMap,
  type MovingKind,
  type Primitive,
  type Track,
} from './moving.js';
import { isoTime } from './time.js';

/** How a feed layer draws and keeps its objects; minutes. */
export interface MovingSettings {
  /** Track drawn behind each object. */
  trailMinutes: number;
  /** Faded when the last report is older. */
  staleMinutes: number;
  /** Gone when the last report is older. */
  removeMinutes: number;
  /** Reports of a live feed kept for the timeline and the check against detections. */
  keepMinutes: number;
}

/** The defaults of each kind: ships report every few seconds to minutes, aircraft every second. */
export function defaultSettings(kind: MovingKind): MovingSettings {
  return kind === 'aircraft' ? { trailMinutes: 5, staleMinutes: 1, removeMinutes: 5, keepMinutes: 360 } : { trailMinutes: 30, staleMinutes: 10, removeMinutes: 30, keepMinutes: 1440 };
}

/** Labels are drawn below this resolution (m per pixel, about zoom 12). */
const LABEL_RESOLUTION = 40;
/** The map is drawn again at most this often for a live feed, ms. */
const FRAME = 1000;
/** Extra attribute columns in the table at most. */
const MAX_EXTRA_FIELDS = 16;
/** Messages a feed's fields are looked for in before it is said that they were not found. */
const DETECT_TRIES = 20;

const COLORS: Record<MovingKind, string> = { ship: '#1971c2', aircraft: '#e8590c' };

/** A ship (a hull with a pointed bow) or an aircraft, pointing up, or a dot for no heading; drawn once per look. */
function symbolCanvas(kind: MovingKind, color: string, pointed: boolean): HTMLCanvasElement {
  const size = 24;
  const ratio = Math.min(3, Math.ceil(globalThis.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * ratio;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (!pointed) ctx.arc(12, 12, 5, 0, Math.PI * 2);
  else if (kind === 'ship') {
    ctx.moveTo(12, 2);
    ctx.lineTo(17, 9);
    ctx.lineTo(17, 21);
    ctx.lineTo(7, 21);
    ctx.lineTo(7, 9);
  } else {
    // Fuselage, wings and tail.
    ctx.moveTo(12, 1.5);
    ctx.lineTo(13.6, 8);
    ctx.lineTo(22, 13);
    ctx.lineTo(22, 15);
    ctx.lineTo(13.6, 13);
    ctx.lineTo(13.2, 18.5);
    ctx.lineTo(16, 21);
    ctx.lineTo(16, 22.5);
    ctx.lineTo(12, 21.5);
    ctx.lineTo(8, 22.5);
    ctx.lineTo(8, 21);
    ctx.lineTo(10.8, 18.5);
    ctx.lineTo(10.4, 13);
    ctx.lineTo(2, 15);
    ctx.lineTo(2, 13);
    ctx.lineTo(10.4, 8);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  return canvas;
}

/** What is drawn of one object besides its point. */
interface Drawn {
  track: Track;
  trail: LineString | null;
  dir: number | null;
  faded: boolean;
  label: string;
  /** The fix time and place last written, to leave unchanged objects alone. */
  key: string;
}

/** The table's fields for an object. */
const CORE_FIELDS: Field[] = [
  { name: 'id', alias: 'ID', type: 'string', editable: false, nullable: false },
  { name: 'name', alias: '名前', type: 'string', editable: false, nullable: true },
  { name: 'type', alias: '種別', type: 'string', editable: false, nullable: true },
  { name: 'time', alias: '最終時刻', type: 'string', editable: false, nullable: true },
  { name: 'lat', alias: '緯度', type: 'double', editable: false, nullable: true },
  { name: 'lon', alias: '経度', type: 'double', editable: false, nullable: true },
  { name: 'heading', alias: '方位', type: 'double', editable: false, nullable: true },
  { name: 'course', alias: '針路', type: 'double', editable: false, nullable: true },
  { name: 'speed', alias: '速度', type: 'double', editable: false, nullable: true },
  { name: 'state', alias: '状態', type: 'string', editable: false, nullable: true },
];

/** The settings a feed layer starts with: the feed's, over the kind's defaults. */
export interface MovingLayerOptions {
  feed: FeedConfig;
  settings?: Partial<MovingSettings>;
  /** Not connected: the reports come from a history file (`addRows`). */
  history?: boolean;
  say?: (message: string) => void;
  /** Called when the state, the counts or the fields change (for the dialog). */
  onChange?: () => void;
  /** The clock (tests). */
  now?: () => number;
}

export class MovingLayer {
  readonly feed: FeedConfig;
  readonly store = new TrackStore();
  readonly source = new VectorSource<Feature>();
  readonly layer: VectorLayer<VectorSource<Feature>>;
  readonly service: ServiceLayer;
  readonly fields: Field[] = CORE_FIELDS.map((f) => ({ ...f }));
  readonly history: boolean;
  kind: MovingKind;
  settings: MovingSettings;
  /** The fields of each role, found or given. */
  mapping: FieldMap;
  status: FeedStatus = 'connecting';
  statusDetail = '';
  /** Reports read, and records left out (no id or position). */
  received = 0;
  skipped = 0;

  private readonly given_: FieldMap;
  private readonly drawn_ = new Map<string, { feature: Feature; drawn: Drawn }>();
  private readonly byFeature_ = new WeakMap<FeatureLike, Drawn>();
  private readonly timeValues_: number[] = [];
  private readonly symbols_ = new Map<string, Style>();
  private readonly canvases_ = new Map<string, HTMLCanvasElement>();
  private connection_: FeedConnection | null = null;
  private time_: number | null = null;
  private tries_ = 0;
  private frame_: ReturnType<typeof setTimeout> | null = null;
  private lastFrame_ = 0;
  private ticker_: ReturnType<typeof setInterval> | null = null;
  private kindFixed_: boolean;
  private keys_ = new Set<string>();

  constructor(private readonly options: MovingLayerOptions) {
    this.feed = options.feed;
    this.history = !!options.history;
    this.kind = options.feed.kind ?? 'ship';
    this.kindFixed_ = !!options.feed.kind;
    this.settings = { ...defaultSettings(this.kind), ...options.settings };
    this.given_ = { ...options.feed.fields };
    this.mapping = { ...this.given_ };
    this.layer = new VectorLayer({ source: this.source, style: (f, r) => this.style_(f, r), updateWhileAnimating: false, updateWhileInteracting: false });
    this.layer.set('moving', true);
    const values = this.timeValues_;
    this.service = {
      ref: null,
      badge: this.history ? '履歴' : 'ライブ',
      title: options.feed.label,
      layer: this.layer,
      correction: null,
      vector: { source: this.source, fields: this.fields, truncated: false, note: this.history ? '各移動体の位置（履歴ファイル）' : '各移動体の最新の位置（ライブ）' },
      styleKey: `moving:${options.feed.url}`,
      extent: null,
      info: [
        ['種類', this.history ? '移動体の履歴ファイル' : `移動体のフィード（${feedTypes[options.feed.type]}）`],
        ['接続先', this.history ? options.feed.url : displayUrl(options.feed.url)],
      ],
      time: {
        values,
        set: (t) => this.setTime(t),
        current: () => (this.time_ === null ? null : isoTime(this.time_)),
      },
      dispose: () => this.close(),
    };
    if (!this.history) {
      this.connection_ = connectFeed(options.feed, {
        onMessage: (data, at) => this.ingest(data, at),
        onStatus: (status, detail) => {
          this.status = status;
          this.statusDetail = detail ?? '';
          options.onChange?.();
        },
        onFields: (fields) => {
          for (const [role, name] of Object.entries(fields)) if (!this.given_[role as keyof FieldMap]) this.given_[role as keyof FieldMap] = name;
          this.mapping = { ...this.mapping, ...this.given_ };
        },
      });
      // Objects fade and go as time passes, and old reports are let go.
      this.ticker_ = setInterval(() => {
        this.store.prune(this.now_() - this.settings.keepMinutes * 60_000);
        this.schedule_();
      }, 5000);
    } else this.status = 'open';
  }

  private now_(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The time shown: the timeline's, else now (live) or the end of the history. */
  shownTime(): number | null {
    return this.time_;
  }

  /** Stands the objects where they were at `t` (the timeline), or back to live with null. */
  setTime(t: number | null): void {
    if (t === this.time_) return;
    this.time_ = t;
    this.render();
    this.options.onChange?.();
  }

  /** Reads one message of the feed. */
  ingest(data: unknown, receivedAt: number): void {
    this.addRows(recordsOf(data), receivedAt);
  }

  /** Adds reports (flattened records), finding the fields of each role first. */
  addRows(rows: Array<Record<string, Primitive>>, receivedAt = this.now_()): void {
    if (!rows.length) return;
    if (!canPlace(this.mapping)) {
      for (const row of rows.slice(0, 50)) for (const k of Object.keys(row)) this.keys_.add(k);
      this.mapping = detectFields(this.keys_, this.given_);
      if (!this.kindFixed_) {
        const kind = guessKind(this.keys_);
        if (kind !== this.kind) {
          this.kind = kind;
          this.settings = { ...defaultSettings(kind), ...this.options.settings };
        }
      }
      if (!canPlace(this.mapping)) {
        this.skipped += rows.length;
        if (++this.tries_ === DETECT_TRIES || this.history) {
          const missing = (['id', 'lat', 'lon'] as const).filter((r) => !this.mapping[r]).map((r) => ({ id: 'ID', lat: '緯度', lon: '経度' })[r]);
          this.statusDetail = `${missing.join('・')}の属性なし（「詳細」で指定）`;
          this.options.say?.(`${this.feed.label}: ${this.statusDetail}`);
        }
        this.options.onChange?.();
        return;
      }
      this.statusDetail = '';
      this.addExtraFields_(rows);
    }
    let added = 0;
    for (const row of rows) {
      const record = readRecord(row, this.mapping, receivedAt);
      if (!record) {
        this.skipped++;
        continue;
      }
      if (this.store.add(record)) added++;
    }
    this.received += added;
    const range = this.store.range();
    this.timeValues_.length = 0;
    if (range) this.timeValues_.push(range[0], range[1]);
    if (this.history) this.render();
    else this.schedule_();
    this.options.onChange?.();
  }

  /** Columns for the other values of the first reports (numbers and text), a few at most. */
  private addExtraFields_(rows: Array<Record<string, Primitive>>): void {
    const mapped = new Set(Object.values(this.mapping));
    const taken = new Set(this.fields.map((f) => f.name));
    const types = new Map<string, Field['type']>();
    for (const row of rows.slice(0, 50)) {
      for (const [k, v] of Object.entries(row)) {
        if (mapped.has(k) || k === '_lon' || k === '_lat' || taken.has(k) || v === null) continue;
        const was = types.get(k);
        const type: Field['type'] = typeof v === 'number' ? 'double' : 'string';
        types.set(k, was && was !== type ? 'string' : type);
      }
    }
    for (const [name, type] of [...types].slice(0, MAX_EXTRA_FIELDS)) this.fields.push({ name, alias: name, type, editable: false, nullable: true });
  }

  /** Draws again soon (at most once a second for a live feed). */
  private schedule_(): void {
    if (this.frame_) return;
    const wait = Math.max(0, FRAME - (performance.now() - this.lastFrame_));
    this.frame_ = setTimeout(() => {
      this.frame_ = null;
      this.render();
    }, wait);
  }

  /** Puts every object where it is at the time shown, with its trail, and drops those gone. */
  render(): void {
    this.lastFrame_ = performance.now();
    const range = this.store.range();
    const live = this.time_ === null && !this.history;
    const at = this.time_ ?? (this.history ? (range?.[1] ?? this.now_()) : this.now_());
    const { trailMinutes, staleMinutes, removeMinutes } = this.settings;
    // A history file without a time shows every object at its last report, faded when it is old.
    const hold = this.time_ === null && this.history ? Infinity : removeMinutes * 60_000;
    const seen = new Set<string>();
    const added: Feature[] = [];
    for (const track of this.store.tracks.values()) {
      const last = track.fixes[track.fixes.length - 1];
      if (!last) continue;
      const p = live ? { lon: last.lon, lat: last.lat, dir: last.dir, speed: last.speed, age: Math.max(0, at - last.t), interpolated: false } : positionAt(track, at, { hold });
      if (!p || p.age > hold) continue;
      seen.add(track.id);
      const faded = p.age > staleMinutes * 60_000;
      const key = `${p.lon},${p.lat},${p.dir},${faded},${last.t},${track.name}`;
      let entry = this.drawn_.get(track.id);
      if (entry && entry.drawn.key === key && live) continue;
      const trail = trailMinutes > 0 ? trailOf(track, at - trailMinutes * 60_000, at, [p.lon, p.lat]) : [];
      const drawn: Drawn = {
        track,
        trail: trail.length >= 2 ? new LineString(trail.map((c) => fromLonLat(c))) : null,
        dir: p.dir,
        faded,
        label: track.name ?? track.id,
        key,
      };
      const fixTime = live ? last.t : at - p.age;
      const props: Record<string, unknown> = {
        ...track.attrs,
        id: track.id,
        name: track.name,
        type: track.kind,
        time: utcText(fixTime),
        lat: Math.round(p.lat * 1e6) / 1e6,
        lon: Math.round(p.lon * 1e6) / 1e6,
        heading: track.heading,
        course: track.course,
        speed: p.speed === null ? null : Math.round(p.speed * 10) / 10,
        state: p.interpolated ? '補間' : faded ? '古い' : '最新',
      };
      if (!entry) {
        const feature = new Feature({ ...props, geometry: new Point(fromLonLat([p.lon, p.lat])) });
        feature.setId(`moving:${track.id}`);
        entry = { feature, drawn };
        this.drawn_.set(track.id, entry);
        added.push(feature);
      } else {
        entry.drawn = drawn;
        entry.feature.setProperties(props, true);
        (entry.feature.getGeometry() as Point).setCoordinates(fromLonLat([p.lon, p.lat]));
      }
      this.byFeature_.set(entry.feature, drawn);
    }
    for (const [id, entry] of this.drawn_) {
      if (seen.has(id)) continue;
      this.source.removeFeature(entry.feature);
      this.drawn_.delete(id);
    }
    if (added.length) this.source.addFeatures(added);
    this.layer.changed();
  }

  /** The look of one object: its trail, its symbol turned to its heading, and its label when zoomed in. */
  private style_(feature: FeatureLike, resolution: number): Style[] {
    const drawn = this.byFeature_.get(feature);
    if (!drawn) return [];
    const kind = this.kind;
    const color = COLORS[kind];
    const pointed = drawn.dir !== null;
    // Symbols are made once per look, turned in steps of 5°.
    const step = pointed ? Math.round(drawn.dir! / 5) % 72 : 0;
    const key = `${kind}|${pointed}|${drawn.faded}|${step}`;
    let symbol = this.symbols_.get(key);
    if (!symbol) {
      let canvas = this.canvases_.get(`${kind}|${pointed}`);
      if (!canvas) this.canvases_.set(`${kind}|${pointed}`, (canvas = symbolCanvas(kind, color, pointed)));
      symbol = new Style({
        image: new Icon({ img: canvas, scale: 24 / canvas.width, opacity: drawn.faded ? 0.4 : 1, rotation: (step * 5 * Math.PI) / 180, rotateWithView: true }),
        zIndex: 2,
      });
      this.symbols_.set(key, symbol);
    }
    const styles: Style[] = [];
    if (drawn.trail) styles.push(new Style({ geometry: drawn.trail, stroke: new Stroke({ color: drawn.faded ? `${color}55` : `${color}aa`, width: 1.5 }), zIndex: 1 }));
    styles.push(symbol);
    if (resolution < LABEL_RESOLUTION) {
      styles.push(
        new Style({
          text: new Text({
            text: drawn.label,
            font: '12px system-ui, sans-serif',
            offsetY: -16,
            fill: new Fill({ color: drawn.faded ? '#555' : '#111' }),
            stroke: new Stroke({ color: '#fff', width: 3 }),
            overflow: true,
          }),
          zIndex: 3,
        }),
      );
    }
    return styles;
  }

  /** The object a feature stands for. */
  trackOf(feature: FeatureLike): Track | null {
    return this.byFeature_.get(feature)?.track ?? null;
  }

  /** The state in words, for the dialog. */
  statusText(): string {
    const parts = [this.history ? '履歴' : feedStatuses[this.status], `${this.store.tracks.size.toLocaleString()} 件`];
    if (this.time_ !== null) parts.push(`${utcText(this.time_)} の位置`);
    if (this.store.dropped) parts.push(`上限で ${this.store.dropped.toLocaleString()} 件を除外`);
    if (this.statusDetail) parts.push(this.statusDetail);
    return parts.join('・');
  }

  /** The kind in words. */
  kindText(): string {
    return movingKinds[this.kind];
  }

  /** Disconnects (the layer was closed). */
  close(): void {
    this.connection_?.close();
    this.connection_ = null;
    if (this.ticker_) clearInterval(this.ticker_);
    if (this.frame_) clearTimeout(this.frame_);
    this.ticker_ = null;
    this.frame_ = null;
    this.status = 'closed';
    this.options.onChange?.();
  }
}
