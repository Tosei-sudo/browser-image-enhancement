/**
 * Attribute values as text: as the table shows them, sorted, and as CSV or
 * tab-separated rows that a spreadsheet opens without running formulas.
 */
import type Feature from 'ol/Feature.js';
import type { Field } from './services/index.js';

/**
 * Formats and collators made once: `toLocaleString` and `localeCompare` with
 * a locale make a new one at every call, which costs microseconds each, so
 * sorting or searching a column of 100,000 rows took seconds.
 */
const dateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
/** Japanese order, with numbers in text by value (`地物2` before `地物10`). */
export const collator = new Intl.Collator('ja', { numeric: true });
/** The names of a domain's codes, by the code as text. */
const codeNames = new WeakMap<NonNullable<Field['codes']>, Map<string, string>>();

/** A date (epoch milliseconds) as the table shows it, in local time. */
export function dateText(ms: number): string {
  // Out of range: as Date has it (`Invalid Date`), where the format would throw.
  return Number.isNaN(new Date(ms).getTime()) ? new Date(ms).toLocaleString('ja-JP') : dateFormat.format(ms);
}

/** A value as the table shows it: domain names, local dates, empty for null. */
export function display(field: Field, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.codes) {
    let names = codeNames.get(field.codes);
    if (!names) {
      names = new Map();
      // The first of codes alike wins, as a search from the start would find it.
      for (const c of field.codes) if (!names.has(String(c.code))) names.set(String(c.code), c.name);
      codeNames.set(field.codes, names);
    }
    const name = names.get(String(value));
    if (name !== undefined) return name;
  }
  if (field.type === 'date' && typeof value === 'number') return dateText(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Text a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, or a tab or
 * carriage return first) gets a leading `'`, so attribute values from a
 * service or a file cannot run as formulas when the CSV or the copied rows
 * are opened. Plain numbers (`-12.5`) stay as they are.
 */
export function defuse(text: string): string {
  return /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) ? `'${text}` : text;
}

/** Order of two values in a sorted column: numbers by value, text as Japanese with numbers in it, empty last. */
export function compareValues(a: unknown, b: unknown, field?: Field): number {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) || empty(b)) return empty(a) === empty(b) ? 0 : empty(a) ? 1 : -1; // empty last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = field ? display(field, a) : String(a);
  const y = field ? display(field, b) : String(b);
  return collator.compare(x, y);
}

/** `yyyy-MM-ddTHH:mm` in local time, for a datetime-local input. */
export function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The rows of `features` with a header of the field aliases, tab-separated, for pasting into a spreadsheet. */
export function toTsv(fields: readonly Field[], features: readonly Feature[]): string {
  const clean = (s: string) => defuse(s.replace(/[\t\r\n]+/g, ' '));
  return [fields.map((f) => clean(f.alias)), ...features.map((r) => fields.map((f) => clean(display(f, r.get(f.name)))))].map((l) => l.join('\t')).join('\n');
}

/** The rows of `features` with a header of the field aliases, as CSV (CRLF line ends, quoted where needed). */
export function toCsv(fields: readonly Field[], features: readonly Feature[]): string {
  const quote = (text: string) => {
    const s = defuse(text);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.map((f) => quote(f.alias)), ...features.map((r) => fields.map((f) => quote(display(f, r.get(f.name)))))].map((l) => l.join(',')).join('\r\n');
}
