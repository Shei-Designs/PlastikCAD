// OpenCascade, the B-rep kernel STEP files are read and written with. It is
// some 23 MB of WebAssembly, so it is loaded when a STEP file first asks for
// it and kept from then on. Where its file is depends on who runs it (the
// worker is given an address by the bundler, a test reads it from disk), so
// that is handed in.
import type { InitOpenCascadeOptions, OpenCascadeInstance } from 'replicad-opencascadejs';

let loading: Promise<OpenCascadeInstance> | null = null;
/** The library that `loading` brought in, once it has. */
let loaded: OpenCascadeInstance | null = null;

/**
 * Loads OpenCascade once; `options` say where its WebAssembly is. A failed load is tried again when next asked for,
 * and so is one let go of since (see `forgetOcc`).
 */
export function loadOcc(options: InitOpenCascadeOptions): Promise<OpenCascadeInstance> {
  loading ??= import('replicad-opencascadejs')
    // The library reports its progress and its statistics on the console: neither is for the user.
    .then((module) => module.default({ print: () => undefined, printErr: () => undefined, ...options }))
    .then((oc) => (loaded = oc))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

/**
 * Whether an error is a trap inside the WebAssembly (memory read out of bounds, as a rule, or none left): not one of
 * the library's own exceptions, which it throws to say that something did not come off and goes on working after.
 */
export const isTrap = (e: unknown): boolean => e instanceof WebAssembly.RuntimeError;

/**
 * Lets go of the library after a trap inside it. What it holds in its memory is from then on not to be relied on,
 * and calls into it have been seen to fail in ways that have nothing to do with what was asked; so it is not used
 * again, and the next `loadOcc` brings in a fresh one. Whoever catches a trap from `oc` calls this and passes the
 * trap on.
 */
export function forgetOcc(oc: OpenCascadeInstance): void {
  if (loaded !== oc) return;
  loaded = null;
  loading = null;
}
