// The one module that knows whether the UI runs in the desktop app (Tauri) or
// in a plain browser, as it does during development (`pnpm dev`). Tauri's
// window, webview and dialog modules are imported on demand, so the browser
// never loads them.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { APP_NAME } from './app';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  name: string;
  /** Absolute path; null in the browser. */
  path: string | null;
  bytes: Uint8Array;
}

export function isDesktop(): boolean {
  return isTauri();
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** Calls one of the commands in `src-tauri/src/lib.rs`, which reject with a plain string. */
async function command<T>(name: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`${name} is only available in the desktop app`);
  try {
    return await invoke<T>(name, args, headers && { headers });
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

async function readBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Keeps the files that could be read: one bad entry (a dropped folder, say) should not lose the rest. */
async function readable(reads: Promise<PickedFile>[]): Promise<PickedFile[]> {
  const results = await Promise.allSettled(reads);
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/**
 * Tauri registers listeners asynchronously, but callers want an unsubscribe
 * function straight away; this one also works if called before registration
 * has finished.
 */
function listen(register: () => Promise<() => void>): () => void {
  let canceled = false;
  let unlisten: (() => void) | null = null;
  register().then((stop) => {
    if (canceled) stop();
    else unlisten = stop;
  }, console.error);
  return () => {
    canceled = true;
    unlisten?.();
  };
}

function pickInBrowser(filters: FileFilter[], multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    const extensions = filters.flatMap((filter) => filter.extensions);
    if (!extensions.includes('*')) input.accept = extensions.map((extension) => `.${extension}`).join(',');
    input.style.display = 'none';
    const settle = (files: Promise<PickedFile[]>) => {
      input.remove();
      files.then(resolve, reject);
    };
    input.addEventListener('change', () => settle(Promise.all(Array.from(input.files ?? [], readBrowserFile))));
    input.addEventListener('cancel', () => settle(Promise.resolve([])));
    // Attached to the page so it cannot be collected while the picker is open.
    document.body.append(input);
    input.click();
  });
}

/** Native open dialog, or a hidden <input type="file"> in the browser. Empty array if canceled. */
export async function pickFiles(options: { filters: FileFilter[]; multiple?: boolean }): Promise<PickedFile[]> {
  const multiple = options.multiple ?? false;
  if (!isTauri()) return pickInBrowser(options.filters, multiple);
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked: string | string[] | null = await open({ filters: options.filters, multiple });
  if (picked === null) return [];
  return Promise.all((Array.isArray(picked) ? picked : [picked]).map(readPath));
}

/** Desktop only. Rejects with a readable Error if the file cannot be read. */
export async function readPath(path: string): Promise<PickedFile> {
  // Tauri delivers the bytes as an array of numbers where it cannot use a binary response.
  const data = await command<ArrayBuffer | number[]>('read_file', { path });
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return { name: baseName(path), path, bytes };
}

/** Native save dialog then write (desktop), or a download (browser, where `path` is null). Null if canceled. */
export async function saveAs(
  suggestedName: string,
  filters: FileFilter[],
  bytes: Uint8Array,
  mime: string,
): Promise<{ path: string | null; name: string } | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: suggestedName, filters });
    if (!path) return null;
    await writePath(path, bytes);
    return { path, name: baseName(path) };
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { path: null, name: suggestedName };
}

/** Desktop only: overwrite a known path atomically. */
export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  // The bytes are the request body, so the path travels in a header, and header values must be ASCII.
  await command<void>('write_file', bytes, { path: encodeURIComponent(path) });
}

/** A design in the projects folder, as the desktop app lists them. */
export interface DesignEntry {
  name: string;
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

/** Desktop only: the designs directly inside a folder, which is created if missing. */
export async function listDesigns(dir: string): Promise<DesignEntry[]> {
  return command<DesignEntry[]>('list_designs', { dir });
}

/** Desktop only: the first `limit` bytes of a file. */
export async function readHead(path: string, limit: number): Promise<Uint8Array> {
  const data = await command<ArrayBuffer | number[]>('read_head', { path, limit });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}

/** Desktop only. */
export async function removeFile(path: string): Promise<void> {
  await command<void>('remove_file', { path });
}

/** Desktop only: renames or moves a file; fails rather than replace an existing one. */
export async function moveFile(from: string, to: string): Promise<void> {
  await command<void>('move_file', { from, to });
}

/** Desktop only: where projects go unless the user picked a folder; `fixed` where no other folder can be chosen (Android). */
export async function defaultProjectsDir(): Promise<{ path: string; fixed: boolean }> {
  return command<{ path: string; fixed: boolean }>('default_projects_dir');
}

/** Desktop only: native folder picker. Null if canceled. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, defaultPath });
  return typeof picked === 'string' ? picked : null;
}

/** Desktop only: path of a design file passed on the command line, else null (always null in the browser). */
export async function startupFile(): Promise<string | null> {
  return isTauri() ? command<string | null>('startup_file') : null;
}

export function setWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri()) return;
  // The native title bar does not follow document.title.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(console.error);
}

/** Files dropped on the window (native drag-drop on desktop, HTML5 drop in the browser). Returns an unsubscribe function. */
export function onFilesDropped(handler: (files: PickedFile[]) => void): () => void {
  const deliver = (files: PickedFile[]) => {
    if (files.length > 0) handler(files);
  };
  if (isTauri()) {
    // Tauri handles drops natively (`dragDropEnabled`, on by default), which
    // is what provides real paths; the webview gets no HTML5 drop events.
    return listen(async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') void readable(event.payload.paths.map(readPath)).then(deliver);
      });
    });
  }
  // Both events must be canceled, or the browser navigates to the dropped file.
  const allow = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    void readable(Array.from(event.dataTransfer?.files ?? [], readBrowserFile)).then(deliver);
  };
  window.addEventListener('dragover', allow);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', allow);
    window.removeEventListener('drop', drop);
  };
}

/** Yes/no question: native dialog on desktop, window.confirm in the browser. */
export async function confirm(
  message: string,
  options: { title?: string; okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(message, { title: options.title ?? APP_NAME, okLabel: options.okLabel, cancelLabel: options.cancelLabel });
}

/**
 * Saves before the window closes while `isDirty()` is true. On desktop the
 * close request is held while `flush` writes; if that fails the user is asked
 * whether to close anyway. In a browser only the standard prompt can be shown.
 * Returns an unsubscribe function.
 */
export function guardClose(isDirty: () => boolean, flush: () => Promise<boolean>): () => void {
  if (isTauri()) {
    let closing = false;
    return listen(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      // Tauri closes the window once this handler settles, unless it called preventDefault.
      return window.onCloseRequested(async (event) => {
        if (!isDirty()) return;
        event.preventDefault();
        // A second click on the close button must not stack another save or dialog.
        if (closing) return;
        closing = true;
        try {
          const saved = await flush();
          const close =
            saved ||
            (await confirm('The latest changes could not be saved. Close anyway and lose them?', {
              title: 'Unsaved changes',
              okLabel: 'Close anyway',
              cancelLabel: 'Keep editing',
            }));
          if (close) await window.destroy();
        } finally {
          closing = false;
        }
      });
    });
  }
  // Browsers show their own wording; canceling the event is what triggers the prompt.
  const warn = (event: BeforeUnloadEvent) => {
    if (isDirty()) event.preventDefault();
  };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}

/** Runs `handler` when the page is hidden (another app in front, the tab switched), the moment to write out what is pending. Returns an unsubscribe function. */
export function onHidden(handler: () => void): () => void {
  const check = () => {
    if (document.visibilityState === 'hidden') handler();
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pagehide', handler);
  return () => {
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('pagehide', handler);
  };
}
