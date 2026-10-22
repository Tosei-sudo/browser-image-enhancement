/**
 * The satellites as a checklist in three folding levels: the kind (optical
 * or SAR), the series, then each satellite with its specifications. A
 * group's checkbox checks or clears everything in it and shows a dash when
 * only some are checked. Shared by the imaging plan (imaging-plan-panel.ts)
 * and the 「衛星パス」 panel (satellite-track-panel.ts).
 */
import { SAMPLE_SOURCE, tleEpoch, type SatelliteSpec } from './imaging-plan.js';

/** One listed satellite and its checkbox. */
export interface ListedSatellite {
  sat: SatelliteSpec;
  /** `source` and `id`: the same satellite again after a reload of the list. */
  key: string;
  box: HTMLInputElement;
  label: HTMLLabelElement;
}

export interface SatelliteTreeOptions {
  /** Called when checkboxes change (by the user, or by {@link SatelliteTree.checkAll}). */
  onChange?: () => void;
  /** Something to put before the name of each satellite (a colour swatch). */
  marker?: (sat: SatelliteSpec) => HTMLElement | null;
}

/** TLEs older than this (days) are marked. */
const OLD_TLE = 14;
const round = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);

export const satelliteKey = (sat: SatelliteSpec): string => `${sat.source}\n${sat.id}`;

export class SatelliteTree {
  private listed_: ListedSatellite[] = [];
  private groups_: Array<{ details: HTMLDetailsElement; box: HTMLInputElement; count: HTMLElement; members: ListedSatellite[] }> = [];

  /**
   * @param list where the tree goes
   * @param summary where 「（checked / all）」 is written
   */
  constructor(
    readonly list: HTMLElement,
    private readonly summary: HTMLElement | null,
    private readonly options: SatelliteTreeOptions = {},
  ) {
    list.addEventListener('change', (e) => {
      // A group's own checkbox handles itself.
      if ((e.target as HTMLElement).closest('summary')) return;
      this.count();
      this.options.onChange?.();
    });
  }

  /** The satellites listed, in list order. */
  items(): readonly ListedSatellite[] {
    return this.listed_;
  }

  /** The checked satellites. */
  checked(): SatelliteSpec[] {
    return this.listed_.filter((l) => l.box.checked).map((l) => l.sat);
  }

  /**
   * Lists `sats`, keeping which were checked; a satellite new to the list is
   * checked when `checkNew` says so (`first`: the list was empty).
   */
  set(sats: SatelliteSpec[], checkNew: (sat: SatelliteSpec, first: boolean) => boolean = () => true): void {
    const before = new Map(this.listed_.map((l) => [l.key, l.box.checked]));
    const open = new Set([...this.list.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.group));
    const first = !this.listed_.length;
    const now = Date.now();
    /** Satellites new to the list that start checked: their groups open, so they can be seen. */
    const added = new Set<string>();
    this.listed_ = sats.map((sat) => {
      const key = satelliteKey(sat);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = before.get(key) ?? checkNew(sat, first);
      if (!first && !before.has(key) && box.checked) added.add(key);
      return { sat, key, box, label: this.labelOf(sat, box, now) };
    });
    this.groups_ = [];
    // A folding group with a checkbox for everything in it.
    const group = (key: string, name: string, members: ListedSatellite[], body: HTMLElement[], level: number) => {
      const details = document.createElement('details');
      details.className = `plan-group plan-group-${level}`;
      details.dataset.group = key;
      // Kinds start open; series open when there are few satellites, or as they were.
      details.open = open.has(key) || (first && (level === 1 || this.listed_.length <= 8)) || members.some((m) => added.has(m.key));
      const summary = document.createElement('summary');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', `${name}をすべて選ぶ`);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        for (const m of members) m.box.checked = box.checked;
        this.count();
        this.options.onChange?.();
      });
      const count = document.createElement('span');
      count.className = 'plan-group-count';
      summary.append(box, document.createTextNode(name), count);
      details.append(summary, ...body);
      this.groups_.push({ details, box, count, members });
      return details;
    };
    const byKey = <T,>(items: T[], key: (t: T) => string) => {
      const map = new Map<string, T[]>();
      for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
      return [...map].sort((a, b) => a[0].localeCompare(b[0], 'ja', { numeric: true }));
    };
    const kinds = [
      { key: 'optical', name: '光学', members: this.listed_.filter((l) => !l.sat.sar) },
      { key: 'sar', name: 'SAR', members: this.listed_.filter((l) => l.sat.sar) },
    ].filter((k) => k.members.length);
    this.list.replaceChildren(
      ...kinds.map((kind) =>
        group(
          kind.key,
          kind.name,
          kind.members,
          byKey(kind.members, (l) => l.sat.series).map(([series, members]) =>
            group(
              `${kind.key}/${series}`,
              series,
              members,
              [...members].sort((a, b) => a.sat.name.localeCompare(b.sat.name, 'ja', { numeric: true })).map((m) => m.label),
              2,
            ),
          ),
          1,
        ),
      ),
    );
    this.count();
  }

  checkAll(on: boolean): void {
    for (const l of this.listed_) l.box.checked = on;
    this.count();
    this.options.onChange?.();
  }

  /** Checks the satellites named (or with these ids), clearing the rest. */
  checkOnly(names: readonly string[]): void {
    for (const l of this.listed_) l.box.checked = names.includes(l.sat.name) || names.includes(l.sat.id);
    this.count();
    this.options.onChange?.();
  }

  /**
   * Shows only the satellites whose name, id or series has all the words of
   * `text` (checked ones stay), with the groups holding them opened; an empty
   * text shows all again.
   */
  filter(text: string): void {
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const l of this.listed_) {
      const hay = `${l.sat.name} ${l.sat.id} ${l.sat.series}`.toLowerCase();
      l.label.hidden = !l.box.checked && !words.every((w) => hay.includes(w));
    }
    for (const g of this.groups_) {
      const shown = g.members.some((m) => !m.label.hidden);
      g.details.hidden = !shown;
      if (words.length && shown) g.details.open = true;
    }
  }

  /** Counts the checked satellites, overall and in each group (whose checkbox follows them). */
  count(): void {
    const on = this.listed_.filter((l) => l.box.checked).length;
    if (this.summary) this.summary.textContent = `（${on} / ${this.listed_.length}）`;
    for (const g of this.groups_) {
      const n = g.members.filter((m) => m.box.checked).length;
      g.box.checked = n === g.members.length;
      g.box.indeterminate = n > 0 && n < g.members.length;
      g.count.textContent = `${n} / ${g.members.length}`;
    }
  }

  /** A satellite's checkbox with its name, specifications and how old its TLE is. */
  private labelOf(sat: SatelliteSpec, box: HTMLInputElement, now: number): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'check';
    const age = (now - tleEpoch(sat)) / 86400000;
    const facts = [
      `最大 ${round(sat.maxOffNadir)}°`,
      sat.minOffNadir > 0 ? `最小 ${round(sat.minOffNadir)}°` : '',
      `幅 ${round(sat.swath)} km`,
      sat.scenesPerPass > 1 ? `連続 ${sat.scenesPerPass} シーン` : '',
      sat.minInterval > 0 ? `間隔 ${round(sat.minInterval)} 分` : '',
      sat.maxPerDay > 0 ? `1 日 ${sat.maxPerDay} 回` : '',
      sat.leadTime > 0 ? `${round(sat.leadTime)} 時間前までに発注` : '',
      sat.lookSide === 'both' ? '' : sat.lookSide === 'right' ? '右向き' : '左向き',
    ]
      .filter(Boolean)
      .join('・');
    const note = document.createElement('small');
    note.textContent = facts;
    label.title = sat.source === SAMPLE_SOURCE ? 'サンプル（決め打ちの軌道。実在の衛星ではありません）' : `${sat.source}${Number.isNaN(age) ? '' : `・TLE ${round(age, 0)} 日前`}`;
    const marker = this.options.marker?.(sat);
    label.append(box, ...(marker ? [marker] : []), document.createTextNode(sat.name), note);
    if (sat.source !== SAMPLE_SOURCE && Math.abs(age) > OLD_TLE) {
      const old = document.createElement('span');
      old.className = 'plan-old';
      old.textContent = 'TLE 古い';
      old.title = `TLE の元期が ${round(age, 0)} 日前です。予測がずれることがあります`;
      label.append(old);
    }
    return label;
  }
}
