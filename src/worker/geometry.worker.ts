// Where the geometry worker starts. It holds none of the worker's code: that is loaded from here as a
// part of its own (geometry.main.ts), and the requests that arrive meanwhile wait their turn.
//
// The reason is WebKit (the desktop app on Linux and macOS). The bundler lets the parts that are loaded
// later (OpenCascade for STEP files, the Draco decoder) import the code they share with the rest from
// the file that holds it, and that was this one. WebKit runs the file a worker starts from a second
// time when another file imports it: the second run took the worker over with an empty kernel and none
// of the imported data or lettering the first had been handed, so after the first STEP file of a
// session an export failed for want of them. A file with nothing to share is imported by no one.
import type { WorkerRequest } from './protocol';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

const early: WorkerRequest[] = [];
ctx.onmessage = (e) => early.push(e.data);

import('./geometry.main').then(
  ({ receive }) => {
    ctx.onmessage = (e) => receive(e.data);
    for (const request of early.splice(0)) receive(request);
  },
  (err: unknown) => {
    // Thrown where nothing catches it, so that the page hears of it as the worker failing and starts another.
    setTimeout(() => {
      throw err;
    });
  },
);
