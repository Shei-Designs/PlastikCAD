// What survives a restart: preferences (localStorage) and the design that was
// open (IndexedDB, since imported meshes can be far larger than localStorage allows).
import { FILE_FORMAT } from '../app';
import type { FormatId } from '../io/export';
import type { Doc } from '../model/types';

export type Theme = 'dark' | 'light';

export interface Prefs {
  theme: Theme;
  edges: boolean;
  grid: boolean;
  /** Grid step that moves and sizes snap to, in mm; 0 turns snapping off. */
  snap: number;
  format: FormatId;
  panel: 'design' | 'versions';
  /** Recently used design files (desktop app). */
  recent: string[];
}

export const SNAP_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10];

const PREFS_KEY = `${FILE_FORMAT}:prefs:v1`;

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    // Corrupt or unavailable storage: start from defaults.
  }
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  return {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : prefersLight ? 'light' : 'dark',
    edges: saved.edges ?? true,
    grid: saved.grid ?? true,
    snap: SNAP_STEPS.includes(saved.snap as number) ? (saved.snap as number) : 1,
    format: (['stl', '3mf', 'obj', 'svg', 'dxf'] as const).find((f) => f === saved.format) ?? 'stl',
    panel: saved.panel === 'versions' ? 'versions' : 'design',
    recent: Array.isArray(saved.recent) ? saved.recent.filter((p): p is string => typeof p === 'string').slice(0, 8) : [],
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; preferences just won't persist.
  }
}

export interface Session {
  doc: Doc;
  filePath: string | null;
  dirty: boolean;
}

const DB_NAME = FILE_FORMAT;
const STORE = 'session';

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function loadSession(): Promise<Session | null> {
  try {
    const session = await withStore<Session | undefined>('readonly', (s) => s.get('current'));
    return session && Array.isArray(session.doc?.scene) ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  // Losing the session copy is not worth interrupting anyone for.
  withStore('readwrite', (s) => s.put(session, 'current')).catch(() => {});
}
