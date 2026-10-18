/* global window, URL, console, setTimeout, clearTimeout */
/**
 * Client of the image viewer's embedding API (no build step, an ES module).
 *
 *   import { connect } from 'https://viewer.example.com/embed-client.js';
 *   const iframe = document.querySelector('iframe'); // src="https://viewer.example.com/index.html?embed=1"
 *   const viewer = await connect(iframe, 'https://viewer.example.com');
 *   await viewer.call('setView', { center: [139.767, 35.681], zoom: 14 });
 *   viewer.on('click', ({ lon, lat }) => console.log(lon, lat));
 *
 * The viewer answers only pages whose origin is in its config.json
 * `embed.allowedOrigins`. Methods and events: see the viewer's README (埋め込み).
 */
const TYPE = 'image-viewer';
const VERSION = 1;

/**
 * Connects to the viewer in `iframe`, served from `origin` (exact, such as
 * `https://viewer.example.com`). Resolves once the viewer answers `hello`
 * (it is retried while the viewer loads); rejects after `options.timeout` ms.
 * Options: `timeout` (15000), `callTimeout` (120000), `events` (names to receive; all by default).
 */
export function connect(iframe, origin, options = {}) {
  if (!iframe || !iframe.contentWindow) throw new TypeError('connect: an iframe in the document is required');
  if (typeof origin !== 'string' || origin === '*' || new URL(origin).origin !== origin) throw new TypeError('connect: origin must be the exact origin of the viewer');
  const timeout = options.timeout ?? 15000;
  const pending = new Map();
  const listeners = new Map();
  let next = 1;
  let readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));

  const onMessage = (e) => {
    if (e.origin !== origin || e.source !== iframe.contentWindow) return;
    const m = e.data;
    if (!m || m.type !== TYPE || m.v !== VERSION) return;
    if (typeof m.event === 'string') {
      if (m.event === 'ready') readyResolve(m.data);
      for (const cb of listeners.get(m.event) ?? []) {
        try {
          cb(m.data);
        } catch (error) {
          console.error(error);
        }
      }
      return;
    }
    const call = pending.get(m.id);
    if (!call) return;
    pending.delete(m.id);
    clearTimeout(call.timer);
    if (m.error) call.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    else call.resolve(m.result);
  };
  window.addEventListener('message', onMessage);

  const send = (method, params, ms) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method}: the viewer did not answer`), { code: 'timeout' }));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      iframe.contentWindow.postMessage({ type: TYPE, v: VERSION, id, method, params: params ?? {} }, origin);
    });

  const client = {
    /** What the viewer said to `hello`: { version, methods, events, readOnly, ready }. */
    info: null,
    /** Resolves when the viewer has opened its start layers. */
    ready,
    /** Calls a method; resolves with its result, rejects with an Error carrying `code`. */
    call: (method, params) => send(method, params, options.callTimeout ?? 120000),
    /** Listens to an event (ready, view, selection, layers, click); returns a function that stops listening. */
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event).delete(cb);
    },
    /** Stops listening to the viewer. */
    close() {
      window.removeEventListener('message', onMessage);
      for (const call of pending.values()) clearTimeout(call.timer);
      pending.clear();
    },
  };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      send('hello', options.events ? { events: options.events } : {}, 1000).then(
        (info) => {
          client.info = info;
          if (info.ready) readyResolve({ readOnly: info.readOnly });
          resolve(client);
        },
        (error) => {
          if (error.code === 'timeout' && Date.now() - started < timeout) return attempt();
          client.close();
          reject(error.code === 'timeout' ? Object.assign(new Error('The viewer did not answer: is this page\'s origin in its config.json embed.allowedOrigins?'), { code: 'timeout' }) : error);
        },
      );
    };
    attempt();
  });
}
