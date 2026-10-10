/**
 * 3D Tiles from a folder on the computer: the files of the folder are given
 * addresses under a made-up origin, and CesiumJS's requests for those
 * addresses are answered from the files instead of the network. Relative
 * references between the files (child tilesets, tile contents, textures)
 * resolve as they would on a server.
 */
import { Resource } from '@cesium/engine';

/** The made-up origin of local folders (`.invalid` never resolves). */
const ORIGIN = 'https://local-3dtiles.invalid';

/** Files by their path under ORIGIN (`/1/folder/tileset.json`). */
const files = new Map<string, Blob>();
let folders = 0;
let hooked = false;

/** A file's path relative to the folder chosen (`webkitRelativePath`, else its name). */
function relativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/**
 * Makes the files of a folder (as chosen with a folder input, each with its
 * path inside the folder) readable by CesiumJS, and returns the address of its
 * tileset: the `tileset.json` nearest the top (else the only `.json` with a
 * root tile). Throws when there is none.
 */
export async function serveFolder(chosen: readonly File[]): Promise<{ url: string; name: string }> {
  hook();
  const id = ++folders;
  const paths = chosen.map((f) => relativePath(f).replace(/\\/g, '/'));
  const depth = (p: string) => p.split('/').length;
  const byDepth = chosen.map((f, i) => ({ f, path: paths[i] })).sort((a, b) => depth(a.path) - depth(b.path));
  let main = byDepth.find(({ path }) => /(^|\/)tileset\.json$/i.test(path));
  if (!main) {
    for (const candidate of byDepth.filter(({ path }) => /\.json$/i.test(path))) {
      const json = (await candidate.f.text().then(JSON.parse).catch(() => null)) as { asset?: unknown; root?: unknown } | null;
      if (json?.asset && json.root) {
        main = candidate;
        break;
      }
    }
  }
  if (!main) throw new Error('フォルダに tileset.json がありません');
  for (const [i, file] of chosen.entries()) files.set(`/${id}/${paths[i]}`, file);
  const folder = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/')) : main.f.name;
  return { url: `${ORIGIN}/${id}/${main.path.split('/').map(encodeURIComponent).join('/')}`, name: folder.split('/').pop() || folder };
}

/** Whether `url` is the address of a local folder's file. */
export function isLocalTiles(url: string): boolean {
  return url.startsWith(`${ORIGIN}/`);
}

/** The file at a local address, or undefined. */
function fileAt(url: string): Blob | undefined {
  if (!isLocalTiles(url)) return undefined;
  try {
    return files.get(decodeURIComponent(new URL(url).pathname));
  } catch {
    return undefined;
  }
}

/** Answers CesiumJS's requests for local addresses (once). */
function hook(): void {
  if (hooked) return;
  hooked = true;
  const impl = (Resource as unknown as { _Implementations: Record<string, (...args: never[]) => unknown> })._Implementations;
  const loadWithXhr = impl.loadWithXhr as (url: string, responseType: string | undefined, method: string, data: unknown, headers: unknown, deferred: Deferred, ...rest: unknown[]) => unknown;
  impl.loadWithXhr = ((url: string, responseType: string | undefined, method: string, data: unknown, headers: unknown, deferred: Deferred, ...rest: unknown[]) => {
    if (!isLocalTiles(url)) return loadWithXhr(url, responseType, method, data, headers, deferred, ...rest);
    const file = fileAt(url);
    if (!file) {
      deferred.reject(new Error(`${decodeURIComponent(url.slice(ORIGIN.length))} がフォルダにありません`));
      return undefined;
    }
    const read = async () => {
      switch (responseType) {
        case 'arraybuffer':
          return file.arrayBuffer();
        case 'blob':
          return file;
        case 'json':
          return JSON.parse(await file.text()) as unknown;
        default:
          return file.text();
      }
    };
    read().then(
      (v) => deferred.resolve(v),
      (e: unknown) => deferred.reject(e),
    );
    return undefined;
  }) as never;
  const loadImageElement = impl.loadImageElement as (url: string, crossOrigin: boolean, deferred: Deferred) => unknown;
  impl.loadImageElement = ((url: string, crossOrigin: boolean, deferred: Deferred) => {
    const file = fileAt(url);
    if (!file) return loadImageElement(url, crossOrigin, deferred);
    const objectUrl = URL.createObjectURL(file);
    const done: Deferred = {
      resolve: (v) => {
        URL.revokeObjectURL(objectUrl);
        deferred.resolve(v);
      },
      reject: (e) => {
        URL.revokeObjectURL(objectUrl);
        deferred.reject(e);
      },
    };
    return loadImageElement(objectUrl, false, done);
  }) as never;
}

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
