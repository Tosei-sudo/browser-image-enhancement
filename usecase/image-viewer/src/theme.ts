/**
 * Light and dark: 「表示」 in the 「ツール」 menu chooses 自動 (the system's setting), ライト
 * or ダーク, remembered in this browser. The page's colours are CSS variables
 * switched by data-theme on <html> (style.css); the script in index.html sets
 * it before the first paint, and this keeps it up to date. Anything drawn in a
 * canvas from those variables redraws on the 'themechange' event.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark';

/** The localStorage key; index.html reads the same one. */
export const THEME_KEY = 'image-viewer.theme';

const NAMES: Record<ThemeChoice, string> = { auto: '自動', light: 'ライト', dark: 'ダーク' };

export function readThemeChoice(): ThemeChoice {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    // Storage blocked: follow the system.
  }
  return saved === 'light' || saved === 'dark' ? saved : 'auto';
}

/** Applies a choice to the page, remembers it and marks it among the buttons. */
export class Theme {
  private choice_: ThemeChoice = readThemeChoice();
  private readonly system_ = matchMedia('(prefers-color-scheme: dark)');

  constructor(private readonly element: HTMLElement) {
    this.system_.addEventListener('change', () => this.apply_());
    element.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => this.set(b.dataset.themeChoice as ThemeChoice)));
    this.apply_();
  }

  get choice(): ThemeChoice {
    return this.choice_;
  }

  /** The colours in use now. */
  get dark(): boolean {
    return document.documentElement.dataset.theme === 'dark';
  }

  set(choice: ThemeChoice): void {
    this.choice_ = choice;
    try {
      if (choice === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    this.apply_();
  }

  private apply_(): void {
    const theme = this.choice_ === 'auto' ? (this.system_.matches ? 'dark' : 'light') : this.choice_;
    const root = document.documentElement;
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    const auto = this.element.querySelector<HTMLElement>('[data-theme-choice="auto"]');
    if (auto) auto.title = `システムの設定に連動（現在: ${NAMES[theme]}）`;
    this.element.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === this.choice_)));
    if (changed) document.dispatchEvent(new Event('themechange'));
  }
}
