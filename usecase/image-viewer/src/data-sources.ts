/**
 * Files as inputs of the processing tools, like ArcGIS's and QGIS's tool
 * dialogs: next to a choice of layers, a 📂 button opens a file (chosen, one
 * of 「最近」, or a URL) without adding it to the map. It is kept as a data
 * source (see {@link ImageList.openAsSources}): offered in every tool's
 * choices from then on, marked 📄, until the page is closed.
 */
import type { ImageList, ViewerLayer } from './images.js';
import { entryLabel, fileOf, pickFiles, readEntry, type RecentEntry, type RecentFiles } from './recent-files.js';

/** What a choice takes: images or vector layers. */
export type SourceKind = 'image' | 'vector';

export interface DataSourcesOptions {
  /** Opens files the usual way (they become data sources while it runs). */
  openFiles: (files: File[]) => Promise<void>;
  /** Opens a URL the usual way: a COG, or a vector file. */
  openUrl: (url: string) => Promise<void>;
  /** The file chooser's `accept`. */
  accept: string;
  /** 「最近」; null when the browser cannot keep files. */
  recent: () => RecentFiles | null;
  /** Remembers files chosen with handles for 「最近」. */
  remember?: (handles: FileSystemFileHandle[]) => void;
  /** Whether the browser picks files with handles (File System Access). */
  fileAccess: boolean;
  say: (message: string) => void;
}

/** Wiring of a 📂 button to a dialog's choice. */
export interface BrowseOptions {
  /** The dialog (its form's choices are kept as they were while it fills again). */
  dialog: HTMLDialogElement;
  kind: SourceKind;
  /** Fills the dialog's choices again (with the new data sources). */
  refill: () => unknown;
  /** The value of the choice's option for `layer`, or null when the choice does not take it. */
  valueOf: (layer: ViewerLayer) => string | null;
  /** Takes the opened layers itself instead of choosing one (a list of check boxes, say). */
  take?: (layers: ViewerLayer[]) => void;
}

/** The value of `select`'s first option for the item at `index` of its list (`3`, or `3:0` for its first band); null when there is none. */
export function optionFor(select: HTMLSelectElement, index: number): string | null {
  if (index < 0) return null;
  return [...select.options].find((o) => o.value === String(index) || o.value.startsWith(`${index}:`))?.value ?? null;
}

export class DataSources {
  constructor(
    private readonly images: ImageList,
    private readonly options: DataSourcesOptions,
  ) {}

  /** A label for a layer in a tool's choice: data sources (not on the map) are marked 📄. */
  label(layer: ViewerLayer, text = layer.name): string {
    return this.images.isSource(layer) ? `📄 ${text}` : text;
  }

  /**
   * Puts a 📂 button after `choice` (a select, or any element) that opens
   * files as data sources and chooses the first that fits.
   */
  attach(choice: HTMLElement, browse: BrowseOptions): HTMLButtonElement {
    const field = document.createElement('span');
    field.className = 'source-field';
    choice.replaceWith(field);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source-browse';
    button.textContent = '📂';
    const what = browse.kind === 'image' ? '画像' : 'ベクター';
    button.title = `${what}ファイルを参照…（地図に追加せずに使います）`;
    button.setAttribute('aria-label', 'ファイルを参照');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'source-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    field.append(choice, button, menu);
    const close = () => {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    button.addEventListener('click', () => {
      if (!menu.hidden) return close();
      void this.fillMenu_(menu, browse, close, choice).then(() => {
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        menu.querySelector<HTMLElement>('button')?.focus();
      });
    });
    // Escape closes the menu, not the dialog.
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      button.focus();
    });
    browse.dialog.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !field.contains(e.target as Node)) close();
    });
    browse.dialog.addEventListener('close', close);
    return button;
  }

  /** The menu: choose files, 「最近」's entries, and a URL. */
  private async fillMenu_(menu: HTMLElement, browse: BrowseOptions, close: () => void, choice: HTMLElement): Promise<void> {
    const item = (label: string, run: () => void, title?: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', () => {
        close();
        run();
      });
      return b;
    };
    const items: HTMLElement[] = [item('ファイルを選ぶ…', () => void this.choose_(browse, choice))];
    const entries = (await this.options.recent()?.list().catch(() => [])) ?? [];
    if (entries.length) {
      const head = document.createElement('span');
      head.className = 'source-menu-head';
      head.textContent = '最近';
      items.push(head, ...entries.map((entry) => item(entryLabel(entry), () => void this.reopen_(entry, browse, choice), entry.handles.map((h) => h.name).join('\n'))));
    }
    // Not a form of its own: the menu is inside the dialog's.
    const url = document.createElement('div');
    url.className = 'source-url';
    url.innerHTML = '<input type="url" placeholder="URL（COG・GeoJSON など）" aria-label="URL" /><button type="button">開く</button>';
    const input = url.querySelector('input')!;
    const go = () => {
      const value = input.value.trim();
      if (!value) return input.focus();
      close();
      void this.open_(() => this.options.openUrl(value), value, browse, choice);
    };
    url.querySelector('button')!.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      go();
    });
    items.push(url);
    menu.replaceChildren(...items);
  }

  /** Chooses files and opens them as data sources. */
  private async choose_(browse: BrowseOptions, choice: HTMLElement): Promise<void> {
    let files: File[];
    if (this.options.fileAccess) {
      try {
        const handles = await pickFiles(this.options.accept);
        if (!handles.length) return;
        this.options.remember?.(handles);
        files = await Promise.all(handles.map(fileOf));
      } catch {
        files = await this.chooseOldWay_();
      }
    } else {
      files = await this.chooseOldWay_();
    }
    if (files.length) await this.open_(() => this.options.openFiles(files), files.map((f) => f.name).join('、'), browse, choice);
  }

  /** Files from an ordinary file chooser (empty when cancelled). */
  private chooseOldWay_(): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = this.options.accept;
      input.addEventListener('change', () => resolve([...(input.files ?? [])]));
      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  }

  private async reopen_(entry: RecentEntry, browse: BrowseOptions, choice: HTMLElement): Promise<void> {
    const { files, missing } = await readEntry(entry);
    if (missing.length) this.options.say(`${missing.join('、')} を開けませんでした（移動・削除されたか、読み取りが許可されていません）`);
    if (!files.length) return;
    this.options.remember?.(entry.handles);
    await this.open_(() => this.options.openFiles(files), files.map((f) => f.name).join('、'), browse, choice);
  }

  /** Opens files as data sources, then fills the dialog again with the first that fits chosen. */
  private async open_(open: () => Promise<void>, names: string, browse: BrowseOptions, choice: HTMLElement): Promise<void> {
    let added: ViewerLayer[];
    try {
      added = await this.images.openAsSources(open);
    } catch (error) {
      this.options.say(`${names} を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!added.length) return; // the opening said why
    this.options.say(`${added.map((l) => l.name).join('、')} を入力用に開きました（地図には追加していません）`);
    if (!browse.dialog.open) return;
    if (browse.take) return browse.take(added);
    const form = browse.dialog.querySelector('form');
    const kept = form ? snapshot(form) : null;
    await browse.refill();
    if (form && kept) restore(form, kept, choice);
    const fits = added.map((l) => browse.valueOf(l)).find((v): v is string => v !== null);
    if (fits === undefined || !(choice instanceof HTMLSelectElement)) {
      this.options.say(`${names} には使える${browse.kind === 'image' ? '画像' : 'ベクターレイヤー'}がありませんでした（入力用に開いたものは他のツールでも選べます）`);
      return;
    }
    choice.value = fits;
    choice.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** The values of a form's named fields (check boxes by name and value). */
function snapshot(form: HTMLFormElement): Map<string, string | boolean> {
  const kept = new Map<string, string | boolean>();
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) kept.set(`${el.name}=${el.value}`, el.checked);
    else if (!(el instanceof HTMLInputElement && el.type === 'file')) kept.set(el.name, el.value);
  }
  return kept;
}

/**
 * Puts back what {@link snapshot} kept, where the field (and, for a select,
 * the option) is still there; a select or box put back says it changed (so
 * what hangs on it follows), but `skip`, which is chosen next.
 */
function restore(form: HTMLFormElement, kept: Map<string, string | boolean>, skip: HTMLElement): void {
  const changed: Array<HTMLInputElement | HTMLSelectElement> = [];
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const v = kept.get(`${el.name}=${el.value}`);
      if (typeof v !== 'boolean' || el.checked === v) continue;
      el.checked = v;
      if (v || el.type === 'checkbox') changed.push(el);
      continue;
    }
    const v = kept.get(el.name);
    if (typeof v !== 'string') continue;
    if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) continue;
    if (el.value === v) continue;
    el.value = v;
    if (el instanceof HTMLSelectElement && el !== skip) changed.push(el);
  }
  for (const el of changed) el.dispatchEvent(new Event('change', { bubbles: true }));
}
