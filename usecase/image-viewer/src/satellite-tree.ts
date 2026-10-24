/**
 * The satellites as a checklist in three folding levels: the kind (optical
 * or SAR), the series, then each satellite with its specifications. A
 * satellite with several imaging modes (sensor-modes.ts) is a fourth level:
 * a box per mode. A group's checkbox chooses everything in it (a satellite
 * by its usual mode, unless some of its modes are chosen already) or clears
 * it, and shows a dash when only some are chosen. Above the tree, a box per
 * mode name chooses that mode of every satellite at once. Shared by the
 * imaging plan (imaging-plan-panel.ts) and the 「衛星パス」 panel
 * (satellite-track-panel.ts).
 */
import { platformKey, SAMPLE_SOURCE, satelliteLabel, tleEpoch, type SatelliteSpec } from './imaging-plan.js';

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

export const satelliteKey = (sat: SatelliteSpec): string => `${platformKey(sat)}${sat.mode ? `\n${sat.mode}` : ''}`;

export class SatelliteTree {
  private listed_: ListedSatellite[] = [];
  private groups_: Array<{ details: HTMLDetailsElement; box: HTMLInputElement; count: HTMLElement; members: ListedSatellite[] }> = [];
  /** The boxes above the tree that choose one mode of every satellite. */
  private modes_: Array<{ box: HTMLInputElement; members: ListedSatellite[] }> = [];

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

  /** The checked satellites (an entry per checked mode). */
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
    const platforms = new Map<string, number>();
    for (const sat of sats) platforms.set(platformKey(sat), (platforms.get(platformKey(sat)) ?? 0) + 1);
    this.listed_ = sats.map((sat) => {
      const key = satelliteKey(sat);
      const box = document.createElement('input');
      box.type = 'checkbox';
      // A satellite's other modes start unchecked: it is chosen by its usual one.
      box.checked = before.get(key) ?? (sat.primary !== false && checkNew(sat, first));
      if (!first && !before.has(key) && box.checked) added.add(key);
      return { sat, key, box, label: this.labelOf(sat, box, now, platforms.get(platformKey(sat))! > 1) };
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
        this.choose(members, box.checked);
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
      ...this.modeBar(),
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
              byKey(members, (m) => m.sat.name).flatMap(([name, same]) =>
                // A satellite with several modes folds them under its name.
                byKey(same, (m) => platformKey(m.sat)).map(([key, modes]) => (modes.length > 1 ? group(`${kind.key}/${series}/${key}`, name, modes, modes.map((m) => m.label), 3) : modes[0].label)),
              ),
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
    this.choose(this.listed_, on);
    this.count();
    this.options.onChange?.();
  }

  /**
   * Checks the satellites named (or with these ids), by their usual modes,
   * clearing the rest; a name with its mode (「名前（モード）」, or the mode
   * after a space) checks just that mode.
   */
  checkOnly(names: readonly string[]): void {
    for (const l of this.listed_) l.box.checked = false;
    const all = new Set(names);
    const exact = this.listed_.filter((l) => l.sat.mode && (all.has(`${l.sat.name}（${l.sat.mode}）`) || all.has(`${l.sat.name} ${l.sat.mode}`) || all.has(`${l.sat.id} ${l.sat.mode}`)));
    for (const l of exact) l.box.checked = true;
    this.choose(
      this.listed_.filter((l) => all.has(l.sat.name) || all.has(l.sat.id)),
      true,
    );
    this.count();
    this.options.onChange?.();
  }

  /** Checks or clears every mode of a mode name (one of {@link modeNames}). */
  checkMode(mode: string, on: boolean): void {
    for (const l of this.listed_) if (l.sat.mode === mode) l.box.checked = on;
    this.count();
    this.options.onChange?.();
  }

  /** The names of the modes listed, in the order first seen. */
  modeNames(): string[] {
    return [...new Set(this.listed_.flatMap((l) => (l.sat.mode ? [l.sat.mode] : [])))];
  }

  /**
   * Chooses `members` (on: each satellite with none of its modes checked by
   * its usual mode) or clears them.
   */
  private choose(members: readonly ListedSatellite[], on: boolean): void {
    if (!on) {
      for (const m of members) m.box.checked = false;
      return;
    }
    for (const same of this.byPlatform(members).values()) {
      if (same.some((m) => m.box.checked)) continue;
      (same.find((m) => m.sat.primary !== false) ?? same[0]).box.checked = true;
    }
  }

  private byPlatform(members: readonly ListedSatellite[]): Map<string, ListedSatellite[]> {
    const map = new Map<string, ListedSatellite[]>();
    for (const m of members) {
      const key = platformKey(m.sat);
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    return map;
  }

  /** A box per mode name, when some satellites have several modes. */
  private modeBar(): HTMLElement[] {
    this.modes_ = [];
    const names = this.modeNames();
    if (!names.length) return [];
    const bar = document.createElement('div');
    bar.className = 'plan-modes';
    const title = document.createElement('span');
    title.textContent = '撮像モード';
    title.title = 'モードごとに、そのモードを持つ衛星をまとめて選びます（衛星ごとの選択は下の一覧で）';
    bar.append(title);
    for (const name of names) {
      const members = this.listed_.filter((l) => l.sat.mode === name);
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', (e) => {
        e.stopPropagation();
        this.checkMode(name, box.checked);
      });
      label.title = `${name}を持つ衛星 ${members.length} 機`;
      label.append(box, document.createTextNode(name));
      bar.append(label);
      this.modes_.push({ box, members });
    }
    return [bar];
  }

  /**
   * Shows only the satellites whose name, id or series has all the words of
   * `text` (checked ones stay), with the groups holding them opened; an empty
   * text shows all again.
   */
  filter(text: string): void {
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const l of this.listed_) {
      const hay = `${l.sat.name} ${l.sat.id} ${l.sat.series} ${l.sat.mode ?? ''} ${l.sat.sensor ?? ''}`.toLowerCase();
      l.label.hidden = !l.box.checked && !words.every((w) => hay.includes(w));
    }
    for (const g of this.groups_) {
      const shown = g.members.some((m) => !m.label.hidden);
      g.details.hidden = !shown;
      if (words.length && shown) g.details.open = true;
    }
  }

  /**
   * Counts the chosen satellites (with at least one mode checked), overall
   * and in each group (whose checkbox follows them), and the modes above.
   */
  count(): void {
    const tally = (members: readonly ListedSatellite[]) => {
      const platforms = [...this.byPlatform(members).values()];
      return { on: platforms.filter((same) => same.some((m) => m.box.checked)).length, all: platforms.length };
    };
    const { on, all } = tally(this.listed_);
    if (this.summary) this.summary.textContent = `（${on} / ${all}）`;
    for (const g of this.groups_) {
      const n = tally(g.members);
      g.box.checked = n.on === n.all;
      g.box.indeterminate = n.on > 0 && n.on < n.all;
      g.count.textContent = `${n.on} / ${n.all}`;
    }
    for (const m of this.modes_) {
      const n = m.members.filter((l) => l.box.checked).length;
      m.box.checked = n === m.members.length;
      m.box.indeterminate = n > 0 && n < m.members.length;
    }
  }

  /** A satellite's checkbox with its name, specifications and how old its TLE is. */
  /** `modeOnly`: the label of one of a satellite's modes, under its name (the mode's name alone). */
  private labelOf(sat: SatelliteSpec, box: HTMLInputElement, now: number, modeOnly: boolean): HTMLLabelElement {
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
      sat.resolution !== undefined ? `分解能 ${round(sat.resolution, 2)} m` : '',
    ]
      .filter(Boolean)
      .join('・');
    const note = document.createElement('small');
    note.textContent = facts;
    label.title = sat.source === SAMPLE_SOURCE ? 'サンプル（決め打ちの軌道。実在の衛星ではありません）' : `${sat.source}${Number.isNaN(age) ? '' : `・TLE ${round(age, 0)} 日前`}`;
    const marker = this.options.marker?.(sat);
    label.append(box, ...(marker ? [marker] : []), document.createTextNode(modeOnly && sat.mode ? sat.mode : satelliteLabel(sat)), note);
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
