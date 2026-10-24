/**
 * Connections to moving-object feeds: a WebSocket, Server-Sent Events, a
 * URL polled for GeoJSON / JSON, or an ArcGIS Stream Service (its
 * `/StreamServer` description names the WebSocket to subscribe to).
 *
 * What comes in is checked before it is read: messages larger than
 * {@link MAX_MESSAGE} (and polled answers larger than {@link MAX_POLL}) are
 * dropped, as are messages beyond {@link MAX_RATE} a second, and text that
 * is not JSON. WebSockets connect again after a break, waiting longer each
 * time; EventSource does so by itself.
 */
import { feedUrl, type FeedConfig, type FieldMap } from './moving.js';

/** The largest WebSocket / SSE message read, in characters. */
export const MAX_MESSAGE = 2_000_000;
/** The largest polled answer read, in bytes. */
export const MAX_POLL = 20_000_000;
/** Messages read a second at most; the rest are dropped. */
export const MAX_RATE = 500;
/** The shortest time between polls, s. */
export const MIN_INTERVAL = 2;

export type FeedStatus = 'connecting' | 'open' | 'retrying' | 'error' | 'closed';
export const feedStatuses: Record<FeedStatus, string> = {
  connecting: '接続中…',
  open: '受信中',
  retrying: '再接続を待機中',
  error: 'エラー',
  closed: '切断',
};

export interface FeedHandlers {
  /** A message, parsed, and when it came. */
  onMessage(data: unknown, receivedAt: number): void;
  onStatus(status: FeedStatus, detail?: string): void;
  /** ArcGIS Stream Service: the fields its description names (track id, time). */
  onFields?(fields: FieldMap): void;
}

/** An open feed. */
export interface FeedConnection {
  close(): void;
  /** Messages dropped (too large, too many, not JSON). */
  dropped(): number;
}

/** Counts messages per second and says whether one more may be read. */
function rateLimiter(max: number): () => boolean {
  let second = 0;
  let count = 0;
  return () => {
    const now = Math.floor(Date.now() / 1000);
    if (now !== second) {
      second = now;
      count = 0;
    }
    return ++count <= max;
  };
}

/** Opens `feed`; messages and changes of state go to `handlers`. */
export function connectFeed(feed: FeedConfig, handlers: FeedHandlers): FeedConnection {
  let closed = false;
  let dropped = 0;
  const allow = rateLimiter(MAX_RATE);
  const take = (text: string) => {
    if (closed) return;
    if (text.length > MAX_MESSAGE || !allow()) return void dropped++;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return void dropped++;
    }
    handlers.onMessage(data, Date.now());
  };
  const cleanups: Array<() => void> = [];
  const connection: FeedConnection = {
    close: () => {
      if (closed) return;
      closed = true;
      for (const c of cleanups) c();
      handlers.onStatus('closed');
    },
    dropped: () => dropped,
  };
  const fail = (error: unknown) => !closed && handlers.onStatus('error', error instanceof Error ? error.message : String(error));

  /** A WebSocket that connects again after a break (2 s, 4 s… up to a minute). */
  const socket = (url: string, onOpen?: (ws: WebSocket) => void) => {
    let ws: WebSocket | null = null;
    let wait = 2000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (closed) return;
      handlers.onStatus('connecting');
      try {
        ws = new WebSocket(url);
      } catch (error) {
        return fail(error);
      }
      ws.onopen = () => {
        wait = 2000;
        handlers.onStatus('open');
        onOpen?.(ws!);
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') take(e.data);
        else if (e.data instanceof Blob && e.data.size <= MAX_MESSAGE) void e.data.text().then(take);
        else dropped++;
      };
      ws.onclose = () => {
        if (closed) return;
        handlers.onStatus('retrying', `${Math.round(wait / 1000)} 秒後に再接続`);
        timer = setTimeout(open, wait);
        wait = Math.min(60_000, wait * 2);
      };
    };
    cleanups.push(() => {
      if (timer) clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    });
    open();
  };

  try {
    const url = feedUrl(feed.url, feed.type, typeof location === 'undefined' ? undefined : location.href);
    if (feed.type === 'websocket') socket(url);
    else if (feed.type === 'sse') {
      handlers.onStatus('connecting');
      const source = new EventSource(url);
      source.onopen = () => handlers.onStatus('open');
      source.onmessage = (e) => take(String(e.data));
      source.onerror = () => {
        if (closed) return;
        // EventSource connects again by itself unless the server refused it.
        handlers.onStatus(source.readyState === EventSource.CLOSED ? 'error' : 'retrying', source.readyState === EventSource.CLOSED ? '接続失敗' : undefined);
      };
      cleanups.push(() => source.close());
    } else if (feed.type === 'poll') {
      const interval = Math.max(MIN_INTERVAL, feed.interval ?? 10) * 1000;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const controller = new AbortController();
      const poll = async () => {
        try {
          const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`サーバーからエラー応答（HTTP ${response.status}）`);
          const length = Number(response.headers.get('content-length') ?? 0);
          if (length > MAX_POLL) throw new Error(`応答が大きすぎ（${Math.round(length / 1e6)} MB）`);
          const text = await response.text();
          if (text.length > MAX_POLL) throw new Error('応答が大きすぎ');
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error('応答が JSON 以外');
          }
          if (closed) return;
          handlers.onStatus('open');
          handlers.onMessage(data, Date.now());
        } catch (error) {
          if (closed) return;
          fail(error instanceof TypeError ? new Error('接続失敗（URL、またはサーバーが CORS を許可しているかを確認）') : error);
        }
        if (!closed) timer = setTimeout(() => void poll(), interval);
      };
      cleanups.push(() => {
        controller.abort();
        if (timer) clearTimeout(timer);
      });
      handlers.onStatus('connecting');
      void poll();
    } else {
      // ArcGIS Stream Service: its description names the WebSocket (…/subscribe) and the track id and time fields.
      handlers.onStatus('connecting');
      void streamSocket(url)
        .then(({ ws, fields }) => {
          if (closed) return;
          if (Object.keys(fields).length) handlers.onFields?.(fields);
          socket(ws);
        })
        .catch(fail);
    }
  } catch (error) {
    fail(error);
  }
  return connection;
}

/** The WebSocket of an ArcGIS Stream Service, and its track id and time fields, from its description. */
export async function streamSocket(url: string): Promise<{ ws: string; fields: FieldMap }> {
  const info = new URL(url);
  const token = info.searchParams.get('token');
  info.search = '';
  info.searchParams.set('f', 'json');
  if (token) info.searchParams.set('token', token);
  let response: Response;
  try {
    response = await fetch(info.href, { cache: 'no-store' });
  } catch {
    throw new Error('Stream Service への接続に失敗（URL、またはサーバーが CORS を許可しているかを確認）');
  }
  if (!response.ok) throw new Error(`Stream Service からエラー応答（HTTP ${response.status}）`);
  const json = (await response.json().catch(() => null)) as {
    streamUrls?: Array<{ transport?: string; urls?: unknown[]; token?: string }>;
    timeInfo?: { trackIdField?: unknown; startTimeField?: unknown };
    error?: { message?: string };
  } | null;
  if (!json) throw new Error('Stream Service の説明が JSON 以外');
  if (json.error) throw new Error(`Stream Service からエラー応答: ${String(json.error.message ?? '').slice(0, 200)}`);
  const entry = json.streamUrls?.find((s) => s.transport === 'ws' && Array.isArray(s.urls) && s.urls.length);
  const base = entry?.urls?.find((u): u is string => typeof u === 'string');
  if (!base) throw new Error('Stream Service に WebSocket の URL（streamUrls）なし');
  const ws = new URL(/\/subscribe\/?$/i.test(base) ? base : `${base.replace(/\/+$/, '')}/subscribe`);
  // The service's own token for its stream; the one typed only goes to the same host.
  const wsToken = entry?.token ?? (ws.hostname === info.hostname ? token : null);
  if (wsToken) ws.searchParams.set('token', wsToken);
  const checked = feedUrl(ws.href, 'websocket');
  const fields: FieldMap = {};
  if (typeof json.timeInfo?.trackIdField === 'string') fields.id = json.timeInfo.trackIdField;
  if (typeof json.timeInfo?.startTimeField === 'string') fields.time = json.timeInfo.startTimeField;
  return { ws: checked, fields };
}
