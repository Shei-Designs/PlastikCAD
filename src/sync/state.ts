// Where this device remembers what it last agreed on with the remote, per
// project: IndexedDB, which the desktop webview and browsers alike have.
import type { SyncRecord, SyncState } from './engine';

const DB_NAME = 'plastikcad-sync';
/** What was agreed about the projects, and about the custom parts: kept apart, as the engine syncs each set on its own. */
export const STORES = { projects: 'records', parts: 'parts' } as const;
export type RecordStore = (typeof STORES)[keyof typeof STORES];
/** 2 added the parts. */
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      for (const store of Object.values(STORES)) if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store, { keyPath: 'projectId' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}

function transact<T>(store: RecordStore, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = run(tx.objectStore(store));
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : (undefined as T));
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('The sync state could not be stored.'));
        };
      }),
  );
}

export class DbSyncState implements SyncState {
  constructor(private readonly store: RecordStore = STORES.projects) {}
  all(): Promise<SyncRecord[]> {
    return transact<SyncRecord[]>(this.store, 'readonly', (s) => s.getAll());
  }
  put(record: SyncRecord): Promise<void> {
    return transact<void>(this.store, 'readwrite', (s) => void s.put(record));
  }
  remove(projectId: string): Promise<void> {
    return transact<void>(this.store, 'readwrite', (s) => void s.delete(projectId));
  }
  /** Forgets everything, when the account is unlinked. */
  clear(): Promise<void> {
    return transact<void>(this.store, 'readwrite', (s) => void s.clear());
  }
}
