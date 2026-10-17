/**
 * Colouring of the script editor: the script as HTML with `<span class="hl-…">`
 * around comments, strings, numbers, keywords, the viewer's names and
 * function calls. A small scanner of JavaScript's tokens, not a parser: it
 * is drawn under the textarea on every keystroke, so it only has to be fast
 * and never lose or reorder a character.
 */

const KEYWORDS = new Set(
  'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(
    ' ',
  ),
);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** What the sandbox gives a script besides the language. */
const BUILTINS = new Set(['viewer', 'geo', 'print', 'console', 'progress', 'sleep', 'toCsv', 'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Date', 'Map', 'Set', 'Promise', 'Error']);

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `code` as HTML with its tokens wrapped in spans of class `hl-comment`, `hl-string`, `hl-number`, `hl-keyword`, `hl-literal`, `hl-builtin`, `hl-function` and `hl-regex`. */
export function highlight(code: string): string {
  let out = '';
  let i = 0;
  // Whether a `/` here would start a regular expression (no value just before it).
  let regexOk = true;
  const n = code.length;
  const wrap = (kind: string, text: string) => `<span class="hl-${kind}">${escape(text)}</span>`;
  // The end of a quoted string or template starting at `from` (the closing quote included; the end of the line or text when it is not closed).
  const quoted = (from: number, quote: string) => {
    let j = from + 1;
    while (j < n) {
      const c = code[j];
      if (c === '\\') j += 2;
      else if (c === quote) return j + 1;
      else if (c === '\n' && quote !== '`') return j;
      else j++;
    }
    return n;
  };
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += wrap('comment', code.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += wrap('comment', code.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      const stop = quoted(i, c);
      out += wrap('string', code.slice(i, stop));
      i = stop;
      regexOk = false;
    } else if (c === '/' && regexOk) {
      // A regular expression: up to the closing `/` outside a class, then its flags.
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== '\n') {
        const d = code[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      if (j < n && code[j] === '/') {
        j++;
        while (j < n && /[a-z]/i.test(code[j])) j++;
        out += wrap('regex', code.slice(i, j));
        i = j;
        regexOk = false;
      } else {
        out += escape(c);
        i++;
      }
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const m = /^(?:0[xob][0-9a-f_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?n?)/i.exec(code.slice(i, i + 64))!;
      out += wrap('number', m[0]);
      i += m[0].length;
      regexOk = false;
    } else if (/[\p{L}_$]/u.test(c)) {
      const m = /^[\p{L}\p{N}_$]+/u.exec(code.slice(i, i + 256))!;
      const word = m[0];
      const before = code[i - 1];
      const property = before === '.' && code[i - 2] !== '.';
      let after = i + word.length;
      while (code[after] === ' ' || code[after] === '\t') after++;
      const call = code[after] === '(';
      const kind = property
        ? call
          ? 'function'
          : ''
        : KEYWORDS.has(word)
          ? 'keyword'
          : LITERALS.has(word)
            ? 'literal'
            : BUILTINS.has(word)
              ? 'builtin'
              : call
                ? 'function'
                : '';
      out += kind ? wrap(kind, word) : escape(word);
      i += word.length;
      // After a keyword such as `return` a `/` starts a regular expression; after a name it divides.
      regexOk = !property && KEYWORDS.has(word) && word !== 'this' && word !== 'super';
    } else {
      out += escape(c);
      i++;
      if (c === ')' || c === ']' || c === '}') regexOk = false;
      else if (!/\s/.test(c)) regexOk = true;
    }
  }
  return out;
}
