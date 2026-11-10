// The things drawn on the plate that are not the design: a joint's or sensor's
// marker as solid strokes, and the arrows a selection or a marker is moved by.
import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { Vec3 } from '../model/types';
import { AXIS_COLORS, UP, axisVector } from './stage';
import type { Marker } from './types';

/**
 * A marker as solid strokes in its own frame, one unit = `MARKER_PIXELS` on
 * screen: a small X/Y/Z triad in the axis colors, then what the thing does in
 * the accent color. A joint's axis with a turn arrow about it (a ring for one
 * that turns freely), or arrowheads both ways for one that slides; a camera's
 * frustum with an "up" mark; a lidar's sweep as an arc with its edge rays; an
 * IMU as a box on a larger triad. Drawn as tubes and cones rather than lines,
 * which WebGL keeps one pixel wide.
 */
export function markerObject(mk: Marker, accent: number, dim = false): Group {
  const group = new Group();
  group.matrixAutoUpdate = false;
  const materials = new Map<string, MeshBasicMaterial>();
  const material = (color: string | number) => {
    const key = String(color);
    let m = materials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ color, transparent: true, opacity: dim ? 0.5 : 0.95, depthTest: false });
      materials.set(key, m);
    }
    return m;
  };
  const R = 0.028;
  const put = (geometry: BufferGeometry, color: string | number, at: Vec3, dir?: Vec3, spin?: number) => {
    const mesh = new Mesh(geometry, material(color));
    mesh.position.set(at[0], at[1], at[2]);
    if (dir) mesh.quaternion.setFromUnitVectors(UP, new Vector3(dir[0], dir[1], dir[2]).normalize());
    if (spin !== undefined) mesh.rotateZ(spin);
    mesh.renderOrder = 10;
    group.add(mesh);
  };
  const add = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const unit = (v: Vec3): Vec3 => {
    const n = Math.hypot(...v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  /** A rod from `a` to `b`. */
  const rod = (a: Vec3, b: Vec3, color: string | number, r = R) => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    if (len < 1e-6) return;
    put(new CylinderGeometry(r, r, len, 10), color, add(a, d, 0.5), d);
  };
  /** A cone whose point is at `tip`, pointing along `dir`. */
  const cone = (tip: Vec3, dir: Vec3, color: string | number, h = 0.2, r = 0.075) => {
    const d = unit(dir);
    put(new ConeGeometry(r, h, 14), color, add(tip, d, -h / 2), d);
  };
  /** The frame's axes with arrowheads; without Z when the axis drawn through the origin is already the Z. */
  const triad = (len: number, withZ = true) => {
    const ends: Vec3[] = [
      [len, 0, 0],
      [0, len, 0],
      [0, 0, len],
    ];
    ends.slice(0, withZ ? 3 : 2).forEach((end, i) => {
      rod([0, 0, 0], end, AXIS_COLORS[i]);
      cone(add(end, unit(end), 0.1), end, AXIS_COLORS[i], 0.12, 0.05);
    });
  };
  const cube = (h: number, color: string | number) => put(new BoxGeometry(2 * h, 2 * h, 2 * h), color, [0, 0, 0]);
  /** An arc about Z at height `z`, from angle `from` through `sweep` radians, counter-clockwise seen from +Z. The torus lies in XY as made; only its start is turned. */
  const arc = (radius: number, from: number, sweep: number, z: number, color: string | number) => {
    const torus = new TorusGeometry(radius, R, 8, Math.max(12, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 64)), Math.abs(sweep));
    put(torus, color, [0, 0, z], undefined, sweep < 0 ? from + sweep : from);
  };
  switch (mk.kind) {
    case 'joint': {
      if (mk.type === 'fixed') {
        triad(0.3);
        cube(0.14, accent);
        break;
      }
      triad(0.3, false);
      rod([0, 0, -1], [0, 0, 1], accent);
      if (mk.type === 'prismatic') {
        cone([0, 0, 1.12], [0, 0, 1], accent);
        cone([0, 0, -1.12], [0, 0, -1], accent);
      } else {
        // The positive turn, by the right hand about the axis: an open arc for a joint with limits, a ring for a wheel.
        const r = 0.6;
        const start = mk.type === 'continuous' ? -Math.PI / 2 : Math.PI / 6;
        const end = Math.PI * 1.5;
        arc(r, start, end - start, 0, accent);
        cone([r * Math.cos(end), r * Math.sin(end), 0], [-Math.sin(end), Math.cos(end), 0], accent, 0.22, 0.08);
      }
      break;
    }
    case 'camera': {
      triad(0.35);
      const hw = Math.min(Math.tan((Math.min(Math.max(mk.hfov, 10), 170) * Math.PI) / 360), 1.4);
      const hh = hw / Math.max(mk.aspect, 0.2);
      const face = (d: number) => {
        const c = [-1, 1].flatMap((y) => [-1, 1].map((z): Vec3 => [d, y * hw * d, z * hh * d]));
        rod(c[0], c[1], accent);
        rod(c[1], c[3], accent);
        rod(c[3], c[2], accent);
        rod(c[2], c[0], accent);
        return c;
      };
      for (const c of face(1)) rod([0, 0, 0], c, accent);
      // The picture's top, so that a camera held sideways shows.
      rod([1, -hw * 0.35, hh], [1, 0, hh + hw * 0.3], accent);
      rod([1, 0, hh + hw * 0.3], [1, hw * 0.35, hh], accent);
      if (mk.depth) face(0.55);
      break;
    }
    case 'lidar': {
      triad(0.35);
      const half = (Math.min(Math.max(mk.hfov, 1), 360) * Math.PI) / 360;
      arc(1, -half, 2 * half, 0, accent);
      rod([0, 0, 0], [1, 0, 0], accent);
      if (mk.hfov < 360) {
        rod([0, 0, 0], [Math.cos(half), Math.sin(half), 0], accent);
        rod([0, 0, 0], [Math.cos(half), -Math.sin(half), 0], accent);
      }
      break;
    }
    case 'imu':
      triad(0.45);
      cube(0.16, accent);
      break;
    case 'touch': {
      // A pad where the link meets things: a flat disc with a short stem. The disc lights up (full strength, its own material) while the pad is pressed.
      const pad = new Mesh(new CylinderGeometry(0.4, 0.4, 0.08, 24), new MeshBasicMaterial({ color: accent, transparent: true, opacity: dim ? 0.5 : 0.95, depthTest: false }));
      pad.position.set(0, 0, 0.04);
      pad.quaternion.setFromUnitVectors(UP, new Vector3(0, 0, 1));
      pad.userData.pad = true;
      pad.renderOrder = 10;
      group.add(pad);
      rod([0, 0, 0.08], [0, 0, 0.4], accent);
      break;
    }
  }
  // Unseen targets for the pointer: the axis of a picked joint, to slide it along; the whole of an unpicked marker, to pick it.
  if (dim) {
    const hit = new Mesh(new SphereGeometry(0.5, 8, 6), material(accent));
    hit.visible = false;
    hit.userData.pick = true;
    group.add(hit);
  } else if (mk.kind === 'joint' && mk.type !== 'fixed') {
    const hit = new Mesh(new CylinderGeometry(0.14, 0.14, 2.3, 8), material(accent));
    hit.quaternion.setFromUnitVectors(UP, new Vector3(0, 0, 1));
    hit.visible = false;
    hit.userData.slide = true;
    group.add(hit);
  }
  return group;
}

/** A touch marker's disc lit while its pad is pressed: solid, and half again as wide. */
export function lightPad(group: Group, pressed: boolean): void {
  for (const child of group.children) {
    if (!child.userData.pad || !(child instanceof Mesh)) continue;
    (child.material as MeshBasicMaterial).opacity = pressed ? 1 : 0.5;
    child.scale.setScalar(pressed ? 1.5 : 1);
  }
}

/** The pieces a move arrow of each length is made of, shared: a shaft, a head, and the fat unseen tube the pointer hits. Built up Y. */
const arrowParts = new Map<string, { shaft: CylinderGeometry; head: ConeGeometry; hit: CylinderGeometry }>();

/** How far a move arrow reaches, in units from where it is placed: its shaft from `from` to `to`, then the head. */
export interface ArrowReach {
  from: number;
  to: number;
}

/** The move arrows of a joint or sensor reach from here to here from its origin, in marker units, with the head on the end. */
export const MARKER_ARROW: ArrowReach = { from: 0.5, to: 1.45 };
/**
 * The move arrows of a selection stand out from the middle of its faces (+X, +Y and the top), a gap
 * first so that they keep clear of the grips there; shorter than a marker's, which start in the middle.
 */
export const SLIDE_ARROW: ArrowReach = { from: 0.4, to: 1.1 };
export const ARROW_HEAD = 0.3;

/** A move arrow along one of the design's axes in that axis's color, one unit = the pixel size it is laid out at. */
export function moveArrow(axis: 0 | 1 | 2, { from, to }: ArrowReach): Group {
  const key = `${from}:${to}`;
  let parts = arrowParts.get(key);
  if (!parts) {
    parts = {
      shaft: new CylinderGeometry(0.045, 0.045, to - from, 10),
      head: new ConeGeometry(0.12, ARROW_HEAD, 14),
      hit: new CylinderGeometry(0.18, 0.18, to + ARROW_HEAD - from + 0.1, 8),
    };
    arrowParts.set(key, parts);
  }
  const material = new MeshBasicMaterial({ color: AXIS_COLORS[axis], transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const arrow = new Group();
  arrow.userData.axis = axis;
  arrow.quaternion.setFromUnitVectors(UP, axisVector(axis));
  const shaft = new Mesh(parts.shaft, material);
  shaft.position.y = (from + to) / 2;
  const head = new Mesh(parts.head, material);
  head.position.y = to + ARROW_HEAD / 2;
  const hit = new Mesh(parts.hit, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  hit.position.y = (from + to + ARROW_HEAD) / 2;
  hit.userData.hit = true;
  for (const part of [shaft, head, hit]) {
    part.renderOrder = 13;
    arrow.add(part);
  }
  return arrow;
}

/** Frees what a marker was built from. */
export function disposeMarker(group: Group): void {
  for (const child of group.children) {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      (child.material as MeshBasicMaterial).dispose();
    }
  }
  group.clear();
}
