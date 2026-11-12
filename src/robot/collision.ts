// What a link collides as when that is a plain shape: the box, cylinder or
// sphere fitted to the object, where it stands and turned as it is. The
// exports write it and the plate draws it from here, so that they agree.
import type { MeshData } from '../geometry/mesh';
import { apply, rotation } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import type { CollisionKind } from './types';

/** A box by its full size, a cylinder along its own Z, or a sphere; lengths in the unit of whoever asks. */
export type Primitive = { box: Vec3 } | { cylinder: { radius: number; length: number } } | { sphere: { radius: number } };

/** A primitive in the design: its center (mm) and its turn about X, Y and Z (degrees), as an object's are. */
export interface PlacedPrimitive {
  shape: Primitive;
  at: Vec3;
  rot: Vec3;
}

/** The primitive a link collides as, in mm: the object's own box, a cylinder filling it along its own Z, or a ball filling it. */
export function collisionPrimitive(node: SceneNode, kind: Extract<CollisionKind, 'box' | 'cylinder' | 'sphere'>): PlacedPrimitive {
  const size = node.size;
  const shape: Primitive = kind === 'box' ? { box: [size[0], size[1], size[2]] } : kind === 'cylinder' ? { cylinder: { radius: Math.max(size[0], size[1]) / 2, length: size[2] } } : { sphere: { radius: Math.max(...size) / 2 } };
  return { shape, at: node.pos, rot: node.rot };
}

/** A placed primitive as triangles in the design, for drawing. */
export function primitiveMesh(p: PlacedPrimitive): MeshData {
  const mesh = tessellate(p.shape);
  const m = rotation(p.rot);
  m[9] = p.at[0];
  m[10] = p.at[1];
  m[11] = p.at[2];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = apply(m, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    mesh.positions[i] = x;
    mesh.positions[i + 1] = y;
    mesh.positions[i + 2] = z;
  }
  return mesh;
}

/** A primitive as triangles, centered on its own origin and along its own axes. */
export function tessellate(g: Primitive): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  const push = (p: Vec3): number => {
    positions.push(p[0], p[1], p[2]);
    return positions.length / 3 - 1;
  };
  if ('box' in g) {
    const [w, d, h] = g.box.map((x) => x / 2);
    for (const z of [-h, h]) for (const y of [-d, d]) for (const x of [-w, w]) push([x, y, z]);
    triangles.push(0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 5, 0, 5, 4, 1, 3, 7, 1, 7, 5, 3, 2, 6, 3, 6, 7, 2, 0, 4, 2, 4, 6);
  } else if ('cylinder' in g) {
    const n = 32;
    const r = g.cylinder.radius;
    const h = g.cylinder.length / 2;
    const bottom = push([0, 0, -h]);
    const top = push([0, 0, h]);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      push([r * Math.cos(a), r * Math.sin(a), -h]);
      push([r * Math.cos(a), r * Math.sin(a), h]);
    }
    for (let i = 0; i < n; i++) {
      const b0 = 2 + 2 * i;
      const b1 = 2 + 2 * ((i + 1) % n);
      triangles.push(bottom, b1, b0, top, b0 + 1, b1 + 1, b0, b1, b1 + 1, b0, b1 + 1, b0 + 1);
    }
  } else {
    const rings = 16;
    const segments = 32;
    const r = g.sphere.radius;
    for (let i = 0; i <= rings; i++) {
      const phi = (Math.PI * i) / rings;
      for (let j = 0; j < segments; j++) {
        const theta = (2 * Math.PI * j) / segments;
        push([r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)]);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * segments + j;
        const b = i * segments + ((j + 1) % segments);
        const c = a + segments;
        const d = b + segments;
        if (i > 0) triangles.push(a, c, b);
        if (i < rings - 1) triangles.push(b, c, d);
      }
    }
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(triangles) };
}
