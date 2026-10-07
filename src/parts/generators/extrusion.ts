// Aluminium extrusion profiles, drawn from the makers' own section drawings:
// OpenBuilds V-Slot, Misumi HFS5 / HFS6 / HFS8 and 80/20's 20, 30 and 40
// series. They all share one anatomy, which is what this file builds:
//
//   - a skin with slotted lips on every outside face (a 45° V on the lip tips
//     of V-Slot, square lips on the T-slots);
//   - behind each lip, a channel that is wider than the opening, with straight
//     walls at first and then a 45° taper down to the flat top of the core;
//   - a square core round the bore in the middle of each cell;
//   - 45° webs from the core's corners to the solid corner blocks of the cell
//     (the taper of one slot and the taper of the next are the two sides of
//     one web);
//   - where two cells meet there is no slot and no corner block: the cores'
//     facing sides and the two webs frame one hollow that reaches the skin
//     through a short neck (the tall octagon of a 2040);
//   - where four cells meet, the four hollows run into one open cross, so a
//     4040 has nothing in its middle but the cores' corners.
//
// Every figure in the table below is read off a drawing; the sectional areas
// come out within a few percent of the catalogue values.
import { arcSegments, circle, ensureCCW, polar, signedArea } from '../math2d';
import { difference, extrude, translate } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { bool, mm, num, str } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

/** Built this long; the object's height is then simply stretched to the length wanted, which a prism survives exactly. */
const STUB = 20;

export interface Family {
  label: string;
  /** Catalogue names this covers, for the help text. */
  models: string;
  /** Cell size: the extrusion is a grid of these squares. */
  cell: number;
  /** Thickness of the lips, and of the faces between slots. */
  lip: number;
  /** Width of the slot opening between the lip tips. */
  opening: number;
  /** Width of the channel behind the lips. */
  channel: number;
  /** Side of the square core. The channel floor is the core's flat top. */
  core: number;
  /** Bore down the middle of each cell. */
  bore: number;
  /** Thickness of the 45° webs. */
  web: number;
  /** Radius of the outer corners. */
  radius: number;
  /**
   * V-Slot lips: a 45° chamfer `chamfer` deep from the surface to a short flat tip, and a
   * different hollow between cells: a neck `neck` wide that runs `neckDepth` in from the
   * surface before opening at 45° onto the cores' sides.
   */
  vslot?: { chamfer: number; neck: number; neckDepth: number };
  /** A round hole in each corner block of the profile, this far in from both faces. */
  cornerHole?: { diameter: number; inset: number };
  /** A square hollow in each corner block of the profile, with rounded corners. */
  cornerCavity?: { size: number; inset: number; radius: number };
  /** Sectional area of the single-cell profile from the catalogue, for the tests. */
  catalogueArea: number;
}

export const FAMILIES: Record<string, Family> = {
  vslot20: {
    label: 'OpenBuilds V-Slot 20',
    models: 'V-SLOT-2020, 2040, 4040',
    cell: 20,
    lip: 1.5,
    opening: 6,
    channel: 12,
    core: 9,
    bore: 5.5,
    web: 1.5,
    radius: 2,
    vslot: { chamfer: 1.1, neck: 4.6, neckDepth: 3.7 },
    catalogueArea: 165,
  },
  hfs5: {
    label: 'Misumi HFS5 (20 mm)',
    models: 'HFS5-2020, 2040, 4040',
    cell: 20,
    lip: 2,
    opening: 6,
    channel: 12,
    core: 8,
    bore: 4.2,
    web: 1.5,
    radius: 1,
    catalogueArea: 183,
  },
  tslot20: {
    label: '80/20 20 series',
    models: '20-2020, 2040, 4040',
    cell: 20,
    lip: 1.6,
    opening: 5.26,
    channel: 11.99,
    core: 7.32,
    bore: 4.19,
    web: 1.5,
    radius: 1,
    catalogueArea: 159,
  },
  hfs6: {
    label: 'Misumi HFS6 (30 mm)',
    models: 'HFS6-3030, 3060, 6060',
    cell: 30,
    lip: 2,
    opening: 8,
    channel: 16.5,
    core: 12,
    bore: 6.8,
    web: 2,
    radius: 2,
    cornerHole: { diameter: 4.2, inset: 3.4 },
    catalogueArea: 333,
  },
  tslot30: {
    label: '80/20 30 series',
    models: '30-3030, 3060, 6060',
    cell: 30,
    lip: 2.21,
    opening: 8.14,
    channel: 16.51,
    core: 11.64,
    bore: 6.65,
    web: 2.54,
    radius: 2,
    cornerCavity: { size: 4.2, inset: 1.33, radius: 0.5 },
    catalogueArea: 314,
  },
  hfs8: {
    label: 'Misumi HFS8 (40 mm)',
    models: 'HFS8-4040, 4080',
    cell: 40,
    lip: 5.5,
    opening: 10,
    channel: 20,
    core: 15,
    bore: 10.5,
    web: 2.5,
    radius: 3,
    cornerCavity: { size: 6, inset: 2, radius: 1 },
    catalogueArea: 640,
  },
  tslot40: {
    label: '80/20 40 series',
    models: '40-4040, 4080',
    cell: 40,
    lip: 4.32,
    opening: 8.13,
    channel: 20.57,
    core: 14.85,
    bore: 6.81,
    web: 4.32,
    radius: 3.5,
    catalogueArea: 874,
  },
};

const DIRS: Vec2[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const left = (d: Vec2): Vec2 => [-d[1], d[0]];

/** A square with rounded corners, CCW, centred on (cx, cy). */
function roundedSquare(size: number, r: number, cx: number, cy: number, n: number): Polygon {
  const h = size / 2;
  const pts: Vec2[] = [];
  const corners: Vec2[] = [
    [h - r, -(h - r)],
    [h - r, h - r],
    [-(h - r), h - r],
    [-(h - r), -(h - r)],
  ];
  corners.forEach(([x, y], i) => {
    const a0 = (i - 1) * (Math.PI / 2);
    for (let k = 0; k <= n; k++) pts.push(polar(r, a0 + (k / n) * (Math.PI / 2), cx + x, cy + y));
  });
  return pts;
}

export interface Profile {
  /** The outside, as drawn: rounded corners, with the slot openings notched through the lips. */
  outline: Polygon;
  /** The outside without the notches, for the solid (the openings are cut with `mouths`). */
  plain: Polygon;
  /** The slot channels, the hollows between cells and the open middles; they touch but never overlap. */
  voids: Polygon[];
  bores: Polygon[];
  /** Holes and hollows in the corner blocks. */
  cavities: Polygon[];
  /** The slot openings through the lips, for the solid (the outline already shows them). */
  mouths: Polygon[];
  width: number;
  height: number;
  family: Family;
  /** Sectional area, less the clearance. */
  area: number;
}

export function profile(p: Params, q: Quality): Profile {
  const family = FAMILIES[str(p, 'family')] ?? FAMILIES.vslot20;
  const across = Math.max(1, Math.round(num(p, 'across')));
  const up = Math.max(1, Math.round(num(p, 'up')));
  const cl = Math.max(0, num(p, 'clearance'));
  const { cell: C, lip, opening, channel, core, web } = family;
  const h = C / 2;
  // Depth of the core's flat top below the face, and half the web measured along a face.
  const cd = (C - core) / 2;
  const o = web / Math.SQRT2;
  // Where the straight channel wall ends and the 45° taper to the core begins.
  const ys = h - channel / 2 - o;
  const width = across * C + 2 * cl;
  const height = up * C + 2 * cl;
  const hw = width / 2;
  const hh = height / 2;
  const n = Math.max(16, Math.round(q.circle / 2));
  const cellX = (i: number) => -hw + cl + (i + 0.5) * C;
  const cellY = (j: number) => -hh + cl + (j + 0.5) * C;
  const vs = family.vslot;
  const chamfer = vs ? Math.min(vs.chamfer, lip) : 0;
  const a = Math.max(opening / 2 - cl, 0.5);

  const voids: Polygon[] = [];
  const mouths: Polygon[] = [];
  const bores: Polygon[] = [];
  const cavities: Polygon[] = [];

  for (let i = 0; i < across; i++) {
    for (let j = 0; j < up; j++) {
      const c: Vec2 = [cellX(i), cellY(j)];
      if (bool(p, 'bores')) bores.push(circle(family.bore / 2, n, c[0], c[1]));
      for (const d of DIRS) {
        const e = left(d);
        const outer = (d[0] < 0 && i === 0) || (d[0] > 0 && i === across - 1) || (d[1] < 0 && j === 0) || (d[1] > 0 && j === up - 1);
        // (u, v): along the face from the slot's centre line, and depth in from the cell's edge.
        const at = (u: number, v: number): Vec2 => [c[0] + d[0] * (h - v) + e[0] * u, c[1] + d[1] * (h - v) + e[1] * u];
        if (outer) {
          // The channel behind the lip: straight walls, then the 45° taper onto the core's top.
          // Clearance shrinks it all round, so that a printed tongue slides in.
          const wall = channel / 2 - cl;
          const floor = h - cd - o - cl;
          voids.push(ensureCCW([at(-wall, lip + cl), at(-wall, ys + cl), at(-floor, cd - cl), at(floor, cd - cl), at(wall, ys + cl), at(wall, lip + cl)]));
          // The opening through the lip, from outside the surface (which sits `cl` out) to just inside the channel.
          const s = -cl;
          const m = a + chamfer;
          mouths.push(
            ensureCCW([
              at(-m - 1, s - 1),
              at(-m, s),
              at(-a, s + chamfer),
              at(-a, lip + cl + 0.5),
              at(a, lip + cl + 0.5),
              at(a, s + chamfer),
              at(m, s),
              at(m + 1, s - 1),
            ]),
          );
        } else if (d[0] > 0 || d[1] > 0) {
          // The hollow between this cell and the next one along, built once from this side.
          // (s, r): along the shared edge from its midpoint, and across it.
          const mid: Vec2 = [c[0] + d[0] * h, c[1] + d[1] * h];
          const at2 = (s: number, r: number): Vec2 => [mid[0] + e[0] * s + d[0] * r, mid[1] + e[1] * s + d[1] * r];
          // Each end of the edge is either on the skin or shared by four cells.
          const ends = [-1, 1].map((sign) => {
            const gx = i + (d[0] > 0 ? 1 : 0) + (d[1] > 0 ? (e[0] * sign > 0 ? 1 : 0) : 0);
            const gy = j + (d[1] > 0 ? 1 : 0) + (d[0] > 0 ? (e[1] * sign > 0 ? 1 : 0) : 0);
            return gx === 0 || gx === across || gy === 0 || gy === up ? 'skin' : 'open';
          });
          const half = (sign: number, end: string): Vec2[] => {
            // From the near core's side (r = -cd) round to the far core's side (r = +cd), at this end.
            if (vs) {
              const nk = vs.neck / 2;
              const s1 = h - vs.neckDepth - cd + nk;
              if (end === 'skin') {
                const sn = h - vs.neckDepth;
                return [at2(sign * s1, -cd), at2(sign * sn, -nk), at2(sign * (h - lip), -nk), at2(sign * (h - lip), nk), at2(sign * sn, nk), at2(sign * s1, cd)];
              }
              const q = h - cd - s1;
              return [at2(sign * s1, -cd), at2(sign * (h - cd), -cd + q), at2(sign * (h - cd), cd - q), at2(sign * s1, cd)];
            }
            const s1 = h - cd - o;
            if (end === 'skin') {
              const flat = lip - o;
              if (flat <= 0) return [at2(sign * s1, -cd), at2(sign * (h - o), 0), at2(sign * s1, cd)];
              return [at2(sign * s1, -cd), at2(sign * (h - lip), -flat), at2(sign * (h - lip), flat), at2(sign * s1, cd)];
            }
            return [at2(sign * s1, -cd), at2(sign * (h - cd), -cd + o), at2(sign * (h - cd), cd - o), at2(sign * s1, cd)];
          };
          voids.push(ensureCCW([...half(1, ends[1]), ...half(-1, ends[0]).reverse()]));
        }
      }
    }
  }
  // Where four cells meet, the square between their cores is open.
  for (let i = 1; i < across; i++)
    for (let j = 1; j < up; j++) {
      const x = -hw + cl + i * C;
      const y = -hh + cl + j * C;
      voids.push([
        [x - cd, y - cd],
        [x + cd, y - cd],
        [x + cd, y + cd],
        [x - cd, y + cd],
      ]);
    }
  // Holes or hollows in the four corner blocks.
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const cx = sx * (hw - cl);
      const cy = sy * (hh - cl);
      if (family.cornerHole) {
        const { diameter, inset } = family.cornerHole;
        cavities.push(circle(diameter / 2, n, cx - sx * inset, cy - sy * inset));
      }
      if (family.cornerCavity) {
        const { size, inset, radius } = family.cornerCavity;
        cavities.push(roundedSquare(size, radius, cx - sx * (inset + size / 2), cy - sy * (inset + size / 2), Math.max(2, Math.round(n / 8))));
      }
    }

  // The outside: rounded corners, and (unless `plain`) the opening of every slot notched through the lips.
  const R = family.radius + cl;
  const nr = arcSegments(q, Math.PI / 2, 4);
  const sides: { d: Vec2; from: Vec2; cells: number }[] = [
    { d: [0, -1], from: [-hw, -hh], cells: across },
    { d: [1, 0], from: [hw, -hh], cells: up },
    { d: [0, 1], from: [hw, hh], cells: across },
    { d: [-1, 0], from: [-hw, hh], cells: up },
  ];
  const outside = (plain: boolean): Polygon => {
    const out: Polygon = [];
    sides.forEach(({ d, from, cells }, k) => {
      const e = left(d);
      // The corner before this side: its arc is centred R in from the corner.
      const centre: Vec2 = [from[0] - d[0] * R + e[0] * R, from[1] - d[1] * R + e[1] * R];
      const a0 = (k - 2) * (Math.PI / 2);
      for (let t = 0; t <= nr; t++) out.push(polar(R, a0 + (t / nr) * (Math.PI / 2), centre[0], centre[1]));
      if (plain) return;
      for (let kc = 0; kc < cells; kc++) {
        // The mouth profile around this cell's slot centre: (u, v) along the side and in from the surface.
        const u0 = cl + (kc + 0.5) * C;
        const m = a + chamfer;
        const depth = lip + 2 * cl;
        const pts: Vec2[] = [
          [-m, 0],
          [-a, chamfer],
          [-a, depth],
          [a, depth],
          [a, chamfer],
          [m, 0],
        ];
        for (const [u, v] of pts) out.push([from[0] + e[0] * (u0 + u) - d[0] * v, from[1] + e[1] * (u0 + u) - d[1] * v]);
      }
    });
    return out;
  };
  const outline = outside(false);
  const plain = outside(true);

  const polyArea = (polys: Polygon[]) => polys.reduce((s, poly) => s + Math.abs(signedArea(poly)), 0);
  const area = signedArea(outline) - polyArea(voids) - polyArea(bores) - polyArea(cavities);
  return { outline, plain, voids, bores, cavities, mouths, width, height, family, area };
}

export const extrusion: GeneratorDef = {
  id: 'extrusion',
  name: 'Aluminium extrusion',
  category: 'frames',
  summary:
    'Slotted aluminium profile to the makers’ drawings: OpenBuilds V-Slot, Misumi HFS and 80/20, in 20, 30 and 40 mm cells (2020, 2040, 4040, 3030, 3060, 4080...). Use it as a hole to cut the pocket a part slides onto; its height is its length.',
  groups: [
    {
      title: 'Profile',
      params: [
        {
          key: 'family',
          label: 'Standard',
          type: 'select',
          default: 'vslot20',
          options: Object.entries(FAMILIES).map(([value, f]) => ({ value, label: f.label })),
          help: 'Whose profile: the section follows that maker’s drawing, slot and bore included.',
        },
        { key: 'across', label: 'Cells across', type: 'number', default: 1, min: 1, max: 4, step: 1, integer: true, help: '2040 is one cell across and two up, or the other way round; 4040 of a 20 mm standard is two by two.' },
        { key: 'up', label: 'Cells up', type: 'number', default: 1, min: 1, max: 4, step: 1, integer: true },
      ],
    },
    {
      title: 'Fit',
      params: [
        { key: 'bores', label: 'Centre bores', type: 'boolean', default: true, help: 'The hole down the middle of each cell.' },
        {
          key: 'clearance',
          label: 'Clearance',
          type: 'number',
          default: 0,
          min: 0,
          max: 1,
          step: 0.05,
          unit: 'mm',
          help: 'Grows the outside and shrinks the slots by this much. Set it when the extrusion is a hole, so the printed part slides on.',
        },
      ],
    },
  ],
  build(p, q): BuildResult {
    const { outline, plain, voids, bores, cavities, mouths, width, height, family, area } = profile(p, q);
    const across = Math.max(1, Math.round(num(p, 'across')));
    const up = Math.max(1, Math.round(num(p, 'up')));
    const clearance = num(p, 'clearance');
    // Through-cuts are a hair longer than the bar so that no faces coincide.
    const cut = (shape: Shape2D): Solid => translate(extrude(shape, STUB + 2), [0, 0, -1]);
    // The solid starts from the plain rounded square; the openings are cut with the rest.
    const cutters: Solid[] = [cut(voids), cut(mouths)];
    if (bores.length) cutters.push(cut(bores));
    if (cavities.length) cutters.push(cut(cavities));
    const solid = difference(extrude([plain], STUB), ...cutters);
    const warnings: string[] = [];
    if (signedArea(outline) <= 0) warnings.push('The profile came out inside out; check the settings.');
    const cd = (family.cell - family.core) / 2;
    return {
      solid,
      // For the picture and the SVG: even-odd contours. The hollows only ever touch, and each bore
      // and corner hole sits in solid metal, so the parity works out.
      outline: [outline, ...voids, ...bores, ...cavities],
      info: [
        { label: 'Profile', value: `${Math.round(width - 2 * clearance)} × ${Math.round(height - 2 * clearance)} mm (${family.models})` },
        { label: 'Slot opening', value: mm(family.opening) },
        { label: 'Slots', value: String(2 * (across + up)) },
        { label: 'Slot depth', value: mm(cd) },
        { label: 'Centre bore', value: bool(p, 'bores') ? mm(family.bore, 1) : 'none' },
        { label: 'Section', value: `${Math.round(area)} mm²` },
      ],
      warnings,
    };
  },
};
