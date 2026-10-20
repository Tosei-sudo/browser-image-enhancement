/**
 * The viewer's shell, simple for a first visit and deep for regular use: the
 * click tools in one 「ツール」 menu, side panel sections that fold away, a
 * short guide on the first visit, and the 「?」 dialog listing every shortcut
 * (single keys for the common tools, so they work with the menu closed).
 */

import { score } from './command-palette.js';
import { GLOSSARY, HELP_TOPICS, pointAt, searchHelp, type HelpTopic, type Hints } from './help.js';

/** Whether a key press belongs to a text field rather than to the viewer. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (a private window, a policy): the state lasts for this page only.
  }
}

/**
 * A drop-down menu of buttons. Choosing a button closes it; so do Esc, a
 * click elsewhere and moving the focus out. While a tool inside is turned on
 * (aria-pressed), the menu's own button is marked, so the mode is not hidden.
 */
export class ToolMenu {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;

  constructor(readonly element: HTMLElement) {
    this.button = element.querySelector<HTMLButtonElement>('.menu-button')!;
    this.panel = element.querySelector<HTMLElement>('.menu-panel')!;
    this.button.addEventListener('click', () => this.setOpen(this.panel.hidden));
    this.panel.addEventListener('click', (e) => {
      // Buttons marked data-keep-open (rename, delete in a list) work inside the open menu.
      const button = (e.target as HTMLElement).closest('button');
      if (button && !('keepOpen' in button.dataset)) this.setOpen(false);
    });
    element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.panel.hidden) {
        this.setOpen(false);
        this.button.focus();
        e.stopPropagation();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !this.panel.hidden) {
        const items = this.items_();
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[at < 0 ? 0 : next]?.focus();
        e.preventDefault();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && this.panel.contains(e.target as Node) && this.moveColumn_(e.key === 'ArrowRight' ? 1 : -1)) {
        e.preventDefault();
      } else if (e.key === 'ArrowDown' && e.target === this.button) {
        this.setOpen(true);
        this.items_()[0]?.focus();
        e.preventDefault();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.hidden && !element.contains(e.target as Node)) this.setOpen(false);
    });
    element.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !element.contains(e.relatedTarget as Node)) this.setOpen(false);
    });
    new MutationObserver(() => this.update_()).observe(this.panel, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    this.update_();
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.keepInWindow_();
  }

  private items_(): HTMLButtonElement[] {
    return [...this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter((b) => b.offsetParent !== null);
  }

  /** ← → in a menu of columns: to the same row of the next column (or its last item). */
  private moveColumn_(step: number): boolean {
    const columns = [...this.panel.querySelectorAll<HTMLElement>(':scope > .menu-column')]
      .map((column) => [...column.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter((b) => b.offsetParent !== null))
      .filter((items) => items.length > 0);
    const from = columns.findIndex((items) => items.includes(document.activeElement as HTMLButtonElement));
    if (from < 0 || columns.length < 2) return false;
    const row = columns[from].indexOf(document.activeElement as HTMLButtonElement);
    const to = columns[(from + step + columns.length) % columns.length];
    to[Math.min(row, to.length - 1)].focus();
    return true;
  }

  /** A wide menu opened from a button far from the right edge would leave the window: slide it back in, and scroll what is below the window. */
  private keepInWindow_(): void {
    this.panel.style.translate = '';
    this.panel.style.maxHeight = '';
    const { left, right, top } = this.panel.getBoundingClientRect();
    if (getComputedStyle(this.panel).overflowY === 'auto') this.panel.style.maxHeight = `${Math.max(160, Math.floor(innerHeight - top - 8))}px`;
    const shift = left < 8 ? 8 - left : right > innerWidth - 8 ? innerWidth - 8 - right : 0;
    if (shift) this.panel.style.translate = `${Math.round(shift)}px 0`;
  }

  /** Marks the menu button while a tool in it is on, naming the tool in its tooltip. */
  private update_(): void {
    const on = this.panel.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    this.button.classList.toggle('active', !!on);
    this.button.title = on ? `${on.textContent?.trim()} を使用中` : '';
  }
}

/**
 * Side panel sections that fold. Each remembers whether it is open, and the
 * geometric one opens by itself when it has something to do for the selected
 * layer. (The points section shows only once there are points: style.css.)
 */
export function foldSections(side: HTMLElement): void {
  for (const fold of side.querySelectorAll<HTMLDetailsElement>('details.fold')) {
    const key = `image-viewer.fold.${fold.dataset.fold}`;
    const saved = readFlag(key);
    if (saved !== null) fold.open = saved === 'open';
    fold.addEventListener('toggle', () => writeFlag(key, fold.open ? 'open' : 'closed'));
  }

  const geometry = side.querySelector<HTMLDetailsElement>('[data-fold="geometry"]');
  const panel = geometry?.querySelector('.geometry');
  if (geometry && panel) {
    let actions = false;
    new MutationObserver(() => {
      // The elevation services' buttons are always there: they are not something to do for the layer.
      const now = [...panel.querySelectorAll('[data-action]')].some((b) => !b.closest('.geometry-sources'));
      if (now && !actions) geometry.open = true;
      actions = now;
    }).observe(panel, { childList: true, subtree: true });
  }
}

const GUIDE_KEY = 'image-viewer.guide-seen';

/**
 * The few lines a first visit needs, over the map. It goes away for good when
 * closed or when the first layer opens; the 「?」 dialog can bring it back.
 */
export class Guide {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, hints?: Hints) {
    const el = (this.element = document.createElement('section'));
    el.className = 'guide';
    el.setAttribute('aria-labelledby', 'guide-title');
    el.hidden = true;
    el.innerHTML = `
      <h2 id="guide-title">はじめに</h2>
      <ol>
        <li>左上のフォルダのボタンで画像・GeoTIFF・Shapefile などを開きます。地図へのドラッグ＆ドロップでも開けます。</li>
        <li>右上のパネルで明るさ・コントラストなどを調整します。調整は画像ごとに残ります。</li>
        <li>計測やポイントは「ツール」に、細かな操作は「?」のショートカット一覧にまとめてあります。どの機能も <kbd>Ctrl</kbd>+<kbd>K</kbd> で名前から探せます。</li>
        <li>わからないときは右上の「?」で、やりたいことから操作の手順と場所を探せます。</li>
      </ol>
      <div class="guide-actions">
        <button type="button" class="bar-button guide-hints" title="ボタンやスライダーにマウスを乗せると、何をするものかを説明します。「?」からいつでもやめられます">ボタンの説明を出す</button>
        <button type="button" class="bar-button guide-start">はじめる</button>
      </div>`;
    el.querySelector('.guide-start')!.addEventListener('click', () => this.close());
    const hintsButton = el.querySelector<HTMLButtonElement>('.guide-hints')!;
    hintsButton.hidden = !hints;
    hintsButton.addEventListener('click', () => {
      hints?.set(true);
      this.close();
    });
    parent.append(el);
    if (readFlag(GUIDE_KEY) === null) this.show();
  }

  isShown(): boolean {
    return !this.element.hidden;
  }

  show(): void {
    this.element.hidden = false;
  }

  /** Hides the guide and does not show it on later visits. */
  close(): void {
    this.element.hidden = true;
    writeFlag(GUIDE_KEY, '1');
  }
}

/** One shortcut row: the keys, then what they do. */
type Shortcut = [keys: string[], what: string];

const SHORTCUTS: Array<[title: string, rows: Shortcut[]]> = [
  [
    '基本',
    [
      [['Ctrl', 'K'], '機能を名前で探して実行（コマンド）'],
      [['O'], 'ファイルを開く'],
      [['/'], '座標・地名の入力欄へ'],
      [['D'], '距離を測る（もう一度で終了）'],
      [['A'], '面積を測る（もう一度で終了）'],
      [['H'], '影から高さを測る（もう一度で終了）'],
      [['P'], 'ポイント追加（もう一度で終了）'],
      [['3'], '3D 表示に切り替え・2D に戻る'],
      [['T'], 'タイムラインを開く・閉じる'],
      [['B'], 'ダッシュボードを開く・閉じる'],
      [['M'], '今の表示をブックマークに追加'],
      [['N'], '注記を描く・やめる'],
      [['C'], '並べて比較（2画面）・終了'],
      [['Esc'], '描いている計測を取り消す・メニューを閉じる'],
      [['Ctrl', 'S'], 'プロジェクトを保存'],
      [['Ctrl', 'Shift', 'S'], 'プロジェクトに名前を付けて保存'],
      [['?'], 'この一覧'],
    ],
  ],
  [
    '地図',
    [
      [['ドラッグ'], '移動'],
      [['ホイール'], '拡大・縮小'],
      [['Shift', 'ドラッグ'], '囲んだ範囲へ拡大'],
      [['Alt', 'Shift', 'ドラッグ'], '回転'],
      [['Ctrl', 'ドラッグ'], '範囲内の地物を選択に追加（ベクターレイヤー）'],
      [['Ctrl', 'クリック'], '地物を選択に追加・解除'],
      [['右クリック'], 'その地点の座標をコピー・左下の座標表示の表記を切り替え'],
      [['+'], '拡大（地図をクリックしてから）'],
      [['−'], '縮小（同上）'],
      [['矢印'], '移動（同上）'],
      [['Ctrl', 'V'], 'GeoJSON・WKT・座標・表・画像を貼り付け（一時レイヤー「貼り付け」）'],
      [['Ctrl', 'C'], '選択した地物を GeoJSON でコピー'],
    ],
  ],
  [
    'タイムライン（グラフをクリックしてから）',
    [
      [['←', '→'], '期間を前後に送る'],
      [['Space'], '再生・停止'],
      [['Home', 'End'], '最初・最後の期間へ'],
      [['ドラッグ'], '期間を選ぶ・動かす（端で伸縮）'],
      [['ホイール'], '時間軸の拡大・縮小'],
      [['ダブルクリック'], '全期間を表示'],
    ],
  ],
  [
    '編集（編集ツールバーが出ているとき）',
    [
      [['Ctrl', 'Z'], '元に戻す（描いている途中は 1 点戻す）'],
      [['Ctrl', 'Y'], 'やり直し（Ctrl + Shift + Z でも）'],
      [['Backspace'], '描いている途中で 1 点戻す'],
      [['Enter'], '描いている線・面を確定（ダブルクリックでも）'],
      [['Esc'], '描いている途中の図形・分割をやめる'],
      [['Alt', 'クリック'], '「形状編集」中に頂点を削除'],
    ],
  ],
  [
    '属性テーブル',
    [
      [['Ctrl', 'A'], '表示中の行をすべて選択'],
      [['Delete'], '選択した地物を削除（編集できるレイヤー）'],
      [['Esc'], '選択を解除'],
      [['Shift', 'F10'], '行のメニュー'],
    ],
  ],
  [
    'パネル',
    [
      [['ダブルクリック'], 'スライダー名で値を元に戻す・パネルの境界で幅を戻す'],
      [['矢印'], '幾何補正の「位置をずらす」中に画像を動かす（Shift で 10 倍）'],
    ],
  ],
];

type HelpTab = 'topics' | 'terms' | 'keys';
const HELP_TAB_KEY = 'image-viewer.help.tab';

/**
 * The 「?」 dialog: 「やりたいこと」 (tasks in plain words, with steps and a
 * pointer to the button), 「用語」, every key and mouse gesture, a search over
 * all of them, the switch of the hints and the way back to the guide. It
 * opens on the tab used last.
 */
export class HelpDialog {
  readonly dialog: HTMLDialogElement;
  private readonly search_: HTMLInputElement;
  private readonly tabs_ = new Map<HelpTab, { tab: HTMLButtonElement; panel: HTMLElement }>();
  private readonly results_: HTMLElement;
  private readonly note_: HTMLElement;

  constructor(guide: Guide, hints?: Hints) {
    const dialog = (this.dialog = document.createElement('dialog'));
    dialog.className = 'add-service help-dialog';
    dialog.setAttribute('aria-labelledby', 'help-title');
    const title = document.createElement('h2');
    title.id = 'help-title';
    title.textContent = '使い方とショートカット';

    const search = (this.search_ = document.createElement('input'));
    search.type = 'search';
    search.className = 'help-search';
    search.placeholder = 'やりたいこと・言葉で探す（例: 明るく、距離、バンド）';
    search.setAttribute('aria-label', 'ヘルプを検索');
    search.autocomplete = 'off';
    search.addEventListener('input', () => this.filter_());

    const tablist = document.createElement('div');
    tablist.className = 'help-tabs';
    tablist.setAttribute('role', 'tablist');
    const panels = document.createElement('div');
    panels.className = 'help-panels';
    const tabs: Array<[HelpTab, string, HTMLElement]> = [
      ['topics', 'やりたいこと', this.topics_(HELP_TOPICS)],
      ['terms', '用語', this.terms_(GLOSSARY)],
      ['keys', 'ショートカット', this.keys_()],
    ];
    for (const [id, name, panel] of tabs) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `help-tab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `help-panel-${id}`);
      tab.textContent = name;
      tab.addEventListener('click', () => this.show(id));
      panel.id = `help-panel-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      this.tabs_.set(id, { tab, panel });
      tablist.append(tab);
      panels.append(panel);
    }
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ids = [...this.tabs_.keys()];
      const at = ids.findIndex((id) => this.tabs_.get(id)!.tab === document.activeElement);
      const next = ids[(at + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      this.show(next);
      this.tabs_.get(next)!.tab.focus();
      e.preventDefault();
    });
    const results = (this.results_ = document.createElement('div'));
    results.className = 'help-results';
    results.setAttribute('aria-live', 'polite');
    results.hidden = true;
    panels.append(results);

    const note = (this.note_ = document.createElement('p'));
    note.className = 'help-note';
    note.setAttribute('role', 'status');

    const actions = document.createElement('div');
    actions.className = 'service-actions help-actions';
    if (hints) {
      const label = document.createElement('label');
      label.className = 'help-hints';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = hints.isEnabled();
      box.addEventListener('change', () => hints.set(box.checked));
      hints.onChange((on) => (box.checked = on));
      label.append(box, 'ボタンやスライダーに説明を出す（初心者向け）');
      actions.append(label);
    }
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'はじめにのガイドを表示';
    again.addEventListener('click', () => {
      dialog.close();
      guide.show();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '閉じる';
    close.addEventListener('click', () => dialog.close());
    actions.append(again, close);
    dialog.append(title, search, tablist, panels, note, actions);
    // A click on the backdrop closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
      }
    });
    document.body.append(dialog);
    const saved = readFlag(HELP_TAB_KEY);
    this.show(saved === 'terms' || saved === 'keys' ? saved : 'topics', false);
  }

  /** Opens the dialog, on `tab` when given (else the one used last). */
  open(tab?: HelpTab): void {
    if (tab) this.show(tab);
    this.note_.textContent = '';
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Switches to `tab` (and clears a search). */
  show(tab: HelpTab, remember = true): void {
    if (this.search_.value) {
      this.search_.value = '';
      this.filter_();
    }
    for (const [id, { tab: button, panel }] of this.tabs_) {
      button.setAttribute('aria-selected', String(id === tab));
      button.tabIndex = id === tab ? 0 : -1;
      panel.hidden = id !== tab;
    }
    if (remember) writeFlag(HELP_TAB_KEY, tab);
  }

  private filter_(): void {
    const query = this.search_.value.trim();
    const current = [...this.tabs_.values()].find(({ tab }) => tab.getAttribute('aria-selected') === 'true');
    this.results_.hidden = !query;
    for (const { panel } of this.tabs_.values()) panel.hidden = !!query || panel !== current?.panel;
    if (!query) return;
    const { topics, terms } = searchHelp(query);
    const keys = SHORTCUTS.map(([group, rows]) => [group, rows.filter(([k, what]) => score({ label: what, detail: k.join(' ') }, query) >= 0)] as [string, Shortcut[]]).filter(([, rows]) => rows.length);
    const parts: HTMLElement[] = [];
    if (topics.length) parts.push(this.topics_([['やりたいこと', topics]], topics.length === 1));
    if (terms.length) parts.push(this.terms_(terms, '用語'));
    if (keys.length) parts.push(this.keys_(keys, 'ショートカット'));
    if (!parts.length) {
      const empty = document.createElement('p');
      empty.className = 'help-empty';
      empty.textContent = '見つかりませんでした。別の言葉で探すか、Ctrl + K で機能の名前から探してください。';
      parts.push(empty);
    }
    this.results_.replaceChildren(...parts);
  }

  private topics_(groups: Array<[string, HelpTopic[]]>, open = false): HTMLElement {
    const root = document.createElement('div');
    root.className = 'help-topics';
    for (const [name, topics] of groups) {
      const group = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = name;
      group.append(h);
      for (const topic of topics) {
        const item = document.createElement('details');
        item.className = 'help-topic';
        item.open = open;
        const summary = document.createElement('summary');
        summary.textContent = topic.title;
        const steps = document.createElement('ol');
        for (const step of topic.steps) {
          const li = document.createElement('li');
          li.textContent = step;
          steps.append(li);
        }
        item.append(summary, steps);
        if (topic.target) {
          const where = document.createElement('button');
          where.type = 'button';
          where.className = 'help-where';
          where.textContent = '場所を見る';
          where.addEventListener('click', () => {
            this.dialog.close();
            pointAt(topic, (text) => {
              this.dialog.showModal();
              this.note_.textContent = text;
            });
          });
          item.append(where);
        }
        group.append(item);
      }
      root.append(group);
    }
    return root;
  }

  private terms_(terms: typeof GLOSSARY, heading?: string): HTMLElement {
    const root = document.createElement('section');
    root.className = 'help-terms';
    if (heading) {
      const h = document.createElement('h3');
      h.textContent = heading;
      root.append(h);
    }
    const list = document.createElement('dl');
    for (const [term, , text] of terms) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = text;
      list.append(dt, dd);
    }
    root.append(list);
    return root;
  }

  private keys_(groups = SHORTCUTS, heading?: string): HTMLElement {
    const body = document.createElement('div');
    body.className = 'help-groups';
    for (const [name, rows] of groups) {
      const group = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = heading ? `${heading}: ${name}` : name;
      const list = document.createElement('dl');
      for (const [keys, what] of rows) {
        const dt = document.createElement('dt');
        keys.forEach((k, i) => {
          if (i) dt.append(' + ');
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          dt.append(kbd);
        });
        const dd = document.createElement('dd');
        dd.textContent = what;
        list.append(dt, dd);
      }
      group.append(h, list);
      body.append(group);
    }
    return body;
  }
}

/**
 * Single-key shortcuts for the whole page. They are off while typing in a
 * field, with Ctrl / ⌘ / Alt held, and while a dialog is open.
 */
export function bindShortcuts(keys: Record<string, () => void>): void {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Shift only for the keys typed with it (? on most layouts).
    if (e.shiftKey && /^[a-z/]$/.test(key)) return;
    const run = keys[key];
    if (!run) return;
    e.preventDefault();
    run();
  });
}
