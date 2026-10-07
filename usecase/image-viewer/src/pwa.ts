/// <reference types="vite/client" />
/**
 * The viewer as an installable app (PWA): the service worker that keeps the
 * site for offline use (sw.js, made by vite.config.ts), the notice that a
 * newer version is ready, and the files the operating system opens with the
 * installed app (the manifest's `file_handlers`: project files, pictures,
 * GeoTIFFs and vector files).
 */

/** What the browser hands an installed app opened with files. */
interface LaunchParams {
  files: FileSystemHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Calls `take` with the files the app was opened with from the operating system, if any. */
export function onLaunchFiles(take: (handles: FileSystemFileHandle[]) => void): void {
  const queue = (window as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    const files = params.files.filter((h): h is FileSystemFileHandle => h.kind === 'file');
    if (files.length) take(files);
  });
}

/**
 * Registers the service worker (only in a build: the dev server has none),
 * and offers to reload when a newer version of the site has been fetched.
 */
export async function registerServiceWorker(url = './sw.js'): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return null;
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.register(url, { scope: './' });
  } catch (error) {
    // Not over HTTPS, or blocked: the site works as before, without being installable.
    console.warn('Service Worker を登録できませんでした', error);
    return null;
  }
  // Service workers turned off (as the browser tests do).
  if (!registration) return null;
  // A newer version waits until every window of the old one is closed, unless the person reloads now.
  const offer = (worker: ServiceWorker | null) => {
    if (worker && navigator.serviceWorker.controller) showUpdate(worker);
  };
  offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration!.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(installing);
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !updating) return;
    reloading = true;
    location.reload();
  });
  return registration;
}

/** Whether the person asked for the newer version (only then does a change of worker reload the page). */
let updating = false;

function showUpdate(worker: ServiceWorker): void {
  if (document.querySelector('.app-update')) return;
  const bar = document.createElement('div');
  bar.className = 'app-update';
  bar.setAttribute('role', 'status');
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = '再読み込み';
  reload.addEventListener('click', () => {
    updating = true;
    worker.postMessage({ type: 'skip-waiting' });
  });
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = '後で';
  later.addEventListener('click', () => bar.remove());
  bar.append('新しいバージョンがあります（開いているレイヤーは閉じます）', reload, later);
  document.body.append(bar);
}
