/** What vite.config.ts records about the build. */
export interface BuildInfo {
  /** Version of browser-image-enhancement the site was built with. */
  version: string;
  /** Short commit hash, '' when unknown. */
  commit: string;
  /** GitHub Actions run number, '' for a local build. */
  run: string;
  /** Build time, ISO 8601. */
  date: string;
}

declare const __BUILD_INFO__: BuildInfo;

/** The build of this page; the dev server and unit tests have none. */
export const buildInfo: BuildInfo | undefined = typeof __BUILD_INFO__ === 'undefined' ? undefined : __BUILD_INFO__;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** One-line label, e.g. "v0.1.0 · ビルド #42 · 1ff993b · 2026-10-04 18:10" (local time). */
export function buildLabel(info: BuildInfo): string {
  const parts = [`v${info.version}`];
  if (info.run) parts.push(`ビルド #${info.run}`);
  if (info.commit) parts.push(info.commit);
  const d = new Date(info.date);
  if (!Number.isNaN(d.getTime())) {
    parts.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }
  return parts.join(' · ');
}

/** Fills the element with the label, the full build time in its tooltip. */
export function showBuildInfo(el: HTMLElement, info: BuildInfo | undefined = buildInfo): void {
  if (!info) return;
  el.textContent = buildLabel(info);
  el.title = `browser-image-enhancement ${info.version}\nコミット ${info.commit || '不明'}\nビルド ${info.run ? `#${info.run}` : '(ローカル)'}\n${info.date}`;
}
