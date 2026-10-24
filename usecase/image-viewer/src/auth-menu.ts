/**
 * The 「サインイン」 menu in the header, shown when `config.json` lists ArcGIS
 * portals (`arcgisPortals`): sign in to a portal in a popup, see who is signed
 * in, sign out. The sign-in itself and the tokens are auth.ts.
 */
import { arcgisPortals, cancelSignIn, currentUser, onAuthChange, signedInUsers, signIn, signOut, type ArcgisPortalConfig } from './auth.js';
import { ToolMenu } from './shell.js';

export class SignInMenu {
  readonly menu: ToolMenu;
  /** The portal being signed in to, while the popup is open. */
  private pending_: ArcgisPortalConfig | null = null;

  constructor(
    readonly element: HTMLElement,
    private readonly options: { say: (message: string) => void },
  ) {
    this.menu = new ToolMenu(element);
    element.hidden = arcgisPortals().length === 0;
    onAuthChange(() => this.render_());
    this.render_();
  }

  /** Signs in to `portal` (the first portal without it); call from a click, so the popup is not blocked. */
  async signIn(portal: ArcgisPortalConfig = arcgisPortals()[0]): Promise<void> {
    if (!portal) return;
    this.pending_ = portal;
    this.render_();
    try {
      const user = await signIn(portal);
      this.options.say(`${portal.label} に ${user.fullName ? `${user.fullName}（${user.username}）` : user.username} でサインイン`);
    } catch (error) {
      this.options.say(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.pending_ === portal) this.pending_ = null;
      this.render_();
    }
  }

  signOut(portal?: string): void {
    signOut(portal);
    this.options.say('サインアウト');
  }

  private render_(): void {
    const users = signedInUsers();
    const button = this.menu.button;
    button.textContent = users.length ? users.map((u) => u.username).join('・') : 'サインイン';
    button.setAttribute('aria-label', users.length ? `サインイン中: ${users.map((u) => `${u.label} の ${u.username}`).join('、')}` : 'サインイン');
    button.classList.toggle('signed-in', users.length > 0);

    const panel = this.menu.panel;
    panel.replaceChildren();
    for (const portal of arcgisPortals()) {
      const user = currentUser(portal.url);
      const row = document.createElement('div');
      row.className = 'signin-portal';
      const name = document.createElement('p');
      name.className = 'menu-heading';
      name.textContent = portal.label;
      row.append(name);
      if (user) {
        const who = document.createElement('p');
        who.className = 'signin-user';
        who.textContent = user.fullName ? `${user.fullName}（${user.username}）` : user.username;
        const out = document.createElement('button');
        out.type = 'button';
        out.textContent = 'サインアウト';
        out.addEventListener('click', () => this.signOut(portal.url));
        row.append(who, out);
      } else if (this.pending_ === portal) {
        const wait = document.createElement('p');
        wait.className = 'signin-user';
        wait.textContent = 'ポップアップでサインイン…';
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.textContent = '中止';
        stop.addEventListener('click', () => cancelSignIn());
        row.append(wait, stop);
      } else {
        const sign = document.createElement('button');
        sign.type = 'button';
        sign.textContent = `${portal.label} にサインイン`;
        sign.title = 'ポップアップで ArcGIS にサインインし、保護されたサービスをトークンなしで利用可能に';
        sign.disabled = this.pending_ !== null;
        sign.addEventListener('click', () => void this.signIn(portal));
        row.append(sign);
      }
      panel.append(row);
    }
  }
}
