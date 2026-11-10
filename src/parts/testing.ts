// What the generator tests look at a part with: its Solid description built by
// the app's own kernel (see geometry/kernel), with its mesh and measurements.
import type { ManifoldToplevel } from 'manifold-3d';
import { initKernel as loadKernel } from '../geometry/kernel';
import { creasedNormals } from '../geometry/mesh';
import type { MeshData, RenderMesh } from '../geometry/mesh';
import { buildSolid } from './evaluate';
import type { Solid, Vec3 } from './types';

export interface MeshStats {
  volume: number;
  surfaceArea: number;
  triangles: number;
  min: Vec3;
  max: Vec3;
}

export interface EvalResult {
  mesh: MeshData;
  render: RenderMesh;
  stats: MeshStats;
}

let kernel: ManifoldToplevel | null = null;

/** Loads the kernel the app builds with, and keeps hold of it for `evaluate`. */
export async function initKernel(): Promise<ManifoldToplevel> {
  kernel = await loadKernel();
  return kernel;
}

const SHARP_ANGLE = 30;

export function evaluate(solid: Solid): EvalResult {
  if (!kernel) throw new Error('Geometry kernel is not initialized');
  const k = kernel;
  const garbage: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(o: T): T => {
    garbage.push(o);
    return o;
  };

  try {
    const result = buildSolid(k, solid, keep);
    const status = result.status();
    if (status !== 'NoError') throw new Error(`Geometry kernel error: ${status}`);
    if (result.isEmpty()) throw new Error('These parameters produce an empty shape.');

    const raw = result.getMesh();
    const positions =
      raw.numProp === 3
        ? raw.vertProperties.slice()
        : Float32Array.from({ length: (raw.vertProperties.length / raw.numProp) * 3 }, (_, i) => {
            return raw.vertProperties[Math.floor(i / 3) * raw.numProp + (i % 3)];
          });

    const triangles = raw.triVerts.slice();

    const box = result.boundingBox();
    return {
      mesh: { positions, triangles },
      render: creasedNormals(positions, triangles, SHARP_ANGLE),
      stats: {
        volume: result.volume(),
        surfaceArea: result.surfaceArea(),
        triangles: result.numTri(),
        min: [box.min[0], box.min[1], box.min[2]],
        max: [box.max[0], box.max[1], box.max[2]],
      },
    };
  } finally {
    for (const o of garbage) o.delete();
  }
}
