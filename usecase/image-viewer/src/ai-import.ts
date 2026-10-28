/**
 * 「観測記録へ取り込み」 (ツール → AI, and the 観測記録 panel's 「詳細」): AI
 * results recorded as observation points (ai/results.ts) — this viewer's own
 * detections, or an AI system's elsewhere read from `config.json`'s
 * `aiResultSources` for an image opened from the image catalog (by its
 * catalog id, shown as a layer as soon as it opens).
 *
 * Light use is one click: the layer and the image are chosen by themselves,
 * classes go to the kinds of the same name and scores to 確度. Under
 * 「種別・確度の対応」 each class can be given its kind (remembered), the
 * score levels and the lowest score changed, and the activity set.
 */
import Feature from 'ol/Feature.js';
import type { ViewerImage, ViewerLayer, ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { ObservationPanel } from './observation-panel.js';
import { field, type ProcessingResult } from './processing/common.js';
import { classByName, kindOf } from './taxonomy.js';
import {
  classCounts,
  defaultScoreLevels,
  fetchResults,
  importPlan,
  resultProperties,
  type AiResultSource,
  type ImportDefaults,
  type ResultAsk,
  type ScoreLevel,
} from './ai/results.js';

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The kinds people gave classes, by class. */
const KINDS_KEY = 'image-viewer.ai-class-kinds';

export interface AiImportOptions {
  sources: AiResultSource[];
  defaults: ImportDefaults;
  observations: ObservationPanel;
  layers: () => readonly ViewerLayer[];
  selected: () => ViewerLayer | null;
  /** The open images, and the catalog id of one opened from the catalog. */
  images: () => readonly ViewerImage[];
  catalogId: (image: ViewerImage) => string | null;
  /** The image's short name and acquisition time. */
  imageInfo: (image: ViewerImage) => Promise<{ name: string; time: number | null }>;
  ask: ResultAsk;
  /** Opens results as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  say: (message: string) => void;
}

/** The fields of a layer of AI results read from a source. */
export const resultFields = () => [
  field('class', 'string', 'クラス'),
  field('score', 'double', 'スコア'),
  field('model', 'string', 'モデル'),
  field('image', 'string', '画像'),
  field('image_id', 'string', '画像ID'),
  field('image_time', 'date', '撮像日時'),
  field('detected_at', 'date', '検出日時'),
  field('length', 'double', '長さ（m）'),
  field('heading', 'double', '向き（°）'),
  field('note', 'string', '備考'),
  field('source', 'string', '取得元'),
  field('result_id', 'string', '結果ID'),
];

/** The title of a source's layer for an image. */
export const resultTitle = (source: AiResultSource, imageId: string) => `AI 結果 ${source.label}（${imageId}）`;

/** Whether a layer holds AI results: this viewer's AI layers, and those read from a source (both have a class). */
const isAiLayer = (l: ViewerLayer): l is ViewerService => l.type === 'service' && !!l.service.vector && !l.service.tableOnly && l.service.vector.fields.some((f) => f.name === 'class');

export class AiImportDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly layer_: HTMLSelectElement;
  private readonly image_: HTMLSelectElement;
  private readonly selectedOnly_: HTMLInputElement;
  private readonly again_: HTMLInputElement;
  private readonly plan_: HTMLElement;
  private readonly classes_: HTMLElement;
  private readonly levels_: HTMLElement;
  private readonly minScore_: HTMLInputElement;
  private readonly activity_: HTMLInputElement;
  private readonly kinds_: HTMLDataListElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly fetch_: HTMLButtonElement;
  private layers_: ViewerService[] = [];
  /** Sources already read for an image (source url and image id), this page. */
  private readonly read_ = new Set<string>();
  /** The kind typed for each class while the dialog is open. */
  private kinds: Record<string, string> = {};

  constructor(
    buttons: ReadonlyArray<HTMLButtonElement | null>,
    private readonly selection: Selection,
    private readonly options: AiImportOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog ai-import-dialog';
    this.dialog.setAttribute('aria-labelledby', 'ai-import-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="ai-import-title">AI 結果の観測記録への取り込み</h2>
        <label class="wide">取り込むレイヤー<select name="layer" aria-label="取り込むレイヤー"></select></label>
        <label class="wide">記録先の画像<select name="image" aria-label="記録先の画像"></select></label>
        <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物のみ</span></label>
        <p class="wide processing-hint ai-import-plan" role="status"></p>
        <details class="wide pansharpen-more">
          <summary>種別・確度の対応</summary>
          <div class="ai-import-classes" aria-label="クラスと種別"></div>
          <div class="ai-import-levels" aria-label="スコアと確度"></div>
          <label>スコア下限<input name="minScore" type="number" step="0.05" min="0" max="1" inputmode="decimal" /></label>
          <label>活動<input name="activity" autocomplete="off" placeholder="空欄で未記入" /></label>
          <label class="wide check" title="記録済みの位置（10 m 以内）の結果も記録"><input name="again" type="checkbox" /><span>記録済みの位置も取り込み</span></label>
        </details>
      </form>
      <datalist id="ai-import-kinds"></datalist>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="fetch" title="記録先の画像のカタログ ID による、外部 AI サービスの結果の読み込み">外部 AI 結果の読み込み</button>
        <button type="button" value="run" class="primary">取り込み</button>
      </div>`;
    document.body.append(this.dialog);
    const $ = <T extends Element>(s: string) => this.dialog.querySelector<T>(s)!;
    this.form_ = $('form');
    this.layer_ = $('select[name=layer]');
    this.image_ = $('select[name=image]');
    this.selectedOnly_ = $('input[name=selectedOnly]');
    this.again_ = $('input[name=again]');
    this.plan_ = $('.ai-import-plan');
    this.classes_ = $('.ai-import-classes');
    this.levels_ = $('.ai-import-levels');
    this.minScore_ = $('input[name=minScore]');
    this.activity_ = $('input[name=activity]');
    this.kinds_ = $('#ai-import-kinds');
    this.note_ = $('.processing-note');
    this.run_ = $('button[value=run]');
    this.fetch_ = $('button[value=fetch]');
    this.fetch_.hidden = options.sources.length === 0;
    $('button[value=cancel]').addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.fetch_.addEventListener('click', () => void this.fetchForChosen_());
    this.layer_.addEventListener('change', () => {
      this.chooseImage_();
      this.renderSettings_();
      this.describe_();
    });
    for (const control of [this.image_, this.selectedOnly_, this.again_]) control.addEventListener('change', () => this.describe_());
    this.form_.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.class !== undefined) this.kinds[input.dataset.class] = input.value.trim();
      this.describe_();
    });
    this.form_.addEventListener('change', (e) => {
      const cls = (e.target as HTMLInputElement).dataset.class;
      if (cls) this.rememberKind_(cls, (e.target as HTMLInputElement).value.trim());
    });
    for (const button of buttons) button?.addEventListener('click', () => void this.open());
  }

  /** Opens the dialog on the selected AI layer (or the newest one). */
  async open(layer?: ViewerService): Promise<void> {
    await Promise.all([this.options.observations.loaded(), this.options.observations.refreshImages()]);
    this.layers_ = this.options.layers().filter(isAiLayer);
    this.layer_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    const selected = layer ?? this.options.selected();
    const at = this.layers_.findIndex((l) => l === selected);
    if (at >= 0) this.layer_.value = String(at);
    this.image_.replaceChildren(...this.options.observations.imageList().map((i) => new Option(`${i.name}${i.file ? '' : '（ファイルなし）'}`, i.id)));
    this.selectedOnly_.checked = this.selectedFeatures_().length > 0;
    this.kinds_.replaceChildren(...this.options.observations.taxonomy().map((t) => new Option(kindOf(t.path))));
    this.note_.textContent = '';
    this.chooseImage_();
    this.renderSettings_();
    this.describe_();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /**
   * Reads the results of an image opened from the catalog (its catalog id) from the sources
   * (only those read when an image opens, unless `all`), each source's as a layer. Each source once per image.
   */
  async loadFor(image: ViewerImage, imageId: string, all = false): Promise<number> {
    let found = 0;
    for (const source of this.options.sources) {
      if (!all && !source.auto) continue;
      const key = `${source.url}\n${imageId}`;
      const title = resultTitle(source, imageId);
      if (this.read_.has(key) || this.options.layers().some((l) => l.type === 'service' && l.name === title)) continue;
      this.read_.add(key);
      try {
        const info = await this.options.imageInfo(image);
        const { features, truncated } = await fetchResults(source, imageId, this.options.ask);
        if (!features.length) continue;
        const made = features.map((f) => {
          const feature = new Feature(f.getGeometry());
          feature.setProperties(resultProperties(f, source, { id: imageId, ...info }));
          return feature;
        });
        found += made.length;
        await this.options.onResult({ title, features: made, fields: resultFields() }, `${source.label} の AI 結果 ${made.length} 件${truncated ? `（先頭 ${made.length} 件）` : ''}`);
        this.options.say(`${source.label}: ${info.name} の AI 結果 ${made.length} 件を表示（ツール → AI → 観測記録へ取り込み… で記録）`);
      } catch (error) {
        this.read_.delete(key);
        this.options.say(`${source.label} から AI 結果の読み込み失敗: ${message(error)}`);
      }
    }
    return found;
  }

  private layer(): ViewerService | null {
    return this.layers_[Number(this.layer_.value)] ?? null;
  }

  private selectedFeatures_(): Feature[] {
    const source = this.layer()?.service.vector?.source;
    return source ? this.selection.list().filter((f) => source.hasFeature(f)) : [];
  }

  private features_(): Feature[] {
    const layer = this.layer();
    if (!layer) return [];
    return this.selectedOnly_.checked ? this.selectedFeatures_() : layer.service.vector!.source.getFeatures();
  }

  /** The source a layer's results came from, when read from one. */
  private sourceOf_(features: readonly Feature[]): AiResultSource | null {
    const label = features.find((f) => f.get('source'))?.get('source');
    return this.options.sources.find((s) => s.label === label) ?? null;
  }

  /** The image the layer's results are of: by catalog id, else by file name; else the one recorded on now. */
  private chooseImage_(): void {
    const features = this.layer()?.service.vector?.source.getFeatures() ?? [];
    const ids = new Set(features.flatMap((f) => [f.get('image_id'), f.get('image')]).filter((v): v is string => typeof v === 'string' && v !== ''));
    const list = this.options.observations.imageList();
    const match = list.find((i) => ids.has(i.id)) ?? list.find((i) => ids.has(i.name)) ?? list.find((i) => i.current);
    if (match) this.image_.value = match.id;
  }

  /** The class rows, the score levels, the lowest score and the activity, as config.json (or the person) says. */
  private renderSettings_(): void {
    const features = this.layer()?.service.vector?.source.getFeatures() ?? [];
    const source = this.sourceOf_(features);
    const defaults = this.options.defaults;
    const remembered = this.rememberedKinds_();
    const taxonomy = this.options.observations.taxonomy();
    const specFields = this.options.observations.specFields();
    this.kinds = {};
    const rows = classCounts(features).map(({ class: cls, count }) => {
      const byName = cls ? classByName(taxonomy, cls, specFields) : null;
      this.kinds[cls] = remembered[cls] ?? source?.classes?.[cls] ?? defaults.classes[cls] ?? (byName ? kindOf(byName) : cls);
      return `<label>${escape(cls || '（クラスなし）')}（${count}）<input data-class="${escape(cls)}" list="ai-import-kinds" autocomplete="off" value="${escape(this.kinds[cls])}" placeholder="種別" /></label>`;
    });
    this.classes_.innerHTML = rows.join('');
    const labels = this.options.observations.confidences().map((c) => c.label);
    const levels = source?.confidences ?? defaults.confidences ?? defaultScoreLevels(labels);
    this.levels_.innerHTML = labels
      .map((label) => {
        const level = levels.find((l) => l.label === label);
        return `<label>確度「${escape(label)}」のスコア下限<input data-level="${escape(label)}" type="number" step="0.05" inputmode="decimal" value="${level ? level.min : ''}" placeholder="対象外" /></label>`;
      })
      .join('');
    this.minScore_.value = String(source?.minScore ?? defaults.minScore);
    this.activity_.value = source?.activity ?? defaults.activity;
  }

  private levels(): ScoreLevel[] {
    return [...this.levels_.querySelectorAll<HTMLInputElement>('input[data-level]')]
      .filter((i) => i.value.trim() !== '' && Number.isFinite(Number(i.value)))
      .map((i) => ({ min: Number(i.value), label: i.dataset.level! }))
      .sort((a, b) => b.min - a.min);
  }

  private plan() {
    const imageId = this.image_.value;
    const minScore = Number(this.minScore_.value);
    return importPlan(
      this.features_(),
      { kinds: this.kinds, levels: this.levels(), minScore: Number.isFinite(minScore) ? minScore : 0, activity: this.activity_.value.trim() },
      imageId ? this.options.observations.recordsOf(imageId) : [],
      this.again_.checked,
    );
  }

  /** What an import would record. */
  private describe_(): void {
    const count = this.selectedFeatures_().length;
    this.selectedOnly_.disabled = count === 0;
    if (count === 0) this.selectedOnly_.checked = false;
    this.selectedOnly_.nextElementSibling!.textContent = `選択中の地物のみ（${count.toLocaleString()} 件）`;
    this.run_.disabled = true;
    if (!this.layer()) {
      this.plan_.textContent = this.options.sources.length
        ? '取り込めるレイヤーなし（画像カタログから画像を開くと外部 AI の結果を表示、または「物体検出」で作成）'
        : '取り込めるレイヤーなし（先に「物体検出」で結果を作成）';
      return;
    }
    if (!this.image_.value) return void (this.plan_.textContent = '記録先の画像なし（画像を開く、または観測記録の「＋」で追加）');
    const plan = this.plan();
    const left = [plan.low && `スコア下限未満 ${plan.low} 件`, plan.recorded && `記録済みの位置 ${plan.recorded} 件`, plan.placeless && `位置なし ${plan.placeless} 件`].filter(Boolean);
    this.plan_.textContent = `${this.options.observations.storeLabel()} へ ${plan.items.length} 件をポイントで記録${left.length ? `（除外: ${left.join('・')}）` : ''}`;
    this.run_.disabled = plan.items.length === 0;
  }

  /** Records the results. */
  async run(): Promise<void> {
    const imageId = this.image_.value;
    const plan = this.plan();
    if (!imageId || !plan.items.length) return;
    this.run_.disabled = true;
    const observations = this.options.observations;
    const name = this.image_.selectedOptions[0]?.textContent ?? imageId;
    const made = await observations.addMany(plan.items, imageId, `AI 結果 ${plan.items.length} 件を記録（${name}）`);
    const done = made.length ? `${name} に AI 結果 ${made.length} 件を観測記録として記録` : `${observations.storeLabel()} への記録失敗`;
    this.note_.textContent = done;
    this.options.say(done);
    if (made.length) {
      this.dialog.close();
      await observations.open();
      observations.goToImage(imageId);
    } else this.describe_();
  }

  /** Reads the sources for the image chosen (its catalog id), all of them, then shows the newest layer. */
  private async fetchForChosen_(): Promise<void> {
    const id = this.image_.value;
    const image = this.options.images().find((i) => this.options.catalogId(i) === id);
    if (!id || !image) return void (this.note_.textContent = '画像カタログから開いた画像のみ読み込み可（カタログの画像 ID で検索）');
    this.note_.textContent = '外部 AI 結果を読み込み中…';
    // Read again, even what was read when it opened.
    for (const source of this.options.sources) this.read_.delete(`${source.url}\n${id}`);
    const before = new Set(this.options.layers());
    const found = await this.loadFor(image, id, true);
    const added = this.options.layers().find((l): l is ViewerService => !before.has(l) && isAiLayer(l));
    await this.open(added);
    this.note_.textContent = found ? `外部 AI 結果 ${found} 件を読み込み` : '外部 AI 結果なし（同名のレイヤーが開いている場合はそのレイヤーを使用）';
  }

  private rememberedKinds_(): Record<string, string> {
    try {
      const value = JSON.parse(localStorage.getItem(KINDS_KEY) ?? '{}') as unknown;
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /** Keeps the kind a person gave a class (none: back to what config.json says). */
  private rememberKind_(cls: string, kind: string): void {
    try {
      const kept = this.rememberedKinds_();
      if (kind) kept[cls] = kind;
      else delete kept[cls];
      localStorage.setItem(KINDS_KEY, JSON.stringify(kept));
    } catch {
      // Only while the dialog is open.
    }
  }
}
