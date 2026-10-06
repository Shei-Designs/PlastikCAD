// The basic shapes: what the catalog and the inspector show about each, and
// how each is built. Only the *types* of the Manifold kernel are imported
// here, so the UI can use this file without pulling the WASM kernel in; the
// worker passes the loaded kernel to `buildShape`.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { builtSize } from '../model/math';
import type { Polygon, ShapeKind, ShapeNode, Vec2, Vec3 } from '../model/types';

export interface ShapeParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  unit?: string;
  default: number;
  help?: string;
}

export interface ShapeDef {
  kind: ShapeKind;
  name: string;
  summary: string;
  defaultSize: Vec3;
  params: ShapeParamDef[];
  defaultColor: string;
}

const STEEL = '#8fa3bf';
const ORANGE = '#e8853a';
const GRAPHITE = '#535965';
const IVORY = '#e6e1d6';
const GREEN = '#5fa777';
const RED = '#d8605a';
const BLUE = '#5b8fd9';
const YELLOW = '#e5c04b';

/** The colours offered for nodes; the same set as the sibling app's materials. */
export const PALETTE: { name: string; value: string }[] = [
  { name: 'Steel', value: STEEL },
  { name: 'Orange', value: ORANGE },
  { name: 'Graphite', value: GRAPHITE },
  { name: 'Ivory', value: IVORY },
  { name: 'Green', value: GREEN },
  { name: 'Red', value: RED },
  { name: 'Blue', value: BLUE },
  { name: 'Yellow', value: YELLOW },
];

const TAU = Math.PI * 2;

/**
 * CCW regular polygon with a circumradius of 1 and one side facing -Y, so
 * that a square lies parallel to the axes, a triangle points towards +Y and a
 * hexagon has two corners on the X axis.
 */
export function regularPolygon(sides: number): Polygon {
  const pts: Polygon = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) * TAU) / sides;
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return pts;
}

/**
 * Width and depth of `regularPolygon(sides)`. Shapes are fitted to their box,
 * so a prism or pyramid is only regular when its x and y sizes are in this ratio.
 */
export function polygonExtent(sides: number): Vec2 {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of regularPolygon(sides)) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [maxX - minX, maxY - minY];
}

/** Footprint of a regular polygon whose larger extent is `across`, rounded to 1/10000 mm. */
function regularFootprint(sides: number, across: number): Vec2 {
  const [w, d] = polygonExtent(sides);
  const k = across / Math.max(w, d);
  return [Math.round(w * k * 1e4) / 1e4, Math.round(d * k * 1e4) / 1e4];
}

const sidesParam = (min: number, max: number, def: number, label = 'Sides', help?: string): ShapeParamDef => ({
  key: 'sides',
  label,
  min,
  max,
  step: 1,
  integer: true,
  default: def,
  help,
});

const ROUND_HELP = 'Number of flat faces around the shape. More is smoother, fewer is faster.';
const PRISM_SIDES = 6;

export const SHAPES: ShapeDef[] = [
  {
    kind: 'box',
    name: 'Box',
    summary: 'A block, optionally with rounded edges',
    defaultSize: [20, 20, 20],
    params: [
      {
        key: 'radius',
        label: 'Edge radius',
        min: 0,
        max: 500,
        step: 0.5,
        unit: 'mm',
        default: 0,
        help: 'Rounds every edge and corner. Limited to half the smallest side.',
      },
    ],
    defaultColor: STEEL,
  },
  {
    kind: 'cylinder',
    name: 'Cylinder',
    summary: 'A round bar or disc',
    defaultSize: [20, 20, 20],
    params: [sidesParam(3, 128, 64, 'Sides', ROUND_HELP)],
    defaultColor: ORANGE,
  },
  {
    kind: 'sphere',
    name: 'Sphere',
    summary: 'A ball; stretch it into an egg',
    defaultSize: [20, 20, 20],
    params: [sidesParam(8, 128, 48, 'Segments', 'Number of segments around the equator, in steps of four.')],
    defaultColor: BLUE,
  },
  {
    kind: 'cone',
    name: 'Cone',
    summary: 'A cone, or a tapered plug with a flat top',
    defaultSize: [20, 20, 20],
    params: [
      sidesParam(3, 128, 64, 'Sides', ROUND_HELP),
      {
        key: 'top',
        label: 'Top size',
        min: 0,
        max: 0.95,
        step: 0.05,
        default: 0,
        help: 'Width of the top as a fraction of the base. 0 gives a point.',
      },
    ],
    defaultColor: GREEN,
  },
  {
    kind: 'pyramid',
    name: 'Pyramid',
    summary: 'Flat sides rising to a point',
    defaultSize: [20, 20, 20],
    params: [sidesParam(3, 12, 4)],
    defaultColor: YELLOW,
  },
  {
    kind: 'wedge',
    name: 'Wedge',
    summary: 'A ramp: full height at one end, nothing at the other',
    defaultSize: [20, 20, 20],
    params: [],
    defaultColor: RED,
  },
  {
    kind: 'roof',
    name: 'Roof',
    summary: 'A triangular prism lying on its side',
    defaultSize: [20, 20, 20],
    params: [],
    defaultColor: IVORY,
  },
  {
    kind: 'prism',
    name: 'Prism',
    summary: 'A bar with a polygon cross-section, such as a hexagon',
    defaultSize: [...regularFootprint(PRISM_SIDES, 20), 20],
    params: [sidesParam(3, 12, PRISM_SIDES)],
    defaultColor: GREEN,
  },
  {
    kind: 'tube',
    name: 'Tube',
    summary: 'A pipe with a wall of constant thickness',
    defaultSize: [20, 20, 20],
    params: [
      {
        key: 'wall',
        label: 'Wall thickness',
        min: 0.2,
        max: 500,
        step: 0.1,
        unit: 'mm',
        default: 2,
        help: 'Stays the same however the tube is resized. Limited to just under half its width.',
      },
      sidesParam(3, 128, 64, 'Sides', ROUND_HELP),
    ],
    defaultColor: STEEL,
  },
  {
    kind: 'torus',
    name: 'Torus',
    summary: 'A ring; its height is the thickness of the ring',
    defaultSize: [30, 30, 8],
    params: [sidesParam(8, 128, 48, 'Segments', 'Number of segments around the ring.')],
    defaultColor: ORANGE,
  },
  {
    kind: 'dome',
    name: 'Dome',
    summary: 'Half a sphere, flat side down',
    defaultSize: [20, 20, 10],
    params: [sidesParam(8, 128, 48, 'Segments', 'Number of segments around the base, in steps of four.')],
    defaultColor: BLUE,
  },
];

export function shapeDef(kind: ShapeKind): ShapeDef {
  const def = SHAPES.find((s) => s.kind === kind);
  if (!def) throw new Error(`Unknown shape "${kind}"`);
  return def;
}

export function defaultParams(kind: ShapeKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of shapeDef(kind).params) out[p.key] = p.default;
  return out;
}

/** The part of a shape node that decides its form. */
export interface ShapeSpec {
  shape: ShapeKind;
  params: Record<string, number>;
  size: Vec3;
}

/** Share of a tube's smaller width that its wall may take up; just short of half, where the bore would close. */
const MAX_WALL = 0.49;

/** Largest value a parameter can usefully take for a shape of this size (some limits depend on the size). */
export function paramMax(kind: ShapeKind, key: string, size: Vec3): number {
  const def = shapeDef(kind).params.find((p) => p.key === key);
  if (!def) throw new Error(`Shape "${kind}" has no parameter "${key}"`);
  if (kind === 'box' && key === 'radius') return Math.min(def.max, Math.min(size[0], size[1], size[2]) / 2);
  if (kind === 'tube' && key === 'wall') return Math.min(def.max, Math.min(size[0], size[1]) * MAX_WALL);
  return def.max;
}

/** The node's parameters, completed with defaults and clamped to what is valid for its size. */
export function clampParams(node: ShapeSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of shapeDef(node.shape).params) {
    let v = node.params[p.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) v = p.default;
    if (p.integer) v = Math.round(v);
    // The size limit is applied last: on a very small tube it wins over the minimum wall.
    out[p.key] = Math.min(Math.max(v, p.min), paramMax(node.shape, p.key, node.size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builders

type Deletable = { delete(): void };

/** Takes ownership of a kernel object: whoever supplies this deletes what it is given. */
export type Keep = <T extends Deletable>(o: T) => T;

interface BuildContext {
  k: ManifoldToplevel;
  keep: Keep;
  /** Size to build at. */
  size: Vec3;
  /** Clamped parameters. */
  p: Record<string, number>;
}

/** Segments around the corner spheres of a rounded box: ten steps per quarter turn. */
const CORNER_SEGMENTS = 40;

// The builders stay away from the kernel's CrossSection class: the JS binding
// leaks WASM memory whenever polygons cross it (and a whole solid when
// extruding "centred"), which adds up for the shapes that are rebuilt on every
// step of a resize.

/** Regular polygon extruded along Z, tapering to `top` times its size; `fit` then sizes it to the box. */
function taper({ k, keep }: BuildContext, sides: number, top: number): Manifold {
  // The kernel starts its polygon with a corner on +X; turn it to match `regularPolygon`.
  return keep(keep(k.Manifold.cylinder(1, 1, top, sides)).rotate([0, 0, 180 / sides - 90]));
}

/** Solid from a closed mesh with outward-facing (CCW) triangles. */
function solid({ k, keep }: BuildContext, positions: Float32Array, triangles: number[]): Manifold {
  const mesh = new k.Mesh({ numProp: 3, vertProperties: positions, triVerts: Uint32Array.from(triangles) });
  return keep(new k.Manifold(mesh));
}

/** Solid with the convex CCW polygon `section` as its cross-section, from z0 up to z1. */
function prism(c: BuildContext, section: Polygon, z0: number, z1: number): Manifold {
  const n = section.length;
  const positions = new Float32Array(n * 6);
  const triangles: number[] = [];
  section.forEach(([x, y], i) => {
    positions.set([x, y, z0], i * 3);
    positions.set([x, y, z1], (n + i) * 3);
  });
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triangles.push(i, j, n + j, i, n + j, n + i);
    // Fans from the first corner: the bottom faces down, the top up.
    if (i >= 2) triangles.push(0, i, i - 1, n, n + i - 1, n + i);
  }
  return solid(c, positions, triangles);
}

/** Triangle given in the XZ plane, extruded along Y. */
function triangularPrism(c: BuildContext, triangle: Polygon): Manifold {
  // Made along Z, then stood up: the section's Y becomes Z.
  return c.keep(prism(c, triangle, -0.5, 0.5).rotate([90, 0, 0]));
}

/**
 * A convex CCW polygon with every side moved inwards by `d`. Sides that are
 * squeezed out disappear; the result is empty if nothing is left at all.
 */
export function inset(polygon: Polygon, d: number): Polygon {
  let out = polygon;
  for (let i = 0; i < polygon.length && out.length > 0; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    // Distance beyond this side's new position, measured along its inward normal.
    const inside = ([x, y]: Vec2) => ((x - ax) * (ay - by) + (y - ay) * (bx - ax)) / len - d;
    const kept: Polygon = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j];
      const q = out[(j + 1) % out.length];
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) kept.push(p);
      if (dp >= 0 !== dq >= 0) {
        const t = dp / (dp - dq);
        kept.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    out = kept;
  }
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const [x0, y0] = out[i];
    const [x1, y1] = out[(i + 1) % out.length];
    area += (x0 * y1 - x1 * y0) / 2;
  }
  return out.length >= 3 && area > 1e-9 ? out : [];
}

const BUILDERS: Record<ShapeKind, (c: BuildContext) => Manifold> = {
  box(c) {
    const { k, keep, size, p } = c;
    const r = p.radius;
    if (!(r > 0)) return keep(k.Manifold.cube(size, true));
    // Hull of a sphere in each corner. Where the radius takes up a whole side the corners coincide.
    const ball = keep(k.Manifold.sphere(r, CORNER_SEGMENTS));
    const offsets = size.map((s) => (s / 2 - r > 1e-9 ? [r - s / 2, s / 2 - r] : [0]));
    const corners: Manifold[] = [];
    for (const x of offsets[0]) {
      for (const y of offsets[1]) {
        for (const z of offsets[2]) corners.push(keep(ball.translate([x, y, z])));
      }
    }
    return corners.length === 1 ? corners[0] : keep(k.Manifold.hull(corners));
  },

  cylinder: (c) => taper(c, c.p.sides, 1),
  prism: (c) => taper(c, c.p.sides, 1),
  cone: (c) => taper(c, c.p.sides, c.p.top),
  pyramid: (c) => taper(c, c.p.sides, 0),

  sphere: ({ k, keep, p }) => keep(k.Manifold.sphere(0.5, p.sides)),

  // The kernel's sphere has a ring of vertices on the equator, so the cut adds no slivers.
  dome: ({ k, keep, p }) => keep(keep(k.Manifold.sphere(0.5, p.sides)).trimByPlane([0, 0, 1], 0)),

  wedge: (c) =>
    triangularPrism(c, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
    ]),

  roof: (c) =>
    triangularPrism(c, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0, 0.5],
    ]),

  tube(c) {
    const { keep, size, p } = c;
    const [w, d] = polygonExtent(p.sides);
    // Centred on its box rather than on its circumcentre, which differ when the number of sides is odd.
    const centreY = Math.cos(Math.PI / p.sides) - d / 2;
    const outline = regularPolygon(p.sides).map(([x, y]): Vec2 => [(x * size[0]) / w, ((y + centreY) * size[1]) / d]);
    const outer = prism(c, outline, -size[2] / 2, size[2] / 2);
    // A true inward offset, not a scaled copy: the wall is then `wall` thick all the way round,
    // also when the tube is oval or has few sides.
    const bore = inset(outline, p.wall);
    // The cutter pokes out at both ends so that no faces coincide.
    return bore.length === 0 ? outer : keep(outer.subtract(prism(c, bore, -size[2], size[2])));
  },

  torus(c) {
    const { size, p } = c;
    const r = size[2] / 2;
    // Radial half-width of the ring's section: round, unless the hole would close up - then it is
    // squeezed so that the hole just does.
    const a = Math.min(r, size[0] / 4);
    const centre = size[0] / 2 - a;
    const closed = centre - a < 1e-9;
    const rings = p.sides;
    const n = Math.max(8, Math.round(p.sides / 8) * 4);
    const positions = new Float32Array(rings * n * 3);
    for (let i = 0; i < rings; i++) {
      const turn = (i * TAU) / rings;
      for (let j = 0; j < n; j++) {
        const t = (j * TAU) / n;
        const radius = centre + a * Math.cos(t);
        positions.set([radius * Math.cos(turn), radius * Math.sin(turn), r * Math.sin(t)], (i * n + j) * 3);
      }
    }
    // Vertex j of ring i. With the hole closed the innermost vertices of all rings meet in the centre and are one.
    const at = (i: number, j: number) => (closed && j % n === n / 2 ? n / 2 : (i % rings) * n + (j % n));
    const triangles: number[] = [];
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < n; j++) {
        const [v0, v1, v2, v3] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        // Next to a closed hole the quad has shrunk to a triangle.
        if (v0 !== v1) triangles.push(v0, v1, v2);
        if (v2 !== v3) triangles.push(v0, v2, v3);
      }
    }
    return solid(c, positions, triangles);
  },
};

/** Stretches and moves a solid so that its bounding box is exactly `size`, centred on the origin. */
function fit(m: Manifold, size: Vec3, keep: Keep): Manifold {
  if (m.isEmpty()) throw new Error('This shape is empty.');
  const { min, max } = m.boundingBox();
  const s = size.map((v, i) => (max[i] - min[i] > 0 ? v / (max[i] - min[i]) : 1));
  const t = size.map((_, i) => (-(min[i] + max[i]) / 2) * s[i]);
  if (s.every((v) => v === 1) && t.every((v) => v === 0)) return m;
  return keep(m.transform([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, t[0], t[1], t[2], 1]));
}

/**
 * Builds a shape node at its built size (see `builtSize`), centred on the
 * origin. Everything made along the way, the result included, is handed to
 * `keep`; the caller deletes what it does not need.
 */
export function buildShape(k: ManifoldToplevel, node: ShapeNode, keep: Keep): Manifold {
  const size = builtSize(node);
  const p = clampParams(node);
  return fit(BUILDERS[node.shape]({ k, keep, size, p }), size, keep);
}
