/**
 * The imaging plan's shots outside the panel: as an iCalendar file (.ics)
 * for Outlook and other calendars, and as reminders that turn into notices of
 * the notification centre (the header's 「通知」 and the app icon's badge,
 * catalog-watch.ts) a chosen number of minutes before each shot.
 *
 * Reminders are kept in the browser (localStorage) and checked while a window
 * of the viewer is open; desktop notifications are never used.
 */
import { addNotices, type WatchNotice } from './catalog-watch.js';
import { satelliteLabel, type Opportunity, type PlanTarget, type SatelliteSpec } from './imaging-plan.js';

/** One shot to remind of. */
export interface PlanReminder {
  /** Satellite id and time, so the same shot is not reminded of twice. */
  id: string;
  /** When the shot is, ms since the epoch. */
  time: number;
  /** When to remind. */
  notifyAt: number;
  satellite: string;
  /** The target (several joined when one scene takes them). */
  target: string;
  offNadir: number;
  /** The scenes, longitude / latitude rings (for 「移動」 in the notification centre). */
  rings: number[][][];
}

const KEY = 'image-viewer-plan-reminders';
/** The most reminders kept. */
export const MAX_REMINDERS = 500;

const pad = (n: number) => String(n).padStart(2, '0');
/** `20261022T201500Z`. */
const icsTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
/** Text escaped for an iCalendar value. */
const icsText = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** A content line folded at 75 octets (RFC 5545 3.1), without splitting a character. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * The shots among `ops` (a combination's scenes taken once even when they
 * take several targets): one per satellite and moment, with the targets each takes.
 */
export function shotsOf(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[]): Array<{ op: Opportunity; sat: SatelliteSpec; targets: string[] }> {
  const byKey = new Map<string, { op: Opportunity; sat: SatelliteSpec; targets: string[] }>();
  for (const op of ops) {
    const sat = sats[op.satellite];
    const key = op.shot !== undefined ? `shot:${op.shot}` : `${sat.id}:${op.time}`;
    const label = targets[op.target]?.label ?? '';
    const found = byKey.get(key);
    if (found) {
      if (!found.targets.includes(label)) found.targets.push(label);
      found.op = op.time < found.op.time ? op : found.op;
    } else byKey.set(key, { op, sat, targets: [label] });
  }
  return [...byKey.values()].sort((a, b) => a.op.time - b.op.time);
}

/** The shots as an iCalendar file: an event a minute long at each, with an alarm `alarm` minutes before (none when null). */
export function planIcs(ops: readonly Opportunity[], sats: readonly SatelliteSpec[], targets: readonly PlanTarget[], alarm: number | null = null, now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//browser-image-enhancement//image-viewer imaging plan//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const { op, sat, targets: names } of shotsOf(ops, sats, targets)) {
    const end = Math.max(op.time + 60000, op.scene?.[1] ?? 0);
    const details = [
      `衛星: ${sat.name}（${sat.id}）`,
      ...(sat.mode ? [`撮像モード: ${sat.mode}`] : []),
      `対象: ${names.join('、')}`,
      `オフナディア角: ${op.offNadir.toFixed(1)}°・入射角 ${op.incidence.toFixed(1)}°`,
      `方向: ${op.side === 'right' ? '右' : '左'}・${op.ascending ? '北行' : '南行'}`,
      `太陽高度: ${op.sunElevation.toFixed(0)}°`,
      ...(sat.leadTime > 0 ? [`発注期限: ${new Date(op.time - sat.leadTime * 3600000).toISOString()}`] : []),
    ];
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(`${sat.id}-${op.time}`)}@image-viewer`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(op.time)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(`撮像 ${satelliteLabel(sat)} → ${names.join('、')}`)}`,
      `DESCRIPTION:${icsText(details.join('\n'))}`,
      `GEO:${targets[op.target].center[1].toFixed(6)};${targets[op.target].center[0].toFixed(6)}`,
      'TRANSP:TRANSPARENT',
    );
    if (alarm !== null) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`撮像 ${satelliteLabel(sat)}`)}`, `TRIGGER:-PT${Math.max(0, Math.round(alarm))}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** The reminders kept (pending ones, soonest first). */
export function loadReminders(): PlanReminder[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? (value as PlanReminder[]).filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.notifyAt)).sort((a, b) => a.notifyAt - b.notifyAt) : [];
  } catch {
    return [];
  }
}

function saveReminders(reminders: PlanReminder[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(reminders.slice(0, MAX_REMINDERS)));
  } catch {
    // Storage full or blocked: reminders last only as long as they are in memory.
  }
}

/**
 * Adds reminders `minutes` before the shots of `ops` still ahead (replacing
 * those of the same shots); `ringsOf` gives each shot's scenes. Returns how
 * many were set.
 */
export function addReminders(
  ops: readonly Opportunity[],
  sats: readonly SatelliteSpec[],
  targets: readonly PlanTarget[],
  minutes: number,
  ringsOf: (op: Opportunity) => number[][][],
  now = Date.now(),
): number {
  const fresh = shotsOf(ops, sats, targets)
    .filter(({ op }) => op.time > now)
    .slice(0, MAX_REMINDERS)
    .map(({ op, sat, targets: names }) => ({
      id: `${sat.id}:${op.time}`,
      time: op.time,
      notifyAt: op.time - Math.max(0, minutes) * 60000,
      satellite: satelliteLabel(sat),
      target: names.join('、'),
      offNadir: Math.round(op.offNadir * 10) / 10,
      rings: ringsOf(op),
    }));
  const ids = new Set(fresh.map((r) => r.id));
  saveReminders([...loadReminders().filter((r) => !ids.has(r.id)), ...fresh].sort((a, b) => a.notifyAt - b.notifyAt));
  return fresh.length;
}

/** Drops every pending reminder. */
export function clearReminders(): void {
  saveReminders([]);
}

const timeText = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The notice of a reminder. */
export function reminderNotice(r: PlanReminder, now: number): WatchNotice {
  const left = Math.max(0, Math.round((r.time - now) / 60000));
  return {
    id: `plan:${r.id}`,
    watchId: 'plan',
    watchName: '撮像計画',
    catalogLabel: '',
    found: now,
    read: false,
    imageId: `${timeText(r.time)} ${r.satellite} が撮像${left > 0 ? `（あと ${left} 分）` : ''}`,
    acquired: r.time,
    sensor: `${r.target}・オフナディア角 ${r.offNadir}°`,
    feature: { attributes: {}, geometry: { rings: r.rings, spatialReference: { wkid: 4326 } } },
    kind: 'plan',
  };
}

/** Turns the reminders that are due into notices; returns how many. Shots already past are dropped without a notice. */
export async function fireDue(now = Date.now()): Promise<number> {
  const all = loadReminders();
  const due = all.filter((r) => r.notifyAt <= now);
  if (!due.length) return 0;
  saveReminders(all.filter((r) => r.notifyAt > now));
  const notices = due.filter((r) => r.time > now - 10 * 60000).map((r) => reminderNotice(r, now));
  await addNotices(notices);
  return notices.length;
}

/** Checks the reminders every 20 seconds while the page is open (and when it comes back into view); `onFired` hears of new notices. */
export function startReminders(onFired: (count: number) => void): () => void {
  const check = () =>
    void fireDue()
      .then((n) => n && onFired(n))
      .catch(() => undefined);
  check();
  const timer = setInterval(check, 20000);
  const visible = () => document.visibilityState === 'visible' && check();
  document.addEventListener('visibilitychange', visible);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
  };
}
