// The worker's side of the protocol: requests answered one at a time, in the
// order they arrived (so imported data is always in before the nodes that use
// it). Apart from the worker file itself so that it can run under vitest.
import { build, collisionMeshes, exportColored, exportNodes, forgetAssets, massProperties, measure, partBox, resetKernel, robotGeometry, setAssets } from '../geometry/kernel';
import { indexFeatures } from '../geometry/features';
import { tr } from '../i18n';
import { writeStep } from '../io/stepExport';
import { unpackZip } from '../io/zip';
import { readFile, readHeld } from './importing';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { transferOf } from './transfer';

type Post = (msg: WorkerResponse, transfer: Transferable[]) => void;

/** What the worker reads STEP files with, loaded when first asked for; none where STEP is not on offer. */
type Occ = Parameters<typeof readFile>[5];
/** What unpacks a glTF file compressed with Draco, loaded when first asked for. */
type Draco = Parameters<typeof readFile>[6];

function answer(req: WorkerRequest, occ: Occ, draco: Draco): WorkerResponse | null | Promise<WorkerResponse> {
  switch (req.type) {
    case 'assets':
      setAssets(req.assets);
      return null;
    case 'forgetAssets':
      forgetAssets(req.keep);
      return null;
    case 'import':
      return readFile(req.id, req.name, req.bytes, req.companions, req.scale, occ, draco).then((result) => ({ type: 'imported' as const, id: req.id, result }));
    case 'importHeld':
      return { type: 'imported', id: req.id, result: readHeld(req.held, req.scale) };
    case 'unzip':
      return { type: 'unzipped', id: req.id, result: unpackZip(req.bytes) };
    case 'build':
      return { type: 'built', id: req.id, result: build(req.key, req.node) };
    case 'measure':
      return { type: 'measured', id: req.id, bounds: measure(req.nodes) };
    case 'partBox':
      return { type: 'partBoxed', id: req.id, bounds: partBox(req.node) };
    case 'exportColored':
      return { type: 'exportedColored', id: req.id, result: exportColored(req.nodes, req.fine, req.local) };
    case 'features':
      return { type: 'features', id: req.id, result: indexFeatures(placedBy(req.positions, req.matrix)) };
    case 'exportStep': {
      // The shapes first, by the kernel, which must be done with them before the wait for OpenCascade begins.
      const colored = exportColored(req.nodes, true);
      // The objects come in the order of the nodes that are neither holes, hidden nor pictures. One of a single
      // color is the whole of its node, which the writer then tries to rebuild as true surfaces.
      const sources = req.nodes.filter((n) => !n.hole && !n.hidden && n.type !== 'picture');
      // At fine detail, to hold a rebuilt solid against; and as the screen has them, to write when there is none:
      // every facet is a face in the file, and a thread at fine detail makes one of a hundred megabytes.
      const coarse = exportColored(req.nodes, false);
      const objects = colored.objects.flatMap((o, i) =>
        o.parts.map((p, k) => ({
          name: o.name,
          color: p.color,
          mesh: p.mesh,
          ...(coarse.objects[i]?.parts.length === o.parts.length ? { facets: coarse.objects[i].parts[k].mesh } : {}),
          ...(o.parts.length === 1 && sources.length === colored.objects.length ? { node: sources[i] } : {}),
        })),
      );
      if (!occ) throw new Error(tr('STEP files cannot be written here.'));
      return occ()
        .catch(() => {
          throw new Error(tr('The STEP writer could not be loaded.'));
        })
        .then((oc) => {
          const written = writeStep(oc, objects, { partBox });
          // What the kernel had to say of open meshes is said by the writer too, of the same objects.
          return { type: 'exportedStep' as const, id: req.id, result: { bytes: written.bytes, warnings: written.warnings } };
        });
    }
    case 'massProperties':
      return { type: 'massProperties', id: req.id, result: massProperties(req.nodes) };
    case 'collisionMeshes':
      return { type: 'collisionMeshes', id: req.id, result: collisionMeshes(req.nodes, req.collisions, req.pieces) };
    case 'robotGeometry':
      return { type: 'robotGeometry', id: req.id, result: robotGeometry(req.nodes, req.collisions, req.fine, req.pieces) };
    case 'export':
      return { type: 'exported', id: req.id, result: exportNodes(req.nodes, req.outline, req.fine, req.local) };
  }
}

/** The points moved by a matrix of sixteen numbers, column by column, where they are (the array is this request's own). */
function placedBy(positions: Float32Array, m: number[]): Float32Array {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return positions;
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
export function serve(post: Post, load: () => Promise<unknown>, occ?: Occ, draco?: Draco): (req: WorkerRequest) => void {
  let queue: Promise<void> = Promise.resolve();
  const handle = async (req: WorkerRequest): Promise<void> => {
    // Imported data needs no kernel: it is taken in even while one fails to load, for the requests that follow.
    const stores = req.type === 'assets' || req.type === 'forgetAssets';
    // Nor does reading a file, or a mesh for the Measure tool.
    const reads = req.type === 'import' || req.type === 'importHeld' || req.type === 'unzip' || req.type === 'features';
    try {
      if (!stores && !reads) await load();
    } catch (err) {
      if (!stores) post({ type: 'error', id: req.id, message: messageOf(err) }, []);
      return;
    }
    try {
      const msg = await answer(req, occ, draco);
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
