// Mounts for the motors that turn up in hobby builds: NEMA steppers, the
// 28BYJ-48, micro gearmotors, servos and brushed motors. Each is a table row
// from its maker's drawing: the mounting face, the bolt pattern on it, the
// pilot boss or the body that passes through, the shaft, and the body behind.
// From that one row the part can be a mounting plate, a hole template to cut
// with, the motor itself as a body to design round (or, made a hole, to
// pocket for), or an L-bracket with a slotted foot.
//
// Everything is built round the mounting face, which lies in the XY plane
// with the shaft pointing up +Z; the body form hangs the motor below it.
import { plural, tr, trx } from '../../i18n';
import { arc, circle, roundedRect } from '../math2d';
import { cylinder, extrude, rotate, translate, union } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { bool, num, lengthsText, str, unitInfo } from './types';
import type { BuildResult, GeneratorDef, InfoItem, ParamGroup, Params } from './types';
import { figureFixed, lengthFixed, lengthText, said } from '../../units';
import type { Unit } from '../../units';

/** Drill sizes for a screw in printed plastic: the screw cutting its own thread, or a clearance hole. */
const SCREWS: Record<string, { tap: number; clearance: number }> = {
  'M1.6': { tap: 1.35, clearance: 1.8 },
  M2: { tap: 1.7, clearance: 2.4 },
  'M2.5': { tap: 2.1, clearance: 2.8 },
  M3: { tap: 2.6, clearance: 3.4 },
  M4: { tap: 3.4, clearance: 4.5 },
  M5: { tap: 4.3, clearance: 5.5 },
};

export interface Motor {
  id: string;
  label: string;
  /** The mounting face: a rounded square or rectangle (w × h, corner r), or a circle (d); `at` when the shaft is not at its middle. */
  face: ({ w: number; h: number; r: number } | { d: number }) & { at?: Vec2 };
  /** Bolt holes on the face, from its center, and the screw they take. */
  holes: Vec2[];
  screw: keyof typeof SCREWS;
  /** A boss standing proud of the face that locates in a bore. */
  pilot?: { d: number; h: number; at?: Vec2 };
  /** A body that passes through the plate instead of sitting on it (a servo): its outline on the face. */
  through?: { w: number; h: number; r: number };
  /** The shaft: diameter, length past the face (or past the top of the body for a servo), flat across, and where it is on the face. */
  shaft: { d: number; len: number; flat?: number; at?: Vec2 };
  /** The body: box or cylinder, how far it reaches behind the face, and for a servo how far it stands above it too. */
  body: { w: number; h: number; round?: boolean; r?: number; below: number; above?: number };
  /** Tabs or ears in the plane of the face: their span across, depth, thickness along the axis, and where their middle is. */
  tabs?: { w: number; h: number; t: number; at?: Vec2 };
  /** Usual body lengths, for the help text. */
  lengths?: string;
  /** A line or two for the dropdown: the hole pattern and what to watch. */
  note: string;
  /** An L-bracket makes sense for this motor. */
  bracket?: boolean;
}

const square = (s: number, r: number) => ({ w: s, h: s, r });
const corners = (s: number): Vec2[] => [
  [-s / 2, -s / 2],
  [s / 2, -s / 2],
  [s / 2, s / 2],
  [-s / 2, s / 2],
];

// Figures from the makers' drawings: StepperOnline's for the NEMA frames, Fulling's for the 28BYJ-48,
// Pololu's for the N20, 25 mm and 37 mm gearmotors, Adafruit's for the TT motor, Mabuchi's for the
// FA-130, TowerPro's for the servos (whose hole sizes no maker publishes). The 775 has no published
// drawing at all. Body lengths are the common ones; a motor's own may differ.
const ring = (n: number, d: number): Vec2[] => Array.from({ length: n }, (_, i) => [(d / 2) * Math.cos((2 * Math.PI * i) / n), (d / 2) * Math.sin((2 * Math.PI * i) / n)]);

export const STEPPERS: Motor[] = [
  { id: 'nema17', label: 'NEMA 17 (42 mm)', face: square(42.3, 5), holes: corners(31), screw: 'M3', pilot: { d: 22, h: 2 }, shaft: { d: 5, len: 24, flat: 4.5 }, body: { w: 42.3, h: 42.3, r: 5, below: 40 }, lengths: '34, 40 or 48', bracket: true, note: tr('Four M3 holes on a 31 mm square, 22 mm pilot boss.') },
  { id: 'nema23', label: 'NEMA 23 (57 mm)', face: square(57.3, 5), holes: corners(47.14), screw: 'M5', pilot: { d: 38.1, h: 1.6 }, shaft: { d: 6.35, len: 21, flat: 5.85 }, body: { w: 57.3, h: 57.3, r: 5, below: 56 }, lengths: '42, 56 or 76', bracket: true, note: tr('Four M5 through holes on a 47.1 mm square, 38.1 mm pilot boss.') },
  { id: 'nema14', label: 'NEMA 14 (35 mm)', face: square(35.2, 4), holes: corners(26), screw: 'M3', pilot: { d: 22, h: 2 }, shaft: { d: 5, len: 24, flat: 4.5 }, body: { w: 35.2, h: 35.2, r: 4, below: 34 }, lengths: '28 or 34', bracket: true, note: tr('Four M3 holes on a 26 mm square, 22 mm pilot boss.') },
  { id: 'nema11', label: 'NEMA 11 (28 mm)', face: square(28.2, 3), holes: corners(23), screw: 'M2.5', pilot: { d: 22, h: 2 }, shaft: { d: 5, len: 20 }, body: { w: 28.2, h: 28.2, r: 3, below: 33 }, lengths: '33, 45 or 51', bracket: true, note: tr('Four M2.5 holes on a 23 mm square, 22 mm pilot boss.') },
  { id: 'nema8', label: 'NEMA 8 (20 mm)', face: square(20.3, 2), holes: corners(15.4), screw: 'M2', pilot: { d: 16, h: 1.5 }, shaft: { d: 4, len: 10, flat: 3.5 }, body: { w: 20.3, h: 20.3, r: 2, below: 27.3 }, lengths: '27 to 38', bracket: true, note: tr('Four M2 holes on a 15.4 mm square, 16 mm pilot boss.') },
  {
    id: '28byj48',
    label: tr('28BYJ-48 geared stepper'),
    // The ears run across the middle of the can; the shaft comes out 8 mm above it, away from the wires.
    face: { d: 28, at: [0, -8] },
    holes: [
      [-17.5, -8],
      [17.5, -8],
    ],
    screw: 'M4',
    pilot: { d: 9, h: 1.5 },
    shaft: { d: 5, len: 10, flat: 3 },
    body: { w: 28, h: 28, round: true, below: 19 },
    tabs: { w: 42, h: 7, t: 1, at: [0, -8] },
    note: tr('Ears 35 mm apart across the middle of the body; the shaft is 8 mm off center, away from the wires.'),
  },
];

export const GEARMOTORS: Motor[] = [
  {
    id: 'n20',
    label: tr('N20 micro gearmotor (12 × 10)'),
    face: { w: 12, h: 10, r: 0.5 },
    holes: [
      [-4.5, 0],
      [4.5, 0],
    ],
    screw: 'M1.6',
    shaft: { d: 3, len: 10, flat: 2.5 },
    body: { w: 12, h: 10, r: 0.5, below: 32.5 },
    lengths: '32.5 with a 9 mm gearbox, 36 with 12.5',
    bracket: true,
    note: tr('Screws reach 1.3 mm into the gearbox.'),
  },
  {
    id: 'tt',
    label: tr('TT yellow gearmotor (3 to 6 V)'),
    face: { w: 22.4, h: 37, r: 1, at: [0, -9.25] },
    holes: [
      [-8.8, -14.4],
      [8.8, -14.4],
      [0, 14],
    ],
    screw: 'M3',
    shaft: { d: 5.4, len: 9, flat: 3.7 },
    body: { w: 22.4, h: 37, r: 1, below: 18.6 },
    note: tr('Gearbox block only; the can runs 33 mm past it. Shaft out both sides, holes go right through.'),
  },
  {
    id: '25d',
    label: tr('25 mm gearmotor (JGA25-370, Pololu 25D)'),
    face: { d: 25 },
    holes: [
      [-8.5, 0],
      [8.5, 0],
    ],
    screw: 'M3',
    pilot: { d: 7, h: 2.5 },
    shaft: { d: 4, len: 12.5, flat: 3.5 },
    body: { w: 25, h: 25, round: true, below: 52 },
    lengths: '48 to 58 by gear ratio',
    bracket: true,
    note: tr('Two M3 holes 17 mm apart either side of a 7 mm boss. Length runs 48 to 58 mm by gear ratio.'),
  },
  {
    id: '37d',
    label: tr('37 mm gearmotor (JGB37-520, Pololu 37D)'),
    face: { d: 36.8 },
    holes: ring(6, 31),
    screw: 'M3',
    pilot: { d: 12, h: 6 },
    shaft: { d: 6, len: 22, flat: 5.4 },
    body: { w: 36.8, h: 36.8, round: true, below: 55 },
    lengths: '52 to 62 by gear ratio',
    bracket: true,
    note: tr('Six M3 holes on a 31 mm circle. JGB37 shaft on the gearbox axis; Pololu 37D 7 mm off it.'),
  },
];

export const SERVOS: Motor[] = [
  {
    id: 'sg90',
    label: tr('SG90 micro servo'),
    face: { w: 32.2, h: 11.8, r: 1 },
    holes: [
      [-14, 0],
      [14, 0],
    ],
    screw: 'M2',
    through: { w: 22.5, h: 11.8, r: 1 },
    shaft: { d: 4.7, len: 8, at: [-5.25, 0] },
    body: { w: 22.5, h: 11.8, r: 1, below: 16, above: 6.7 },
    tabs: { w: 32.2, h: 11.8, t: 2.5 },
    note: tr('Body drops through the plate, tabs sit on it; output 6 mm in from one end. Tab holes vary.'),
  },
  {
    id: 'mg996r',
    label: tr('MG996R / MG995 standard servo'),
    face: { w: 54, h: 19.7, r: 1 },
    holes: [
      [-24.75, -5],
      [24.75, -5],
      [-24.75, 5],
      [24.75, 5],
    ],
    screw: 'M4',
    through: { w: 40.7, h: 19.7, r: 1 },
    shaft: { d: 5.9, len: 5.7, at: [-9.95, 0] },
    body: { w: 40.7, h: 19.7, r: 1, below: 26.8, above: 10.2 },
    tabs: { w: 54, h: 19.7, t: 2.5 },
    note: tr('Body drops through the plate, tabs sit on it; output 10 mm in from one end. Tab holes vary.'),
  },
];

export const DC_MOTORS: Motor[] = [
  {
    id: '775',
    label: tr('775 brushed motor (Ø42)'),
    face: { d: 42 },
    holes: [
      [-14.5, 0],
      [14.5, 0],
    ],
    screw: 'M4',
    pilot: { d: 17.5, h: 5 },
    shaft: { d: 5, len: 17 },
    body: { w: 42, h: 42, round: true, below: 66.7 },
    bracket: true,
    note: tr('Two M4 holes 29 mm apart, 17.5 mm pilot boss.'),
  },
  {
    id: '130',
    label: tr('130 brushed motor (Mabuchi FA-130)'),
    face: { w: 20.1, h: 15.1, r: 7.5 },
    holes: [],
    screw: 'M2',
    pilot: { d: 6.15, h: 1.7 },
    shaft: { d: 2, len: 9.4 },
    body: { w: 20.1, h: 15.1, r: 7.5, below: 25 },
    note: tr('No screw holes: the plate carries only the bearing-boss bore.'),
  },
];

// --- 2D ----------------------------------------------------------------------------------

/** A shaft section: a circle with a flat (or two) when the shaft has one. */
function shaftSection(d: number, flat: number | undefined, q: Quality): Polygon {
  const r = d / 2;
  if (!flat || flat >= d) return circle(r, q.circle);
  const x = flat - r;
  const a = Math.acos(x / r);
  return arc(0, 0, r, a, 2 * Math.PI - a, Math.max(8, Math.round((q.circle * (2 * Math.PI - 2 * a)) / (2 * Math.PI))));
}

const faceOutline = (m: Motor, grow: number, q: Quality): Polygon => {
  const [cx, cy] = m.face.at ?? [0, 0];
  return 'd' in m.face ? circle(m.face.d / 2 + grow, q.circle, cx, cy) : roundedRect(cx, cy, m.face.w + 2 * grow, m.face.h + 2 * grow, m.face.r + grow, q);
};

/**
 * The plate's outline: round the face, the bolt pattern plus a margin, any tabs, and a body that
 * passes through plus the same margin, whichever reaches furthest each way. `grow` is the play
 * round such a body: without the margin beyond it the opening would cut the plate in two.
 */
function plateOutline(m: Motor, margin: number, corner: number, grow: number, q: Quality): Polygon {
  const [fx, fy] = m.face.at ?? [0, 0];
  const fw = 'd' in m.face ? m.face.d : m.face.w;
  const fh = 'd' in m.face ? m.face.d : m.face.h;
  const [tx, ty] = m.tabs?.at ?? [0, 0];
  const [bw, bh] = m.through ? [m.through.w / 2 + grow + margin, m.through.h / 2 + grow + margin] : [0, 0];
  const xs = [fx - fw / 2, fx + fw / 2, -bw, bw, ...m.holes.flatMap((h) => [h[0] - margin, h[0] + margin]), ...(m.tabs ? [tx - m.tabs.w / 2, tx + m.tabs.w / 2] : [])];
  const ys = [fy - fh / 2, fy + fh / 2, -bh, bh, ...m.holes.flatMap((h) => [h[1] - margin, h[1] + margin]), ...(m.tabs ? [ty - m.tabs.h / 2, ty + m.tabs.h / 2] : [])];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return roundedRect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, corner, q);
}

/** What the plate must let through at its middle: the pilot boss, the body of a servo, or just the shaft. */
function bore(m: Motor, grow: number, q: Quality): Polygon {
  if (m.through) return roundedRect(0, 0, m.through.w + 2 * grow, m.through.h + 2 * grow, m.through.r + grow, q);
  if (m.pilot) return circle(m.pilot.d / 2 + grow, q.circle, ...(m.pilot.at ?? [0, 0]));
  return circle(m.shaft.d / 2 + grow + 0.5, q.circle, ...(m.shaft.at ?? [0, 0]));
}

// --- parameters ----------------------------------------------------------------------------

type Form = 'plate' | 'holes' | 'body' | 'bracket';
const form = (p: Params) => str(p, 'form') as Form;
const is = (...forms: Form[]) => (p: Params) => forms.includes(form(p));

function groups(motors: Motor[]): ParamGroup[] {
  const anyBracket = motors.some((m) => m.bracket);
  return [
    {
      title: tr('Motor'),
      params: [
        { key: 'motor', label: tr('Motor'), type: 'select', default: motors[0].id, options: motors.map((m) => ({ value: m.id, label: m.label, note: m.note })) },
        {
          key: 'form',
          label: tr('Make'),
          type: 'select',
          default: 'plate',
          help: tr('Selects the build target for the chosen motor.'),
          options: [
            { value: 'plate', label: tr('Mounting plate') },
            { value: 'holes', label: tr('Mounting holes') },
            { value: 'body', label: tr('The motor itself') },
            ...(anyBracket ? [{ value: 'bracket', label: tr('L-bracket') }] : []),
          ],
        },
        { key: 'clearance', label: tr('Clearance'), type: 'number', default: 0.3, min: 0, max: 2, step: 0.05, unit: 'mm', help: tr('Adds this much round the bore and any body that passes through.') },
      ],
    },
    {
      title: trx('mount', 'Plate'),
      params: [
        { key: 'thickness', label: tr('Thickness'), type: 'number', default: 4, min: 1, max: 30, step: 0.5, unit: 'mm', visible: is('plate', 'bracket') },
        { key: 'margin', label: tr('Margin'), type: 'number', default: 6, min: 2, max: 40, step: 0.5, unit: 'mm', help: tr('Sets the margin from the bolt holes and a through body to the edge of the plate.'), visible: is('plate', 'bracket') },
        { key: 'corner', label: tr('Corner radius'), type: 'number', default: 3, min: 0, max: 20, step: 0.5, unit: 'mm', visible: is('plate', 'bracket') },
        {
          key: 'boltFit',
          label: tr('Bolt holes'),
          type: 'select',
          default: 'clearance',
          help: tr('Selects the fit of the bolt holes.'),
          options: [
            { value: 'clearance', label: trx('hole', 'Clearance') },
            { value: 'tap', label: tr('Tapped') },
          ],
          visible: is('plate', 'holes', 'bracket'),
        },
        { key: 'holeLength', label: tr('Length'), type: 'number', default: 20, min: 1, max: 100, step: 0.5, unit: 'mm', help: tr('Sets the length of the hole cutters.'), visible: is('holes') },
      ],
    },
    {
      title: tr('Body'),
      params: [
        { key: 'length', label: tr('Body length'), type: 'number', default: 0, min: 0, max: 200, step: 0.5, unit: 'mm', help: tr('Sets the body length behind the mounting face. 0 takes the usual length.'), visible: is('body') },
        { key: 'shaftLength', label: tr('Shaft length'), type: 'number', default: 0, min: 0, max: 100, step: 0.5, unit: 'mm', help: tr('Sets the shaft length. 0 takes the usual length.'), visible: is('body') },
      ],
    },
    {
      title: tr('Foot'),
      params: [
        { key: 'footLength', label: tr('Foot length'), type: 'number', default: 30, min: 5, max: 150, step: 1, unit: 'mm', help: tr('Sets how far the foot runs back from the upright.'), visible: is('bracket') },
        {
          key: 'footScrew',
          label: tr('Foot screws'),
          type: 'select',
          default: 'M4',
          options: ['M3', 'M4', 'M5'].map((s) => ({ value: s, label: s })),
          visible: is('bracket'),
        },
        { key: 'slotLength', label: tr('Slot length'), type: 'number', default: 10, min: 0, max: 60, step: 1, unit: 'mm', help: tr('Sets the length of the slots in the foot. 0 makes round holes.'), visible: is('bracket') },
        { key: 'gusset', label: tr('Gusset'), type: 'boolean', default: true, help: tr('Adds a triangular web either side, between the upright and the foot.'), visible: is('bracket') },
      ],
    },
  ];
}

// --- build --------------------------------------------------------------------------------

/** The shaft as the inspector describes it: its size, the width across its flat and how far off the middle of the face it is, where it has either. */
function shaftText(shaft: Motor['shaft'], unit: Unit): string {
  const { d, len, flat, at } = shaft;
  const size = `Ø${lengthsText(unit, [d, len])}`;
  if (flat && at) return tr('{size}, {flat} across the flat, {off} off center', { size, flat: lengthText(flat, unit), off: lengthText(at[0], unit) });
  if (flat) return tr('{size}, {flat} across the flat', { size, flat: lengthText(flat, unit) });
  if (at) return tr('{size}, {off} off center', { size, off: lengthText(at[0], unit) });
  return size;
}

function build(motors: Motor[], p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const m = motors.find((x) => x.id === str(p, 'motor')) ?? motors[0];
  let make = form(p);
  if (make === 'bracket' && !m.bracket) {
    warnings.push(tr('An L-bracket does not suit the {motor}; a plate is made instead.', { motor: m.label }));
    make = 'plate';
  }
  const grow = num(p, 'clearance');
  const n = q.circle;
  const screw = SCREWS[m.screw];
  const info: InfoItem[] = [];
  const holesText = (unit: Unit) => {
    const xs = [...new Set(m.holes.map((h) => h[0]))];
    const ys = [...new Set(m.holes.map((h) => h[1]))];
    // Six holes all as far from the shaft as each other lie on a circle of twice that.
    const reach = m.holes.map(([x, y]) => Math.hypot(x, y));
    const ringed = m.holes.length === 6 && reach.every((r) => Math.abs(r - reach[0]) < 1e-6);
    const count = m.holes.length;
    if (count === 4 && xs.length === 2 && ys.length === 2) return `${count} × ${m.screw}, ${lengthsText(unit, [Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0])], 2)}`;
    if (count === 2 && ys.length === 1) return tr('{n} × {screw}, {distance} apart', { n: count, screw: m.screw, distance: lengthFixed(Math.abs(xs[1] - xs[0]), unit, 2) });
    if (ringed) return tr('{n} × {screw}, on a {diameter} circle', { n: count, screw: m.screw, diameter: lengthText(2 * reach[0], unit) });
    return plural(count, '{n} × {screw}, {n} hole', '{n} × {screw}, {n} holes', { screw: m.screw });
  };
  if (m.holes.length) info.push(unitInfo(tr('Bolt pattern'), holesText));
  const pilot = m.pilot;
  if (pilot) info.push(unitInfo(tr('Pilot'), (unit) => `Ø${lengthsText(unit, [pilot.d, pilot.h])}`));
  const through = m.through;
  if (through) info.push(unitInfo(tr('Body through'), (unit) => lengthsText(unit, [through.w, through.h])));
  info.push(unitInfo(tr('Shaft'), (unit) => shaftText(m.shaft, unit)));
  const outline: Shape2D = [faceOutline(m, 0, q), ...m.holes.map(([x, y]) => circle(screw.clearance / 2, 24, x, y)), bore(m, 0, q)];

  const boltD = str(p, 'boltFit') === 'tap' ? screw.tap : screw.clearance;

  if (make === 'plate' || make === 'bracket') {
    const t = num(p, 'thickness');
    const plate = plateOutline(m, num(p, 'margin'), num(p, 'corner'), grow, q);
    const shape: Shape2D = [plate, ...m.holes.map(([x, y]) => circle(boltD / 2, n, x, y)), bore(m, grow, q)];
    const { min, max } = extentOf(plate);
    info.push(unitInfo(trx('mount', 'Plate'), (unit) => `${figureFixed(max[0] - min[0], unit, 1)} × ${figureFixed(max[1] - min[1], unit, 1)} × ${lengthText(t, unit)}`));
    if (make === 'plate') return { solid: extrude(shape, t), outline, info, warnings };

    // The bracket: the plate stood up on its lower edge, the motor on its -Y side, a slotted foot behind.
    const H = max[1] - min[1];
    const W = max[0] - min[0];
    const upright = translate(rotate(extrude(shape, t), [90, 0, 0]), [0, 0, H / 2]);
    const footLen = num(p, 'footLength');
    const foot = SCREWS[str(p, 'footScrew')].clearance;
    let slotLen = num(p, 'slotLength');
    if (slotLen > footLen - foot) {
      slotLen = Math.max(0, footLen - foot);
      warnings.push(said((unit) => tr('The slots were shortened to {length} to stay inside the foot.', { length: lengthFixed(slotLen, unit, 1) })));
    }
    const footShape: Shape2D = [roundedRect(0, footLen / 2, W, footLen, Math.min(num(p, 'corner'), footLen / 2 - 0.1), q)];
    const sx = W / 2 - num(p, 'margin');
    const sy = footLen / 2;
    for (const s of [-1, 1]) footShape.push(slotLen > 0 ? stadium(s * sx, sy, foot, slotLen, q) : circle(foot / 2, n, s * sx, sy));
    const footSolid = translate(extrude(footShape, t), [0, 0, 0]);
    const pieces: Solid[] = [upright, footSolid];
    if (bool(p, 'gusset')) {
      // Triangular webs at the outer edges, from the foot up the upright.
      const reach = Math.min(footLen - 2, H - t);
      const web: Polygon = [
        [0, t],
        [reach, t],
        [0, t + reach],
      ];
      for (const s of [-1, 1]) {
        // The web lies in the YZ plane: made in XY (y across, z up), stood up, then moved to the side.
        const slab = extrude([web], t);
        pieces.push(translate(rotate(slab, [90, 0, 90]), [s * (W / 2) - (s > 0 ? t : 0), 0, 0]));
      }
    }
    info.push(
      unitInfo(tr('Foot'), (unit) => {
        const size = `${figureFixed(W, unit, 1)} × ${lengthText(footLen, unit)}`;
        return slotLen > 0 ? tr('{size}, {screw} slots', { size, screw: str(p, 'footScrew') }) : tr('{size}, {screw} holes', { size, screw: str(p, 'footScrew') });
      }),
    );
    return { solid: union(...pieces), outline, info, warnings };
  }

  if (make === 'holes') {
    const len = num(p, 'holeLength');
    const pins: Solid[] = m.holes.map(([x, y]) => translate(cylinder(boltD / 2, len, n), [x, y, -len / 2]));
    pins.push(translate(extrude([bore(m, grow, q)], len), [0, 0, -len / 2]));
    info.push(unitInfo(tr('Bolt holes'), (unit) => `Ø${lengthFixed(boltD, unit, 2)}`));
    return { solid: union(...pins), outline, info, warnings };
  }

  // The motor itself: body behind the face (and above it for a servo), tabs, pilot, shaft.
  const below = num(p, 'length') || m.body.below;
  const shaftLen = num(p, 'shaftLength') || m.shaft.len;
  const [bx, by] = m.face.at ?? [0, 0];
  const bodyOutline = m.body.round ? circle(m.body.w / 2, n, bx, by) : roundedRect(bx, by, m.body.w, m.body.h, m.body.r ?? 0, q);
  const pieces: Solid[] = [translate(extrude([bodyOutline], below + (m.body.above ?? 0)), [0, 0, -below])];
  if (m.tabs) pieces.push(extrude([roundedRect(...(m.tabs.at ?? [0, 0]), m.tabs.w, m.tabs.h, Math.min(3.5, m.tabs.h / 2), q)], m.tabs.t));
  const top = m.body.above ?? 0;
  if (m.pilot) pieces.push(translate(cylinder(m.pilot.d / 2, m.pilot.h, n), [...(m.pilot.at ?? [0, 0]), top]));
  const pilotH = m.pilot?.h ?? 0;
  if (shaftLen > pilotH) pieces.push(translate(extrude([shaftSection(m.shaft.d, m.shaft.flat, q)], shaftLen - pilotH), [...(m.shaft.at ?? [0, 0]), top + pilotH]));
  else warnings.push(tr('The shaft is shorter than the pilot boss, so no shaft is shown.'));
  info.push(unitInfo(tr('Body'), (unit) => tr('{size} behind the face', { size: m.body.round ? `Ø${lengthsText(unit, [m.body.w, below])}` : lengthsText(unit, [m.body.w, m.body.h, below]) })));
  return { solid: union(...pieces), outline, info, warnings };
}

function extentOf(poly: Polygon): { min: Vec2; max: Vec2 } {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/** A slot running along Y: `d` wide, `len` between the end centers. */
function stadium(cx: number, cy: number, d: number, len: number, q: Quality): Polygon {
  const r = d / 2;
  const n = Math.max(4, Math.round(q.circle / 2));
  return [...arc(cx, cy - len / 2, r, Math.PI, 2 * Math.PI, n), ...arc(cx, cy + len / 2, r, 0, Math.PI, n)];
}

function family(id: string, name: string, summary: string, motors: Motor[]): GeneratorDef {
  return { id, name, category: 'motors', summary, groups: groups(motors), build: (p, q) => build(motors, p, q) };
}

export const stepper = family('stepper-mount', tr('Stepper'), tr('Mounting plate, holes or bracket for a stepper motor.'), STEPPERS);
export const gearmotor = family('gearmotor-mount', tr('Gearmotor'), tr('Mounting plate, holes or bracket for a gearmotor.'), GEARMOTORS);
export const servo = family('servo-mount', tr('Servo'), tr('Mounting plate, holes or bracket for a servo.'), SERVOS);
export const dcMotor = family('dc-motor-mount', tr('DC motor'), tr('Mounting plate, holes or bracket for a DC motor.'), DC_MOTORS);

export const MOTORS: GeneratorDef[] = [stepper, gearmotor, servo, dcMotor];
export const ALL_MOTORS: Motor[] = [...STEPPERS, ...GEARMOTORS, ...SERVOS, ...DC_MOTORS];
