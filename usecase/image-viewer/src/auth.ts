/**
 * Credentials for the servers the viewer reads, in one place:
 *
 * - **ArcGIS sign-in.** `config.json`'s `arcgisPortals` lists ArcGIS Online /
 *   Enterprise portals with the client id of an app registered there. Signing
 *   in is OAuth 2.0 with an authorization code and PKCE (no client secret, so
 *   it works from the browser): a popup goes to the portal's
 *   `/sharing/rest/oauth2/authorize`, which sends it back to
 *   `oauth-callback.html` with a code; the callback hands the code to this
 *   page (a BroadcastChannel of this origin, and `postMessage` to its opener
 *   restricted to this origin) and the code is exchanged for a token at
 *   `/sharing/rest/oauth2/token`. The token (and refresh token) live in
 *   memory and `sessionStorage` (this tab only), and are refreshed before they
 *   expire. A token applies to the portal, its organization's hosted services
 *   and its federated servers (`/sharing/rest/portals/self/servers`), and is
 *   added to Esri requests that have no token of their own ({@link tokenFor}).
 * - **Access rules.** `config.json`'s `authRules` add request headers or query
 *   parameters to the URLs that start with a prefix (an object storage
 *   bucket, a tile server behind an API key): COG reads, picture tiles and
 *   service requests go through {@link authorize} / {@link authFetch}.
 *
 * Tokens and rule values are never logged, never put in links or project
 * files, and never sent to hosts other than the ones they are for.
 */

/** An ArcGIS portal to sign in to, from `config.json`'s `arcgisPortals`. */
export interface ArcgisPortalConfig {
  /** Name in the sign-in menu. */
  label: string;
  /** The portal's root: `https://www.arcgis.com`, `https://gis.example.com/portal` (no trailing slash). */
  url: string;
  /** The client id (app id) of the app registered in the portal, with `oauth-callback.html` as a redirect URI. */
  clientId: string;
}

/** Headers or query parameters for the URLs that start with `prefix`, from `config.json`'s `authRules`. */
export interface AuthRule {
  prefix: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** Who is signed in to a portal. */
export interface ArcgisUser {
  /** The portal's root URL, as in config.json. */
  portal: string;
  /** The portal's name in the menu. */
  label: string;
  username: string;
  fullName?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `url` parsed when it is https, or http to this machine; null otherwise. */
function secureUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return u;
  return null;
}

/** An HTTP header name (RFC 9110 token). */
const isHeaderName = (name: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name);
/** Headers the browser will not let a page set, or that would change what the request is. */
const RESERVED_HEADERS = new Set(['host', 'cookie', 'origin', 'referer', 'content-length', 'connection', 'range', 'content-type']);

/** The portal of one `arcgisPortals` entry; null (with the reason in `problems`) when it cannot be used. */
export function arcgisPortalOf(value: unknown, problems: string[], index: number): ArcgisPortalConfig | null {
  const at = `arcgisPortals[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { label, url, clientId } = value;
  const u = typeof url === 'string' ? secureUrl(url.trim()) : null;
  if (!u || u.search || u.hash) return (problems.push(`${at} の url はポータルの https の URL（https://www.arcgis.com、https://gis.example.com/portal など）にしてください`), null);
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) return (problems.push(`${at} の clientId（ポータルに登録したアプリのクライアント ID）がありません`), null);
  const root = u.href.replace(/\/+$/, '').replace(/\/sharing(\/rest)?$/i, '');
  return { label: typeof label === 'string' && label.trim() ? label.trim() : u.host, url: root, clientId };
}

/** The rule of one `authRules` entry; null (with the reason in `problems`) when it cannot be used. */
export function authRuleOf(value: unknown, problems: string[], index: number): AuthRule | null {
  const at = `authRules[${index}]`;
  if (!isRecord(value)) return (problems.push(`${at} がオブジェクトではありません`), null);
  const { prefix, headers, query } = value;
  // At least the host and the `/` after it, so `https://bucket.example.com` cannot match `https://bucket.example.com.evil.net`.
  const u = typeof prefix === 'string' && /^https?:\/\/[^/?#]+\//i.test(prefix) ? secureUrl(prefix) : null;
  if (!u || u.hash) return (problems.push(`${at} の prefix は https:// で始まり、ホストの後の / まで含む URL にしてください（http は localhost のみ）`), null);
  const out: AuthRule = { prefix: u.href, headers: {}, query: {} };
  const valid = (v: unknown): v is string => typeof v === 'string' && v.length <= 8192 && !/[\r\n\0]/.test(v);
  if (headers !== undefined) {
    if (!isRecord(headers)) problems.push(`${at} の headers はオブジェクトにしてください`);
    else {
      for (const [name, v] of Object.entries(headers)) {
        if (isHeaderName(name) && !RESERVED_HEADERS.has(name.toLowerCase()) && !/^(sec-|proxy-)/i.test(name) && valid(v)) out.headers[name] = v;
        else problems.push(`${at} の headers の「${name.slice(0, 40)}」は無視しました`);
      }
    }
  }
  if (query !== undefined) {
    if (!isRecord(query)) problems.push(`${at} の query はオブジェクトにしてください`);
    else {
      for (const [name, v] of Object.entries(query)) {
        if (name && name.length <= 100 && valid(v)) out.query[name] = v;
        else problems.push(`${at} の query の「${name.slice(0, 40)}」は無視しました`);
      }
    }
  }
  if (!Object.keys(out.headers).length && !Object.keys(out.query).length) return (problems.push(`${at} に headers も query もありません`), null);
  return out;
}

// ---------------------------------------------------------------------------
// Access rules

let rules: readonly AuthRule[] = [];

/** The access rules in use (config.json's `authRules`). */
export function setAuthRules(next: readonly AuthRule[]): void {
  rules = next;
}

/** The rule for `url` (absolute), the one with the longest prefix; undefined when none applies. */
export function ruleFor(url: string, list: readonly AuthRule[] = rules): AuthRule | undefined {
  let best: AuthRule | undefined;
  for (const rule of list) if (url.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  return best;
}

/** The absolute form of `url` (against the page), or null for what is not http(s). */
function absolute(url: string): URL | null {
  try {
    const u = new URL(url, typeof document === 'undefined' ? undefined : document.baseURI);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Sets query parameters on `url` without percent-encoding what it already has (tile templates keep their braces). */
function addQuery(url: string, params: Record<string, string>): string {
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const extra = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return extra ? `${base}${base.includes('?') ? '&' : '?'}${extra}${hash < 0 ? '' : url.slice(hash)}` : url;
}

/** Whether `url`'s query has the parameter `name` (ignoring case, as ArcGIS does). */
function hasParam(url: URL, name: string): boolean {
  return [...url.searchParams.keys()].some((k) => k.toLowerCase() === name.toLowerCase());
}

/**
 * The URL to request and the headers to send for `url`: the access rule's
 * query parameters and headers when one applies, and with `token`, the token
 * of a signed-in portal as the `token` parameter when the URL belongs to it
 * and has none (for picture tiles, which cannot be POSTs). Other URLs come
 * back as they are, with no headers.
 */
export function authorize(url: string, options: { token?: boolean } = {}): { url: string; headers: Record<string, string> } {
  const u = absolute(url);
  if (!u) return { url, headers: {} };
  const rule = ruleFor(u.href);
  const params: Record<string, string> = {};
  if (rule) for (const [k, v] of Object.entries(rule.query)) if (!hasParam(u, k)) params[k] = v;
  if (options.token && !hasParam(u, 'token')) {
    const token = tokenFor(u.href);
    if (token) params.token = token;
  }
  return { url: Object.keys(params).length ? addQuery(url, params) : url, headers: rule ? { ...rule.headers } : {} };
}

/** `fetch` with {@link authorize}'s query parameters and headers (headers given in `init` win). */
export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { url: target, headers } = authorize(url);
  if (!Object.keys(headers).length) return fetch(target, init);
  const merged = new Headers(headers);
  new Headers(init.headers).forEach((v, k) => merged.set(k, v));
  return fetch(target, { ...init, headers: merged });
}

// ---------------------------------------------------------------------------
// PKCE

/** Bytes as base64url without padding (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random string of `bytes` random bytes, base64url (a PKCE verifier, a state). */
export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE `S256` challenge of `verifier` (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

// ---------------------------------------------------------------------------
// Sessions

/** A signed-in portal: its tokens and the URLs they apply to. */
export interface Session {
  portal: string;
  clientId: string;
  label: string;
  token: string;
  /** When the token expires (ms since 1970). */
  expires: number;
  refreshToken?: string;
  refreshExpires?: number;
  username: string;
  fullName?: string;
  /** URL prefixes the token applies to, each ending in `/`: the portal and its federated servers. */
  scopes: string[];
  /** ArcGIS Online: the organization's id, for its hosted services (`services1.arcgis.com/<id>/…`). */
  orgId?: string;
}

/** Whether `session`'s token applies to `url` (absolute). */
export function sessionCovers(session: Pick<Session, 'scopes' | 'orgId'>, url: string): boolean {
  const u = secureUrl(url);
  if (!u) return false;
  const href = u.href;
  if (session.scopes.some((s) => href.startsWith(s))) return true;
  if (session.orgId && u.protocol === 'https:') {
    const host = u.hostname.toLowerCase();
    if (/^(services|tiles|features|vectortiles)\d*\.arcgis\.com$/.test(host) && u.pathname.startsWith(`/${session.orgId}/`)) return true;
  }
  return false;
}

const STORE_KEY = 'image-viewer.arcgis-sessions';
/** Refresh this long before the token expires. */
const REFRESH_AHEAD = 2 * 60_000;

let portals: readonly ArcgisPortalConfig[] = [];
let sessions: Session[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const refreshing = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

function changed(): void {
  save();
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever someone signs in or out (or a session ends). Returns the unsubscribe function. */
export function onAuthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function save(): void {
  try {
    if (sessions.length) sessionStorage.setItem(STORE_KEY, JSON.stringify(sessions));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: the sign-in lasts for this page only.
  }
}

/** A stored session, checked; null when it is not one or no longer usable. */
function sessionOf(value: unknown, now: number): Session | null {
  if (!isRecord(value)) return null;
  const { portal, clientId, token, expires, refreshToken, refreshExpires, username, fullName, scopes, orgId } = value;
  const config = portals.find((p) => p.url === portal && p.clientId === clientId);
  if (!config || typeof token !== 'string' || typeof expires !== 'number' || typeof username !== 'string' || !Array.isArray(scopes)) return null;
  const canRefresh = typeof refreshToken === 'string' && typeof refreshExpires === 'number' && refreshExpires > now;
  if (expires <= now && !canRefresh) return null;
  return {
    portal: config.url,
    clientId: config.clientId,
    label: config.label,
    token,
    expires,
    ...(canRefresh ? { refreshToken: refreshToken as string, refreshExpires: refreshExpires as number } : {}),
    username,
    ...(typeof fullName === 'string' && fullName ? { fullName } : {}),
    scopes: scopes.filter((s): s is string => typeof s === 'string' && secureUrl(s) !== null && s.endsWith('/')),
    ...(typeof orgId === 'string' && /^[A-Za-z0-9]{1,64}$/.test(orgId) ? { orgId } : {}),
  };
}

/** The portals to sign in to (config.json's `arcgisPortals`); restores this tab's sessions with them. */
export function configureAuth(options: { portals: readonly ArcgisPortalConfig[]; rules: readonly AuthRule[] }): void {
  portals = options.portals;
  setAuthRules(options.rules);
  let stored: unknown;
  try {
    stored = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  const now = Date.now();
  sessions = Array.isArray(stored) ? stored.map((s) => sessionOf(s, now)).filter((s): s is Session => s !== null) : [];
  for (const s of sessions) schedule(s);
  save();
}

/** The portals of config.json. */
export function arcgisPortals(): readonly ArcgisPortalConfig[] {
  return portals;
}

/** Who is signed in: to the portal `portalUrl`, or (without it) to any. */
export function currentUser(portalUrl?: string): ArcgisUser | null {
  const s = portalUrl === undefined ? sessions[0] : sessions.find((x) => x.portal === portalUrl.replace(/\/+$/, ''));
  return s ? { portal: s.portal, label: s.label, username: s.username, ...(s.fullName ? { fullName: s.fullName } : {}) } : null;
}

/** Everyone signed in, one per portal. */
export function signedInUsers(): ArcgisUser[] {
  return sessions.map((s) => currentUser(s.portal)!);
}

/** The session whose token applies to `url`. */
function sessionFor(url: string): Session | undefined {
  const u = absolute(url);
  return u ? sessions.find((s) => sessionCovers(s, u.href)) : undefined;
}

/** The token of the signed-in portal `url` belongs to (the portal, its hosted services, its federated servers), while valid. */
export function tokenFor(url: string): string | undefined {
  const s = sessionFor(url);
  return s && s.expires > Date.now() ? s.token : undefined;
}

/** {@link tokenFor}, refreshing the token first when it is about to expire. */
export async function freshTokenFor(url: string): Promise<string | undefined> {
  const s = sessionFor(url);
  if (!s) return undefined;
  if (s.expires - Date.now() < REFRESH_AHEAD && s.refreshToken) await refresh(s);
  return tokenFor(url);
}

/** A new token for `url`'s portal (after a server called the token invalid, 498/499); undefined when it cannot be had. */
export async function renewTokenFor(url: string): Promise<string | undefined> {
  const s = sessionFor(url);
  if (!s?.refreshToken) return undefined;
  return (await refresh(s)) ? tokenFor(url) : undefined;
}

function schedule(s: Session): void {
  clearTimeout(timers.get(s.portal));
  const wait = s.refreshToken ? s.expires - REFRESH_AHEAD - Date.now() : s.expires - Date.now();
  // setTimeout keeps 32-bit delays only.
  const timer = setTimeout(() => {
    if (!sessions.includes(s)) return;
    if (s.refreshToken && s.expires - Date.now() < REFRESH_AHEAD + 1000) void refresh(s);
    else if (!s.refreshToken && s.expires <= Date.now()) end(s);
    else schedule(s);
  }, Math.min(Math.max(wait, 5_000), 2 ** 31 - 1));
  timers.set(s.portal, timer);
}

function end(s: Session): void {
  clearTimeout(timers.get(s.portal));
  timers.delete(s.portal);
  sessions = sessions.filter((x) => x !== s);
  changed();
}

/** The token endpoint's answer, checked. */
interface TokenAnswer {
  token: string;
  expires: number;
  refreshToken?: string;
  refreshExpires?: number;
  username?: string;
}

/** POSTs a form to the portal's REST API and reads the JSON answer; an `error` member becomes an Error with its message. */
async function portalPost(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  } catch {
    throw new Error('ポータルに接続できませんでした（URL、または CORS の設定を確認してください）');
  }
  const json = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(json)) throw new Error(`ポータルの応答が JSON ではありません（HTTP ${response.status}）`);
  if (isRecord(json.error)) {
    const message = typeof json.error.message === 'string' ? json.error.message : String(json.error.code ?? '');
    const description = typeof json.error_description === 'string' ? json.error_description : '';
    throw new Error(`ポータルがエラーを返しました: ${[message, description].filter(Boolean).join(' ').slice(0, 300)}`);
  }
  if (typeof json.error === 'string') throw new Error(`ポータルがエラーを返しました: ${json.error}${typeof json.error_description === 'string' ? ` ${json.error_description.slice(0, 300)}` : ''}`);
  return json;
}

/** Asks the token endpoint for a token (`grant_type` authorization_code or refresh_token). */
export async function requestToken(portal: string, form: Record<string, string>, now = Date.now()): Promise<TokenAnswer> {
  const json = await portalPost(`${portal}/sharing/rest/oauth2/token`, { ...form, f: 'json' });
  const { access_token, expires_in, refresh_token, refresh_token_expires_in, username } = json;
  if (typeof access_token !== 'string' || !access_token || typeof expires_in !== 'number' || !(expires_in > 0)) throw new Error('ポータルからトークンを受け取れませんでした');
  return {
    token: access_token,
    expires: now + expires_in * 1000,
    ...(typeof refresh_token === 'string' && refresh_token ? { refreshToken: refresh_token, refreshExpires: now + (typeof refresh_token_expires_in === 'number' && refresh_token_expires_in > 0 ? refresh_token_expires_in : 14 * 86_400) * 1000 } : {}),
    ...(typeof username === 'string' && username ? { username } : {}),
  };
}

/** Refreshes `s`'s token; false (and the session ended once the token has expired) when that fails. */
function refresh(s: Session): Promise<boolean> {
  const running = refreshing.get(s.portal);
  if (running) return running;
  const done = (async () => {
    try {
      const answer = await requestToken(s.portal, { grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken ?? '' });
      s.token = answer.token;
      s.expires = answer.expires;
      if (answer.refreshToken) {
        s.refreshToken = answer.refreshToken;
        s.refreshExpires = answer.refreshExpires;
      }
      schedule(s);
      changed();
      return true;
    } catch {
      // Try again later while the token lasts; a refused refresh token means signing in again.
      if (s.expires <= Date.now() + 1000) end(s);
      else {
        delete s.refreshToken;
        schedule(s);
        changed();
      }
      return false;
    } finally {
      refreshing.delete(s.portal);
    }
  })();
  refreshing.set(s.portal, done);
  return done;
}

/** The prefix of a server URL (`https://gis.example.com/server` → `https://gis.example.com/server/`), or null when not https. */
function scopeOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const u = secureUrl(url.trim());
  if (!u) return null;
  u.search = '';
  u.hash = '';
  return u.href.endsWith('/') ? u.href : `${u.href}/`;
}

/**
 * What the token applies to, from the portal's description (`portals/self`)
 * and its federated servers (`portals/self/servers`).
 */
export function scopesOf(portal: string, self: Record<string, unknown>, servers: unknown): { scopes: string[]; orgId?: string } {
  const scopes = new Set<string>();
  const root = scopeOf(portal);
  if (root) scopes.add(root);
  const isOnline = self.isPortal === false || /(^|\.)arcgis\.com$/i.test(new URL(portal).hostname);
  const orgId = typeof self.id === 'string' && /^[A-Za-z0-9]{1,64}$/.test(self.id) ? self.id : undefined;
  // The organization's own address (https://<urlKey>.maps.arcgis.com).
  if (typeof self.urlKey === 'string' && /^[A-Za-z0-9-]{1,63}$/.test(self.urlKey) && typeof self.customBaseUrl === 'string' && /^[A-Za-z0-9.-]{1,200}$/.test(self.customBaseUrl)) {
    const org = scopeOf(`https://${self.urlKey}.${self.customBaseUrl}`);
    if (org) scopes.add(org);
  }
  const list = isRecord(servers) && Array.isArray(servers.servers) ? servers.servers : [];
  for (const server of list.slice(0, 100)) {
    if (!isRecord(server)) continue;
    for (const key of ['url', 'adminUrl']) {
      const scope = scopeOf(server[key]);
      if (scope) scopes.add(scope);
    }
  }
  return { scopes: [...scopes], ...(isOnline && orgId ? { orgId } : {}) };
}

/** The page the portal sends the popup back to. */
export function redirectUri(): string {
  return new URL('oauth-callback.html', document.baseURI).href;
}

/** The authorize URL the popup opens. */
export function authorizeUrl(portal: ArcgisPortalConfig, p: { challenge: string; state: string; redirect: string }): string {
  const params = new URLSearchParams({
    client_id: portal.clientId,
    response_type: 'code',
    redirect_uri: p.redirect,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  return `${portal.url}/sharing/rest/oauth2/authorize?${params}`;
}

/** The message the callback page sends. */
interface CallbackMessage {
  type: 'arcgis-oauth';
  state: string;
  code?: string;
  error?: string;
}

const CHANNEL = 'image-viewer-oauth';
let pending: { state: string; resolve: (code: string) => void; reject: (error: Error) => void } | null = null;

/** Stops a sign-in that is waiting for the popup. */
export function cancelSignIn(): void {
  pending?.reject(new Error('サインインを中止しました'));
}

/** Waits for the callback page to send the code for `state` (10 minutes at most). */
function waitForCode(state: string): Promise<string> {
  cancelSignIn();
  return new Promise<string>((resolve, reject) => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    const timer = setTimeout(() => finish(new Error('サインインが時間内に終わりませんでした')), 10 * 60_000);
    const take = (data: unknown) => {
      if (!isRecord(data) || data.type !== 'arcgis-oauth' || data.state !== state) return;
      const m = data as unknown as CallbackMessage;
      if (typeof m.code === 'string' && m.code) finish(null, m.code);
      else finish(new Error(`サインインできませんでした${typeof m.error === 'string' && m.error ? `（${m.error.slice(0, 200)}）` : ''}`));
    };
    const onMessage = (e: MessageEvent) => {
      // Only this site's callback page.
      if (e.origin === location.origin) take(e.data);
    };
    const onChannel = (e: MessageEvent) => take(e.data);
    function finish(error: Error | null, code?: string) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      channel?.removeEventListener('message', onChannel);
      channel?.close();
      if (pending?.state === state) pending = null;
      if (error) reject(error);
      else resolve(code!);
    }
    window.addEventListener('message', onMessage);
    channel?.addEventListener('message', onChannel);
    pending = { state, resolve: (code) => finish(null, code), reject: (error) => finish(error) };
  });
}

/**
 * Signs in to `portal` in a popup. Call from a click (the popup opens at
 * once, before anything is awaited, so it is not blocked). Resolves with who
 * signed in.
 */
export async function signIn(portal: ArcgisPortalConfig): Promise<ArcgisUser> {
  const popup = window.open('about:blank', 'arcgis-signin', 'popup,width=520,height=720');
  if (!popup) throw new Error('ポップアップがブロックされました。このサイトのポップアップを許可してください');
  const verifier = randomString(48);
  const state = randomString(24);
  const redirect = redirectUri();
  try {
    const challenge = await pkceChallenge(verifier);
    const code = waitForCode(state);
    popup.location.href = authorizeUrl(portal, { challenge, state, redirect });
    const answer = await requestToken(portal.url, { grant_type: 'authorization_code', client_id: portal.clientId, code: await code, redirect_uri: redirect, code_verifier: verifier });
    const self = await portalPost(`${portal.url}/sharing/rest/portals/self`, { f: 'json', token: answer.token });
    const servers = await portalPost(`${portal.url}/sharing/rest/portals/self/servers`, { f: 'json', token: answer.token }).catch(() => null);
    const user = isRecord(self.user) ? self.user : {};
    const username = typeof user.username === 'string' && user.username ? user.username : answer.username;
    if (!username) throw new Error('サインインしたユーザーが分かりませんでした');
    const session: Session = {
      portal: portal.url,
      clientId: portal.clientId,
      label: portal.label,
      token: answer.token,
      expires: answer.expires,
      ...(answer.refreshToken ? { refreshToken: answer.refreshToken, refreshExpires: answer.refreshExpires } : {}),
      username,
      ...(typeof user.fullName === 'string' && user.fullName ? { fullName: user.fullName.slice(0, 200) } : {}),
      ...scopesOf(portal.url, self, servers),
    };
    const previous = sessions.find((s) => s.portal === portal.url);
    if (previous) clearTimeout(timers.get(previous.portal));
    sessions = [...sessions.filter((s) => s.portal !== portal.url), session];
    schedule(session);
    changed();
    return currentUser(portal.url)!;
  } catch (error) {
    try {
      popup.close();
    } catch {
      // Another browsing context group (cross-origin isolation): it closes itself.
    }
    throw error;
  }
}

/** Signs out of `portalUrl` (every portal without it): forgets the tokens and asks the portal to revoke the refresh token. */
export function signOut(portalUrl?: string): void {
  const gone = portalUrl === undefined ? sessions : sessions.filter((s) => s.portal === portalUrl.replace(/\/+$/, ''));
  for (const s of gone) {
    clearTimeout(timers.get(s.portal));
    timers.delete(s.portal);
    if (s.refreshToken) {
      void portalPost(`${s.portal}/sharing/rest/oauth2/revokeToken`, { f: 'json', client_id: s.clientId, auth_token: s.refreshToken, token_type_hint: 'refresh_token' }).catch(() => {});
    }
  }
  sessions = sessions.filter((s) => !gone.includes(s));
  changed();
}

// ---------------------------------------------------------------------------
// Pictures

/** Loads `image` from `src`; resolves once it has loaded. */
function loadInto(image: HTMLImageElement, src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('画像を読み込めませんでした')), { once: true });
    image.src = src;
  });
}

/**
 * Loads a picture (a tile) from `src` with {@link authorize}'s query
 * parameters and a signed-in portal's token. Headers cannot go with an
 * `<img>`, so a URL with rule headers is fetched (CORS) and shown from a blob.
 */
export async function loadAuthorizedImage(src: string, options: { crossOrigin?: string | null; signal?: AbortSignal; image?: HTMLImageElement } = {}): Promise<HTMLImageElement> {
  const { url, headers } = authorize(src, { token: true });
  const image = options.image ?? new Image();
  if (!Object.keys(headers).length) {
    if (options.crossOrigin !== undefined) image.crossOrigin = options.crossOrigin;
    return loadInto(image, url);
  }
  const response = await fetch(url, { headers, signal: options.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    return await loadInto(image, blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
