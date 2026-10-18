/**
 * 「サーバ処理」: runs a geoprocessing task on a server — an ArcGIS GP service
 * (GPServer) or OGC API – Processes. The service is read from a URL (or
 * picked from config.json's `gpServices`), the task's parameters become a
 * form (required ones shown, optional ones folded under 「詳細」), and the
 * run is waited for, or followed as a job with its messages and a cancel
 * button. Feature results open as temporary layers, images as layers, a
 * job's result map service as a map layer; other values and links are shown
 * in the dialog.
 */
import type Feature from 'ol/Feature.js';
import type OlMap from 'ol/Map.js';
import Draw from 'ol/interaction/Draw.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import type { ViewerLayer, ViewerService } from './images.js';
import type { Selection } from './selection.js';
import type { ProcessingResult } from './processing/common.js';
import { copyFields } from './processing/common.js';
import { targetCrs } from './processing/reproject.js';
import type { GpServiceConfig } from './config.js';
import { GpCancelled, gpToken, readGp, readTask, runTask, type RunResult } from './gp/client.js';
import { linearUnitNames, safeUrl, type GpField, type GpOutput, type GpService, type GpTask, type GpValue } from './gp/model.js';

export interface GpDialogOptions {
  map: OlMap;
  /** The services of config.json. */
  services: () => readonly GpServiceConfig[];
  /** The open layers, top first. */
  layers: () => readonly ViewerLayer[];
  /** Opens features as a temporary layer. */
  onFeatures: (result: ProcessingResult, made: string) => Promise<void>;
  /** Opens an image (a COG) by URL; throws when it cannot. */
  openImage: (url: string) => Promise<void>;
  /** Adds a map service (a job's result map) as a layer; throws when it cannot. */
  addMapServer: (url: string, token?: string) => Promise<void>;
  say: (message: string) => void;
}

/** Makes an element with properties and children (no HTML parsing of server text). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, String(value));
    else (node as unknown as Record<string, unknown>)[key] = value;
  }
  node.append(...children);
  return node;
}

/** An ISO date as a `datetime-local` value (local time). */
function localInput(iso: unknown): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

const drawNames = { Polygon: 'ポリゴン', LineString: 'ライン', Point: 'ポイント' } as const;

export class GpDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly service_: HTMLSelectElement;
  private readonly url_: HTMLInputElement;
  private readonly token_: HTMLInputElement;
  private readonly task_: HTMLSelectElement;
  private readonly description_: HTMLElement;
  private readonly required_: HTMLElement;
  private readonly optional_: HTMLElement;
  private readonly more_: HTMLDetailsElement;
  private readonly status_: HTMLElement;
  private readonly progress_: HTMLProgressElement;
  private readonly results_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private readonly stop_: HTMLButtonElement;
  private service_info: GpService | null = null;
  private task: GpTask | null = null;
  /** Where the current task was read from: the token goes only to its host. */
  private serviceUrl = '';
  private layers_: ViewerService[] = [];
  /** Shapes drawn on the map, per parameter. */
  private readonly drawn = new Map<string, Feature[]>();
  private readonly drawSource = new VectorSource<Feature>();
  private readonly drawLayer = new VectorLayer({ source: this.drawSource, zIndex: 19_000 });
  private draw_: Draw | null = null;
  private abort_: AbortController | null = null;

  constructor(
    button: HTMLButtonElement | null,
    private readonly selection: Selection,
    private readonly options: GpDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service gp-dialog';
    this.dialog.setAttribute('aria-labelledby', 'gp-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="gp-title">サーバ処理</h2>
        <p class="wide processing-hint">ArcGIS の GP サービス（GPServer）や OGC API – Processes の処理をサーバーで実行し、結果をレイヤーとして開きます。</p>
        <label class="wide gp-service-choice" hidden>サービス<select name="gp-service" aria-label="サービス"></select></label>
        <label class="wide">URL<input name="gp-url" type="url" placeholder="https://…/GPServer、…/GPServer/タスク名、…/processes など" aria-label="処理サービスの URL" /></label>
        <label>トークン（任意）<input name="gp-token" type="password" autocomplete="off" aria-label="トークン" /></label>
        <button type="submit" value="read" class="read">読み込む</button>
        <label class="wide gp-task-choice" hidden>処理<select name="gp-task" aria-label="処理"></select></label>
        <p class="wide processing-hint gp-description"></p>
        <div class="wide service-form gp-params"></div>
        <details class="wide composite-more gp-more" hidden><summary>詳細</summary><div class="service-form gp-optional"></div></details>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <progress class="gp-progress" max="100" hidden></progress>
      <div class="gp-results" aria-label="処理の結果" hidden></div>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="stop" hidden>取り消し</button>
        <button type="button" value="run" class="primary" disabled>実行</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.service_ = this.form_.elements.namedItem('gp-service') as HTMLSelectElement;
    this.url_ = this.form_.elements.namedItem('gp-url') as HTMLInputElement;
    this.token_ = this.form_.elements.namedItem('gp-token') as HTMLInputElement;
    this.task_ = this.form_.elements.namedItem('gp-task') as HTMLSelectElement;
    this.description_ = this.dialog.querySelector('.gp-description')!;
    this.required_ = this.dialog.querySelector('.gp-params')!;
    this.optional_ = this.dialog.querySelector('.gp-optional')!;
    this.more_ = this.dialog.querySelector('.gp-more')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.progress_ = this.dialog.querySelector('.gp-progress')!;
    this.results_ = this.dialog.querySelector('.gp-results')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.stop_ = this.dialog.querySelector('button[value=stop]')!;
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.read();
    });
    this.service_.addEventListener('change', () => {
      const chosen = this.options.services()[Number(this.service_.value)];
      if (!chosen) return;
      this.url_.value = chosen.url;
      this.token_.value = chosen.token ?? '';
      void this.read();
    });
    this.task_.addEventListener('change', () => void this.chooseTask(Number(this.task_.value)));
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    this.stop_.addEventListener('click', () => this.abort_?.abort());
    this.dialog.addEventListener('close', () => {
      // Drawn shapes stay only while they can still be used.
      if (!this.draw_) this.drawLayer.setMap(null);
    });
    button?.addEventListener('click', () => this.open());
  }

  /** Opens the dialog; the first configured service is read when nothing is yet. */
  open(): void {
    const services = this.options.services();
    const choice = this.dialog.querySelector<HTMLElement>('.gp-service-choice')!;
    choice.hidden = services.length === 0;
    const before = this.service_.value;
    this.service_.replaceChildren(...services.map((s, i) => new Option(s.label, String(i))));
    if (before && Number(before) < services.length) this.service_.value = before;
    if (this.task) this.renderParams_();
    else if (services.length && !this.url_.value) {
      this.url_.value = services[0].url;
      this.token_.value = services[0].token ?? '';
      void this.read();
    }
    if (this.drawn.size) this.drawLayer.setMap(this.options.map);
    this.dialog.showModal();
  }

  private token_value(): string | undefined {
    return gpToken(this.serviceUrl || this.url_.value, this.token_.value);
  }

  /** Reads the service or task at the URL. */
  async read(): Promise<void> {
    const url = this.url_.value.trim();
    this.service_info = null;
    this.task = null;
    this.drawn.clear();
    this.drawSource.clear();
    this.task_.replaceChildren();
    this.dialog.querySelector<HTMLElement>('.gp-task-choice')!.hidden = true;
    this.renderParams_();
    this.results_.hidden = true;
    if (!safeUrl(url)) {
      this.status_.textContent = 'http(s) の URL を入れてください';
      return;
    }
    this.serviceUrl = url;
    this.status_.textContent = '読み込んでいます…';
    try {
      const read = await readGp(url, this.token_value());
      if ('task' in read) {
        this.setTask_(read.task);
        return;
      }
      this.service_info = read.service;
      if (!read.service.tasks.length) throw new Error('処理がありません');
      const choice = this.dialog.querySelector<HTMLElement>('.gp-task-choice')!;
      choice.hidden = false;
      this.task_.replaceChildren(...read.service.tasks.map((t, i) => new Option(t.title === t.id ? t.title : `${t.title}（${t.id}）`, String(i))));
      this.status_.textContent = `${read.service.kind === 'esri' ? 'GP サービス' : 'OGC API – Processes'}「${read.service.title}」: ${read.service.tasks.length} 件の処理`;
      await this.chooseTask(0);
    } catch (error) {
      this.status_.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Reads one task of the service and shows its form. */
  async chooseTask(index: number): Promise<void> {
    const ref = this.service_info?.tasks[index];
    if (!ref || !this.service_info) return;
    this.task_.value = String(index);
    this.task = null;
    this.drawn.clear();
    this.drawSource.clear();
    this.renderParams_();
    this.status_.textContent = `「${ref.title}」を読んでいます…`;
    try {
      this.setTask_(await readTask({ kind: this.service_info.kind, url: ref.url }, this.token_value()));
    } catch (error) {
      this.status_.textContent = `処理を読めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private setTask_(task: GpTask): void {
    this.task = task;
    // A GPServer lists its tasks by name only: their titles show once read.
    const option = this.task_.selectedOptions[0];
    if (option && this.service_info && task.title !== task.id) option.text = `${task.title}（${task.id}）`;
    this.renderParams_();
    const optional = task.inputs.filter((f) => !f.required).length;
    this.status_.textContent = `「${task.title}」${task.async ? '（ジョブで実行）' : ''}: 入力 ${task.inputs.length} 件${optional ? `（うち任意 ${optional} 件は「詳細」）` : ''}`;
  }

  /** The vector layers a field can take. */
  private layerChoices_(field: GpField): Array<[number, ViewerService]> {
    return this.layers_.flatMap((l, i): Array<[number, ViewerService]> => (field.type === 'table' || !l.service.tableOnly ? [[i, l]] : []));
  }

  /** Fills the form of the current task. */
  private renderParams_(): void {
    const task = this.task;
    this.layers_ = this.options.layers().filter((l): l is ViewerService => l.type === 'service' && !!l.service.vector);
    this.description_.textContent = task?.description ?? '';
    const required = task?.inputs.filter((f) => f.required) ?? [];
    const optional = task?.inputs.filter((f) => !f.required) ?? [];
    // Keep what was typed when the form is drawn again (new layers to choose from).
    const typed = new FormData(this.form_);
    this.required_.replaceChildren(...required.map((f) => this.control_(f, typed)));
    this.optional_.replaceChildren(...optional.map((f) => this.control_(f, typed)));
    this.more_.hidden = optional.length === 0;
    this.run_.disabled = !task || !!this.abort_;
  }

  /** The control of one parameter. */
  private control_(field: GpField, typed: FormData): HTMLElement {
    const name = field.name;
    const previous = typed.get(name);
    const title = field.description;
    const label = field.required ? field.label : `${field.label}（任意）`;
    const wrap = (control: HTMLElement, wide = true) => el('label', { className: wide ? 'wide' : '', title }, label, control);
    const value = (fallback: unknown) => (typeof previous === 'string' ? previous : fallback === undefined || fallback === null ? '' : String(fallback));
    switch (field.type) {
      case 'choice': {
        const select = el('select', { name, 'aria-label': field.label });
        if (!field.required) select.append(new Option('（指定しない）', ''));
        select.append(...(field.choices ?? []).map((c) => new Option(String(c), String(c))));
        select.value = value(field.default ?? (field.required ? field.choices?.[0] : ''));
        return wrap(select);
      }
      case 'integer':
      case 'number':
        return wrap(el('input', { name, type: 'number', step: field.type === 'integer' ? '1' : 'any', value: value(field.default), 'aria-label': field.label, ...(field.min !== undefined ? { min: String(field.min) } : {}), ...(field.max !== undefined ? { max: String(field.max) } : {}) }));
      case 'boolean': {
        const box = el('input', { name, type: 'checkbox', checked: previous !== null ? previous === 'on' : field.default === true, 'aria-label': field.label });
        return el('label', { className: 'wide check', title }, box, el('span', {}, field.label));
      }
      case 'date':
        return wrap(el('input', { name, type: 'datetime-local', value: typeof previous === 'string' ? previous : localInput(field.default), 'aria-label': field.label }));
      case 'linear-unit': {
        const units = el('select', { name: `${name}.units`, 'aria-label': `${field.label}の単位` });
        units.append(...Object.entries(linearUnitNames).map(([k, n]) => new Option(n, k)));
        units.value = value(typed.get(`${name}.units`) ?? field.units ?? 'esriMeters');
        return el('div', { className: 'wide gp-row', title }, wrap(el('input', { name, type: 'number', step: 'any', value: value(field.default), 'aria-label': field.label }), false), units);
      }
      case 'raster':
      case 'file':
        return wrap(el('input', { name, type: 'text', inputMode: 'url', placeholder: 'https://…', value: value(field.default), 'aria-label': field.label }));
      case 'json':
      case 'multi':
        return wrap(el('textarea', { name, rows: field.type === 'json' ? 3 : 1, value: value(field.default), placeholder: field.type === 'multi' ? `カンマ区切り${field.choices ? `（${field.choices.slice(0, 5).join(', ')}…）` : ''}` : 'JSON', 'aria-label': field.label }));
      case 'features':
      case 'table':
        return this.layerControl_(field, typed);
      default:
        return wrap(el('input', { name, type: 'text', value: value(field.default), 'aria-label': field.label }));
    }
  }

  /** A layer to send (all its features or the selected ones), or (features) shapes drawn on the map. */
  private layerControl_(field: GpField, typed: FormData): HTMLElement {
    const name = field.name;
    const select = el('select', { name, 'aria-label': field.label });
    if (!field.required) select.append(new Option('（指定しない）', ''));
    for (const [i, l] of this.layerChoices_(field)) select.append(new Option(l.name, `layer:${i}`));
    const drawn = this.drawn.get(name) ?? [];
    if (field.type === 'features') select.append(new Option(drawn.length ? `地図に描いた図形（${drawn.length} 個）` : '地図に描く…', 'draw'));
    const previous = typed.get(name);
    if (typeof previous === 'string' && [...select.options].some((o) => o.value === previous)) select.value = previous;
    else if (drawn.length) select.value = 'draw';
    const selected = el('input', { name: `${name}.selected`, type: 'checkbox', checked: typed.get(`${name}.selected`) === 'on' });
    const selectedLabel = el('label', { className: 'check' }, selected, el('span', {}, '選択中の地物だけ'));
    const row = el('div', { className: 'wide gp-row' }, selectedLabel);
    if (field.type === 'features') {
      const type = el('select', { name: `${name}.draw`, 'aria-label': `${field.label}に描く図形` });
      type.append(...Object.entries(drawNames).map(([k, n]) => new Option(n, k)));
      type.hidden = !!field.geometry;
      if (field.geometry) type.value = field.geometry;
      const drawButton = el('button', { type: 'button', className: 'gp-draw', textContent: drawn.length ? '描き足す' : '地図に描く' });
      drawButton.addEventListener('click', () => this.startDraw_(field, type.value as keyof typeof drawNames));
      const clear = el('button', { type: 'button', textContent: '描いた図形を消す', hidden: drawn.length === 0 });
      clear.addEventListener('click', () => {
        for (const f of this.drawn.get(name) ?? []) this.drawSource.removeFeature(f);
        this.drawn.delete(name);
        this.renderParams_();
      });
      row.append(type, drawButton, clear);
    }
    const update = () => {
      const entry = select.value.startsWith('layer:') ? this.layers_[Number(select.value.slice(6))] : null;
      const count = entry ? this.selection.list().filter((f) => entry.service.vector!.source.hasFeature(f)).length : 0;
      selected.disabled = count === 0;
      if (count === 0) selected.checked = false;
      selectedLabel.querySelector('span')!.textContent = `選択中の地物だけ（${count.toLocaleString()} 件）`;
      selectedLabel.hidden = !entry;
    };
    select.addEventListener('change', () => {
      if (select.value === 'draw' && !this.drawn.get(name)?.length) this.startDraw_(field, (row.querySelector<HTMLSelectElement>('select')?.value ?? 'Polygon') as keyof typeof drawNames);
      update();
    });
    update();
    return el('div', { className: 'wide gp-layer', title: field.description }, el('label', {}, field.required ? field.label : `${field.label}（任意）`, select), row);
  }

  /** Draws one shape on the map for `field` (the dialog steps aside meanwhile). */
  private startDraw_(field: GpField, type: keyof typeof drawNames): void {
    if (this.draw_) return;
    const map = this.options.map;
    this.drawLayer.setMap(map);
    const draw = new Draw({ source: this.drawSource, type });
    this.draw_ = draw;
    const typed = new FormData(this.form_);
    const finish = (feature: Feature | null) => {
      map.removeInteraction(draw);
      document.removeEventListener('keydown', onKey, true);
      this.draw_ = null;
      if (feature) this.drawn.set(field.name, [...(this.drawn.get(field.name) ?? []), feature]);
      this.dialog.showModal();
      this.renderParams_();
      // What was typed before drawing, back in place.
      for (const [key, value] of typed) {
        const control = this.form_.elements.namedItem(key);
        if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = value === 'on';
        else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.value = String(value);
      }
      const select = this.form_.elements.namedItem(field.name);
      if (feature && select instanceof HTMLSelectElement) {
        select.value = 'draw';
        select.dispatchEvent(new Event('change'));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      draw.abortDrawing();
      finish(null);
    };
    draw.on('drawend', (e) => setTimeout(() => finish(e.feature as Feature)));
    document.addEventListener('keydown', onKey, true);
    map.addInteraction(draw);
    this.dialog.close();
    this.options.say(`「${field.label}」の${drawNames[type]}を地図に描いてください（${type === 'Point' ? 'クリック' : 'ダブルクリックで終わり'}、Esc で取り消し）`);
  }

  /** The form's values, as the task takes them. */
  private values_(task: GpTask): Record<string, GpValue> {
    const form = new FormData(this.form_);
    const values: Record<string, GpValue> = {};
    for (const field of task.inputs) {
      const raw = form.get(field.name);
      const text = typeof raw === 'string' ? raw.trim() : '';
      switch (field.type) {
        case 'boolean':
          values[field.name] = raw === 'on';
          break;
        case 'integer':
        case 'number':
          values[field.name] = text === '' ? null : Number(text);
          break;
        case 'choice': {
          const choice = field.choices?.find((c) => String(c) === text);
          values[field.name] = text === '' ? null : (choice ?? text);
          break;
        }
        case 'linear-unit':
          values[field.name] = text === '' ? null : { distance: Number(text), units: String(form.get(`${field.name}.units`) ?? field.units ?? 'esriMeters') };
          break;
        case 'date':
          values[field.name] = text === '' ? null : new Date(text).toISOString();
          break;
        case 'features':
        case 'table': {
          if (text === 'draw') {
            values[field.name] = { features: this.drawn.get(field.name) ?? [], fields: [] };
            break;
          }
          const entry = text.startsWith('layer:') ? this.layers_[Number(text.slice(6))] : null;
          const vector = entry?.service.vector;
          if (!vector) {
            values[field.name] = null;
            break;
          }
          const features = form.get(`${field.name}.selected`) === 'on' ? this.selection.list().filter((f) => vector.source.hasFeature(f)) : vector.source.getFeatures();
          values[field.name] = { features, fields: vector.fields };
          break;
        }
        default:
          values[field.name] = text === '' ? null : text;
      }
    }
    return values;
  }

  /** Runs the task with the form's values and opens what it makes. */
  async run(): Promise<void> {
    const task = this.task;
    if (!task || this.abort_) return;
    const abort = new AbortController();
    this.abort_ = abort;
    this.run_.disabled = true;
    this.stop_.hidden = !task.async;
    this.results_.hidden = true;
    this.progress_.hidden = false;
    this.progress_.removeAttribute('value');
    try {
      const token = this.token_value();
      const result = await runTask(task, this.values_(task), token, {
        signal: abort.signal,
        onStatus: (text, percent) => {
          this.status_.textContent = text;
          if (percent !== undefined && Number.isFinite(percent)) this.progress_.value = Math.max(0, Math.min(100, percent));
        },
      });
      await this.show_(task, result, token);
    } catch (error) {
      this.status_.textContent = error instanceof GpCancelled ? '取り消しました' : `実行できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.abort_ = null;
      this.stop_.hidden = true;
      this.progress_.hidden = true;
      this.run_.disabled = !this.task;
    }
  }

  /** Opens the results that are layers, and lists them all in the dialog. */
  private async show_(task: GpTask, result: RunResult, token?: string): Promise<void> {
    const host = (() => {
      try {
        return new URL(task.url).host;
      } catch {
        return '';
      }
    })();
    const made = `サーバ処理「${task.title}」（${host}）`;
    const items: HTMLElement[] = [];
    const link = (label: string, url: string, note = '') => el('li', {}, `${label}: `, el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: url }), note);
    let layers = 0;
    for (const output of result.outputs) {
      try {
        items.push(await this.open_(output, task, made));
        if (output.kind === 'features' && output.features.length) layers++;
        if (output.kind === 'image') layers++;
      } catch (error) {
        if (output.kind === 'image' || output.kind === 'link') items.push(link(output.label, output.url, `（開けませんでした: ${error instanceof Error ? error.message : String(error)}）`));
        else items.push(el('li', {}, `${output.label}: 開けませんでした（${error instanceof Error ? error.message : String(error)}）`));
      }
    }
    if (result.mapServer) {
      try {
        await this.options.addMapServer(result.mapServer, token);
        items.push(el('li', {}, '結果のマップサービスをレイヤーに追加しました'));
        layers++;
      } catch {
        items.push(link('結果のマップサービス', result.mapServer));
      }
    }
    if (!items.length) items.push(el('li', {}, '結果はありませんでした'));
    const messages = result.messages.length ? [el('details', { className: 'gp-messages' }, el('summary', {}, `メッセージ（${result.messages.length} 件）`), el('pre', { textContent: result.messages.join('\n') }))] : [];
    this.results_.replaceChildren(el('h3', {}, '結果'), el('ul', {}, ...items), ...messages);
    this.results_.hidden = false;
    this.status_.textContent = `「${task.title}」を実行しました${layers ? `（${layers} 件をレイヤーに追加）` : ''}`;
    this.options.say(this.status_.textContent);
  }

  /** Opens one output (a layer, when it is one) and says what became of it. */
  private async open_(output: GpOutput, task: GpTask, made: string): Promise<HTMLElement> {
    switch (output.kind) {
      case 'features': {
        if (!output.features.length) return el('li', {}, `${output.label}: 0 件`);
        const crs = output.srs && output.srs.startsWith('EPSG:') && output.srs !== 'EPSG:3857' && output.srs !== 'EPSG:4326' ? await targetCrs(output.srs).catch(() => undefined) : undefined;
        const title = `${task.title} ${output.label}`;
        const notes = output.truncated ? [`${output.features.length.toLocaleString()} 件で打ち切りました`] : [];
        await this.options.onFeatures({ title, features: output.features, fields: copyFields(output.fields), ...(crs ? { crs } : {}), notes }, `${made} ${output.label}`);
        return el('li', {}, `${output.label}: 一時レイヤー「${title}」（${output.features.length.toLocaleString()} 件${output.truncated ? '、打ち切り' : ''}）`);
      }
      case 'image':
        await this.options.openImage(output.url);
        return el('li', {}, `${output.label}: 画像をレイヤーとして開きました`);
      case 'link':
        return el('li', {}, `${output.label}: `, el('a', { href: output.url, target: '_blank', rel: 'noopener noreferrer', textContent: output.url }));
      case 'value':
        return el('li', {}, `${output.label}: `, el('span', { className: 'gp-value', textContent: output.text }));
    }
  }
}

