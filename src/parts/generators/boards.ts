// Mounts for the development boards that end up in most enclosures: the
// Raspberry Pi range, the common Arduinos and the ESP32 dev kits. Each board
// is a table row read from its maker's mechanical drawing: outline, corner
// radius and the mounting holes with the screw they take. From that one row
// the part can be:
//
//   - standoffs: a post at every hole, drilled for the screw, a heat-set
//     insert or left plain, on an optional base plate;
//   - holes: a pin at every hole, to group with a floor or lid as a hole;
//   - blank: a slab the shape of the board, a dummy for checking fit, or
//     grown by a gap and made a hole to pocket a floor;
//   - corner stops: four L-shaped blocks round the board's corners, which
//     hold a board that has no mounting holes.
//
// Boards lie along X with the origin at their lower-left corner as the
// drawing shows them; the app centres the part afterwards.
import { arc, circle, offsetPolygon } from '../math2d';
import { cylinder, difference, extrude, translate, union } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { mm, num, str } from './types';
import type { BuildResult, GeneratorDef, ParamGroup, Params } from './types';

/** Drill sizes for a screw in printed plastic: the screw cutting its own thread, a clearance hole, a heat-set insert. */
const SCREWS: Record<string, { tap: number; clearance: number; insert: number }> = {
  'M1.6': { tap: 1.35, clearance: 1.8, insert: 2.5 },
  M2: { tap: 1.7, clearance: 2.4, insert: 3.2 },
  'M2.5': { tap: 2.1, clearance: 2.8, insert: 3.5 },
  M3: { tap: 2.6, clearance: 3.4, insert: 4 },
};

export interface Board {
  id: string;
  label: string;
  /** Along X and Y. */
  length: number;
  width: number;
  corner: number;
  /** Mounting holes from the lower-left corner; empty for a board without any. */
  holes: Vec2[];
  holeDiameter: number;
  screw: keyof typeof SCREWS;
  /** Which way the board lies, for the help text. */
  layout: string;
  /** A module that reaches past the +X end of the board, centred on its width: the antenna end of an ESP32 kit. */
  overhang?: { length: number; width: number };
  /** The board's own outline, CCW from its lower-left corner, when it is not a rounded rectangle. */
  outline?: (q: Quality) => Polygon;
  /** Shown as a warning: clones of this board differ. */
  caution?: string;
}

const piHoles = (width: number): Vec2[] => [
  [3.5, 3.5],
  [61.5, 3.5],
  [3.5, width - 3.5],
  [61.5, width - 3.5],
];

export const RASPBERRY_PI: Board[] = [
  { id: 'pi5', label: 'Raspberry Pi 5', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.7, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left.' },
  { id: 'pi4', label: 'Raspberry Pi 4 Model B', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.7, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left.' },
  { id: 'pi3', label: 'Raspberry Pi 3 Model B / B+', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.75, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left.' },
  { id: 'pi-zero-2', label: 'Raspberry Pi Zero / Zero 2 W', length: 65, width: 30, corner: 3, holes: piHoles(30), holeDiameter: 2.75, screw: 'M2.5', layout: 'Mini HDMI and micro USB along the bottom long edge. The holes sit 3.5 mm in from every edge, so the pattern is the same whichever way round.' },
  {
    id: 'pico',
    label: 'Raspberry Pi Pico / Pico W / Pico 2',
    length: 51,
    width: 21,
    corner: 1,
    holes: [
      [2, 4.8],
      [49, 4.8],
      [2, 16.2],
      [49, 16.2],
    ],
    holeDiameter: 2.1,
    screw: 'M2',
    layout: 'Micro USB on the left.',
  },
];

const unoHoles: Vec2[] = [
  [13.97, 2.54],
  [15.24, 50.8],
  [66.04, 7.62],
  [66.04, 35.56],
];

/**
 * The Uno outline, which the Mega stretches: 53.34 wide, with the right-hand
 * end 2.54 narrower above and below a band from 5.08 to 37.85 up, 45° jogs
 * between, a 1.52 chamfer at the top-right corner and 1 mm radii on the other
 * three. Read from Arduino's own Eagle board files.
 */
function arduinoOutline(length: number, q: Quality): Polygon {
  const w = 53.34;
  const step = 2.54;
  const x1 = length - step;
  const n = Math.max(2, Math.round(q.circle / 4));
  return [
    ...arc(1, 1, 1, Math.PI, 1.5 * Math.PI, n),
    ...arc(x1 - 1, 1, 1, -Math.PI / 2, 0, n),
    [x1, 2.54],
    [length, 5.08],
    [length, 37.846],
    [x1, 40.386],
    [x1, 51.816],
    [x1 - 1.524, w],
    ...arc(1, w - 1, 1, Math.PI / 2, Math.PI, n),
  ];
}

export const ARDUINO: Board[] = [
  { id: 'uno', label: 'Arduino Uno (R3 / R4)', length: 68.58, width: 53.34, corner: 1, holes: unoHoles, holeDiameter: 3.2, screw: 'M3', layout: 'USB and power jack on the left, the notched end on the right.', outline: (q) => arduinoOutline(68.58, q) },
  {
    id: 'mega',
    label: 'Arduino Mega 2560',
    length: 101.6,
    width: 53.34,
    corner: 1,
    holes: [...unoHoles, [90.17, 50.8], [96.52, 2.54]],
    holeDiameter: 3.2,
    screw: 'M3',
    layout: 'USB and power jack on the left, the notched end on the right.',
    outline: (q) => arduinoOutline(101.6, q),
  },
  {
    id: 'nano',
    label: 'Arduino Nano / Nano Every / Nano ESP32',
    length: 43.18,
    width: 17.78,
    corner: 1,
    holes: [
      [1.27, 1.27],
      [41.91, 1.27],
      [1.27, 16.51],
      [41.91, 16.51],
    ],
    holeDiameter: 1.8,
    screw: 'M1.6',
    layout: 'USB on the left. Usually held by its header pins instead; the corner holes, 1.27 mm in from every edge, take M1.6 screws.',
  },
];

export const ESP32: Board[] = [
  {
    id: 'esp32-devkitc',
    label: 'ESP32-DevKitC V4 (38 pin)',
    length: 48.26,
    width: 27.94,
    corner: 1,
    holes: [],
    holeDiameter: 0,
    screw: 'M3',
    layout: 'Micro USB on the left. The module\'s antenna reaches 6 mm past the right-hand end of the board, which the blank, the pocket and the corner stops allow for. No mounting holes.',
    overhang: { length: 6.04, width: 18 },
    caution: 'Clones of this board differ by a millimetre or two, and some have the antenna flush with the end: measure yours.',
  },
  {
    id: 'esp32-devkit-v1',
    label: 'ESP32 DevKit V1 (30 pin)',
    length: 51.8,
    width: 28.2,
    corner: 1,
    holes: [
      [2.2, 2.2],
      [49.6, 2.2],
      [2.2, 26],
      [49.6, 26],
    ],
    holeDiameter: 2.8,
    screw: 'M2.5',
    layout: 'Micro USB on the left, antenna on the right. The holes sit 2.2 mm in from every edge.',
    caution: 'No maker\'s drawing exists for this board; these figures are measured from real ones and clones differ by up to half a millimetre. Some have no holes.',
  },
  {
    id: 'nodemcu-32s',
    label: 'NodeMCU-32S (38 pin)',
    length: 48.3,
    width: 25.4,
    corner: 1,
    holes: [],
    holeDiameter: 0,
    screw: 'M3',
    layout: 'Micro USB on the left, antenna on the right. No mounting holes.',
    caution: 'Only the overall size is published for this board, and clones differ: measure yours.',
  },
];

// --- 2D helpers ------------------------------------------------------------------

/** CCW rounded rectangle with its lower-left corner at (x, y). */
function roundedRect(x: number, y: number, w: number, h: number, r: number, q: Quality): Polygon {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0)
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  const n = Math.max(2, Math.round(q.circle / 4));
  return [
    ...arc(x + w - r, y + r, r, -Math.PI / 2, 0, n),
    ...arc(x + w - r, y + h - r, r, 0, Math.PI / 2, n),
    ...arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, n),
    ...arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI, n),
  ];
}

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** The board outline grown by `grow` all round. */
const outlineOf = (b: Board, grow: number, q: Quality): Polygon =>
  b.outline ? offsetPolygon(b.outline(q), grow) : roundedRect(-grow, -grow, b.length + 2 * grow, b.width + 2 * grow, b.corner + grow, q);

/** The module's reach past the +X end, grown by `grow`, as a rectangle overlapping the board's edge. */
const overhangOf = (b: Board, grow: number): Polygon | null =>
  b.overhang ? rect(b.length - 1, (b.width - b.overhang.width) / 2 - grow, b.length + b.overhang.length + grow, (b.width + b.overhang.width) / 2 + grow) : null;

/** A slab of the board's footprint, overhang included. */
function slab(b: Board, grow: number, thickness: number, holes: boolean, q: Quality): Solid {
  const shape: Shape2D = [outlineOf(b, grow, q), ...(holes ? b.holes.map(([x, y]) => circle(b.holeDiameter / 2, q.circle, x, y).reverse()) : [])];
  const over = overhangOf(b, grow);
  return over ? union(extrude(shape, thickness), extrude([over], thickness)) : extrude(shape, thickness);
}

// --- parameters ------------------------------------------------------------------

type Form = 'standoffs' | 'holes' | 'blank' | 'corners';
const form = (p: Params) => str(p, 'form') as Form;
const is = (...forms: Form[]) => (p: Params) => forms.includes(form(p));
const onBase = (p: Params) => is('standoffs', 'corners')(p) && str(p, 'base') === 'plate';

function groups(boards: Board[], defaultForm: Form): ParamGroup[] {
  return [
    {
      title: 'Board',
      params: [
        { key: 'board', label: 'Board', type: 'select', default: boards[0].id, options: boards.map((b) => ({ value: b.id, label: b.label })) },
        {
          key: 'form',
          label: 'Make',
          type: 'select',
          default: defaultForm,
          help: 'Standoffs are posts at the mounting holes. Holes are pins to cut the holes with. The blank is a slab the shape of the board, for checking fit or, grown by a gap and made a hole, for a pocket. Corner stops hold a board that has no holes.',
          options: [
            { value: 'standoffs', label: 'Standoffs' },
            { value: 'holes', label: 'Mounting holes' },
            { value: 'blank', label: 'Board blank' },
            { value: 'corners', label: 'Corner stops' },
          ],
        },
      ],
    },
    {
      title: 'Standoffs',
      params: [
        { key: 'postHeight', label: 'Height', type: 'number', default: 6, min: 1, max: 60, step: 0.5, unit: 'mm', help: 'From the base, or from whatever the posts stand on, to the underside of the board.', visible: is('standoffs') },
        { key: 'postDiameter', label: 'Diameter', type: 'number', default: 6, min: 2, max: 20, step: 0.5, unit: 'mm', visible: is('standoffs') },
      ],
    },
    {
      title: 'Stops',
      params: [
        { key: 'stopHeight', label: 'Height', type: 'number', default: 5, min: 1, max: 60, step: 0.5, unit: 'mm', help: 'How far the stops rise above the base, or above whatever they stand on.', visible: is('corners') },
        { key: 'stopThickness', label: 'Thickness', type: 'number', default: 2, min: 0.8, max: 10, step: 0.1, unit: 'mm', visible: is('corners') },
        { key: 'stopLength', label: 'Leg length', type: 'number', default: 8, min: 2, max: 40, step: 0.5, unit: 'mm', help: 'How far each stop runs along the two edges it holds.', visible: is('corners') },
        { key: 'stopGap', label: 'Gap to the board', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05, unit: 'mm', help: 'Room between the board and the stops. 0.3 mm suits most printers.', visible: is('corners') },
      ],
    },
    {
      title: 'Screw',
      params: [
        {
          key: 'holeKind',
          label: 'Hole',
          type: 'select',
          default: 'tap',
          help: 'Tap: the screw cuts its own thread in the plastic. Clearance: the screw passes through, for a nut or a threaded post. Insert: a heat-set brass insert. The size follows the screw the board takes.',
          options: [
            { value: 'tap', label: 'Screw cuts its thread' },
            { value: 'clearance', label: 'Clearance' },
            { value: 'insert', label: 'Heat-set insert' },
            { value: 'custom', label: 'Custom diameter' },
            { value: 'none', label: 'No hole' },
          ],
          visible: is('standoffs', 'holes'),
        },
        { key: 'holeDiameter', label: 'Diameter', type: 'number', default: 2.8, min: 0.5, max: 12, step: 0.05, unit: 'mm', visible: (p) => is('standoffs', 'holes')(p) && str(p, 'holeKind') === 'custom' },
        { key: 'holeLength', label: 'Length', type: 'number', default: 20, min: 1, max: 100, step: 0.5, unit: 'mm', help: 'Long enough to pass right through what it cuts.', visible: is('holes') },
      ],
    },
    {
      title: 'Blank',
      params: [
        { key: 'blankGap', label: 'Gap all round', type: 'number', default: 0, min: 0, max: 3, step: 0.05, unit: 'mm', help: '0 is the board itself, holes included. A gap makes it a pocket cutter: the holes are left out so that the pocket is clear.', visible: is('blank') },
        { key: 'blankThickness', label: 'Thickness', type: 'number', default: 1.6, min: 0.5, max: 60, step: 0.1, unit: 'mm', help: '1.6 mm is the board. For a pocket, the depth of the pocket.', visible: is('blank') },
      ],
    },
    {
      title: 'Base',
      params: [
        {
          key: 'base',
          label: 'Base',
          type: 'select',
          default: 'none',
          help: 'A plate under the posts or stops, the shape of the board with a margin, so the mount is one printable piece.',
          options: [
            { value: 'none', label: 'None' },
            { value: 'plate', label: 'Plate under the board' },
          ],
          visible: is('standoffs', 'corners'),
        },
        { key: 'baseMargin', label: 'Margin', type: 'number', default: 3, min: 0, max: 30, step: 0.5, unit: 'mm', help: 'How far the plate reaches beyond the board edge.', visible: onBase },
        { key: 'baseThickness', label: 'Thickness', type: 'number', default: 2, min: 0.5, max: 20, step: 0.1, unit: 'mm', visible: onBase },
      ],
    },
  ];
}

// --- build -----------------------------------------------------------------------

/** The drill diameter for the hole choice, or 0 for none. */
function drill(p: Params, b: Board): number {
  const kind = str(p, 'holeKind');
  if (kind === 'none') return 0;
  if (kind === 'custom') return num(p, 'holeDiameter');
  return SCREWS[b.screw][kind as 'tap' | 'clearance' | 'insert'];
}

/** Hole spacing as a user would quote it, when the holes sit on a rectangle. */
function spacing(holes: Vec2[]): string | null {
  const xs = [...new Set(holes.map((h) => h[0]))];
  const ys = [...new Set(holes.map((h) => h[1]))];
  if (holes.length !== 4 || xs.length !== 2 || ys.length !== 2) return null;
  return `${Math.abs(xs[1] - xs[0]).toFixed(2)} × ${Math.abs(ys[1] - ys[0]).toFixed(2)} mm`;
}

function build(boards: Board[], p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const b = boards.find((x) => x.id === str(p, 'board')) ?? boards[0];
  if (b.caution) warnings.push(b.caution);
  let make = form(p);
  if (b.holes.length === 0 && (make === 'standoffs' || make === 'holes')) {
    warnings.push(`The ${b.label} has no mounting holes, so corner stops are made instead.`);
    make = 'corners';
  }
  const n = q.circle;
  const info: { label: string; value: string }[] = [{ label: 'Board', value: `${b.length.toFixed(2)} × ${b.width.toFixed(2)} mm` }];
  if (b.holes.length) {
    info.push({ label: 'Holes', value: `${b.holes.length} × Ø${b.holeDiameter} mm, ${b.screw}` });
    const s = spacing(b.holes);
    if (s) info.push({ label: 'Hole spacing', value: s });
  }
  const outline: Shape2D = [outlineOf(b, 0, q), ...b.holes.map(([x, y]) => circle(b.holeDiameter / 2, 24, x, y).reverse())];

  const base = onBase(p);
  const baseT = base ? num(p, 'baseThickness') : 0;
  const plate = (): Solid[] => (base ? [slab(b, num(p, 'baseMargin'), baseT, false, q)] : []);

  if (make === 'standoffs') {
    const height = num(p, 'postHeight');
    let d = num(p, 'postDiameter');
    const hole = drill(p, b);
    if (hole > 0 && d < hole + 1.6) {
      d = hole + 1.6;
      warnings.push(`The posts were widened to ${d.toFixed(1)} mm to leave a wall round the ${hole} mm hole.`);
    }
    const posts = b.holes.map(([x, y]) => translate(cylinder(d / 2, height, n), [x, y, baseT]));
    let solid = union(...plate(), ...posts);
    if (hole > 0) {
      // Through the post only: a base plate keeps its floor.
      const cutters = b.holes.map(([x, y]) => translate(cylinder(hole / 2, height + 1, n), [x, y, base ? baseT : -0.5]));
      solid = difference(solid, ...cutters);
    }
    info.push({ label: 'Posts', value: `Ø${d.toFixed(1)} × ${height.toFixed(1)} mm` }, { label: 'Hole', value: hole > 0 ? mm(hole, 2) : 'none' });
    return { solid, outline, info, warnings };
  }

  if (make === 'holes') {
    let hole = drill(p, b);
    if (hole <= 0) {
      hole = SCREWS[b.screw].clearance;
      warnings.push('A hole template needs a hole: the clearance size is used.');
    }
    const length = num(p, 'holeLength');
    const pins = b.holes.map(([x, y]) => translate(cylinder(hole / 2, length, n), [x, y, 0]));
    info.push({ label: 'Hole', value: `Ø${hole.toFixed(2)} × ${length.toFixed(1)} mm` });
    return { solid: union(...pins), outline, info, warnings };
  }

  if (make === 'blank') {
    const gap = num(p, 'blankGap');
    const t = num(p, 'blankThickness');
    const reach = b.length + (b.overhang?.length ?? 0);
    info.push({ label: 'Slab', value: `${(reach + 2 * gap).toFixed(2)} × ${(b.width + 2 * gap).toFixed(2)} × ${t.toFixed(1)} mm` });
    return { solid: slab(b, gap, t, gap === 0, q), outline, info, warnings };
  }

  // Corner stops: a block over each corner of the board's box, with the board itself, grown by the
  // gap, carved out of it. On a plain board that leaves an L; on a notched or rounded corner the
  // stop follows the notch, so it holds the board where the board actually is.
  const gap = num(p, 'stopGap');
  const height = num(p, 'stopHeight');
  const t = num(p, 'stopThickness');
  const leg = Math.min(num(p, 'stopLength'), b.length / 2, b.width / 2);
  if (base && num(p, 'baseMargin') < gap + t) warnings.push(`The stops overhang the base: a margin of at least ${(gap + t).toFixed(1)} mm covers them.`);
  // At an end the module reaches past, the legs across that end stop short of it.
  const endLeg = b.overhang ? Math.max(1, Math.min(leg, (b.width - b.overhang.width) / 2 - gap - 0.5)) : leg;
  if (endLeg < leg) warnings.push(`The legs across the antenna end are ${endLeg.toFixed(1)} mm, to clear the module.`);
  const x0 = -gap;
  const y0 = -gap;
  const x1 = b.length + gap;
  const y1 = b.width + gap;
  const stops: Polygon[] = [
    rect(x0 - t, y0 - t, x0 + leg, y0 + leg),
    rect(x1 - leg, y0 - t, x1 + t, y0),
    rect(x1 - leg, y0 - t, x1 + t, y0 + endLeg),
    rect(x0 - t, y1 - leg, x0 + leg, y1 + t),
    rect(x1 - leg, y1, x1 + t, y1 + t),
    rect(x1 - leg, y1 - endLeg, x1 + t, y1 + t),
  ];
  const carved = difference(union(...stops.map((s) => extrude([s], height))), translate(slab(b, gap, height + 2, false, q), [0, 0, -1]));
  const blocks = [translate(carved, [0, 0, baseT])];
  info.push({ label: 'Stops', value: `${t.toFixed(1)} mm thick, ${height.toFixed(1)} mm high, legs ${leg.toFixed(1)} mm` }, { label: 'Pocket', value: `${(b.length + 2 * gap).toFixed(2)} × ${(b.width + 2 * gap).toFixed(2)} mm` });
  return { solid: union(...plate(), ...blocks), outline, info, warnings };
}

function family(id: string, name: string, summary: string, boards: Board[], defaultForm: Form): GeneratorDef {
  return {
    id,
    name,
    category: 'boards',
    summary,
    groups: groups(boards, defaultForm),
    build: (p, q) => build(boards, p, q),
  };
}

export const raspberryPi = family('raspberry-pi', 'Raspberry Pi', 'Mounts for the Raspberry Pi 5, 4, 3, Zero 2 W and Pico: standoffs, hole templates, a blank or corner stops.', RASPBERRY_PI, 'standoffs');
export const arduino = family('arduino', 'Arduino', 'Mounts for the Arduino Uno, Mega and Nano: standoffs, hole templates, a blank or corner stops.', ARDUINO, 'standoffs');
export const esp32 = family('esp32', 'ESP32', 'Mounts for the ESP32 dev kits: corner stops or a pocket for the ones without holes, standoffs for the DevKit V1.', ESP32, 'corners');

export const BOARDS: GeneratorDef[] = [raspberryPi, arduino, esp32];
export const ALL_BOARDS: Board[] = [...RASPBERRY_PI, ...ARDUINO, ...ESP32];
