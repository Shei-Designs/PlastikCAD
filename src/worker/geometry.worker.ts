// Runs all solid modeling off the UI thread so the viewport stays responsive.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import occUrl from 'replicad-opencascadejs/wasm?url';
import dracoUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import { initKernel } from '../geometry/kernel';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { loadDraco } from '../io/draco';
import { loadOcc } from '../io/occ';
import { serve } from './serve';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const receive = serve(
  (msg, transfer) => ctx.postMessage(msg, transfer),
  () => initKernel(wasmUrl),
  // OpenCascade comes only when a STEP file does: the address costs nothing until then.
  () => loadOcc({ locateFile: () => occUrl }),
  // Likewise the Draco decoder, for the first glTF file compressed with it.
  () => loadDraco({ locateFile: () => dracoUrl }),
);

// Loading starts at once rather than with the first request; if it fails, that request tries again.
initKernel(wasmUrl).catch(() => undefined);

ctx.onmessage = (e) => receive(e.data);
