/**
 * A small XML reader for files from other programs (QGIS styles and
 * projects, SLD): elements, attributes and text, nothing else. Entities
 * other than the five predefined ones and character references are never
 * expanded, a document type that declares any is refused, and the size and
 * depth are capped, so a hostile file cannot make the reader fetch anything
 * or grow without bound. It needs no DOM, so it also runs in workers and
 * unit tests.
 */

/** An element: its qualified name, its local name (without a prefix), attributes, child elements and own text. */
export interface XmlElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The text directly inside the element (its children's text not included). */
  text: string;
}

/** The most characters read by default (20 MB). */
export const MAX_XML = 20_000_000;
const MAX_DEPTH = 256;
const MAX_ELEMENTS = 2_000_000;

export class XmlError extends Error {}

const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text with the predefined entities and character references replaced; others stay as written. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[ref] ?? whole;
  });
}

/** Text as XML writes it in attributes and elements. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

const localOf = (name: string) => name.slice(name.indexOf(':') + 1);

/** Reads an XML document; throws {@link XmlError} with a message for the status line when it cannot. */
export function parseXml(text: string, maxChars = MAX_XML): XmlElement {
  if (text.length > maxChars) throw new XmlError(`ファイルが大きすぎます（${Math.round(maxChars / 1e6)} MB まで）`);
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const fail = (what: string): never => {
    throw new XmlError(`XML として読めません（${what}）`);
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i && stack.length) stack[stack.length - 1].text += decodeXml(text.slice(i, end));
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) fail('コメントが閉じていません');
      i = close + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close < 0) fail('CDATA が閉じていません');
      if (stack.length) stack[stack.length - 1].text += text.slice(lt + 9, close);
      i = close + 3;
    } else if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2);
      if (close < 0) fail('処理命令が閉じていません');
      i = close + 2;
    } else if (text.startsWith('<!', lt)) {
      // A document type: one with an internal subset may declare entities, which are refused.
      let j = lt + 2;
      let depth = 0;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) fail('文書型宣言が閉じていません');
      if (/<!ENTITY/i.test(text.slice(lt, j))) throw new XmlError('実体（ENTITY）を宣言した XML は安全のため読みません');
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const close = text.indexOf('>', lt);
      if (close < 0) fail('終了タグが閉じていません');
      const name = text.slice(lt + 2, close).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`</${name}> が対応していません`);
      i = close + 1;
    } else {
      // A start tag: its end is the first `>` outside quotes.
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) fail('タグが閉じていません');
      const selfClosing = text[j - 1] === '/';
      const body = text.slice(lt + 1, selfClosing ? j - 1 : j);
      const m = /^[^\s/>]+/.exec(body);
      if (!m) fail('要素名がありません');
      const name = m![0];
      const attrs: Record<string, string> = {};
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      const rest = body.slice(name.length);
      let a: RegExpExecArray | null;
      while ((a = re.exec(rest))) attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '');
      const element: XmlElement = { name, local: localOf(name), attrs, children: [], text: '' };
      if (++count > MAX_ELEMENTS) fail('要素が多すぎます');
      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root) fail('ルート要素が二つあります');
      else root = element;
      if (!selfClosing) {
        stack.push(element);
        if (stack.length > MAX_DEPTH) fail('入れ子が深すぎます');
      }
      i = j + 1;
    }
  }
  if (!root) fail('要素がありません');
  if (stack.length) fail(`<${stack[stack.length - 1].name}> が閉じていません`);
  return root!;
}

/** The child elements named `local` (any prefix). */
export function kids(el: XmlElement | null | undefined, local: string): XmlElement[] {
  return el ? el.children.filter((c) => c.local === local) : [];
}

/** The first child element named `local` (any prefix). */
export function kid(el: XmlElement | null | undefined, local: string): XmlElement | undefined {
  return el?.children.find((c) => c.local === local);
}

/** The first element down a path of local names, each a child of the one before. */
export function path(el: XmlElement | null | undefined, ...names: string[]): XmlElement | undefined {
  let at: XmlElement | undefined = el ?? undefined;
  for (const name of names) at = kid(at, name);
  return at;
}

/** Every element under `el` named `local`, in document order. */
export function descendants(el: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.local === local) out.push(c);
    descendants(c, local, out);
  }
  return out;
}

/** The first element under `el` named `local`. */
export function descendant(el: XmlElement | null | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (c.local === local) return c;
    const found = descendant(c, local);
    if (found) return found;
  }
  return undefined;
}

/** All the text inside `el`, its children's included, trimmed. */
export function textOf(el: XmlElement | null | undefined): string {
  if (!el) return '';
  const all = (e: XmlElement): string => e.text + e.children.map(all).join('');
  return all(el).trim();
}

/** An attribute by its local name (any prefix), or null. */
export function attr(el: XmlElement | null | undefined, local: string): string | null {
  if (!el) return null;
  if (local in el.attrs) return el.attrs[local];
  for (const [k, v] of Object.entries(el.attrs)) if (localOf(k) === local) return v;
  return null;
}
