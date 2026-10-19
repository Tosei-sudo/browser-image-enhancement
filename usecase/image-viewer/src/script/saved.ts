/**
 * The scripts saved in this browser (localStorage), by name, and the same
 * list as kept in a project file. Saved scripts are only listed: none runs
 * until 「実行」 is pressed.
 */

const SAVED_KEY = 'image-viewer.scripts';

export interface SavedScript {
  name: string;
  code: string;
}

/** The saved scripts in a value read from JSON (storage or a project file); anything else is left out. */
export function readScripts(raw: unknown): SavedScript[] {
  return Array.isArray(raw) ? raw.filter((s): s is SavedScript => typeof s?.name === 'string' && !!s.name && typeof s?.code === 'string').map((s) => ({ name: s.name, code: s.code })) : [];
}

export function readSaved(): SavedScript[] {
  try {
    return readScripts(JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function writeSaved(list: SavedScript[]): boolean {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * `list` with the scripts of `added` the list does not have: the same name
 * and code is already there; the same name with other code comes in as
 * 「name (2)」, so nothing saved is replaced.
 */
export function mergeScripts(list: SavedScript[], added: SavedScript[]): SavedScript[] {
  const merged = [...list];
  for (const script of added) {
    const same = (name: string) => merged.some((s) => s.name === name && s.code === script.code);
    let name = script.name;
    for (let n = 2; merged.some((s) => s.name === name) && !same(name); n++) name = `${script.name} (${n})`;
    if (!same(name)) merged.push({ name, code: script.code });
  }
  return merged;
}
