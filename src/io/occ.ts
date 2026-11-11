// OpenCascade, the B-rep kernel STEP files are read and written with. It is
// some 23 MB of WebAssembly, so it is loaded when a STEP file first asks for
// it and kept from then on. Where its file is depends on who runs it (the
// worker is given an address by the bundler, a test reads it from disk), so
// that is handed in.
import type { InitOpenCascadeOptions, OpenCascadeInstance } from 'replicad-opencascadejs';

let loading: Promise<OpenCascadeInstance> | null = null;

/** Loads OpenCascade once; `options` say where its WebAssembly is. A failed load is tried again when next asked for. */
export function loadOcc(options: InitOpenCascadeOptions): Promise<OpenCascadeInstance> {
  loading ??= import('replicad-opencascadejs')
    // The library reports its progress and its statistics on the console: neither is for the user.
    .then((module) => module.default({ print: () => undefined, printErr: () => undefined, ...options }))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}
