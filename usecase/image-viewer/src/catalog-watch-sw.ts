/**
 * The service worker's part of the catalog watches (catalog-watch.ts): when
 * the browser fires the installed app's Periodic Background Sync, the
 * watches are checked and the app icon's badge updated, also with no window
 * of the app open. vite.config.ts bundles this file into sw.js.
 */
import { checkDue, plainAsk, SYNC_TAG } from './catalog-watch.js';

interface PeriodicSyncEvent extends Event {
  readonly tag: string;
  waitUntil(promise: Promise<unknown>): void;
}

self.addEventListener('periodicsync', (event) => {
  const sync = event as PeriodicSyncEvent;
  // The browser chose the time: every enabled watch is checked.
  if (sync.tag === SYNC_TAG) sync.waitUntil(checkDue(plainAsk, 0, true).catch(() => null));
});
