/**
 * Band math: expressions such as `(B4 - B3) / (B4 + B3)` over the bands of
 * images, read once ({@link parseExpression}) and evaluated a block of pixels
 * at a time ({@link evaluate}), each operation over the whole block, so a
 * block costs a few passes over typed arrays rather than a call per pixel.
 * No JavaScript is generated or run from the text.
 *
 * Supported: numbers, variables (named by the caller, case-insensitive),
 * `+ - * / ^`, unary minus, comparisons (`< <= > >= == !=`, 1 or 0),
 * parentheses, and the functions in {@link FUNCTIONS}. Pixels where an input
 * has no data (NaN), or the result is not a finite number (x / 0), get NaN.
 */

/** A parsed expression. */
export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; index: number }
  | { kind: 'unary'; op: '-'; arg: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; name: FunctionName; args: Expr[] };

type BinaryOp = '+' | '-' | '*' | '/' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!=';

/** The functions, with how many arguments each takes ([min, max]). */
export const FUNCTIONS = {
  abs: [1, 1],
  sqrt: [1, 1],
  exp: [1, 1],
  /** Natural logarithm. */
  ln: [1, 1],
  log10: [1, 1],
  min: [2, 8],
  max: [2, 8],
  /** `clamp(x, low, high)`. */
  clamp: [3, 3],
  /** `if(condition, then, else)`: `then` where the condition is not 0. */
  if: [3, 3],
} as const satisfies Record<string, readonly [number, number]>;

export type FunctionName = keyof typeof FUNCTIONS;

/** A mistake in an expression, with where it is (0-based character). */
export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

type Token = { type: 'number'; value: number; at: number } | { type: 'name'; value: string; at: number } | { type: 'op'; value: string; at: number } | { type: 'end'; at: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_぀-ヿ一-鿿][\w぀-ヿ一-鿿]*/.exec(text.slice(i));
    if (name) {
      tokens.push({ type: 'name', value: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = /^(<=|>=|==|!=|\*\*|[-+*/^(),<>])/.exec(text.slice(i));
    if (op) {
      tokens.push({ type: 'op', value: op[0] === '**' ? '^' : op[0], at: i });
      i += op[0].length;
      continue;
    }
    throw new ExpressionError(`使えない文字「${c}」があります`, i);
  }
  tokens.push({ type: 'end', at: text.length });
  return tokens;
}

/**
 * Reads `text` with `variables` as the names it may use (matched without
 * regard to case). Throws an {@link ExpressionError} saying what is wrong.
 */
export function parseExpression(text: string, variables: readonly string[]): Expr {
  if (!text.trim()) throw new ExpressionError('式を入力してください', 0);
  const tokens = tokenize(text);
  const lower = variables.map((v) => v.toLowerCase());
  let k = 0;
  const peek = () => tokens[k];
  const isOp = (value: string) => {
    const t = peek();
    return t.type === 'op' && t.value === value;
  };
  const expect = (value: string) => {
    if (!isOp(value)) throw new ExpressionError(`「${value}」が必要です`, peek().at);
    k++;
  };

  // comparison < additive < multiplicative < unary < power < primary
  const comparison = (): Expr => {
    let left = additive();
    for (;;) {
      const t = peek();
      if (t.type === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.value)) {
        k++;
        left = { kind: 'binary', op: t.value as BinaryOp, left, right: additive() };
      } else return left;
    }
  };
  const additive = (): Expr => {
    let left = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[k++] as { value: string }).value as BinaryOp;
      left = { kind: 'binary', op, left, right: multiplicative() };
    }
    return left;
  };
  const multiplicative = (): Expr => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[k++] as { value: string }).value as BinaryOp;
      left = { kind: 'binary', op, left, right: unary() };
    }
    return left;
  };
  const unary = (): Expr => {
    if (isOp('-')) {
      k++;
      return { kind: 'unary', op: '-', arg: unary() };
    }
    if (isOp('+')) {
      k++;
      return unary();
    }
    return power();
  };
  const power = (): Expr => {
    const base = primary();
    if (isOp('^')) {
      k++;
      // Right-associative, and binds tighter than a minus before it: -2^2 = -4.
      return { kind: 'binary', op: '^', left: base, right: unary() };
    }
    return base;
  };
  const primary = (): Expr => {
    const t = peek();
    if (t.type === 'number') {
      k++;
      return { kind: 'number', value: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      k++;
      const inner = comparison();
      expect(')');
      return inner;
    }
    if (t.type === 'name') {
      k++;
      const name = t.value.toLowerCase();
      if (isOp('(')) {
        if (!Object.hasOwn(FUNCTIONS, name)) throw new ExpressionError(`関数「${t.value}」はありません（使える関数: ${Object.keys(FUNCTIONS).join(', ')}）`, t.at);
        k++;
        const args: Expr[] = [];
        if (!isOp(')')) {
          args.push(comparison());
          while (isOp(',')) {
            k++;
            args.push(comparison());
          }
        }
        expect(')');
        const [min, max] = FUNCTIONS[name as FunctionName];
        if (args.length < min || args.length > max) throw new ExpressionError(`${name} の引数は ${min === max ? min : `${min}〜${max}`} 個です`, t.at);
        return { kind: 'call', name: name as FunctionName, args };
      }
      const index = lower.indexOf(name);
      if (index < 0) throw new ExpressionError(`「${t.value}」は使えません（使える名前: ${variables.join(', ')}）`, t.at);
      return { kind: 'variable', index };
    }
    if (t.type === 'end') throw new ExpressionError('式が途中で終わっています', t.at);
    throw new ExpressionError(`「${(t as { value: string }).value}」の位置がおかしいです`, t.at);
  };

  const expr = comparison();
  if (peek().type !== 'end') throw new ExpressionError(`「${(peek() as { value: string }).value}」の位置がおかしいです`, peek().at);
  return expr;
}

/** The variables an expression uses (indexes into the names it was read with), in order. */
export function variablesOf(expr: Expr): number[] {
  const out = new Set<number>();
  const walk = (e: Expr): void => {
    if (e.kind === 'variable') out.add(e.index);
    else if (e.kind === 'unary') walk(e.arg);
    else if (e.kind === 'binary') {
      walk(e.left);
      walk(e.right);
    } else if (e.kind === 'call') e.args.forEach(walk);
  };
  walk(expr);
  return [...out].sort((a, b) => a - b);
}

/** `expr` reading only the variables `used` (as from {@link variablesOf}), renumbered in that order. */
export function onlyVariables(expr: Expr, used: readonly number[]): Expr {
  const walk = (e: Expr): Expr => {
    if (e.kind === 'variable') return { kind: 'variable', index: used.indexOf(e.index) };
    if (e.kind === 'unary') return { ...e, arg: walk(e.arg) };
    if (e.kind === 'binary') return { ...e, left: walk(e.left), right: walk(e.right) };
    if (e.kind === 'call') return { ...e, args: e.args.map(walk) };
    return e;
  };
  return walk(expr);
}

/** A value of every pixel, or one number for all of them. */
type Values = Float32Array | number;

const map1 = (a: Values, f: (x: number) => number, n: number): Values => {
  if (typeof a === 'number') return f(a);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(a[i]);
  return out;
};

// The four arithmetic operators each have their own loops: one loop calling
// whichever operator it is handed cannot inline it, which makes it several
// times slower on a block of millions of pixels.
type Loop = (out: Float32Array, a: Float32Array, b: Float32Array, n: number) => void;
type ScalarLoop = (out: Float32Array, a: Float32Array, b: number, n: number) => void;
const arithmetic: Partial<Record<BinaryOp, { both: Loop; left: ScalarLoop; right: ScalarLoop }>> = {
  '+': {
    both: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] + b[i]; },
    left: (out, b, a, n) => { for (let i = 0; i < n; i++) out[i] = a + b[i]; },
    right: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] + b; },
  },
  '-': {
    both: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] - b[i]; },
    left: (out, b, a, n) => { for (let i = 0; i < n; i++) out[i] = a - b[i]; },
    right: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] - b; },
  },
  '*': {
    both: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] * b[i]; },
    left: (out, b, a, n) => { for (let i = 0; i < n; i++) out[i] = a * b[i]; },
    right: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] * b; },
  },
  '/': {
    both: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] / b[i]; },
    left: (out, b, a, n) => { for (let i = 0; i < n; i++) out[i] = a / b[i]; },
    right: (out, a, b, n) => { for (let i = 0; i < n; i++) out[i] = a[i] / b; },
  },
};

/** `a op b` at every pixel, written over `a` or `b` when it is a step's result (not an input). */
const operate = (a: Values, b: Values, op: BinaryOp, n: number, inputs: readonly Float32Array[]): Values => {
  const loops = arithmetic[op];
  if (!loops || (typeof a === 'number' && typeof b === 'number')) return map2(a, b, binary[op], n);
  const scratch = (v: Values): v is Float32Array => typeof v !== 'number' && !inputs.includes(v);
  const out = scratch(a) ? a : scratch(b) ? b : new Float32Array(n);
  if (typeof a === 'number') loops.left(out, b as Float32Array, a, n);
  else if (typeof b === 'number') loops.right(out, a, b, n);
  else loops.both(out, a, b, n);
  return out;
};

const map2 = (a: Values, b: Values, f: (x: number, y: number) => number, n: number): Values => {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  const out = new Float32Array(n);
  if (typeof a === 'number') for (let i = 0; i < n; i++) out[i] = f(a, (b as Float32Array)[i]);
  else if (typeof b === 'number') for (let i = 0; i < n; i++) out[i] = f(a[i], b);
  else for (let i = 0; i < n; i++) out[i] = f(a[i], b[i]);
  return out;
};

const binary: Record<BinaryOp, (x: number, y: number) => number> = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '^': (x, y) => x ** y,
  // A comparison with no data stays no data.
  '<': (x, y) => (x !== x || y !== y ? NaN : x < y ? 1 : 0),
  '<=': (x, y) => (x !== x || y !== y ? NaN : x <= y ? 1 : 0),
  '>': (x, y) => (x !== x || y !== y ? NaN : x > y ? 1 : 0),
  '>=': (x, y) => (x !== x || y !== y ? NaN : x >= y ? 1 : 0),
  '==': (x, y) => (x !== x || y !== y ? NaN : x === y ? 1 : 0),
  '!=': (x, y) => (x !== x || y !== y ? NaN : x !== y ? 1 : 0),
};

const unaryFunctions: Partial<Record<FunctionName, (x: number) => number>> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
};

/**
 * The value of `expr` at each of `n` pixels, `inputs[i]` holding variable
 * `i` (NaN where it has no data). Not-finite results become NaN.
 */
export function evaluate(expr: Expr, inputs: readonly Float32Array[], n: number): Float32Array {
  const run = (e: Expr): Values => {
    switch (e.kind) {
      case 'number':
        return e.value;
      case 'variable':
        return inputs[e.index];
      case 'unary':
        return map1(run(e.arg), (x) => -x, n);
      case 'binary':
        return operate(run(e.left), run(e.right), e.op, n, inputs);
      case 'call': {
        const args = e.args.map(run);
        const one = unaryFunctions[e.name];
        if (one) return map1(args[0], one, n);
        if (e.name === 'min' || e.name === 'max') {
          const pick = e.name === 'min' ? Math.min : Math.max;
          return args.slice(1).reduce((acc: Values, b) => map2(acc, b, pick, n), args[0]);
        }
        if (e.name === 'clamp') return map2(map2(args[0], args[1], Math.max, n), args[2], Math.min, n);
        // if(c, a, b)
        const [c, a, b] = args;
        const at = (v: Values, i: number) => (typeof v === 'number' ? v : v[i]);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const cond = at(c, i);
          out[i] = cond !== cond ? NaN : cond ? at(a, i) : at(b, i);
        }
        return out;
      }
    }
  };
  const result = run(expr);
  const out = typeof result === 'number' ? new Float32Array(n).fill(result) : result === inputs[0] || inputs.includes(result) ? Float32Array.from(result) : result;
  // Not finite (x - x is NaN for NaN and ±Infinity) becomes NaN.
  for (let i = 0; i < n; i++) {
    const v = out[i];
    if (v - v !== 0) out[i] = NaN;
  }
  // A pixel where any input has no data has none (already so where every operation on the way passes NaN on).
  if (!passesNaN(expr, inputs.length)) for (const input of inputs) for (let i = 0; i < n; i++) if (input[i] !== input[i]) out[i] = NaN;
  return out;
}

/**
 * Whether `expr` is NaN wherever one of its `count` variables is: it reads
 * every one, and everything on the way passes NaN on (`x ^ 0` and `if` need
 * not, so they do not count).
 */
function passesNaN(expr: Expr, count: number): boolean {
  const seen = new Set<number>();
  const walk = (e: Expr): boolean => {
    switch (e.kind) {
      case 'number':
        return true;
      case 'variable':
        seen.add(e.index);
        return true;
      case 'unary':
        return walk(e.arg);
      case 'binary':
        return e.op !== '^' && walk(e.left) && walk(e.right);
      case 'call':
        return e.name !== 'if' && e.args.every(walk);
    }
  };
  return walk(expr) && seen.size === count;
}

/** One index, by its usual band names. */
export interface IndexPreset {
  id: string;
  label: string;
  /** The bands it uses, by role. */
  roles: Array<{ name: string; label: string }>;
  /** The expression, over the role names. */
  expression: string;
  /** What it shows. */
  hint: string;
}

/** The indices offered by name; anything else is typed under 「自由式」. */
export const INDEX_PRESETS: readonly IndexPreset[] = [
  {
    id: 'ndvi',
    label: 'NDVI（植生）',
    roles: [
      { name: 'NIR', label: '近赤外（NIR）' },
      { name: 'Red', label: '赤（Red）' },
    ],
    expression: '(NIR - Red) / (NIR + Red)',
    hint: '植物の多い所ほど大きく（〜1）、水・裸地は 0 付近か負になります。',
  },
  {
    id: 'ndwi',
    label: 'NDWI（水域）',
    roles: [
      { name: 'Green', label: '緑（Green）' },
      { name: 'NIR', label: '近赤外（NIR）' },
    ],
    expression: '(Green - NIR) / (Green + NIR)',
    hint: '水面が正（明るく）、陸は負になります（McFeeters）。',
  },
  {
    id: 'ndbi',
    label: 'NDBI（市街地）',
    roles: [
      { name: 'SWIR', label: '短波長赤外（SWIR）' },
      { name: 'NIR', label: '近赤外（NIR）' },
    ],
    expression: '(SWIR - NIR) / (SWIR + NIR)',
    hint: '建物・舗装の多い所ほど大きくなります。',
  },
  {
    id: 'savi',
    label: 'SAVI（土壌補正植生）',
    roles: [
      { name: 'NIR', label: '近赤外（NIR）' },
      { name: 'Red', label: '赤（Red）' },
    ],
    expression: '1.5 * (NIR - Red) / (NIR + Red + 0.5)',
    hint: '植生がまばらな所で土の影響を抑えた NDVI です（L = 0.5）。',
  },
  {
    id: 'evi',
    label: 'EVI（強調植生）',
    roles: [
      { name: 'NIR', label: '近赤外（NIR）' },
      { name: 'Red', label: '赤（Red）' },
      { name: 'Blue', label: '青（Blue）' },
    ],
    expression: '2.5 * (NIR - Red) / (NIR + 6 * Red - 7.5 * Blue + 1)',
    hint: '植生の多い所でも飽和しにくい指標です。反射率（0〜1）の画像で使ってください。',
  },
];

/** Words in band names (GDAL DESCRIPTION, sensor band names) that tell a role. */
const ROLE_WORDS: Record<string, RegExp> = {
  NIR: /\b(nir|near[\s_-]?infra|b8a?\b|band[\s_]?8\b)|近赤外/i,
  Red: /^(?!.*(edge|infra|nir)).*\b(red|r)\b|^赤$/i,
  Green: /\b(green|g)\b|^緑$/i,
  Blue: /\b(blue|b)\b|^青$/i,
  SWIR: /\bswir|短波長/i,
};

/**
 * The band (0-based) for each role, from the band names when they say so,
 * else the usual order of a sensor with that many bands (blue, green, red,
 * near infrared for four bands or more; SWIR is the fifth or sixth band
 * only when the names say so). Null where nothing fits.
 */
export function guessRoles(roles: readonly string[], bandCount: number, names: readonly string[] = []): Array<number | null> {
  const taken = new Set<number>();
  return roles.map((role) => {
    const words = ROLE_WORDS[role];
    const named = words ? names.findIndex((n, i) => !taken.has(i) && words.test(n.trim())) : -1;
    let band: number | null = named >= 0 ? named : null;
    if (band === null && bandCount >= 4) band = { Blue: 0, Green: 1, Red: 2, NIR: 3 }[role] ?? null;
    if (band === null && bandCount === 3) band = { Blue: 2, Green: 1, Red: 0 }[role] ?? null;
    if (band !== null && band >= bandCount) band = null;
    if (band !== null) taken.add(band);
    return band;
  });
}
