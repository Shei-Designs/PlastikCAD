// What a response hands over to the main thread rather than copying: the
// buffers behind its meshes.
import type { MeshData } from '../geometry/mesh';
import type { WorkerResponse } from './protocol';

type View = { buffer: ArrayBufferLike } | undefined;

const meshViews = (mesh: MeshData | null): View[] => (mesh ? [mesh.positions, mesh.triangles] : []);

function viewsOf(msg: WorkerResponse): View[] {
  switch (msg.type) {
    case 'built':
      return [
        msg.result.render.positions,
        msg.result.render.normals,
        msg.result.render.uv,
        msg.result.faces?.source,
        msg.result.bvh.boxes,
        msg.result.bvh.nodes,
        msg.result.bvh.order,
        msg.result.edges,
      ];
    case 'imported':
      // The meshes travel as text; only the pictures that came with a model are arrays.
      return msg.result.kind === 'model' ? msg.result.parts.map((p) => p.image?.bytes) : [];
    case 'features':
      return [msg.result.regionOf, msg.result.normals];
    case 'exported':
      return [...meshViews(msg.result.mesh), msg.result.faces?.source, msg.result.uv];
    case 'exportedColored':
      return msg.result.objects.flatMap((o) => o.parts.flatMap((p) => meshViews(p.mesh)));
    case 'robotGeometry':
      return msg.result.flatMap((l) => [...l.visual.flatMap((p) => meshViews(p.mesh)), ...meshViews(l.collision)]);
    default:
      return [];
  }
}

/**
 * The buffers of a response's arrays, each named once: a list that names a
 * buffer twice is refused, and two parts of a result may be one mesh (an open
 * mesh that is its own collision shape).
 */
export function transferOf(msg: WorkerResponse): Transferable[] {
  const buffers = new Set<ArrayBufferLike>();
  for (const view of viewsOf(msg)) if (view) buffers.add(view.buffer);
  return [...buffers] as Transferable[];
}
