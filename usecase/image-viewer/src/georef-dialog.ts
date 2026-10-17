/**
 * 「投影を設定」: a CRS and a placement for an image without a projection
 * (or with coordinates in no known CRS): from a world file (.tfw, .jgw,
 * .pgw…), the extent, the four corners (rotation allowed), or the image's own
 * coordinates. Opened from the ⌖ button of such an image's row, from
 * プロセッシング for any image opened from a file, and when an image comes
 * with half a placement (a world file without a CRS). Saved in projects.
 */
import type { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';
import type { ImageList, ViewerImage } from './images.js';
import { crsPresets } from './processing/reproject.js';
import { originOf } from './open-files.js';
import {
  cornersTransform,
  crsLabel,
  crsProjection,
  extentTransform,
  isAuxXmlName,
  looksLikeDegrees,
  normalizeCrs,
  parseAuxXml,
  parseWorldFile,
  transformCorners,
  type Georef,
  type GeorefMethod,
  type SideGeoref,
} from './georef.js';

export interface GeorefDialogOptions {
  /** Places `image` by `georef` (null: back to no projection); throws with a message for the person. */
  apply: (image: ViewerImage, georef: Georef | null) => Promise<void>;
  say: (message: string) => void;
}

/** The placement methods offered, in order. */
const methods: Array<{ value: GeorefMethod; label: string }> = [
  { value: 'worldfile', label: 'ワールドファイル（.tfw・.jgw・.pgw など）' },
  { value: 'extent', label: '範囲（左・下・右・上の座標）' },
  { value: 'corners', label: '四隅の座標（回転・ゆがみも可）' },
  { value: 'keep', label: '画像の座標をそのまま使う（座標系だけ設定）' },
];

/** Where the last CRS chosen is remembered. */
const LAST_CRS = 'image-viewer:georef-crs';

const number = (v: number) => String(Math.round(v * 1e9) / 1e9);

export class GeorefDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly image_: HTMLSelectElement;
  private readonly crs_: HTMLInputElement;
  private readonly crsNote_: HTMLElement;
  private readonly method_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly clear_: HTMLButtonElement;
  private readonly apply_: HTMLButtonElement;
  private images_: ViewerImage[] = [];
  /** The GeoTransform read from a world file (or .aux.xml), and its name. */
  private world_: { transform: number[]; from: string; method: GeorefMethod } | null = null;
  private busy_ = false;

  constructor(
    private readonly images: ImageList,
    private readonly options: GeorefDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog georef-dialog';
    this.dialog.setAttribute('aria-labelledby', 'georef-title');
    const xy = (name: string, label: string) =>
      `<span class="georef-xy" role="group" aria-label="${label}"><span>${label}</span><input name="${name}-x" type="text" inputmode="decimal" placeholder="X（東）" aria-label="${label} X" /><input name="${name}-y" type="text" inputmode="decimal" placeholder="Y（北）" aria-label="${label} Y" /></span>`;
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="georef-title">投影を設定</h2>
        <label class="wide">画像<select name="image" aria-label="画像"></select></label>
        <label class="wide">座標系<input name="crs" type="text" list="georef-crs-list" placeholder="EPSG:6677 など（コードか名前で選ぶ）" aria-label="座標系" autocomplete="off" /></label>
        <datalist id="georef-crs-list">${crsPresets.map((p) => `<option value="${p.code}" label="${p.name}">${p.name}</option>`).join('')}</datalist>
        <p class="wide processing-hint georef-crs-note"></p>
        <label class="wide">配置<select name="method" aria-label="配置">${methods.map((m) => `<option value="${m.value}">${m.label}</option>`).join('')}</select></label>
        <div class="wide georef-part" data-method="worldfile">
          <label class="wide">ファイル<input name="world" type="file" accept=".tfw,.tifw,.jgw,.jpgw,.pgw,.pngw,.gfw,.bpw,.j2w,.wld,.xml" aria-label="ワールドファイル" /></label>
          <p class="processing-hint georef-world"></p>
        </div>
        <div class="wide georef-part georef-grid" data-method="extent">
          <label>左（西）<input name="west" type="text" inputmode="decimal" aria-label="左" /></label>
          <label>下（南）<input name="south" type="text" inputmode="decimal" aria-label="下" /></label>
          <label>右（東）<input name="east" type="text" inputmode="decimal" aria-label="右" /></label>
          <label>上（北）<input name="north" type="text" inputmode="decimal" aria-label="上" /></label>
        </div>
        <div class="wide georef-part" data-method="corners">
          ${xy('tl', '左上')}${xy('tr', '右上')}${xy('br', '右下')}${xy('bl', '左下')}
          <p class="processing-hint">画像の四隅が来る座標です。3 点以上あれば配置できます（4 点なら最小二乗で合わせます）。</p>
        </div>
        <div class="wide georef-part" data-method="keep">
          <p class="processing-hint georef-own"></p>
        </div>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="clear">投影を外す</button>
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="apply" class="primary">適用</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const field = <T extends Element>(name: string) => this.form_.elements.namedItem(name) as unknown as T;
    this.image_ = field('image');
    this.crs_ = field('crs');
    this.method_ = field('method');
    this.crsNote_ = this.dialog.querySelector('.georef-crs-note')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.clear_ = this.dialog.querySelector('button[value=clear]')!;
    this.apply_ = this.dialog.querySelector('button[value=apply]')!;
    this.form_.addEventListener('submit', (e) => e.preventDefault());
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.apply_.addEventListener('click', () => void this.run_(false));
    this.clear_.addEventListener('click', () => void this.run_(true));
    this.image_.addEventListener('change', () => this.show_(null));
    this.method_.addEventListener('change', () => this.showMethod_());
    this.crs_.addEventListener('change', () => void this.checkCrs_());
    field<HTMLInputElement>('world').addEventListener('change', (e) => void this.readWorld_((e.target as HTMLInputElement).files?.[0] ?? null));
  }

  /** Images whose projection can be set: those opened from a file. */
  candidates(): ViewerImage[] {
    return this.images.list().filter((i) => !!originOf(i.source));
  }

  /**
   * Opens the dialog on `image` (default: the selected image, else the first
   * without a projection), with what side files gave (`side`) filled in.
   */
  open(image: ViewerImage | null = this.images.selected(), side: SideGeoref | null = null): void {
    this.images_ = this.candidates();
    this.image_.replaceChildren(...this.images_.map((i, n) => new Option(i.name, String(n))));
    const chosen = image && this.images_.includes(image) ? image : (this.images_.find((i) => originOf(i.source)?.unplaced) ?? this.images_[0]);
    if (chosen) this.image_.value = String(this.images_.indexOf(chosen));
    this.show_(side);
    this.note_.textContent = this.images_.length ? '' : 'ファイルから開いた画像がありません';
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Opens the dialog on the image of `source`, with what its side files gave. */
  openFor(source: EnhancedGeoTIFF, side: SideGeoref): void {
    this.open(this.images.find(source), side);
  }

  private chosen_(): ViewerImage | null {
    return this.images_[Number(this.image_.value)] ?? null;
  }

  /** The form shows the chosen image's placement, or what `side` gave. */
  private show_(side: SideGeoref | null): void {
    const image = this.chosen_();
    const origin = image ? originOf(image.source) : null;
    const set = origin?.georef ?? null;
    this.world_ = side?.transform ? { transform: side.transform, from: side.from, method: side.method } : set && (set.method === 'worldfile' || set.method === 'aux') ? { transform: set.transform, from: set.from ?? '', method: set.method } : null;
    const keep = this.method_.querySelector<HTMLOptionElement>('option[value=keep]')!;
    keep.hidden = keep.disabled = !origin?.own;
    this.dialog.querySelector('.georef-own')!.textContent = origin?.own ? `画像の左上 ${number(origin.own[0])}, ${number(origin.own[3])}、画素の大きさ ${number(origin.own[1])} × ${number(-origin.own[5])}` : '';
    const field = (name: string) => this.form_.elements.namedItem(name) as HTMLInputElement;
    (this.form_.elements.namedItem('world') as HTMLInputElement).value = '';
    for (const name of ['west', 'south', 'east', 'north', 'tl-x', 'tl-y', 'tr-x', 'tr-y', 'br-x', 'br-y', 'bl-x', 'bl-y']) field(name).value = '';
    // The placement as set, in each method's terms.
    const transform = set?.transform ?? this.world_?.transform ?? origin?.own ?? null;
    if (transform && origin && origin.width) {
      const corners = transformCorners(transform, origin.width, origin.height);
      ['tl', 'tr', 'br', 'bl'].forEach((c, i) => {
        field(`${c}-x`).value = number(corners[i][0]);
        field(`${c}-y`).value = number(corners[i][1]);
      });
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      field('west').value = number(Math.min(...xs));
      field('south').value = number(Math.min(...ys));
      field('east').value = number(Math.max(...xs));
      field('north').value = number(Math.max(...ys));
    }
    this.method_.value = side?.transform ? 'worldfile' : (set?.method === 'aux' ? 'worldfile' : set?.method) ?? (origin?.own ? 'keep' : 'worldfile');
    let crs = side?.crs ?? set?.crs ?? null;
    if (!crs && transform && origin?.width && looksLikeDegrees(transform, origin.width, origin.height)) crs = 'EPSG:4326';
    if (!crs) {
      try {
        crs = localStorage.getItem(LAST_CRS);
      } catch {
        crs = null;
      }
    }
    this.crs_.value = crs ?? '';
    this.clear_.hidden = !set;
    this.showWorld_();
    this.showMethod_();
    void this.checkCrs_();
    this.note_.textContent = '';
  }

  private showMethod_(): void {
    for (const part of this.dialog.querySelectorAll<HTMLElement>('.georef-part')) part.hidden = part.dataset.method !== this.method_.value;
  }

  private showWorld_(): void {
    const w = this.world_;
    this.dialog.querySelector('.georef-world')!.textContent = w
      ? `${w.from}: 左上 ${number(w.transform[0])}, ${number(w.transform[3])}、画素の大きさ ${number(w.transform[1])} × ${number(-w.transform[5])}${w.transform[2] || w.transform[4] ? '（回転あり）' : ''}`
      : 'ワールドファイルを選んでください';
  }

  /** Reads a chosen world file (or .aux.xml, which may also give the CRS). */
  private async readWorld_(file: File | null): Promise<void> {
    if (!file) return;
    try {
      const text = await file.text();
      if (isAuxXmlName(file.name) || /\.xml$/i.test(file.name)) {
        const aux = parseAuxXml(text);
        if (!aux.transform) throw new Error('GeoTransform がありません');
        this.world_ = { transform: aux.transform, from: file.name, method: 'aux' };
        const crs = aux.crs && normalizeCrs(aux.crs);
        if (crs) this.crs_.value = crs;
      } else {
        this.world_ = { transform: parseWorldFile(text), from: file.name, method: 'worldfile' };
      }
      this.note_.textContent = '';
      const origin = this.chosen_() ? originOf(this.chosen_()!.source) : null;
      if (!this.crs_.value && origin?.width && looksLikeDegrees(this.world_.transform, origin.width, origin.height)) this.crs_.value = 'EPSG:4326';
    } catch (error) {
      this.world_ = null;
      this.note_.textContent = `${file.name} を読めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.showWorld_();
    void this.checkCrs_();
  }

  /** Says which CRS the box names, or that it is not known. */
  private async checkCrs_(): Promise<string | null> {
    const crs = normalizeCrs(this.crs_.value);
    const note = this.crsNote_;
    if (!crs) {
      note.textContent = this.crs_.value.trim() ? 'EPSG コード（例: EPSG:6677）か WKT を入れてください' : '画像の座標の座標系を選んでください';
      return null;
    }
    const projection = await crsProjection(crs).catch(() => null);
    if (normalizeCrs(this.crs_.value) !== crs) return null;
    note.textContent = projection ? `${crsLabel(crs)}（単位: ${projection.getUnits() === 'degrees' ? '度' : 'm'}）` : `${crs} の定義が見つかりません`;
    return projection ? crs : null;
  }

  /** The placement the form describes; throws with a message for the person. */
  private async georef_(image: ViewerImage): Promise<Georef> {
    const origin = originOf(image.source);
    if (!origin) throw new Error('この画像には投影を設定できません');
    const crs = await this.checkCrs_();
    if (!crs) throw new Error(this.crsNote_.textContent || '座標系を選んでください');
    const method = this.method_.value as GeorefMethod;
    const value = (name: string) => {
      const text = (this.form_.elements.namedItem(name) as HTMLInputElement).value.trim().replace(/[−－]/g, '-').replace(/,/g, '');
      return text === '' ? NaN : Number(text);
    };
    const size = (): [number, number] => {
      if (!origin.width) throw new Error('画像の大きさが分かりません');
      return [origin.width, origin.height];
    };
    if (method === 'worldfile') {
      if (!this.world_) throw new Error('ワールドファイルを選んでください');
      return { crs, transform: this.world_.transform, method: this.world_.method, from: this.world_.from };
    }
    if (method === 'keep') {
      if (!origin.own) throw new Error('この画像には座標がありません');
      return { crs, transform: origin.own, method: 'keep' };
    }
    if (method === 'extent') {
      const extent = ['west', 'south', 'east', 'north'].map(value);
      if (!extent.every(Number.isFinite)) throw new Error('左・下・右・上の座標を数字で入れてください');
      return { crs, transform: extentTransform(extent, ...size()), method: 'extent' };
    }
    const points = ['tl', 'tr', 'br', 'bl'].map((c): [number, number] | null => {
      const p: [number, number] = [value(`${c}-x`), value(`${c}-y`)];
      return p.every(Number.isFinite) ? p : null;
    });
    return { crs, transform: cornersTransform(points, ...size()), method: 'corners' };
  }

  private async run_(clear: boolean): Promise<void> {
    const image = this.chosen_();
    if (!image || this.busy_) return;
    this.busy_ = true;
    this.apply_.disabled = this.clear_.disabled = true;
    this.note_.textContent = clear ? '投影を外しています…' : '配置しています…';
    try {
      const georef = clear ? null : await this.georef_(image);
      await this.options.apply(image, georef);
      if (georef) {
        try {
          localStorage.setItem(LAST_CRS, georef.crs.startsWith('EPSG:') ? georef.crs : '');
        } catch {
          // Not kept: the next image starts with an empty box.
        }
      }
      this.note_.textContent = georef ? `${crsLabel(georef.crs)} で配置しました` : '投影を外しました';
      this.clear_.hidden = !georef;
    } catch (error) {
      this.note_.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy_ = false;
      this.apply_.disabled = this.clear_.disabled = false;
    }
  }
}
