// Mass properties of a closed triangle mesh, by summing the tetrahedra each
// triangle makes with the origin (signed, so hollows and concavities come out
// right). Volume in mm³, area in mm², the centroid in mm, and the inertia
// per unit mass about the centroid in mm², which any uniform density scales
// to a tensor. Masses are in grams; `toSI` makes kg·m² for the exporters.
import type { MeshData } from '../geometry/mesh';
import { apply, flipSigns, invert, multiply, ownOrigin, rotation, scaling } from '../model/math';
import type { Mat } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import type { MassSpec } from './types';
import { materialOf } from './materials';

/** Symmetric 3×3, the six distinct entries: xx, yy, zz, xy, xz, yz. */
export type Tensor = [number, number, number, number, number, number];

export interface MeshProperties {
  /** mm³; 0 for a mesh with no volume (open, or flat). */
  volume: number;
  /** mm² of surface. */
  area: number;
  /** mm, from the mesh's origin. */
  centroid: Vec3;
  /** Inertia about the centroid per unit of mass (mm²): the tensor of a uniform solid is this times its mass. */
  unit: Tensor;
}

export function meshProperties(mesh: MeshData): MeshProperties {
  const { positions: p, triangles: t } = mesh;
  let volume = 0;
  let area = 0;
  const first: Vec3 = [0, 0, 0];
  // Second moments about the origin: ∫ x xᵀ dV, the six distinct entries.
  const c = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const d = t[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[d], cy = p[d + 1], cz = p[d + 2];
    // Signed volume of the tetrahedron with the origin: det / 6.
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const v = det / 6;
    volume += v;
    first[0] += (v * (ax + bx + cx)) / 4;
    first[1] += (v * (ay + by + cy)) / 4;
    first[2] += (v * (az + bz + cz)) / 4;
    // Covariance of a tetrahedron with one vertex at the origin: V/20 (Σ vᵢvᵢᵀ + s sᵀ), s = Σ vᵢ.
    const sx = ax + bx + cx;
    const sy = ay + by + cy;
    const sz = az + bz + cz;
    const w = v / 20;
    c[0] += w * (ax * ax + bx * bx + cx * cx + sx * sx);
    c[1] += w * (ay * ay + by * by + cy * cy + sy * sy);
    c[2] += w * (az * az + bz * bz + cz * cz + sz * sz);
    c[3] += w * (ax * ay + bx * by + cx * cy + sx * sy);
    c[4] += w * (ax * az + bx * bz + cx * cz + sx * sz);
    c[5] += w * (ay * az + by * bz + cy * cz + sy * sz);
    // Triangle area, half the cross product of two edges.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  if (!(Math.abs(volume) > 1e-9)) return { volume: 0, area, centroid: [0, 0, 0], unit: [0, 0, 0, 0, 0, 0] };
  // An inside-out mesh lists its triangles the other way round; the magnitudes are the same.
  const sign = volume < 0 ? -1 : 1;
  const g: Vec3 = [first[0] / volume, first[1] / volume, first[2] / volume];
  // Inertia about the origin from the second moments, then moved to the centroid (parallel axis theorem).
  const trace = c[0] + c[1] + c[2];
  const ixx = trace - c[0] - volume * (g[1] * g[1] + g[2] * g[2]);
  const iyy = trace - c[1] - volume * (g[0] * g[0] + g[2] * g[2]);
  const izz = trace - c[2] - volume * (g[0] * g[0] + g[1] * g[1]);
  const ixy = -c[3] + volume * g[0] * g[1];
  const ixz = -c[4] + volume * g[0] * g[2];
  const iyz = -c[5] + volume * g[1] * g[2];
  const unit: Tensor = [ixx / volume, iyy / volume, izz / volume, ixy / volume, ixz / volume, iyz / volume];
  return { volume: sign * volume, area, centroid: g, unit: unit.map((x) => x) as Tensor };
}

/**
 * Grams, from how the link's mass is known. A printed part is a solid shell
 * (`shell` mm thick all round, so about area × shell) with the inside filled
 * to `infill` percent; a solid material is just density × volume.
 */
export function massOf(spec: MassSpec, props: Pick<MeshProperties, 'volume' | 'area'>): number {
  if (spec.kind === 'measured') return spec.grams;
  const material = materialOf(spec.material);
  // g/cm³ → g/mm³.
  const density = material.density / 1000;
  if (!material.printed) return density * props.volume;
  const shell = Math.min(props.volume, props.area * Math.max(0, spec.shell));
  const filled = shell + (Math.min(100, Math.max(0, spec.infill)) / 100) * (props.volume - shell);
  return density * filled;
}

/** The tensor (g·mm²) of a uniform solid of this mass. */
export const tensorOf = (mass: number, unit: Tensor): Tensor => unit.map((x) => x * mass) as Tensor;

/**
 * The frame a link's typed figures are in: at the origin its file had, or the
 * middle of its box when it keeps none, along the object's own axes (mirrored
 * with it). A source that gives a link's center of mass and inertia gives
 * them from the point its mesh is measured from, which is this.
 */
export function ownFrame(node: SceneNode): Mat {
  const m = multiply(rotation(node.rot), scaling(flipSigns(node.flip)));
  const at = ownOrigin(node);
  m[9] = at[0];
  m[10] = at[1];
  m[11] = at[2];
  return m;
}

/** A tensor seen from another set of axes: M·I·Mᵀ, by the turning (and mirroring) part of `m`. */
export function turned(t: Tensor, m: Mat): Tensor {
  const i = [t[0], t[3], t[4], t[3], t[1], t[5], t[4], t[5], t[2]];
  // m is held by columns: entry (row, col) is m[col * 3 + row].
  const at = (row: number, col: number): number => {
    let sum = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += m[a * 3 + row] * i[a * 3 + b] * m[b * 3 + col];
    return sum;
  };
  return [at(0, 0), at(1, 1), at(2, 2), at(0, 1), at(0, 2), at(1, 2)];
}

export interface Inertial {
  /** Grams. */
  mass: number;
  /** The center of mass in the design (mm). */
  center: Vec3;
  /** g·mm² about the center of mass, along the design's axes. */
  inertia: Tensor;
  /** Whether the center and the inertia were typed rather than taken from the shape. */
  typed: { center: boolean; inertia: boolean };
}

/**
 * A link's mass, where its center is and its inertia about it, as it stands in
 * the design: the figures typed for a weighed link where it has them, the
 * shape's own (a uniform solid of that mass) where it has not.
 */
export function inertialOf(spec: MassSpec, node: SceneNode, props: MeshProperties): Inertial {
  const mass = massOf(spec, props);
  const frame = ownFrame(node);
  const center = spec.kind === 'measured' && spec.center ? apply(frame, spec.center) : props.centroid;
  const inertia = spec.kind === 'measured' && spec.inertia ? turned(spec.inertia, frame) : tensorOf(mass, props.unit);
  return { mass, center, inertia, typed: { center: spec.kind === 'measured' && Boolean(spec.center), inertia: spec.kind === 'measured' && Boolean(spec.inertia) } };
}

/** What `inertialOf` gives, as the object's own frame has it: the figures to show in the boxes, and to keep once one is typed. */
export function inertialInOwn(spec: MassSpec, node: SceneNode, props: MeshProperties): { center: Vec3; inertia: Tensor } {
  const { center, inertia } = inertialOf(spec, node, props);
  const back = invert(ownFrame(node));
  return { center: apply(back, center), inertia: turned(inertia, back) };
}

/** g·mm² → kg·m². */
export const toSI = (gmm2: number): number => gmm2 * 1e-9;

/** The principal moments of a symmetric tensor: its eigenvalues, in no particular order (closed form for 3×3). */
export function principalMoments(t: Tensor): Vec3 {
  const [a, b, c, d, e, f] = t;
  const p1 = d * d + e * e + f * f;
  if (p1 < 1e-18 * (a * a + b * b + c * c + 1e-300)) return [a, b, c];
  const q = (a + b + c) / 3;
  const p2 = (a - q) * (a - q) + (b - q) * (b - q) + (c - q) * (c - q) + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (A - qI) / p; r = det(B) / 2, clamped against rounding.
  const ba = (a - q) / p, bb = (b - q) / p, bc = (c - q) / p, bd = d / p, be = e / p, bf = f / p;
  const det = ba * (bb * bc - bf * bf) - bd * (bd * bc - bf * be) + be * (bd * bf - bb * be);
  const r = Math.min(1, Math.max(-1, det / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e1, 3 * q - e1 - e3, e3];
}

/**
 * Whether a tensor could belong to a real body: positive principal moments,
 * each no larger than the other two together. Simulators reject anything
 * else (or blow up on it).
 */
export function plausibleInertia(t: Tensor): boolean {
  const [x, y, z] = principalMoments(t);
  if (!(x > 0 && y > 0 && z > 0)) return false;
  const slack = 1e-6 * (x + y + z);
  return x + y + slack >= z && y + z + slack >= x && x + z + slack >= y;
}
