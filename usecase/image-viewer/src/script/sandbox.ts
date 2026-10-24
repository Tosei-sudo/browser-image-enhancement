/**
 * Where a script runs: away from the page. The code goes into a Web Worker
 * started inside a sandboxed iframe (`sandbox="allow-scripts"`, no
 * `allow-same-origin`), so it has an origin of its own that nothing belongs
 * to: no cookies, no IndexedDB or localStorage of the viewer, no service
 * worker, no DOM of the page. The iframe's Content Security Policy forbids
 * every connection (`default-src 'none'`), which the worker inherits: no
 * fetch, XHR, WebSocket, EventSource or script loading, so nothing can be
 * sent anywhere. The worker can be stopped at any time (the iframe is
 * removed with it), and a busy loop in it never freezes the page.
 *
 * The only way out is a message: `viewer.layers()` in the script posts a
 * call that the page answers from {@link ScriptHandlers}, a fixed list of
 * functions that check what they are given. Whatever the worker sends is
 * treated as untrusted: unknown methods are refused, and nothing it sends is
 * ever run or put into the page as HTML.
 */

/** The functions a script can call, by name: `viewer.<name>(...)` or `geo.<name>(...)` (as `geo.<name>`). */
export type ScriptHandlers = ReadonlyMap<string, (...args: unknown[]) => unknown>;

export interface ScriptEvents {
  /** A line from `print()` / `console.log()`. */
  onLog?: (text: string, level: 'log' | 'warn' | 'error') => void;
  /** `progress(fraction, message)`. */
  onProgress?: (fraction: number | null, message: string) => void;
  /** The script ended: its error (with the line in the script), or null when it finished. */
  onEnd?: (error: string | null, value: string | undefined) => void;
}

/** Longest line kept from the script (characters), and most lines per run. */
export const MAX_LOG_LINE = 20_000;
export const MAX_LOG_LINES = 5_000;

/** The worker's side: the `viewer`, `geo`, `print`, `progress`, `sleep` and `toCsv` the script sees. */
const RUNTIME = String.raw`'use strict';
const pending = new Map();
let seq = 0;
const send = (message) => self.postMessage(message);
const format = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const text = JSON.stringify(value, (k, v) => (ArrayBuffer.isView(v) ? '[' + v.constructor.name + ' ' + v.length + ']' : typeof v === 'bigint' ? String(v) : v), 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};
const print = (...values) => send({ type: 'log', level: 'log', text: values.map(format).join(' ') });
const warn = (...values) => send({ type: 'log', level: 'warn', text: values.map(format).join(' ') });
const call = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    // Made here, so a refusal points at the line of the script that asked.
    const origin = new Error();
    pending.set(id, { resolve, reject: (error) => reject(Object.assign(error, { stack: error.message + '\n' + origin.stack })) });
    try {
      send({ type: 'call', id, method, args });
    } catch (error) {
      pending.delete(id);
      reject(new TypeError(method + ': 引数の受け渡し不可（関数や DOM は不可）: ' + (error && error.message)));
    }
  });
self.onmessage = (event) => {
  const m = event.data;
  if (!m || m.type !== 'reply') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error));
};
const api = (names, prefix) => Object.freeze(Object.fromEntries(names.map((name) => [name, (...args) => call(prefix + name, args)])));
const viewer = api(VIEWER_METHODS, '');
const geo = api(GEO_METHODS, 'geo.');
const progress = (fraction, message) => send({ type: 'progress', fraction: typeof fraction === 'number' ? fraction : null, message: message === undefined ? '' : String(message) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toCsv = (rows, columns) => {
  const list = Array.from(rows || []);
  const cols = columns || (list.length && !Array.isArray(list[0]) ? [...new Set(list.flatMap((r) => Object.keys(r)))] : null);
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = cols ? [cols.map(cell).join(','), ...list.map((r) => cols.map((c) => cell(r[c])).join(','))] : list.map((r) => Array.from(r).map(cell).join(','));
  return '\uFEFF' + lines.join('\r\n');
};
const where = (stack) => String(stack || '').replace(/(?:blob:[^\s)]*|<anonymous>):(\d+):(\d+)/g, (_, line, column) => '行 ' + (Number(line) - USER_LINE_OFFSET) + ':' + column);
self.console = Object.freeze({ log: print, info: print, debug: print, warn, error: (...v) => send({ type: 'log', level: 'error', text: v.map(format).join(' ') }) });
// The sandbox forbids these already (no origin, no connections): taken away as well, so a mistake reads plainly.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'WebTransport', 'Worker', 'SharedWorker']) {
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    try {
      if (Object.prototype.hasOwnProperty.call(o, name)) delete o[name];
    } catch {}
  }
}
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  send({ type: 'log', level: 'error', text: '処理されなかったエラー: ' + format(event.reason) });
});
setTimeout(async () => {
  try {
    const value = await __script(viewer, geo, print, progress, sleep, toCsv);
    send({ type: 'end', error: null, value: value === undefined ? undefined : format(value) });
  } catch (error) {
    const message = error && error.message ? error.message : format(error);
    const at = error && error.stack ? where(error.stack).match(/行 \d+:\d+/g) : null;
    const line = at ? at.find((a) => Number(a.slice(2).split(':')[0]) > 0) : null;
    send({ type: 'end', error: message + (line ? '（' + line + '）' : '') });
  }
}, 0);
`;

/** The iframe's page: it starts the worker and passes messages both ways, nothing more. */
const BOOT = `
<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; base-uri 'none'; form-action 'none'">
<script>
'use strict';
addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || !event.data || typeof event.data.source !== 'string') return;
  let worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([event.data.source], { type: 'text/javascript' })));
  } catch (error) {
    port.postMessage({ type: 'end', error: 'スクリプトの開始に失敗: ' + error.message });
    return;
  }
  worker.onmessage = (e) => port.postMessage(e.data);
  worker.onerror = (e) => {
    e.preventDefault();
    const line = e.lineno - event.data.offset;
    port.postMessage({ type: 'end', error: (e.message || 'スクリプトの読み込みに失敗') + (line > 0 ? '（行 ' + line + (e.colno ? ':' + e.colno : '') + '）' : '') });
  };
  worker.onmessageerror = () => port.postMessage({ type: 'end', error: '受け渡し不可の値を送信' });
  port.onmessage = (e) => worker.postMessage(e.data);
}, { once: true });
</script>`;

/** The source the worker runs: the runtime, then the script as the body of an async function. */
export function workerSource(code: string, viewerMethods: readonly string[], geoMethods: readonly string[]): { source: string; offset: number } {
  const head = `const USER_LINE_OFFSET = __OFFSET__;\nconst VIEWER_METHODS = ${JSON.stringify(viewerMethods)};\nconst GEO_METHODS = ${JSON.stringify(geoMethods)};\n${RUNTIME}\nasync function __script(viewer, geo, print, progress, sleep, toCsv) {\n`;
  const offset = head.split('\n').length - 1;
  return { source: `${head.replace('__OFFSET__', String(offset))}${code}\n}\n`, offset };
}

/** One run of a script. */
export class ScriptRun {
  private frame_: HTMLIFrameElement | null;
  private port_: MessagePort | null = null;
  private ended_ = false;
  private lines_ = 0;

  constructor(
    code: string,
    private readonly handlers: ScriptHandlers,
    private readonly events: ScriptEvents = {},
  ) {
    const viewerMethods = [...handlers.keys()].filter((k) => !k.startsWith('geo.'));
    const geoMethods = [...handlers.keys()].filter((k) => k.startsWith('geo.')).map((k) => k.slice(4));
    const { source, offset } = workerSource(code, viewerMethods, geoMethods);
    const frame = (this.frame_ = document.createElement('iframe'));
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.srcdoc = BOOT;
    frame.addEventListener(
      'load',
      () => {
        if (this.ended_ || !frame.contentWindow) return;
        const channel = new MessageChannel();
        this.port_ = channel.port1;
        channel.port1.onmessage = (e) => void this.receive_(e.data);
        // The frame has no origin of its own to name: '*' is the only target; what is sent is the script itself.
        frame.contentWindow.postMessage({ source, offset }, '*', [channel.port2]);
      },
      { once: true },
    );
    document.body.append(frame);
  }

  /** Whether the script is still running. */
  running(): boolean {
    return !this.ended_;
  }

  /** Stops the script at once (its worker goes with the frame). */
  stop(reason = '停止'): void {
    this.end_(reason);
  }

  private end_(error: string | null, value?: string): void {
    if (this.ended_) return;
    this.ended_ = true;
    this.port_?.close();
    this.port_ = null;
    this.frame_?.remove();
    this.frame_ = null;
    this.events.onEnd?.(error, value);
  }

  private async receive_(message: unknown): Promise<void> {
    if (this.ended_ || typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    switch (m.type) {
      case 'log': {
        if (this.lines_++ >= MAX_LOG_LINES) {
          if (this.lines_ === MAX_LOG_LINES + 1) this.events.onLog?.(`出力が ${MAX_LOG_LINES} 行を超えたため、以降は非表示`, 'warn');
          return;
        }
        const level = m.level === 'warn' || m.level === 'error' ? m.level : 'log';
        this.events.onLog?.(String(m.text).slice(0, MAX_LOG_LINE), level);
        return;
      }
      case 'progress': {
        const f = typeof m.fraction === 'number' && Number.isFinite(m.fraction) ? Math.min(1, Math.max(0, m.fraction)) : null;
        this.events.onProgress?.(f, String(m.message ?? '').slice(0, 200));
        return;
      }
      case 'end':
        this.end_(m.error === null || m.error === undefined ? null : String(m.error).slice(0, MAX_LOG_LINE), m.value === undefined ? undefined : String(m.value).slice(0, MAX_LOG_LINE));
        return;
      case 'call': {
        const id = m.id;
        if (typeof id !== 'number') return;
        const method = typeof m.method === 'string' ? m.method : '';
        const handler = this.handlers.get(method);
        let reply: { type: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };
        try {
          if (!handler) throw new Error(`${method} という関数なし`);
          const value = await handler(...(Array.isArray(m.args) ? m.args : []));
          reply = { type: 'reply', id, ok: true, value };
        } catch (error) {
          reply = { type: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (this.ended_ || !this.port_) return;
        try {
          this.port_.postMessage(reply);
        } catch (error) {
          this.port_.postMessage({ type: 'reply', id, ok: false, error: `結果の受け渡しに失敗: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
      }
    }
  }
}
