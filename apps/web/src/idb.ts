/** Minimal promise helpers over IndexedDB (no wrapper library). */

export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = (e) => upgrade(r.result, r.transaction!, e.oldVersion);
    r.onsuccess = () => {
      const db = r.result;
      // Let deleteDatabase() (sign-out wipe) proceed instead of blocking on this open connection.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another tab`));
  });
}

export const req = <T,>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Resolves on the transaction's `complete` event, i.e. once the data is durable. */
export const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

export function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve(); // completes once other connections close (they close on versionchange)
  });
}
