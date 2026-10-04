/**
 * Editing layers read from local files (GeoJSON, Shapefile, GeoPackage).
 * "Save" writes the file again in its own format and CRS: over the original
 * when it was opened with a handle the browser lets us write (it asks
 * first), else as a download of the same name. A GeoPackage gets only the
 * edited rows changed, so its other tables and columns stay as they were; a
 * Shapefile in a .zip goes back into the .zip with the rest of it.
 */
import type Feature from 'ol/Feature.js';
import type VectorSource from 'ol/source/Vector.js';
import type { EditTarget } from './edit-session.js';
import { encodeGeometry, quote, type GeoPackageTable } from './geopackage.js';
import type { Field } from './services/index.js';
import type { SqlValue } from './sqlite.js';
import type { NamedBytes, VectorFile } from './vector-files.js';
import { sqlValue, wgs84, writeGeoJson, writeShapefile, zipFiles, type TargetCrs } from './vector-write.js';

/** How a file was saved. */
export type Saved = 'overwritten' | 'downloaded';

/** Hands bytes to the person as a download named `name`. */
export function download(name: string, bytes: Uint8Array<ArrayBuffer> | string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface WritableHandle extends FileSystemFileHandle {
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Writes over `handle` after asking for permission; false when not allowed or not possible. */
async function overwrite(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer> | string): Promise<boolean> {
  const h = handle as WritableHandle;
  if (typeof h.createWritable !== 'function') return false;
  try {
    if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
    const writable = await h.createWritable();
    await writable.write(bytes);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/** Saves files: each over its handle when every one has a handle we may write, else all as one download (`fallback`). */
async function saveFiles(files: Array<{ handle?: FileSystemFileHandle; bytes: Uint8Array<ArrayBuffer> | string }>, fallback: () => void): Promise<Saved> {
  if (files.every((f) => f.handle)) {
    let done = 0;
    for (const f of files) {
      if (!(await overwrite(f.handle!, f.bytes))) break;
      done++;
    }
    if (done === files.length) return 'overwritten';
  }
  fallback();
  return 'downloaded';
}

/** The file name without folders. */
function fileName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Whether a layer read from files can be edited (and saved again). */
export function isEditable(file: VectorFile, truncated: boolean): boolean {
  // A layer cut at the feature limit would lose the rest when written again; a GeoPackage changes only edited rows.
  return !!file.origin && (!truncated || !!file.gpkg);
}

/**
 * The edit target of a layer read from files. `fields` are the table's; new
 * features start empty, and any geometry type the file holds can be drawn.
 */
export function localTarget(file: VectorFile, source: VectorSource<Feature>, fields: Field[]): EditTarget {
  const crs = file.writeCrs ?? wgs84;
  const target: EditTarget = {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    geometryType: file.geometryType ?? null,
    template: {},
    savedTo: 'ファイル',
    async save(edits) {
      let saved: Saved;
      if (file.gpkg) {
        writeEdits(file.gpkg, crs, edits);
        const gpkg = Object.values(file.origin!.files)[0];
        saved = await saveFiles([{ handle: gpkg.handle, bytes: file.gpkg.db.export() }], () => download(fileName(gpkg.name), file.gpkg!.db.export(), 'application/geopackage+sqlite3'));
      } else if (file.format === 'GeoJSON') {
        const json = Object.values(file.origin!.files)[0];
        const text = writeGeoJson(source.getFeatures(), fields, crs);
        saved = await saveFiles([{ handle: json.handle, bytes: text }], () => download(fileName(json.name), text, 'application/geo+json'));
      } else {
        saved = await saveShapefile(file, source.getFeatures(), fields, crs);
      }
      return { note: saved === 'overwritten' ? '元のファイルに上書きしました' : 'ファイルをダウンロードしました' };
    },
  };
  return target;
}

/** Writes a Shapefile again: into its .zip, over its parts, or as a download of `name.zip`. */
async function saveShapefile(file: VectorFile, features: Feature[], fields: Field[], crs: TargetCrs): Promise<Saved> {
  const origin = file.origin!;
  const shp = origin.files['.shp'];
  const base = shp.name.slice(0, -4);
  // One kind of geometry (the editor draws the file's own), so the names stay the file's.
  const written = writeShapefile(fileName(base), features, fields, crs).map((f) => ({ ...f, name: base + f.name.slice(f.name.lastIndexOf('.')) }));
  if (origin.zip) {
    const replaced = new Set(written.map((f) => f.name.toLowerCase()));
    const stem = base.toLowerCase();
    const kept = origin.zip.entries.filter((e) => !replaced.has(e.name.toLowerCase()) && !(e.name.toLowerCase().startsWith(`${stem}.`) && /\.(shp|shx|dbf|prj|cpg|qix|sbn|sbx)$/i.test(e.name)));
    const entries: NamedBytes[] = [...kept, ...written];
    const bytes = zipFiles(entries);
    origin.zip.entries = entries;
    return saveFiles([{ handle: origin.zip.file.handle, bytes }], () => download(fileName(origin.zip!.file.name), bytes, 'application/zip'));
  }
  // Separate files: each written over its own, when all of them were chosen with handles.
  const byExt = new Map(written.map((f) => [f.name.slice(f.name.lastIndexOf('.')).toLowerCase(), f]));
  const needed = ['.shp', '.shx', '.dbf', '.cpg', ...(byExt.has('.prj') ? ['.prj'] : [])];
  return saveFiles(
    needed.map((ext) => ({ handle: origin.files[ext]?.handle, bytes: byExt.get(ext)!.bytes as Uint8Array<ArrayBuffer> })),
    () => download(`${fileName(base)}.zip`, zipFiles(written.map((f) => ({ ...f, name: fileName(f.name) }))), 'application/zip'),
  );
}

/** Writes the edits into the table of an open GeoPackage, in one transaction. */
function writeEdits(t: GeoPackageTable, crs: TargetCrs, edits: Parameters<EditTarget['save']>[0]): void {
  const { db } = t;
  const table = quote(t.table);
  const geometry = (f: Feature): SqlValue => {
    const g = f.getGeometry();
    return g ? encodeGeometry(g.clone().transform('EPSG:3857', crs.projection), t.srsId) : null;
  };
  const columns = (names: Iterable<string>) => [...names].filter((n) => t.types.has(n) && n !== t.idColumn && n !== t.geometryColumn);
  const value = (f: Feature, column: string) => sqlValue(f.get(column), t.types.get(column)!);
  db.exec('BEGIN');
  try {
    for (const f of edits.deletes) db.run(`DELETE FROM ${table} WHERE ${quote(t.idColumn)} = ?`, [f.getId() as number]);
    for (const { feature: f, attributes, geometry: moved } of edits.updates) {
      const set = columns(attributes);
      const sets = [...set.map((c) => `${quote(c)} = ?`), ...(moved ? [`${quote(t.geometryColumn)} = ?`] : [])];
      if (!sets.length) continue;
      db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${quote(t.idColumn)} = ?`, [...set.map((c) => value(f, c)), ...(moved ? [geometry(f)] : []), f.getId() as number]);
    }
    for (const f of edits.adds) {
      const set = columns(Object.keys(f.getProperties()));
      db.run(`INSERT INTO ${table} (${[t.geometryColumn, ...set].map(quote).join(', ')}) VALUES (?${', ?'.repeat(set.length)})`, [geometry(f), ...set.map((c) => value(f, c))]);
      const id = Number(db.query('SELECT last_insert_rowid() AS id')[0].id);
      f.setId(id);
      f.set(t.idColumn, id);
    }
    db.run(`UPDATE gpkg_contents SET last_change = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE table_name = ?`, [t.table]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
