/**
 * Saving a processing result (the ⇩ of its layer row, or 「処理結果」): as a
 * COG (overviews, Deflate; what QGIS, GDAL and web maps open fastest), or as
 * it was made (an uncompressed tiled GeoTIFF, saved at once), with the
 * tool's other files (a classification's class numbers and table).
 *
 * The COG is made a block at a time (cog.ts) and written straight into the
 * save folder when one is chosen (save-folder.ts), else into the browser's
 * storage and handed to the downloads, so a result of many gigabytes never
 * has to be one Blob in the page.
 */
import { writeCog } from './cog.js';
import type { ViewerImage } from './images.js';
import { results, type ResultInfo } from './result-store.js';
import { downloadBlob, saveFile, saveFolder, savedMessage, type Saved } from './save-folder.js';
import { getShift } from './shift.js';
import { MemorySink } from './byte-sink.js';

export interface ResultSaveOptions {
  say: (message: string) => void;
  /** Opens 「保存先…」 (absent where the browser cannot write into folders). */
  chooseFolder?: () => void;
}

/** What is saved: a result, open as a layer or only kept in the browser. */
export interface SaveTarget {
  info: ResultInfo;
  image?: ViewerImage;
}

/** `bytes` for people: 1.2 GB, 340 MB… */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[u]}`;
}

/** `name` as a .tif file name (what was typed, without characters a file name cannot have). */
export function tifName(name: string, fallback: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim() || fallback;
  return /\.tiff?$/i.test(clean) ? clean : `${clean}.tif`;
}

export class ResultSaveDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly what_: HTMLElement;
  private readonly where_: HTMLElement;
  private readonly note_: HTMLElement;
  private readonly extras_: HTMLElement;
  private readonly shift_: HTMLElement;
  private readonly save_: HTMLButtonElement;
  private target_: SaveTarget | null = null;
  private running_: { cancelled: boolean } | null = null;

  constructor(private readonly options: ResultSaveOptions) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service result-save';
    this.dialog.setAttribute('aria-labelledby', 'result-save-title');
    this.dialog.innerHTML = `
      <h2 id="result-save-title">処理結果を保存</h2>
      <p class="result-save-what"></p>
      <form method="dialog">
        <label class="result-save-name">ファイル名 <input name="name" type="text" required spellcheck="false" autocomplete="off"></label>
        <fieldset class="result-save-format">
          <legend>形式</legend>
          <label class="check"><input type="radio" name="format" value="cog" checked> COG（概要画像付き・圧縮。QGIS・GDAL・Web で高速表示）</label>
          <label class="check"><input type="radio" name="format" value="raw"> GeoTIFF（作ったまま・圧縮なし。すぐ保存可能）</label>
        </fieldset>
        <details class="result-save-details">
          <summary>詳細設定</summary>
          <label>圧縮 <select name="compression"><option value="deflate">Deflate（予測子つき）</option><option value="none">なし</option></select></label>
          <label>概要画像 <select name="resampling"><option value="average">平均</option><option value="nearest">最近傍（分類など）</option><option value="off">なし</option></select></label>
        </details>
        <label class="check result-save-shift" hidden><input type="checkbox" name="shift" checked> <span></span></label>
        <fieldset class="result-save-extras" hidden><legend>一緒に保存</legend></fieldset>
        <p class="hint result-save-where"><span></span> <button type="button" value="folder" hidden>保存先の変更…</button></p>
        <p class="note" role="status"></p>
        <div class="service-actions">
          <button type="button" value="cancel">閉じる</button>
          <button type="submit" value="save" class="primary">保存</button>
        </div>
      </form>`;
    this.form_ = this.dialog.querySelector('form')!;
    this.what_ = this.dialog.querySelector('.result-save-what')!;
    this.where_ = this.dialog.querySelector('.result-save-where span')!;
    this.note_ = this.dialog.querySelector('.note')!;
    this.extras_ = this.dialog.querySelector('.result-save-extras')!;
    this.shift_ = this.dialog.querySelector('.result-save-shift')!;
    this.save_ = this.dialog.querySelector('button[value=save]')!;
    const folder = this.dialog.querySelector<HTMLButtonElement>('button[value=folder]')!;
    if (options.chooseFolder) {
      folder.hidden = false;
      folder.addEventListener('click', () => options.chooseFolder!());
    }
    saveFolder.onChange(() => void this.whereUpdate_());
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.save();
    });
    this.form_.addEventListener('change', () => this.update_());
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
    document.body.append(this.dialog);
  }

  /** Opens the dialog for `target`. */
  async open(target: SaveTarget): Promise<void> {
    this.target_ = target;
    const { info, image } = target;
    const main = info.files[0];
    const field = (name: string) => this.form_.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    field('name').value = main.name;
    (this.form_.querySelector('input[value=cog]') as HTMLInputElement).checked = true;
    field('compression').value = 'deflate';
    field('resampling').value = info.categorical ? 'nearest' : 'average';
    const kept = info.kept ? 'ブラウザ内に保存済み' : 'このページ内のみ（再読み込みで消去）';
    this.what_.textContent = `「${main.name}」（${info.tool}、${formatBytes(main.size)}、${kept}）`;
    // A layer moved on the map (manual shift): saved where it is shown, if wanted.
    const [dx, dy] = image ? getShift(image.source) : [0, 0];
    this.shift_.hidden = !dx && !dy;
    (this.shift_.querySelector('input') as HTMLInputElement).checked = true;
    this.shift_.querySelector('span')!.textContent = `地図で動かした位置で保存（東 ${dx.toFixed(2)}、北 ${dy.toFixed(2)}。COG のとき）`;
    this.extras_.replaceChildren(
      Object.assign(document.createElement('legend'), { textContent: '一緒に保存' }),
      ...info.files.slice(1).map((file, k) => {
        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.name = 'extra';
        box.value = String(k + 1);
        box.checked = true;
        label.append(box, ` ${file.name}（${formatBytes(file.size)}）`);
        return label;
      }),
    );
    this.extras_.hidden = info.files.length < 2;
    this.note_.textContent = '';
    this.save_.disabled = false;
    this.update_();
    await this.whereUpdate_();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private update_(): void {
    const cog = new FormData(this.form_).get('format') === 'cog';
    this.dialog.querySelector<HTMLDetailsElement>('.result-save-details')!.hidden = !cog;
  }

  private async whereUpdate_(): Promise<void> {
    const folder = await saveFolder.current();
    this.where_.textContent = folder ? `保存先: フォルダ「${folder.name}」` : '保存先: ダウンロード';
  }

  /** Saves with the dialog's choices; resolves when every file is saved (or it failed). */
  async save(): Promise<void> {
    const target = this.target_;
    if (!target || this.running_) return;
    const form = new FormData(this.form_);
    const main = target.info.files[0];
    const name = tifName(String(form.get('name') ?? ''), main.name);
    const control = { cancelled: false };
    this.running_ = control;
    this.save_.disabled = true;
    try {
      let saved: Saved;
      if (form.get('format') === 'raw') {
        this.note_.textContent = '保存中…';
        saved = await saveFolder.save(name, main);
      } else {
        const resampling = String(form.get('resampling'));
        const [dx, dy] = target.image && form.has('shift') ? getShift(target.image.source) : [0, 0];
        const opened = await saveFolder.open(name);
        const sink = opened.sink ?? results.scratch(name);
        this.note_.textContent = 'COG を作成中… 0%';
        const file = await writeCog(main, sink, opened.sink ? opened.saved.name : name, {
          compression: form.get('compression') === 'none' ? 'none' : 'deflate',
          overviews: resampling !== 'off',
          resampling: resampling === 'nearest' ? 'nearest' : 'average',
          shift: [dx, dy],
          scratch: () => (results.kept ? results.scratch('work') : new MemorySink()),
          control,
          onProgress: (done) => {
            if (!control.cancelled) this.note_.textContent = `COG を作成中… ${Math.floor(done * 100)}%`;
          },
        });
        if (opened.sink) saved = opened.saved;
        else {
          downloadBlob(name, file);
          saved = { name, folder: null, ...(opened.problem ? { problem: opened.problem } : {}) };
        }
      }
      const others = [...this.extras_.querySelectorAll<HTMLInputElement>('input[name=extra]')].filter((b) => b.checked).map((b) => target.info.files[Number(b.value)]);
      for (const file of others) {
        if (control.cancelled) break;
        await saveFile(file.name, file, () => {});
      }
      const more = others.length ? `（ほかに ${others.map((f) => f.name).join('、')}）` : '';
      this.options.say(savedMessage(saved, more));
      this.dialog.close();
    } catch (error) {
      if (control.cancelled) this.options.say('保存を中止');
      else this.note_.textContent = `保存失敗: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.running_ = null;
      this.save_.disabled = false;
    }
  }
}
