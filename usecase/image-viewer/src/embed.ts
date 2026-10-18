/**
 * The embedding API: a page of an origin listed in config.json's
 * `embed.allowedOrigins` shows the viewer in an iframe (`index.html?embed=1`
 * hides everything but the map) and drives it with `postMessage`, through
 * the same functions scripts use (script/api.ts, script/automation.ts), so the
 * same checks apply. The messages are in embed-protocol.ts; a small client is
 * `public/embed-client.js`.
 *
 * Safety: only messages from the parent window (`event.source`) of an allowed
 * origin (`event.origin`) are read; answers and events go to that origin only,
 * and events only after it said `hello`. Methods are a fixed list with strict
 * parameters (embed-protocol.ts); nothing edits features, saves, downloads or
 * picks files, `readOnly` leaves only reading and moving the view, and a
 * server the viewer does not already use is opened only when the person
 * agrees (confirm).
 */
import type OlMap from 'ol/Map.js';
import type BaseLayer from 'ol/layer/Base.js';
import { toLonLat } from 'ol/proj.js';
import type { Selection } from './selection.js';
import type { ViewerLayer } from './images.js';
import type { ScriptContext } from './script/api.js';
import type { ScriptHandlers } from './script/sandbox.js';
import {
  answer,
  EmbedError,
  eventMessage,
  EVENTS,
  failure,
  methodsFor,
  originAllowed,
  readRequest,
  shapeParams,
  toolAllowed,
  type EmbedConfig,
  type EmbedEvent,
  type EmbedRequest,
} from './embed-protocol.js';

/** Most requests worked on at once. */
const MAX_PENDING = 8;
/** Least time between two `view` events (ms). */
const VIEW_INTERVAL = 200;
/** Most selected ids a `selection` event lists. */
const MAX_EVENT_IDS = 5000;

/** What the viewer lends the embedding API (main.ts fills it). */
export interface EmbedContext {
  map: OlMap;
  selection: Selection;
  /** The script functions, with the context adapted (script-dialog.ts). */
  handlers: (adapt: (ctx: ScriptContext) => ScriptContext) => ScriptHandlers;
  /** Shows link shapes as a temporary layer (main.ts's addLinkShapes). */
  addShapes: (params: URLSearchParams, zoom: boolean) => Promise<{ layer: ViewerLayer | null; count: number; errors: string[] }>;
  /** The id scripts know a layer by. */
  layerId: (layer: ViewerLayer) => string;
  /** Settles once the layers opening at start are open. */
  ready: Promise<unknown>;
}

export class EmbedApi {
  private readonly allowed_: readonly string[];
  private readonly readOnly_: boolean;
  /** The origin that said `hello`: events go there. */
  private peer_: string | null = null;
  private events_ = new Set<EmbedEvent>(EVENTS);
  private handlers_: ScriptHandlers | null = null;
  /** Servers the person allowed for the parent page. */
  private readonly hosts_ = new Set<string>();
  private knownHosts_: () => string[] = () => [];
  private pending_ = 0;
  private ready_ = false;
  private readySent_ = false;
  private viewTimer_: ReturnType<typeof setTimeout> | null = null;
  private lastView_ = 0;
  private selectionQueued_ = false;
  private layersQueued_ = false;
  private readonly watched_ = new WeakSet<BaseLayer>();

  constructor(
    config: EmbedConfig,
    private readonly ctx: EmbedContext,
  ) {
    this.allowed_ = config.allowedOrigins;
    this.readOnly_ = config.readOnly;
    if (!this.allowed_.length || window.parent === window) return;
    window.addEventListener('message', (e) => void this.onMessage_(e));
    void ctx.ready.finally(() => {
      this.ready_ = true;
      this.sendReady_();
    });
    ctx.map.on('moveend', () => this.viewChanged_());
    ctx.selection.on('change', () => {
      if (!this.peer_ || this.selectionQueued_) return;
      this.selectionQueued_ = true;
      setTimeout(() => {
        this.selectionQueued_ = false;
        const { layer, ids } = this.call_('selection') as { layer: string | null; ids: string[] };
        this.emit_('selection', { layer, ids: ids.slice(0, MAX_EVENT_IDS), ...(ids.length > MAX_EVENT_IDS ? { truncated: true } : {}) });
      });
    });
    ctx.map.on('singleclick', (e) => {
      const [lon, lat] = toLonLat(e.coordinate, ctx.map.getView().getProjection());
      if (Number.isFinite(lon) && Number.isFinite(lat)) this.emit_('click', { lon: Math.round(lon * 1e7) / 1e7, lat: Math.round(lat * 1e7) / 1e7 });
    });
  }

  /** Layers were added, removed or reordered (ImageList's onChange). */
  layersChanged(): void {
    if (!this.peer_) return;
    // Shown or hidden changes the list too.
    for (const layer of this.ctx.map.getLayers().getArray()) {
      if (this.watched_.has(layer)) continue;
      this.watched_.add(layer);
      layer.on('change:visible', () => this.layersChanged());
    }
    if (this.layersQueued_) return;
    this.layersQueued_ = true;
    setTimeout(() => {
      this.layersQueued_ = false;
      this.emit_('layers', { layers: this.call_('layers') });
    });
  }

  private async onMessage_(e: MessageEvent): Promise<void> {
    if (e.source !== window.parent || !originAllowed(e.origin, this.allowed_)) return;
    const read = readRequest(e.data, this.readOnly_);
    if (!read) return;
    const reply = (message: Record<string, unknown>) => window.parent.postMessage(message, e.origin);
    if (!read.ok) {
      if (read.id !== null) reply(failure(read.id, read.error));
      return;
    }
    const { request } = read;
    if (request.method !== 'hello' && this.peer_ !== e.origin) {
      reply(failure(request.id, new EmbedError('hello-first', '最初に hello を送ってください')));
      return;
    }
    if (this.pending_ >= MAX_PENDING) {
      reply(failure(request.id, new EmbedError('busy', `同時に送れる要求は ${MAX_PENDING} 個までです`)));
      return;
    }
    this.pending_++;
    try {
      reply(answer(request.id, await this.run_(request, e.origin)));
    } catch (error) {
      reply(failure(request.id, error instanceof EmbedError ? error : new EmbedError('failed', error instanceof Error ? error.message : String(error))));
    } finally {
      this.pending_--;
    }
    if (request.method === 'hello') this.sendReady_();
  }

  /** Calls a script function. */
  private call_(name: string, ...args: unknown[]): unknown {
    if (!this.handlers_) {
      this.handlers_ = this.ctx.handlers((c) => {
        this.knownHosts_ = c.knownHosts;
        return { ...c, knownHosts: () => [...c.knownHosts(), ...this.hosts_] };
      });
    }
    const f = this.handlers_.get(name);
    if (!f) throw new EmbedError('failed', `${name} は使えません`);
    return f(...args);
  }

  private async run_({ method, params: p }: EmbedRequest, origin: string): Promise<unknown> {
    switch (method) {
      case 'hello':
        this.peer_ = origin;
        this.events_ = new Set((p.events as EmbedEvent[] | undefined) ?? EVENTS);
        this.layersChanged();
        return { version: 1, methods: methodsFor(this.readOnly_), events: [...EVENTS], readOnly: this.readOnly_, ready: this.ready_ };
      case 'getView':
        return this.call_('view');
      case 'setView':
        return this.call_('setView', p);
      case 'zoomTo':
        return this.call_('zoomTo', p.layer);
      case 'listLayers':
        return this.call_('layers');
      case 'selectLayer':
        return this.call_('selectLayer', p.layer);
      case 'getSelection': {
        const selected = this.call_('selection') as { layer: string | null; ids: string[] };
        if (!p.features || !selected.layer || !selected.ids.length) return selected;
        return { ...selected, features: this.call_('features', selected.layer, { selected: true, limit: 1000 }) };
      }
      case 'listBaseMaps':
        return this.call_('baseMaps');
      case 'listTools':
        return (this.call_('tools') as Array<{ id: string }>).filter((t) => toolAllowed(t.id));
      case 'open': {
        this.ask_(p.url as string, origin);
        const { url, ...rest } = p;
        return this.call_('open', url, rest);
      }
      case 'setVisible':
        return this.call_('setVisible', p.layer, p.visible);
      case 'setOpacity':
        return this.call_('setOpacity', p.layer, p.opacity);
      case 'removeLayer':
        return this.call_('removeLayer', p.layer);
      case 'setBaseMap':
        return this.call_('setBaseMap', p.id);
      case 'addShapes': {
        const added = await this.ctx.addShapes(shapeParams(p), p.zoom !== false);
        if (!added.layer) throw new EmbedError('failed', `図形を表示できませんでした${added.errors.length ? `: ${added.errors.join(' / ')}` : ''}`);
        return { layer: this.ctx.layerId(added.layer), count: added.count, ...(added.errors.length ? { errors: added.errors } : {}) };
      }
      case 'runTool':
        if (!toolAllowed(p.id as string)) throw new EmbedError('failed', `ツール「${String(p.id)}」は埋め込みからは使えません`);
        return this.call_('tool', p.id, p.params ?? {});
    }
    throw new EmbedError('unknown-method', `メソッド「${method}」はありません`);
  }

  /**
   * Asks the person before a server the viewer does not already use is read
   * on the parent page's behalf (once per server); throws when they decline.
   */
  private ask_(url: string, origin: string): void {
    let server: string;
    try {
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return; // automation.ts refuses it
      server = parsed.origin;
    } catch {
      return;
    }
    this.call_('layers'); // makes the handlers, so the known servers are at hand
    if (server === location.origin || this.hosts_.has(server) || this.knownHosts_().includes(server)) return;
    if (!confirm(`埋め込み元のページ（${origin}）が次のサーバーからデータを読み込もうとしています。\n\n${server}\n\n許可しますか？`)) {
      throw new EmbedError('failed', `${server} への接続は許可されませんでした`);
    }
    this.hosts_.add(server);
  }

  private viewChanged_(): void {
    if (!this.peer_ || this.viewTimer_) return;
    const wait = Math.max(0, this.lastView_ + VIEW_INTERVAL - performance.now());
    this.viewTimer_ = setTimeout(() => {
      this.viewTimer_ = null;
      this.lastView_ = performance.now();
      this.emit_('view', this.call_('view'));
    }, wait);
  }

  private sendReady_(): void {
    if (!this.ready_ || !this.peer_ || this.readySent_) return;
    this.readySent_ = true;
    this.emit_('ready', { readOnly: this.readOnly_ });
  }

  /** Sends an event to the page that said hello. */
  private emit_(event: EmbedEvent, data: unknown): void {
    if (!this.peer_ || !this.events_.has(event)) return;
    try {
      window.parent.postMessage(eventMessage(event, data), this.peer_);
    } catch (error) {
      console.warn(`埋め込み: ${event} を送れませんでした`, error);
    }
  }
}
