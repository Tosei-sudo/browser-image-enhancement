/**
 * The "export" dialog of a vector layer (WFS, Esri, or a file): writes its
 * features (all, or the selected ones) to GeoJSON, a Shapefile (.zip), a
 * GeoPackage, FlatGeobuf, KML / KMZ or GPX, in WGS 84, Web Mercator or the layer's own CRS, and hands the
 * file over as a download. Unsaved edits are included: it writes what the
 * map shows. The layer's style goes with Shapefiles and GeoPackages (as
 * QGIS keeps styles), so QGIS and the viewer draw them the same way.
 */
import type Feature from 'ol/Feature.js';
import { download } from './local-edit.js';
import type { ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { VectorStyleSpec } from './vector-style.js';
import { writeFgb, writeGpx, writeKml, writeKmz } from './vector-formats.js';
import { webMercator, wgs84, writeGeoJson, writeGeoPackage, writeShapefile, zipFiles, type TargetCrs } from './vector-write.js';

/** The formats a layer can be written to. */
export type ExportFormat = 'geojson' | 'shapefile' | 'geopackage' | 'kml' | 'kmz' | 'gpx' | 'fgb';

/** Formats that are WGS 84 by definition (the CRS choice does not apply). */
const LON_LAT_ONLY: readonly ExportFormat[] = ['kml', 'kmz', 'gpx'];

/** A file name made of a layer title: no characters file systems refuse. */
export function safeName(title: string): string {
  const name = [...title].map((c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? '_' : c)).join('');
  return name.trim() || 'layer';
}

/** The file of `features` in `format`: its name and bytes; with `style` where the format keeps one (not GeoJSON). */
export async function exportFile(
  title: string,
  features: Feature[],
  fields: Parameters<typeof writeGeoJson>[1],
  format: ExportFormat,
  crs: TargetCrs,
  style?: VectorStyleSpec,
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> | string; type: string }> {
  const name = safeName(title);
  if (format === 'geojson') return { name: `${name}.geojson`, bytes: writeGeoJson(features, fields, crs), type: 'application/geo+json' };
  if (format === 'shapefile') return { name: `${name}.zip`, bytes: zipFiles(writeShapefile(name, features, fields, crs, style)), type: 'application/zip' };
  if (format === 'kml') return { name: `${name}.kml`, bytes: writeKml(features, fields), type: 'application/vnd.google-earth.kml+xml' };
  if (format === 'kmz') return { name: `${name}.kmz`, bytes: writeKmz(features, fields), type: 'application/vnd.google-earth.kmz' };
  if (format === 'gpx') return { name: `${name}.gpx`, bytes: writeGpx(features, fields).text, type: 'application/gpx+xml' };
  if (format === 'fgb') return { name: `${name}.fgb`, bytes: writeFgb(name, features, fields, crs), type: 'application/octet-stream' };
  return { name: `${name}.gpkg`, bytes: await writeGeoPackage(name, features, fields, crs, style), type: 'application/geopackage+sqlite3' };
}

/** The style a layer is written with: none for the service's own drawing, which the viewer cannot describe. */
export function exportStyle(entry: ViewerService): VectorStyleSpec | undefined {
  const spec = entry.service.style?.get();
  return spec && spec.mode !== 'own' ? spec : undefined;
}

export class ExportDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly crs_: HTMLSelectElement;
  private readonly selected_: HTMLInputElement;
  private readonly withStyle_: HTMLInputElement;
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
          <option value="fgb">FlatGeobuf（.fgb）</option>
          <option value="kml">KML（.kml、Google Earth）</option>
          <option value="kmz">KMZ（.kmz、Google Earth）</option>
          <option value="gpx">GPX（.gpx、GPS）</option>
        </select></label>
        <label>座標系<select name="crs" aria-label="座標系"></select></label>
        <label class="wide check"><input name="selected" type="checkbox" /><span>選択中の地物だけ</span></label>
        <label class="wide check"><input name="withStyle" type="checkbox" checked /><span>スタイルも保存（QGIS でも同じ見た目で表示可能）</span></label>
      </form>
      <p class="service-status export-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="export" class="primary">書き出し</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.crs_ = this.form_.elements.namedItem('crs') as HTMLSelectElement;
    this.selected_ = this.form_.elements.namedItem('selected') as HTMLInputElement;
    this.withStyle_ = this.form_.elements.namedItem('withStyle') as HTMLInputElement;
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
    this.options.say(`${entry.name} を書き出し中…`);
    try {
      const style = this.withStyle_.checked ? exportStyle(entry) : undefined;
      const file = await exportFile(entry.name, features, vector.fields, format, crs, style);
      download(file.name, file.bytes, file.type);
      this.options.say(`${features.length.toLocaleString()} 件を ${file.name} に書き出し`);
    } catch (error) {
      this.options.say(`書き出し失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private selectedOf_(entry: ViewerService): Feature[] {
    const source = entry.service.vector?.source;
    return source ? this.selection.list().filter((f) => source.hasFeature(f)) : [];
  }

  private update_(): void {
    const format = (this.form_.elements.namedItem('format') as HTMLSelectElement).value as ExportFormat;
    // Only Shapefiles and GeoPackages keep a style, and a service's own drawing cannot be written.
    this.withStyle_.closest('label')!.hidden = !(format === 'shapefile' || format === 'geopackage') || !this.entry_ || !exportStyle(this.entry_);
    // KML and GPX are always WGS 84.
    if (LON_LAT_ONLY.includes(format)) this.crs_.value = '0';
    this.crs_.disabled = LON_LAT_ONLY.includes(format);
    const notes: string[] = [];
    if (this.entry_?.service.vector?.truncated) notes.push('このレイヤーは先頭 5 万件だけ読み込み中。書き出し対象も読み込んだ地物のみ');
    if (this.entry_?.service.vector?.note) notes.push('このレイヤーは表示範囲の地物だけを（縮小時は間引いて）読み込み中。書き出し対象も読み込んだ地物のみ');
    if (format === 'shapefile') notes.push('属性名は 10 バイトまでに切り詰め、文字は UTF-8（.cpg 付き）で書き込み。点・線・面が混在する場合は種類ごとに別の Shapefile');
    if (format === 'geojson' && this.crs_.value !== '0') notes.push('WGS 84 以外の GeoJSON は標準外（古い crs 指定を付与）');
    if (format === 'kml' || format === 'kmz') notes.push('KML は WGS 84 で書き込み。name・description は KML の名前・説明に、ほかの属性は ExtendedData に格納');
    if (format === 'gpx') notes.push('GPX は WGS 84 で、点はウェイポイント、線はトラック（面は書き込み不可のため除外）。属性は name・desc・ele・time のみ保持');
    this.note_.textContent = notes.join('。');
  }
}
