/**
 * The land cover classification dialog (from the processing dialog): an
 * image's bands put in classes, either automatically (k-means: give how many
 * classes) or from training polygons (a polygon layer and the attribute that
 * names each polygon's class). The classes open as a new layer in their
 * colors; the dialog then lists each class with its color, pixels and area,
 * saved as CSV, and the class numbers can be saved as a GeoTIFF. The classes
 * can also be outlined as a temporary polygon layer.
 */
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import type OlMap from 'ol/Map.js';
import { getTransform } from 'ol/proj.js';
import { fromBlob } from 'geotiff';
import type { EnhancedGeoTIFF, LoadImageControl } from 'browser-image-enhancement/openlayers';
import { tiffOf } from './composite-dialog.js';
import { formatArea, geodesicArea } from './geodesic.js';
import { baseName, type ImageList, type ViewerImage, type ViewerService } from './images.js';
import { polygonize } from './mask-polygons.js';
import { field, type ProcessingResult } from './processing/common.js';
import { MAX_CLASSES, planClassify, runClassify, type ClassifyOutput, type ClassSummary, type TrainingClass } from './classify-run.js';
import type { ClassifierKind } from './classify.js';
import type { LonLat } from './coordinates.js';
import { saveFile } from './save-folder.js';

/** Most pixels the outlines are traced over (the classes are read reduced to this). */
const MAX_TRACE_PIXELS = 4_000_000;
/** Most polygons kept (the largest). */
const MAX_POLYGONS = 20_000;

export interface ClassifyDialogOptions {
  say: (message: string) => void;
  /** Opens the result like a chosen file; default: the loader opens it as it is. */
  open?: (file: File) => Promise<EnhancedGeoTIFF | null>;
  /** Adds the outlines of the classes as a temporary layer. */
  onPolygons?: (result: ProcessingResult, made: string) => Promise<void>;
}

/** A layer with polygons to train on. */
function polygonLayers(images: ImageList): ViewerService[] {
  return images.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector && l.service.vector.source.getFeatures().some((f) => polygonsOf(f).length > 0));
}

/** The polygons of a feature (`[[x, y], …]` rings), in the map's projection. */
function polygonsOf(feature: Feature): Array<Array<Array<[number, number]>>> {
  const g = feature.getGeometry();
  if (g instanceof Polygon) return [g.getCoordinates() as Array<Array<[number, number]>>];
  if (g instanceof MultiPolygon) return g.getCoordinates() as Array<Array<Array<[number, number]>>>;
  return [];
}

/**
 * The training classes of a polygon layer: one per value of `fieldName`
 * (in order of first appearance), its polygons moved into `to`.
 */
export function trainingOf(features: readonly Feature[], fieldName: string, transform: (xy: [number, number]) => [number, number]): TrainingClass[] {
  const classes = new Map<string, TrainingClass>();
  for (const f of features) {
    const polygons = polygonsOf(f);
    const value = f.get(fieldName);
    if (!polygons.length || value === undefined || value === null || value === '') continue;
    const name = String(value);
    let c = classes.get(name);
    if (!c) {
      c = { name, polygons: [] };
      classes.set(name, c);
    }
    for (const rings of polygons) c.polygons.push(rings.map((ring) => ring.map(transform)));
  }
  return [...classes.values()];
}

/** The class table as CSV (UTF-8 with BOM, for Excel). */
export function classCsv(classes: readonly ClassSummary[]): string {
  const total = classes.reduce((s, c) => s + c.area, 0);
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = classes.map((c, i) => [String(i + 1), quote(c.name), `#${c.color.map((v) => v.toString(16).padStart(2, '0')).join('')}`, String(c.pixels), (c.area / 1e6).toFixed(6), total ? ((100 * c.area) / total).toFixed(2) : '0'].join(','));
  return `\ufeff番号,クラス,色,画素数,面積_km2,割合_%\n${rows.join('\n')}\n`;
}

export class ClassifyDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly image_: HTMLSelectElement;
  private readonly bands_: HTMLElement;
  private readonly layer_: HTMLSelectElement;
  private readonly field_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly plan_: HTMLElement;
  private readonly result_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly made_ = new WeakMap<ViewerImage, ClassifyOutput>();
  private images_: ViewerImage[] = [];
  private layers_: ViewerService[] = [];
  private last_: { image: ViewerImage; output: ClassifyOutput } | null = null;
  private running_: { cancelled: boolean } | null = null;

  constructor(
    private readonly images: ImageList,
    private readonly loader: LoadImageControl,
    private readonly map: OlMap,
    private readonly options: ClassifyDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog classify-dialog';
    this.dialog.setAttribute('aria-labelledby', 'classify-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="classify-title">土地被覆分類</h2>
        <p class="wide processing-hint">画像の画素を、色（バンドの値）の似たものどうしのクラスに分けて色分けし、クラスごとの面積を求めます。</p>
        <label class="wide">画像<select name="image" aria-label="分類する画像"></select></label>
        <fieldset class="wide classify-method">
          <legend>分け方</legend>
          <label class="check"><input type="radio" name="method" value="kmeans" checked /><span>自動（教師なし）: クラスの数だけ決める</span></label>
          <label class="check"><input type="radio" name="method" value="supervised" /><span>学習ポリゴン（教師あり）: 描いた見本に合わせる</span></label>
        </fieldset>
        <label class="wide classify-kmeans">クラスの数<input name="classes" type="number" min="2" max="${MAX_CLASSES}" step="1" value="6" aria-label="クラスの数" /></label>
        <div class="wide classify-supervised service-form" hidden>
          <label class="wide">学習用のレイヤー<select name="layer" aria-label="学習用のレイヤー"></select></label>
          <label class="wide">クラス名の属性<select name="field" aria-label="クラス名の属性"></select></label>
          <label class="wide">分類方法<select name="classifier" aria-label="分類方法"><option value="likelihood">最尤法（ばらつきも見る・おすすめ）</option><option value="distance">最短距離法（平均だけを見る）</option></select></label>
          <p class="wide processing-hint">見本のポリゴンは「ツール → 新規レイヤー…」で描けます。クラス名を入れる属性を作り、クラスごとに数か所ずつ囲んでください。</p>
        </div>
        <label class="wide check"><input name="outline" type="checkbox" /><span>クラスごとにポリゴンにする</span></label>
        <details class="wide composite-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <div class="wide classify-bands" role="group" aria-label="使うバンド"></div>
            <label>最小の大きさ（画素）<input name="minPixels" type="number" min="1" step="1" value="9" aria-label="最小の大きさ" /></label>
          </div>
        </details>
        <p class="wide processing-hint composite-plan"></p>
      </form>
      <div class="classify-result" hidden></div>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="csv" hidden>表を CSV 保存</button>
        <button type="button" value="save" hidden>クラス番号を GeoTIFF 保存</button>
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    const el = (name: string) => this.form_.elements.namedItem(name) as HTMLSelectElement;
    this.image_ = el('image');
    this.layer_ = el('layer');
    this.field_ = el('field');
    this.bands_ = this.dialog.querySelector('.classify-bands')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.plan_ = this.dialog.querySelector('.composite-plan')!;
    this.result_ = this.dialog.querySelector('.classify-result')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.dialog.querySelector('button[value=save]')!.addEventListener('click', () => this.save());
    this.dialog.querySelector('button[value=csv]')!.addEventListener('click', () => this.saveCsv());
    this.run_.addEventListener('click', () => void this.run());
    this.image_.addEventListener('change', () => {
      this.showBands_();
      this.describe_();
    });
    this.layer_.addEventListener('change', () => {
      this.showFields_();
      this.describe_();
    });
    this.form_.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).name === 'method') this.showMethod_();
      this.describe_();
    });
    this.dialog.addEventListener('close', () => {
      if (this.running_) this.running_.cancelled = true;
    });
  }

  /** Opens the dialog with the selected image (else the top one). */
  open(): void {
    this.images_ = [...this.images.list()].filter((i) => tiffOf(i) && !this.made_.has(i));
    this.image_.replaceChildren(...this.images_.map((image, i) => new Option(image.name, String(i))));
    const selected = this.images.selected();
    const at = selected ? this.images_.indexOf(selected) : -1;
    this.image_.value = String(Math.max(0, at));
    this.layers_ = polygonLayers(this.images);
    this.layer_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    this.note_.textContent = this.images_.length ? '' : '分類する画像（GeoTIFF）を開いてください';
    this.showResult_(selected && this.made_.has(selected) ? { image: selected, output: this.made_.get(selected)! } : null);
    this.showBands_();
    this.showFields_();
    this.showMethod_();
    this.dialog.showModal();
  }

  /** Whether `image` is a classification made here. */
  isResult(image: ViewerImage): boolean {
    return this.made_.has(image);
  }

  /** Saves the class numbers of a classification (default: the last one) as a GeoTIFF. */
  async save(): Promise<void> {
    const last = this.last_;
    if (!last) return;
    await saveFile(`${baseName(last.image.name)}_番号.tif`, last.output.classBlob, this.options.say);
  }

  /** Saves the class table as CSV. */
  async saveCsv(): Promise<void> {
    const last = this.last_;
    if (!last) return;
    await saveFile(`${baseName(last.image.name)}.csv`, new Blob([classCsv(last.output.classes)], { type: 'text/csv' }), this.options.say);
  }

  private selectedImage_(): ViewerImage | null {
    return this.images_[Number(this.image_.value)] ?? null;
  }

  private method_(): 'kmeans' | 'supervised' {
    return new FormData(this.form_).get('method') === 'supervised' ? 'supervised' : 'kmeans';
  }

  private bandsChosen_(): number[] {
    return [...this.bands_.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].filter((b) => b.checked).map((b) => Number(b.value));
  }

  private showBands_(): void {
    const image = this.selectedImage_();
    const count = image?.source.getValueBandCount() ?? 0;
    const labels = Array.from({ length: count }, (_, b) => {
      const label = document.createElement('label');
      label.className = 'check';
      label.innerHTML = `<input type="checkbox" value="${b}" checked /><span>バンド ${b + 1}</span>`;
      return label;
    });
    this.bands_.replaceChildren(...labels);
    // The bands' names (GDAL's DESCRIPTION), when the file has them.
    void image?.source
      .getBandNames()
      .then((names) => names.forEach((name, b) => name && labels[b] && (labels[b].querySelector('span')!.textContent = `${b + 1}: ${name}`)))
      .catch(() => {});
  }

  private showFields_(): void {
    const layer = this.layers_[Number(this.layer_.value)];
    const fields = layer?.service.vector?.fields.filter((f) => f.type === 'string' || f.type === 'integer') ?? [];
    this.field_.replaceChildren(...fields.map((f) => new Option(f.alias || f.name, f.name)));
    // A field that looks like a class name, else the first text field.
    const guess = fields.find((f) => /class|クラス|分類|種別|label|name|名/i.test(`${f.name} ${f.alias}`)) ?? fields.find((f) => f.type === 'string');
    if (guess) this.field_.value = guess.name;
  }

  private showMethod_(): void {
    const supervised = this.method_() === 'supervised';
    this.dialog.querySelector<HTMLElement>('.classify-kmeans')!.hidden = supervised;
    this.dialog.querySelector<HTMLElement>('.classify-supervised')!.hidden = !supervised;
    this.describe_();
  }

  /** The training classes chosen, in `image`'s projection. */
  private training_(image: ViewerImage): TrainingClass[] {
    const layer = this.layers_[Number(this.layer_.value)];
    const projection = image.source.getProjection();
    if (!layer?.service.vector || !projection || !this.field_.value) return [];
    const to = getTransform(this.map.getView().getProjection(), projection);
    return trainingOf(layer.service.vector.source.getFeatures(), this.field_.value, (xy) => to(xy) as [number, number]);
  }

  private describe_(): void {
    const image = this.selectedImage_();
    this.run_.disabled = true;
    if (!image) return void (this.plan_.textContent = '');
    try {
      const bands = this.bandsChosen_();
      const { grid } = planClassify(image, bands);
      let what = `${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px（${bands.length} バンド）を`;
      if (this.method_() === 'supervised') {
        if (!this.layers_.length) throw new Error('学習用のポリゴンのレイヤーがありません（「ツール → 新規レイヤー…」で描けます）');
        if (!this.field_.value) throw new Error('クラス名を入れた属性（文字か整数）がありません');
        const training = this.training_(image);
        if (training.length < 2) throw new Error(`クラスが ${training.length} つしかありません（属性の値が 2 種類以上必要です）`);
        if (training.length > MAX_CLASSES) throw new Error(`クラスが ${training.length} あります（${MAX_CLASSES} までです）`);
        what += ` ${training.map((t) => t.name).join('・')} の ${training.length} クラスに分けます。`;
      } else {
        what += ` ${Number(new FormData(this.form_).get('classes')) || 6} クラスに自動で分けます。`;
      }
      this.plan_.textContent = what;
      this.run_.disabled = false;
    } catch (error) {
      this.plan_.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  /** Classifies; the classes open as a layer, the table shows in the dialog. */
  async run(): Promise<ViewerImage | null> {
    const image = this.selectedImage_();
    if (!image) return null;
    const form = new FormData(this.form_);
    const bands = this.bandsChosen_();
    const supervised = this.method_() === 'supervised';
    this.run_.disabled = true;
    const control = { cancelled: false };
    this.running_ = control;
    try {
      this.note_.textContent = '分類しています… 0%';
      const output = await runClassify({
        image,
        bands,
        method: supervised
          ? { kind: 'supervised', classifier: (form.get('classifier') as ClassifierKind) || 'likelihood', training: this.training_(image) }
          : { kind: 'kmeans', classes: Math.round(Number(form.get('classes')) || 6) },
        control,
        onProgress: (pass, done) => {
          if (control.cancelled) return;
          // The first pass reads a sample (or only the training areas): a third of the work.
          this.note_.textContent = `分類しています… ${Math.floor(pass === 1 ? done * 33 : 33 + done * 67)}%`;
        },
      });
      const name = `${baseName(image.name)}_分類.tif`.slice(-120);
      this.note_.textContent = '結果を開いています…';
      const file = new File([output.colorBlob], name, { type: 'image/tiff' });
      const source = this.options.open ? await this.options.open(file) : await this.loader.loadFile(file, name);
      const made = source && this.images.find(source);
      if (!made) return null;
      this.made_.set(made, output);
      this.images.setBadge(made, '分類');
      let outlined = '';
      if (form.has('outline')) {
        const count = await this.outline_(output, made.name, Math.max(1, Math.round(Number(form.get('minPixels')) || 1)));
        outlined = `、ポリゴン ${count.toLocaleString()} 個`;
      }
      this.showResult_({ image: made, output });
      this.note_.textContent = `${name} を作りました${outlined}`;
      this.options.say(`${name} を作りました（${output.classes.length} クラス）${outlined}`);
      return made;
    } catch (error) {
      if (control.cancelled) this.options.say('分類を中止しました');
      else this.note_.textContent = `分類できませんでした: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      this.running_ = null;
      this.run_.disabled = false;
    }
  }

  /** The class table under the form (null: none). */
  private showResult_(last: { image: ViewerImage; output: ClassifyOutput } | null): void {
    this.last_ = last;
    this.result_.hidden = !last;
    for (const v of ['csv', 'save']) this.dialog.querySelector<HTMLButtonElement>(`button[value=${v}]`)!.hidden = !last;
    if (!last) return this.result_.replaceChildren();
    const classes = last.output.classes;
    const total = classes.reduce((s, c) => s + c.area, 0);
    const table = document.createElement('table');
    table.className = 'classify-table';
    table.innerHTML = '<thead><tr><th>クラス</th><th>画素数</th><th>面積</th><th>割合</th></tr></thead><tbody></tbody>';
    const body = table.tBodies[0];
    for (const c of classes) {
      const row = body.insertRow();
      const name = row.insertCell();
      const swatch = document.createElement('span');
      swatch.className = 'classify-swatch';
      swatch.style.background = `rgb(${c.color.join(',')})`;
      name.append(swatch, c.name);
      row.insertCell().textContent = c.pixels.toLocaleString();
      row.insertCell().textContent = formatArea(c.area);
      row.insertCell().textContent = total ? `${((100 * c.area) / total).toFixed(1)}%` : '';
    }
    this.result_.replaceChildren(table);
  }

  /** Outlines the classes as a temporary layer; resolves to how many polygons. */
  private async outline_(output: ClassifyOutput, title: string, minPixels: number): Promise<number> {
    const { grid, projection } = output.plan;
    const tiff = await (await fromBlob(output.classBlob)).getImage();
    const scale = Math.max(1, Math.sqrt((grid.width * grid.height) / MAX_TRACE_PIXELS));
    const width = Math.max(1, Math.round(grid.width / scale));
    const height = Math.max(1, Math.round(grid.height / scale));
    const [values] = (await tiff.readRasters({ width, height, samples: [0], resampleMethod: 'nearest' })) as unknown as Uint8Array[];
    const sx = grid.width / width;
    const sy = grid.height / height;
    const toMap3857 = getTransform(projection, 'EPSG:3857');
    const toWgs84 = getTransform('EPSG:3857', 'EPSG:4326');
    const toMap = (x: number, y: number): [number, number] => toMap3857([grid.origin[0] + x * sx * grid.resolution[0], grid.origin[1] + y * sy * grid.resolution[1]]) as [number, number];
    const toLonLat = (xy: [number, number]) => toWgs84(xy) as LonLat;
    const features: Feature[] = [];
    let truncated = false;
    const mask = new Uint8Array(width * height);
    output.classes.forEach((c, k) => {
      for (let i = 0; i < mask.length; i++) mask[i] = values[i] === k + 1 ? 1 : 0;
      const room = MAX_POLYGONS - features.length;
      if (room <= 0) return void (truncated = true);
      const polygons = polygonize(mask, width, height, { minPixels: Math.max(1, Math.round(minPixels / (sx * sy))), maxPolygons: room + 1 });
      if (polygons.length > room) {
        truncated = true;
        polygons.length = room;
      }
      for (const p of polygons) {
        const rings = p.rings.map((ring) => {
          const out = ring.map(([x, y]) => toMap(x, y));
          out.push(out[0]);
          return out;
        });
        let area = geodesicArea(rings[0].slice(0, -1).map(toLonLat)).area;
        for (const hole of rings.slice(1)) area -= geodesicArea(hole.slice(0, -1).map(toLonLat)).area;
        features.push(new Feature({ geometry: new Polygon(rings), クラス: c.name, 番号: k + 1, 面積_m2: Math.round(area * 10) / 10, 画素数: Math.round(p.pixels * sx * sy) }));
      }
    });
    await this.options.onPolygons?.(
      {
        title: `${baseName(title)} のクラス`,
        features,
        fields: [field('クラス', 'string'), field('番号', 'integer'), field('面積_m2', 'double', '面積（m²）'), field('画素数', 'integer')],
        notes: truncated ? [`${MAX_POLYGONS.toLocaleString()} 個まで`] : [],
      },
      `クラスのポリゴン ${features.length} 個`,
    );
    return features.length;
  }
}
