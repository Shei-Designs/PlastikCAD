// Pipes and ducts: the pieces of a run that are awkward to model from boxes
// and cylinders, namely bends, tapers and branches. Each is a cross-section
// (round, or a rectangle with rounded corners) swept along a path, as a solid
// or as a wall around a bore. The sweep is lofted straight into a mesh, ring
// by ring, which keeps the geometry exact wherever the ring is: a bend is a
// true torus section, a taper a true frustum, an offset taper a true
// eccentric one.
import { tr, trx } from '../../i18n';
import { cross, scale, unit } from '../../model/math';
import { arcSegments, polar, TAU } from '../math2d';
import { difference, union } from '../types';
import type { Quality, Solid, Vec2, Vec3 } from '../types';
import { mm, num, str } from './types';
import type { BuildResult, GeneratorDef, ParamDef, ParamGroup, Params } from './types';

/** A cross-section in its own plane, CCW. */
type Ring = Vec2[];

interface Section {
  round: boolean;
  /** Outer width across the section's u axis (the bend plane) and height across v. */
  w: number;
  h: number;
  /** Corner radius of a rectangular section. */
  corner: number;
}

/** The outline of a section, with `n` points round a circle and `nc` per rounded corner. Always the same count for a given shape and quality. */
function ring(s: Section, n: number, nc: number): Ring {
  if (s.round) {
    const pts: Ring = [];
    for (let i = 0; i < n; i++) pts.push(polar(s.w / 2, (TAU * i) / n));
    return pts;
  }
  const r = Math.max(0, Math.min(s.corner, s.w / 2, s.h / 2));
  const pts: Ring = [];
  const cx = s.w / 2 - r;
  const cy = s.h / 2 - r;
  const corners: [number, number, number][] = [
    [cx, -cy, -Math.PI / 2],
    [cx, cy, 0],
    [-cx, cy, Math.PI / 2],
    [-cx, -cy, Math.PI],
  ];
  for (const [x, y, a0] of corners) {
    if (r === 0) {
      pts.push([x, y]);
      continue;
    }
    for (let k = 0; k <= nc; k++) pts.push(polar(r, a0 + (k / nc) * (Math.PI / 2), x, y));
  }
  return pts;
}

/** Shrink a section by a wall all round. */
const inner = (s: Section, wall: number): Section => ({ round: s.round, w: s.w - 2 * wall, h: s.h - 2 * wall, corner: Math.max(0, s.corner - wall) });

/** Where a ring goes: its center and the directions its u and v axes map to. */
interface Station {
  p: Vec3;
  u: Vec3;
  v: Vec3;
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/**
 * A closed mesh through the rings placed at the stations: quads between
 * neighbors, fans over the ends. The rings must all have the same number of
 * points and be star-shaped about their center (circles and rounded
 * rectangles are), and the triangles are turned to face outwards whichever
 * way the path runs.
 */
function loft(stations: Station[], rings: Ring[]): Solid {
  const n = rings[0].length;
  const positions: number[] = [];
  const triangles: number[] = [];
  const m = stations.length;
  for (let i = 0; i < m; i++) {
    const { p, u, v } = stations[i];
    for (const [a, b] of rings[i]) positions.push(p[0] + u[0] * a + v[0] * b, p[1] + u[1] * a + v[1] * b, p[2] + u[2] * a + v[2] * b);
  }
  const at = (i: number, j: number) => i * n + (j % n);
  for (let i = 0; i + 1 < m; i++)
    for (let j = 0; j < n; j++) triangles.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  // The end caps, fanned from the ring's center.
  const c0 = positions.length / 3;
  positions.push(...stations[0].p);
  const c1 = positions.length / 3;
  positions.push(...stations[m - 1].p);
  for (let j = 0; j < n; j++) triangles.push(c0, at(0, j), at(0, j + 1), c1, at(m - 1, j + 1), at(m - 1, j));
  // Signed volume tells which way round it came out.
  let vol = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t] * 3, triangles[t + 1] * 3, triangles[t + 2] * 3];
    vol +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (vol < 0) for (let t = 0; t < triangles.length; t += 3) [triangles[t + 1], triangles[t + 2]] = [triangles[t + 2], triangles[t + 1]];
  return { op: 'mesh', positions, triangles, swept: { stations, rings } };
}

/**
 * The same path carried on past its two ends, for a bore that must break through the end faces. An
 * end the path runs straight into is simply moved out; an end on a bend gets a short straight
 * stretch added before it instead, so that the bend stays the bend it is all the way to the face.
 */
function stretched(stations: Station[], by: number): Station[] {
  const same = (a: Vec3, b: Vec3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9;
  /** What stands for the end station `at`, whose neighbor along the path is `next`: itself moved out, or itself with one more beyond it. */
  const end = (at: Station, next: Station): Station[] => {
    const back = add(at.p, next.p, -1);
    if (same(at.u, next.u) && same(at.v, next.v)) return [{ ...at, p: add(at.p, unit(back), by) }];
    // Straight on through the face: along the section's own normal, away from the path.
    const normal = unit(cross(at.u, at.v));
    const away = back[0] * normal[0] + back[1] * normal[1] + back[2] * normal[2] >= 0 ? 1 : -1;
    return [{ ...at, p: add(at.p, normal, away * by) }, at];
  };
  const last = stations.length - 1;
  return [...end(stations[0], stations[1]), ...stations.slice(1, last), ...end(stations[last], stations[last - 1]).reverse()];
}

/** A sweep of one section along the stations: solid, or a wall around the same sweep of the inner section. */
function sweep(stations: Station[], outer: Section, wall: number, q: Quality, rings?: (s: Section) => Ring[]): Solid {
  const n = q.circle;
  const nc = Math.max(2, Math.round(q.circle / 16));
  // A ring for every station of the path it is for: the bore's path may have one more at either end.
  const of = (path: Station[], s: Section): Ring[] => (rings ? rings(s) : path.map(() => ring(s, n, nc)));
  const body = loft(stations, of(stations, outer));
  if (wall <= 0) return body;
  const bore = stretched(stations, 0.5);
  return difference(body, loft(bore, of(bore, inner(outer, wall))));
}

// --- parameters ----------------------------------------------------------------

const isRound = (p: Params) => str(p, 'section') !== 'rect';
const isRect = (p: Params) => !isRound(p);

function sectionGroup(): ParamGroup {
  return {
    title: tr('Section'),
    params: [
      {
        key: 'section',
        label: tr('Shape'),
        type: 'select',
        default: 'round',
        options: [
          { value: 'round', label: trx('section', 'Round') },
          { value: 'rect', label: tr('Rectangular') },
        ],
      },
      { key: 'diameter', label: tr('Diameter'), type: 'number', default: 25, min: 2, max: 400, step: 0.5, unit: 'mm', help: tr('Outside diameter.'), visible: isRound },
      { key: 'width', label: tr('Width'), type: 'number', default: 50, min: 2, max: 600, step: 0.5, unit: 'mm', help: tr('Outside width, across the plane of a bend.'), visible: isRect },
      { key: 'height', label: tr('Height'), type: 'number', default: 30, min: 2, max: 600, step: 0.5, unit: 'mm', help: tr('Outside height.'), visible: isRect },
      { key: 'corner', label: tr('Corner radius'), type: 'number', default: 5, min: 0, max: 100, step: 0.5, unit: 'mm', help: tr('Rounds the four corners. 0 for a sharp box.'), visible: isRect },
      { key: 'wall', label: tr('Wall'), type: 'number', default: 2, min: 0, max: 50, step: 0.1, unit: 'mm', help: tr('Sets the wall thickness. 0 makes the pipe solid.') },
    ],
  };
}

/** The section from the parameters; `suffix` picks the far end of a taper or the branch of a tee. */
function section(p: Params, suffix = ''): Section {
  const round = isRound(p);
  return {
    round,
    w: num(p, (round ? 'diameter' : 'width') + suffix),
    h: round ? num(p, 'diameter' + suffix) : num(p, 'height' + suffix),
    corner: round ? 0 : num(p, 'corner'),
  };
}

/** The wall, kept thinner than half the smallest side so that there is always a bore; says so when it had to be. */
function wallOf(p: Params, sections: Section[], warnings: string[]): number {
  const wall = num(p, 'wall');
  if (wall <= 0) return 0;
  const least = Math.min(...sections.map((s) => Math.min(s.w, s.h)));
  const most = least / 2 - 0.2;
  if (wall <= most) return wall;
  warnings.push(tr('The wall is as thick as the pipe: it was thinned to {wall} mm so that a bore is left.', { wall: most.toFixed(1) }));
  return most;
}

const sizeText = (s: Section) => (s.round ? `Ø${s.w.toFixed(1)}` : `${s.w.toFixed(1)} × ${s.h.toFixed(1)}`);

function sizeInfo(s: Section, wall: number): { label: string; value: string }[] {
  const out = [{ label: tr('Outside'), value: `${sizeText(s)} mm` }];
  if (wall > 0) out.push({ label: tr('Inside'), value: `${sizeText(inner(s, wall))} mm` });
  return out;
}

const Z: Vec3 = [0, 0, 1];
const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];

/** Stations along +Z from z0 to z1 (the section lies in XY). */
const along = (z0: number, z1: number): Station[] => [
  { p: [0, 0, z0], u: X, v: Y },
  { p: [0, 0, z1], u: X, v: Y },
];

// --- straight ------------------------------------------------------------------

export const pipe: GeneratorDef = {
  id: 'pipe',
  name: tr('Straight'),
  category: 'ducts',
  summary: tr('A length of pipe or duct, round or rectangular, hollow or solid.'),
  groups: [{ title: tr('Pipe'), params: [{ key: 'length', label: tr('Length'), type: 'number', default: 40, min: 1, max: 1000, step: 1, unit: 'mm' }] }, sectionGroup()],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const s = section(p);
    const wall = wallOf(p, [s], warnings);
    const length = num(p, 'length');
    return {
      solid: sweep(along(0, length), s, wall, q),
      info: [{ label: tr('Length'), value: mm(length, 1) }, ...sizeInfo(s, wall)],
      warnings,
    };
  },
};

// --- elbow ---------------------------------------------------------------------

export const elbow: GeneratorDef = {
  id: 'elbow',
  name: tr('Elbow'),
  category: 'ducts',
  summary: tr('A bend of any angle, with a straight leg either side.'),
  groups: [
    {
      title: tr('Bend'),
      params: [
        { key: 'angle', label: tr('Angle'), type: 'number', default: 90, min: 1, max: 180, step: 1, unit: '°', help: tr('How far the run turns. 90° is a square corner.') },
        { key: 'bendRadius', label: tr('Bend radius'), type: 'number', default: 30, min: 1, max: 500, step: 1, unit: 'mm', help: tr('Sets the bend radius along the center line.') },
        { key: 'legA', label: tr('Leg before'), type: 'number', default: 10, min: 0, max: 500, step: 1, unit: 'mm', help: tr('Straight length before the bend.') },
        { key: 'legB', label: tr('Leg after'), type: 'number', default: 10, min: 0, max: 500, step: 1, unit: 'mm', help: tr('Straight length after the bend.') },
      ],
    },
    sectionGroup(),
  ],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const s = section(p);
    const wall = wallOf(p, [s], warnings);
    const angle = (num(p, 'angle') * Math.PI) / 180;
    let radius = num(p, 'bendRadius');
    const least = s.w / 2 + 0.2;
    if (radius < least) {
      radius = least;
      warnings.push(tr('The bend radius was raised to {radius} mm, half the width, so that the inside of the bend does not fold over.', { radius: least.toFixed(1) }));
    }
    const legA = num(p, 'legA');
    const legB = num(p, 'legB');
    // Up +Z, then round towards +X about a center at (radius, 0, 0); the section's u axis stays in the bend plane.
    const stations: Station[] = [];
    if (legA > 0) stations.push({ p: [0, 0, -legA], u: X, v: Y });
    const steps = arcSegments(q, angle, 8);
    for (let i = 0; i <= steps; i++) {
      const a = (angle * i) / steps;
      stations.push({ p: [radius - radius * Math.cos(a), 0, radius * Math.sin(a)], u: [Math.cos(a), 0, -Math.sin(a)], v: Y });
    }
    if (legB > 0) {
      const end = stations[stations.length - 1];
      const t: Vec3 = [Math.sin(angle), 0, Math.cos(angle)];
      stations.push({ ...end, p: add(end.p, t, legB) });
    }
    return {
      solid: sweep(stations, s, wall, q),
      info: [
        { label: tr('Angle'), value: `${num(p, 'angle')}°` },
        { label: tr('Bend radius'), value: mm(radius, 1) },
        { label: tr('Inside radius'), value: mm(radius - s.w / 2, 1) },
        ...sizeInfo(s, wall),
      ],
      warnings,
    };
  },
};

// --- reducer -------------------------------------------------------------------

export const reducer: GeneratorDef = {
  id: 'reducer',
  name: tr('Reducer'),
  category: 'ducts',
  summary: tr('A taper from one size to another, in line or offset to one side.'),
  groups: [
    {
      title: tr('Taper'),
      params: [
        { key: 'length', label: tr('Length'), type: 'number', default: 40, min: 1, max: 1000, step: 1, unit: 'mm' },
        { key: 'diameter2', label: tr('Diameter at end'), type: 'number', default: 16, min: 2, max: 400, step: 0.5, unit: 'mm', visible: isRound },
        { key: 'width2', label: tr('Width at end'), type: 'number', default: 30, min: 2, max: 600, step: 0.5, unit: 'mm', visible: isRect },
        { key: 'height2', label: tr('Height at end'), type: 'number', default: 20, min: 2, max: 600, step: 0.5, unit: 'mm', visible: isRect },
        { key: 'offset', label: tr('Offset'), type: 'number', default: 0, min: -300, max: 300, step: 0.5, unit: 'mm', help: tr('Shifts the far end sideways for an eccentric reducer, so one side of the run stays flat.') },
      ],
    },
    sectionGroup(),
  ],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const a = section(p);
    const b = section(p, '2');
    const wall = wallOf(p, [a, b], warnings);
    const length = num(p, 'length');
    const offset = num(p, 'offset');
    const stations = along(0, length);
    const n = q.circle;
    const nc = Math.max(2, Math.round(q.circle / 16));
    // The two end rings differ in size (and the far one may be shifted); the loft between them is the taper.
    const rings = (s: Section): Ring[] => {
      const far = s === a ? b : inner(b, wall);
      return [ring(s, n, nc), ring(far, n, nc).map(([x, y]): Vec2 => [x + offset, y])];
    };
    const ratio = Math.max(a.w / b.w, b.w / a.w);
    return {
      solid: sweep(stations, a, wall, q, rings),
      info: [
        { label: tr('Length'), value: mm(length, 1) },
        { label: trx('pipe', 'Start'), value: `${sizeText(a)} mm` },
        { label: trx('pipe', 'End'), value: `${sizeText(b)} mm` },
        { label: tr('Ratio'), value: `${ratio.toFixed(2)} : 1` },
        ...(wall > 0 ? [{ label: tr('Inside'), value: tr('{from} to {to} mm', { from: sizeText(inner(a, wall)), to: sizeText(inner(b, wall)) }) }] : []),
      ],
      warnings,
    };
  },
};

// --- tee -----------------------------------------------------------------------

export const tee: GeneratorDef = {
  id: 'tee',
  name: tr('Tee'),
  category: 'ducts',
  summary: tr('A branch off a straight run, square or at an angle.'),
  groups: [
    {
      title: tr('Branch'),
      params: [
        { key: 'length', label: tr('Run length'), type: 'number', default: 60, min: 1, max: 1000, step: 1, unit: 'mm' },
        { key: 'branchAngle', label: tr('Branch angle'), type: 'number', default: 90, min: 20, max: 90, step: 1, unit: '°', help: tr('90° is a tee; less leans the branch along the run for a wye.') },
        { key: 'branchLength', label: tr('Branch length'), type: 'number', default: 25, min: 1, max: 500, step: 1, unit: 'mm', help: tr('From the side of the run to the end of the branch.') },
        { key: 'diameter2', label: tr('Branch diameter'), type: 'number', default: 25, min: 2, max: 400, step: 0.5, unit: 'mm', visible: isRound },
        { key: 'width2', label: tr('Branch width'), type: 'number', default: 50, min: 2, max: 600, step: 0.5, unit: 'mm', visible: isRect },
        { key: 'height2', label: tr('Branch height'), type: 'number', default: 30, min: 2, max: 600, step: 0.5, unit: 'mm', visible: isRect },
      ],
    },
    sectionGroup(),
  ],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const run = section(p);
    const branch = section(p, '2');
    const wall = wallOf(p, [run, branch], warnings);
    const length = num(p, 'length');
    const angle = (num(p, 'branchAngle') * Math.PI) / 180;
    // The run lies along X with its height up Z; the branch leaves the middle of it, rising towards +Z
    // and leaning along +X when the angle is less than square.
    const runStations: Station[] = [
      { p: [-length / 2, 0, 0], u: Y, v: Z },
      { p: [length / 2, 0, 0], u: Y, v: Z },
    ];
    const t: Vec3 = [Math.cos(angle), 0, Math.sin(angle)];
    const v = unit(cross(t, Y));
    const reach = run.h / 2 / Math.sin(angle) + num(p, 'branchLength');
    const branchStations: Station[] = [
      { p: [0, 0, 0], u: Y, v },
      { p: scale(t, reach), u: Y, v },
    ];
    const n = q.circle;
    const nc = Math.max(2, Math.round(q.circle / 16));
    const rings = (s: Section) => [ring(s, n, nc), ring(s, n, nc)];
    const outer = union(loft(runStations, rings(run)), loft(branchStations, rings(branch)));
    const solid =
      wall > 0
        ? difference(outer, loft(stretched(runStations, 0.5), rings(inner(run, wall))), loft(stretched(branchStations, 0.5), rings(inner(branch, wall))))
        : outer;
    return {
      solid,
      info: [
        { label: trx('pipe', 'Run'), value: `${sizeText(run)} × ${length.toFixed(1)} mm` },
        { label: tr('Branch'), value: tr('{size} mm at {angle}°', { size: sizeText(branch), angle: num(p, 'branchAngle') }) },
        ...(wall > 0 ? [{ label: tr('Inside'), value: `${sizeText(inner(run, wall))} / ${sizeText(inner(branch, wall))} mm` }] : []),
      ],
      warnings,
    };
  },
};

export const DUCTS: GeneratorDef[] = [pipe, elbow, reducer, tee];

/** For the tests: the parameters that give a section. */
export const sectionParams: ParamDef[] = sectionGroup().params;
