// Runs all solid modeling off the UI thread so the viewport stays responsive.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { build, exportNodes, initKernel, measure, partBox, setAssets } from '../geometry/kernel';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const ready = initKernel(wasmUrl);

function handle(req: WorkerRequest): void {
  switch (req.type) {
    case 'assets':
      setAssets(req.assets);
      break;
    case 'build': {
      const result = build(req.key, req.node);
      ctx.postMessage({ type: 'built', id: req.id, result }, [
        result.render.positions.buffer,
        result.render.normals.buffer,
      ]);
      break;
    }
    case 'measure':
      ctx.postMessage({ type: 'measured', id: req.id, bounds: measure(req.nodes) });
      break;
    case 'partBox':
      ctx.postMessage({ type: 'partBoxed', id: req.id, bounds: partBox(req.node) });
      break;
    case 'export': {
      const result = exportNodes(req.nodes, req.outline, req.fine);
      ctx.postMessage({ type: 'exported', id: req.id, result }, [
        result.mesh.positions.buffer,
        result.mesh.triangles.buffer,
      ]);
      break;
    }
  }
}

// Every handler waits on the same promise, so requests are still answered in
// the order they arrived (assets always before the nodes that use them).
ctx.onmessage = async (e) => {
  const req = e.data;
  try {
    await ready;
    handle(req);
  } catch (err) {
    // An 'assets' message has no reply; a problem with its data surfaces when a node uses it.
    if (req.type === 'assets') return;
    ctx.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
