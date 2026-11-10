// Axial fans, 25 to 140 mm, as the things an enclosure needs for one: the
// cutout through the wall (a clear round hole, or a guard pattern cut straight
// into the wall), the screw holes alone, a printed grill to screw over the
// fan, and the fan itself, a placeholder with the frame, hub and blades of a
// typical fan of that size, to check clearance round and design against.
//
// Everything is built with the fan's axis along Z, lying flat and centered
// on the wall it sits in: turn the part to face through a side wall.
import { plural, tr, trx } from '../../i18n';
import { TAU, arc, arcSegments, circle, regularPolygon, roundedRect, signedArea } from '../math2d';
import { cylinder, extrude, intersection, rotate, translate, union } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { CUTOUT_LENGTH } from './cutouts';
import { bool, mm, num, str } from './types';
import type { BuildResult, GeneratorDef, InfoItem, Params } from './types';

export interface Fan {
  /** Frame size (square) in mm. */
  size: number;
  /** Screw hole center spacing (square pattern) and hole diameter. */
  spacing: number;
  hole: number;
  /** Opening diameter, a little under the frame. */
  opening: number;
  /** The usual frame depth (stretch the part for a thicker fan), the frame's corner radius and the hub diameter of a typical fan this size. */
  depth: number;
  corner: number;
  hub: number;
}

// Hole patterns from Delta's and Sunon's drawings and Noctua's spec; the opening is the frame less 2 mm.
// Depths are the common ones (thinner and thicker fans exist at every size); the corner radii and
// hub diameters are typical, read off the same drawings, for the placeholder fan.
export const FANS: Fan[] = [
  { size: 25, spacing: 20, hole: 2.8, opening: 23, depth: 10, corner: 3, hub: 14 },
  { size: 30, spacing: 24, hole: 3.2, opening: 28, depth: 10, corner: 3.5, hub: 16 },
  { size: 40, spacing: 32, hole: 3.5, opening: 38, depth: 10, corner: 4, hub: 20 },
  { size: 50, spacing: 40, hole: 4.3, opening: 48, depth: 15, corner: 5, hub: 24 },
  { size: 60, spacing: 50, hole: 4.5, opening: 58, depth: 15, corner: 5.5, hub: 28 },
  { size: 70, spacing: 61.5, hole: 4.3, opening: 68, depth: 15, corner: 6, hub: 32 },
  { size: 80, spacing: 71.5, hole: 4.5, opening: 78, depth: 25, corner: 7, hub: 36 },
  { size: 92, spacing: 82.5, hole: 4.5, opening: 90, depth: 25, corner: 7.5, hub: 40 },
  { size: 120, spacing: 105, hole: 4.5, opening: 118, depth: 25, corner: 7.5, hub: 46 },
  { size: 140, spacing: 124.5, hole: 4.5, opening: 138, depth: 25, corner: 7.5, hub: 50 },
];

export type FanPattern = 'open' | 'rings' | 'slots' | 'honeycomb' | 'grid';
type Form = 'cutout' | 'holes' | 'grill' | 'body';

// --- 2D ---------------------------------------------------------------------------------------

/** Keep the part of a polygon on the side of a line (through `a`, normal `n`) the normal points to. */
function clipHalfPlane(poly: Polygon, a: Vec2, n: Vec2): Polygon {
  const out: Polygon = [];
  const side = (p: Vec2) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Clip a polygon to the circle of radius R (as the kernel will draw it, with q.circle sides). */
function clipToCircle(poly: Polygon, R: number, q: Quality): Polygon {
  const n = q.circle;
  // Wholly inside the inscribed circle of the polygonal disc: nothing to do.
  if (poly.every(([x, y]) => Math.hypot(x, y) <= R * Math.cos(Math.PI / n))) return poly;
  let out = poly;
  for (let i = 0; i < n && out.length >= 3; i++) {
    const a0 = (TAU * i) / n;
    const a1 = (TAU * (i + 1)) / n;
    const p: Vec2 = [R * Math.cos(a0), R * Math.sin(a0)];
    const d: Vec2 = [R * Math.cos(a1) - p[0], R * Math.sin(a1) - p[1]];
    // Inside the CCW disc is to the left of each edge.
    const inward: Vec2 = [-d[1], d[0]];
    if (out.every(([x, y]) => (x - p[0]) * inward[0] + (y - p[1]) * inward[1] >= 0)) continue;
    out = clipHalfPlane(out, p, inward);
  }
  return out.length >= 3 ? out : [];
}

/** A sector of the ring between radii ri and ro, from angle a0 to a1; a pie wedge when ri is 0. */
function ringSector(ri: number, ro: number, a0: number, a1: number, q: Quality): Polygon {
  const n = arcSegments(q, a1 - a0, 4);
  const outer = arc(0, 0, ro, a0, a1, n);
  if (ri <= 0) return [[0, 0], ...outer];
  return [...outer, ...arc(0, 0, ri, a1, a0, n)];
}

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** The fan frame's outline: a square of side `s` about the origin, grown by `grow` all round. */
export function roundedSquare(s: number, r: number, q: Quality, grow = 0): Polygon {
  const side = 2 * (s / 2 + grow);
  return roundedRect(0, 0, side, side, r + grow, q);
}

/**
 * The open parts of a guard pattern inside a circle of radius R: disjoint CCW polygons, each a
 * hole in the wall or grill. `bar` is the width of material left between them, `gap` the width of
 * each opening (a ring's width, a slot's height, a cell's across-flats).
 */
export function fanOpenings(pattern: FanPattern, R: number, bar: number, gap: number, spokes: number, q: Quality): Polygon[] {
  if (R <= 0) return [];
  if (pattern === 'open') return [circle(R, q.circle)];
  const out: Polygon[] = [];
  const keep = (poly: Polygon, least: number) => {
    if (poly.length >= 3 && signedArea(poly) >= least) out.push(poly);
  };
  if (pattern === 'rings') {
    // Rings of open air from the rim inwards, a disc in the middle if one fits, each cut into
    // sectors by the spokes that hold the bars together.
    const n = Math.max(2, Math.round(spokes));
    for (let outer = R; outer > bar; outer -= gap + bar) {
      let inner = Math.max(0, outer - gap);
      if (inner < bar) inner = 0;
      for (let k = 0; k < n; k++) {
        const a0 = (TAU * k) / n;
        const a1 = (TAU * (k + 1)) / n;
        let sector = ringSector(inner, outer, a0, a1, q);
        // The spoke along a0 lies to the right of the sector, the one along a1 to its left.
        sector = clipHalfPlane(sector, [(-Math.sin(a0) * bar) / 2, (Math.cos(a0) * bar) / 2], [-Math.sin(a0), Math.cos(a0)]);
        sector = clipHalfPlane(sector, [(Math.sin(a1) * bar) / 2, (-Math.cos(a1) * bar) / 2], [Math.sin(a1), -Math.cos(a1)]);
        keep(sector, 0.5);
      }
      if (inner === 0) break;
    }
    return out;
  }
  if (pattern === 'slots') {
    // Horizontal slots, one centered, each ending at the circle; the shortest, at the top and
    // bottom, are dropped once they would be shorter than they are wide.
    const pitch = gap + bar;
    for (let yc = 0; yc - gap / 2 < R; yc = yc === 0 ? pitch : yc + pitch) {
      for (const s of yc === 0 ? [1] : [-1, 1]) keep(clipToCircle(rect(-R - 1, s * yc - gap / 2, R + 1, s * yc + gap / 2), R, q), gap * gap);
    }
    return out;
  }
  // Cells on a lattice: hexagons across-flats `gap` or squares of side `gap`, `bar` apart, one
  // centered. Cells reaching past the circle are trimmed to it; those with less than half
  // their middle inside are left out, so no sliver of an opening is left at the rim.
  const pitch = gap + bar;
  const cell = pattern === 'honeycomb' ? regularPolygon(6, gap / 2) : rect(-gap / 2, -gap / 2, gap / 2, gap / 2);
  const area = signedArea(cell);
  const reach = Math.ceil(R / pitch) + 1;
  const centers: Vec2[] = [];
  if (pattern === 'honeycomb') {
    // Flats face ±X, so neighbors sit along X and at ±60°.
    for (let j = -reach; j <= reach; j++) for (let i = -reach - 1; i <= reach + 1; i++) centers.push([(i + j / 2) * pitch, ((j * Math.sqrt(3)) / 2) * pitch]);
  } else {
    for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) centers.push([i * pitch, j * pitch]);
  }
  for (const [cx, cy] of centers) {
    if (Math.hypot(cx, cy) > R - gap / 4) continue;
    keep(clipToCircle(cell.map(([x, y]) => [x + cx, y + cy] as Vec2), R, q), area / 4);
  }
  return out;
}

// --- parameters -------------------------------------------------------------------------------

const form = (p: Params) => str(p, 'form') as Form;
const is = (...forms: Form[]) => (p: Params) => forms.includes(form(p));
const patterned = (p: Params) => is('cutout', 'grill')(p) && str(p, 'pattern') !== 'open';

const fanOf = (p: Params): Fan => FANS.find((x) => String(x.size) === str(p, 'size')) ?? FANS[2];

/** A slab from the shapes, `t` thick, centered on z = 0. */
const slab = (shapes: Shape2D, t: number): Solid => translate(extrude(shapes, t), [0, 0, -t / 2]);

export const fan: GeneratorDef = {
  id: 'fan',
  name: tr('Fan'),
  category: 'fans',
  summary: tr('Cutout, grill or mounting holes for a standard axial fan.'),
  groups: [
    {
      title: tr('Fan'),
      params: [
        { key: 'size', label: tr('Fan'), type: 'select', default: '40', options: FANS.map((f) => ({ value: String(f.size), label: `${f.size} mm` })) },
        {
          key: 'form',
          label: tr('Make'),
          type: 'select',
          default: 'cutout',
          help: tr('Selects the build target for the chosen fan.'),
          options: [
            { value: 'cutout', label: tr('Panel cutout') },
            { value: 'holes', label: tr('Screw holes') },
            { value: 'grill', label: tr('Frame & grill') },
            { value: 'body', label: tr('Fan') },
          ],
        },
        { key: 'clearance', label: tr('Clearance'), type: 'number', default: 0.3, min: 0, max: 3, step: 0.05, unit: 'mm', help: tr('Added all round the opening and the screw holes, or round the frame of the fan itself. 0.3 mm suits most printers; more for a loose fit.') },
        {
          key: 'pattern',
          label: trx('guard', 'Pattern'),
          type: 'select',
          default: 'open',
          help: tr('Selects the guard pattern across the opening.'),
          options: [
            { value: 'open', label: trx('guard', 'Open') },
            { value: 'rings', label: tr('Rings') },
            { value: 'slots', label: trx('guard', 'Slots') },
            { value: 'honeycomb', label: tr('Honeycomb') },
            { value: 'grid', label: trx('guard', 'Grid') },
          ],
          visible: is('cutout', 'grill'),
        },
        { key: 'bar', label: tr('Bar width'), type: 'number', default: 2, min: 0.8, max: 10, step: 0.1, unit: 'mm', help: tr('The material left between the openings. Two nozzle widths prints cleanly.'), visible: patterned },
        { key: 'gap', label: tr('Opening width'), type: 'number', default: 6, min: 2, max: 30, step: 0.5, unit: 'mm', help: tr('Sets the width of each opening in the pattern.'), visible: patterned },
        { key: 'spokes', label: tr('Spokes'), type: 'number', default: 4, min: 2, max: 8, step: 1, integer: true, help: tr('Bars from the middle out that hold the rings together.'), visible: (p) => patterned(p) && str(p, 'pattern') === 'rings' },
        { key: 'thickness', label: tr('Thickness'), type: 'number', default: 2, min: 0.8, max: 10, step: 0.2, unit: 'mm', help: tr('Sets the grill plate thickness.'), visible: is('grill') },
        { key: 'rim', label: tr('Rim'), type: 'number', default: 3, min: 1, max: 15, step: 0.5, unit: 'mm', help: tr('Solid border between the pattern and the edge of the grill, which the screws pass through.'), visible: is('grill') },
        { key: 'grillHoles', label: tr('Screw holes'), type: 'boolean', default: true, help: tr('The four fan screw holes in the frame. Off for a grill that is glued or built into something else.'), visible: is('grill') },
        { key: 'grillCorners', label: tr('Rounded corners'), type: 'boolean', default: true, help: tr('Corners rounded like the fan frame, or square.'), visible: is('grill') },
      ],
    },
  ],
  build(p, q): BuildResult {
    const f = fanOf(p);
    const make = form(p);
    const grow = num(p, 'clearance');
    const n = q.circle;
    const warnings: string[] = [];
    const info: InfoItem[] = [
      { label: tr('Fan'), value: `${f.size} × ${f.size} mm` },
      { label: tr('Screw holes'), value: tr('4 × Ø{hole} mm, {spacing} mm apart', { hole: f.hole, spacing: f.spacing }) },
    ];
    const holes = (d: number): Polygon[] => [-1, 1].flatMap((sx) => [-1, 1].map((sy) => circle(d / 2, n, (sx * f.spacing) / 2, (sy * f.spacing) / 2)));
    const openPercent = (openings: Polygon[], R: number) => ((100 * openings.reduce((a, o) => a + signedArea(o), 0)) / (Math.PI * R * R)).toFixed(0);
    const pattern = str(p, 'pattern') as FanPattern;
    const bar = num(p, 'bar');
    const gap = num(p, 'gap');
    const spokes = num(p, 'spokes');

    if (make === 'cutout' || make === 'holes') {
      const pins = holes(f.hole + 2 * grow);
      const R = f.opening / 2 + grow;
      const openings = make === 'cutout' ? fanOpenings(pattern, R, bar, gap, spokes, q) : [];
      if (make === 'cutout') {
        info.push({ label: tr('Opening'), value: `Ø${(2 * R).toFixed(1)} mm` });
        if (pattern !== 'open') info.push({ label: trx('guard', 'Pattern'), value: plural(openings.length, '{n} opening, {percent} % of the circle open', '{n} openings, {percent} % of the circle open', { percent: openPercent(openings, R) }) });
        if (pattern !== 'open' && bar < 1.2) warnings.push(tr('Bars under 1.2 mm are a single extrusion wide and break easily; 2 mm is sturdier.'));
      }
      info.push({ label: tr('Length'), value: mm(CUTOUT_LENGTH, 0) });
      // The screw holes can reach into a large opening: a union, not one even-odd shape, keeps the overlap cut.
      const shapes: Shape2D = [...openings, ...pins];
      const solid = openings.length ? union(slab(openings, CUTOUT_LENGTH), slab(pins, CUTOUT_LENGTH)) : slab(pins, CUTOUT_LENGTH);
      return { solid, outline: shapes, info, warnings };
    }

    if (make === 'grill') {
      const t = num(p, 'thickness');
      const R = f.size / 2 - num(p, 'rim');
      const openings = fanOpenings(pattern, R, bar, gap, spokes, q);
      const shapes: Shape2D = [roundedSquare(f.size, bool(p, 'grillCorners') ? f.corner : 0, q), ...(bool(p, 'grillHoles') ? holes(f.hole + 2 * grow) : []), ...openings];
      info.push({ label: tr('Grill'), value: `${f.size} × ${f.size} × ${t} mm` }, { label: tr('Opening'), value: pattern !== 'open' ? tr('Ø{diameter} mm, {percent} % of the circle open', { diameter: (2 * R).toFixed(1), percent: openPercent(openings, R) }) : `Ø${(2 * R).toFixed(1)} mm` });
      if (pattern !== 'open' && bar < 1.2) warnings.push(tr('Bars under 1.2 mm are a single extrusion wide and break easily; 2 mm is sturdier.'));
      return { solid: slab(shapes, t), outline: shapes, info, warnings };
    }

    // The fan itself: the frame with its bore and holes, the hub, the struts behind and the blades,
    // trimmed to the bore. A placeholder, not any one maker's fan.
    const t = f.depth;
    const Rb = f.opening / 2;
    const frameShape: Shape2D = [roundedSquare(f.size, f.corner, q, grow), circle(Rb, n), ...holes(f.hole)];
    const pieces: Solid[] = [slab(frameShape, t)];
    const hubR = f.hub / 2;
    const inset = Math.min(1.5, t / 10);
    pieces.push(translate(cylinder(hubR, t - 2 * inset, n), [0, 0, -t / 2 + inset]));
    // Struts at the back, from the hub to the frame.
    const strutW = f.size < 50 ? 2 : 3;
    const strutT = Math.min(3, t / 5);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const strut = rect(hubR - 1, -strutW / 2, Rb + 1, strutW / 2).map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as Vec2);
      pieces.push(translate(extrude([strut], strutT), [0, 0, -t / 2 + inset]));
    }
    // Seven blades, pitched 35°, as wide as the frame depth allows, broader at the tip than at the hub.
    const blades = 7;
    const pitch = 35;
    const bladeT = f.size < 50 ? 1 : 1.4;
    const span = t - 2 * inset - 1;
    const w = Math.min((0.9 * span) / Math.sin((pitch * Math.PI) / 180), (1.7 * TAU * hubR) / blades);
    const blade: Polygon = [
      [hubR - 1, -0.35 * w],
      [Rb, -0.65 * w],
      [Rb, 0.65 * w],
      [hubR - 1, 0.35 * w],
    ];
    const bladeSet: Solid[] = [];
    for (let i = 0; i < blades; i++) bladeSet.push(rotate(translate(extrude([blade], bladeT), [0, 0, -bladeT / 2]), [pitch, 0, (360 * i) / blades]));
    pieces.push(intersection(union(...bladeSet), translate(cylinder(Rb - 0.6, span, n), [0, 0, -span / 2])));
    info.push({ label: tr('Frame depth'), value: mm(t, 0) }, { label: tr('Hub'), value: tr('Ø{hub} mm, 7 blades', { hub: f.hub }) });
    if (grow > 0) info.push({ label: trx('fan', 'Frame'), value: tr('{size} mm with the clearance', { size: (f.size + 2 * grow).toFixed(1) }) });
    return { solid: union(...pieces), outline: frameShape, info, warnings };
  },
};

export const FAN_PARTS: GeneratorDef[] = [fan];
