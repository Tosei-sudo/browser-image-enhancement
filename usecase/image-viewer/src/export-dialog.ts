/**
 * The "export" dialog of a vector layer (WFS, Esri, or a file): writes its
 * features (all, or the selected ones) to GeoJSON, a Shapefile (.zip) or a
 * GeoPackage, in WGS 84, Web Mercator or the layer's own CRS, and hands the
 * file over as a download. Unsaved edits are included: it writes what the
 * map shows.
 */
import type Feature from 'ol/Feature.js';
import { download } from './local-edit.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import { webMercator, wgs84, writeGeoJson, writeGeoPackage, writeShapefile, zipFiles, type TargetCrs } from './vector-write.js';

/** The formats a layer can be written to. */
export type ExportFormat = 'geojson' | 'shapefile' | 'geopackage';

/** A file name made of a layer title: no characters file systems refuse. */
export function safeName(title: string): string {
  const name = [...title].map((c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? '_' : c)).join('');
  return name.trim() || 'layer';
}

/** The file of `features` in `format`: its name and bytes. */
export async function exportFile(
  title: string,
  features: Feature[],
  fields: Parameters<typeof writeGeoJson>[1],
  format: ExportFormat,
  crs: TargetCrs,
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> | string; type: string }> {
  const name = safeName(title);
  if (format === 'geojson') return { name: `${name}.geojson`, bytes: writeGeoJson(features, fields, crs), type: 'application/geo+json' };
  if (format === 'shapefile') return { name: `${name}.zip`, bytes: zipFiles(writeShapefile(name, features, fields, crs)), type: 'application/zip' };
  return { name: `${name}.gpkg`, bytes: await writeGeoPackage(name, features, fields, crs), type: 'application/geopackage+sqlite3' };
}

export class ExportDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly crs_: HTMLSelectElement;
  private readonly selected_: HTMLInputElement;
  private readonly note_: HTMLElement;
  private entry_: ViewerService | null = null;
  private choices_: TargetCrs[] = [];

  constructor(
    private readonly selection: Selection,
    private readonly options: { say: (message: string) => void },
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service export-dialog';
    this.dialog.setAttribute('aria-labelledby', 'export-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="export-title">書き出し</h2>
        <label>形式<select name="format" aria-label="形式">
          <option value="geojson">GeoJSON（.geojson）</option>
          <option value="shapefile">Shapefile（.zip）</option>
          <option value="geopackage">GeoPackage（.gpkg）</option>
        </select></label>
        <label>座標系<select name="crs" aria-label="座標系"></select></label>
        <label class="wide check"><input name="selected" type="checkbox" /><span>選択中の地物だけ</span></label>
      </form>
      <p class="service-status export-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="export" class="primary">書き出す</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.crs_ = this.form_.elements.namedItem('crs') as HTMLSelectElement;
    this.selected_ = this.form_.elements.namedItem('selected') as HTMLInputElement;
    this.note_ = this.dialog.querySelector('.export-note')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=export]')!.addEventListener('click', () => void this.export());
    this.form_.addEventListener('change', () => this.update_());
  }

  /** Opens the dialog for a vector layer. */
  open(entry: ViewerService): void {
    const vector = entry.service.vector;
    if (!vector) return;
    this.entry_ = entry;
    const own = entry.service.fileCrs;
    this.choices_ = [wgs84, webMercator, ...(own && own.projection !== wgs84.projection && own.projection !== webMercator.projection ? [own] : [])];
    this.crs_.replaceChildren(...this.choices_.map((c, i) => new Option(c === own ? `元の座標系: ${c.name}` : c.name, String(i))));
    const first = this.choices_.findIndex((c) => c.projection === entry.service.exportCrs?.projection);
    this.crs_.value = String(Math.max(0, first));
    const selected = this.selectedOf_(entry).length;
    this.selected_.checked = selected > 0;
    this.selected_.disabled = selected === 0;
    this.selected_.nextElementSibling!.textContent = `選択中の地物だけ（${selected.toLocaleString()} 件）`;
    this.update_();
    this.dialog.showModal();
  }

  /** Writes the file and hands it over. */
  async export(): Promise<void> {
    const entry = this.entry_;
    const vector = entry?.service.vector;
    if (!entry || !vector) return;
    const format = (this.form_.elements.namedItem('format') as HTMLSelectElement).value as ExportFormat;
    const crs = this.choices_[Number(this.crs_.value)] ?? wgs84;
    const features = this.selected_.checked ? this.selectedOf_(entry) : vector.source.getFeatures();
    this.dialog.close();
    this.options.say(`${entry.name} を書き出しています…`);
    try {
      const file = await exportFile(entry.name, features, vector.fields, format, crs);
      download(file.name, file.bytes, file.type);
      this.options.say(`${features.length.toLocaleString()} 件を ${file.name} に書き出しました`);
    } catch (error) {
      this.options.say(`書き出せませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private selectedOf_(entry: ViewerService): Feature[] {
    const source = entry.service.vector?.source;
    return source ? this.selection.list().filter((f) => source.hasFeature(f)) : [];
  }

  private update_(): void {
    const format = (this.form_.elements.namedItem('format') as HTMLSelectElement).value;
    const notes: string[] = [];
    if (this.entry_?.service.vector?.truncated) notes.push('このレイヤーは先頭 5 万件だけ読み込んでいます。書き出すのも読み込んだ地物だけです');
    if (format === 'shapefile') notes.push('属性名は 10 バイトまでに切り詰め、文字は UTF-8（.cpg 付き）で書きます。点・線・面が混ざっていると種類ごとに別の Shapefile にします');
    if (format === 'geojson' && this.crs_.value !== '0') notes.push('WGS 84 以外の GeoJSON は標準外です（古い crs 指定を付けます）');
    this.note_.textContent = notes.join('。');
  }
}
