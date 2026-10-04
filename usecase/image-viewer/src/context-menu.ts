/**
 * A small right-click menu of commands, opened at a point of the page. It
 * closes on a choice, on Escape, on a click elsewhere and on scrolling, and
 * the arrow keys move between its items.
 */

/** One command of the menu. */
export interface MenuItem {
  label: string;
  run: () => void;
  /** Shown in red, after a line (deleting). */
  danger?: boolean;
  disabled?: boolean;
}

export class ContextMenu {
  /** The menu element (hidden when closed). */
  readonly element = document.createElement('div');

  constructor(label: string) {
    const menu = this.element;
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    menu.hidden = true;
    document.body.append(menu);
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target as Node)) this.close();
    });
    document.addEventListener('scroll', () => this.close(), true);
    window.addEventListener('blur', () => this.close());
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
      else return;
      e.preventDefault();
    });
  }

  /** Opens the menu with `items` at the page point (`clientX`, `clientY`). */
  open(items: MenuItem[], clientX: number, clientY: number): void {
    const menu = this.element;
    const before = document.activeElement as HTMLElement | null;
    menu.replaceChildren(
      ...items.map((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = item.label;
        b.disabled = !!item.disabled;
        if (item.danger) b.classList.add('danger');
        b.addEventListener('click', () => {
          this.close();
          before?.focus({ preventScroll: true });
          item.run();
        });
        return b;
      }),
    );
    menu.hidden = false;
    // Keep it inside the window.
    menu.style.left = `${Math.max(0, Math.min(clientX, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(clientY, innerHeight - menu.offsetHeight - 4))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  close(): void {
    this.element.hidden = true;
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }
}
