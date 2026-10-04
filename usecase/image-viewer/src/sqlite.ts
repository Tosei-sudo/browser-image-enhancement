/**
 * SQLite in the browser (the official WebAssembly build, which has the
 * R-tree module GeoPackage spatial indexes use) behind a small interface.
 * It is loaded the first time a GeoPackage is opened or written, not with
 * the page.
 */
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';

/** A value in or out of SQLite. */
export type SqlValue = string | number | null | Uint8Array;

/** An SQLite database held in memory. */
export interface Database {
  /** Rows of a query, as objects by column name. */
  query(sql: string, params?: SqlValue[]): Array<Record<string, SqlValue>>;
  /** Runs one statement with `params`. */
  run(sql: string, params?: SqlValue[]): void;
  /** Runs SQL statements (no parameters). */
  exec(sql: string): void;
  /** Adds an SQL function of one argument. */
  addFunction(name: string, fn: (value: SqlValue) => SqlValue): void;
  /** The whole database as an SQLite file. */
  export(): Uint8Array<ArrayBuffer>;
  close(): void;
}

let loading: Promise<Sqlite3Static> | null = null;

function sqlite(): Promise<Sqlite3Static> {
  loading ??= import('@sqlite.org/sqlite-wasm').then(({ default: init }) => init());
  loading.catch(() => (loading = null));
  return loading;
}

/** Opens an SQLite file (or a new, empty database) in memory. */
export async function openDatabase(bytes?: Uint8Array): Promise<Database> {
  const sqlite3 = await sqlite();
  const { capi, wasm } = sqlite3;
  const db = new sqlite3.oo1.DB(':memory:');
  if (bytes) {
    const pointer = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(db.pointer!, 'main', pointer, bytes.length, bytes.length, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc) {
      db.close();
      throw new Error(`SQLite のファイルとして読めませんでした（${capi.sqlite3_js_rc_str(rc) ?? rc}）`);
    }
  }
  return {
    query: (sql, params = []) => db.selectObjects(sql, params) as Array<Record<string, SqlValue>>,
    run: (sql, params = []) => void db.exec({ sql, bind: params }),
    exec: (sql) => void db.exec(sql),
    addFunction: (name, fn) => void db.createFunction(name, (_ctx: number, ...values) => fn(values[0] as SqlValue), { arity: 1, deterministic: true }),
    export: () => capi.sqlite3_js_db_export(db) as Uint8Array<ArrayBuffer>,
    close: () => db.close(),
  };
}
