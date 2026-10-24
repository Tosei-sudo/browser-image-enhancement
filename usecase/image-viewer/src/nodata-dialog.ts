/**
 * The no-data dialog (from the processing dialog): which pixels of an image
 * are drawn transparent. By default the file's own no-data value
 * (GDAL_NODATA) and the fill values that usually mean no data (-9999,
 * -32768, the lowest float, NaN) are; here the black collar around a warped
 * image (0 in every band) and any other values can be added, and the
 * automatic ones turned off.
 *
 * Nothing is computed: the image's tiles are read again with the new values
 * (see `EnhancedGeoTIFF.setNoData`), DRA leaves the new no-data pixels out,
 * and the setting is saved in projects.
 */
import type { ImageList, ViewerImage } from './images.js';

export interface NoDataDialogOptions {
  say: (message: string) => void;
  /** Called after an image's no-data values changed (for a project's unsaved mark). */
  onChange?: (image: ViewerImage) => void;
}

/** Numbers in `text`, separated by commas or spaces; null when one is not a number. */
export function parseValues(text: string): number[] | null {
  const parts = text.split(/[\s,、，]+/).filter((p) => p !== '');
  const values = parts.map((p) => Number(p.replace(/[−－]/g, '-')));
  return values.every((v) => Number.isFinite(v)) ? values : null;
}

/** A value as typed back: -3.4e+38 rather than its 39 digits. */
const show = (v: number) => (Math.abs(v) >= 1e15 ? v.toExponential() : String(v));

export class NoDataDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly image_: HTMLSelectElement;
  private readonly auto_: HTMLInputElement;
  private readonly zero_: HTMLInputElement;
  private readonly values_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private images_: ViewerImage[] = [];

  constructor(
    private readonly images: ImageList,
    private readonly options: NoDataDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog nodata-dialog';
    this.dialog.setAttribute('aria-labelledby', 'nodata-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="nodata-title">ノーデータの透明化</h2>
        <label class="wide">画像<select name="image" aria-label="画像"></select></label>
        <p class="wide processing-hint nodata-file"></p>
        <label class="check wide"><input name="zero" type="checkbox" /><span>黒い縁（すべてのバンドが 0 の画素）を透明化</span></label>
        <label class="check wide"><input name="auto" type="checkbox" checked /><span>ファイルのノーデータ値と、よく使われる埋め値（-9999・-32768・NaN など）を透明化</span></label>
        <label class="wide">ほかに透明にする値<input name="values" type="text" inputmode="decimal" placeholder="例: 255, 65535" aria-label="ほかに透明にする値" /></label>
        <p class="wide processing-hint">すべてのバンドがこれらの値の画素を透明化。16 bit・浮動小数点の画像は元の値、8 bit の画像は 0〜255 で記述。選択後すぐ地図に反映、DRA の統計からも除外。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="reset">既定に復元</button>
        <button type="button" value="cancel" class="primary">閉じる</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const field = <T extends Element>(name: string) => this.form_.elements.namedItem(name) as unknown as T;
    this.image_ = field('image');
    this.auto_ = field('auto');
    this.zero_ = field('zero');
    this.values_ = field('values');
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.form_.addEventListener('submit', (e) => e.preventDefault());
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=reset]')!.addEventListener('click', () => {
      const image = this.images_[Number(this.image_.value)];
      if (image) this.set(image, { auto: true, values: [] });
      this.show_();
    });
    this.image_.addEventListener('change', () => this.show_());
    this.auto_.addEventListener('change', () => this.apply_());
    this.zero_.addEventListener('change', () => this.apply_());
    this.values_.addEventListener('change', () => this.apply_());
  }

  /** Opens the dialog on `image` (default: the selected image). */
  open(image = this.images.selected()): void {
    this.images_ = [...this.images.list()];
    this.image_.replaceChildren(...this.images_.map((i, n) => new Option(i.name, String(n))));
    const chosen = image && this.images_.includes(image) ? image : this.images_[0];
    if (chosen) this.image_.value = String(this.images_.indexOf(chosen));
    this.show_();
    this.note_.textContent = this.images_.length ? '' : '画像なし（先に画像を開く）';
    this.dialog.showModal();
  }

  /** Makes `noData` the transparent pixels of `image`. */
  set(image: ViewerImage, noData: { auto: boolean; values: number[] }): void {
    void image.source.setNoData(noData).catch((error: unknown) => this.options.say(`ノーデータの変更に失敗: ${error instanceof Error ? error.message : String(error)}`));
    this.options.onChange?.(image);
  }

  /** The form shows the chosen image's values. */
  private show_(): void {
    const image = this.images_[Number(this.image_.value)];
    const noData = image?.source.getNoData() ?? { auto: true, values: [] };
    this.auto_.checked = noData.auto;
    this.zero_.checked = noData.values.includes(0);
    this.values_.value = noData.values.filter((v) => v !== 0).map(show).join(', ');
    const own = image?.source.getFileNoData() ?? null;
    this.dialog.querySelector('.nodata-file')!.textContent = image ? `ファイルのノーデータ値: ${own === null ? 'なし' : show(own)}` : '';
    this.note_.textContent = '';
  }

  /** The form's values, on the chosen image. */
  private apply_(): void {
    const image = this.images_[Number(this.image_.value)];
    if (!image) return;
    const typed = parseValues(this.values_.value);
    if (!typed) {
      this.note_.textContent = '値は数字をカンマ区切りで入力';
      return;
    }
    this.note_.textContent = '';
    // A 0 typed in the box is the black collar's check box.
    if (typed.includes(0)) this.zero_.checked = true;
    const others = typed.filter((v) => v !== 0);
    this.values_.value = others.map(show).join(', ');
    this.set(image, { auto: this.auto_.checked, values: [...new Set([...(this.zero_.checked ? [0] : []), ...others])] });
  }
}
