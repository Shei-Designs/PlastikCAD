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
  /** Shapes that exist to cut come in as holes. */
  hole?: boolean;
}

const STEEL = '#8fa3bf';
const ORANGE = '#e8853a';
const GRAPHITE = '#535965';
const IVORY = '#e6e1d6';
const GREEN = '#5fa777';
const RED = '#d8605a';
const BLUE = '#5b8fd9';
const YELLOW = '#e5c04b';

/**
 * The colors offered for nodes, muted enough that edges and shading still
 * read. Any other color can be picked by hand, from a twelfth swatch after
 * these: the inspector lays all twelve out in one row, so the count here goes
 * with the width of that panel (see .swatch-row in styles.css).
 */
export const PALETTE: { name: string; value: string }[] = [
  { name: 'Steel', value: STEEL },
  { name: 'Orange', value: ORANGE },
  { name: 'Graphite', value: GRAPHITE },
  { name: 'Ivory', value: IVORY },
  { name: 'Green', value: GREEN },
  { name: 'Red', value: RED },
  { name: 'Blue', value: BLUE },
  { name: 'Yellow', value: YELLOW },
  { name: 'White', value: '#f2f2f0' },
  { name: 'Black', value: '#2a2d33' },
  { name: 'Teal', value: '#3fa9a3' },
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
    summary: 'Block with optional rounded edges.',
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
    summary: 'Round bar or disc with optional rounded rims.',
    defaultSize: [20, 20, 20],
    params: [
      sidesParam(3, 128, 64, 'Sides', ROUND_HELP),
      {
        key: 'radius',
        label: 'Edge radius',
        min: 0,
        max: 500,
        step: 0.5,
        unit: 'mm',
        default: 0,
        help: 'Rounds the top and bottom rims. Limited to half the smallest side.',
      },
    ],
    defaultColor: ORANGE,
  },
  {
    kind: 'sphere',
    name: 'Sphere',
    summary: 'Ball or stretched ellipsoid.',
    defaultSize: [20, 20, 20],
    params: [sidesParam(8, 128, 48, 'Segments', 'Number of segments around the equator, in steps of four.')],
    defaultColor: BLUE,
  },
  {
    kind: 'cone',
    name: 'Cone',
    summary: 'Cone or tapered plug with a flat top.',
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
    summary: 'Pyramid with any number of sides.',
    defaultSize: [20, 20, 20],
    params: [sidesParam(3, 12, 4)],
    defaultColor: YELLOW,
  },
  {
    kind: 'wedge',
    name: 'Wedge',
    summary: 'Ramp sloping from full height to zero.',
    defaultSize: [20, 20, 20],
    params: [],
    defaultColor: RED,
  },
  {
    kind: 'roof',
    name: 'Roof',
    summary: 'Triangular prism lying on its side.',
    defaultSize: [20, 20, 20],
    params: [],
    defaultColor: IVORY,
  },
  {
    kind: 'roundroof',
    name: 'Round roof',
    summary: 'Half cylinder lying on its flat side.',
    defaultSize: [20, 20, 10],
    params: [sidesParam(2, 64, 32, 'Steps', 'Number of flat faces over the curve.')],
    defaultColor: ORANGE,
  },
  {
    kind: 'prism',
    name: 'Prism',
    summary: 'Bar with a polygon cross-section.',
    defaultSize: [...regularFootprint(PRISM_SIDES, 20), 20],
    params: [sidesParam(3, 12, PRISM_SIDES)],
    defaultColor: GREEN,
  },
  {
    kind: 'torus',
    name: 'Torus',
    summary: 'Ring with a round or flattened section.',
    defaultSize: [30, 30, 8],
    params: [
      sidesParam(8, 128, 48, 'Segments', 'Number of segments around the ring.'),
      {
        key: 'ring',
        label: 'Ring width',
        min: 0,
        max: 500,
        step: 0.5,
        unit: 'mm',
        default: 0,
        help: 'Sets the ring width from the hole to the outer rim. 0 gives a round cross-section.',
      },
    ],
    defaultColor: ORANGE,
  },
  {
    kind: 'dome',
    name: 'Dome',
    summary: 'Half sphere, flat side down.',
    defaultSize: [20, 20, 10],
    params: [sidesParam(8, 128, 48, 'Segments', 'Number of segments around the base, in steps of four.')],
    defaultColor: BLUE,
  },
  {
    kind: 'fillet',
    name: 'Fillet',
    summary: 'Edge cutter for rounding or chamfering as a hole.',
    defaultSize: [5, 20, 5],
    params: [sidesParam(1, 64, 16, 'Steps', 'Number of flat faces along the curve. One step cuts a straight chamfer.')],
    defaultColor: GRAPHITE,
    hole: true,
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

/** Largest value a parameter can usefully take for a shape of this size (some limits depend on the size). */
export function paramMax(kind: ShapeKind, key: string, size: Vec3): number {
  const def = shapeDef(kind).params.find((p) => p.key === key);
  if (!def) throw new Error(`Shape "${kind}" has no parameter "${key}"`);
  if ((kind === 'box' || kind === 'cylinder') && key === 'radius') return Math.min(def.max, Math.min(size[0], size[1], size[2]) / 2);
  if (kind === 'torus' && key === 'ring') return Math.min(def.max, Math.min(size[0], size[1]) / 2);
  return def.max;
}

/** The node's parameters, completed with defaults and clamped to what is valid for its size. */
export function clampParams(node: ShapeSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of shapeDef(node.shape).params) {
    let v = node.params[p.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) v = p.default;
    if (p.integer) v = Math.round(v);
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
/** Steps over the half turn of a rounded rim. */
const RIM_SEGMENTS = 20;

// The builders stay away from the kernel's CrossSection class: the JS binding
// leaks WASM memory whenever polygons cross it (and a whole solid when
// extruding "centered"), which adds up for the shapes that are rebuilt on every
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

/**
 * Solid with the CCW polygon `section` as its cross-section, from z0 up to z1.
 * The polygon must be convex, or at least visible in full from its first corner.
 */
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

/** Section given in the XZ plane (see `prism` for what it may look like), extruded along Y. */
function lyingPrism(c: BuildContext, section: Polygon): Manifold {
  // Made along Z, then laid down: the section's Y becomes Z.
  return c.keep(prism(c, section, -0.5, 0.5).rotate([90, 0, 0]));
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

  cylinder(c) {
    const { k, keep, size, p } = c;
    const r = p.radius;
    if (!(r > 0)) return taper(c, p.sides, 1);
    // Hull of a tube of radius r run round the rim, at the top and at the bottom. The tube follows
    // the ellipse r inside the outline, so the rounding is r everywhere even when the cylinder is
    // oval, and the result still fills its box exactly. The ellipse is stepped through by the
    // direction of its normal, not by angle: where the radius takes up a whole side it is flat (a
    // line, or a point), and the tube then has to go round its ends in every direction.
    const a = Math.max(size[0] / 2 - r, 0);
    const b = Math.max(size[1] / 2 - r, 0);
    const lift = Math.max(size[2] / 2 - r, 0);
    const points: Vec3[] = [];
    for (let i = 0; i < p.sides; i++) {
      const phi = (i * TAU) / p.sides;
      const nx = Math.cos(phi);
      const ny = Math.sin(phi);
      // The point of the ellipse whose outward normal points this way.
      const t = Math.atan2(b * ny, a * nx);
      const cx = a * Math.cos(t);
      const cy = b * Math.sin(t);
      for (let j = 0; j <= RIM_SEGMENTS; j++) {
        // Only the outer half of the tube can show; the rest is inside the hull anyway.
        const f = (j / RIM_SEGMENTS - 0.5) * Math.PI;
        const out = r * Math.cos(f);
        const up = r * Math.sin(f);
        points.push([cx + nx * out, cy + ny * out, lift + up], [cx + nx * out, cy + ny * out, -lift - up]);
      }
    }
    return keep(k.Manifold.hull(points));
  },
  prism: (c) => taper(c, c.p.sides, 1),
  cone: (c) => taper(c, c.p.sides, c.p.top),
  pyramid: (c) => taper(c, c.p.sides, 0),

  sphere: ({ k, keep, p }) => keep(k.Manifold.sphere(0.5, p.sides)),

  // The kernel's sphere has a ring of vertices on the equator, so the cut adds no slivers.
  dome: ({ k, keep, p }) => keep(keep(k.Manifold.sphere(0.5, p.sides)).trimByPlane([0, 0, 1], 0)),

  wedge: (c) =>
    lyingPrism(c, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
    ]),

  roof: (c) =>
    lyingPrism(c, [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0, 0.5],
    ]),

  roundroof(c) {
    const section: Polygon = [];
    for (let i = 0; i <= c.p.sides; i++) {
      const a = (i / c.p.sides) * Math.PI;
      section.push([Math.cos(a) / 2, Math.sin(a) - 0.5]);
    }
    return lyingPrism(c, section);
  },

  // What is left of a square bar when a quarter-round bar is taken out of it: the solid corner is
  // at +X +Z, and the hollow curve runs from the top at -X down to the bottom at +X.
  fillet(c) {
    const section: Polygon = [[0.5, 0.5]];
    for (let i = 0; i <= c.p.sides; i++) {
      const a = ((1 - i / c.p.sides) * Math.PI) / 2;
      section.push([Math.cos(a) - 0.5, Math.sin(a) - 0.5]);
    }
    return lyingPrism(c, section);
  },

  torus(c) {
    const { size, p } = c;
    const r = size[2] / 2;
    // Radial half-width of the ring's section: the ring width when one is set, else round, unless
    // the hole would close up - then it is squeezed so that the hole just does.
    const a = p.ring > 0 ? Math.min(p.ring / 2, size[0] / 4) : Math.min(r, size[0] / 4);
    const center = size[0] / 2 - a;
    const closed = center - a < 1e-9;
    const rings = p.sides;
    const n = Math.max(8, Math.round(p.sides / 8) * 4);
    const positions = new Float32Array(rings * n * 3);
    for (let i = 0; i < rings; i++) {
      const turn = (i * TAU) / rings;
      for (let j = 0; j < n; j++) {
        const t = (j * TAU) / n;
        const radius = center + a * Math.cos(t);
        positions.set([radius * Math.cos(turn), radius * Math.sin(turn), r * Math.sin(t)], (i * n + j) * 3);
      }
    }
    // Vertex j of ring i. With the hole closed the innermost vertices of all rings meet in the center and are one.
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

/** Stretches and moves a solid so that its bounding box is exactly `size`, centered on the origin. */
function fit(m: Manifold, size: Vec3, keep: Keep): Manifold {
  if (m.isEmpty()) throw new Error('This shape is empty.');
  const { min, max } = m.boundingBox();
  const s = size.map((v, i) => (max[i] - min[i] > 0 ? v / (max[i] - min[i]) : 1));
  const t = size.map((_, i) => (-(min[i] + max[i]) / 2) * s[i]);
  if (s.every((v) => v === 1) && t.every((v) => v === 0)) return m;
  return keep(m.transform([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, t[0], t[1], t[2], 1]));
}

/**
 * Builds a shape node at its built size (see `builtSize`), centered on the
 * origin. Everything made along the way, the result included, is handed to
 * `keep`; the caller deletes what it does not need.
 */
/**
 * Shapes whose side count is only there to approximate a curve. A prism or a
 * pyramid is its number of sides; these are round, and a cylinder with fewer
 * than this many sides was meant to be faceted too.
 */
const ROUND: Partial<Record<ShapeKind, number>> = { cylinder: 16, cone: 16, sphere: 8, dome: 8, torus: 8, roundroof: 8, fillet: 4 };

/** The parameters with twice the facets on every curve (up to 256), for an export at fine detail. */
export function refineParams(kind: ShapeKind, p: Record<string, number>): Record<string, number> {
  const least = ROUND[kind];
  if (least === undefined || p.sides < least) return p;
  return { ...p, sides: Math.min(256, p.sides * 2) };
}

export function buildShape(k: ManifoldToplevel, node: ShapeNode, keep: Keep, fine = false): Manifold {
  const size = builtSize(node);
  const p = fine ? refineParams(node.shape, clampParams(node)) : clampParams(node);
  return fit(BUILDERS[node.shape]({ k, keep, size, p }), size, keep);
}
