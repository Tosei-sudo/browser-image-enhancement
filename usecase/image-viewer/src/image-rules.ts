/**
 * The defaults `config.json`'s `imageRules` give an image by its file name:
 * the first rule whose pattern matches sets the correction and the bands
 * shown when the image opens. Anything changed afterwards (in the panel, or
 * restored from a project file) takes over.
 */
import type { EnhancedGeoTIFF } from 'browser-image-enhancement/openlayers';
import { imageRuleFor, type ImageRule } from './config.js';

/** The rule each source was opened with. */
const applied = new WeakMap<EnhancedGeoTIFF, ImageRule>();

/** The rule `source` was opened with, if any. */
export function imageRuleOf(source: EnhancedGeoTIFF): ImageRule | undefined {
  return applied.get(source);
}

/** Stops the rule's bands from being shown on `source` when they are still to come (its settings are being restored instead). */
export function dropImageRule(source: EnhancedGeoTIFF): void {
  applied.delete(source);
}

/**
 * Gives `source` (just read, not shown yet) the correction of the first rule
 * matching `name` (a file name or URL), and starts showing its bands. The
 * correction is set at once; the bands follow, and `onProblem` says why when
 * they cannot be shown. Returns the rule, if one matched.
 */
export function applyImageRule(rules: readonly ImageRule[], name: string, source: EnhancedGeoTIFF, onProblem: (message: string) => void): ImageRule | undefined {
  const rule = imageRuleFor(rules, fileNameOf(name));
  if (!rule) return undefined;
  applied.set(source, rule);
  if (rule.pipeline) source.setPipeline(rule.pipeline);
  if (rule.bands) {
    void showBands(source, rule, rule.bands).catch((error: unknown) => onProblem(`設定「${rule.label}」のバンド割り当てを使えませんでした（${error instanceof Error ? error.message : String(error)}）`));
  }
  return rule;
}

/** The file name of a name as loaded: the last part of a URL's path (absolute or relative to the page), or the name of a file. */
export function fileNameOf(name: string): string {
  if (/^([a-z][a-z\d+.-]+:|\.{0,2}\/)/i.test(name)) {
    try {
      const path = new URL(name, 'http://localhost/').pathname;
      return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
    } catch {
      // not a URL after all
    }
  }
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
}

/** Shows `bands` (1-based numbers or band names) as R, G and B, or one band in gray. */
async function showBands(source: EnhancedGeoTIFF, rule: ImageRule, bands: ReadonlyArray<number | string>): Promise<void> {
  const count = source.getValueBandCount();
  if (count < 3) throw new Error(`バンドが ${count} つしかありません`);
  const names = bands.some((b) => typeof b === 'string') ? await source.getBandNames() : [];
  // A project file being restored sets the bands instead.
  if (applied.get(source) !== rule) return;
  const select = bands.map((band) => {
    if (typeof band === 'number') {
      if (band > count) throw new Error(`バンド ${band} はありません（${count} バンドの画像です）`);
      return band - 1;
    }
    const wanted = band.trim().toLowerCase();
    const found = names.findIndex((n) => n?.trim().toLowerCase() === wanted);
    if (found < 0) throw new Error(`「${band}」という名前のバンドがありません`);
    return found;
  });
  await source.setSelect(select as [number] | [number, number, number]);
}
