/**
 * Runs the viewer's tool dialogs for a script: the dialog opens as the
 * person would open it, each setting the script gives goes into the
 * control of that name (checked against what the control takes), and the
 * dialog's own 「実行」 runs. Results are what the dialog makes: new layers.
 *
 * Only the dialogs listed as tools are driven, and only their own form
 * controls of the kinds below are set (no file, URL or hidden fields).
 */

/** One tool a script can run. */
export interface ScriptTool {
  /** As the script names it: `buffer`, `band-math`… */
  id: string;
  /** As the menu shows it. */
  label: string;
  dialog: HTMLDialogElement;
  /** Opens the dialog (with its defaults). */
  open: () => void | Promise<void>;
  /** What the dialog's 「実行」 does. */
  run: () => Promise<unknown>;
}

/** Control types a script may set. */
const SETTABLE = new Set(['text', 'number', 'search', 'checkbox', 'radio', 'range', 'color', 'select-one', 'textarea']);
/** Longest text a script may type into a control. */
const MAX_TEXT = 10_000;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Lets a dialog react to a change (fill the choices that depend on it, read band names) before the next setting. */
export const settle = () => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => setTimeout(resolve, 0)), 0));

/** The controls of a dialog a script can set, by name. */
export function controlsOf(dialog: HTMLElement): Map<string, Control[]> {
  const out = new Map<string, Control[]>();
  for (const c of dialog.querySelectorAll<Control>('input[name], select[name], textarea[name]')) {
    if (!SETTABLE.has(c.type) || c.closest('[hidden]')) continue;
    const list = out.get(c.name) ?? [];
    list.push(c);
    out.set(c.name, list);
  }
  return out;
}

/** What a script can set in a dialog, for messages and `viewer.tools()`: name → the choices of a select or radio group (empty for free input). */
export function describeControls(dialog: HTMLElement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, list] of controlsOf(dialog)) {
    const first = list[0];
    if (first instanceof HTMLSelectElement) out[name] = [...first.options].map((o) => (o.value === o.text ? o.value : `${o.value}（${o.text.trim()}）`));
    else if (first.type === 'radio') out[name] = list.map((r) => (r as HTMLInputElement).value);
    else out[name] = [first.type === 'checkbox' ? 'true / false' : first.type];
  }
  return out;
}

const fire = (c: Element) => {
  c.dispatchEvent(new Event('input', { bubbles: true }));
  c.dispatchEvent(new Event('change', { bubbles: true }));
};

/** The option of `select` a script means by `value`: a layer (by name), an option value, or the option's text. */
function optionOf(select: HTMLSelectElement, value: unknown, layerName: (v: unknown) => string | null): HTMLOptionElement | null {
  const options = [...select.options].filter((o) => !o.disabled);
  const byText = (text: string) => options.find((o) => o.text.trim() === text) ?? options.find((o) => o.text.startsWith(`${text}（`) || o.text.startsWith(`${text} `));
  const name = layerName(value);
  if (name !== null) {
    const found = byText(name);
    if (found) return found;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  return options.find((o) => o.value === text) ?? byText(text) ?? null;
}

/**
 * Sets the control `name` of `dialog` to `value`. `layerName` turns a layer
 * the script names (its id or info object) into the name the dialog lists.
 */
export async function setControl(dialog: HTMLElement, name: string, value: unknown, layerName: (v: unknown) => string | null, label: string): Promise<void> {
  const controls = controlsOf(dialog);
  if (name === 'checked') return setChecks(dialog, value, layerName, label);
  const list = controls.get(name);
  if (!list) throw new Error(`${label}に「${name}」という項目はありません。使える項目: ${[...controls.keys()].join(', ') || '（なし）'}`);
  const first = list[0];
  if (first.disabled) throw new Error(`${label}の「${name}」は今は設定できません`);
  if (first instanceof HTMLSelectElement) {
    const option = optionOf(first, value, layerName);
    if (!option) throw new Error(`${label}の「${name}」に ${JSON.stringify(value)} はありません。選べるもの: ${describeControls(dialog)[name].join(' / ')}`);
    first.value = option.value;
  } else if (first.type === 'radio') {
    const radio = (list as HTMLInputElement[]).find((r) => r.value === String(value));
    if (!radio) throw new Error(`${label}の「${name}」は ${list.map((r) => (r as HTMLInputElement).value).join(' / ')} のどれかです`);
    radio.checked = true;
    fire(radio);
    await settle();
    return;
  } else if (first.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new TypeError(`${label}の「${name}」は true か false で指定してください`);
    (first as HTMLInputElement).checked = value;
  } else if (first.type === 'number' || first.type === 'range') {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${label}の「${name}」は数値で指定してください`);
    const input = first as HTMLInputElement;
    if ((input.min !== '' && n < Number(input.min)) || (input.max !== '' && n > Number(input.max))) {
      throw new RangeError(`${label}の「${name}」は ${input.min || '−∞'}〜${input.max || '∞'} です`);
    }
    input.value = String(n);
  } else {
    if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${label}の「${name}」は文字列で指定してください`);
    first.value = String(value).slice(0, MAX_TEXT);
  }
  fire(first);
  await settle();
}

/** Ticks the unnamed check boxes of a dialog's list (images of a mosaic, bands to classify) given by label or value, and unticks the rest. */
async function setChecks(dialog: HTMLElement, value: unknown, layerName: (v: unknown) => string | null, label: string): Promise<void> {
  const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type=checkbox]:not([name])')].filter((b) => !b.closest('[hidden]'));
  if (!boxes.length) throw new Error(`${label}には checked で選ぶ一覧がありません`);
  if (!Array.isArray(value)) throw new TypeError(`${label}の checked は配列で指定してください`);
  const text = (b: HTMLInputElement) => b.closest('label')?.textContent?.trim() ?? '';
  const wanted = new Set<HTMLInputElement>();
  for (const v of value) {
    const name = layerName(v);
    const box =
      (name !== null ? boxes.find((b) => text(b) === name) : undefined) ??
      boxes.find((b) => b.value === String(v)) ??
      boxes.find((b) => text(b) === String(v));
    if (!box) throw new Error(`${label}の一覧に ${JSON.stringify(v)} はありません。一覧: ${boxes.map(text).join(' / ')}`);
    wanted.add(box);
  }
  for (const b of boxes) {
    if (b.checked === wanted.has(b)) continue;
    b.checked = wanted.has(b);
    fire(b);
  }
  await settle();
}

/** Text the dialog shows about its run (an error, or what it made). */
export function statusOf(dialog: HTMLElement): string {
  return [...dialog.querySelectorAll('[role=status]')]
    .map((e) => e.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}
