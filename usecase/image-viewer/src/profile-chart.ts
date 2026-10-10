/**
 * The profile of a 3D distance measurement as a small chart (SVG): the ground
 * as a filled area, objects above it (3D Tiles, multipatches) as a line, and
 * the line of sight between the two ends. Hovering shows the heights at a
 * distance. A CSV of the samples can be saved.
 */
import { sightLineHeight } from './viewshed.js';
import type { Profile } from './globe-measure.js';

const W = 320;
const H = 170;
const PAD = { left: 44, right: 8, top: 18, bottom: 26 };
const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** A round step giving about `count` ticks over `span`. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}

/** Draws `profile` into `container` (replacing what is there). */
export function drawProfile(container: HTMLElement, profile: Profile): void {
  container.replaceChildren();
  const { ground, surface } = profile;
  const length = ground[ground.length - 1]?.distance ?? 0;
  if (!(length > 0)) return;
  const sight = (d: number) => sightLineHeight(d, length, profile.from, profile.to, profile.refraction);
  const values = [...ground, ...surface].map((s) => s.height).filter((h) => !Number.isNaN(h));
  values.push(profile.from, profile.to);
  if (profile.sight) for (let i = 0; i <= 16; i++) values.push(sight((length * i) / 16));
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1) {
    min -= 0.5;
    max += 0.5;
  }
  const yStep = niceStep(max - min, 4);
  min = Math.floor(min / yStep) * yStep;
  max = Math.ceil(max / yStep) * yStep;
  const km = length >= 2000;
  const unit = km ? 1000 : 1;
  const xStep = niceStep(length / unit, 4) * unit;
  const x = (d: number) => PAD.left + ((W - PAD.left - PAD.right) * d) / length;
  const y = (h: number) => PAD.top + ((H - PAD.top - PAD.bottom) * (max - h)) / (max - min);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'profile-chart', role: 'img' });
  svg.setAttribute('aria-label', `断面図（距離 ${(length / unit).toFixed(km ? 2 : 0)} ${km ? 'km' : 'm'}、標高 ${min}〜${max} m）`);
  // Grid and axes: quiet.
  for (let h = min; h <= max + yStep / 2; h += yStep) {
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y(h), y2: y(h), class: 'profile-grid' }));
    const t = el('text', { x: PAD.left - 4, y: y(h) + 3, class: 'profile-tick', 'text-anchor': 'end' });
    t.textContent = `${Math.round(h)}`;
    svg.append(t);
  }
  for (let d = 0; d <= length + 1e-6; d += xStep) {
    const t = el('text', { x: x(d), y: H - PAD.bottom + 14, class: 'profile-tick', 'text-anchor': 'middle' });
    t.textContent = `${+(d / unit).toFixed(3)}`;
    svg.append(t);
  }
  const axis = el('text', { x: W - PAD.right, y: H - 2, class: 'profile-tick', 'text-anchor': 'end' });
  axis.textContent = `距離（${km ? 'km' : 'm'}）`;
  svg.append(axis);
  const yAxis = el('text', { x: 2, y: 9, class: 'profile-tick' });
  yAxis.textContent = '標高 m';
  svg.append(yAxis);

  // Runs of known heights, as paths.
  const runs = (samples: typeof ground) => {
    const out: Array<typeof ground> = [];
    let run: typeof ground = [];
    for (const s of samples) {
      if (Number.isNaN(s.height)) {
        if (run.length) out.push(run);
        run = [];
      } else run.push(s);
    }
    if (run.length) out.push(run);
    return out;
  };
  for (const run of runs(ground)) {
    const top = run.map((s) => `${x(s.distance).toFixed(1)},${y(s.height).toFixed(1)}`).join(' L');
    svg.append(el('path', { d: `M${x(run[0].distance).toFixed(1)},${y(min)} L${top} L${x(run[run.length - 1].distance).toFixed(1)},${y(min)} Z`, class: 'profile-ground' }));
  }
  // Objects: where the surface stands above the ground.
  const above = surface.map((s, i) => ({ distance: s.distance, height: !Number.isNaN(s.height) && !(s.height <= (ground[i].height ?? NaN) + 0.2) ? s.height : NaN }));
  const hasObjects = above.some((s) => !Number.isNaN(s.height));
  for (const run of runs(surface)) {
    if (!hasObjects && ground.some((g) => !Number.isNaN(g.height))) break;
    svg.append(el('path', { d: `M${run.map((s) => `${x(s.distance).toFixed(1)},${y(s.height).toFixed(1)}`).join(' L')}`, class: 'profile-surface' }));
  }
  if (profile.sight) {
    const pts: string[] = [];
    for (let i = 0; i <= 32; i++) {
      const d = (length * i) / 32;
      pts.push(`${x(d).toFixed(1)},${y(sight(d)).toFixed(1)}`);
    }
    svg.append(el('path', { d: `M${pts.join(' L')}`, class: profile.blocked === null ? 'profile-sight clear' : 'profile-sight blocked' }));
    if (profile.blocked !== null) {
      svg.append(el('circle', { cx: x(profile.blocked), cy: y(sight(profile.blocked)), r: 4, class: 'profile-block' }));
    }
  }
  for (const [d, h] of [
    [0, profile.from],
    [length, profile.to],
  ]) {
    svg.append(el('circle', { cx: x(d), cy: y(h), r: 4, class: 'profile-end' }));
  }

  // Hover: a crosshair and the heights there.
  const cross = el('line', { y1: PAD.top, y2: H - PAD.bottom, class: 'profile-cross', visibility: 'hidden' });
  svg.append(cross);
  const tip = document.createElement('div');
  tip.className = 'profile-tip';
  tip.hidden = true;
  const hit = el('rect', { x: PAD.left, y: 0, width: W - PAD.left - PAD.right, height: H, fill: 'transparent' });
  svg.append(hit);
  const move = (event: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    const d = Math.min(length, Math.max(0, ((px - PAD.left) / (W - PAD.left - PAD.right)) * length));
    const i = Math.round((d / length) * (ground.length - 1));
    const g = ground[i]?.height;
    const s = surface[i]?.height;
    cross.setAttribute('x1', String(x(ground[i].distance)));
    cross.setAttribute('x2', String(x(ground[i].distance)));
    cross.setAttribute('visibility', 'visible');
    const rows = [`${(ground[i].distance / unit).toFixed(km ? 3 : 1)} ${km ? 'km' : 'm'}`, `地面 ${Number.isNaN(g) ? '—' : `${g.toFixed(1)} m`}`];
    if (hasObjects && !Number.isNaN(s) && s > g + 0.2) rows.push(`建物など ${s.toFixed(1)} m`);
    if (profile.sight) rows.push(`視線 ${sight(ground[i].distance).toFixed(1)} m`);
    tip.textContent = rows.join('\n');
    tip.hidden = false;
    tip.style.left = `${Math.min(box.width - 110, Math.max(0, event.clientX - box.left + 8))}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
  });

  const legend = document.createElement('p');
  legend.className = 'profile-legend';
  const key = (cls: string, text: string) => {
    const span = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = cls;
    span.append(swatch, text);
    legend.append(span);
  };
  key('ground', '地面（標高データ）');
  if (hasObjects || !ground.some((g) => !Number.isNaN(g.height))) key('surface', '表示中の地表・建物');
  if (profile.sight) key(profile.blocked === null ? 'sight clear' : 'sight blocked', profile.blocked === null ? '視線（見える）' : '視線（遮られる）');

  const wrap = document.createElement('div');
  wrap.className = 'profile-wrap';
  wrap.append(svg, tip);
  container.append(legend, wrap);
}

/** The profile as CSV: distance, ground and surface heights (m). */
export function profileCsv(profile: Profile): string {
  const rows = ['distance_m,ground_m,surface_m'];
  profile.ground.forEach((g, i) => {
    const s = profile.surface[i]?.height;
    rows.push([g.distance.toFixed(2), Number.isNaN(g.height) ? '' : g.height.toFixed(2), s === undefined || Number.isNaN(s) ? '' : s.toFixed(2)].join(','));
  });
  return `${rows.join('\n')}\n`;
}
