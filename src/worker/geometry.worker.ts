// Runs all solid modeling off the UI thread so the viewport stays responsive.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initKernel } from '../geometry/kernel';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { serve } from './serve';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const receive = serve(
  (msg, transfer) => ctx.postMessage(msg, transfer),
  () => initKernel(wasmUrl),
);

// Loading starts at once rather than with the first request; if it fails, that request tries again.
initKernel(wasmUrl).catch(() => undefined);

ctx.onmessage = (e) => receive(e.data);
