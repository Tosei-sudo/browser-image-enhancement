/**
 * The imaging plan's timeline: the listed shots as bars over the planned
 * period, one row per satellite, with the time each satellite is busy after
 * a shot (its interval between shots) shaded behind it, so where shots crowd
 * and which satellites are free show at a glance. A bar's colour tells its
 * target; clicking a bar chooses that shot.
 */
import { platformKey, type Opportunity, type SatelliteSpec } from './imaging-plan.js';

export interface TimelineOptions {
  ops: readonly Opportunity[];
  sats: readonly SatelliteSpec[];
  /** The period, ms since the epoch. */
  start: number;
  end: number;
  chosen: Opportunity | null;
  /** What a bar's tooltip says. */
  title: (op: Opportunity) => string;
  onPick: (op: Opportunity) => void;
}

const SVG = 'http://www.w3.org/2000/svg';
const ROW = 20;
const HEAD = 18;
const LABEL = 120;
/** Colours of the targets, in turn. */
const COLOURS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#4f46e5', '#dc2626', '#65a30d'];

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
};

/**
 * The rows of the timeline: the satellites with shots, by name, each with
 * its shots in time order (those of all its modes in one row, as they share
 * its time).
 */
export function timelineRows(ops: readonly Opportunity[], sats: readonly SatelliteSpec[]): Array<{ satellite: number; ops: Opportunity[] }> {
  const rows = new Map<string, { satellite: number; ops: Opportunity[] }>();
  for (const op of ops) {
    const key = platformKey(sats[op.satellite]);
    const row = rows.get(key);
    if (row) row.ops.push(op);
    else rows.set(key, { satellite: op.satellite, ops: [op] });
  }
  return [...rows.values()]
    .map(({ satellite, ops: list }) => ({ satellite, ops: list.sort((a, b) => a.time - b.time) }))
    .sort((a, b) => sats[a.satellite].name.localeCompare(sats[b.satellite].name, 'ja', { numeric: true }));
}

/** Draws the timeline into `host` (replacing what was there), as wide as the host. */
export function drawTimeline(host: HTMLElement, options: TimelineOptions): void {
  const { ops, sats, start, end, chosen } = options;
  const rows = timelineRows(ops, sats);
  if (!rows.length || end <= start) {
    host.replaceChildren();
    return;
  }
  const width = Math.max(320, host.clientWidth || 640);
  const plot = width - LABEL - 8;
  const height = HEAD + rows.length * ROW + 4;
  const x = (t: number) => LABEL + ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * plot;
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `撮像のタイムライン（${rows.length} 機）` });

  // Days: a line at each local midnight, labelled when there is room.
  const day = new Date(start);
  day.setHours(24, 0, 0, 0);
  const days = Math.ceil((end - start) / 86400000);
  const every = Math.max(1, Math.ceil((days * 46) / plot));
  for (let t = day.getTime(), k = 0; t < end; k++) {
    const d = new Date(t);
    el('line', { x1: x(t), x2: x(t), y1: HEAD - 4, y2: height, class: 'plan-tl-day' }, svg);
    if (k % every === 0) {
      const text = el('text', { x: x(t) + 2, y: HEAD - 6, class: 'plan-tl-tick' }, svg);
      text.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    d.setDate(d.getDate() + 1);
    t = d.getTime();
  }

  const colours = new Map<number, string>();
  const colourOf = (target: number) => {
    if (!colours.has(target)) colours.set(target, COLOURS[colours.size % COLOURS.length]);
    return colours.get(target)!;
  };
  rows.forEach((row, i) => {
    const sat = sats[row.satellite];
    const y = HEAD + i * ROW;
    if (i % 2) el('rect', { x: 0, y, width, height: ROW, class: 'plan-tl-band' }, svg);
    const label = el('text', { x: 4, y: y + ROW - 6, class: 'plan-tl-label' }, svg);
    label.textContent = sat.name.length > 16 ? `${sat.name.slice(0, 15)}…` : sat.name;
    const limits = [sat.minInterval > 0 ? `撮像間隔 ${sat.minInterval} 分` : '', sat.maxPerDay > 0 ? `1 日 ${sat.maxPerDay} 回まで` : ''].filter(Boolean).join('・');
    el('title', {}, label).textContent = `${sat.name}（${row.ops.length} 回）${limits ? `・${limits}` : ''}`;
    // Busy after each shot: the interval it must wait before the next.
    if (sat.minInterval > 0) {
      for (const op of row.ops) el('rect', { x: x(op.time), y: y + 3, width: Math.max(1, x(op.time + sat.minInterval * 60000) - x(op.time)), height: ROW - 6, class: 'plan-tl-busy' }, svg);
    }
    for (const op of row.ops) {
      const bar = el('rect', { x: x(op.time) - 1.5, y: y + 3, width: 3, height: ROW - 6, fill: colourOf(op.target), class: op === chosen ? 'plan-tl-shot chosen' : 'plan-tl-shot' }, svg);
      el('title', {}, bar).textContent = options.title(op);
      bar.addEventListener('click', () => options.onPick(op));
    }
  });
  host.replaceChildren(svg);
}
