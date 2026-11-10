// Panel cutouts: the openings an enclosure wall needs that are worth looking
// up rather than drawing: a connector that bolts to a panel is its cutout with
// its screw holes, as the maker draws them. (A dev board's sockets live with
// the board, in boards.ts, where they come placed on the board itself; fans
// have their own family in fans.ts.) Each is a prism, grown by a
// clearance and long enough to pass through a wall: make it a hole and group
// it with the wall. Parts lie flat, centered on the wall; turn them to face
// through a side.
import { tr } from '../../i18n';
import { arc, circle, roundedRect } from '../math2d';
import { extrude, translate } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { bool, num, str } from './types';
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
  if (o.bottom === undefined) return roundedRect(cx, cy, w, h, o.r + grow, q);
  // A D-sub style trapezoid: sloping sides, corners rounded with square arcs moved in.
  const r = Math.max(0, Math.min(o.r + grow, w / 2, h / 2));
  const n = Math.max(2, Math.round(q.circle / 4));
  const bw = o.bottom + 2 * grow;
  const slope = Math.atan2((w - bw) / 2, h);
  return [
    ...arc(cx + w / 2 - r, cy + h / 2 - r, r, -slope, Math.PI / 2, n),
    ...arc(cx - w / 2 + r, cy + h / 2 - r, r, Math.PI / 2, Math.PI + slope, n),
    ...arc(cx - bw / 2 + r, cy - h / 2 + r, r, Math.PI + slope, 1.5 * Math.PI, n),
    ...arc(cx + bw / 2 - r, cy - h / 2 + r, r, 1.5 * Math.PI, 2 * Math.PI - slope, n),
  ];
}

// --- shared ----------------------------------------------------------------------------------

/** Every cutout is this long: it lies flat, centered on the wall, and can be stretched along its axis for a thicker one. */
export const CUTOUT_LENGTH = 20;

const clearanceParam = { key: 'clearance', label: tr('Clearance'), type: 'number' as const, default: 0.3, min: 0, max: 3, step: 0.05, unit: 'mm', help: tr('Added all round every opening and hole. 0.3 mm suits most printers; more for a loose fit.') };

/** A prism of the shapes along Z, centered on the wall. */
const prism = (shapes: Shape2D): Solid => translate(extrude(shapes, CUTOUT_LENGTH), [0, 0, -CUTOUT_LENGTH / 2]);

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
  /** A line or two for the dropdown: what fits, what the holes take. */
  note: string;
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
  { id: 'neutrik-d', label: tr('Neutrik D-series'), cutout: round(24), holes: { d: 3.2, across: 19, up: 24, diagonal: true }, note: tr('Fits every D-size chassis connector: XLR, speakON, powerCON, etherCON. M3 holes.') },
  { id: 'iec-c14', label: tr('IEC C14 inlet, screw flange'), cutout: { w: 28, h: 20, r: 3 }, holes: { d: 3.5, across: 40 }, note: tr('Fits Schurter 6100 and Qualtek 703W inlets; panels up to 8 mm.') },
  { id: 'iec-c13', label: tr('IEC C13 outlet, screw flange'), cutout: { w: 32.5, h: 24.8, r: 4 }, holes: { d: 3.5, across: 40 }, note: tr('Fits Schurter 6600 and like outlets; two M3 holes 40 mm apart.') },
  { id: 'iec-c8', label: tr('IEC C8 inlet, snap-in'), cutout: { w: 19.5, h: 12.5, r: 0 }, wings: { w: 24.5, h: 7.5 }, note: tr('Snap-in (Qualtek 771W) for 0.6 to 1.5 mm panels; the notch takes its catches.') },
  { id: 'db9', label: 'D-sub 9 (DE-9)', cutout: { w: 20.7, h: 11.68, r: 2.4, bottom: 15.9 }, holes: { d: 3.1, across: 24.99 }, note: tr('9-pin D-sub (serial). Norcomp cut-out; the holes take #4-40 jackscrews or M3.') },
  { id: 'db15', label: 'D-sub 15 (DA-15)', cutout: { w: 29, h: 11.68, r: 2.4, bottom: 24.2 }, holes: { d: 3.1, across: 33.32 }, note: tr('15-pin D-sub in two rows (DA-15). Norcomp cut-out; holes take #4-40 jackscrews or M3.') },
  { id: 'db25', label: 'D-sub 25 (DB-25)', cutout: { w: 42.8, h: 11.68, r: 2.4, bottom: 38 }, holes: { d: 3.1, across: 47.04 }, note: tr('25-pin D-sub (parallel). Norcomp cut-out; the holes take #4-40 jackscrews or M3.') },
  { id: 'xt60', label: tr('XT60 panel mount (XT60E)'), cutout: { w: 15.5, h: 8.1, r: 1 }, holes: { d: 3.2, across: 20 }, note: tr('Amass XT60E panel mount; two M3 holes 20 mm apart.') },
];

function holeShapes(h: NonNullable<PanelConnector['holes']>, grow: number, q: Quality): { at: Vec2[]; shapes: Polygon[] } {
  const at: Vec2[] = [];
  if (h.diagonal && h.across !== undefined && h.up !== undefined) at.push([-h.across / 2, h.up / 2], [h.across / 2, -h.up / 2]);
  else if (h.across !== undefined && h.up !== undefined) for (const sx of [-1, 1]) for (const sy of [-1, 1]) at.push([(sx * h.across) / 2, (sy * h.up) / 2]);
  else if (h.across !== undefined) for (const sx of [-1, 1]) at.push([(sx * h.across) / 2, 0]);
  else if (h.up !== undefined) for (const sy of [-1, 1]) at.push([0, (sy * h.up) / 2]);
  return { at, shapes: at.map(([x, y]) => circle((h.d + 2 * grow) / 2, q.circle, x, y)) };
}

/** The screw holes as the inspector describes them: how many, their size, and how far apart they are each way. */
function holesText(h: NonNullable<PanelConnector['holes']>, n: number): string {
  const { d, across, up } = h;
  if (across && up) {
    if (h.diagonal) return tr('{n} × Ø{d} mm, {across} mm across and {up} mm up, at opposite corners', { n, d, across, up });
    return tr('{n} × Ø{d} mm, {across} mm across, {up} mm up', { n, d, across, up });
  }
  if (across) return tr('{n} × Ø{d} mm, {across} mm across', { n, d, across });
  if (up) return tr('{n} × Ø{d} mm, {up} mm up', { n, d, up });
  return `${n} × Ø${d} mm, `;
}

export const panelConnector: GeneratorDef = {
  id: 'panel-connector',
  name: tr('Panel connector'),
  category: 'cutouts',
  summary: tr('Cutout and screw holes for a panel-mount connector.'),
  groups: [
    {
      title: tr('Connector'),
      params: [
        { key: 'connector', label: tr('Connector'), type: 'select', default: 'neutrik-d', options: PANEL_CONNECTORS.map((c) => ({ value: c.id, label: c.label, note: c.note })) },
        clearanceParam,
        { key: 'holes', label: tr('Screw holes'), type: 'boolean', default: true, visible: (p) => Boolean(PANEL_CONNECTORS.find((c) => c.id === str(p, 'connector'))?.holes) },
      ],
    },
  ],
  build(p, q): BuildResult {
    const warnings: string[] = [];
    const c = PANEL_CONNECTORS.find((x) => x.id === str(p, 'connector')) ?? PANEL_CONNECTORS[0];
    const grow = num(p, 'clearance');
    const shapes: Shape2D = [c.wings ? stepped(c.cutout, c.wings, grow) : outline(c.cutout, grow, q)];
    if (c.holes && bool(p, 'holes')) shapes.push(...holeShapes(c.holes, grow, q).shapes);
    const info = [
      { label: tr('Cutout'), value: sizeText((c.wings ? Math.max(c.wings.w, c.cutout.w) : c.cutout.w) + 2 * grow, c.cutout.h + 2 * grow) },
      { label: tr('Nominal'), value: sizeText(c.cutout.w, c.cutout.h) },
      ...(c.holes ? [{ label: tr('Holes'), value: holesText(c.holes, holeShapes(c.holes, 0, q).at.length) }] : []),
    ];
    return { solid: prism(shapes), outline: shapes, info, warnings };
  },
};

export const CUTOUTS: GeneratorDef[] = [panelConnector];

/** For the tests. */
export const cutoutOutline = outline;
