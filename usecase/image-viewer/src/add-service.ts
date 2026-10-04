/**
 * The "add a service" dialog: a URL (the kind is detected, or chosen), a
 * token for secured Esri services, then the service's layers to tick and
 * add. WMTS layers also pick their tile matrix set and image format.
 */
import { readService, serviceNames, type LayerChoice, type OpenContext, type ServiceCatalog, type ServiceKind, type ServiceLayer, type ServiceRef } from './services/index.js';

export interface AddServiceOptions {
  /** Called with each layer opened. */
  onAdd: (layer: ServiceLayer) => void;
  context: () => OpenContext;
}

export class AddServiceDialog {
  readonly dialog: HTMLDialogElement;
  private readonly form_: HTMLFormElement;
  private readonly url_: HTMLInputElement;
  private readonly kind_: HTMLSelectElement;
  private readonly token_: HTMLInputElement;
  private readonly list_: HTMLElement;
  private readonly status_: HTMLElement;
  private readonly add_: HTMLButtonElement;
  private catalog_: ServiceCatalog | null = null;

  constructor(
    button: HTMLButtonElement,
    private readonly options: AddServiceOptions,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service';
    this.dialog.setAttribute('aria-labelledby', 'add-service-title');
    this.dialog.innerHTML = `
      <form method="dialog" class="service-form">
        <h2 id="add-service-title">サービスを追加</h2>
        <label class="wide">URL<input name="url" type="url" required placeholder="https://…/wms、…/FeatureServer など" aria-label="サービスの URL" /></label>
        <label>種類<select name="kind" aria-label="サービスの種類">
          <option value="auto">自動判定</option>
          ${(Object.entries(serviceNames) as Array<[ServiceKind, string]>).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}
        </select></label>
        <label>トークン（Esri、任意）<input name="token" type="password" autocomplete="off" aria-label="トークン" /></label>
        <button type="submit" value="read" class="read">読み込む</button>
      </form>
      <p class="service-status" role="status"></p>
      <div class="service-layers"></div>
      <div class="service-actions">
        <button type="button" value="cancel">キャンセル</button>
        <button type="button" value="add" class="primary" disabled>追加</button>
      </div>`;
    document.body.append(this.dialog);
    this.form_ = this.dialog.querySelector('form')!;
    this.url_ = this.form_.elements.namedItem('url') as HTMLInputElement;
    this.kind_ = this.form_.elements.namedItem('kind') as HTMLSelectElement;
    this.token_ = this.form_.elements.namedItem('token') as HTMLInputElement;
    this.list_ = this.dialog.querySelector('.service-layers')!;
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.add_ = this.dialog.querySelector('button[value=add]')!;

    button.addEventListener('click', () => this.open());
    this.form_.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.read();
    });
    this.dialog.querySelector('button[value=cancel]')!.addEventListener('click', () => this.dialog.close());
    this.add_.addEventListener('click', () => void this.addChecked());
  }

  open(): void {
    this.dialog.showModal();
    this.url_.focus();
  }

  /** Reads the service at the URL and lists its layers. */
  async read(): Promise<void> {
    this.catalog_ = null;
    this.list_.replaceChildren();
    this.add_.disabled = true;
    this.status_.textContent = '読み込んでいます…';
    try {
      const catalog = await readService(this.url_.value.trim(), this.kind_.value as ServiceKind | 'auto', this.token_.value.trim() || undefined);
      this.catalog_ = catalog;
      this.status_.textContent = `${serviceNames[catalog.kind]}「${catalog.title}」: ${catalog.choices.length} レイヤー`;
      this.list_.replaceChildren(...catalog.choices.map((c) => this.row_(c, catalog.choices.length === 1)));
      this.updateAdd_();
    } catch (error) {
      this.status_.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Opens the ticked layers and adds them. */
  async addChecked(): Promise<void> {
    const catalog = this.catalog_;
    if (!catalog) return;
    const rows = [...this.list_.querySelectorAll<HTMLElement>('.service-layer')].filter((r) => r.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked);
    this.add_.disabled = true;
    this.status_.textContent = `${rows.length} レイヤーを読み込んでいます…`;
    const context = { ...this.options.context(), token: this.token_.value.trim() || undefined };
    const failures: string[] = [];
    // Bottom row first, so the list keeps the order shown here.
    for (const row of rows.reverse()) {
      const choice = catalog.choices[Number(row.dataset.index)];
      const pick = {
        matrixSet: row.querySelector<HTMLSelectElement>('select[name=matrixSet]')?.value,
        format: row.querySelector<HTMLSelectElement>('select[name=format]')?.value,
      };
      try {
        this.options.onAdd(await catalog.open(choice, context, pick));
      } catch (error) {
        failures.push(`${choice.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) {
      this.status_.textContent = `追加できなかったレイヤーがあります。${failures.join(' / ')}`;
      this.updateAdd_();
    } else {
      this.dialog.close();
    }
  }

  private row_(choice: LayerChoice, checked: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'service-layer';
    row.dataset.index = String(this.catalog_!.choices.indexOf(choice));
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => this.updateAdd_());
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = choice.title;
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = choice.name === choice.title ? '' : choice.name;
    label.append(box, title, name);
    if (choice.abstract) label.title = choice.abstract;
    row.append(label);
    const select = (field: string, text: string, values?: string[]) => {
      if (!values || values.length === 0) return;
      const l = document.createElement('label');
      l.className = 'pick';
      const s = document.createElement('select');
      s.name = field;
      s.append(...values.map((v) => new Option(v, v)));
      l.append(text, s);
      row.append(l);
    };
    select('matrixSet', 'タイル行列セット', choice.matrixSets);
    select('format', '画像形式', choice.formats);
    return row;
  }

  private updateAdd_(): void {
    this.add_.disabled = !this.list_.querySelector('input[type=checkbox]:checked');
  }
}

/** Opens one layer again from a link (`?service=`). */
export async function openRef(ref: ServiceRef, context: OpenContext): Promise<ServiceLayer> {
  const catalog = await readService(ref.url, ref.kind);
  const choice = catalog.choices.find((c) => c.name === ref.layer);
  if (!choice) throw new Error(`レイヤー ${ref.layer} が見つかりません`);
  return catalog.open(choice, context, { matrixSet: ref.matrixSet, format: ref.format });
}

/** A layer as a `service` URL parameter, and back. */
export function refToParam(ref: ServiceRef): string {
  return JSON.stringify(ref);
}

export function paramToRef(param: string): ServiceRef | null {
  try {
    const ref = JSON.parse(param) as ServiceRef;
    return ref && typeof ref.url === 'string' && typeof ref.layer === 'string' && ref.kind in serviceNames ? ref : null;
  } catch {
    return null;
  }
}
