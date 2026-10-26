/**
 * The observation report (報告書): the records of a period (and of a class,
 * and at least a level of 確度) made into one page to print or keep — a
 * summary, counts by class and by activity, a map of where things were, each
 * thing's flow (the spans it stayed doing one thing), the checked areas and
 * the records. Saved as one HTML file (the map inside it), or printed (the
 * browser's print, which also makes a PDF).
 */
import { flows, living, localTime, timeKey, type ConfidenceLevel, type ObjectFlow, type Observation } from './observations.js';
import { areaLabel, type CheckedArea } from './observation-areas.js';
import { kindOf, pathOf, within } from './taxonomy.js';
import { saveFile } from './save-folder.js';

/** What goes into a report. */
export interface ReportOptions {
  title: string;
  /** The period (ms, inclusive); null: open. */
  from: number | null;
  to: number | null;
  /** Only this class and below ('' all). */
  kind: string;
  /** Only records at least this sure (a level's label; '' all, records without a level too). */
  confidence: string;
  map: boolean;
  flows: boolean;
  areas: boolean;
  records: boolean;
}

export const defaultReportOptions: ReportOptions = { title: '観測報告', from: null, to: null, kind: '', confidence: '', map: true, flows: true, areas: true, records: false };

/** The records and areas a report holds. */
export interface ReportSelection {
  records: Observation[];
  flows: ObjectFlow[];
  areas: CheckedArea[];
  /** The images they are from, in time order. */
  images: Array<{ id: string; name: string; time: number | null }>;
}

const inPeriod = (t: number | null, o: Pick<ReportOptions, 'from' | 'to'>) => (o.from === null || (t !== null && t >= o.from)) && (o.to === null || (t !== null && t <= o.to));

/** The records (living), things and areas of the period, class and 確度 asked for. */
export function selectForReport(all: readonly Observation[], areas: readonly CheckedArea[], options: ReportOptions, levels: readonly ConfidenceLevel[]): ReportSelection {
  const kind = pathOf(options.kind);
  const rank = (label: string | undefined) => levels.findIndex((l) => l.label === label);
  const limit = options.confidence ? rank(options.confidence) : -1;
  const records = living(all).filter((o) => inPeriod(timeKey(o), options) && (!kind.length || within(o.kind, kind)) && (limit < 0 || (rank(o.confidence) >= 0 && rank(o.confidence) <= limit)));
  const shown = areas.filter((a) => a.deletedAt === null && inPeriod(a.imageTime ?? a.createdAt, options) && (!kind.length || !a.kind || within(a.kind, kind) || within(kindOf(kind), pathOf(a.kind))));
  const images = new Map<string, { id: string; name: string; time: number | null }>();
  for (const x of [...records, ...shown]) if (!images.has(x.imageId)) images.set(x.imageId, { id: x.imageId, name: x.imageName || x.imageId, time: x.imageTime });
  return {
    records,
    flows: flows(records),
    areas: shown,
    images: [...images.values()].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.name.localeCompare(b.name)),
  };
}

const escape = (v: unknown) =>
  String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const table = (head: string[], rows: unknown[][]) => `<table><thead><tr>${head.map((h) => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
/** Counts of a value, the most first. */
const counts = (values: string[]) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));

/** What the page says besides the selection. */
export interface ReportContext {
  /** The store the records are from. */
  store: string;
  /** Who made the report. */
  author: string;
  made: number;
  levels: readonly ConfidenceLevel[];
  /** The map (a data URL), when drawn. */
  map?: string | null;
}

/** The report as one HTML page (styles inside, the map as a data URL). */
export function reportHtml(selection: ReportSelection, options: ReportOptions, context: ReportContext): string {
  const { records, areas, images } = selection;
  const things = selection.flows;
  const times = records.map(timeKey);
  const period = options.from !== null || options.to !== null ? `${options.from !== null ? localTime(options.from) : ''} 〜 ${options.to !== null ? localTime(options.to) : ''}` : times.length ? `${localTime(Math.min(...times))} 〜 ${localTime(Math.max(...times))}（記録の期間）` : '—';
  const meta = [
    ['期間', period],
    ['分類', options.kind ? `${kindOf(pathOf(options.kind))} 以下` : 'すべて'],
    ['確度', options.confidence ? `${options.confidence} 以上` : 'すべて'],
    ['保存先', context.store],
    ['作成', `${localTime(context.made)}${context.author ? `・${context.author}` : ''}`],
  ];
  const parts: string[] = [];
  parts.push(`<h1>${escape(options.title || '観測報告')}</h1>`);
  parts.push(`<dl class="meta">${meta.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`);
  const present = things.filter((f) => f.present);
  parts.push(
    `<section><h2>概要</h2><p class="summary">モノ ${things.length} 件（最新で所在 ${present.length}・不在 ${things.length - present.length}）・記録 ${records.length} 件・画像 ${images.length} 枚${options.areas ? `・確認範囲 ${areas.length} 件` : ''}</p>`,
  );
  const byClass = counts(things.map((f) => pathOf(f.kind)[0] || '種別なし'));
  const byActivity = counts(present.map((f) => f.activity || '活動の記録なし'));
  const byConfidence = counts(records.map((o) => o.confidence || '確度なし'));
  parts.push(`<div class="cols">${table(['大分類', 'モノ'], byClass)}${table(['最新の活動', 'モノ'], byActivity)}${table(['確度', '記録'], byConfidence)}</div></section>`);
  if (options.map && context.map) parts.push(`<section class="map"><h2>位置</h2><img src="${escape(context.map)}" alt="記録の位置" /></section>`);
  if (options.flows && things.length) {
    parts.push('<section><h2>モノごとの流れ</h2>');
    for (const f of things) {
      const last = f.observations[f.observations.length - 1];
      parts.push(
        `<article class="thing"><h3>${escape(f.name)} <small>${escape(f.kind || '種別なし')}・${escape(f.objectId)}</small></h3>` +
          `<p>${escape(`${localTime(f.first)} 〜 ${localTime(f.last)}・${f.seen} 画像で確認・移動 ${km(f.distance)}・最新: ${f.present ? f.activity || '活動の記録なし' : '不在'}${last.confidence ? `（${last.confidence}）` : ''}`)}</p>` +
          table(
            ['期間', '活動', '画像', '移動'],
            f.steps.map((s) => [s.from === s.to ? localTime(s.from) : `${localTime(s.from)} 〜 ${localTime(s.to)}`, s.present ? s.activity || '—' : '不在', s.count, s.moved !== null && s.moved > 0 ? km(s.moved) : '']),
          ) +
          '</article>',
      );
    }
    parts.push('</section>');
  }
  if (options.areas && areas.length) {
    parts.push(
      `<section><h2>確認範囲</h2><p class="note">範囲内の対象の種別は記録がすべて（記録のないものは不在）</p>${table(
        ['撮像日時', '画像', '対象', '備考', '記録者'],
        [...areas].sort((a, b) => (a.imageTime ?? a.createdAt) - (b.imageTime ?? b.createdAt)).map((a) => [localTime(a.imageTime), a.imageName || a.imageId, areaLabel(a).replace(/^確認範囲（(.*)）$/, '$1'), a.note, a.recordedBy ?? '']),
      )}</section>`,
    );
  }
  if (options.records && records.length) {
    parts.push(
      `<section><h2>記録一覧</h2>${table(
        ['撮像日時', 'モノ', '種別', '活動', '確度', '経度', '緯度', '備考', '記録者'],
        [...records].sort((a, b) => timeKey(a) - timeKey(b) || a.objectName.localeCompare(b.objectName, 'ja')).map((o) => [localTime(o.imageTime), o.objectName, o.kind, o.present ? o.activity : '不在', o.confidence ?? '', o.lon.toFixed(5), o.lat.toFixed(5), o.note, o.recordedBy ?? '']),
      )}</section>`,
    );
  }
  parts.push(`<section><h2>画像</h2>${table(['撮像日時', '画像', '画像 ID'], images.map((i) => [localTime(i.time) || '日時不明', i.name, i.id]))}</section>`);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(options.title || '観測報告')}</title>
<style>
body{font:13px/1.55 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;color:#111;margin:24px auto;max-width:960px;padding:0 16px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;border-bottom:2px solid #111;padding-bottom:2px;margin:22px 0 8px}h3{font-size:14px;margin:12px 0 2px}h3 small{font-weight:400;color:#555}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}dl.meta dt{color:#555}dl.meta dd{margin:0}
table{border-collapse:collapse;width:100%;margin:4px 0 8px}th,td{border:1px solid #bbb;padding:2px 6px;text-align:left;vertical-align:top}th{background:#f1f1f1}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.summary{font-size:14px}.note{color:#555;margin:0}
.map img{width:100%;border:1px solid #bbb}.thing{break-inside:avoid}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
${parts.join('\n')}
</body></html>
`;
}

/** The report's file name: 観測報告_20261025.html */
export function reportFileName(title: string, made: number): string {
  const d = new Date(made);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${(title || '観測報告').replace(/[\\/:*?"<>|\s]+/g, '_')}_${stamp}.html`;
}

/** Saves a report page (the chosen folder, else a download). */
export async function saveReport(html: string, title: string, say: (message: string) => void, made = Date.now()): Promise<string> {
  const name = reportFileName(title, made);
  await saveFile(name, new Blob([html], { type: 'text/html' }), say);
  return name;
}

/** Prints a report page (the browser's print dialog, where a PDF can be made too). */
export function printReport(html: string): void {
  const frame = document.createElement('iframe');
  frame.className = 'obs-report-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  // No scripts in the report page (its text is records from a shared store): the page prints it from here.
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // Gone after printing (or soon, where print does not block).
    setTimeout(() => frame.remove(), 60_000);
  });
  document.body.append(frame);
}
