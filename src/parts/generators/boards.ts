// Mounts for the development boards that end up in most enclosures: the
// Raspberry Pi range, the common Arduinos, the ESP32 dev kits and the NVIDIA
// Jetson developer-kit carriers. Each board
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
// drawing shows them; the app centers the part afterwards.
import { tr, trx } from '../../i18n';
import { arc, circle, offsetPolygon, roundedRectFrom } from '../math2d';
import { cylinder, difference, extrude, rotate, translate, union } from '../types';
import type { Polygon, Quality, Shape2D, Solid, Vec2 } from '../types';
import { lengthInfo, num, lengthsText, str, unitInfo } from './types';
import type { BuildResult, GeneratorDef, InfoItem, ParamGroup, Params } from './types';
import { figureFixed, lengthFigure, lengthFixed, lengthText, said } from '../../units';
import type { Unit } from '../../units';

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
  /** A module that reaches past the +X end of the board, centered on its width: the antenna end of an ESP32 kit. */
  overhang?: { length: number; width: number };
  /** The board's own outline, CCW from its lower-left corner, when it is not a rounded rectangle. */
  outline?: (q: Quality) => Polygon;
  /** A line or two for the dropdown: holes, orientation, what to check. */
  note: string;
  /** The sockets along the board's edges, from its drawing. */
  sockets?: EdgeSocket[];
}

/** The kinds of socket found along a board's edge, each with the envelope of the plug that mates with it. */
type Socket = 'usb-c' | 'micro-usb' | 'mini-usb' | 'micro-hdmi' | 'mini-hdmi' | 'hdmi' | 'displayport' | 'hdmi-dp-stack' | 'usb-a-stack' | 'rj45' | 'av-jack' | 'barrel' | 'usb-b';

/** Plug envelopes (width along the edge × height), centered on the socket: the USB-IF overmold maxima, typical HDMI, DisplayPort and AV plugs, a stacked pair of USB-A plugs, an HDMI plug under a DisplayPort one. */
type Plug = { w: number; h: number; r: number };
const PLUGS: Record<Socket, Plug> = {
  'usb-c': { w: 12.35, h: 6.5, r: 2.5 },
  'micro-usb': { w: 10.6, h: 8.5, r: 1.5 },
  'mini-usb': { w: 11.5, h: 8, r: 1.5 },
  'micro-hdmi': { w: 12.6, h: 7, r: 2 },
  'mini-hdmi': { w: 13.5, h: 8, r: 2 },
  hdmi: { w: 20.5, h: 10.5, r: 2.5 },
  displayport: { w: 20, h: 10, r: 2.5 },
  'hdmi-dp-stack': { w: 20.5, h: 22, r: 2.5 },
  'usb-a-stack': { w: 16, h: 17, r: 1.5 },
  rj45: { w: 16.4, h: 13.5, r: 0.5 },
  'av-jack': { w: 9, h: 9, r: 4.5 },
  barrel: { w: 10.5, h: 10.5, r: 5.25 },
  'usb-b': { w: 16.5, h: 12.5, r: 1.5 },
};

/**
 * A socket on a board's edge: which edge of the board's frame it sits on, where its center is along
 * that edge (from the frame's origin corner), its body's width along the edge and height above the
 * PCB top, and how far the body stands out past the edge.
 */
export interface EdgeSocket {
  name: string;
  socket: Socket;
  edge: 'left' | 'right' | 'bottom';
  at: number;
  w: number;
  h: number;
  out: number;
  /** A plug envelope other than the socket kind's usual one: an opening that takes every plug a board family uses. */
  plug?: Plug;
}

const plugOf = (s: EdgeSocket): Plug => s.plug ?? PLUGS[s.socket];

// Socket positions and widths are read from the boards' drawings (the Pi drawings print the positions,
// widths are measured off them to ±0.3), the Uno's and Nano's from Arduino's Eagle and STEP files, the
// DevKitC's from Espressif's DXF; the DevKit V1 and NodeMCU-32S, which have no maker drawing, from a
// real-size community drawing and the maker's photo. Heights the drawings omit (micro USB 2.9, the
// Uno's jack and USB-B 11) are typical.
const PI_END = (ports: [string, Socket, number, number, number, number][]): EdgeSocket[] => ports.map(([name, socket, at, w, h, out]) => ({ name, socket, edge: 'right', at, w, h, out }));
const PI_LONG = (ports: [string, Socket, number, number, number, number][]): EdgeSocket[] => ports.map(([name, socket, at, w, h, out]) => ({ name, socket, edge: 'bottom', at, w, h, out }));
const PI5_SOCKETS: EdgeSocket[] = [
  ...PI_LONG([
    [tr('USB-C power'), 'usb-c', 11.2, 9, 3.2, 1.3],
    ['Micro HDMI 0', 'micro-hdmi', 25.8, 7.1, 3.4, 1.7],
    ['Micro HDMI 1', 'micro-hdmi', 39.2, 7.1, 3.4, 1.7],
  ]),
  ...PI_END([
    ['Ethernet', 'rj45', 10.2, 16, 13.5, 3],
    [tr('USB pair'), 'usb-a-stack', 29.1, 13.1, 16, 3],
    [tr('USB pair'), 'usb-a-stack', 47, 13.1, 16, 3],
  ]),
];
const PI4_SOCKETS: EdgeSocket[] = [
  ...PI_LONG([
    [tr('USB-C power'), 'usb-c', 11.2, 8.7, 3.2, 1.2],
    ['Micro HDMI 0', 'micro-hdmi', 26, 7.1, 3, 1.4],
    ['Micro HDMI 1', 'micro-hdmi', 39.5, 7.1, 3, 1.4],
    [tr('AV jack'), 'av-jack', 53.5, 6, 6, 2.5],
  ]),
  ...PI_END([
    [tr('USB pair'), 'usb-a-stack', 9, 13.1, 16, 3],
    [tr('USB pair'), 'usb-a-stack', 27, 13.1, 16, 3],
    ['Ethernet', 'rj45', 45.75, 15.5, 13.5, 3],
  ]),
];
const PI3_SOCKETS: EdgeSocket[] = [
  ...PI_LONG([
    [tr('Micro USB power'), 'micro-usb', 10.6, 8.1, 2.9, 1.3],
    ['HDMI', 'hdmi', 32, 14.4, 6.5, 1.5],
    [tr('AV jack'), 'av-jack', 53.5, 7, 6, 2.6],
  ]),
  ...PI_END([
    ['Ethernet', 'rj45', 10.25, 15.5, 13.5, 2],
    [tr('USB pair'), 'usb-a-stack', 29, 13.2, 16, 2],
    [tr('USB pair'), 'usb-a-stack', 47, 13.1, 16, 2],
  ]),
];
const ZERO_SOCKETS: EdgeSocket[] = PI_LONG([
  ['Mini HDMI', 'mini-hdmi', 12.4, 10.9, 3.2, 0.5],
  ['Micro USB', 'micro-usb', 41.4, 8.1, 2.9, 1.2],
  [tr('Micro USB power'), 'micro-usb', 54, 8.1, 2.9, 1.2],
]);
const UNO_SOCKETS: EdgeSocket[] = [
  { name: tr('Power jack'), socket: 'barrel', edge: 'left', at: 7.8, w: 9, h: 11, out: 1.8 },
  { name: 'USB-B', socket: 'usb-b', edge: 'left', at: 38.1, w: 11.8, h: 11, out: 6.34 },
];

const piHoles = (width: number): Vec2[] => [
  [3.5, 3.5],
  [61.5, 3.5],
  [3.5, width - 3.5],
  [61.5, width - 3.5],
];

export const RASPBERRY_PI: Board[] = [
  { id: 'pi5', label: 'Raspberry Pi 5', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.7, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left, GPIO header along the top, power and HDMI along the bottom.', sockets: PI5_SOCKETS, note: tr('Four M2.5 holes, 58 × 49 mm. USB and Ethernet on the right, GPIO header along the top.') },
  { id: 'pi4', label: 'Raspberry Pi 4 Model B', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.7, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left, GPIO header along the top, power, HDMI and audio along the bottom.', sockets: PI4_SOCKETS, note: tr('Four M2.5 holes, 58 × 49 mm. USB and Ethernet on the right, GPIO header along the top.') },
  { id: 'pi3', label: 'Raspberry Pi 3 Model B / B+', length: 85, width: 56, corner: 3, holes: piHoles(56), holeDiameter: 2.75, screw: 'M2.5', layout: 'USB and Ethernet on the right, SD card slot on the left, GPIO header along the top, power, HDMI and audio along the bottom.', sockets: PI3_SOCKETS, note: tr('Four M2.5 holes, 58 × 49 mm. USB and Ethernet on the right, GPIO header along the top.') },
  { id: 'pi-zero-2', label: 'Raspberry Pi Zero / Zero 2 W', length: 65, width: 30, corner: 3, holes: piHoles(30), holeDiameter: 2.75, screw: 'M2.5', layout: 'Mini HDMI and micro USB along the bottom long edge, SD card slot on the left. The holes sit 3.5 mm in from every edge, so the pattern is the same whichever way round.', sockets: ZERO_SOCKETS, note: tr('Four M2.5 holes, 58 × 23 mm. Ports along the bottom long edge, SD card on the left.') },
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
    sockets: [{ name: 'Micro USB', socket: 'micro-usb', edge: 'left', at: 10.5, w: 8, h: 2.9, out: 1.3 }],
    note: tr('Four M2 holes, 47 × 11.4 mm. Micro USB on the left.'),
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
  { id: 'uno', label: 'Arduino Uno (R3 / R4)', length: 68.58, width: 53.34, corner: 1, holes: unoHoles, holeDiameter: 3.2, screw: 'M3', layout: 'USB and power jack on the left, the notched end on the right.', outline: (q) => arduinoOutline(68.58, q), sockets: UNO_SOCKETS, note: tr('Four M3 holes in the Uno pattern, which shields share. USB and power jack on the left.') },
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
    sockets: UNO_SOCKETS,
    note: tr('The Uno\'s four holes plus two near the far end. USB and power jack on the left.'),
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
    layout: 'USB on the left, centered on the board\'s width on every Nano: mini USB on the classic, micro USB on the Every, USB-C on the Nano ESP32. Usually held by its header pins instead; the corner holes, 1.27 mm in from every edge, take M1.6 screws.',
    // One socket stands for the three connectors: the classic's mini-B body (the tallest and the furthest out) and an
    // opening wide enough for a USB-C plug and tall enough for a micro-B one.
    sockets: [{ name: tr('USB (mini-B; micro-B on the Every, C on the Nano ESP32)'), socket: 'mini-usb', edge: 'left', at: 8.89, w: 7.7, h: 3.9, out: 1.8, plug: { w: 12.35, h: 8.5, r: 1.5 } }],
    note: tr('Four M1.6 holes 1.27 mm in from the corners. USB on the left, centered.'),
  },
];

export const ESP32: Board[] = [
  {
    id: 'esp32-devkitc',
    label: tr('ESP32-DevKitC V4 (38 pin)'),
    length: 48.26,
    width: 27.94,
    corner: 1,
    holes: [],
    holeDiameter: 0,
    screw: 'M3',
    layout: 'Micro USB on the left. The module\'s antenna reaches 6 mm past the right-hand end of the board, which the blank, the pocket and the corner stops allow for. No mounting holes.',
    overhang: { length: 6.04, width: 18 },
    sockets: [{ name: 'Micro USB', socket: 'micro-usb', edge: 'left', at: 13.95, w: 7.4, h: 2.9, out: 0.95 }],
    note: tr('No holes: blank, pocket or corner stops. Antenna reaches 6 mm past the right end.'),
  },
  {
    id: 'esp32-devkit-v1',
    label: tr('ESP32 DevKit V1 (30 pin)'),
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
    layout: 'Micro USB on the left, centered on the board\'s width, antenna on the right. The holes sit 2.2 mm in from every edge.',
    sockets: [{ name: 'Micro USB', socket: 'micro-usb', edge: 'left', at: 14.1, w: 7.5, h: 2.9, out: 1 }],
    note: tr('Four holes 2.2 mm in from the corners. USB on the left, antenna on the right.'),
  },
  {
    id: 'nodemcu-32s',
    label: tr('NodeMCU-32S (38 pin)'),
    length: 48.3,
    width: 25.4,
    corner: 1,
    holes: [],
    holeDiameter: 0,
    screw: 'M3',
    layout: 'Micro USB on the left, centered on the board\'s width, antenna on the right. No mounting holes.',
    sockets: [{ name: 'Micro USB', socket: 'micro-usb', edge: 'left', at: 12.7, w: 7.5, h: 2.9, out: 1 }],
    note: tr('No holes: blank, pocket or corner stops.'),
  },
];

// The Jetson developer kits all come on the same 100 × 79 carrier with the same M2.5 holes, the ports along
// one long edge in the same order. The Orin Nano carrier's drawing (NVIDIA SP-11324) gives the holes and the
// ports to ±0.3 mm; the Xavier NX kit's drawing (SP-09765) and the Nano kit's layout, which NVIDIA keeps behind
// a login and is known from a posted screenshot, agree with it to a millimetre. Heights are the connectors'
// usual ones; the module stack above the carrier is for the case lid.
const JETSON_HOLES = (third: boolean): Vec2[] => [
  [4, 17],
  [90, 17],
  ...(third ? ([[96, 17]] as Vec2[]) : []),
  [4, 75],
  [90, 75],
  ...(third ? ([[96, 75]] as Vec2[]) : []),
];
const JETSON_PORTS = (display: EdgeSocket, last: EdgeSocket): EdgeSocket[] => [
  { name: tr('Power jack'), socket: 'barrel', edge: 'bottom', at: 6, w: 9, h: 11, out: 1.6 },
  display,
  { name: tr('USB pair'), socket: 'usb-a-stack', edge: 'bottom', at: 42.6, w: 13.4, h: 16.5, out: 1.6 },
  { name: tr('USB pair'), socket: 'usb-a-stack', edge: 'bottom', at: 59.6, w: 13.3, h: 16.5, out: 1.6 },
  { name: 'Ethernet', socket: 'rj45', edge: 'bottom', at: 77, w: 16.1, h: 13.5, out: 1.6 },
  last,
];
const HDMI_DP: EdgeSocket = { name: tr('HDMI and DisplayPort'), socket: 'hdmi-dp-stack', edge: 'bottom', at: 23, w: 16.3, h: 19.4, out: 1.6 };
const JETSON_MICRO_USB: EdgeSocket = { name: 'Micro USB', socket: 'micro-usb', edge: 'bottom', at: 92, w: 7.5, h: 2.9, out: 1 };
const JETSON_LAYOUT = 'Ports along the bottom long edge, left to right: power jack, display, two USB pairs, Ethernet and the small USB. Camera connectors on the left end, the 40-pin header along the right end. The module and its heatsink stand on the far half of the board.';

export const JETSON: Board[] = [
  {
    id: 'jetson-nano',
    label: 'Jetson Nano Developer Kit (A02 / B01)',
    length: 100,
    width: 79,
    corner: 2,
    holes: JETSON_HOLES(false),
    holeDiameter: 2.75,
    screw: 'M2.5',
    layout: `${JETSON_LAYOUT} Module and heatsink reach about 27 mm above the carrier.`,
    sockets: JETSON_PORTS(HDMI_DP, JETSON_MICRO_USB),
    note: tr('Four M2.5 holes, 86 × 58 mm. Ports along the bottom edge.'),
  },
  {
    id: 'jetson-orin-nano',
    label: 'Jetson Orin Nano / Orin NX Developer Kit',
    length: 100,
    width: 79,
    corner: 2,
    holes: JETSON_HOLES(true),
    holeDiameter: 2.7,
    screw: 'M2.5',
    layout: `${JETSON_LAYOUT} The outer four holes carry the kit's base plate. Module, heatsink and fan reach about 28.5 mm above the carrier; the M.2 cards underneath need 4.3 mm.`,
    sockets: JETSON_PORTS({ name: 'DisplayPort', socket: 'displayport', edge: 'bottom', at: 22.8, w: 16.4, h: 7, out: 1.6 }, { name: 'USB-C', socket: 'usb-c', edge: 'bottom', at: 91.9, w: 9.2, h: 3.3, out: 1 }),
    note: tr('Six M2.5 holes: the Nano\'s four plus two by the header end. DisplayPort and USB-C.'),
  },
  {
    id: 'jetson-xavier-nx',
    label: 'Jetson Xavier NX Developer Kit',
    length: 100,
    width: 79,
    corner: 2,
    holes: JETSON_HOLES(true),
    holeDiameter: 2.7,
    screw: 'M2.5',
    layout: `${JETSON_LAYOUT} The outer four holes carry the kit's base plate. Module, heatsink and fan reach about 28.5 mm above the carrier.`,
    sockets: JETSON_PORTS(HDMI_DP, JETSON_MICRO_USB),
    note: tr('The Orin Nano kit\'s carrier and holes, with HDMI, DisplayPort and micro USB.'),
  },
];

// --- 2D helpers ------------------------------------------------------------------

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** The board outline grown by `grow` all round. */
const outlineOf = (b: Board, grow: number, q: Quality): Polygon =>
  b.outline ? offsetPolygon(b.outline(q), grow) : roundedRectFrom(-grow, -grow, b.length + 2 * grow, b.width + 2 * grow, b.corner + grow, q);

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

type Form = 'standoffs' | 'holes' | 'blank' | 'corners' | 'connectors';
const form = (p: Params) => str(p, 'form') as Form;
const is = (...forms: Form[]) => (p: Params) => forms.includes(form(p));
const onBase = (p: Params) => is('standoffs', 'corners')(p) && str(p, 'base') === 'plate';

function groups(boards: Board[], defaultForm: Form): ParamGroup[] {
  return [
    {
      title: tr('Board'),
      params: [
        { key: 'board', label: tr('Board'), type: 'select', default: boards[0].id, options: boards.map((b) => ({ value: b.id, label: b.label, note: b.note })) },
        {
          key: 'form',
          label: tr('Make'),
          type: 'select',
          default: defaultForm,
          help: tr('Selects the build target for the chosen board.'),
          options: [
            { value: 'standoffs', label: tr('Standoffs') },
            { value: 'holes', label: tr('Mounting holes') },
            { value: 'blank', label: tr('Board blank') },
            { value: 'connectors', label: tr('Board & connectors') },
            { value: 'corners', label: tr('Corner stops') },
          ],
        },
      ],
    },
    {
      title: tr('Standoffs'),
      params: [
        { key: 'postHeight', label: tr('Height'), type: 'number', default: 6, min: 1, max: 60, step: 0.5, unit: 'mm', help: tr('Sets the standoff height to the underside of the board.'), visible: is('standoffs') },
        { key: 'postDiameter', label: tr('Diameter'), type: 'number', default: 6, min: 2, max: 20, step: 0.5, unit: 'mm', visible: is('standoffs') },
      ],
    },
    {
      title: tr('Stops'),
      params: [
        { key: 'stopHeight', label: tr('Height'), type: 'number', default: 5, min: 1, max: 60, step: 0.5, unit: 'mm', help: tr('Sets the height of the corner stops.'), visible: is('corners') },
        { key: 'stopThickness', label: tr('Thickness'), type: 'number', default: 2, min: 0.8, max: 10, step: 0.1, unit: 'mm', visible: is('corners') },
        { key: 'stopLength', label: tr('Leg length'), type: 'number', default: 8, min: 2, max: 40, step: 0.5, unit: 'mm', help: tr('Sets how far each stop runs along the two edges it holds.'), visible: is('corners') },
        { key: 'stopGap', label: tr('Gap'), type: 'number', default: 0.3, min: 0, max: 3, step: 0.05, unit: 'mm', help: tr('Sets the room between the board and the stops.'), visible: is('corners') },
      ],
    },
    {
      title: tr('Screw'),
      params: [
        {
          key: 'holeKind',
          label: tr('Hole'),
          type: 'select',
          default: 'tap',
          help: tr('Selects how the mounting holes are sized for the board\'s screws.'),
          options: [
            { value: 'tap', label: tr('Tapped') },
            { value: 'clearance', label: trx('hole', 'Clearance') },
            { value: 'insert', label: tr('Heat-set insert') },
            { value: 'custom', label: tr('Custom diameter') },
            { value: 'none', label: tr('No hole') },
          ],
          visible: is('standoffs', 'holes'),
        },
        { key: 'holeDiameter', label: tr('Diameter'), type: 'number', default: 2.8, min: 0.5, max: 12, step: 0.05, unit: 'mm', visible: (p) => is('standoffs', 'holes')(p) && str(p, 'holeKind') === 'custom' },
        { key: 'holeLength', label: tr('Length'), type: 'number', default: 20, min: 1, max: 100, step: 0.5, unit: 'mm', help: tr('Sets the length of the hole cutters.'), visible: is('holes') },
      ],
    },
    {
      title: tr('Blank'),
      params: [
        { key: 'blankGap', label: tr('Gap all round'), type: 'number', default: 0, min: 0, max: 3, step: 0.05, unit: 'mm', help: tr('Adds clearance around the board blank. Any gap makes it a pocket cutter and removes the holes.'), visible: is('blank') },
        { key: 'blankThickness', label: tr('Thickness'), type: 'number', default: 1.6, min: 0.5, max: 60, step: 0.1, unit: 'mm', help: tr('Sets the thickness of the blank, or the depth of the pocket.'), visible: is('blank') },
      ],
    },
    {
      title: tr('Connectors'),
      params: [
        { key: 'reach', label: tr('Reach'), type: 'number', default: 15, min: 0, max: 60, step: 0.5, unit: 'mm', help: tr('Sets how far every connector reaches beyond the board edge.'), visible: is('connectors') },
        {
          key: 'fit',
          label: tr('Past the edge'),
          type: 'select',
          default: 'plug',
          help: tr('Selects whether the plugs or the socket bodies extend past the board edge.'),
          options: [
            { value: 'plug', label: tr('Plugs') },
            { value: 'body', label: tr('Socket bodies') },
          ],
          visible: is('connectors'),
        },
      ],
    },
    {
      title: tr('Base'),
      params: [
        {
          key: 'base',
          label: tr('Base'),
          type: 'select',
          default: 'none',
          help: tr('Adds a plate under the posts or stops, the shape of the board with a margin.'),
          options: [
            { value: 'none', label: trx('base', 'None') },
            { value: 'plate', label: tr('Base plate') },
          ],
          visible: is('standoffs', 'corners'),
        },
        { key: 'baseMargin', label: tr('Margin'), type: 'number', default: 3, min: 0, max: 30, step: 0.5, unit: 'mm', help: tr('Sets how far the plate reaches beyond the board edge.'), visible: onBase },
        { key: 'baseThickness', label: tr('Thickness'), type: 'number', default: 2, min: 0.5, max: 20, step: 0.1, unit: 'mm', visible: onBase },
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
function spacing(holes: Vec2[], unit: Unit): string | null {
  const xs = [...new Set(holes.map((h) => h[0]))];
  const ys = [...new Set(holes.map((h) => h[1]))];
  if (holes.length !== 4 || xs.length !== 2 || ys.length !== 2) return null;
  return lengthsText(unit, [Math.abs(xs[1] - xs[0]), Math.abs(ys[1] - ys[0])], 2);
}

/** A socket as the inspector describes it: its body, where it sits along its edge, and the plug's envelope when that is what is cut. */
function socketText(s: EdgeSocket, forPlug: boolean, unit: Unit): string {
  const body = { size: lengthsText(unit, [s.w, s.h], 1), at: lengthFixed(s.at, unit, 2) };
  if (!forPlug) {
    if (s.edge === 'left') return tr('{size}, {at} along the left edge', body);
    if (s.edge === 'right') return tr('{size}, {at} along the right edge', body);
    return tr('{size}, {at} along the bottom edge', body);
  }
  const plug = { ...body, plug: `${lengthFigure(plugOf(s).w, unit)} × ${lengthFigure(plugOf(s).h, unit)}` };
  if (s.edge === 'left') return tr('{size}, {at} along the left edge, plug {plug}', plug);
  if (s.edge === 'right') return tr('{size}, {at} along the right edge, plug {plug}', plug);
  return tr('{size}, {at} along the bottom edge, plug {plug}', plug);
}

function build(boards: Board[], p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const b = boards.find((x) => x.id === str(p, 'board')) ?? boards[0];
  let make = form(p);
  if (b.holes.length === 0 && (make === 'standoffs' || make === 'holes')) {
    warnings.push(tr('The {board} has no mounting holes, so corner stops are made instead.', { board: b.label }));
    make = 'corners';
  }
  const n = q.circle;
  const info: InfoItem[] = [unitInfo(tr('Board'), (unit) => lengthsText(unit, [b.length, b.width], 2))];
  if (b.holes.length) {
    info.push(unitInfo(tr('Holes'), (unit) => `${b.holes.length} × Ø${lengthText(b.holeDiameter, unit)}, ${b.screw}`));
    if (spacing(b.holes, 'mm')) info.push(unitInfo(tr('Hole spacing'), (unit) => spacing(b.holes, unit) ?? ''));
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
      warnings.push(said((unit) => tr('The posts were widened to {diameter} to leave a wall round the {hole} hole.', { diameter: lengthFixed(d, unit, 1), hole: lengthText(hole, unit) })));
    }
    const posts = b.holes.map(([x, y]) => translate(cylinder(d / 2, height, n), [x, y, baseT]));
    let solid = union(...plate(), ...posts);
    if (hole > 0) {
      // Through the post only: a base plate keeps its floor.
      const cutters = b.holes.map(([x, y]) => translate(cylinder(hole / 2, height + 1, n), [x, y, base ? baseT : -0.5]));
      solid = difference(solid, ...cutters);
    }
    info.push(unitInfo(tr('Posts'), (unit) => `Ø${lengthsText(unit, [d, height], 1)}`), hole > 0 ? lengthInfo(tr('Hole'), hole, 2) : { label: tr('Hole'), value: tr('none') });
    return { solid, outline, info, warnings };
  }

  if (make === 'holes') {
    let hole = drill(p, b);
    if (hole <= 0) {
      hole = SCREWS[b.screw].clearance;
      warnings.push(tr('Hole is set to None, so the cutters take the {screw} clearance size.', { screw: b.screw }));
    }
    const length = num(p, 'holeLength');
    const pins = b.holes.map(([x, y]) => translate(cylinder(hole / 2, length, n), [x, y, 0]));
    info.push(unitInfo(tr('Hole'), (unit) => `Ø${figureFixed(hole, unit, 2)} × ${lengthFixed(length, unit, 1)}`));
    return { solid: union(...pins), outline, info, warnings };
  }

  if (make === 'connectors') {
    const reach = num(p, 'reach');
    const forPlug = str(p, 'fit') === 'plug';
    const PCB = 1.6;
    const INBOARD = 8;
    const pieces: Solid[] = [slab(b, 0, PCB, true, q)];
    const sockets = b.sockets ?? [];
    if (sockets.length === 0) warnings.push(tr('No socket positions are recorded for the {board} yet: this is the blank alone.', { board: b.label }));
    for (const s of sockets) {
      // The socket body: a block from a little inside the edge to where the body stops (or on to the reach).
      const bodyOut = forPlug ? s.out : Math.max(s.out, reach);
      const box = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Solid =>
        translate(extrude([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], z1 - z0), [0, 0, z0]);
      if (s.edge === 'bottom') pieces.push(box(s.at - s.w / 2, -bodyOut, s.at + s.w / 2, INBOARD, PCB, PCB + s.h));
      else if (s.edge === 'right') pieces.push(box(b.length - INBOARD, s.at - s.w / 2, b.length + bodyOut, s.at + s.w / 2, PCB, PCB + s.h));
      else pieces.push(box(-bodyOut, s.at - s.w / 2, INBOARD, s.at + s.w / 2, PCB, PCB + s.h));
      if (forPlug && reach > 0) {
        // The plug envelope, from the edge outwards, centered on the socket.
        const plug = plugOf(s);
        const face = roundedRectFrom(-plug.w / 2, -plug.h / 2, plug.w, plug.h, plug.r, q);
        const along = extrude([face], reach);
        const zc = PCB + s.h / 2;
        if (s.edge === 'bottom') pieces.push(translate(rotate(along, [90, 0, 0]), [s.at, 0, zc]));
        else if (s.edge === 'right') pieces.push(translate(rotate(along, [90, 0, 90]), [b.length, s.at, zc]));
        else pieces.push(translate(rotate(along, [90, 0, -90]), [0, s.at, zc]));
      }
    }
    // A plug body can hang below the PCB: say so, since the part then stands that much lower than the board.
    const lowest = forPlug ? Math.min(0, ...sockets.map((s) => PCB + s.h / 2 - plugOf(s).h / 2)) : 0;
    info.push(
      unitInfo('PCB', (unit) => tr('{thickness} thick, holes included', { thickness: lengthText(PCB, unit) })),
      ...(lowest < 0 ? [unitInfo(tr('Base'), (unit) => tr('{depth} below the PCB underside: a plug hangs lower than the board', { depth: lengthFixed(-lowest, unit, 1) }))] : []),
      ...sockets.map((s) => unitInfo(s.name, (unit) => socketText(s, forPlug, unit))),
      lengthInfo(tr('Reach'), reach, 1),
    );
    return { solid: union(...pieces), outline, info, warnings };
  }

  if (make === 'blank') {
    const gap = num(p, 'blankGap');
    const t = num(p, 'blankThickness');
    const reach = b.length + (b.overhang?.length ?? 0);
    info.push(unitInfo(tr('Slab'), (unit) => `${figureFixed(reach + 2 * gap, unit, 2)} × ${figureFixed(b.width + 2 * gap, unit, 2)} × ${lengthFixed(t, unit, 1)}`));
    return { solid: slab(b, gap, t, gap === 0, q), outline, info, warnings };
  }

  // Corner stops: a block over each corner of the board's box, with the board itself, grown by the
  // gap, carved out of it. On a plain board that leaves an L; on a notched or rounded corner the
  // stop follows the notch, so it holds the board where the board actually is.
  const gap = num(p, 'stopGap');
  const height = num(p, 'stopHeight');
  const t = num(p, 'stopThickness');
  const leg = Math.min(num(p, 'stopLength'), b.length / 2, b.width / 2);
  if (base && num(p, 'baseMargin') < gap + t) warnings.push(said((unit) => tr('The stops overhang the base: a margin of at least {margin} covers them.', { margin: lengthFixed(gap + t, unit, 1) })));
  // At an end the module reaches past, the legs across that end stop short of it.
  const endLeg = b.overhang ? Math.max(1, Math.min(leg, (b.width - b.overhang.width) / 2 - gap - 0.5)) : leg;
  if (endLeg < leg) info.push(lengthInfo(tr('Legs at the antenna end'), endLeg, 1));
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
  info.push(
    unitInfo(tr('Stops'), (unit) => tr('{thickness} thick, {height} high, legs {leg}', { thickness: lengthFixed(t, unit, 1), height: lengthFixed(height, unit, 1), leg: lengthFixed(leg, unit, 1) })),
    unitInfo(tr('Pocket'), (unit) => lengthsText(unit, [b.length + 2 * gap, b.width + 2 * gap], 2)),
  );
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

export const raspberryPi = family('raspberry-pi', 'Raspberry Pi', tr('Mounts and cutouts for Raspberry Pi boards.'), RASPBERRY_PI, 'standoffs');
export const arduino = family('arduino', 'Arduino', tr('Mounts and cutouts for Arduino boards.'), ARDUINO, 'standoffs');
export const esp32 = family('esp32', 'ESP32', tr('Mounts and cutouts for ESP32 dev kits.'), ESP32, 'corners');
export const jetson = family('jetson', 'NVIDIA Jetson', tr('Mounts and cutouts for Jetson developer kits.'), JETSON, 'standoffs');

export const BOARDS: GeneratorDef[] = [raspberryPi, arduino, esp32, jetson];
export const ALL_BOARDS: Board[] = [...RASPBERRY_PI, ...ARDUINO, ...ESP32, ...JETSON];
