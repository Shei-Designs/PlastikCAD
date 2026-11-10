// Where this device remembers what it last agreed on with the remote, per
// project: IndexedDB, which the desktop webview and browsers alike have.
import { tr } from '../i18n';
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
          reject(tx.error ?? new Error(tr('The sync state could not be stored.')));
        };
      }),
  );
}

const BINDING_KEY = 'plastikcad:sync:places:v1';

/** The pair of places each set of records was agreed between, as `bindRecords` wants it; null when none is on record. */
export function loadBinding(store: RecordStore): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(BINDING_KEY) ?? '{}') as Record<string, unknown>;
    const value = all?.[store];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function saveBinding(store: RecordStore, binding: string | null): void {
  try {
    const all = (JSON.parse(localStorage.getItem(BINDING_KEY) ?? '{}') ?? {}) as Record<string, unknown>;
    if (binding === null) delete all[store];
    else all[store] = binding;
    localStorage.setItem(BINDING_KEY, JSON.stringify(all));
  } catch {
    // Without storage the records are trusted for the session only as far as they were before.
  }
}

/** The records of one set on this device, or null where there is nowhere to keep them. */
export const openSyncState = (store: RecordStore): DbSyncState | null => (typeof indexedDB === 'undefined' ? null : new DbSyncState(store));

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
