// Ported from Gearwright (src/geometry/evaluate.ts). Evaluates a Solid
// description with the Manifold kernel; `buildSolid` is what PlastikCAD's own
// kernel calls, the rest serves the generator tests.
import Module from 'manifold-3d';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Solid, Vec3 } from './types';

export interface MeshData {
  /** xyz per vertex, shared between triangles (indexed, watertight). */
  positions: Float32Array;
  triangles: Uint32Array;
}

export interface RenderMesh {
  /** Unindexed triangles (9 floats each); corners carry their own normal so sharp edges shade crisply. */
  positions: Float32Array;
  normals: Float32Array;
}

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
let loading: Promise<ManifoldToplevel> | null = null;

/** Load the WASM kernel. `wasmUrl` is only needed in the browser, where the bundler relocates the file. */
export function initKernel(wasmUrl?: string): Promise<ManifoldToplevel> {
  loading ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined).then((m) => {
    m.setup();
    kernel = m;
    return m;
  });
  return loading;
}

const SHARP_ANGLE = 30;

/**
 * Per-corner normals: each corner averages the faces around its vertex that
 * lie within `angle` degrees of its own face. Linear in the triangle count
 * (Manifold's calculateNormals takes seconds on finely twisted surfaces).
 */
export function creasedNormals(positions: Float32Array, triangles: Uint32Array, angle: number): RenderMesh {
  const nTri = triangles.length / 3;
  const nVert = positions.length / 3;
  // Face normals scaled by twice the face area, and their unit versions.
  const scaled = new Float32Array(nTri * 3);
  const unit = new Float32Array(nTri * 3);
  const first = new Uint32Array(nVert + 1);
  for (let t = 0; t < nTri; t++) {
    const a = triangles[t * 3] * 3;
    const b = triangles[t * 3 + 1] * 3;
    const c = triangles[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    scaled.set([nx, ny, nz], t * 3);
    unit.set([nx / len, ny / len, nz / len], t * 3);
    first[triangles[t * 3] + 1]++;
    first[triangles[t * 3 + 1] + 1]++;
    first[triangles[t * 3 + 2] + 1]++;
  }
  // Faces around each vertex, stored back to back.
  for (let v = 0; v < nVert; v++) first[v + 1] += first[v];
  const fill = first.slice(0, nVert);
  const around = new Uint32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) around[fill[triangles[t * 3 + k]]++] = t;

  const limit = Math.cos((angle * Math.PI) / 180);
  const outPositions = new Float32Array(nTri * 9);
  const outNormals = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const fx = unit[t * 3];
    const fy = unit[t * 3 + 1];
    const fz = unit[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = triangles[t * 3 + k];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = first[v]; i < first[v + 1]; i++) {
        const f = around[i] * 3;
        if (f === t * 3 || unit[f] * fx + unit[f + 1] * fy + unit[f + 2] * fz >= limit) {
          nx += scaled[f];
          ny += scaled[f + 1];
          nz += scaled[f + 2];
        }
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const o = t * 9 + k * 3;
      outPositions[o] = positions[v * 3];
      outPositions[o + 1] = positions[v * 3 + 1];
      outPositions[o + 2] = positions[v * 3 + 2];
      outNormals[o] = nx / len;
      outNormals[o + 1] = ny / len;
      outNormals[o + 2] = nz / len;
    }
  }
  return { positions: outPositions, normals: outNormals };
}

/** Turns a Solid description into a Manifold. Every kernel object made along the way is handed to `keep`. */
export function buildSolid(k: ManifoldToplevel, solid: Solid, keep: <T extends { delete(): void }>(o: T) => T): Manifold {
  const build = (s: Solid): Manifold => {
    switch (s.op) {
      case 'extrude': {
        const cs = keep(new k.CrossSection(s.shape, 'EvenOdd'));
        const twist = s.twist ?? 0;
        const divisions = s.divisions ?? (twist ? Math.ceil(Math.abs(twist) / 3) : 0);
        const scale = s.scaleTop ?? 1;
        // The scalar form of scaleTop is mishandled by the JS bindings; always pass a vector.
        return keep(cs.extrude(s.height, divisions, twist, [scale, scale]));
      }
      case 'revolve': {
        const cs = keep(new k.CrossSection([s.profile], 'EvenOdd'));
        return keep(cs.revolve(s.segments ?? 0));
      }
      case 'cylinder':
        return keep(k.Manifold.cylinder(s.height, s.radius, s.radiusTop ?? s.radius, s.segments ?? 0));
      case 'mesh': {
        const mesh = new k.Mesh({
          numProp: 3,
          vertProperties: Float32Array.from(s.positions),
          triVerts: Uint32Array.from(s.triangles),
        });
        mesh.merge();
        // Through the class behind `k.Manifold`: the wrapper throws on a mesh that is not manifold
        // without freeing the solid it made. Made this way it is kept, so it is freed with the rest.
        const Raw = Object.getPrototypeOf(k.Manifold.prototype).constructor as new (mesh: unknown) => Manifold;
        const made = keep(new Raw(mesh));
        const status = made.status();
        if (status !== 'NoError') throw new Error(`Geometry kernel error: ${status}`);
        return made;
      }
      case 'union':
        return keep(k.Manifold.union(s.children.map(build)));
      case 'intersection':
        return keep(k.Manifold.intersection(s.children.map(build)));
      case 'difference': {
        const [base, ...cutters] = s.children.map(build);
        if (cutters.length === 0) return base;
        return keep(base.subtract(cutters.length === 1 ? cutters[0] : keep(k.Manifold.union(cutters))));
      }
      case 'transform': {
        let m = build(s.child);
        if (s.mirror) m = keep(m.mirror(s.mirror));
        if (s.rotate) m = keep(m.rotate(s.rotate));
        if (s.translate) m = keep(m.translate(s.translate));
        return m;
      }
    }
  };
  return build(solid);
}

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
