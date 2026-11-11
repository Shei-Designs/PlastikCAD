// Aluminum extrusion profiles: 20, 30 and 40 mm cells, V-slot or T-slot, in
// a row of up to four cells, one or two rows deep. Each size follows one
// maker's section drawing, the rest being close enough to it: OpenBuilds
// V-Slot for 20 mm, Misumi HFS6 for 30 mm and HFS8 for 40 mm. They share one
// anatomy, which is what this file builds:
//
//   - a skin with slotted lips on every outside face (a 45° V on the lip tips
//     of a V-slot, square lips on a T-slot);
//   - behind each lip, a channel that is wider than the opening, with straight
//     walls at first and then a 45° taper down to the flat top of the core;
//   - a square core round the bore in the middle of each cell;
//   - 45° webs from the core's corners to the solid corner blocks of the cell
//     (the taper of one slot and the taper of the next are the two sides of
//     one web);
//   - where two cells meet there is no slot and no corner block: the cores'
//     facing sides and the two webs frame one hollow that reaches the skin
//     through a short neck (the tall octagon of a 2040);
//   - where four cells meet, the hollows run into one open middle, with the
//     cores' corners rounded off; in a two-row bar of three or four cells the
//     inner cells' stacked cores are joined by walls flush with their sides.
//
// Every figure in the table below is read off a drawing; the sectional areas
// come out within a few percent of the catalog values.
import { tr } from '../../i18n';
import { arcSegments, circle, ensureCCW, polar, signedArea } from '../math2d';
import { difference, extrude, translate } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { bool, mm, num, str } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

/** Built this long; the object's height is then simply stretched to the length wanted, which a prism survives exactly. */
const STUB = 20;

export interface Size {
  label: string;
  /** Whose drawing the figures are read from. */
  source: string;
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
  /** Thickness of the 45° webs, and of the walls between inner cells. */
  web: number;
  /** Radius of the outer corners. */
  radius: number;
  /** The V on a V-slot's lip tips: a 45° chamfer this deep from the surface to a short flat tip. */
  chamfer: number;
  /**
   * The hollow between two cells, as V-Slot has it: a neck `neck` wide that runs `neckDepth` in
   * from the surface before opening at 45° onto the cores' sides. Without it the hollow is the
   * T-slot octagon, whose sides are the slot tapers moved over by a web.
   */
  neck?: { width: number; depth: number };
  /** A round hole in each corner block of the profile, this far in from both faces. */
  cornerHole?: { diameter: number; inset: number };
  /** A square hollow in each corner block of the profile, with rounded corners. */
  cornerCavity?: { size: number; inset: number; radius: number };
  /** Sectional area of the single-cell T-slot (V-slot for 20) from the catalog, for the tests. */
  catalogueArea: number;
}

export const SIZES: Record<string, Size> = {
  '20': {
    label: '20 mm (2020, 2040, 4040...)',
    source: 'OpenBuilds V-Slot 20',
    cell: 20,
    lip: 1.5,
    opening: 6,
    channel: 12,
    core: 9,
    bore: 5.5,
    web: 1.5,
    radius: 2,
    chamfer: 1.1,
    neck: { width: 4.6, depth: 3.7 },
    catalogueArea: 166,
  },
  '30': {
    label: '30 mm (3030, 3060, 6060...)',
    source: 'Misumi HFS6',
    cell: 30,
    lip: 2,
    opening: 8,
    channel: 16.5,
    core: 12,
    bore: 6.8,
    web: 2,
    radius: 2,
    chamfer: 1.6,
    cornerHole: { diameter: 4.2, inset: 3.4 },
    catalogueArea: 333,
  },
  '40': {
    label: '40 mm (4040, 4080...)',
    source: 'Misumi HFS8',
    cell: 40,
    lip: 5.5,
    opening: 10,
    channel: 20,
    core: 15,
    bore: 10.5,
    web: 2.5,
    radius: 3,
    chamfer: 2.5,
    cornerCavity: { size: 6, inset: 2, radius: 1 },
    catalogueArea: 640,
  },
};

const DIRS: Vec2[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const left = (d: Vec2): Vec2 => [-d[1], d[0]];

/** A square with rounded corners, CCW, centered on (cx, cy). */
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
  size: Size;
  /** Cells along and rows deep. */
  across: number;
  up: number;
  /** Sectional area. */
  area: number;
}

export function profile(p: Params, q: Quality): Profile {
  const size = SIZES[str(p, 'size')] ?? SIZES['20'];
  const across = Math.min(4, Math.max(1, Math.round(num(p, 'cells'))));
  const up = bool(p, 'double') ? 2 : 1;
  const { cell: C, lip, opening, channel, core, web } = size;
  const h = C / 2;
  // Depth of the core's flat top below the face, and half the web measured along a face.
  const cd = (C - core) / 2;
  const o = web / Math.SQRT2;
  // Where the straight channel wall ends and the 45° taper to the core begins.
  const ys = h - channel / 2 - o;
  const width = across * C;
  const height = up * C;
  const hw = width / 2;
  const hh = height / 2;
  const n = Math.max(16, Math.round(q.circle / 2));
  const cellX = (i: number) => -hw + (i + 0.5) * C;
  const cellY = (j: number) => -hh + (j + 0.5) * C;
  const chamfer = str(p, 'style') === 't' ? 0 : Math.min(size.chamfer, lip);
  const neck = size.neck;
  const a = opening / 2;

  const voids: Polygon[] = [];
  const mouths: Polygon[] = [];
  const bores: Polygon[] = [];
  const cavities: Polygon[] = [];

  for (let i = 0; i < across; i++) {
    for (let j = 0; j < up; j++) {
      const c: Vec2 = [cellX(i), cellY(j)];
      if (bool(p, 'bores')) bores.push(circle(size.bore / 2, n, c[0], c[1]));
      for (const d of DIRS) {
        const e = left(d);
        const outer = (d[0] < 0 && i === 0) || (d[0] > 0 && i === across - 1) || (d[1] < 0 && j === 0) || (d[1] > 0 && j === up - 1);
        // (u, v): along the face from the slot's center line, and depth in from the cell's edge.
        const at = (u: number, v: number): Vec2 => [c[0] + d[0] * (h - v) + e[0] * u, c[1] + d[1] * (h - v) + e[1] * u];
        if (outer) {
          // The channel behind the lip: straight walls, then the 45° taper onto the core's top.
          const wall = channel / 2;
          const floor = h - cd - o;
          voids.push(ensureCCW([at(-wall, lip), at(-wall, ys), at(-floor, cd), at(floor, cd), at(wall, ys), at(wall, lip)]));
          // The opening through the lip, from outside the surface to just inside the channel.
          const s = 0;
          const m = a + chamfer;
          mouths.push(
            ensureCCW([
              at(-m - 1, s - 1),
              at(-m, s),
              at(-a, s + chamfer),
              at(-a, lip + 0.5),
              at(a, lip + 0.5),
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
            // Where four cells meet the hollow simply runs on to the cores' corners and the open middle.
            // In a two-row bar, the inner cells' stacked cores are joined by a wall down each side
            // of the hollow between them, flush with the cores' faces.
            const walled = d[1] > 0 && up === 2 && i >= 1 && i <= across - 2;
            if (end === 'open') {
              const s0 = h - cd - (walled ? web : 0);
              return [at2(sign * s0, -cd), at2(sign * s0, cd)];
            }
            if (neck) {
              const nk = neck.width / 2;
              const s1 = h - neck.depth - cd + nk;
              const sn = h - neck.depth;
              return [at2(sign * s1, -cd), at2(sign * sn, -nk), at2(sign * (h - lip), -nk), at2(sign * (h - lip), nk), at2(sign * sn, nk), at2(sign * s1, cd)];
            }
            const s1 = h - cd - o;
            const flat = lip - o;
            if (flat <= 0) return [at2(sign * s1, -cd), at2(sign * (h - o), 0), at2(sign * s1, cd)];
            return [at2(sign * s1, -cd), at2(sign * (h - lip), -flat), at2(sign * (h - lip), flat), at2(sign * s1, cd)];
          };
          voids.push(ensureCCW([...half(1, ends[1]), ...half(-1, ends[0]).reverse()]));
        }
      }
    }
  }
  // Where four cells meet, the square between their cores is open, with the cores' corners
  // rounded off, except where a core's face runs on into one of those walls.
  const fr = web;
  const nf = Math.max(2, Math.round(n / 8));
  for (let i = 1; i < across; i++)
    for (let j = 1; j < up; j++) {
      const x = -hw + i * C;
      const y = -hh + j * C;
      voids.push([
        [x - cd, y - cd],
        [x + cd, y - cd],
        [x + cd, y + cd],
        [x - cd, y + cd],
      ]);
      const inner = (column: number) => up === 2 && column >= 1 && column <= across - 2;
      for (const [sx, sy] of [
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ]) {
        if (inner(sx > 0 ? i : i - 1)) continue;
        // The fillet: what an arc centered a radius into the core takes off its corner. It only
        // touches the open middle at the corner, so it is a polygon of its own, between the two
        // hollows that meet there.
        const qx = x + sx * (cd + fr);
        const qy = y + sy * (cd + fr);
        const towards = Math.atan2(-sy, -sx);
        const arc: Vec2[] = [];
        for (let k = 0; k <= nf; k++) arc.push(polar(fr, towards - Math.PI / 4 + (k / nf) * (Math.PI / 2), qx, qy));
        voids.push(ensureCCW([[x + sx * cd, y + sy * cd], ...arc]));
      }
    }
  // Holes or hollows in the four corner blocks.
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const cx = sx * hw;
      const cy = sy * hh;
      if (size.cornerHole) {
        const { diameter, inset } = size.cornerHole;
        cavities.push(circle(diameter / 2, n, cx - sx * inset, cy - sy * inset));
      }
      if (size.cornerCavity) {
        const { size: side, inset, radius } = size.cornerCavity;
        cavities.push(roundedSquare(side, radius, cx - sx * (inset + side / 2), cy - sy * (inset + side / 2), Math.max(2, Math.round(n / 8))));
      }
    }

  // The outside: rounded corners, and (unless `plain`) the opening of every slot notched through the lips.
  const R = size.radius;
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
      // The corner before this side: its arc is centered R in from the corner.
      const center: Vec2 = [from[0] - d[0] * R + e[0] * R, from[1] - d[1] * R + e[1] * R];
      const a0 = (k - 2) * (Math.PI / 2);
      for (let t = 0; t <= nr; t++) out.push(polar(R, a0 + (t / nr) * (Math.PI / 2), center[0], center[1]));
      if (plain) return;
      for (let kc = 0; kc < cells; kc++) {
        // The mouth profile around this cell's slot center: (u, v) along the side and in from the surface.
        const u0 = (kc + 0.5) * C;
        const m = a + chamfer;
        const depth = lip;
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
  return { outline, plain, voids, bores, cavities, mouths, width, height, size, across, up, area };
}

export const extrusion: GeneratorDef = {
  id: 'extrusion',
  name: tr('Aluminum rail'),
  category: 'frames',
  summary: tr('Slotted aluminum extrusion in standard profile sizes.'),
  groups: [
    {
      title: tr('Profile'),
      params: [
        {
          key: 'size',
          label: tr('Series'),
          type: 'select',
          default: '20',
          options: Object.entries(SIZES).map(([value, s]) => ({ value, label: s.label })),
          help: tr('Sets the size of one cell.'),
        },
        {
          key: 'style',
          label: tr('Slot'),
          type: 'select',
          default: 'v',
          options: [
            { value: 'v', label: 'V-slot' },
            { value: 't', label: 'T-slot' },
          ],
          help: tr('Selects the shape of the slot lips.'),
        },
        { key: 'cells', label: tr('Cells'), type: 'number', default: 1, min: 1, max: 4, step: 1, integer: true, help: tr('Sets the number of cells in a row.') },
        { key: 'double', label: tr('Two rows'), type: 'boolean', default: false, help: tr('Makes two rows of cells.') },
        { key: 'bores', label: tr('Center bores'), type: 'boolean', default: true, help: tr('Adds the hole down the middle of each cell.') },
      ],
    },
  ],
  build(p, q): BuildResult {
    const { plain, outline, voids, bores, cavities, mouths, width, height, size, across, up, area } = profile(p, q);
    // Through-cuts are a hair longer than the bar so that no faces coincide.
    const cut = (shape: Shape2D): Solid => translate(extrude(shape, STUB + 2), [0, 0, -1]);
    // The solid starts from the plain rounded square; the openings are cut with the rest.
    const cutters: Solid[] = [cut(voids), cut(mouths)];
    if (bores.length) cutters.push(cut(bores));
    if (cavities.length) cutters.push(cut(cavities));
    const solid = difference(extrude([plain], STUB), ...cutters);
    const warnings: string[] = [];
    if (signedArea(outline) <= 0) warnings.push(tr('The profile came out inside out; check the settings.'));
    const cd = (size.cell - size.core) / 2;
    const name = `${up * size.cell}${across * size.cell}`;
    return {
      solid,
      // For the picture and the SVG: even-odd contours. The hollows only ever touch, and each bore
      // and corner hole sits in solid metal, so the parity works out.
      outline: [outline, ...voids, ...bores, ...cavities],
      info: [
        { label: tr('Profile'), value: `${name}: ${Math.round(width)} × ${Math.round(height)} mm` },
        { label: tr('Slot'), value: tr('{kind}, {width} opening', { kind: str(p, 'style') === 't' ? 'T' : 'V', width: mm(size.opening, 1) }) },
        { label: tr('Slots'), value: String(2 * (across + up)) },
        { label: tr('Slot depth'), value: mm(cd) },
        { label: tr('Center bore'), value: bool(p, 'bores') ? mm(size.bore, 1) : tr('none') },
        { label: tr('Section'), value: `${Math.round(area)} mm²` },
      ],
      warnings,
    };
  },
};
