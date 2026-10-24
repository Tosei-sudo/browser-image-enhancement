/**
 * The 「保存した計画」 panel: the imaging plans kept in the Esri feature
 * services of `config.json`'s `planStores` (imaging-plan-store.ts). It lists
 * the plans with how far each has got, and a chosen plan's shots on the map
 * and in a table, coloured by status. 「撮像を確認」 asks the image catalog
 * whether the shots whose moment has passed were taken (also done by itself
 * when a plan is opened); a shot's status can be set by hand, its image
 * opened, and a whole plan deleted.
 */
import type OlMap from 'ol/Map.js';
import Feature from 'ol/Feature.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import { MultiPolygon } from 'ol/geom.js';
import { fromLonLat } from 'ol/proj.js';
import { createEmpty, extend, isEmpty } from 'ol/extent.js';
import EsriJSON from 'ol/format/EsriJSON.js';
import { readCatalogLayer, recordOf, type CatalogConfig, type CatalogRecord } from './catalog.js';
import { quote } from './catalog-query.js';
import { deletePlan, listPlans, loadShots, progressText, STATUSES, trackShots, updateShots, type PlanStoreConfig, type SavedPlan, type SavedShot, type ShotStatus, type StoreAsk } from './imaging-plan-store.js';
import { localText } from './imaging-plan-panel.js';

export interface SavedPlansOptions {
  stores: PlanStoreConfig[];
  /** The image catalogs of config.json, for following the shots up. */
  catalogs: CatalogConfig[];
  ask: StoreAsk;
  /** Opens a catalog image (as the catalog panel does). */
  open: (record: CatalogRecord, catalog: CatalogConfig) => Promise<void>;
  say: (message: string) => void;
}

const colours: Record<ShotStatus, string> = { 予定: '#2563eb', 撮像済み: '#16a34a', 未撮像: '#dc2626', 取消: '#6b7280' };
const styleOf = (f: Feature) => {
  const colour = colours[f.get('status') as ShotStatus] ?? '#2563eb';
  return new Style({
    stroke: new Stroke({ color: colour, width: f.get('chosen') ? 3 : 1.5 }),
    fill: new Fill({ color: `${colour}33` }),
    text: f.get('chosen') ? new Text({ text: String(f.get('label') ?? ''), font: 'bold 12px sans-serif', overflow: true, fill: new Fill({ color: '#111' }), stroke: new Stroke({ color: '#fff', width: 3 }) }) : undefined,
  });
};
const format = new EsriJSON();

export class SavedPlansPanel {
  readonly dialog: HTMLDialogElement;
  /** The chosen plan's shots, while the panel is open. */
  readonly overlay = new VectorLayer({ source: new VectorSource<Feature>(), style: (f) => styleOf(f as Feature), zIndex: 1000 });
  private readonly status_: HTMLElement;
  private readonly plans_: HTMLTableSectionElement;
  private readonly shots_: HTMLTableSectionElement;
  private readonly storeSelect_: HTMLSelectElement;
  private store_: PlanStoreConfig | null;
  private list_: SavedPlan[] = [];
  private plan_: SavedPlan | null = null;
  private shotList_: SavedShot[] = [];
  private chosen_: SavedShot | null = null;

  constructor(
    private readonly map: OlMap,
    private readonly options: SavedPlansOptions,
  ) {
    this.store_ = options.stores[0] ?? null;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'add-service plan-saved-dialog';
    this.dialog.setAttribute('aria-labelledby', 'plan-saved-title');
    this.dialog.innerHTML = `
      <div class="catalog-head">
        <h2 id="plan-saved-title">保存した撮像計画</h2>
        <select name="store" aria-label="保存先" ${options.stores.length > 1 ? '' : 'hidden'}></select>
        <button type="button" class="catalog-close" aria-label="閉じる" title="閉じる（Esc）">×</button>
      </div>
      <p class="service-status" role="status"></p>
      <div class="catalog-results plan-saved-list"><table class="catalog-table"><thead><tr><th>計画</th><th>撮像</th><th>期間</th><th>状況</th></tr></thead><tbody></tbody></table></div>
      <div class="catalog-results plan-saved-shots" hidden><table class="catalog-table"><thead><tr><th>日時</th><th>衛星</th><th>対象</th><th>オフナディア角</th><th>状態</th><th>画像</th></tr></thead><tbody></tbody></table></div>
      <div class="service-actions catalog-actions">
        <button type="button" value="reload" title="保存先から計画を再読み込み">再読み込み</button>
        <button type="button" value="delete" disabled title="選んだ計画の撮像をすべて保存先から削除">計画を削除</button>
        <button type="button" value="track" disabled title="撮像時刻を過ぎた予定の撮像について、画像カタログへの画像の登録を確認">撮像を確認</button>
        <button type="button" value="zoom" class="primary" disabled>範囲へ移動</button>
      </div>`;
    document.body.append(this.dialog);
    this.status_ = this.dialog.querySelector('.service-status')!;
    this.plans_ = this.dialog.querySelector('.plan-saved-list tbody')!;
    this.shots_ = this.dialog.querySelector('.plan-saved-shots tbody')!;
    this.storeSelect_ = this.dialog.querySelector('select[name=store]')!;
    options.stores.forEach((s, i) => this.storeSelect_.add(new Option(s.label, String(i))));
    this.storeSelect_.addEventListener('change', () => {
      this.store_ = options.stores[Number(this.storeSelect_.value)] ?? null;
      void this.reload();
    });
    this.dialog.querySelector('.catalog-close')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => map.removeLayer(this.overlay));
    this.dialog.querySelector('button[value=reload]')!.addEventListener('click', () => void this.reload());
    this.dialog.querySelector('button[value=track]')!.addEventListener('click', () => void this.track(true));
    this.dialog.querySelector('button[value=zoom]')!.addEventListener('click', () => this.zoom());
    const remove = this.dialog.querySelector<HTMLButtonElement>('button[value=delete]')!;
    // Two steps, so one click never deletes a plan.
    remove.addEventListener('click', () => {
      if (remove.dataset.armed !== '1') {
        remove.dataset.armed = '1';
        remove.textContent = 'もう一度押すと削除';
        setTimeout(() => {
          remove.dataset.armed = '';
          remove.textContent = '計画を削除';
        }, 4000);
        return;
      }
      remove.dataset.armed = '';
      remove.textContent = '計画を削除';
      void this.remove();
    });
  }

  /** Opens the panel (on the plan `planId` when given). */
  async open(planId?: string): Promise<void> {
    if (!this.map.getLayers().getArray().includes(this.overlay)) this.map.addLayer(this.overlay);
    this.dialog.show();
    await this.reload();
    const plan = planId ? this.list_.find((p) => p.id === planId) : undefined;
    if (plan) await this.choose(plan);
  }

  /** The plans listed. */
  plans(): SavedPlan[] {
    return this.list_;
  }

  /** The chosen plan's shots. */
  shots(): SavedShot[] {
    return this.shotList_;
  }

  /** Reads the plans of the store again. */
  async reload(): Promise<void> {
    const store = this.store_;
    if (!store) return void (this.status_.textContent = 'config.json に計画の保存先（planStores）なし');
    this.status_.textContent = `${store.label} を読み込み中…`;
    try {
      this.list_ = await listPlans(store, this.options.ask);
    } catch (error) {
      this.status_.textContent = `読み込み失敗: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (store !== this.store_) return;
    const chosen = this.plan_?.id;
    this.plan_ = this.list_.find((p) => p.id === chosen) ?? null;
    this.renderPlans();
    this.status_.textContent = this.list_.length ? `${store.label}: ${this.list_.length} 件の計画。行の選択で撮像を地図に表示し、撮像を確認` : `${store.label} に保存した計画なし（撮像計画の「保存・追跡…」で保存）`;
    if (this.plan_) await this.choose(this.plan_, false);
  }

  private renderPlans(): void {
    const range = (p: SavedPlan) => (Number.isFinite(p.first) ? `${localText(p.first).slice(0, 10)}〜${localText(p.last).slice(5, 10)}` : '');
    this.plans_.replaceChildren(
      ...this.list_.map((plan) => {
        const row = document.createElement('tr');
        row.classList.toggle('chosen', plan === this.plan_);
        for (const text of [plan.name, String(plan.shots), range(plan), progressText(plan.statuses)]) {
          const td = document.createElement('td');
          td.textContent = text;
          row.append(td);
        }
        row.title = plan.created ? `保存 ${localText(plan.created)}` : '';
        row.addEventListener('click', () => void this.choose(plan));
        return row;
      }),
    );
    this.updateButtons();
  }

  /** Shows a plan's shots, and follows them up when some are due (`track`). */
  async choose(plan: SavedPlan, track = true): Promise<void> {
    const store = this.store_;
    if (!store) return;
    this.plan_ = plan;
    this.chosen_ = null;
    this.renderPlans();
    try {
      this.shotList_ = await loadShots(store, this.options.ask, plan.id);
    } catch (error) {
      this.status_.textContent = `撮像の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.renderShots();
    this.zoom();
    this.status_.textContent = `${plan.name}: ${this.shotList_.length} 回・${progressText(this.counts())}`;
    if (track && this.shotList_.some((s) => s.status === '予定' && s.time <= Date.now())) await this.track(false);
  }

  private counts(): Partial<Record<ShotStatus, number>> {
    const counts: Partial<Record<ShotStatus, number>> = {};
    for (const s of this.shotList_) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return counts;
  }

  /** The catalog the store follows its shots up in. */
  private catalog(): CatalogConfig | null {
    const store = this.store_;
    if (!store) return null;
    return (store.catalog ? this.options.catalogs.find((c) => c.label === store.catalog) : this.options.catalogs[0]) ?? null;
  }

  private renderShots(): void {
    const host = this.dialog.querySelector<HTMLElement>('.plan-saved-shots')!;
    host.hidden = !this.plan_;
    const catalog = this.catalog();
    this.shots_.replaceChildren(
      ...this.shotList_.map((shot) => {
        const row = document.createElement('tr');
        row.className = `plan-shot-${STATUSES.indexOf(shot.status)}`;
        row.classList.toggle('chosen', shot === this.chosen_);
        for (const text of [localText(shot.time), shot.satellite, shot.target, shot.offNadir === null ? '' : `${Math.round(shot.offNadir * 10) / 10}°`]) {
          const td = document.createElement('td');
          td.textContent = text;
          row.append(td);
        }
        const state = document.createElement('td');
        const select = document.createElement('select');
        select.setAttribute('aria-label', '状態');
        for (const s of STATUSES) select.add(new Option(s, s));
        select.value = shot.status;
        select.addEventListener('click', (e) => e.stopPropagation());
        select.addEventListener('change', () => void this.setStatus(shot, select.value as ShotStatus));
        state.append(select);
        const image = document.createElement('td');
        if (shot.imageId) {
          if (catalog?.fields.id) {
            const open = document.createElement('button');
            open.type = 'button';
            open.textContent = shot.imageId;
            open.title = '画像を開く';
            open.addEventListener('click', (e) => {
              e.stopPropagation();
              void this.openImage(shot, catalog);
            });
            image.append(open);
          } else image.textContent = shot.imageId;
        }
        row.append(state, image);
        row.addEventListener('click', () => {
          this.chosen_ = shot;
          this.renderShots();
          this.zoom();
        });
        return row;
      }),
    );
    this.draw();
    this.updateButtons();
  }

  private draw(): void {
    const source = this.overlay.getSource()!;
    source.clear();
    const projection = this.map.getView().getProjection();
    for (const shot of this.shotList_) {
      if (!shot.rings.length) continue;
      const polygons = shot.rings.map((ring) => [ring.map((c) => fromLonLat(c, projection))]);
      source.addFeature(new Feature({ geometry: new MultiPolygon(polygons), status: shot.status, chosen: shot === this.chosen_, label: `${shot.satellite} ${localText(shot.time).slice(5)}` }));
    }
  }

  private updateButtons(): void {
    const has = !!this.plan_;
    for (const v of ['delete', 'zoom']) this.dialog.querySelector<HTMLButtonElement>(`button[value=${v}]`)!.disabled = !has;
    this.dialog.querySelector<HTMLButtonElement>('button[value=track]')!.disabled = !has || !this.catalog();
  }

  /** Fits the view to the chosen shot, or the whole plan. */
  zoom(): void {
    const extent = createEmpty();
    for (const f of this.overlay.getSource()!.getFeatures()) if (!this.chosen_ || f.get('chosen')) extend(extent, f.getGeometry()!.getExtent());
    if (!isEmpty(extent)) this.map.getView().fit(extent, { padding: [60, 60, 60, 60], maxZoom: 12, duration: 250 });
  }

  /** Asks the catalog about the shots that are due, and saves what it finds. */
  async track(say: boolean): Promise<void> {
    const store = this.store_;
    const catalog = this.catalog();
    const plan = this.plan_;
    if (!store || !plan) return;
    if (!catalog) return void (this.status_.textContent = '撮像を確認する画像カタログ（config.json の imageCatalogs）なし');
    this.status_.textContent = `${catalog.label} で撮像を確認中…`;
    try {
      const { types } = await readCatalogLayer(catalog);
      const changes = await trackShots(store, catalog, types, this.options.ask, this.shotList_);
      await updateShots(store, this.options.ask, changes);
      for (const c of changes) {
        const shot = this.shotList_.find((s) => s.objectId === c.objectId);
        if (shot) Object.assign(shot, { status: c.status, ...(c.imageId !== undefined ? { imageId: c.imageId } : {}) });
      }
      plan.statuses = this.counts();
      this.renderPlans();
      this.renderShots();
      const taken = changes.filter((c) => c.status === '撮像済み').length;
      const missed = changes.length - taken;
      const text = changes.length ? `新たに撮像済み ${taken} 回${missed ? `・未撮像 ${missed} 回` : ''}` : '変わった撮像なし';
      this.status_.textContent = `${plan.name}: ${text}。${progressText(plan.statuses)}`;
      if (say && changes.length) this.options.say(`${plan.name}: ${text}`);
    } catch (error) {
      this.status_.textContent = `撮像の確認に失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async setStatus(shot: SavedShot, status: ShotStatus): Promise<void> {
    const store = this.store_;
    if (!store || !this.plan_) return;
    try {
      await updateShots(store, this.options.ask, [{ objectId: shot.objectId, status }]);
      shot.status = status;
      this.plan_.statuses = this.counts();
      this.renderPlans();
      this.renderShots();
    } catch (error) {
      this.status_.textContent = `保存失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async openImage(shot: SavedShot, catalog: CatalogConfig): Promise<void> {
    try {
      const json = await this.options.ask(`${catalog.url}/query`, { where: `${catalog.fields.id} = ${quote(shot.imageId)}`, outFields: '*', returnGeometry: 'true', outSR: '4326' }, catalog.token);
      const [feature] = format.readFeatures(json, { dataProjection: 'EPSG:4326', featureProjection: this.map.getView().getProjection() }) as Feature[];
      if (!feature) return void this.options.say(`${shot.imageId} が画像カタログになし`);
      await this.options.open(recordOf(feature, catalog.fields), catalog);
    } catch (error) {
      this.options.say(`画像の読み込みに失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async remove(): Promise<void> {
    const store = this.store_;
    const plan = this.plan_;
    if (!store || !plan) return;
    try {
      await deletePlan(store, this.options.ask, plan.id);
      this.plan_ = null;
      this.shotList_ = [];
      this.overlay.getSource()!.clear();
      this.options.say(`計画「${plan.name}」を削除`);
      await this.reload();
      this.renderShots();
    } catch (error) {
      this.status_.textContent = `削除失敗: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
