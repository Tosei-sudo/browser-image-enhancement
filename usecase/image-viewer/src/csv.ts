/**
 * CSV (and TSV) files as attribute tables without geometry: rows become
 * features with no geometry, columns become fields typed by their values.
 * Points can then be made from their X / Y columns with the processing tool
 * 「XY 座標からポイントを作成」.
 */
import Feature from 'ol/Feature.js';
import type { Field } from './services/index.js';

/** What the viewer reads as a table, by extension. */
export function isCsvName(name: string): boolean {
  return /\.(csv|tsv)$/i.test(name);
}

/** The text of a CSV: UTF-8 (with or without a BOM) when it is valid UTF-8, else Shift_JIS (Japanese Excel). */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'shift_jis' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
}

/** The delimiter of a CSV: the one of tab, comma and semicolon found most in its first line (outside quotes). */
export function delimiterOf(text: string): string {
  const first = text.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  const counts = ['\t', ',', ';'].map((d) => [d, first.split(d).length - 1] as const);
  const [best] = counts.sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/** The rows of a CSV (RFC 4180: quoted values may hold delimiters, quotes doubled, and line breaks). Blank lines are skipped. */
export function parseCsv(text: string, delimiter = delimiterOf(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  const end = () => {
    row.push(value);
    value = '';
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"' && value === '') quoted = true;
    else if (c === delimiter) end();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      end();
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else value += c;
  }
  end();
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const integer = /^[+-]?\d+$/;
const number = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A CSV read as a table. */
export interface CsvTable {
  title: string;
  /** One feature per row, without geometry. */
  features: Feature[];
  fields: Field[];
  encoding: 'utf-8' | 'shift_jis';
  delimiter: string;
}

/**
 * Reads a CSV with a header line. Columns whose values are all whole numbers
 * are integers, all numbers doubles (Excel's thousands separators are not
 * read as numbers), the rest text; empty cells are null.
 */
export function readCsv(bytes: Uint8Array, title: string): CsvTable {
  const { text, encoding } = decodeCsv(bytes);
  const delimiter = delimiterOf(text);
  const [header, ...rows] = parseCsv(text, delimiter);
  if (!header) throw new Error('CSV が空です');
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  const seen = new Set<string>();
  const names = Array.from({ length: width }, (_, i) => {
    // OpenLayers keeps a feature's geometry under `geometry`.
    let name = header[i]?.trim() || `field_${i + 1}`;
    if (name === 'geometry') name = 'geometry_';
    for (let n = 2; seen.has(name); n++) name = `${header[i]?.trim() || `field_${i + 1}`}_${n}`;
    seen.add(name);
    return name;
  });
  const types = names.map((_, i) => {
    const values = rows.map((r) => r[i]?.trim() ?? '').filter((v) => v !== '');
    if (values.length && values.every((v) => integer.test(v) && Number.isSafeInteger(Number(v)))) return 'integer' as const;
    if (values.length && values.every((v) => number.test(v))) return 'double' as const;
    return 'string' as const;
  });
  const fields: Field[] = names.map((name, i) => ({ name, alias: name, type: types[i], editable: false, nullable: true }));
  const features = rows.map((r, index) => {
    const feature = new Feature();
    feature.setId(index + 1);
    feature.setProperties(
      Object.fromEntries(
        names.map((name, i) => {
          const raw = r[i] ?? '';
          const empty = raw.trim() === '';
          return [name, empty ? null : types[i] === 'string' ? raw : Number(raw.trim())];
        }),
      ),
    );
    return feature;
  });
  return { title, features, fields, encoding, delimiter };
}
