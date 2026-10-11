// Panel cutouts: the openings an enclosure wall needs that are worth looking
// up rather than drawing. A fan is its opening with its screw pattern; a
// connector that bolts to a panel is its cutout with its screw holes, as the
// maker draws them. (A dev board's sockets live with the board, in boards.ts,
// where they come placed on the board itself.) Each is a prism, grown by a
// clearance and long enough to pass through a wall: make it a hole and group
// it with the wall. Parts are made lying through a wall across Y, a case
// front, and can be turned to a side wall or the floor.
import { arc, circle } from '../math2d';
import { extrude, rotate, translate } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { bool, mm, num, str } from './types';
import type { BuildResult, GeneratorDef } from './types';

// --- 2D -------------------------------------------------------------------------------

/** A rectangular-ish opening: width across, height up, with its corners rounded. */
export interface Opening {
  w: number;
  h: number;
  /** Corner radius; half the smaller side makes a stadium, and a round hole is a square with that radius. */
  r: number;
  /** A trapezoid instead: the width of the narrower, lower edge. */
  bottom?: number;
}

/** CCW outline of an opening centered on (cx, cy), grown by `grow` all round. */
function outline(o: Opening, grow: number, q: Quality, cx = 0, cy = 0): Polygon {
  const w = o.w + 2 * grow;
  const h = o.h + 2 * grow;
  const r = Math.max(0, Math.min(o.r + grow, w / 2, h / 2));
  const n = Math.max(2, Math.round(q.circle / 4));
  if (o.bottom !== undefined) {
    // A D-sub style trapezoid: sloping sides, corners rounded with square arcs moved in.
    const bw = o.bottom + 2 * grow;
    const slope = Math.atan2((w - bw) / 2, h);
    return [
      ...arc(cx + w / 2 - r, cy + h / 2 - r, r, -slope, Math.PI / 2, n),
      ...arc(cx - w / 2 + r, cy + h / 2 - r, r, Math.PI / 2, Math.PI + slope, n),
      ...arc(cx - bw / 2 + r, cy - h / 2 + r, r, Math.PI + slope, 1.5 * Math.PI, n),
      ...arc(cx + bw / 2 - r, cy - h / 2 + r, r, 1.5 * Math.PI, 2 * Math.PI - slope, n),
    ];
  }
  if (r <= 0)
    return [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy - h / 2],
      [cx + w / 2, cy + h / 2],
      [cx - w / 2, cy + h / 2],
    ];
  return [
    ...arc(cx + w / 2 - r, cy - h / 2 + r, r, -Math.PI / 2, 0, n),
    ...arc(cx + w / 2 - r, cy + h / 2 - r, r, 0, Math.PI / 2, n),
    ...arc(cx - w / 2 + r, cy + h / 2 - r, r, Math.PI / 2, Math.PI, n),
    ...arc(cx - w / 2 + r, cy - h / 2 + r, r, Math.PI, 1.5 * Math.PI, n),
  ];
}

// --- shared parameters ---------------------------------------------------------------------

type Through = 'y' | 'x' | 'z';

const throughParam = {
  key: 'through',
  label: 'Through',
  type: 'select' as const,
  default: 'y',
  help: 'Which way the cut runs: through a wall that stands across Y (a case front), across X (a side), or through the floor or lid.',
  options: [
    { value: 'y', label: 'A wall across Y (front or back)' },
    { value: 'x', label: 'A wall across X (a side)' },
    { value: 'z', label: 'The floor or lid' },
  ],
};
const clearanceParam = { key: 'clearance', label: 'Clearance', type: 'number' as const, default: 0.3, min: 0, max: 3, step: 0.05, unit: 'mm', help: 'Added all round every opening and hole. 0.3 mm suits most printers; more for a loose fit.' };
const depthParam = { key: 'depth', label: 'Length', type: 'number' as const, default: 20, min: 1, max: 200, step: 0.5, unit: 'mm', help: 'How far the cut reaches: anything longer than the wall is thick.' };
const cutGroup = { title: 'Cut', params: [throughParam, depthParam] };

/** A prism of the shapes along Z, centered on the wall, laid through the chosen wall. */
function prism(shapes: Shape2D, depth: number, through: Through): Solid {
  const solid = translate(extrude(shapes, depth), [0, 0, -depth / 2]);
  if (through === 'z') return solid;
  // Stand the opening up (its height along Z), then turn it to face along X for a side wall.
  return rotate(solid, through === 'y' ? [90, 0, 0] : [90, 0, 90]);
}

const sizeText = (w: number, h: number) => `${w.toFixed(2)} × ${h.toFixed(2)} mm`;

// --- panel connectors ------------------------------------------------------------------------

export interface PanelConnector {
  id: string;
  label: string;
  cutout: Opening;
  /** A second, wider and lower opening across the first: the stepped cutout of a C8 inlet. */
  wings?: { w: number; h: number };
  /**
   * Screw holes: diameter and their center spacing across (two side by side), up (two above and
   * below), both (four at the corners), or diagonal (two at opposite corners of an across × up box).
   */
  holes?: { d: number; across?: number; up?: number; diagonal?: boolean };
  note?: string;
}

/** A round hole as an opening. */
const round = (d: number): Opening => ({ w: d, h: d, r: d / 2 });

/** A cross of two rectangles, the main one tall and the wings wide and low, as one CCW polygon. */
function stepped(main: Opening, wings: { w: number; h: number }, grow: number): Polygon {
  const a = main.w / 2 + grow;
  const b = main.h / 2 + grow;
  const c = wings.w / 2 + grow;
  const d = wings.h / 2 + grow;
  return [
    [-a, -b],
    [a, -b],
    [a, -d],
    [c, -d],
    [c, d],
    [a, d],
    [a, b],
    [-a, b],
    [-a, d],
    [-c, d],
    [-c, -d],
    [-a, -d],
  ];
}

// Only connectors whose cutout has some geometry to it: screw holes, a D shape, a step. A plain
// rectangle for a snap-in part is quicker drawn by hand. Figures are the makers' own: Neutrik's
// D-series drawings, Schurter 6100-3 / 6600-3 and Qualtek 771W for the IEC parts, Norcomp's D-sub
// panel cut-outs, Amass's XT60E sheet.
export const PANEL_CONNECTORS: PanelConnector[] = [
  { id: 'neutrik-d', label: 'Neutrik D-series (XLR, powerCON, etherCON, USB)', cutout: round(24), holes: { d: 3.2, across: 19, up: 24, diagonal: true }, note: 'The one D-size hole all the D-series chassis connectors share: Ø24 with two M3 holes at opposite corners.' },
  { id: 'iec-c14', label: 'IEC C14 inlet, screw flange', cutout: { w: 28, h: 20, r: 3 }, holes: { d: 3.5, across: 40 }, note: 'Schurter 6100 and Qualtek 703W both fit; the panel can be up to 8 mm.' },
  { id: 'iec-c13', label: 'IEC C13 outlet, screw flange', cutout: { w: 32.5, h: 24.8, r: 4 }, holes: { d: 3.5, across: 40 } },
  { id: 'iec-c8', label: 'IEC C8 inlet, snap-in', cutout: { w: 19.5, h: 12.5, r: 0 }, wings: { w: 24.5, h: 7.5 }, note: 'Snaps into a 0.6 to 1.5 mm panel (Qualtek 771W); the wider, lower wings take its catches.' },
  { id: 'db9', label: 'D-sub 9 (DE-9)', cutout: { w: 20.7, h: 11.68, r: 2.4, bottom: 15.9 }, holes: { d: 3.1, across: 24.99 } },
  { id: 'db15', label: 'D-sub 15 (DA-15)', cutout: { w: 29, h: 11.68, r: 2.4, bottom: 24.2 }, holes: { d: 3.1, across: 33.32 } },
  { id: 'db25', label: 'D-sub 25 (DB-25)', cutout: { w: 42.8, h: 11.68, r: 2.4, bottom: 38 }, holes: { d: 3.1, across: 47.04 } },
  { id: 'xt60', label: 'XT60 panel mount (XT60E)', cutout: { w: 15.5, h: 8.1, r: 1 }, holes: { d: 3.2, across: 20 } },
];

function holeShapes(h: NonNullable<PanelConnector['holes']>, grow: number, q: Quality): { at: Vec2[]; shapes: Polygon[] } {
  const at: Vec2[] = [];
  if (h.diagonal && h.across !== undefined && h.up !== undefined) at.push([-h.across / 2, h.up / 2], [h.across / 2, -h.up / 2]);
  else if (h.across !== undefined && h.up !== undefined) for (const sx of [-1, 1]) for (const sy of [-1, 1]) at.push([(sx * h.across) / 2, (sy * h.up) / 2]);
  else if (h.across !== undefined) for (const sx of [-1, 1]) at.push([(sx * h.across) / 2, 0]);
  else if (h.up !== undefined) for (const sy of [-1, 1]) at.push([0, (sy * h.up) / 2]);
  return { at, shapes: at.map(([x, y]) => circle((h.d + 2 * grow) / 2, q.circle, x, y)) };
}

export const panelConnector: GeneratorDef = {
  id: 'panel-connector',
  name: 'Panel connector',
  category: 'cutouts',
  summary: 'The cutout and screw holes for a connector that bolts to a panel: Neutrik D-series, IEC mains, D-sub, XT60.',
  groups: [
    {
      title: 'Connector',
      params: [
        { key: 'connector', label: 'Connector', type: 'select', default: 'neutrik-d', options: PANEL_CONNECTORS.map((c) => ({ value: c.id, label: c.label })) },
        clearanceParam,
        { key: 'holes', label: 'Screw holes', type: 'boolean', default: true, visible: (p) => Boolean(PANEL_CONNECTORS.find((c) => c.id === str(p, 'connector'))?.holes) },
      ],
    },
    cutGroup,
  ],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const c = PANEL_CONNECTORS.find((x) => x.id === str(p, 'connector')) ?? PANEL_CONNECTORS[0];
    const grow = num(p, 'clearance');
    const depth = num(p, 'depth');
    const shapes: Shape2D = [c.wings ? stepped(c.cutout, c.wings, grow) : outline(c.cutout, grow, q)];
    if (c.holes && bool(p, 'holes')) shapes.push(...holeShapes(c.holes, grow, q).shapes);
    if (c.note) warnings.push(c.note);
    const info = [
      { label: 'Cutout', value: sizeText((c.wings ? Math.max(c.wings.w, c.cutout.w) : c.cutout.w) + 2 * grow, c.cutout.h + 2 * grow) },
      { label: 'Nominal', value: sizeText(c.cutout.w, c.cutout.h) },
      ...(c.holes ? [{ label: 'Holes', value: `${holeShapes(c.holes, 0, q).at.length} × Ø${c.holes.d} mm, ${[c.holes.across && `${c.holes.across} mm across`, c.holes.up && `${c.holes.up} mm up`].filter(Boolean).join(c.holes.diagonal ? ' and ' : ', ')}${c.holes.diagonal ? ', at opposite corners' : ''}` }] : []),
      { label: 'Length', value: mm(depth, 1) },
    ];
    return { solid: prism(shapes, depth, str(p, 'through') as Through), outline: shapes, info, warnings };
  },
};

// --- fans ------------------------------------------------------------------------------------

export interface Fan {
  size: number;
  /** Screw hole center spacing (square pattern) and hole diameter. */
  spacing: number;
  hole: number;
  /** Opening diameter, a little under the frame. */
  opening: number;
}

// Hole patterns from Delta's and Sunon's drawings and Noctua's spec; the opening is the frame less 2 mm.
export const FANS: Fan[] = [
  { size: 25, spacing: 20, hole: 2.8, opening: 23 },
  { size: 30, spacing: 24, hole: 3.2, opening: 28 },
  { size: 40, spacing: 32, hole: 3.5, opening: 38 },
  { size: 50, spacing: 40, hole: 4.3, opening: 48 },
  { size: 60, spacing: 50, hole: 4.5, opening: 58 },
  { size: 70, spacing: 61.5, hole: 4.3, opening: 68 },
  { size: 80, spacing: 71.5, hole: 4.5, opening: 78 },
  { size: 92, spacing: 82.5, hole: 4.5, opening: 90 },
  { size: 120, spacing: 105, hole: 4.5, opening: 118 },
  { size: 140, spacing: 124.5, hole: 4.5, opening: 138 },
];

export const fan: GeneratorDef = {
  id: 'fan-cutout',
  name: 'Fan',
  category: 'cutouts',
  summary: 'The round opening and four screw holes for an axial fan, 25 to 140 mm.',
  groups: [
    {
      title: 'Fan',
      params: [
        { key: 'size', label: 'Fan', type: 'select', default: '40', options: FANS.map((f) => ({ value: String(f.size), label: `${f.size} mm` })) },
        {
          key: 'opening',
          label: 'Opening',
          type: 'select',
          default: 'round',
          help: 'Round: one clear hole. Guard: the hole with concentric rings left across it, so fingers and cables stay out. Holes only: just the screw holes, for a grille of your own.',
          options: [
            { value: 'round', label: 'Round' },
            { value: 'guard', label: 'Round with a guard' },
            { value: 'none', label: 'Screw holes only' },
          ],
        },
        { key: 'bar', label: 'Guard bar width', type: 'number', default: 2, min: 0.8, max: 10, step: 0.1, unit: 'mm', visible: (p) => str(p, 'opening') === 'guard' },
        { key: 'gap', label: 'Guard gap', type: 'number', default: 6, min: 2, max: 30, step: 0.5, unit: 'mm', help: 'Width of the open rings between the bars.', visible: (p) => str(p, 'opening') === 'guard' },
        clearanceParam,
      ],
    },
    cutGroup,
  ],
  build(p, q): BuildResult {
    const f = FANS.find((x) => String(x.size) === str(p, 'size')) ?? FANS[2];
    const grow = num(p, 'clearance');
    const depth = num(p, 'depth');
    const through = str(p, 'through') as Through;
    const opening = str(p, 'opening');
    const shapes: Shape2D = [];
    const holes: Polygon[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) holes.push(circle((f.hole + 2 * grow) / 2, q.circle, (sx * f.spacing) / 2, (sy * f.spacing) / 2));
    const R = f.opening / 2 + grow;
    if (opening === 'round') shapes.push(circle(R, q.circle));
    else if (opening === 'guard') {
      // Rings of open air between bars, from the rim inwards, and a disc in the middle if one fits; the
      // bars are joined by four spokes, which hold the rings together when the cutter is subtracted.
      const bar = num(p, 'bar');
      const gap = num(p, 'gap');
      const rings: Polygon[] = [];
      for (let outer = R; outer > bar; outer -= gap + bar) {
        const inner = Math.max(0, outer - gap);
        if (inner < bar) {
          rings.push(circle(outer, q.circle));
          break;
        }
        rings.push(circle(outer, q.circle), circle(inner, q.circle).reverse());
      }
      // Even-odd fill: each ring is an outer circle minus an inner one, and the spokes are taken off as solids below.
      shapes.push(...rings);
    }
    const info = [
      { label: 'Fan', value: `${f.size} mm` },
      { label: 'Screw holes', value: `4 × Ø${f.hole} mm, ${f.spacing} mm apart` },
      ...(opening !== 'none' ? [{ label: 'Opening', value: `Ø${(2 * R).toFixed(1)} mm` }] : []),
      { label: 'Length', value: mm(depth, 1) },
    ];
    let solid = prism([...shapes, ...holes], depth, through);
    if (opening === 'guard') {
      // The spokes: four bars across the opening, taken out of the cutter so that they stay in the wall.
      const bar = num(p, 'bar');
      const spoke = (a: number): Polygon => [
        [-R - 1, -bar / 2],
        [R + 1, -bar / 2],
        [R + 1, bar / 2],
        [-R - 1, bar / 2],
      ].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as Vec2);
      const spokes = prism([spoke(0), spoke(Math.PI / 2)].map((s) => s), depth + 2, through);
      solid = { op: 'difference', children: [solid, spokes] };
    }
    return { solid, outline: [...shapes, ...holes], info, warnings: [] };
  },
};

export const CUTOUTS: GeneratorDef[] = [fan, panelConnector];

/** For the tests. */
export const cutoutOutline = outline;
