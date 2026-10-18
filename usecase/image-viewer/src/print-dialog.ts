/**
 * The 「印刷レイアウト」 dialog: a title, the sheet (A4 / A3, portrait or
 * landscape), the scale bar, north arrow and legend to put on it, and PDF or
 * PNG (see print-layout.ts). The resolution waits under 詳細設定.
 */
import type OlMap from 'ol/Map.js';
import type { ImageList, ViewerLayer } from './images.js';
import { stopsOf } from './colorize-dialog.js';
import { drawSheet, sheetFile, type LegendEntry, type Orientation, type Paper, type PrintRequest } from './print-layout.js';
import { saveFile } from './save-folder.js';

const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** The legend of the layers shown, top first. */
export function legendOf(layers: readonly ViewerLayer[], visible: (layer: ViewerLayer) => boolean): LegendEntry[] {
  return layers.filter(visible).map((l): LegendEntry => {
    if (l.type === 'image') {
      const scale = l.layer.getColorScale();
      if (scale) {
        const stops = [...stopsOf(scale.scale)].sort((a, b) => a[0] - b[0]).map(([, c]) => hex(c));
        return { name: l.name, swatch: { kind: 'ramp', stops: scale.reverse ? stops.reverse() : stops } };
      }
      return { name: l.name, swatch: { kind: 'image' } };
    }
    const style = l.service.style?.get();
    if (!style) return { name: l.name, swatch: { kind: 'image' } };
    const s = style.symbol;
    if (s.fillOpacity === 0 && s.strokeWidth > 0) return { name: l.name, swatch: { kind: 'line', stroke: s.stroke } };
    return { name: l.name, swatch: { kind: 'fill', fill: s.fill, stroke: s.stroke } };
  });
}

export interface PrintDialogOptions {
  say: (message: string) => void;
  /** Whether a layer's check box is on. */
  visible: (layer: ViewerLayer) => boolean;
  /** A name for the file, without extension (default: the title or "map"). */
  name?: () => string | null;
}

export class PrintDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly images: ImageList,
    private readonly options: PrintDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog print-dialog';
    this.dialog.setAttribute('aria-labelledby', 'print-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="print-title">印刷レイアウト</h2>
        <label class="wide">タイトル<input name="title" type="text" autocomplete="off" aria-label="タイトル" placeholder="（なし）" /></label>
        <label>用紙<select name="paper" aria-label="用紙"><option value="A4">A4</option><option value="A3">A3</option></select></label>
        <label>向き<select name="orientation" aria-label="向き"><option value="landscape">横</option><option value="portrait">縦</option></select></label>
        <label>形式<select name="format" aria-label="形式"><option value="pdf">PDF</option><option value="png">PNG</option></select></label>
        <div class="wide print-parts" role="group" aria-label="載せるもの">
          <label class="check"><input name="scaleBar" type="checkbox" checked /><span>縮尺バー</span></label>
          <label class="check"><input name="northArrow" type="checkbox" checked /><span>方位記号</span></label>
          <label class="check"><input name="legend" type="checkbox" checked /><span>凡例</span></label>
        </div>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label class="wide">下の注記<input name="note" type="text" autocomplete="off" aria-label="下の注記" placeholder="作成者・目的など" /></label>
            <label>解像度<select name="dpi" aria-label="解像度"><option value="150">150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi（大きなファイル）</option></select></label>
          </div>
        </details>
        <p class="wide processing-hint">今の表示範囲が入るように、用紙いっぱいに地図を描き直します。地図に描いた注記も入ります。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">保存</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    button.addEventListener('click', () => this.open());
  }

  open(): void {
    this.note_.textContent = '';
    this.dialog.showModal();
  }

  /** What the form asks for. */
  request(): PrintRequest & { format: 'pdf' | 'png' } {
    const form = new FormData(this.form_);
    const sources = [...new Set([...this.map.getViewport().querySelectorAll('.ol-attribution li')].map((li) => li.textContent?.trim() ?? '').filter(Boolean))];
    return {
      paper: (form.get('paper') as Paper) || 'A4',
      orientation: (form.get('orientation') as Orientation) || 'landscape',
      dpi: Number(form.get('dpi')) || 150,
      title: String(form.get('title') ?? ''),
      note: String(form.get('note') ?? ''),
      scaleBar: form.has('scaleBar'),
      northArrow: form.has('northArrow'),
      legend: form.has('legend') ? legendOf(this.images.layers(), this.options.visible) : null,
      sources,
      format: form.get('format') === 'png' ? 'png' : 'pdf',
    };
  }

  /** Draws the sheet and saves it. */
  async run(): Promise<Blob | null> {
    const request = this.request();
    this.run_.disabled = true;
    this.note_.textContent = '地図を描いています…';
    try {
      const canvas = await drawSheet(this.map, request);
      const blob = await sheetFile(canvas, request, request.format);
      canvas.width = canvas.height = 0;
      const stem = (request.title.trim() || this.options.name?.() || 'map').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      const name = `${stem}.${request.format}`;
      this.dialog.close();
      await saveFile(name, blob, this.options.say, `（${request.paper} ${request.orientation === 'portrait' ? '縦' : '横'}、${request.dpi} dpi）`);
      return blob;
    } catch (error) {
      this.note_.textContent = `保存できませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      this.run_.disabled = false;
    }
  }
}
