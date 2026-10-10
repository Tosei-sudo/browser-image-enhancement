/**
 * 「DB へ転記」 (ツール → AI): writes an AI layer's features (as the model made
 * them, corrected, or added by hand) to an Esri feature layer of
 * `config.json`'s `detectionOutputs`, its attributes mapped by role. New
 * features are added, features changed since they were sent are updated,
 * the rest are left; what was sent is kept with the layer, so the next
 * transfer carries on from there.
 */
import type Feature from 'ol/Feature.js';
import type { ViewerLayer, ViewerService } from './images.js';
import type { Selection } from './selection.js';
import { applyEdits, esriGeometry, esriJson, type EsriLayerInfo } from './services/esri.js';
import {
  actionOf,
  markSent,
  missingFields,
  signatureOf,
  statusLabels,
  statusOf,
  targetGeometry,
  transferAttributes,
  transferRoles,
  type DetectionOutput,
  type DetectionStatus,
  type TargetField,
  type TransferRole,
} from './ai/transfer.js';

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Features per applyEdits request. */
const BATCH = 250;

export interface TransferDialogOptions {
  outputs: DetectionOutput[];
  layers: () => readonly ViewerLayer[];
  selected: () => ViewerLayer | null;
  say: (message: string) => void;
}

/** The target layer as its REST description gives it. */
interface Target {
  info: EsriLayerInfo;
  fields: Map<string, TargetField>;
}

/** What a transfer would do. */
interface Plan {
  adds: Array<{ feature: Feature; attributes: Record<string, unknown>; geometry: object; signature: string }>;
  updates: Array<{ feature: Feature; id: number; attributes: Record<string, unknown>; geometry: object; signature: string }>;
  same: number;
  skipped: number;
  statuses: Record<DetectionStatus, number>;
}

/** Whether a layer is one the AI tools made (or looks like one: it has a class). */
const isAiLayer = (l: ViewerLayer): l is ViewerService => l.type === 'service' && !!l.service.vector && l.service.vector.fields.some((f) => f.name === 'class');

export class TransferDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly source_: HTMLSelectElement;
  private readonly target_: HTMLSelectElement;
  private readonly selectedOnly_: HTMLInputElement;
  private readonly plan_: HTMLElement;
  private readonly mapping_: HTMLElement;
  private readonly note_: HTMLElement;
  private readonly run_: HTMLButtonElement;
  private layers_: ViewerService[] = [];
  private targets_ = new Map<string, Promise<Target>>();

  constructor(
    button: HTMLButtonElement,
    private readonly selection: Selection,
    private readonly options: TransferDialogOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service processing-dialog ai-transfer-dialog';
    this.dialog.setAttribute('aria-labelledby', 'ai-transfer-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="ai-transfer-title">検出結果を DB へ転記</h2>
        <label class="wide">転記するレイヤー<select name="source" aria-label="転記するレイヤー"></select></label>
        <label class="wide">転記先<select name="target" aria-label="転記先">${options.outputs.map((o, i) => `<option value="${i}">${escape(o.label)}</option>`).join('')}</select></label>
        <label class="wide check"><input name="selectedOnly" type="checkbox" /><span>選択中の地物だけ</span></label>
        <p class="wide processing-hint ai-transfer-plan" role="status"></p>
        <details class="wide pansharpen-more">
          <summary>属性の対応</summary>
          <div class="ai-transfer-mapping"></div>
        </details>
      </form>
      <p class="service-status processing-note" role="status"></p>
      <div class="service-actions">
        <button type="button" value="cancel">閉じる</button>
        <button type="button" value="run" class="primary">転記</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.source_ = this.form_.elements.namedItem('source') as HTMLSelectElement;
    this.target_ = this.form_.elements.namedItem('target') as HTMLSelectElement;
    this.selectedOnly_ = this.form_.elements.namedItem('selectedOnly') as HTMLInputElement;
    this.plan_ = this.dialog.querySelector('.ai-transfer-plan')!;
    this.mapping_ = this.dialog.querySelector('.ai-transfer-mapping')!;
    this.note_ = this.dialog.querySelector('.processing-note')!;
    this.run_ = this.dialog.querySelector('button[value=run]')!;
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.run_.addEventListener('click', () => void this.run());
    for (const control of [this.source_, this.target_, this.selectedOnly_]) control.addEventListener('change', () => void this.describe_());
    button.addEventListener('click', () => this.open());
  }

  open(): void {
    this.layers_ = this.options.layers().filter(isAiLayer);
    this.source_.replaceChildren(...this.layers_.map((l, i) => new Option(l.name, String(i))));
    const selected = this.options.selected();
    const at = this.layers_.findIndex((l) => l === selected);
    if (at >= 0) this.source_.value = String(at);
    const count = this.selectedFeatures_().length;
    this.selectedOnly_.checked = count > 0;
    this.note_.textContent = '';
    void this.describe_();
    this.dialog.showModal();
  }

  private layer_(): ViewerService | null {
    return this.layers_[Number(this.source_.value)] ?? null;
  }

  private output_(): DetectionOutput | null {
    return this.options.outputs[Number(this.target_.value)] ?? null;
  }

  private selectedFeatures_(): Feature[] {
    const source = this.layer_()?.service.vector?.source;
    return source ? this.selection.list().filter((f) => source.hasFeature(f)) : [];
  }

  /** The target layer's description (read once per page). */
  private target(output: DetectionOutput): Promise<Target> {
    let target = this.targets_.get(output.url);
    if (!target) {
      target = (async () => {
        const json = await esriJson<{
          name: string;
          geometryType?: string;
          objectIdField?: string;
          capabilities?: string;
          fields?: Array<TargetField & { type: string }>;
        }>(output.url, {}, output.token);
        const caps = new Set((json.capabilities ?? '').split(',').map((c) => c.trim().toLowerCase()));
        const editing = caps.has('editing') && !caps.has('create') && !caps.has('update');
        const info: EsriLayerInfo = {
          url: output.url,
          name: json.name,
          geometryType: json.geometryType ?? '',
          objectIdField: json.objectIdField ?? json.fields?.find((f) => f.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID',
          canCreate: editing || caps.has('create'),
          canUpdate: editing || caps.has('update'),
          canDelete: false,
          template: {},
          token: output.token,
        };
        return { info, fields: new Map((json.fields ?? []).map((f) => [f.name.toLowerCase(), f])) };
      })();
      target.catch(() => this.targets_.delete(output.url));
      this.targets_.set(output.url, target);
    }
    return target;
  }

  /** What would be sent: new features to add, changed ones to update. */
  private plan(features: Feature[], output: DetectionOutput, target: Target): Plan {
    const now = Date.now();
    const plan: Plan = { adds: [], updates: [], same: 0, skipped: 0, statuses: { ai: 0, corrected: 0, manual: 0 } };
    const sentAt = output.fields.sentAt && target.fields.get(output.fields.sentAt.toLowerCase())?.name;
    for (const feature of features) {
      const geometry = feature.getGeometry();
      const shape = geometry && targetGeometry(geometry, target.info.geometryType);
      if (!shape) {
        plan.skipped++;
        continue;
      }
      plan.statuses[statusOf(feature)]++;
      const attributes = transferAttributes(feature, output, target.fields, now);
      const esri = esriGeometry(shape);
      const signature = signatureOf(attributes, esri, sentAt);
      const action = actionOf(feature, output.url, signature);
      if (action.kind === 'add') plan.adds.push({ feature, attributes, geometry: esri, signature });
      else if (action.kind === 'update') plan.updates.push({ feature, id: action.id, attributes, geometry: esri, signature });
      else plan.same++;
    }
    return plan;
  }

  private features_(): Feature[] {
    const layer = this.layer_();
    if (!layer) return [];
    return this.selectedOnly_.checked ? this.selectedFeatures_() : layer.service.vector!.source.getFeatures();
  }

  /** Shows what a transfer would do, and how the attributes are mapped. */
  private async describe_(): Promise<void> {
    const output = this.output_();
    const layer = this.layer_();
    const count = this.selectedFeatures_().length;
    this.selectedOnly_.disabled = count === 0;
    if (count === 0) this.selectedOnly_.checked = false;
    this.selectedOnly_.nextElementSibling!.textContent = `選択中の地物だけ（${count.toLocaleString()} 件）`;
    this.run_.disabled = true;
    this.mapping_.replaceChildren();
    if (!output) return void (this.plan_.textContent = '転記先がありません。config.json の detectionOutputs に Esri フィーチャーレイヤーと属性の対応を書いてください');
    if (!layer) return void (this.plan_.textContent = '転記できるレイヤーがありません。先に「物体検出」か「クリックで抽出」で結果を作ってください');
    this.plan_.textContent = '転記先を確認しています…';
    try {
      const target = await this.target(output);
      const rows = (Object.entries(output.fields) as Array<[TransferRole, string]>).map(([role, name]) => [transferRoles[role], name]);
      rows.push(...Object.entries(output.constants).map(([name, value]) => [`固定値 ${JSON.stringify(value)}`, name]));
      const missing = new Set(missingFields(output, target.fields));
      const list = document.createElement('dl');
      list.className = 'ai-transfer-fields';
      for (const [role, name] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = role;
        const dd = document.createElement('dd');
        dd.textContent = missing.has(name) ? `${name}（転記先にない・書けない属性）` : name;
        dd.classList.toggle('missing', missing.has(name));
        list.append(dt, dd);
      }
      this.mapping_.append(list);
      if (!target.info.canCreate) return void (this.plan_.textContent = `${target.info.name} は追加できないレイヤーです（サービスで作成を許可してください）`);
      if (!['esriGeometryPolygon', 'esriGeometryPoint'].includes(target.info.geometryType)) {
        return void (this.plan_.textContent = `${target.info.name} はポリゴンかポイントのレイヤーにしてください`);
      }
      const plan = this.plan(this.features_(), output, target);
      const statuses = (Object.entries(plan.statuses) as Array<[DetectionStatus, number]>)
        .filter(([, n]) => n)
        .map(([s, n]) => `${statusLabels[s]} ${n}`)
        .join('・');
      this.plan_.textContent = [
        `${target.info.name}（${target.info.geometryType === 'esriGeometryPoint' ? 'ポイント：中心点を転記' : 'ポリゴン'}）へ`,
        `新規 ${plan.adds.length} 件・更新 ${plan.updates.length} 件・転記済みで変更なし ${plan.same} 件`,
        statuses && `（${statuses}）`,
        plan.skipped ? `。形が合わない ${plan.skipped} 件は送りません` : '',
        missing.size ? `。転記先にない属性 ${missing.size} 個は書きません` : '',
      ].join('');
      this.run_.disabled = plan.adds.length + plan.updates.length === 0 || (plan.updates.length > 0 && !target.info.canUpdate && plan.adds.length === 0);
    } catch (error) {
      this.plan_.textContent = `転記先を読めませんでした: ${message(error)}`;
    }
  }

  /** Sends the new and changed features. */
  async run(): Promise<void> {
    const output = this.output_();
    const layer = this.layer_();
    if (!output || !layer) return;
    this.run_.disabled = true;
    let added = 0;
    let updated = 0;
    const failures: string[] = [];
    try {
      const target = await this.target(output);
      const plan = this.plan(this.features_(), output, target);
      const updates = target.info.canUpdate ? plan.updates : [];
      if (plan.updates.length && !target.info.canUpdate) failures.push(`更新できないレイヤーなので、変更した ${plan.updates.length} 件は送りません`);
      for (let i = 0; i < Math.max(plan.adds.length, updates.length); i += BATCH) {
        this.note_.textContent = `転記しています… ${Math.min(i + BATCH, Math.max(plan.adds.length, updates.length))} / ${Math.max(plan.adds.length, updates.length)}`;
        const adds = plan.adds.slice(i, i + BATCH);
        const ups = updates.slice(i, i + BATCH);
        const result = await applyEdits(target.info, {
          adds: adds.map((a) => ({ attributes: a.attributes, geometry: a.geometry })),
          updates: ups.map((u) => ({ attributes: { ...u.attributes, [target.info.objectIdField]: u.id }, geometry: u.geometry })),
          deletes: [],
        });
        result.addResults.forEach((r, k) => {
          if (r.success && r.objectId !== undefined) {
            markSent(adds[k].feature, output.url, r.objectId, adds[k].signature);
            added++;
          } else failures.push(r.error?.description ?? '追加できませんでした');
        });
        result.updateResults.forEach((r, k) => {
          if (r.success) {
            markSent(ups[k].feature, output.url, ups[k].id, ups[k].signature);
            updated++;
          } else failures.push(r.error?.description ?? '更新できませんでした');
        });
      }
    } catch (error) {
      failures.push(message(error));
    } finally {
      // What was sent is kept with a temporary layer (in the browser), so the next transfer carries on.
      if (layer.service.temp && (added || updated)) await layer.service.editTarget?.save({ adds: [], updates: [], deletes: [] }).catch(() => {});
    }
    const done = `${output.label} へ ${added} 件を追加、${updated} 件を更新しました`;
    const failed = failures.length ? `（失敗 ${failures.length} 件: ${[...new Set(failures)].slice(0, 3).join('、')}）` : '';
    this.options.say(done + failed);
    this.note_.textContent = done + failed;
    await this.describe_();
  }
}
