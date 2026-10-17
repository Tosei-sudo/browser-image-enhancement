/**
 * The command palette (Ctrl+K / ⌘K): every tool by name. Typing narrows the
 * list (both hiragana and katakana, full- or half-width, and the words of a
 * tool's tooltip match), Enter runs the chosen one. With nothing typed, the
 * tools used most recently come first.
 *
 * The buttons of the bar, its menus and the side panel are found by
 * themselves (`buttonCommands`), so a new tool shows up here without being
 * listed twice; tools without a button of their own (the processing tools)
 * are added by the caller.
 */

export interface Command {
  /** Stable, for remembering the recent ones. */
  id: string;
  label: string;
  /** Where it lives or what it does (the menu heading, the tooltip). */
  detail?: string;
  /** Shortcut keys to show, as written in aria-keyshortcuts (`Control+S`). */
  keys?: string;
  run: () => void;
}

const RECENT_KEY = 'image-viewer.palette.recent';
const RECENT_MAX = 8;

/** Lower case, full-width folded to half-width (NFKC), katakana to hiragana, without the 「…」 of a button that opens a dialog. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/…|\.\.\./g, '')
    .trim();
}

/**
 * Readings of the words the tools are named with, so a name still being typed
 * in kana (before the IME turns it into kanji) already finds them.
 */
const READINGS: Record<string, string> = {
  保存: 'ほぞん',
  開: 'ひらく',
  距離: 'きょり',
  面積: 'めんせき',
  計測: 'けいそく',
  測: 'はかる',
  消去: 'しょうきょ',
  追加: 'ついか',
  新規: 'しんき',
  解析: 'かいせき',
  物体検出: 'ぶったいけんしゅつ',
  抽出: 'ちゅうしゅつ',
  転記: 'てんき',
  集計: 'しゅうけい',
  撮像計画: 'さつぞうけいかく',
  注記: 'ちゅうき',
  表示範囲: 'ひょうじはんい',
  印刷: 'いんさつ',
  表示: 'ひょうじ',
  比較: 'ひかく',
  情報: 'じょうほう',
  名前: 'なまえ',
  座標: 'ざひょう',
  移動: 'いどう',
  変化: 'へんか',
  位置合: 'いちあわせ',
  着色: 'ちゃくしょく',
  合成: 'ごうせい',
  投影: 'とうえい',
  演算: 'えんざん',
  指標: 'しひょう',
  透明化: 'とうめいか',
  重心: 'じゅうしん',
  分割: 'ぶんかつ',
  変換: 'へんかん',
  画像: 'がぞう',
  背景地図: 'はいけいちず',
  地図: 'ちず',
  統計: 'とうけい',
  検索: 'けんさく',
  地名: 'ちめい',
  住所: 'じゅうしょ',
  高: 'たかさ',
  影: 'かげ',
};

/** `text` normalized, followed by the readings of the words in it. */
function searchable(text: string): string {
  const base = normalize(text);
  const readings = Object.entries(READINGS)
    .filter(([word]) => base.includes(word))
    .map(([, reading]) => reading);
  return readings.length ? `${base} ${readings.join(' ')}` : base;
}

/**
 * How well `command` matches `query` (higher is better), or -1 when some
 * word of the query is in neither its label nor its detail. Words found in
 * the label count more, at its start most.
 */
export function score(command: Pick<Command, 'label' | 'detail'>, query: string): number {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = normalize(command.label);
  const spoken = searchable(command.label).slice(label.length);
  const detail = searchable(command.detail ?? '');
  let total = 0;
  for (const word of words) {
    const at = label.indexOf(word);
    if (at === 0) total += 100;
    else if (at > 0) total += 60 - Math.min(at, 30);
    else if (spoken.includes(word)) total += 40;
    else if (detail.includes(word)) total += 10;
    else return -1;
  }
  // Of equal matches, the shorter label is the closer one.
  return total - label.length / 100;
}

/** The commands matching `query`, best first; with no query, the recent ones first and the rest in their order. */
export function rank(commands: Command[], query: string, recent: string[] = []): Command[] {
  if (!normalize(query)) {
    const at = (c: Command) => {
      const i = recent.indexOf(c.id);
      return i < 0 ? Infinity : i;
    };
    return commands.map((c, i) => ({ c, i })).sort((a, b) => at(a.c) - at(b.c) || a.i - b.i).map(({ c }) => c);
  }
  return commands
    .map((c, i) => ({ c, i, s: score(c, query) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ c }) => c);
}

function label(button: HTMLButtonElement): string {
  return (button.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The heading a menu button sits under: the menu's 「計測」「解析」…, or the menu's own name. */
function section(button: HTMLButtonElement): string {
  const group = button.closest('.measure-tools, .point-tools, [role=group], [role=radiogroup]');
  let heading = group?.previousElementSibling;
  if (heading?.classList.contains('menu-heading')) return heading.textContent?.trim() ?? '';
  heading = button.closest('.menu')?.querySelector('.menu-button');
  if (heading) return heading.textContent?.trim() ?? '';
  return button.closest('[aria-label]')?.getAttribute('aria-label') ?? '';
}

/** Whether `button` can be used now: not disabled, and not hidden other than by a closed menu. */
function usable(button: HTMLButtonElement): boolean {
  if (button.disabled) return false;
  for (let node: HTMLElement | null = button; node; node = node.parentElement) {
    if (node.hidden && !node.classList.contains('menu-panel')) return false;
  }
  return true;
}

/**
 * Commands for the buttons under `roots`: each runs by clicking its button.
 * Menu buttons themselves, and buttons with no text, are left out.
 */
export function buttonCommands(roots: Iterable<Element>): Command[] {
  const commands: Command[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
      if (button.classList.contains('menu-button') || button.type === 'submit' || !usable(button)) continue;
      const text = label(button);
      if (!text || text.length > 40) continue;
      const where = section(button);
      const id = button.id || `${where}:${text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const title = button.title.replace(/（[^）]*）$/, '');
      commands.push({
        id,
        label: button.getAttribute('role') === 'radio' && where ? `${where}: ${text}` : text,
        detail: [where, title].filter(Boolean).join(' — '),
        keys: button.getAttribute('aria-keyshortcuts') ?? undefined,
        run: () => button.click(),
      });
    }
  }
  return commands;
}

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the order lasts for this page only.
  }
}

/** `Control+Shift+S` → `Ctrl + Shift + S`. */
function keyText(keys: string): string {
  return keys
    .split(' ')[0]
    .split('+')
    .map((k) => (k === 'Control' ? 'Ctrl' : k))
    .join(' + ');
}

/** The palette dialog. `commands` is asked afresh each time it opens, so it lists what can be used then. */
export class CommandPalette {
  readonly dialog: HTMLDialogElement;
  private readonly input_: HTMLInputElement;
  private readonly list_: HTMLUListElement;
  private readonly empty_: HTMLElement;
  private all_: Command[] = [];
  private shown_: Command[] = [];
  private active_ = 0;
  private recent_ = readRecent();

  constructor(private readonly commands: () => Command[]) {
    const dialog = (this.dialog = document.createElement('dialog'));
    dialog.className = 'command-palette';
    dialog.setAttribute('aria-label', 'コマンド');
    dialog.innerHTML = `
      <input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
        aria-label="機能を検索" placeholder="機能を検索（例: 距離、ndvi、保存）" autocomplete="off" spellcheck="false" />
      <ul id="palette-list" role="listbox" aria-label="機能"></ul>
      <p class="palette-empty" hidden>一致する機能がありません</p>
      <p class="palette-hint"><kbd>↑</kbd><kbd>↓</kbd> 選ぶ <kbd>Enter</kbd> 実行 <kbd>Esc</kbd> 閉じる</p>`;
    this.input_ = dialog.querySelector('input')!;
    this.list_ = dialog.querySelector('ul')!;
    this.empty_ = dialog.querySelector('.palette-empty')!;
    this.input_.addEventListener('input', () => this.filter_());
    this.input_.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = this.shown_.length;
        if (n) this.select_((this.active_ + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.run_(this.active_);
      }
    });
    this.list_.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('li');
      if (item) this.run_(Number(item.dataset.index));
    });
    this.list_.addEventListener('pointermove', (e) => {
      const item = (e.target as HTMLElement).closest('li');
      if (item && Number(item.dataset.index) !== this.active_) this.select_(Number(item.dataset.index), false);
    });
    // A click on the backdrop closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
    document.body.append(dialog);
  }

  isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    if (this.dialog.open) return;
    this.all_ = this.commands();
    this.input_.value = '';
    this.filter_();
    this.dialog.showModal();
    this.input_.focus();
  }

  close(): void {
    this.dialog.close();
  }

  toggle(): void {
    if (this.dialog.open) this.close();
    else this.open();
  }

  private filter_(): void {
    this.shown_ = rank(this.all_, this.input_.value, this.recent_);
    const recent = new Set(this.input_.value.trim() ? [] : this.recent_);
    this.list_.replaceChildren(
      ...this.shown_.map((command, index) => {
        const item = document.createElement('li');
        item.id = `palette-item-${index}`;
        item.role = 'option';
        item.dataset.index = String(index);
        const name = document.createElement('span');
        name.className = 'palette-label';
        name.textContent = command.label;
        item.append(name);
        if (recent.has(command.id)) {
          const tag = document.createElement('span');
          tag.className = 'palette-recent';
          tag.textContent = '最近';
          item.append(tag);
        }
        if (command.keys) {
          const keys = document.createElement('kbd');
          keys.textContent = keyText(command.keys);
          item.append(keys);
        }
        if (command.detail) {
          const detail = document.createElement('span');
          detail.className = 'palette-detail';
          detail.textContent = command.detail;
          item.append(detail);
        }
        return item;
      }),
    );
    this.empty_.hidden = this.shown_.length > 0;
    this.select_(0);
  }

  private select_(index: number, scroll = true): void {
    this.list_.querySelector('[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
    this.active_ = index;
    const item = this.list_.children[index] as HTMLElement | undefined;
    if (!item) {
      this.input_.removeAttribute('aria-activedescendant');
      return;
    }
    item.setAttribute('aria-selected', 'true');
    this.input_.setAttribute('aria-activedescendant', item.id);
    if (scroll) item.scrollIntoView({ block: 'nearest' });
  }

  private run_(index: number): void {
    const command = this.shown_[index];
    if (!command) return;
    this.recent_ = [command.id, ...this.recent_.filter((id) => id !== command.id)].slice(0, RECENT_MAX);
    writeRecent(this.recent_);
    this.close();
    command.run();
  }
}

/** Ctrl+K / ⌘K opens and closes the palette anywhere on the page, also from a text field. */
export function bindPalette(palette: CommandPalette): void {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
    // Another dialog open over the page keeps its keys, unless it is the palette itself.
    if (!palette.isOpen() && document.querySelector('dialog[open]:modal')) return;
    e.preventDefault();
    palette.toggle();
  });
}
