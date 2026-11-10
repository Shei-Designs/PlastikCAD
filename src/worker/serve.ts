// The worker's side of the protocol: requests answered one at a time, in the
// order they arrived (so imported data is always in before the nodes that use
// it). Apart from the worker file itself so that it can run under vitest.
import { build, exportColored, exportNodes, forgetAssets, massProperties, measure, partBox, resetKernel, robotGeometry, setAssets } from '../geometry/kernel';
import { tr } from '../i18n';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { transferOf } from './transfer';

type Post = (msg: WorkerResponse, transfer: Transferable[]) => void;

function answer(req: WorkerRequest): WorkerResponse | null {
  switch (req.type) {
    case 'assets':
      setAssets(req.assets);
      return null;
    case 'forgetAssets':
      forgetAssets(req.keep);
      return null;
    case 'build':
      return { type: 'built', id: req.id, result: build(req.key, req.node) };
    case 'measure':
      return { type: 'measured', id: req.id, bounds: measure(req.nodes) };
    case 'partBox':
      return { type: 'partBoxed', id: req.id, bounds: partBox(req.node) };
    case 'exportColored':
      return { type: 'exportedColored', id: req.id, result: exportColored(req.nodes, req.fine, req.local) };
    case 'massProperties':
      return { type: 'massProperties', id: req.id, result: massProperties(req.nodes) };
    case 'robotGeometry':
      return { type: 'robotGeometry', id: req.id, result: robotGeometry(req.nodes, req.collisions, req.fine) };
    case 'export':
      return { type: 'exported', id: req.id, result: exportNodes(req.nodes, req.outline, req.fine, req.local) };
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Whether an error means the kernel itself has stopped: a trap inside the
 * WASM (out of memory, as a rule), or a C++ exception that got out, which the
 * binding throws as a bare number. Every call into that kernel fails from
 * then on.
 */
export const kernelFault = (err: unknown): boolean => err instanceof WebAssembly.RuntimeError || typeof err === 'number';

/**
 * The handler for incoming requests. `load` brings the kernel up and is asked
 * before every request: it answers at once when the kernel is there, and
 * tries again when the last attempt failed.
 */
export function serve(post: Post, load: () => Promise<unknown>): (req: WorkerRequest) => void {
  let queue: Promise<void> = Promise.resolve();
  const handle = async (req: WorkerRequest): Promise<void> => {
    // Imported data needs no kernel: it is taken in even while one fails to load, for the requests that follow.
    const stores = req.type === 'assets' || req.type === 'forgetAssets';
    try {
      if (!stores) await load();
    } catch (err) {
      if (!stores) post({ type: 'error', id: req.id, message: messageOf(err) }, []);
      return;
    }
    try {
      const msg = answer(req);
      if (msg) post(msg, transferOf(msg));
    } catch (err) {
      const fault = kernelFault(err);
      // A fresh kernel is loaded for the next request; the imported data is still here.
      if (fault) resetKernel();
      // Asset messages have no reply; a problem with their data surfaces when a node uses it.
      if (stores) return;
      const message = !fault
        ? messageOf(err)
        : err instanceof Error
          ? tr('The geometry kernel stopped ({reason}), most likely for lack of memory, and was restarted.', { reason: err.message })
          : tr('The geometry kernel stopped, most likely for lack of memory, and was restarted.');
      post({ type: 'error', id: req.id, message }, []);
    }
  };
  return (req) => {
    // An answer that could not even be posted must not hold up the requests behind it.
    queue = queue.then(() => handle(req)).catch(() => undefined);
  };
}
