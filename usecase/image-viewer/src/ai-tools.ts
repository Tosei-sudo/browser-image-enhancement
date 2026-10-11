/**
 * The AI tools (「ツール」→「AI」): models trained elsewhere and exported to
 * ONNX, run in the browser on what an image layer shows.
 *
 * - 物体検出: a YOLO model (detect, oriented boxes or instance segmentation)
 *   runs over the view in overlapping tiles; the objects found become a
 *   temporary layer of boxes or outlines with their class and score.
 * - クリックで抽出: a Segment Anything model; a click on the image outlines
 *   the object there (Shift + click takes in more of it, Alt + click leaves a
 *   part out), and the outlines become a temporary layer.
 *
 * Models come from `config.json`'s `aiModels` (URLs, so a closed network can
 * serve its own) or from files chosen on the computer. An Ultralytics model
 * carries its class names and input size, so it needs no settings.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import { getUid } from 'ol/util.js';
import type MapBrowserEvent from 'ol/MapBrowserEvent.js';
import type { Tensor } from 'onnxruntime-web/webgpu';
import { shortName, type ViewerLayer } from './images.js';
import { markOrigin } from './ai/transfer.js';
import type { ProcessingResult } from './processing/common.js';
import { field } from './processing/common.js';
import { drawView, drawViewInStrips, pixelRatioOf, type DrawnView } from './view-export.js';
import { detectorSpec, type AiModelConfig, type DetectModelConfig, type SamModelConfig } from './ai/model-config.js';
import { blocksOf, boxCorners, nms, offset, tilesOf, type Detection } from './ai/detect.js';
import { maskOutline, type PixelPolygon } from './ai/mask-outline.js';
import { partAt, SAM_MEAN, SAM_STD, samMask, samPrompt, samScale, samTensor, type SamPoint } from './ai/sam.js';
import { backendLabel, hasWebGpu, modelBytes, modelFrom, nameOf, tensor, type LoadedModel, type ModelBytes } from './ai/runtime.js';
import { cpuPlan, createDetectPool, type DetectPool } from './ai/detect-pool.js';
import { offscreenMap, type OffscreenMap } from './offscreen-map.js';

/** How the CPU runs the tiles, after its label: workers and threads. */
function cpuLabel(): string {
  const { workers, threads } = cpuPlan();
  return `${workers > 1 ? ` × ${workers}` : ''}${threads > 1 ? `（${threads} スレッド${workers > 1 ? 'ずつ' : ''}）` : ''}`;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Lets the page draw (a message, a progress line) before more work holds it. */
const breathe = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

/** Whether a layer shows pixels (an image, or a picture service such as WMS). */
export const isRaster = (l: ViewerLayer): boolean => l.type === 'image' || !l.service.vector;

export interface AiToolsOptions {
  /** `config.json`'s `aiModels`. */
  models: AiModelConfig[];
  /** The open layers, top first. */
  layers: () => readonly ViewerLayer[];
  selected: () => ViewerLayer | null;
  /** Opens a result as a temporary layer. */
  onResult: (result: ProcessingResult, made: string) => Promise<void>;
  say: (message: string) => void;
  /** The click tool started: other click tools stop. */
  onStart?: () => void;
  /** The catalog id and the acquisition time of an image, when known, written on what is found in it. */
  imageInfo?: (layer: ViewerLayer) => Promise<{ id?: string | null; time?: number | null }>;
}

/** The fields every AI layer has: where its features come from (for the database, transfer.ts). */
export const sourceFields = () => [
  field('image', 'string', '画像'),
  field('image_id', 'string', '画像ID'),
  field('image_time', 'date', '撮像日時'),
  field('model', 'string', 'モデル'),
  field('detected_at', 'date', '検出日時'),
  field('note', 'string', '備考'),
];

/** Sets where features come from, and marks them as the model made them. */
async function stamp(features: Feature[], layer: ViewerLayer, model: string, options: AiToolsOptions): Promise<void> {
  const info: { id?: string | null; time?: number | null } = (await options.imageInfo?.(layer).catch(() => null)) ?? {};
  const now = Date.now();
  for (const f of features) {
    f.setProperties({ image: shortName(layer.name), image_id: info.id ?? null, image_time: info.time ?? null, model, detected_at: now, note: null }, true);
    markOrigin(f);
  }
}

/** The image to look at: the selected layer when it shows pixels, else the top visible one that does. */
function targetLayer(options: AiToolsOptions): ViewerLayer | null {
  const selected = options.selected();
  if (selected && isRaster(selected)) return selected;
  return options.layers().find((l) => isRaster(l) && l.layer.getVisible()) ?? null;
}

/** Maps pixels of a drawn view to map coordinates and back. */
function placementOf(drawn: DrawnView) {
  const { origin, right, down } = drawn.placement;
  const det = right[0] * down[1] - down[0] * right[1];
  return {
    toMap: ([x, y]: readonly [number, number]): [number, number] => [origin[0] + x * right[0] + y * down[0], origin[1] + x * right[1] + y * down[1]],
    toPixel: ([mx, my]: readonly number[]): [number, number] => {
      const dx = mx - origin[0];
      const dy = my - origin[1];
      return [(dx * down[1] - dy * down[0]) / det, (right[0] * dy - right[1] * dx) / det];
    },
  };
}

/** A polygon of pixels as a map polygon. */
function polygonOf(rings: PixelPolygon, toMap: (p: readonly [number, number]) => [number, number]): Polygon {
  return new Polygon(rings.map((ring) => {
    const coords = ring.map(toMap);
    return [...coords, coords[0]];
  }));
}

/**
 * A model choice: `config.json`'s models of one kind, then files chosen on
 * the computer (kept in the list for the page's life).
 */
class ModelChoice<T extends AiModelConfig> {
  readonly select: HTMLSelectElement;
  private readonly files_: Array<{ label: string; files: File[] }> = [];
  private readonly input_: HTMLInputElement;

  constructor(
    private readonly configs: T[],
    multiple: boolean,
    private readonly onChange: () => void,
  ) {
    this.select = document.createElement('select');
    this.select.name = 'model';
    this.select.setAttribute('aria-label', 'モデル');
    this.input_ = document.createElement('input');
    this.input_.type = 'file';
    this.input_.accept = '.onnx';
    this.input_.multiple = multiple;
    this.input_.hidden = true;
    this.input_.setAttribute('aria-label', 'モデルのファイル');
    this.input_.addEventListener('change', () => {
      const files = [...(this.input_.files ?? [])];
      this.input_.value = '';
      if (files.length) this.addFiles(files);
    });
    this.select.addEventListener('change', () => {
      if (this.select.value === 'pick') {
        this.select.value = this.select.options[0]?.value === 'pick' ? '' : this.select.options[0].value;
        this.input_.click();
      } else this.onChange();
    });
    this.fill_();
  }

  /** The hidden file input (to sit next to the select). */
  get input(): HTMLInputElement {
    return this.input_;
  }

  /** Adds chosen files as a model and chooses it. */
  addFiles(files: File[]): void {
    this.files_.push({ label: files.map((f) => f.name).join(' + '), files });
    this.fill_();
    this.select.value = `file:${this.files_.length - 1}`;
    this.onChange();
  }

  /** The chosen model: its config entry or its files; null when none is chosen. */
  chosen(): { config: T; files?: undefined } | { config?: undefined; files: File[]; label: string } | null {
    const [kind, index] = this.select.value.split(':');
    if (kind === 'config') return { config: this.configs[Number(index)] };
    if (kind === 'file') return { files: this.files_[Number(index)].files, label: this.files_[Number(index)].label };
    return null;
  }

  private fill_(): void {
    const options = [
      ...this.configs.map((c, i) => new Option(c.label, `config:${i}`)),
      ...this.files_.map((f, i) => new Option(`📄 ${f.label}`, `file:${i}`)),
    ];
    if (!options.length) options.push(new Option('（モデルを選んでください）', ''));
    options.push(new Option('ファイルから選ぶ…', 'pick'));
    this.select.replaceChildren(...options);
  }
}

/** The 「物体検出」 dialog. */
export class DetectDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly models_: ModelChoice<DetectModelConfig>;
  private readonly target_: HTMLSelectElement;
  private readonly note_: HTMLElement;
  private readonly info_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private layers_: ViewerLayer[] = [];
  private running_: { cancelled: boolean } | null = null;
  private pool_ref: { key: string; pool: Promise<DetectPool> } | null = null;
  private readonly progress_: Progress;

  constructor(
    button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly options: AiToolsOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog ai-dialog';
    this.dialog.setAttribute('aria-labelledby', 'ai-detect-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="ai-detect-title">物体検出（AI）</h2>
        <label class="wide ai-model">モデル（ONNX）</label>
        <label class="wide">対象の画像<select name="target" aria-label="対象の画像"></select></label>
        <p class="wide processing-hint">表示範囲を画面の細かさで解析します。小さな物体は拡大して表示するか、詳細設定の「解析の細かさ」を上げてください。</p>
        <details class="wide pansharpen-more">
          <summary>詳細設定</summary>
          <div class="service-form">
            <label>解析の細かさ<select name="scale" aria-label="解析の細かさ"><option value="1">画面のまま</option><option value="2">2 倍</option><option value="4">4 倍</option><option value="8">8 倍</option><option value="16">16 倍</option></select></label>
            <label>スコアのしきい値<input name="score" type="number" min="0.01" max="0.99" step="0.05" aria-label="スコアのしきい値" /></label>
            <label>重なりの判定（IoU）<input name="iou" type="number" min="0.05" max="0.95" step="0.05" aria-label="重なりの判定" /></label>
            <label>タイルの重なり（%）<input name="overlap" type="number" min="0" max="50" step="5" value="20" aria-label="タイルの重なり" /></label>
            <label class="wide">検出するクラス（カンマ区切り、空ならすべて）<input name="classes" type="text" aria-label="検出するクラス" /></label>
          </div>
        </details>
        <p class="wide processing-hint ai-model-info"></p>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.models_ = new ModelChoice(
      options.models.filter((m): m is DetectModelConfig => m.kind === 'detect'),
      false,
      () => void this.describe_(),
    );
    this.dialog.querySelector('.ai-model')!.append(this.models_.select, this.models_.input);
    this.target_ = this.form_.elements.namedItem('target') as HTMLSelectElement;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.info_ = this.dialog.querySelector('.ai-model-info')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.progress_ = new Progress(map.getViewport().parentElement ?? document.body);
    button.addEventListener('click', () => this.open());
  }

  open(): void {
    this.layers_ = this.options.layers().filter(isRaster);
    this.target_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    const target = targetLayer(this.options);
    if (target) this.target_.value = String(this.layers_.indexOf(target));
    this.note_.textContent = this.layers_.length ? '' : '先に画像を開いてください';
    void this.describe_();
    this.dialog.showModal();
  }

  /** Adds a model file and chooses it (also for tests). */
  addModelFile(file: File): void {
    this.models_.addFiles([file]);
  }

  /** The chosen model's bytes (read, not loaded: the workers load it), with its spec. */
  private async model_(onProgress?: (done: number) => void) {
    const chosen = this.models_.chosen();
    if (!chosen) return null;
    const bytes = await modelBytes(chosen.config ? chosen.config.url : chosen.files[0], onProgress);
    return { bytes, spec: detectorSpec(chosen.config ?? {}, bytes.metadata, bytes.signature), label: chosen.config ? chosen.config.label : chosen.label };
  }

  /** Shows what the chosen model is (its task, classes and input), loading it. */
  private async describe_(): Promise<void> {
    this.info_.textContent = '';
    const score = this.form_.elements.namedItem('score') as HTMLInputElement;
    const iou = this.form_.elements.namedItem('iou') as HTMLInputElement;
    if (!this.models_.chosen()) {
      this.info_.textContent = 'YOLO（Ultralytics など）の ONNX を選んでください。config.json の aiModels に登録したモデルはここに並びます。';
      return;
    }
    // Another model chosen while this one loads: its own description wins.
    const key = this.models_.select.value;
    const stale = () => this.models_.select.value !== key;
    try {
      this.info_.textContent = 'モデルを読み込んでいます…';
      const loaded = await this.model_((done) => stale() || (this.info_.textContent = `モデルを読み込んでいます… ${Math.round(done * 100)}%`));
      if (!loaded || stale()) return;
      const { spec } = loaded;
      // The workers run on the GPU when there is one.
      const backend = (await hasWebGpu()) ? 'webgpu' : 'wasm';
      if (stale()) return;
      score.value = String(spec.score);
      iou.value = String(spec.iou);
      const task = { detect: '物体検出（矩形）', obb: '物体検出（回転矩形）', segment: 'インスタンスセグメンテーション（輪郭）' }[spec.task];
      const kind = spec.format === 'detectron2' ? '（Detectron2 形式）' : '';
      const classes = spec.classes.length
        ? `${spec.classes.length} クラス（${spec.classes.slice(0, 8).join('・')}${spec.classes.length > 8 ? '…' : ''}）`
        : 'クラス名なし（番号で出します）';
      this.info_.textContent = `${task}${kind}・入力 ${spec.inputSize[0]}×${spec.inputSize[1]}・${classes}・${backendLabel(backend)}${backend === 'wasm' ? cpuLabel() : ''}で実行`;
    } catch (error) {
      if (!stale()) this.info_.textContent = `モデルを読み込めませんでした: ${message(error)}`;
    }
  }

  /**
   * Runs the chosen model over the view of the chosen image, in the
   * background: the dialog closes, a small panel shows how far it got (and
   * stops it), and the map stays free to use. The view is drawn on a hidden
   * copy of the map, block by block when large, while workers analyse the
   * tiles of the block drawn before.
   */
  async run(): Promise<void> {
    const layer = this.layers_[Number(this.target_.value)];
    if (!layer) return void (this.note_.textContent = '先に画像を開いてください');
    if (!this.models_.chosen()) return void (this.note_.textContent = 'モデルを選んでください');
    if (this.running_) return void (this.note_.textContent = '物体検出を実行中です。終わってからもう一度実行してください');
    const running = { cancelled: false };
    this.running_ = running;
    this.run_.disabled = true;
    const form = new FormData(this.form_);
    const started = performance.now();
    const progress = this.progress_;
    progress.start(() => (running.cancelled = true));
    let offscreen: OffscreenMap | null = null;
    try {
      this.note_.textContent = 'モデルを読み込んでいます…';
      const loaded = (await this.model_())!;
      const { label } = loaded;
      const spec = { ...loaded.spec };
      const score = Number(form.get('score'));
      const iou = Number(form.get('iou'));
      if (score > 0 && score < 1) spec.score = score;
      if (iou > 0 && iou < 1) spec.iou = iou;
      const wanted = String(form.get('classes') ?? '')
        .split(/[,、，]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const scale = Number(form.get('scale')) || 1;
      const overlap = Math.min(0.5, Math.max(0, Number(form.get('overlap')) / 100 || 0));
      this.dialog.close();
      this.note_.textContent = '';

      progress.say('モデルを準備しています…');
      const pool = await this.pool_(loaded.bytes);
      if (running.cancelled) throw new Error('中止しました');

      // The view as it is now, on a hidden copy of the map (the map itself when the layer cannot be copied).
      offscreen = await offscreenMap(this.map, layer.layer);
      const drawMap = offscreen?.map ?? this.map;
      const only = offscreen ? undefined : layer.layer;
      const ratio = pixelRatioOf(drawMap);
      // A large scale is drawn and analysed block by block, so memory stays bounded.
      const blocks = blocksOf(drawMap.getSize()!, scale, ratio, Math.max(...spec.inputSize));
      // The hidden map draws in strips, so the page never waits long for the GPU; the map itself in one go.
      const draw = (b: number) => (offscreen ? drawViewInStrips(drawMap, scale, blocks[b]) : drawView(drawMap, scale, only, blocks.length > 1 ? blocks[b] : undefined));
      const [tw, th] = spec.inputSize;
      const found: Detection[] = [];
      let toMap: ((p: readonly [number, number]) => [number, number]) | null = null;
      let tileCount = 0;
      let drawing = draw(0);
      for (let b = 0; b < blocks.length; b++) {
        if (running.cancelled) throw new Error('中止しました');
        const where = blocks.length > 1 ? `ブロック ${b + 1} / ${blocks.length}・` : '';
        progress.say(`${where}画像を描いています…`);
        const drawn = await drawing;
        // The next block is drawn (on the hidden map) while this one is analysed.
        if (offscreen && b + 1 < blocks.length) drawing = draw(b + 1);
        const block = blocks[b];
        // Pixels of every block are counted from the larger view's corner.
        const [bx, by] = [Math.round(block[0] * ratio), Math.round(block[1] * ratio)];
        if (!toMap) {
          const { origin, right, down } = drawn.placement;
          const corner: [number, number] = [origin[0] - bx * right[0] - by * down[0], origin[1] - bx * right[1] - by * down[1]];
          toMap = placementOf({ ...drawn, placement: { origin: corner, right, down } }).toMap;
        }
        const { width, height } = drawn.canvas;
        const rgba = drawn.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
        drawn.canvas.width = drawn.canvas.height = 0;
        const tiles = tilesOf(width, height, spec.inputSize, overlap).filter(([x0, y0]) => !isEmpty(rgba, width, height, x0, y0, tw, th));
        tileCount += tiles.length;
        let done = 0;
        // A few tiles more than workers are cut out at a time: each worker has the next one waiting.
        const inFlight = new Set<Promise<void>>();
        for (const [x0, y0] of tiles) {
          if (running.cancelled) throw new Error('中止しました');
          const job = pool
            .run(cropOf(rgba, width, height, x0, y0, tw, th), tw, th, spec)
            .then((objects) => {
              found.push(...objects.map((d) => offset(d, bx + x0, by + y0)));
              progress.say(`${where}解析しています… ${++done} / ${tiles.length} タイル（${backendLabel(pool.backend)}${pool.size > 1 ? ` × ${pool.size}` : ''}）`, done / tiles.length);
            });
          inFlight.add(job);
          void job.finally(() => inFlight.delete(job)).catch(() => {});
          if (inFlight.size >= pool.size * 2) await Promise.race(inFlight);
        }
        await Promise.all(inFlight);
      }
      const names = spec.classes;
      const nameOfClass = (cls: number) => names[cls] ?? `class ${cls}`;
      const kept = nms(found, spec.iou).filter((d) => !wanted.length || wanted.includes(nameOfClass(d.cls).toLowerCase()) || wanted.includes(String(d.cls)));

      const features = kept.map((d) => {
        const rings = d.outline ?? [boxCorners(d)];
        const feature = new Feature({
          geometry: polygonOf(rings, toMap!),
          class: nameOfClass(d.cls),
          class_id: d.cls,
          score: Math.round(d.score * 1000) / 1000,
        });
        if (d.angle !== undefined) feature.set('angle', Math.round(((d.angle * 180) / Math.PI) * 10) / 10);
        return feature;
      });
      if (!features.length) {
        this.options.say(`物体検出（${label}）: 見つかりませんでした（${tileCount} タイル、スコア ${spec.score} 以上）。拡大するか、しきい値を下げてみてください`);
        return;
      }
      const fields = [field('class', 'string', 'クラス'), field('class_id', 'integer', 'クラス番号'), field('score', 'double', 'スコア')];
      if (spec.task === 'obb') fields.push(field('angle', 'double', '回転角（°）'));
      fields.push(...sourceFields());
      await stamp(features, layer, label, this.options);
      const counts = new Map<string, number>();
      for (const f of features) counts.set(f.get('class'), (counts.get(f.get('class')) ?? 0) + 1);
      const summary = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} ${n}`).join('・');
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const result: ProcessingResult = {
        title: `物体検出（${label}）`,
        features,
        fields,
        notes: [`${summary}（${tileCount} タイル、${backendLabel(pool.backend)}${pool.size > 1 ? ` × ${pool.size}` : ''}、${seconds} 秒）`],
      };
      await this.options.onResult(result, `物体検出 ${label}・スコア ${spec.score} 以上（${layer.name}）`);
      this.options.say(`${result.title} を作成しました（${features.length.toLocaleString()} 件、一時レイヤー）。${result.notes![0]}`);
    } catch (error) {
      if (running.cancelled) this.options.say('物体検出を中止しました');
      else this.options.say(`物体検出できませんでした: ${message(error)}`);
      // A worker stopped half-way through a tile is made again next time.
      if (running.cancelled) this.dropPool_();
    } finally {
      offscreen?.dispose();
      progress.stop();
      this.run_.disabled = false;
      if (this.running_ === running) this.running_ = null;
    }
  }

  /** The workers for the model in `bytes` (the same ones while the model stays). */
  private async pool_(bytes: ModelBytes): Promise<DetectPool> {
    // A pool a stopped worker left dead is made again.
    if (this.pool_ref?.key === bytes.key && (await this.pool_ref.pool.catch(() => null))?.dead) this.dropPool_();
    if (this.pool_ref?.key !== bytes.key) {
      this.dropPool_();
      const pool = createDetectPool(bytes.bytes, bytes.name);
      this.pool_ref = { key: bytes.key, pool };
      pool.catch(() => this.pool_ref?.pool === pool && (this.pool_ref = null));
    }
    return this.pool_ref!.pool;
  }

  private dropPool_(): void {
    void this.pool_ref?.pool.then((p) => p.terminate()).catch(() => {});
    this.pool_ref = null;
  }

  /** Whether a detection is running (it runs in the background). */
  isRunning(): boolean {
    return this.running_ !== null;
  }
}

/** The tile at (x0, y0) of an RGBA picture, `tw` × `th` (transparent past the edges). */
function cropOf(rgba: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, tw: number, th: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw * th * 4);
  const w = Math.max(0, Math.min(tw, width - x0));
  for (let y = 0; y < th && y0 + y < height; y++) out.set(rgba.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * tw * 4);
  return out;
}

/** A small panel over the map: how far a background detection got, and a button that stops it. */
class Progress {
  private readonly panel_ = document.createElement('div');
  private readonly text_ = document.createElement('span');
  private readonly bar_ = document.createElement('progress');
  private readonly stop_ = document.createElement('button');
  private onStop_: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.panel_.className = 'ai-progress';
    this.panel_.hidden = true;
    this.panel_.setAttribute('role', 'status');
    this.panel_.setAttribute('aria-label', '物体検出の進み具合');
    this.stop_.type = 'button';
    this.stop_.textContent = '中止';
    this.stop_.addEventListener('click', () => {
      this.onStop_?.();
      this.say('中止しています…');
    });
    this.bar_.max = 1;
    this.panel_.append(this.text_, this.bar_, this.stop_);
    parent.append(this.panel_);
  }

  start(onStop: () => void): void {
    this.onStop_ = onStop;
    this.bar_.removeAttribute('value');
    this.text_.textContent = '物体検出を始めています…';
    this.panel_.hidden = false;
  }

  /** What it is doing, and how much of it is done (0–1; none: not known). */
  say(text: string, done?: number): void {
    this.text_.textContent = `物体検出: ${text}`;
    if (done === undefined) this.bar_.removeAttribute('value');
    else this.bar_.value = done;
  }

  stop(): void {
    this.onStop_ = null;
    this.panel_.hidden = true;
  }
}

/** Whether the tile at (x0, y0) has no visible pixel. */
function isEmpty(rgba: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, tw: number, th: number): boolean {
  for (let y = y0; y < Math.min(height, y0 + th); y += 2) {
    for (let x = x0; x < Math.min(width, x0 + tw); x += 2) if (rgba[(y * width + x) * 4 + 3] !== 0) return false;
  }
  return true;
}

function area(ring: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(sum / 2);
}

/** The encoder's view of one drawn picture, reused while the view stays put. */
interface SamImage {
  key: string;
  drawn: DrawnView;
  scale: number;
  /** The encoder's input side. */
  side: number;
  embeddings: Tensor;
}

/** An object being outlined: its clicked points and its feature. */
interface SamObject {
  points: SamPoint[];
  feature: Feature | null;
}

const outlineStyle = new Style({ stroke: new Stroke({ color: '#00e5ff', width: 2 }), fill: new Fill({ color: 'rgba(0, 229, 255, 0.18)' }) });
const pointStyles = {
  true: new Style({ image: new Circle({ radius: 5, fill: new Fill({ color: '#2ecc71' }), stroke: new Stroke({ color: '#fff', width: 1.5 }) }) }),
  false: new Style({ image: new Circle({ radius: 5, fill: new Fill({ color: '#e74c3c' }), stroke: new Stroke({ color: '#fff', width: 1.5 }) }) }),
};

/** 「クリックで抽出」: Segment Anything on the image under the click. */
export class SegmentTool {
  readonly panel: HTMLElement;
  private readonly models_: ModelChoice<SamModelConfig>;
  private readonly note_: HTMLElement;
  private readonly keep_: HTMLButtonElement;
  private readonly undo_: HTMLButtonElement;
  private readonly source_ = new VectorSource();
  private readonly layer_: VectorLayer;
  private active_ = false;
  private image_: SamImage | null = null;
  private objects_: SamObject[] = [];
  private busy_: Promise<void> = Promise.resolve();

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly map: OlMap,
    private readonly options: AiToolsOptions,
  ) {
    this.layer_ = new VectorLayer({
      source: this.source_,
      zIndex: 10_001,
      style: (f) => (f.getGeometry() instanceof Point ? pointStyles[String(!!f.get('positive')) as 'true' | 'false'] : outlineStyle),
    });
    this.panel = document.createElement('div');
    this.panel.className = 'ai-segment-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', 'クリックで抽出');
    this.panel.innerHTML = `
      <div class="ai-segment-row"><strong>クリックで抽出（AI）</strong><label class="ai-model">モデル</label></div>
      <p class="ai-segment-hint">画像の物体をクリックすると輪郭を取ります。Shift+クリックで範囲を広げ、Alt+クリックで除きます。</p>
      <p class="ai-segment-note" role="status"></p>
      <div class="ai-segment-row">
        <button type="button" value="undo">1 つ戻す</button>
        <button type="button" value="keep" class="primary">レイヤーにする</button>
        <button type="button" value="close">終了</button>
      </div>`;
    this.models_ = new ModelChoice(
      options.models.filter((m): m is SamModelConfig => m.kind === 'sam'),
      true,
      () => {
        this.image_ = null;
        void this.prepare_();
      },
    );
    this.panel.querySelector('.ai-model')!.append(this.models_.select, this.models_.input);
    this.note_ = this.panel.querySelector('.ai-segment-note')!;
    this.keep_ = this.panel.querySelector('button[value=keep]')!;
    this.undo_ = this.panel.querySelector('button[value=undo]')!;
    this.keep_.addEventListener('click', () => void this.keep());
    this.undo_.addEventListener('click', () => this.undo());
    this.panel.querySelector('button[value=close]')!.addEventListener('click', () => this.setActive(false));
    (this.map.getViewport().parentElement ?? document.body).append(this.panel);
    button.addEventListener('click', () => this.setActive(!this.active_));
    map.on('singleclick', (e) => {
      if (this.active_) this.busy_ = this.busy_.then(() => this.click_(e)).catch(() => {});
    });
    document.addEventListener('keydown', (e) => {
      if (this.active_ && e.key === 'Escape' && !(e.target as HTMLElement).closest?.('dialog')) this.setActive(false);
    });
    this.update_();
  }

  isActive(): boolean {
    return this.active_;
  }

  setActive(active: boolean): void {
    if (active === this.active_) return;
    this.active_ = active;
    this.button.setAttribute('aria-pressed', String(active));
    this.panel.hidden = !active;
    this.map.getViewport().classList.toggle('measuring', active);
    if (active) {
      this.options.onStart?.();
      this.map.addLayer(this.layer_);
      void this.prepare_();
    } else {
      this.map.removeLayer(this.layer_);
      this.source_.clear();
      this.objects_ = [];
      this.image_ = null;
      this.update_();
    }
  }

  /** Adds model files (encoder and decoder) and chooses them (also for tests). */
  addModelFiles(files: File[]): void {
    this.models_.addFiles(files);
  }

  /** Loads the chosen model's encoder and decoder. */
  private async models(): Promise<{ encoder: LoadedModel; decoder: LoadedModel; config: Partial<SamModelConfig> } | null> {
    const chosen = this.models_.chosen();
    if (!chosen) return null;
    if (chosen.config) {
      const [encoder, decoder] = await Promise.all([modelFrom(chosen.config.encoder), modelFrom(chosen.config.decoder)]);
      return { encoder, decoder, config: chosen.config };
    }
    if (chosen.files.length !== 2) throw new Error('エンコーダーとデコーダーの 2 つの .onnx を一緒に選んでください');
    // By name (…encoder… / …decoder…), else the larger file is the encoder.
    const [a, b] = chosen.files;
    const encoderFirst = /encoder/i.test(a.name) || /decoder/i.test(b.name) || (!/encoder|decoder/i.test(a.name + b.name) && a.size >= b.size);
    const [encoder, decoder] = await Promise.all([modelFrom(encoderFirst ? a : b), modelFrom(encoderFirst ? b : a)]);
    return { encoder, decoder, config: {} };
  }

  /** Loads the model when the tool starts, so the first click is quicker. */
  private async prepare_(): Promise<void> {
    if (!this.models_.chosen()) {
      this.note_.textContent = 'Segment Anything（SAM・MobileSAM など）のエンコーダーとデコーダーの ONNX を選んでください';
      return;
    }
    const key = this.models_.select.value;
    const stale = () => this.models_.select.value !== key;
    try {
      this.note_.textContent = 'モデルを読み込んでいます…';
      const m = await this.models();
      if (m && this.active_ && !stale()) this.note_.textContent = `準備ができました（${backendLabel(m.encoder.backend)}）。画像をクリックしてください`;
    } catch (error) {
      if (!stale()) this.note_.textContent = `モデルを読み込めませんでした: ${message(error)}`;
    }
  }

  /** The encoder's view of the image as the map shows it now (made again when the view or the image changed). */
  private async image(layer: ViewerLayer, encoder: LoadedModel, config: Partial<SamModelConfig>): Promise<SamImage> {
    const view = this.map.getView();
    const source = (layer.layer as unknown as { getSource?: () => { getRevision(): number } | null }).getSource?.();
    const key = JSON.stringify([getUid(layer.layer), source?.getRevision(), view.getCenter(), view.getResolution(), view.getRotation(), this.map.getSize(), getUid(encoder.session)]);
    if (this.image_?.key === key) return this.image_;
    this.note_.textContent = '画像を解析しています（エンコーダー）…';
    await breathe();
    const drawn = await drawView(this.map, 1, layer.layer);
    const side = config.inputSize ?? 1024;
    const { scale, width, height } = samScale(drawn.canvas.width, drawn.canvas.height, side);
    const small = document.createElement('canvas');
    small.width = width;
    small.height = height;
    const ctx = small.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(drawn.canvas, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const input = encoder.session.inputNames[0];
    const meta = (encoder.session as unknown as { inputMetadata?: Array<{ shape?: ReadonlyArray<number | string> }> }).inputMetadata?.[0];
    let feed: Tensor;
    if (meta?.shape?.length === 3 && meta.shape[2] === 3) {
      // An encoder with its preprocessing inside: the scaled picture as it is, height × width × RGB.
      const hwc = new Float32Array(width * height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) [hwc[j], hwc[j + 1], hwc[j + 2]] = [rgba[i], rgba[i + 1], rgba[i + 2]];
      feed = await tensor(hwc, [height, width, 3]);
    } else {
      feed = await tensor(samTensor(rgba, width, height, side, config.mean ?? SAM_MEAN, config.std ?? SAM_STD), [1, 3, side, side]);
    }
    const outputs = await encoder.session.run({ [input]: feed });
    feed.dispose();
    const [first, ...rest] = encoder.session.outputNames;
    for (const n of rest) outputs[n].dispose();
    this.image_?.embeddings.dispose();
    this.image_ = { key, drawn, scale, side, embeddings: outputs[first] };
    return this.image_;
  }

  private async click_(e: MapBrowserEvent<PointerEvent | KeyboardEvent | WheelEvent>): Promise<void> {
    const layer = targetLayer(this.options);
    if (!layer) return void (this.note_.textContent = '先に画像を開いてください');
    const event = e.originalEvent as MouseEvent;
    try {
      const models = await this.models();
      if (!models) return void (this.note_.textContent = '先にモデルを選んでください');
      const started = performance.now();
      const image = await this.image(layer, models.encoder, models.config);
      const [px, py] = placementOf(image.drawn).toPixel(e.coordinate);
      if (px < 0 || py < 0 || px >= image.drawn.canvas.width || py >= image.drawn.canvas.height) return;
      const adding = (event.shiftKey || event.altKey) && this.objects_.length > 0;
      const object: SamObject = adding ? this.objects_[this.objects_.length - 1] : { points: [], feature: null };
      if (!adding) this.objects_.push(object);
      object.points.push({ x: px, y: py, positive: !event.altKey });
      this.source_.addFeature(new Feature({ geometry: new Point(e.coordinate), positive: !event.altKey }));
      this.note_.textContent = '輪郭を取っています…';
      await this.outline_(object, models.decoder, image);
      this.note_.textContent = object.feature
        ? `${this.count_()} 個を抽出しました（${((performance.now() - started) / 1000).toFixed(1)} 秒）。「レイヤーにする」で一時レイヤーにします`
        : 'この点からは輪郭を取れませんでした';
    } catch (error) {
      this.note_.textContent = `抽出できませんでした: ${message(error)}`;
    }
    this.update_();
  }

  /** Outlines `object` from its points (replacing its outline). */
  private async outline_(object: SamObject, decoder: LoadedModel, image: SamImage): Promise<void> {
    const { width, height } = image.drawn.canvas;
    const mask = await this.decode_(decoder, image, object.points, width, height);
    // The part of the mask under the first point taken in: the object clicked, not others like it.
    const first = object.points.find((p) => p.positive) ?? object.points[0];
    const polygons = maskOutline(partAt(mask, width, height, first.x, first.y), width, height, 1);
    if (object.feature) this.source_.removeFeature(object.feature);
    object.feature = null;
    if (!polygons.length) return;
    const largest = polygons.reduce((a, b) => (area(b[0]) > area(a[0]) ? b : a));
    object.feature = new Feature({ geometry: polygonOf(largest, placementOf(image.drawn).toMap) });
    this.source_.addFeature(object.feature);
  }

  /** Runs the decoder for `points` and returns the picture-sized mask. */
  private async decode_(decoder: LoadedModel, image: SamImage, points: SamPoint[], width: number, height: number): Promise<Uint8Array> {
    const prompt = samPrompt(points, image.scale);
    const names = decoder.session.inputNames;
    const feeds: Record<string, Tensor> = {};
    const add = async (name: string, data: Float32Array, dims: number[]) => {
      if (names.includes(name)) feeds[name] = await tensor(data, dims);
    };
    await add('point_coords', prompt.coords, [1, prompt.count, 2]);
    await add('point_labels', prompt.labels, [1, prompt.count]);
    await add('mask_input', new Float32Array(256 * 256), [1, 1, 256, 256]);
    await add('has_mask_input', new Float32Array(1), [1]);
    await add('orig_im_size', Float32Array.of(height, width), [2]);
    const embeddings = nameOf(names, 'image_embeddings', 0);
    let outputs: Record<string, Tensor> = {};
    try {
      outputs = await decoder.session.run({ ...feeds, [embeddings]: image.embeddings });
      const out = decoder.session.outputNames;
      const masks = outputs[nameOf(out, 'masks', 0)];
      const scoresName = out.find((n) => n === 'iou_predictions') ?? out.find((n) => outputs[n].dims.length === 2);
      const scores = scoresName ? ((await outputs[scoresName].getData()) as Float32Array) : null;
      return samMask({ dims: masks.dims, data: (await masks.getData()) as Float32Array }, scores, width, height, image.scale, image.side);
    } finally {
      for (const t of Object.values(feeds)) t.dispose();
      for (const t of Object.values(outputs)) t.dispose();
    }
  }

  /** Removes the last click: the last object's last point (outlining it again from the rest), or the object. */
  undo(): void {
    const object = this.objects_.at(-1);
    if (!object) return;
    const marker = this.source_.getFeatures().filter((f) => f.getGeometry() instanceof Point).at(-1);
    if (marker) this.source_.removeFeature(marker);
    object.points.pop();
    if (!object.points.length) {
      if (object.feature) this.source_.removeFeature(object.feature);
      this.objects_.pop();
    } else {
      this.busy_ = this.busy_
        .then(async () => {
          const layer = targetLayer(this.options);
          const models = await this.models();
          if (layer && models) await this.outline_(object, models.decoder, await this.image(layer, models.encoder, models.config));
          this.update_();
        })
        .catch(() => {});
    }
    this.note_.textContent = `${this.count_()} 個を抽出しています`;
    this.update_();
  }

  /** Makes the outlines a temporary layer and starts again. */
  async keep(): Promise<void> {
    const features = this.objects_.flatMap((o, i) => (o.feature ? [new Feature({ geometry: o.feature.getGeometry()!.clone(), id: i + 1, class: null })] : []));
    if (!features.length) return;
    const label = (this.models_.select.selectedOptions[0]?.textContent ?? 'SAM').replace(/^📄 /, '');
    const layer = targetLayer(this.options);
    if (layer) await stamp(features, layer, label, this.options);
    const fields = [field('id', 'integer', '番号'), field('class', 'string', 'クラス'), ...sourceFields()];
    await this.options.onResult({ title: 'AI 抽出', features, fields }, `クリックで抽出（${label}）`);
    this.options.say(`AI 抽出 を作成しました（${features.length} 件、一時レイヤー）`);
    this.objects_ = [];
    this.source_.clear();
    this.update_();
  }

  /** The outlines made so far (not yet a layer). */
  outlines(): Feature[] {
    return this.objects_.flatMap((o) => (o.feature ? [o.feature] : []));
  }

  private count_(): number {
    return this.objects_.filter((o) => o.feature).length;
  }

  private update_(): void {
    this.keep_.disabled = this.count_() === 0;
    this.undo_.disabled = this.objects_.length === 0;
  }
}
