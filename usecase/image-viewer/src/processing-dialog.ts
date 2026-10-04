/**
 * The "processing" dialog, like a few of QGIS's processing tools: a tool, an
 * input vector layer (all its features or the selected ones) and the tool's
 * settings. The result opens as a temporary layer (see temp-layers.ts).
 */
import type Feature from 'ol/Feature.js';
import type { ViewerLayer, ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { Field } from './services/index.js';
import type { ProcessingInput, ProcessingResult } from './processing/common.js';
import { geodesicBuffer } from './processing/buffer.js';
import { pointsToLine } from './processing/points-to-line.js';
import { centroids } from './processing/centroid.js';
import { voronoi } from './processing/voronoi.js';
import { crsPresets, reproject, targetCrs } from './processing/reproject.js';
import { formatLength } from './geodesic.js';
import { xyToPoints } from './processing/xy-to-points.js';

/** The kinds of geometry a tool takes. */
type Kind = 'point' | 'line' | 'polygon' | 'table';

interface Tool {
  id: string;
  label: string;
  /** What the input layer must hold (any of). */
  takes: Kind[];
  /** The settings' form fields. */
  settings: (fields: Field[], layers: ViewerService[]) => string;
  /** Runs the tool; `made` says what was done, for the layer's information. */
  run: (input: ProcessingInput, form: FormData, layers: ViewerService[]) => Promise<{ result: ProcessingResult; made: string }>;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

/** A field choice, with "none" first. */
function fieldSelect(name: string, label: string, fields: Field[], none: string): string {
  const options = fields.filter((f) => f.type !== 'other').map((f) => `<option value="${escape(f.name)}">${escape(f.alias === f.name ? f.name : `${f.alias}（${f.name}）`)}</option>`);
  return `<label>${label}<select name="${name}" aria-label="${label}"><option value="">${none}</option>${options.join('')}</select></label>`;
}

const marginSetting = '<label>範囲の余白（%）<input name="margin" type="number" min="0" max="1000" step="1" value="10" aria-label="範囲の余白" /></label>';

/** The CRS choice of the reprojection and XY tools. */
function crsSetting(label: string, hint: string): string {
  return `
      <label class="wide">${label}<select name="preset" aria-label="${label}">${crsPresets
        .map((p) => `<option value="${escape(p.code)}">${escape(p.name)}</option>`)
        .join('')}<option value="">その他（EPSG コードを入力）</option></select></label>
      <label class="wide">EPSG コード<input name="code" type="text" placeholder="例: 6677" aria-label="EPSG コード" /></label>
      <p class="wide processing-hint">${hint}</p>`;
}

/** The CRS chosen in {@link crsSetting}. */
async function chosenCrs(form: FormData) {
  const code = ((form.get('preset') as string) || (form.get('code') as string) || '').trim();
  if (!code) throw new Error('EPSG コードを入れてください');
  return targetCrs(code);
}

export const tools: Tool[] = [
  {
    id: 'buffer',
    label: '測地線バッファ',
    takes: ['point', 'line', 'polygon'],
    settings: () => `
      <label>距離<input name="distance" type="number" step="any" value="100" required aria-label="距離" /></label>
      <label>単位<select name="unit" aria-label="単位"><option value="1">m</option><option value="1000">km</option></select></label>
      <label>円弧の細かさ（90° あたりの分割数）<input name="segments" type="number" min="1" max="90" value="16" aria-label="分割数" /></label>
      <label>線の端<select name="cap" aria-label="線の端"><option value="round">丸</option><option value="flat">平ら</option><option value="square">四角</option></select></label>
      <label class="wide check"><input name="dissolve" type="checkbox" /><span>結果を1つに融合（ディゾルブ）</span></label>
      <p class="wide processing-hint">WGS 84 楕円体上の距離で広げます（負の距離でポリゴンを縮めます）。</p>`,
    run: async (input, form) => {
      const distance = Number(form.get('distance')) * Number(form.get('unit'));
      if (!Number.isFinite(distance) || distance === 0) throw new Error('距離を入れてください');
      const result = geodesicBuffer(input, {
        distance,
        segments: Number(form.get('segments')) || 16,
        cap: form.get('cap') as 'round' | 'flat' | 'square',
        dissolve: form.has('dissolve'),
      });
      return { result, made: `測地線バッファ ${formatLength(Math.abs(distance))}${distance < 0 ? '（縮小）' : ''}${form.has('dissolve') ? '・融合' : ''}（${input.title}）` };
    },
  },
  {
    id: 'points-to-line',
    label: 'ポイント→ライン',
    takes: ['point'],
    settings: (fields) => `
      ${fieldSelect('order', '並べ替える属性（時刻など）', fields, '（並べ替えない：レイヤーの順）')}
      ${fieldSelect('group', 'ラインを分ける属性', fields, '（分けない：1本）')}`,
    run: async (input, form) => {
      const orderField = (form.get('order') as string) || null;
      const groupField = (form.get('group') as string) || null;
      const result = pointsToLine(input, { orderField, groupField });
      const how = [orderField && `${orderField} 順`, groupField && `${groupField} ごと`].filter(Boolean).join('・');
      return { result, made: `ポイント→ライン${how ? `（${how}）` : ''}（${input.title}）` };
    },
  },
  {
    id: 'centroid',
    label: 'ポリゴンの重心',
    takes: ['polygon', 'line', 'point'],
    settings: () => `
      <label class="wide check"><input name="perPart" type="checkbox" /><span>マルチポリゴンはパートごとに作る</span></label>
      <label class="wide check"><input name="inside" type="checkbox" /><span>重心が外に出る形は内側の点にする</span></label>`,
    run: async (input, form) => ({
      result: centroids(input, { perPart: form.has('perPart'), inside: form.has('inside') }),
      made: `重心${form.has('perPart') ? '（パートごと）' : ''}（${input.title}）`,
    }),
  },
  {
    id: 'voronoi',
    label: 'ボロノイ分割',
    takes: ['point'],
    settings: () => `${marginSetting}<p class="wide processing-hint">点ごとの領域（id 付き）を作ります。点の属性を引き継ぐときは「ティーセンポリゴン」を使ってください。</p>`,
    run: async (input, form) => ({
      result: voronoi(input, { margin: Number(form.get('margin')), keepAttributes: false }),
      made: `ボロノイ分割（${input.title}）`,
    }),
  },
  {
    id: 'thiessen',
    label: 'ティーセンポリゴン',
    takes: ['point'],
    settings: (_fields, layers) => `
      ${marginSetting}
      <label>切り抜くポリゴンレイヤー<select name="clip" aria-label="切り抜くポリゴンレイヤー"><option value="">（切り抜かない）</option>${layers
        .map((l, i) => (kindsOf(l).has('polygon') ? `<option value="${i}">${escape(l.name)}</option>` : ''))
        .join('')}</select></label>
      <p class="wide processing-hint">ボロノイ分割と同じ領域に、それぞれの点の属性を引き継ぎます。行政界などで切り抜けます。</p>`,
    run: async (input, form, layers) => {
      const clipLayer = form.get('clip') ? layers[Number(form.get('clip'))] : null;
      const clip = clipLayer?.service.vector?.source.getFeatures() ?? null;
      return {
        result: voronoi(input, { margin: Number(form.get('margin')), keepAttributes: true, clip }),
        made: `ティーセンポリゴン${clipLayer ? `（${clipLayer.name} で切り抜き）` : ''}（${input.title}）`,
      };
    },
  },
  {
    id: 'reproject',
    label: 'ベクター投影変換',
    takes: ['point', 'line', 'polygon'],
    settings: () => crsSetting('変換先の座標系', '結果のレイヤーはこの座標系で書き出されます（地図には重ねて表示します）。'),
    run: async (input, form) => {
      const crs = await chosenCrs(form);
      return { result: reproject(input, crs), made: `投影変換 → ${crs.name}（${input.title}）` };
    },
  },
  {
    id: 'xy',
    label: 'XY 座標からポイントを作成',
    takes: ['table', 'point', 'line', 'polygon'],
    settings: (fields) => {
      // Guess the columns by their names: x / lon / lng / 経度, y / lat / 緯度.
      const pick = (pattern: RegExp) => fields.find((f) => pattern.test(f.name))?.name ?? '';
      const select = (name: string, label: string, chosen: string) =>
        `<label>${label}<select name="${name}" aria-label="${label}">${fields
          .filter((f) => f.type !== 'other')
          .map((f) => `<option value="${escape(f.name)}"${f.name === chosen ? ' selected' : ''}>${escape(f.name)}</option>`)
          .join('')}</select></label>`;
      return `
      ${select('x', 'X（経度・東西）の列', pick(/^(x|lon|lng|long|longitude|経度|東経|x座標|easting)$/i))}
      ${select('y', 'Y（緯度・南北）の列', pick(/^(y|lat|latitude|緯度|北緯|y座標|northing)$/i))}
      ${crsSetting('値の座標系', 'X は経度または東向き（平面直角座標系の Y）、Y は緯度または北向き（平面直角座標系の X）です。結果はこの座標系で書き出されます。')}`;
    },
    run: async (input, form) => {
      const crs = await chosenCrs(form);
      const xField = form.get('x') as string;
      const yField = form.get('y') as string;
      if (!xField || !yField) throw new Error('X と Y の列を選んでください');
      return { result: xyToPoints(input, { xField, yField, crs }), made: `XY 座標からポイント（${xField}・${yField}、${crs.name}）（${input.title}）` };
    },
  },
];

/** The kinds of geometry a layer holds. */
function kindsOf(entry: ViewerService): Set<Kind> {
  const kinds = new Set<Kind>();
  for (const f of entry.service.vector?.source.getFeatures() ?? []) {
    const type = f.getGeometry()?.getType();
    if (type === 'Point' || type === 'MultiPoint') kinds.add('point');
    else if (type === 'LineString' || type === 'MultiLineString') kinds.add('line');
    else if (type === 'Polygon' || type === 'MultiPolygon') kinds.add('polygon');
    else if (!type) kinds.add('table');
    if (kinds.size === 4) break;
  }
  return kinds;
}

export interface ProcessingDialogOptions {
  /** The open layers, top first. */
  layers: () => readonly ViewerLayer[];
  /** The layer selected in the list. */
  selected: () => ViewerLayer | null;
  /** Opens a result as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  say: (message: string) => void;
}

export class ProcessingDialog {
  readonly dialog: HTMLDialogElement;
  private readonly tool_: HTMLSelectElement;
  private readonly input_: HTMLSelectElement;
  private readonly selected_: HTMLInputElement;
  private readonly settings_: HTMLElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private layers_: ViewerService[] = [];

  constructor(
    button: HTMLButtonElement,
    private readonly selection: Selection,
    private readonly options: ProcessingDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog';
    this.dialog.setAttribute('aria-labelledby', 'processing-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="processing-title">プロセッシング</h2>
        <label>処理<select name="tool" aria-label="処理">${tools.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</select></label>
        <label>入力レイヤー<select name="input" aria-label="入力レイヤー"></select></label>
        <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物だけ</span></label>
        <div class="wide processing-settings service-form"></div>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    const form = this.dialog.querySelector('form')!;
    this.tool_ = form.elements.namedItem('tool') as HTMLSelectElement;
    this.input_ = form.elements.namedItem('input') as HTMLSelectElement;
    this.selected_ = form.elements.namedItem('selectedOnly') as HTMLInputElement;
    this.settings_ = this.dialog.querySelector('.processing-settings')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.tool_.addEventListener('change', () => this.update_());
    this.input_.addEventListener('change', () => this.update_(false));
    button.addEventListener('click', () => this.open());
  }

  /** Opens the dialog, with the selected vector layer as the input when it is one. */
  open(tool?: string): void {
    const selectedLayer = this.options.selected();
    // A table (CSV) has nothing to process but its coordinates.
    if (tool || (selectedLayer?.type === 'service' && selectedLayer.service.tableOnly)) this.tool_.value = tool ?? 'xy';
    this.note_.textContent = '';
    this.update_();
    const index = this.layers_.findIndex((l) => l === selectedLayer);
    if (index >= 0 && [...this.input_.options].some((o) => o.value === String(index))) {
      this.input_.value = String(index);
      this.update_(false);
    }
    this.dialog.showModal();
  }

  /** Runs the chosen tool on the chosen layer. */
  async run(): Promise<void> {
    const tool = tools.find((t) => t.id === this.tool_.value)!;
    const entry = this.layers_[Number(this.input_.value)];
    const vector = entry?.service.vector;
    if (!entry || !vector) {
      this.note_.textContent = `${tool.label}に使えるベクターレイヤーがありません`;
      return;
    }
    const features: Feature[] = this.selected_.checked ? this.selection.list().filter((f) => vector.source.hasFeature(f)) : vector.source.getFeatures();
    const input: ProcessingInput = { title: entry.name, features, fields: vector.fields, crs: entry.service.fileCrs };
    const form = new FormData(this.dialog.querySelector('form')!);
    this.run_.disabled = true;
    this.note_.textContent = `${tool.label}を実行しています…`;
    // Let the message show before a long computation holds the page.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    try {
      const { result, made } = await tool.run(input, form, this.layers_);
      if (!result.features.length) throw new Error(['結果が空でした', ...(result.notes ?? [])].join('。'));
      await this.options.onResult(result, made);
      this.dialog.close();
      // The tools' own "made N" notes repeat the count.
      const notes = (result.notes ?? []).filter((n) => !n.endsWith('作成しました'));
      this.options.say([`${result.title} を作成しました（${result.features.length.toLocaleString()} 件、一時レイヤー）`, ...notes].join('。'));
    } catch (error) {
      this.note_.textContent = `${tool.label}できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.run_.disabled = false;
    }
  }

  /** Fills the input layers the tool takes, and (when `tool` changed or the layer did) its settings. */
  private update_(tool = true): void {
    const chosen = tools.find((t) => t.id === this.tool_.value)!;
    this.layers_ = this.options.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector);
    if (tool) {
      const before = this.layers_[Number(this.input_.value)];
      this.input_.replaceChildren(
        ...this.layers_.flatMap((l, i) => ([...kindsOf(l)].some((k) => chosen.takes.includes(k)) ? [new Option(l.name, String(i))] : [])),
      );
      const keep = this.layers_.indexOf(before!);
      if (keep >= 0 && [...this.input_.options].some((o) => o.value === String(keep))) this.input_.value = String(keep);
    }
    const entry = this.layers_[Number(this.input_.value)];
    this.settings_.innerHTML = chosen.settings(entry?.service.vector?.fields ?? [], this.layers_);
    const selected = entry ? this.selection.list().filter((f) => entry.service.vector!.source.hasFeature(f)).length : 0;
    this.selected_.checked = selected > 0;
    this.selected_.disabled = selected === 0;
    this.selected_.nextElementSibling!.textContent = `選択中の地物だけ（${selected.toLocaleString()} 件）`;
    this.run_.disabled = !this.input_.options.length;
    this.note_.textContent = this.input_.options.length ? '' : `${chosen.label}に使える${chosen.takes.includes('line') ? '' : chosen.takes[0] === 'point' ? 'ポイントの' : ''}ベクターレイヤーを開いてください`;
  }
}
