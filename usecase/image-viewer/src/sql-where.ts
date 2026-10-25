/**
 * A SQL `WHERE` of attribute conditions, read and checked against features
 * in the browser: the part of SQL that ArcGIS calls "standardized queries",
 * so one condition works on a local file and on an Esri layer alike.
 *
 * - comparisons `= <> != < <= > >=`, `AND`, `OR`, `NOT` and parentheses
 * - `[NOT] LIKE` (`%`, `_`, `ESCAPE`), `[NOT] IN (…)`, `[NOT] BETWEEN … AND …`, `IS [NOT] NULL`
 * - arithmetic `+ - * /` and `||` (joins text)
 * - literals: numbers, `'text'` (`''` for a quote), `DATE 'yyyy-mm-dd'`,
 *   `TIMESTAMP 'yyyy-mm-dd hh:mm:ss'` (UTC, as ArcGIS stores dates), `TRUE`, `FALSE`, `NULL`,
 *   `CURRENT_DATE`, `CURRENT_TIMESTAMP`
 * - fields by name (any case), or quoted as `"name"` or `[name]`
 * - functions: UPPER, LOWER, TRIM, LTRIM, RTRIM, CHAR_LENGTH (LENGTH), SUBSTRING,
 *   POSITION, CONCAT, ABS, ROUND, TRUNC, FLOOR, CEILING, MOD, POWER, SQRT,
 *   COALESCE, NULLIF, CAST (… AS INTEGER | FLOAT | DOUBLE | CHAR | VARCHAR | DATE | TIMESTAMP),
 *   EXTRACT (YEAR | MONTH | DAY | HOUR | MINUTE | SECOND FROM …)
 *
 * Unknown values follow SQL: a condition on NULL is neither true nor false,
 * and only features for which the whole `WHERE` is true pass.
 */
import { timeOf } from './catalog-query.js';

/** A field the condition can name (a layer's attribute). */
export interface SqlField {
  name: string;
  /** `date` fields compare as times (milliseconds or date text). */
  type?: string;
}

/** Something wrong with the text, said for the person, with where it is. */
export class SqlError extends Error {
  constructor(
    message: string,
    /** Character offset in the text. */
    readonly at: number,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

/** A point in time (a DATE or TIMESTAMP, or a value of a date field), in milliseconds. */
class Time {
  constructor(readonly ms: number) {}
}

type Value = string | number | boolean | Time | null;
/** Reads an attribute of the thing tested. */
type Get = (name: string) => unknown;
type Expr = (get: Get) => Value;

interface Token {
  kind: 'number' | 'string' | 'name' | 'quoted' | 'op' | 'end';
  text: string;
  value?: number | string;
  at: number;
}

const OPERATORS = ['<>', '!=', '<=', '>=', '||', '=', '<', '>', '+', '-', '*', '/', '(', ')', ','];
const RESERVED = new Set(['AND', 'OR', 'NOT', 'LIKE', 'IN', 'BETWEEN', 'IS', 'NULL', 'ESCAPE', 'TRUE', 'FALSE', 'DATE', 'TIMESTAMP', 'AS', 'FROM', 'FOR']);
const isNameStart = (c: string) => /[\p{L}_]/u.test(c);
const isNamePart = (c: string) => /[\p{L}\p{N}_$]/u.test(c);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i))!;
      tokens.push({ kind: 'number', text: m[0], value: Number(m[0]), at });
      i += m[0].length;
    } else if (c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= text.length) throw new SqlError('文字列の閉じ引用符（\'）なし', at);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
      tokens.push({ kind: 'string', text: text.slice(at, i), value, at });
    } else if (c === '"' || c === '[') {
      const close = c === '"' ? '"' : ']';
      const end = text.indexOf(close, i + 1);
      if (end < 0) throw new SqlError(`フィールド名の閉じ記号（${close}）なし`, at);
      tokens.push({ kind: 'quoted', text: text.slice(at, end + 1), value: text.slice(i + 1, end), at });
      i = end + 1;
    } else if (isNameStart(c)) {
      let j = i + 1;
      while (j < text.length && isNamePart(text[j])) j++;
      tokens.push({ kind: 'name', text: text.slice(i, j), at });
      i = j;
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i));
      if (!op) throw new SqlError(`使用不可の文字: ${c}`, at);
      tokens.push({ kind: 'op', text: op, at });
      i += op.length;
    }
  }
  tokens.push({ kind: 'end', text: '', at: text.length });
  return tokens;
}

// --- values ---

const isTime = (v: Value): v is Time => v instanceof Time;
/** A value as a number, when it is one (a number, numeric text, a time, a boolean); else NaN. */
function numberOf(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTime(v)) return v.ms;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return Number.NaN;
}
function textOf(v: Value): string {
  if (isTime(v)) return Number.isFinite(v.ms) ? new Date(v.ms).toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '') : '';
  return String(v);
}
/** -1, 0 or 1; null when either is unknown (or they cannot be compared). */
function compare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  let x: number;
  let y: number;
  if (isTime(a) || isTime(b)) {
    x = isTime(a) ? a.ms : typeof a === 'string' ? timeOf(a) : numberOf(a);
    y = isTime(b) ? b.ms : typeof b === 'string' ? timeOf(b) : numberOf(b);
  } else if (typeof a === 'string' && typeof b === 'string') {
    return a === b ? 0 : a < b ? -1 : 1;
  } else {
    x = numberOf(a);
    y = numberOf(b);
    // Text against a number that is not numeric text: compared as text.
    if (Number.isNaN(x) || Number.isNaN(y)) {
      const [s, t] = [textOf(a), textOf(b)];
      return s === t ? 0 : s < t ? -1 : 1;
    }
  }
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x === y ? 0 : x < y ? -1 : 1;
}
/** A field value as the condition sees it: dates as times, the rest as given. */
function valueOf(raw: unknown, date: boolean): Value {
  if (raw === undefined || raw === null || (typeof raw === 'number' && Number.isNaN(raw))) return null;
  if (raw instanceof Date) return new Time(raw.getTime());
  if (date && (typeof raw === 'number' || typeof raw === 'string')) {
    const ms = timeOf(raw);
    return Number.isFinite(ms) ? new Time(ms) : String(raw);
  }
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') return raw;
  return String(raw);
}
const truth = (v: Value): boolean | null => (v === null ? null : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' : true);

/** A LIKE pattern as a regular expression. */
function likePattern(pattern: string, escape: string | null): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escape && c === escape && i + 1 < pattern.length) out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') out += '[\\s\\S]*';
    else if (c === '_') out += '[\\s\\S]';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

/** A date or timestamp literal's text, in UTC. */
function timeLiteral(text: string, at: number, kind: string): Time {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(t)) throw new SqlError(`${kind} の形式が不正: '${text}'（例: ${kind} '2026-10-01${kind === 'TIMESTAMP' ? ' 12:00:00' : ''}'）`, at);
  const ms = timeOf(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t} 00:00:00` : t);
  if (!Number.isFinite(ms)) throw new SqlError(`${kind} の日付が不正: '${text}'`, at);
  return new Time(ms);
}

function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const functions: Record<string, { min: number; max: number; run: (args: Value[]) => Value }> = {
  UPPER: { min: 1, max: 1, run: ([s]) => (s === null ? null : textOf(s).toUpperCase()) },
  LOWER: { min: 1, max: 1, run: ([s]) => (s === null ? null : textOf(s).toLowerCase()) },
  TRIM: { min: 1, max: 1, run: ([s]) => (s === null ? null : textOf(s).trim()) },
  LTRIM: { min: 1, max: 1, run: ([s]) => (s === null ? null : textOf(s).trimStart()) },
  RTRIM: { min: 1, max: 1, run: ([s]) => (s === null ? null : textOf(s).trimEnd()) },
  CHAR_LENGTH: { min: 1, max: 1, run: ([s]) => (s === null ? null : [...textOf(s)].length) },
  LENGTH: { min: 1, max: 1, run: ([s]) => (s === null ? null : [...textOf(s)].length) },
  CONCAT: { min: 1, max: Infinity, run: (args) => args.map((a) => (a === null ? '' : textOf(a))).join('') },
  SUBSTRING: {
    min: 2,
    max: 3,
    run: ([s, from, count]) => {
      if (s === null || from === null || count === null) return null;
      const chars = [...textOf(s)];
      const start = Math.max(0, numberOf(from) - 1);
      return chars.slice(start, count === undefined ? undefined : start + Math.max(0, numberOf(count))).join('');
    },
  },
  POSITION: {
    min: 2,
    max: 2,
    run: ([find, s]) => {
      if (find === null || s === null) return null;
      const i = textOf(s).indexOf(textOf(find));
      return i < 0 ? 0 : [...textOf(s).slice(0, i)].length + 1;
    },
  },
  ABS: { min: 1, max: 1, run: ([x]) => (x === null ? null : Math.abs(numberOf(x))) },
  ROUND: {
    min: 1,
    max: 2,
    run: ([x, n]) => {
      if (x === null) return null;
      const f = 10 ** (n === undefined || n === null ? 0 : numberOf(n));
      return Math.round(numberOf(x) * f) / f;
    },
  },
  TRUNC: {
    min: 1,
    max: 2,
    run: ([x, n]) => {
      if (x === null) return null;
      const f = 10 ** (n === undefined || n === null ? 0 : numberOf(n));
      return Math.trunc(numberOf(x) * f) / f;
    },
  },
  FLOOR: { min: 1, max: 1, run: ([x]) => (x === null ? null : Math.floor(numberOf(x))) },
  CEILING: { min: 1, max: 1, run: ([x]) => (x === null ? null : Math.ceil(numberOf(x))) },
  CEIL: { min: 1, max: 1, run: ([x]) => (x === null ? null : Math.ceil(numberOf(x))) },
  MOD: { min: 2, max: 2, run: ([a, b]) => (a === null || b === null ? null : numberOf(a) % numberOf(b)) },
  POWER: { min: 2, max: 2, run: ([a, b]) => (a === null || b === null ? null : numberOf(a) ** numberOf(b)) },
  SQRT: { min: 1, max: 1, run: ([x]) => (x === null ? null : Math.sqrt(numberOf(x))) },
  COALESCE: { min: 1, max: Infinity, run: (args) => args.find((a) => a !== null) ?? null },
  NULLIF: { min: 2, max: 2, run: ([a, b]) => (compare(a, b) === 0 ? null : a) },
};

/** Reads the text into an expression (recursive descent, SQL's precedence). */
class Parser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly field: (name: string, at: number) => Expr,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }
  private next(): Token {
    return this.tokens[this.i++];
  }
  private isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'name' && t.text.toUpperCase() === word;
  }
  private acceptWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.i++;
    return true;
  }
  private expectWord(word: string): void {
    if (!this.acceptWord(word)) throw this.unexpected(`${word} が必要`);
  }
  private isOp(op: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.text === op;
  }
  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.i++;
    return true;
  }
  private expectOp(op: string): void {
    if (!this.acceptOp(op)) throw this.unexpected(`「${op}」が必要`);
  }
  private unexpected(need?: string): SqlError {
    const t = this.peek();
    const got = t.kind === 'end' ? '文の終わり' : `「${t.text}」`;
    return new SqlError(need ? `${got} の位置に ${need}` : `${got} は不正`, t.at);
  }

  parse(): Expr {
    if (this.peek().kind === 'end') throw new SqlError('条件が空', 0);
    const e = this.or();
    if (this.peek().kind !== 'end') throw this.unexpected('AND・OR か文の終わりが必要');
    return e;
  }

  private or(): Expr {
    let left = this.and();
    while (this.acceptWord('OR')) {
      const a = left;
      const b = this.and();
      left = (get) => {
        const x = truth(a(get));
        if (x === true) return true;
        const y = truth(b(get));
        return y === true ? true : x === null || y === null ? null : false;
      };
    }
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.acceptWord('AND')) {
      const a = left;
      const b = this.not();
      left = (get) => {
        const x = truth(a(get));
        if (x === false) return false;
        const y = truth(b(get));
        return y === false ? false : x === null || y === null ? null : true;
      };
    }
    return left;
  }

  private not(): Expr {
    if (this.acceptWord('NOT')) {
      const e = this.not();
      return (get) => {
        const v = truth(e(get));
        return v === null ? null : !v;
      };
    }
    return this.predicate();
  }

  private predicate(): Expr {
    const left = this.additive();
    const t = this.peek();
    if (t.kind === 'op' && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(t.text)) {
      this.i++;
      const right = this.additive();
      const test: Record<string, (c: number) => boolean> = { '=': (c) => c === 0, '<>': (c) => c !== 0, '!=': (c) => c !== 0, '<': (c) => c < 0, '<=': (c) => c <= 0, '>': (c) => c > 0, '>=': (c) => c >= 0 };
      const ok = test[t.text];
      return (get) => {
        const c = compare(left(get), right(get));
        return c === null ? null : ok(c);
      };
    }
    if (this.acceptWord('IS')) {
      const negate = this.acceptWord('NOT');
      this.expectWord('NULL');
      return (get) => (left(get) === null) !== negate;
    }
    const negate = this.isWord('NOT') && (this.isWord('LIKE', 1) || this.isWord('IN', 1) || this.isWord('BETWEEN', 1));
    if (negate) this.i++;
    const flip = (v: boolean | null) => (v === null ? null : v !== negate);
    if (this.acceptWord('LIKE')) {
      const pattern = this.additive();
      let escape: Expr | null = null;
      if (this.acceptWord('ESCAPE')) escape = this.additive();
      const cache = new Map<string, RegExp>();
      return (get) => {
        const s = left(get);
        const p = pattern(get);
        const e = escape ? escape(get) : null;
        if (s === null || p === null) return null;
        const key = `${textOf(p)}\u0000${e === null ? '' : textOf(e)}`;
        let re = cache.get(key);
        if (!re) cache.set(key, (re = likePattern(textOf(p), e === null ? null : textOf(e).slice(0, 1))));
        return flip(re.test(textOf(s)));
      };
    }
    if (this.acceptWord('IN')) {
      this.expectOp('(');
      const list: Expr[] = [this.additive()];
      while (this.acceptOp(',')) list.push(this.additive());
      this.expectOp(')');
      return (get) => {
        const v = left(get);
        if (v === null) return null;
        let unknown = false;
        for (const item of list) {
          const c = compare(v, item(get));
          if (c === 0) return flip(true);
          if (c === null) unknown = true;
        }
        return unknown ? null : flip(false);
      };
    }
    if (this.acceptWord('BETWEEN')) {
      const low = this.additive();
      this.expectWord('AND');
      const high = this.additive();
      return (get) => {
        const v = left(get);
        const a = compare(v, low(get));
        const b = compare(v, high(get));
        if (a === null || b === null) return null;
        return flip(a >= 0 && b <= 0);
      };
    }
    if (negate) throw this.unexpected();
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op' || !['+', '-', '||'].includes(t.text)) return left;
      this.i++;
      const a = left;
      const b = this.multiplicative();
      if (t.text === '||') {
        left = (get) => {
          const x = a(get);
          const y = b(get);
          return x === null || y === null ? null : textOf(x) + textOf(y);
        };
      } else {
        const sign = t.text === '+' ? 1 : -1;
        left = (get) => {
          const x = a(get);
          const y = b(get);
          if (x === null || y === null) return null;
          // A time and a number of days (CURRENT_DATE - 7).
          if (isTime(x) && !isTime(y)) return new Time(x.ms + sign * numberOf(y) * 86_400_000);
          if (isTime(x) && isTime(y) && sign < 0) return (x.ms - y.ms) / 86_400_000;
          return numberOf(x) + sign * numberOf(y);
        };
      }
    }
  }

  private multiplicative(): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op' || (t.text !== '*' && t.text !== '/')) return left;
      this.i++;
      const a = left;
      const b = this.unary();
      const times = t.text === '*';
      left = (get) => {
        const x = a(get);
        const y = b(get);
        if (x === null || y === null) return null;
        const d = numberOf(y);
        return times ? numberOf(x) * d : d === 0 ? null : numberOf(x) / d;
      };
    }
  }

  private unary(): Expr {
    if (this.acceptOp('-')) {
      const e = this.unary();
      return (get) => {
        const v = e(get);
        return v === null ? null : -numberOf(v);
      };
    }
    if (this.acceptOp('+')) return this.unary();
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    if (t.kind === 'number') {
      const v = t.value as number;
      return () => v;
    }
    if (t.kind === 'string') {
      const v = t.value as string;
      return () => v;
    }
    if (t.kind === 'quoted') return this.field(t.value as string, t.at);
    if (t.kind === 'op' && t.text === '(') {
      const e = this.or();
      this.expectOp(')');
      return e;
    }
    if (t.kind !== 'name') {
      this.i--;
      throw this.unexpected('値・フィールド・「(」が必要');
    }
    const word = t.text.toUpperCase();
    if (word === 'NULL') return () => null;
    if (word === 'TRUE') return () => true;
    if (word === 'FALSE') return () => false;
    if ((word === 'DATE' || word === 'TIMESTAMP') && this.peek().kind === 'string') {
      const s = this.next();
      const v = timeLiteral(s.value as string, s.at, word);
      return () => v;
    }
    if (word === 'CURRENT_DATE') return () => new Time(utcDay(Date.now()));
    if (word === 'CURRENT_TIMESTAMP' || (word === 'NOW' && this.isOp('('))) {
      if (word === 'NOW') {
        this.expectOp('(');
        this.expectOp(')');
      }
      return () => new Time(Date.now());
    }
    if (this.isOp('(')) return this.call(word, t);
    if (RESERVED.has(word)) {
      this.i--;
      throw this.unexpected('値・フィールドが必要');
    }
    return this.field(t.text, t.at);
  }

  private call(word: string, t: Token): Expr {
    this.expectOp('(');
    if (word === 'CAST') {
      const e = this.or();
      this.expectWord('AS');
      const type = this.next();
      const name = type.text.toUpperCase();
      // VARCHAR(20), DECIMAL(10, 2): the size does not matter here.
      if (this.acceptOp('(')) {
        while (!this.isOp(')') && this.peek().kind !== 'end') this.i++;
        this.expectOp(')');
      }
      this.expectOp(')');
      if (/^(INT|INTEGER|SMALLINT|BIGINT)$/.test(name)) return (get) => (e(get) === null ? null : Math.trunc(numberOf(e(get))));
      if (/^(FLOAT|REAL|DOUBLE|NUMERIC|DECIMAL)$/.test(name)) return (get) => (e(get) === null ? null : numberOf(e(get)));
      if (/^(CHAR|VARCHAR|TEXT|STRING)$/.test(name)) return (get) => (e(get) === null ? null : textOf(e(get)));
      if (name === 'DATE' || name === 'TIMESTAMP') {
        return (get) => {
          const v = e(get);
          if (v === null) return null;
          const ms = isTime(v) ? v.ms : typeof v === 'string' ? timeOf(v) : numberOf(v);
          return Number.isFinite(ms) ? new Time(name === 'DATE' ? utcDay(ms) : ms) : null;
        };
      }
      throw new SqlError(`CAST で使用不可の型: ${type.text}`, type.at);
    }
    if (word === 'EXTRACT') {
      const part = this.next();
      const name = part.text.toUpperCase();
      const parts: Record<string, (d: Date) => number> = {
        YEAR: (d) => d.getUTCFullYear(),
        MONTH: (d) => d.getUTCMonth() + 1,
        DAY: (d) => d.getUTCDate(),
        HOUR: (d) => d.getUTCHours(),
        MINUTE: (d) => d.getUTCMinutes(),
        SECOND: (d) => d.getUTCSeconds(),
      };
      if (!parts[name]) throw new SqlError(`EXTRACT で使用不可: ${part.text}（YEAR・MONTH・DAY・HOUR・MINUTE・SECOND のいずれか）`, part.at);
      this.expectWord('FROM');
      const e = this.or();
      this.expectOp(')');
      return (get) => {
        const v = e(get);
        if (v === null) return null;
        const ms = isTime(v) ? v.ms : typeof v === 'string' ? timeOf(v) : numberOf(v);
        return Number.isFinite(ms) ? parts[name](new Date(ms)) : null;
      };
    }
    const fn = functions[word];
    if (!fn) throw new SqlError(`不明な関数: ${t.text}`, t.at);
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      args.push(this.or());
      // SUBSTRING(s FROM a FOR b), POSITION(a IN s): the standard's words for the commas.
      for (;;) {
        if (this.acceptOp(',') || (word === 'SUBSTRING' && (this.acceptWord('FROM') || this.acceptWord('FOR'))) || (word === 'POSITION' && this.acceptWord('IN'))) args.push(this.or());
        else break;
      }
    }
    this.expectOp(')');
    if (args.length < fn.min || args.length > fn.max) throw new SqlError(`${word} の引数の数が不正`, t.at);
    return (get) => fn.run(args.map((a) => a(get)));
  }
}

/** A test of features made from a `WHERE`. */
export interface SqlTest {
  /** Whether the thing passes (the `WHERE` is true for it). */
  (get: Get): boolean;
  /** The fields named, as the layer calls them. */
  fields: string[];
}

/**
 * Reads `where` for a layer of `fields` into a test; throws {@link SqlError}
 * when it cannot be read or names a field the layer lacks (unless
 * `anyField`: attributes are then read by the name as written).
 */
export function compileWhere(where: string, fields: readonly SqlField[], anyField = false): SqlTest {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const byLower = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const used = new Set<string>();
  const parser = new Parser(tokenize(where), (name, at) => {
    const field = byName.get(name) ?? byLower.get(name.toLowerCase());
    if (!field && !anyField) throw new SqlError(`不明なフィールド: ${name}`, at);
    const key = field?.name ?? name;
    const date = field?.type === 'date';
    used.add(key);
    return (get) => valueOf(get(key), date);
  });
  const expr = parser.parse();
  const test = ((get: Get) => truth(expr(get)) === true) as SqlTest;
  test.fields = [...used];
  return test;
}

/** What is wrong with `where` for a layer of `fields`, or null when it reads. */
export function checkWhere(where: string, fields: readonly SqlField[]): string | null {
  try {
    compileWhere(where, fields);
    return null;
  } catch (error) {
    if (error instanceof SqlError) return error.message;
    throw error;
  }
}

// --- writing conditions (the condition builder) ---

/** A field name as written in SQL: as is when it is a plain name, else in double quotes. */
export function sqlName(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !RESERVED.has(name.toUpperCase()) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** A SQL string literal. */
export const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The operators the condition builder offers. */
export type ConditionOp = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'contains' | 'not-contains' | 'starts' | 'ends' | 'in' | 'null' | 'not-null';

/** One condition of the builder, joined to the one before it by `join`. */
export interface Condition {
  join: 'AND' | 'OR';
  field: string;
  op: ConditionOp;
  /** The value as typed (for `in`, values separated by commas). */
  value: string;
}

export const conditionOps: Array<[ConditionOp, string]> = [
  ['=', '＝（等しい）'],
  ['<>', '≠（等しくない）'],
  ['>', '＞'],
  ['>=', '≧'],
  ['<', '＜'],
  ['<=', '≦'],
  ['contains', 'を含む'],
  ['not-contains', 'を含まない'],
  ['starts', 'で始まる'],
  ['ends', 'で終わる'],
  ['in', 'のいずれか（カンマ区切り）'],
  ['null', '空（NULL）'],
  ['not-null', '空以外'],
];

/** Whether `op` takes a value. */
export const takesValue = (op: ConditionOp) => op !== 'null' && op !== 'not-null';

const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');
const pad = (n: number) => String(n).padStart(2, '0');
const dayAfter = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
};

/** A value typed for a field, as a SQL literal of the field's type. */
export function sqlLiteral(value: string, field: SqlField | undefined): string {
  const v = value.trim();
  const type = field?.type;
  if ((type === 'integer' || type === 'double' || type === 'oid') && v !== '' && Number.isFinite(Number(v))) return String(Number(v));
  if (type === 'date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `TIMESTAMP '${v} 00:00:00'`;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) return `TIMESTAMP '${v.replace('T', ' ')}${v.length === 16 ? ':00' : ''}'`;
  }
  return sqlString(value);
}

/** One condition as SQL. */
export function conditionSql(c: Condition, field: SqlField | undefined): string {
  const name = sqlName(c.field);
  const v = c.value;
  switch (c.op) {
    case 'null':
      return `${name} IS NULL`;
    case 'not-null':
      return `${name} IS NOT NULL`;
    case 'contains':
      return `${name} LIKE ${sqlString(`%${escapeLike(v)}%`)}${/[\\%_]/.test(v) ? " ESCAPE '\\'" : ''}`;
    case 'not-contains':
      return `${name} NOT LIKE ${sqlString(`%${escapeLike(v)}%`)}${/[\\%_]/.test(v) ? " ESCAPE '\\'" : ''}`;
    case 'starts':
      return `${name} LIKE ${sqlString(`${escapeLike(v)}%`)}${/[\\%_]/.test(v) ? " ESCAPE '\\'" : ''}`;
    case 'ends':
      return `${name} LIKE ${sqlString(`%${escapeLike(v)}`)}${/[\\%_]/.test(v) ? " ESCAPE '\\'" : ''}`;
    case 'in': {
      const values = v.split(/[,、，]/).map((s) => s.trim()).filter((s) => s !== '');
      return `${name} IN (${(values.length ? values : ['']).map((s) => sqlLiteral(s, field)).join(', ')})`;
    }
    default: {
      // A day on a date field means the whole day (UTC, as the dates are stored).
      const day = field?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
      if (day && c.op === '=') return `(${name} >= TIMESTAMP '${day} 00:00:00' AND ${name} < TIMESTAMP '${dayAfter(day)} 00:00:00')`;
      if (day && c.op === '<>') return `(${name} < TIMESTAMP '${day} 00:00:00' OR ${name} >= TIMESTAMP '${dayAfter(day)} 00:00:00')`;
      if (day && c.op === '>') return `${name} >= TIMESTAMP '${dayAfter(day)} 00:00:00'`;
      if (day && c.op === '<=') return `${name} < TIMESTAMP '${dayAfter(day)} 00:00:00'`;
      return `${name} ${c.op} ${sqlLiteral(v, field)}`;
    }
  }
}

/** The builder's conditions as one `WHERE` (in order; AND binds before OR, as in SQL). */
export function conditionsSql(conditions: readonly Condition[], fields: readonly SqlField[]): string {
  const byName = new Map(fields.map((f) => [f.name, f]));
  return conditions
    .filter((c) => c.field)
    .map((c, i) => `${i ? ` ${c.join} ` : ''}${conditionSql(c, byName.get(c.field))}`)
    .join('');
}
