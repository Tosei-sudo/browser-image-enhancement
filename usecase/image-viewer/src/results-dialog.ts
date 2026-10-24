/**
 * 「処理結果…」: the processing results kept in the browser (result-store.ts),
 * newest first, each to open as a layer again, save as a file (COG or
 * GeoTIFF, result-save-dialog.ts) or delete; and how much of the browser's
 * storage they take.
 */
import type { ImageList, ViewerImage } from './images.js';
import { results, type KeptResult, type ResultInfo } from './result-store.js';
import { formatBytes, type ResultSaveDialog } from './result-save-dialog.js';

export interface ResultsDialogOptions {
  say: (message: string) => void;
  /** Opens a file as a layer; the layer, or null when it could not be opened. */
  open: (file: File) => Promise<ViewerImage | null>;
  saver: ResultSaveDialog;
}

export class ResultsDialog {
  readonly dialog: HTMLDialogElement;
  private readonly list_: HTMLUListElement;
  private readonly usage_: HTMLElement;
  private readonly clear_: HTMLButtonElement;

  constructor(
    private readonly images: ImageList,
    private readonly options: ResultsDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service results-dialog';
    this.dialog.setAttribute('aria-labelledby', 'results-title');
    this.dialog.innerHTML = `
      <h2 id="results-title">処理結果</h2>
      <p class="hint">プロセッシングで作成した画像はブラウザ内に保存、再読み込み後も保持。ここから表示・ファイルに保存（COG・GeoTIFF）・削除が可能。</p>
      <ul class="results-list"></ul>
      <p class="hint results-usage"></p>
      <div class="service-actions">
        <button type="button" value="clear">すべて削除</button>
        <button type="button" value="close">閉じる</button>
      </div>`;
    this.list_ = this.dialog.querySelector('.results-list')!;
    this.usage_ = this.dialog.querySelector('.results-usage')!;
    this.clear_ = this.dialog.querySelector('button[value=clear]')!;
    this.clear_.addEventListener('click', () => void this.clearAll_());
    this.dialog.querySelector('button[value=close]')!.addEventListener('click', () => this.dialog.close());
    results.onChange(() => {
      if (this.dialog.open) void this.fill_();
    });
    document.body.append(this.dialog);
  }

  async open(): Promise<void> {
    await this.fill_();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** The open layers of a kept result. */
  private layersOf_(id: string): ViewerImage[] {
    return this.images.list().filter((image) => results.infoOf(image)?.kept?.id === id);
  }

  private async fill_(): Promise<void> {
    const kept = await results.list().catch(() => []);
    this.list_.replaceChildren(
      ...kept.map((result) => {
        const item = document.createElement('li');
        const text = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'results-name';
        name.textContent = result.name;
        const meta = document.createElement('span');
        meta.className = 'results-meta';
        const when = new Date(result.created);
        const open = this.layersOf_(result.id).length > 0;
        meta.textContent = `${result.tool}・${formatBytes(result.size)}・${when.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}${open ? '・表示中' : ''}`;
        text.append(name, meta);
        const actions = document.createElement('span');
        actions.className = 'results-actions';
        const button = (label: string, run: () => Promise<void>) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.setAttribute('aria-label', `${result.name} を${label.replace('…', '')}`);
          b.addEventListener('click', () => void run());
          actions.append(b);
          return b;
        };
        button('開く', () => this.open_(result)).disabled = open;
        button('保存…', () => this.save_(result));
        button('削除', () => this.remove_(result));
        item.append(text, actions);
        return item;
      }),
    );
    if (!kept.length) {
      const none = document.createElement('li');
      none.className = 'results-none';
      none.textContent = results.kept ? 'ブラウザに保存された処理結果なし' : 'このブラウザでは処理結果の保存不可（ページを閉じると消去）';
      this.list_.append(none);
    }
    this.clear_.disabled = !kept.length;
    const total = kept.reduce((n, r) => n + r.size, 0);
    const usage = await results.usage().catch(() => null);
    this.usage_.textContent = `処理結果 ${kept.length} 件、${formatBytes(total)}${usage ? `（ブラウザの空き ${formatBytes(Math.max(0, usage.quota - usage.used))}）` : ''}`;
  }

  /** The files of a kept result, as the save dialog takes them. */
  private async info_(result: KeptResult): Promise<ResultInfo> {
    return { tool: result.tool, kept: result, files: await Promise.all(result.files.map((name) => results.file(result, name))), categorical: result.categorical };
  }

  private async open_(result: KeptResult): Promise<void> {
    try {
      const info = await this.info_(result);
      const image = await this.options.open(info.files[0]);
      if (!image) return;
      results.mark(image, info);
      this.images.setBadge(image, result.tool);
      this.options.say(`${result.name} を表示`);
      await this.fill_();
    } catch (error) {
      this.options.say(`${result.name} の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async save_(result: KeptResult): Promise<void> {
    const image = this.layersOf_(result.id)[0];
    await this.options.saver.open(image ? { info: results.infoOf(image)!, image } : { info: await this.info_(result) });
  }

  private async remove_(result: KeptResult): Promise<void> {
    const layers = this.layersOf_(result.id);
    const warning = layers.length ? `${result.name} を削除。表示中のレイヤーも閉じる。` : `${result.name} を削除。`;
    if (!confirm(warning)) return;
    for (const layer of layers) this.images.remove(layer);
    await results.remove(result.id);
    this.options.say(`${result.name} を削除`);
  }

  private async clearAll_(): Promise<void> {
    const kept = await results.list();
    if (!kept.length || !confirm(`ブラウザに保存された処理結果 ${kept.length} 件をすべて削除。表示中のものも閉じる。`)) return;
    for (const result of kept) {
      for (const layer of this.layersOf_(result.id)) this.images.remove(layer);
      await results.remove(result.id).catch(() => {});
    }
    this.options.say(`処理結果 ${kept.length} 件を削除`);
  }
}
