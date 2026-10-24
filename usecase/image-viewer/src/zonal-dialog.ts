/**
 * The zonal statistics dialog (from the processing dialog): a polygon layer
 * and an image, and for each polygon the statistics of the image's bands
 * inside it (zonal.ts). The result is a copy of the polygons, with their
 * attributes and a column per band and statistic, as a temporary layer: so
 * the numbers go to the attribute table, the dashboard, graduated styles and
 * scripts, and the source layer (an Esri service, a file) is left as it is.
 */
import Feature from 'ol/Feature.js';
import type Geometry from 'ol/geom/Geometry.js';
import { get as getProjection } from 'ol/proj.js';
import { place, tiffOf, transformer } from './composite-dialog.js';
import type { ViewerImage, ViewerLayer, ViewerService } from './images.js';
import { attributesOf, copyFields, field, type ProcessingResult } from './processing/common.js';
import type { Selection } from './selection.js';
import { optionFor, type DataSources } from './data-sources.js';
import { pixelBounds, rasterizePolygon, statField, ZONAL_STATS, zoneStats, type Rings, type ZonalStat } from './zonal.js';

/** A polygon's window larger than this many pixels is read at a lower resolution. */
const MAX_READ = 4_000_000;
/** Bands offered at most (the rest of a hyperspectral image are left out). */
const MAX_BANDS = 32;

export interface ZonalDialogOptions {
  /** The open layers, top first (and the data sources, after). */
  layers: () => readonly ViewerLayer[];
  /** Files as inputs, without adding them to the map (📂). */
  sources?: DataSources;
  /** The layer selected in the list. */
  selected: () => ViewerLayer | null;
  /** Opens the result as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  say: (message: string) => void;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Whether `entry` holds polygons. */
function hasPolygons(entry: ViewerService): boolean {
  return (entry.service.vector?.source.getFeatures() ?? []).some((f) => /Polygon$/.test(f.getGeometry()?.getType() ?? ''));
}

/** The rings of a polygon or multipolygon, flat [x, y, …] arrays in the map's projection. */
function ringsOf(geometry: Geometry | undefined): number[][] {
  if (!geometry) return [];
  const type = geometry.getType();
  const coords = (geometry as unknown as { getCoordinates(): unknown }).getCoordinates();
  const rings = type === 'Polygon' ? (coords as number[][][]) : type === 'MultiPolygon' ? (coords as number[][][][]).flat() : [];
  return rings.map((ring) => ring.flatMap((c) => [c[0], c[1]]));
}

export class ZonalDialog {
  readonly dialog: HTMLDialogElement;
  private readonly layer_: HTMLSelectElement;
  private readonly image_: HTMLSelectElement;
  private readonly bands_: HTMLElement;
  private readonly selected_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private layers_: ViewerService[] = [];
  private images_: ViewerImage[] = [];
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly selection: Selection,
    private readonly options: ZonalDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog zonal-dialog';
    this.dialog.setAttribute('aria-labelledby', 'zonal-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="zonal-title">ゾーン統計</h2>
        <label class="wide">ポリゴンレイヤー<select name="layer" aria-label="ポリゴンレイヤー"></select></label>
        <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物だけ</span></label>
        <label class="wide">画像<select name="image" aria-label="画像"></select></label>
        <fieldset class="wide zonal-choices zonal-bands"><legend>バンド</legend></fieldset>
        <fieldset class="wide zonal-choices"><legend>統計</legend>${ZONAL_STATS.map(
          (s) => `<label class="check"><input type="checkbox" name="stat" value="${s.id}"${s.id === 'mean' || s.id === 'count' ? ' checked' : ''} /><span>${s.label}</span></label>`,
        ).join('')}</fieldset>
        <p class="wide processing-hint">ポリゴンごとに、中心が内側に入る画素で集計（ノーデータは除外）。結果はポリゴンの写しに列を加えた一時レイヤー。</p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    const form = this.dialog.querySelector('form')!;
    this.layer_ = form.elements.namedItem('layer') as HTMLSelectElement;
    this.image_ = form.elements.namedItem('image') as HTMLSelectElement;
    this.selected_ = form.elements.namedItem('selectedOnly') as HTMLInputElement;
    this.bands_ = this.dialog.querySelector('.zonal-bands')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.layer_.addEventListener('change', () => this.update_());
    this.image_.addEventListener('change', () => void this.fillBands_());
    form.addEventListener('change', () => this.update_());
    const sources = options.sources;
    sources?.attach(this.layer_, { dialog: this.dialog, kind: 'vector', refill: () => this.open(), valueOf: (l) => optionFor(this.layer_, this.layers_.indexOf(l as ViewerService)) });
    sources?.attach(this.image_, { dialog: this.dialog, kind: 'image', refill: () => this.open(), valueOf: (l) => optionFor(this.image_, this.images_.indexOf(l as ViewerImage)) });
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog, with the selected layer (polygons or image) chosen. */
  async open(): Promise<void> {
    const all = this.options.layers();
    this.layers_ = all.filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector && hasPolygons(l));
    this.images_ = all.filter((l): l is ViewerImage => l.type === 'image' && !!tiffOf(l));
    const label = (l: ViewerLayer, text?: string) => this.options.sources?.label(l, text) ?? text ?? l.name;
    this.layer_.replaceChildren(...this.layers_.map((l, i) => new Option(label(l), String(i))));
    this.image_.replaceChildren(...this.images_.map((l, i) => new Option(label(l, `${l.name}（${l.source.getValueBandCount()} バンド）`), String(i))));
    const selected = this.options.selected();
    if (selected?.type === 'service' && this.layers_.includes(selected)) this.layer_.value = String(this.layers_.indexOf(selected));
    if (selected?.type === 'image' && this.images_.includes(selected)) this.image_.value = String(this.images_.indexOf(selected));
    this.note_.textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
    await this.fillBands_();
  }

  private layer(): ViewerService | null {
    return this.layers_[Number(this.layer_.value)] ?? null;
  }

  private image(): ViewerImage | null {
    return this.images_[Number(this.image_.value)] ?? null;
  }

  /** A check box per band of the image, all on. */
  private async fillBands_(): Promise<void> {
    const image = this.image();
    const n = Math.min(MAX_BANDS, image?.source.getValueBandCount() ?? 0);
    const names = image ? await image.source.getBandNames().catch(() => []) : [];
    const legend = this.bands_.querySelector('legend')!;
    this.bands_.replaceChildren(
      legend,
      ...Array.from({ length: n }, (_, b) => {
        const label = document.createElement('label');
        label.className = 'check';
        label.innerHTML = `<input type="checkbox" name="band" value="${b}" checked /><span>B${b + 1}${names[b] ? ` ${escape(names[b])}` : ''}</span>`;
        return label;
      }),
    );
    this.update_();
  }

  private chosen_(name: string): string[] {
    return [...this.dialog.querySelectorAll<HTMLInputElement>(`input[name=${name}]:checked`)].map((i) => i.value);
  }

  /** The selected-only box, and whether there is something to run. */
  private update_(): void {
    const entry = this.layer();
    const selected = entry ? this.selection.list().filter((f) => entry.service.vector!.source.hasFeature(f)).length : 0;
    if (selected === 0) this.selected_.checked = false;
    this.selected_.disabled = selected === 0;
    this.selected_.nextElementSibling!.textContent = `選択中の地物だけ（${selected.toLocaleString()} 件）`;
    const missing = !entry ? 'ポリゴンのレイヤーを開く必要あり' : !this.image() ? '画像なし（先に画像を開く）' : !this.chosen_('band').length ? 'バンドを選択' : !this.chosen_('stat').length ? '統計を選択' : '';
    if (!this.running_) this.note_.textContent = missing;
    this.run_.disabled = !!missing || !!this.running_;
  }

  /** Counts every polygon and opens the result. */
  async run(): Promise<void> {
    const entry = this.layer();
    const image = this.image();
    if (!entry || !image || this.running_) return;
    const vector = entry.service.vector!;
    const features = (this.selected_.checked ? this.selection.list().filter((f) => vector.source.hasFeature(f)) : vector.source.getFeatures()).filter((f) =>
      /Polygon$/.test(f.getGeometry()?.getType() ?? ''),
    );
    const bands = this.chosen_('band').map(Number);
    const stats = ZONAL_STATS.map((s) => s.id).filter((s) => this.chosen_('stat').includes(s));
    const control = (this.running_ = { cancelled: false });
    this.update_();
    try {
      const result = await this.compute_(entry, image, features, bands, stats, control);
      if (control.cancelled) return;
      await this.options.onResult(result, `ゾーン統計（${image.name}）`);
      this.dialog.close();
      this.options.say([`${result.title} を作成（${result.features.length.toLocaleString()} 件、一時レイヤー）`, ...(result.notes ?? [])].join('。'));
    } catch (error) {
      this.note_.textContent = `ゾーン統計の出力に失敗: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.running_ = null;
      this.update_();
    }
  }

  private async compute_(entry: ViewerService, image: ViewerImage, features: Feature[], bands: number[], stats: ZonalStat[], control: { cancelled: boolean }): Promise<ProcessingResult> {
    const p = place(image);
    const toImage = transformer(getProjection('EPSG:3857')!, p.projection);
    const width = p.tiff.getWidth();
    const height = p.tiff.getHeight();
    const total = image.source.getValueBandCount();
    const own = p.tiff.getGDALNoData();
    const noData = new Set<number>([...image.source.getNoData().values, ...(own === null ? [] : [own])]);
    const isNoData = (v: number) => noData.has(v);
    const median = stats.includes('median');
    const out: Feature[] = [];
    let outside = 0;
    let thinned = 0;
    let last = performance.now();
    for (let k = 0; k < features.length; k++) {
      if (control.cancelled) break;
      const feature = features[k];
      const rings: Rings = ringsOf(feature.getGeometry()).map((flat) => {
        toImage(flat, flat, 2);
        const ring: Array<[number, number]> = [];
        for (let i = 0; i < flat.length; i += 2) ring.push([(flat[i] - p.shift[0] - p.origin[0]) / p.resolution[0], (flat[i + 1] - p.shift[1] - p.origin[1]) / p.resolution[1]]);
        return ring;
      });
      const values: Record<string, number | null> = {};
      const bounds = pixelBounds(rings, width, height);
      if (!bounds) {
        outside++;
        for (const b of bands) for (const s of stats) values[statField(b, s, total)] = s === 'count' ? 0 : null;
      } else {
        const [c0, r0, c1, r1] = bounds;
        const w = c1 - c0;
        const h = r1 - r0;
        const scale = Math.min(1, Math.sqrt(MAX_READ / (w * h)));
        if (scale < 1) thinned++;
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));
        let mask: Uint8Array | null = rasterizePolygon(rings, c0, r0, outW, outH, outW / w);
        let window: [number, number, number, number] = [c0, r0, c1, r1];
        let read = { width: outW, height: outH };
        if (!mask.some((m) => m)) {
          // Smaller than a pixel: the pixel under its centre.
          const cx = Math.min(width - 1, Math.max(0, Math.floor(rings[0].reduce((s, [x]) => s + x, 0) / rings[0].length)));
          const cy = Math.min(height - 1, Math.max(0, Math.floor(rings[0].reduce((s, [, y]) => s + y, 0) / rings[0].length)));
          window = [cx, cy, cx + 1, cy + 1];
          read = { width: 1, height: 1 };
          mask = null;
        }
        const data = (await p.tiff.readRasters({ window, samples: bands, ...read, resampleMethod: 'nearest' })) as unknown as ArrayLike<number>[];
        const zone = zoneStats(data, mask, isNoData, median);
        zone.forEach((z, i) => {
          for (const s of stats) values[statField(bands[i], s, total)] = s === 'count' ? z.count : Number.isNaN(z[s]) ? null : z[s];
        });
      }
      const copy = new Feature({ ...attributesOf(feature), ...values });
      copy.setGeometry(feature.getGeometry()!.clone());
      out.push(copy);
      // Let the page breathe and say how far it got.
      if (performance.now() - last > 100) {
        this.note_.textContent = `${(k + 1).toLocaleString()} / ${features.length.toLocaleString()} 件を集計中…`;
        await new Promise((resolve) => setTimeout(resolve));
        last = performance.now();
      }
    }
    const fields = [
      ...copyFields(entry.service.vector!.fields),
      ...bands.flatMap((b) => stats.map((s) => field(statField(b, s, total), s === 'count' ? 'integer' : 'double', `${total > 1 ? `B${b + 1} ` : ''}${ZONAL_STATS.find((z) => z.id === s)!.label}`))),
    ];
    const notes: string[] = [];
    if (outside) notes.push(`${outside.toLocaleString()} 件は画像の外なので値なし`);
    if (thinned) notes.push(`${thinned.toLocaleString()} 件は大きいため間引いて集計`);
    return { title: `${entry.name}_統計`, features: out, fields, crs: entry.service.fileCrs, notes };
  }
}
