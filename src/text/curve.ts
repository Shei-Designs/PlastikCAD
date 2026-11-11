// Lettering that is not straight: bent round a cylinder, the way a label
// hugs a jar, or laid along an arc, the way a name goes round a dial. Both
// start from the flat lettering (its box w × h, letters along X, height up Y,
// extruded along Z with the reading face toward +Z) and move every point of
// it; the kernel does this to the mesh, and the editor uses the same sums to
// know the bent box before the mesh is back.
import { tr, trx } from '../i18n';
import type { Vec2, Vec3 } from '../model/types';

/**
 * How lettering is curved. `angle` is the degrees of a circle the lettering
 * spans, so the curve stays the same when the letters are scaled; the radius
 * follows from the width. `flip` turns the curve the other way: text bent to
 * read from inside a ring, or an arc that hangs instead of arching.
 * `thickness` is the lettering's depth in mm, kept here because the bent
 * box's depth includes the sag as well.
 */
export interface TextCurve {
  kind: 'bend' | 'arc';
  angle: number;
  flip: boolean;
  thickness: number;
}

export const CURVE_KINDS: { id: TextCurve['kind'] | 'none'; label: string; title: string }[] = [
  { id: 'none', label: trx('lettering', 'Straight'), title: tr('Lays the letters in a line.') },
  { id: 'bend', label: trx('lettering', 'Round'), title: tr('Bends the letters round a cylinder.') },
  { id: 'arc', label: tr('Arc'), title: tr('Lays the letters along an arc in their own plane.') },
];

/** Angles the curve can take: short of a full circle, where the ends would meet. */
export const MIN_CURVE_ANGLE = 5;
export const MAX_CURVE_ANGLE = 355;
export const clampAngle = (a: number): number => Math.max(MIN_CURVE_ANGLE, Math.min(MAX_CURVE_ANGLE, a));

/** The radius the lettering's back (bend) or baseline (arc) follows, for lettering `width` wide. */
export const curveRadius = (curve: TextCurve, width: number): number => width / ((clampAngle(curve.angle) * Math.PI) / 180);

/**
 * The move a point of the flat lettering makes. `flat` is the flat box (w, h)
 * and `thickness` the extrusion, in the same units as the points; the
 * lettering is centered on its box as the outlines are.
 */
export function textWarp(curve: TextCurve, flat: Vec2, thickness: number): (p: Vec3) => Vec3 {
  const [w, h] = flat;
  const r = curveRadius(curve, w);
  if (curve.kind === 'bend') {
    // Round a cylinder whose axis runs along the letters' height. The back face (z = -thickness/2) sits on
    // the cylinder at radius r; the letters stand outward from it, or inward when flipped, where the axis
    // lies on the reading side.
    return ([x, y, z]) => {
      const a = x / r;
      const rho = curve.flip ? r - (z + thickness / 2) : r + (z + thickness / 2);
      return curve.flip ? [rho * Math.sin(a), y, -rho * Math.cos(a)] : [rho * Math.sin(a), y, rho * Math.cos(a)];
    };
  }
  // Along an arc in the letters' own plane: the baseline (y = -h/2) follows a circle of radius r whose
  // centre lies below the letters (an arch), or above them when flipped (a hanging arc).
  return ([x, y, z]) => {
    const a = x / r;
    const rho = curve.flip ? r - (y + h / 2) : r + (y + h / 2);
    return curve.flip ? [rho * Math.sin(a), r - rho * Math.cos(a), z] : [rho * Math.sin(a), rho * Math.cos(a) - r, z];
  };
}

/**
 * The box round the curved lettering, before anything is built: the flat
 * box's edges are followed through the warp. Where the lettering is centred
 * is the kernel's business (it centres what it builds); only the size counts.
 */
export function curvedSize(curve: TextCurve, flat: Vec2, thickness: number): Vec3 {
  const warp = textWarp(curve, flat, thickness);
  const [w, h] = flat;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const steps = 720;
  for (let i = 0; i <= steps; i++) {
    const x = -w / 2 + (w * i) / steps;
    for (const y of [-h / 2, h / 2]) {
      for (const z of [-thickness / 2, thickness / 2]) {
        const p = warp([x, y, z]);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
      }
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** About the most triangles curved lettering is cut into, however tall it is and however far round it goes. */
export const CURVED_TRIANGLES = 300_000;

/**
 * How finely the mesh must be cut along the letters for the curve to read
 * smooth: about two degrees a step. With the `area` of the flat lettering's
 * surface, no finer than keeps it within `CURVED_TRIANGLES`: every edge is cut
 * to the step, which leaves triangles of about half its square.
 */
export const curveStep = (curve: TextCurve, width: number, area = 0): number =>
  Math.max((curveRadius(curve, width) * (2 * Math.PI)) / 180, 0.05, Math.sqrt((2 * area) / CURVED_TRIANGLES));
