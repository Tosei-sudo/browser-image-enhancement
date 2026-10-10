/**
 * The viewer's shell, simple for a first visit and deep for regular use: the
 * click tools in one 「ツール」 menu, side panel sections that fold away, a
 * short guide on the first visit, and the 「?」 dialog listing every shortcut
 * (single keys for the common tools, so they work with the menu closed).
 */

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
      if ((e.target as HTMLElement).closest('button')) this.setOpen(false);
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
  }

  private items_(): HTMLButtonElement[] {
    return [...this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
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
      const now = !!panel.querySelector('[data-action]');
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

  constructor(parent: HTMLElement) {
    const el = (this.element = document.createElement('section'));
    el.className = 'guide';
    el.setAttribute('aria-labelledby', 'guide-title');
    el.hidden = true;
    el.innerHTML = `
      <h2 id="guide-title">はじめに</h2>
      <ol>
        <li>左上のフォルダのボタンで画像・GeoTIFF・Shapefile などを開きます。地図へのドラッグ＆ドロップでも開けます。</li>
        <li>右上のパネルで明るさ・コントラストなどを調整します。調整は画像ごとに残ります。</li>
        <li>計測やポイントは「ツール」に、細かな操作は「?」のショートカット一覧にまとめてあります。</li>
      </ol>
      <div class="guide-actions"><button type="button" class="bar-button">はじめる</button></div>`;
    el.querySelector('button')!.addEventListener('click', () => this.close());
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
      [['O'], 'ファイルを開く'],
      [['/'], '座標の入力欄へ'],
      [['D'], '距離を測る（もう一度で終了）'],
      [['A'], '面積を測る（もう一度で終了）'],
      [['P'], 'ポイント追加（もう一度で終了）'],
      [['3'], '3D 表示に切り替え・2D に戻る'],
      [['T'], 'タイムラインを開く・閉じる'],
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
      [['右クリック'], 'その地点の座標をコピー'],
      [['+'], '拡大（地図をクリックしてから）'],
      [['−'], '縮小（同上）'],
      [['矢印'], '移動（同上）'],
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

/** The 「?」 dialog: what every key and mouse gesture does, and the way back to the guide. */
export class HelpDialog {
  readonly dialog: HTMLDialogElement;

  constructor(guide: Guide) {
    const dialog = (this.dialog = document.createElement('dialog'));
    dialog.className = 'add-service help-dialog';
    dialog.setAttribute('aria-labelledby', 'help-title');
    const title = document.createElement('h2');
    title.id = 'help-title';
    title.textContent = '使い方とショートカット';
    const body = document.createElement('div');
    body.className = 'help-groups';
    for (const [name, rows] of SHORTCUTS) {
      const group = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = name;
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
    const actions = document.createElement('div');
    actions.className = 'service-actions help-actions';
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
    dialog.append(title, body, actions);
    // A click on the backdrop closes it.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
      }
    });
    document.body.append(dialog);
  }

  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
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
