// What a link collides as when that is a plain shape: the box, cylinder or
// sphere fitted to the object, where it stands and turned as it is. The
// exports write it and the plate draws it from here, so that they agree.
import type { MeshData } from '../geometry/mesh';
import { apply, determinant, eulerOf, invert, multiply, rotation, tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { ownFrame } from './inertia';
import type { CollisionShape, RobotLink } from './types';

/** A box by its full size, a cylinder along its own Z, or a sphere; lengths in the unit of whoever asks. */
export type Primitive = { box: Vec3 } | { cylinder: { radius: number; length: number } } | { sphere: { radius: number } };

/** A primitive in the design: its center (mm) and its turn about X, Y and Z (degrees), as an object's are. */
export interface PlacedPrimitive {
  shape: Primitive;
  at: Vec3;
  rot: Vec3;
}

/** What of a link says how it collides. */
export type Collides = Pick<RobotLink, 'collision' | 'shape' | 'pieces'>;

/**
 * The primitive a link collides as, in mm. Fitted to the object unless the link has a shape of its own: the
 * object's box, a cylinder filling it along the axis it is round about (else its own Z), or a ball filling it. A shape of its own sits where
 * the link keeps it, in the object's own frame, and moves, turns and mirrors with the object.
 */
export function collisionPrimitive(node: SceneNode, link: Collides): PlacedPrimitive {
  const kind = link.collision;
  const size = link.shape?.size ?? node.size;
  // A fitted cylinder lies along the axis the object is round about; one that is round about none, or about Z, stands along its own Z.
  const along = kind === 'cylinder' && !link.shape ? roundAxis(size) : 2;
  const [a, b] = along === 0 ? [size[1], size[2]] : along === 1 ? [size[0], size[2]] : [size[0], size[1]];
  const shape: Primitive = kind === 'box' ? { box: [size[0], size[1], size[2]] } : kind === 'cylinder' ? { cylinder: { radius: Math.max(a, b) / 2, length: size[along] } } : { sphere: { radius: Math.max(...size) / 2 } };
  if (!link.shape) return { shape, at: node.pos, rot: along === 2 ? node.rot : eulerOf(multiply(rotation(node.rot), rotation(along === 0 ? [0, 90, 0] : [90, 0, 0]))) };
  const own = ownFrame(node);
  const turned = multiply(own, rotation(link.shape.rot));
  // A mirrored object's frame is left-handed, which no turn is: a box, a cylinder and a ball look the same with one axis the other way.
  if (determinant(turned) < 0) for (const i of [6, 7, 8]) turned[i] = -turned[i];
  return { shape, at: apply(own, link.shape.center), rot: eulerOf(turned) };
}

/** The axis a box of this size is round about: the one whose two other sizes are equal, Z when that is so of it or of none. */
function roundAxis(size: Vec3): 0 | 1 | 2 {
  const same = (p: number, q: number): boolean => Math.abs(p - q) <= 1e-6 * Math.max(p, q, 1);
  if (same(size[0], size[1])) return 2;
  if (same(size[1], size[2])) return 0;
  if (same(size[0], size[2])) return 1;
  return 2;
}

/** A primitive given in the design (its frame there, sizes in mm) as the shape a link keeps for itself, in the object's own frame. */
export function shapeInOwn(node: SceneNode, primitive: Primitive, frame: Mat): CollisionShape {
  const back = invert(ownFrame(node));
  const local = multiply(back, frame);
  if (determinant(local) < 0) for (const i of [6, 7, 8]) local[i] = -local[i];
  const size: Vec3 = 'box' in primitive ? primitive.box : 'cylinder' in primitive ? [2 * primitive.cylinder.radius, 2 * primitive.cylinder.radius, primitive.cylinder.length] : [2 * primitive.sphere.radius, 2 * primitive.sphere.radius, 2 * primitive.sphere.radius];
  return { size: tidyVec(size), center: tidyVec([local[9], local[10], local[11]]), rot: eulerOf(local) };
}

/** The shape a link collides as, in the object's own frame: the one it keeps, else the fitted one, for the boxes that show and change it. */
export function shapeOf(node: SceneNode, link: Collides): CollisionShape {
  if (link.shape) return link.shape;
  const fitted = collisionPrimitive(node, link);
  const frame = rotation(fitted.rot);
  frame[9] = fitted.at[0];
  frame[10] = fitted.at[1];
  frame[11] = fitted.at[2];
  return shapeInOwn(node, fitted.shape, frame);
}

/** How a cylinder is turned to lie along each of the object's own axes, degrees. */
const LAID: Vec3[] = [
  [0, 90, 0],
  [90, 0, 0],
  [0, 0, 0],
];

/** Which of the object's own axes a cylinder lies along: 0, 1 or 2, or -1 when it is turned some other way. */
export function cylinderAlong(shape: CollisionShape): number {
  const m = rotation(shape.rot);
  return [0, 1, 2].findIndex((k) => Math.abs(Math.abs(m[6 + k]) - 1) < 1e-6);
}

/**
 * The cylinder a link collides as, laid along one of the object's own axes. One that was typed keeps its
 * diameter, length and center; one still fitted to the object is fitted again that way: as long as the object's
 * box along the axis, as wide as the box across it.
 */
export function cylinderLaid(node: SceneNode, link: Collides, axis: 0 | 1 | 2): CollisionShape {
  if (link.shape) return { ...link.shape, rot: LAID[axis] };
  const box = shapeOf(node, { ...link, collision: 'box' });
  const across = Math.max(...box.size.filter((_, k) => k !== axis));
  return { size: tidyVec([across, across, box.size[axis]]), center: box.center, rot: LAID[axis] };
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
