/**
 * Field aliases: the heading an attribute is shown with (Esri's `alias`,
 * QGIS's aliases in a .qml or a GeoPackage's style, FlatGeobuf's column
 * `title`, a GeoPackage's `gpkg_data_columns`, a web map's popup labels).
 * Tables, choices of attributes and forms show the alias; SQL, where
 * clauses, files and edits keep the attribute's own name.
 *
 * The person can change a layer's alias in the table's 「列」 list; the
 * alias the layer came with is kept, so a blank one goes back to it, and
 * the changed ones are saved in the project.
 */
import { attr, escapeXml, kid, kids, parseXml, type XmlElement } from './safe-xml.js';
import type { Field } from './services/index.js';

/** Sent on `window` when an alias is changed, for what shows headings. */
export const ALIAS_EVENT = 'image-viewer:field-aliases';

/** The alias each field came with, when the person has changed it. */
const originals = new WeakMap<Field, string>();

/** The heading of a field: its alias, else its name. */
export function fieldHeading(field: Pick<Field, 'name' | 'alias'>): string {
  return field.alias?.trim() || field.name;
}

/** A field for a choice of attributes: `alias（name）`, or the name alone without an alias. */
export function fieldLabel(field: Pick<Field, 'name' | 'alias'>): string {
  const heading = fieldHeading(field);
  return heading === field.name ? field.name : `${heading}（${field.name}）`;
}

/** {@link fieldLabel} of the field named `name` among `fields`, else the name. */
export function nameLabel(fields: readonly Field[] | undefined, name: string): string {
  const field = fields?.find((f) => f.name === name);
  return field ? fieldLabel(field) : name;
}

/** The alias the field came with (before the person changed it). */
export function originalAlias(field: Field): string {
  return originals.get(field) ?? field.alias;
}

/**
 * Sets a field's alias; blank goes back to the one it came with. Returns
 * whether it changed, and tells the headings ({@link ALIAS_EVENT}).
 */
export function setFieldAlias(field: Field, alias: string): boolean {
  const original = originalAlias(field);
  const next = alias.trim() || original || field.name;
  if (next === field.alias) return false;
  if (!originals.has(field)) originals.set(field, field.alias);
  field.alias = next;
  if (next === original) originals.delete(field);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ALIAS_EVENT, { detail: field }));
  return true;
}

/** The aliases the person changed (name → alias), or null when none was. */
export function aliasOverrides(fields: readonly Field[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of fields) if (originals.has(f) && f.alias !== originals.get(f)) out[f.name] = f.alias;
  return Object.keys(out).length ? out : null;
}

/** Sets the aliases of `aliases` (name → alias) on the fields with those names. */
export function applyAliases(fields: readonly Field[], aliases: Readonly<Record<string, string>> | ReadonlyMap<string, string>): void {
  const entries = aliases instanceof Map ? [...aliases] : Object.entries(aliases);
  for (const [name, alias] of entries) {
    const field = fields.find((f) => f.name === name);
    if (field && typeof alias === 'string') setFieldAlias(field, alias);
  }
}

/** Fields with the aliases of `aliases` as the ones they come with (for a file's own aliases). */
export function withAliases<F extends Pick<Field, 'name' | 'alias'>>(fields: F[], aliases: ReadonlyMap<string, string>): F[] {
  return aliases.size ? fields.map((f) => (aliases.get(f.name) ? { ...f, alias: aliases.get(f.name)! } : f)) : fields;
}

/** Gives fields the aliases of `aliases` (name → alias) as the ones they come with (a file's own, not the person's). */
export function adoptAliases(fields: ReadonlyArray<Pick<Field, 'name' | 'alias'>>, aliases: ReadonlyMap<string, string>): void {
  for (const f of fields) {
    const alias = aliases.get(f.name);
    if (alias) f.alias = alias;
  }
}

/** The aliases in a QGIS style file's text (.qml, a GeoPackage's `layer_styles`); none when it cannot be read. */
export function qmlTextAliases(text: string | null | undefined): Map<string, string> {
  if (!text) return new Map();
  try {
    return readQmlAliases(parseXml(text));
  } catch {
    return new Map();
  }
}

/** The aliases of a QGIS layer (`<aliases><alias field= name=/>`, in a .qml, a style or a project's map layer). */
export function readQmlAliases(layer: XmlElement | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of kids(kid(layer, 'aliases'), 'alias')) {
    const field = attr(a, 'field');
    const name = attr(a, 'name')?.trim();
    if (field && name) out.set(field, name);
  }
  return out;
}

/** QGIS's `<aliases>` for the fields with an alias other than their name; `rename` gives the column written. */
export function qmlAliasesXml(fields: ReadonlyArray<Pick<Field, 'name' | 'alias'>>, rename: ReadonlyMap<string, string> = new Map()): string {
  const named = fields.map((f, index) => ({ field: rename.get(f.name) ?? f.name, alias: fieldHeading(f), index })).filter((f) => f.alias !== f.field && f.alias !== '');
  if (!named.length) return '';
  return `<aliases>${named.map((f) => `<alias field="${escapeXml(f.field)}" index="${f.index}" name="${escapeXml(f.alias)}"/>`).join('')}</aliases>`;
}
