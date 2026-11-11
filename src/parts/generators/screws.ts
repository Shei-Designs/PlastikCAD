// Printable fasteners: ISO metric bolts and nuts, trapezoidal lead screws and their nuts,
// and the holes that take a metric screw with its head, nut or insert.
import { tr, trx } from '../../i18n';
import { handParam, isLeftHanded } from '../features';
import { regularPolygon } from '../math2d';
import {
  isoMetricProfile,
  profileExtent,
  threadedRod,
  threadSolid,
  trapezoidalClearance,
  trapezoidalProfile,
} from '../threads';
import type { AxialProfile } from '../threads';
import { cylinder, difference, extrude, intersection, revolve, rotate, translate, union } from '../types';
import type { Polygon, Quality, Solid } from '../types';
import { bool, mm, num, str } from './types';
import type { GeneratorDef, ParamDef, Params } from './types';

interface MetricSize {
  d: number;
  /** Coarse pitch (ISO 261). */
  pitch: number;
  /** Hex across flats (ISO 4017 / 4032). */
  af: number;
  /** Hex head height (ISO 4017). */
  headHeight: number;
  /** Nut height (ISO 4032). */
  nutHeight: number;
  /** Socket cap head diameter and hex key size (ISO 4762). */
  capDiameter: number;
  socket: number;
  /** Clearance hole for the screw: close, normal and loose (ISO 273 fine, medium and coarse). */
  clearance: [number, number, number];
  /** Head diameter of a countersunk screw, to its sharp edge (ISO 10642; DIN 965 below M3). */
  sunk: number;
  /** Bore for a heat-set insert, for the sizes the insert makers agree on. */
  insert?: number;
}

const METRIC: Record<string, MetricSize> = {
  M2: { d: 2, pitch: 0.4, af: 4, headHeight: 1.4, nutHeight: 1.6, capDiameter: 3.8, socket: 1.5, clearance: [2.2, 2.4, 2.6], sunk: 3.8, insert: 3.2 },
  'M2.5': { d: 2.5, pitch: 0.45, af: 5, headHeight: 1.7, nutHeight: 2, capDiameter: 4.5, socket: 2, clearance: [2.7, 2.9, 3.1], sunk: 4.7, insert: 4 },
  M3: { d: 3, pitch: 0.5, af: 5.5, headHeight: 2, nutHeight: 2.4, capDiameter: 5.5, socket: 2.5, clearance: [3.2, 3.4, 3.6], sunk: 6.72, insert: 4 },
  M4: { d: 4, pitch: 0.7, af: 7, headHeight: 2.8, nutHeight: 3.2, capDiameter: 7, socket: 3, clearance: [4.3, 4.5, 4.8], sunk: 8.96, insert: 5.6 },
  M5: { d: 5, pitch: 0.8, af: 8, headHeight: 3.5, nutHeight: 4.7, capDiameter: 8.5, socket: 4, clearance: [5.3, 5.5, 5.8], sunk: 11.2, insert: 6.4 },
  M6: { d: 6, pitch: 1, af: 10, headHeight: 4, nutHeight: 5.2, capDiameter: 10, socket: 5, clearance: [6.4, 6.6, 7], sunk: 13.44, insert: 8 },
  M8: { d: 8, pitch: 1.25, af: 13, headHeight: 5.3, nutHeight: 6.8, capDiameter: 13, socket: 6, clearance: [8.4, 9, 10], sunk: 17.92 },
  M10: { d: 10, pitch: 1.5, af: 16, headHeight: 6.4, nutHeight: 8.4, capDiameter: 16, socket: 8, clearance: [10.5, 11, 12], sunk: 22.4 },
  M12: { d: 12, pitch: 1.75, af: 18, headHeight: 7.5, nutHeight: 10.8, capDiameter: 18, socket: 10, clearance: [13, 13.5, 14.5], sunk: 26.88 },
  M14: { d: 14, pitch: 2, af: 21, headHeight: 8.8, nutHeight: 12.8, capDiameter: 21, socket: 12, clearance: [15, 15.5, 16.5], sunk: 30.8 },
  M16: { d: 16, pitch: 2, af: 24, headHeight: 10, nutHeight: 14.8, capDiameter: 24, socket: 14, clearance: [17, 17.5, 18.5], sunk: 33.6 },
  M20: { d: 20, pitch: 2.5, af: 30, headHeight: 12.5, nutHeight: 18, capDiameter: 30, socket: 17, clearance: [21, 22, 24], sunk: 40.32 },
};

/** The sizes a hole is made for: every one in the table. */
export const HOLE_SIZES = Object.keys(METRIC);
/** The sizes offered as printed bolts and nuts: below M3 a printed thread is too fine to hold. */
export const METRIC_SIZES = HOLE_SIZES.filter((name) => METRIC[name].d >= 3);

/** Extra width of the hex key socket so that a real key fits a printed recess. */
const SOCKET_FIT = 0.2;

const sizeParam: ParamDef = {
  type: 'select',
  key: 'size',
  label: tr('Size'),
  default: 'M8',
  options: METRIC_SIZES.map((value) => ({ value, label: `${value} × ${METRIC[value].pitch}` })),
};

const pitchParam: ParamDef = {
  type: 'number',
  key: 'pitch',
  label: tr('Custom pitch'),
  help: tr('Leave at 0 for the standard coarse pitch. A coarser pitch prints more reliably on small sizes.'),
  default: 0,
  min: 0,
  max: 6,
  step: 0.05,
  unit: 'mm',
};


const clearanceParam = (def: number, help: string): ParamDef => ({
  type: 'number',
  key: 'clearance',
  label: tr('Thread clearance'),
  help,
  default: def,
  min: 0,
  max: 0.6,
  step: 0.05,
  unit: 'mm',
});

function metricPitch(p: Params, size: MetricSize, warnings: string[]): number {
  const custom = num(p, 'pitch');
  if (custom <= 0) return size.pitch;
  const max = size.d / 2;
  if (custom > max) warnings.push(tr('The pitch was limited to {max} mm for this diameter.', { max }));
  return Math.min(max, Math.max(0.2, custom));
}

/**
 * Share of the basic thread depth that still overlaps when a screw and a nut are
 * both made with the given clearances.
 */
function engagement(size: MetricSize, pitch: number, screwClearance: number, nutClearance: number): number {
  const crest = profileExtent(isoMetricProfile(size.d, pitch, -screwClearance)).rMax;
  const bore = profileExtent(isoMetricProfile(size.d, pitch, nutClearance)).rMin;
  return (crest - bore) / ((5 / 8) * (Math.sqrt(3) / 2) * pitch);
}

function checkEngagement(size: MetricSize, pitch: number, clearance: number, warnings: string[]) {
  const share = engagement(size, pitch, clearance, clearance);
  if (share < 0.4) {
    warnings.push(
      tr('Only {percent}% of the thread depth engages with this clearance. Reduce the clearance or use a coarser pitch.', { percent: Math.max(0, Math.round(share * 100)) }),
    );
  }
}

/** 45° countersinks that ease a screw into both ends of a threaded hole spanning 0..height. */
function countersinks(profile: AxialProfile, height: number, q: Quality): Solid[] {
  const { rMin, rMax } = profileExtent(profile);
  const depth = Math.min(rMax + 0.1 - rMin, height / 4);
  const over = 0.5;
  const wide = rMin + depth + over;
  const h = depth + over;
  return [
    translate(cylinder(wide, h, q.circle, rMin), [0, 0, -over]),
    translate(cylinder(rMin, h, q.circle, wide), [0, 0, height - depth]),
  ];
}

/** Hex prism spanning 0..height, optionally with the usual 30° chamfer on both faces. */
function hexBody(af: number, height: number, chamfer: boolean, q: Quality): Solid {
  const hex = [regularPolygon(6, af / 2)];
  if (!chamfer) return extrude(hex, height);
  const flatRadius = 0.465 * af;
  const outer = af / 2 / Math.cos(Math.PI / 6) + 0.5;
  const rise = Math.min((outer - flatRadius) * Math.tan(Math.PI / 6), height / 3);
  const envelope: Polygon = [
    [0, 0],
    [flatRadius, 0],
    [outer, rise],
    [outer, height - rise],
    [flatRadius, height],
    [0, height],
  ];
  return intersection(translate(extrude(hex, height + 1), [0, 0, -0.5]), revolve(envelope, q.circle));
}

export const metricBolt: GeneratorDef = {
  id: 'metric-bolt',
  name: tr('Metric bolt / threaded rod'),
  category: 'screws',
  summary: tr('ISO metric screw with a hex or socket head, or a plain threaded rod.'),
  groups: [
    {
      title: tr('Thread'),
      params: [
        sizeParam,
        pitchParam,
        {
          type: 'number',
          key: 'length',
          label: tr('Length'),
          help: tr('Threaded length, measured from under the head.'),
          default: 30,
          min: 2,
          max: 300,
          step: 1,
          unit: 'mm',
        },
        clearanceParam(0.15, tr('The thread is shrunk by this amount so that it turns freely in a nut. 0.1–0.2 mm suits FDM.')),
        { type: 'boolean', key: 'chamfer', label: tr('Chamfered end'), default: true },
        handParam,
      ],
    },
    {
      title: tr('Head'),
      params: [
        {
          type: 'select',
          key: 'head',
          label: tr('Type'),
          default: 'hex',
          options: [
            { value: 'hex', label: tr('Hex head') },
            { value: 'socket', label: tr('Socket cap') },
            { value: 'none', label: tr('None (threaded rod)') },
          ],
        },
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const size = METRIC[str(p, 'size')];
    const pitch = metricPitch(p, size, warnings);
    const length = num(p, 'length');
    const head = str(p, 'head');
    const chamfer = bool(p, 'chamfer');
    const leftHanded = isLeftHanded(p);
    const clearance = num(p, 'clearance');
    checkEngagement(size, pitch, clearance, warnings);
    const profile = isoMetricProfile(size.d, pitch, -clearance);
    const { rMin, rMax } = profileExtent(profile);

    let solid: Solid;
    let headHeight = 0;
    if (head === 'none') {
      solid = threadedRod({ profile, pitch, length, leftHanded, q, chamferBottom: chamfer, chamferTop: chamfer });
    } else {
      headHeight = head === 'hex' ? size.headHeight : size.d;
      // The head sits on the build plate; the shank starts slightly inside it.
      const embed = Math.min(headHeight / 2, pitch);
      const shank = translate(
        threadedRod({ profile, pitch, length: length + embed, leftHanded, q, chamferTop: chamfer }),
        [0, 0, headHeight - embed],
      );
      let headSolid: Solid;
      if (head === 'hex') {
        headSolid = extrude([regularPolygon(6, size.af / 2)], headHeight);
      } else {
        const recess = extrude([regularPolygon(6, (size.socket + SOCKET_FIT) / 2)], 0.55 * size.d + 1);
        headSolid = difference(cylinder(size.capDiameter / 2, headHeight, q.circle), translate(recess, [0, 0, -1]));
      }
      solid = union(headSolid, shank);
    }

    const info = [
      { label: tr('Major diameter'), value: mm(rMax * 2) },
      { label: tr('Minor diameter'), value: mm(rMin * 2) },
      { label: tr('Pitch'), value: mm(pitch) },
    ];
    if (head === 'hex') info.push({ label: tr('Across flats'), value: mm(size.af, 1) });
    if (head === 'socket') {
      info.push({ label: tr('Head diameter'), value: mm(size.capDiameter, 1) });
      info.push({ label: tr('Hex key'), value: mm(size.socket, 1) });
    }
    if (headHeight > 0) info.push({ label: tr('Head height'), value: mm(headHeight, 1) });
    info.push({ label: tr('Total length'), value: mm(headHeight + length, 1) });
    return { solid, info, warnings };
  },
};

export const metricNut: GeneratorDef = {
  id: 'metric-nut',
  name: tr('Metric nut'),
  category: 'screws',
  summary: tr('ISO metric hex nut with a printable internal thread.'),
  groups: [
    {
      title: tr('Nut'),
      params: [
        sizeParam,
        pitchParam,
        {
          type: 'number',
          key: 'height',
          label: tr('Custom height'),
          help: tr('Leave at 0 for the standard (ISO 4032) nut height.'),
          default: 0,
          min: 0,
          max: 100,
          step: 0.5,
          unit: 'mm',
        },
        clearanceParam(0.2, tr('The thread is cut oversize by this amount so that a screw turns freely in it.')),
        {
          type: 'boolean',
          key: 'chamfer',
          label: tr('Chamfered'),
          help: tr('Chamfers the hex corners and adds a lead-in to the thread.'),
          default: true,
        },
        handParam,
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const size = METRIC[str(p, 'size')];
    const pitch = metricPitch(p, size, warnings);
    const custom = num(p, 'height');
    const height = custom > 0 ? custom : size.nutHeight;
    const chamfer = bool(p, 'chamfer');
    const clearance = num(p, 'clearance');
    checkEngagement(size, pitch, clearance, warnings);
    const profile = isoMetricProfile(size.d, pitch, clearance);
    const { rMin, rMax } = profileExtent(profile);

    const cutter = threadSolid({
      profile,
      pitch,
      length: height + 2 * pitch,
      leftHanded: isLeftHanded(p),
      q,
    });
    const cuts = [translate(cutter, [0, 0, -pitch])];
    if (chamfer) cuts.push(...countersinks(profile, height, q));
    const solid = difference(hexBody(size.af, height, chamfer, q), ...cuts);

    return {
      solid,
      info: [
        { label: tr('Thread major diameter'), value: mm(rMax * 2) },
        { label: tr('Thread minor diameter'), value: mm(rMin * 2) },
        { label: tr('Pitch'), value: mm(pitch) },
        { label: tr('Across flats'), value: mm(size.af, 1) },
        { label: tr('Height'), value: mm(height, 1) },
      ],
      warnings,
    };
  },
};

const FITS = ['close', 'normal', 'loose'];
const isKind = (kind: string) => (p: Params) => str(p, 'kind') === kind;
const hasRecess = (...recesses: string[]) => (p: Params) => str(p, 'kind') === 'clearance' && recesses.includes(str(p, 'recess'));

/**
 * The hole a metric screw goes into, as a solid to cut out of another object:
 * standing on the plate, its axis at the origin, its mouth (where the screw
 * goes in, and where its head or nut sits) at the top. Clearance holes are
 * those of ISO 273; a recess is as much wider than the head or nut as the
 * hole is than the screw.
 */
export const screwHole: GeneratorDef = {
  id: 'screw-hole',
  name: tr('Screw hole'),
  category: 'screws',
  summary: tr('Hole for a metric screw, with room for its head, nut or insert.'),
  cutter: true,
  groups: [
    {
      title: tr('Hole'),
      params: [
        { type: 'select', key: 'size', label: tr('Size'), default: 'M3', options: HOLE_SIZES.map((value) => ({ value, label: value })) },
        {
          type: 'select',
          key: 'kind',
          label: tr('Type'),
          default: 'clearance',
          options: [
            { value: 'clearance', label: trx('hole', 'Clearance') },
            { value: 'tapped', label: tr('Threaded') },
            { value: 'insert', label: tr('Heat-set insert') },
          ],
        },
        { type: 'number', key: 'depth', label: tr('Depth'), default: 10, min: 1, max: 200, step: 0.5, unit: 'mm' },
        {
          type: 'select',
          key: 'fit',
          label: tr('Fit'),
          default: 'normal',
          visible: isKind('clearance'),
          options: [
            { value: 'close', label: trx('fit', 'Close') },
            { value: 'normal', label: tr('Normal') },
            { value: 'loose', label: tr('Loose') },
          ],
        },
        {
          type: 'select',
          key: 'recess',
          label: tr('Recess'),
          default: 'none',
          visible: isKind('clearance'),
          options: [
            { value: 'none', label: trx('recess', 'None') },
            { value: 'counterbore', label: tr('Counterbore') },
            { value: 'countersink', label: tr('Countersink') },
            { value: 'nut', label: tr('Nut trap') },
          ],
        },
        {
          type: 'number',
          key: 'recessDepth',
          label: tr('Recess depth'),
          help: tr('Leave at 0 for the standard head or nut height.'),
          default: 0,
          min: 0,
          max: 100,
          step: 0.5,
          unit: 'mm',
          visible: hasRecess('counterbore', 'nut'),
        },
        { ...pitchParam, visible: isKind('tapped') },
        { ...clearanceParam(0.2, tr('The thread is cut oversize by this amount so that a screw turns freely in it.')), visible: isKind('tapped') },
        { ...handParam, visible: isKind('tapped') },
        {
          type: 'number',
          key: 'bore',
          label: tr('Custom diameter'),
          help: tr('Leave at 0 for the usual bore of an insert this size.'),
          default: 0,
          min: 0,
          max: 40,
          step: 0.1,
          unit: 'mm',
          visible: isKind('insert'),
        },
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const name = str(p, 'size');
    const size = METRIC[name];
    const kind = str(p, 'kind');
    const depth = num(p, 'depth');

    if (kind === 'tapped') {
      const pitch = metricPitch(p, size, warnings);
      const clearance = num(p, 'clearance');
      checkEngagement(size, pitch, clearance, warnings);
      const profile = isoMetricProfile(size.d, pitch, clearance);
      const { rMin, rMax } = profileExtent(profile);
      // The thread runs past both ends and is cut off square, with a lead-in at the mouth.
      const thread = translate(threadSolid({ profile, pitch, length: depth + 2 * pitch, leftHanded: isLeftHanded(p), q }), [0, 0, -pitch]);
      const lead = Math.min(rMax + 0.1 - rMin, depth / 4);
      const solid = union(intersection(thread, cylinder(rMax + 1, depth, q.circle)), translate(cylinder(rMin, lead, q.circle, rMin + lead), [0, 0, depth - lead]));
      return {
        solid,
        info: [
          { label: tr('Thread major diameter'), value: mm(rMax * 2) },
          { label: tr('Thread minor diameter'), value: mm(rMin * 2) },
          { label: tr('Pitch'), value: mm(pitch) },
        ],
        warnings,
      };
    }

    if (kind === 'insert') {
      const custom = num(p, 'bore');
      if (custom <= 0 && size.insert === undefined) warnings.push(tr('{size} inserts have no usual bore. Set the diameter.', { size: name }));
      const bore = custom > 0 ? custom : (size.insert ?? size.clearance[1]);
      return { solid: cylinder(bore / 2, depth, q.circle), info: [{ label: tr('Bore'), value: mm(bore, 1) }], warnings };
    }

    const hole = size.clearance[Math.max(0, FITS.indexOf(str(p, 'fit')))];
    const play = hole - size.d;
    const parts: Solid[] = [cylinder(hole / 2, depth, q.circle)];
    const info = [{ label: tr('Hole diameter'), value: mm(hole, 1) }];
    const recess = str(p, 'recess');
    // How deep a head or nut sits: as asked, or its own height, and never deeper than the hole.
    const seat = (standard: number): number => {
      const asked = num(p, 'recessDepth') > 0 ? num(p, 'recessDepth') : standard;
      if (asked > depth) warnings.push(tr('The recess was limited to the depth of the hole.'));
      return Math.min(asked, depth);
    };
    if (recess === 'counterbore') {
      const wide = size.capDiameter + play;
      const deep = seat(size.d);
      parts.push(translate(cylinder(wide / 2, deep, q.circle), [0, 0, depth - deep]));
      info.push({ label: tr('Recess diameter'), value: mm(wide, 1) }, { label: tr('Recess depth'), value: mm(deep, 1) });
    } else if (recess === 'countersink') {
      // A 90° cone from the head's sharp edge down to the hole.
      const wide = size.sunk + play;
      const deep = (wide - hole) / 2;
      if (deep > depth) warnings.push(tr('The recess was limited to the depth of the hole.'));
      const cut = Math.min(deep, depth);
      parts.push(translate(cylinder(wide / 2 - cut, cut, q.circle, wide / 2), [0, 0, depth - cut]));
      info.push({ label: tr('Recess diameter'), value: mm(wide, 1) }, { label: tr('Recess depth'), value: mm(cut, 1) });
    } else if (recess === 'nut') {
      const across = size.af + play;
      const deep = seat(size.nutHeight);
      parts.push(translate(extrude([regularPolygon(6, across / 2)], deep), [0, 0, depth - deep]));
      info.push({ label: tr('Across flats'), value: mm(across, 1) }, { label: tr('Recess depth'), value: mm(deep, 1) });
    }
    return { solid: parts.length === 1 ? parts[0] : union(...parts), info, warnings };
  },
};

const trapezoidalParams: ParamDef[] = [
  {
    type: 'number',
    key: 'diameter',
    label: tr('Diameter'),
    help: tr('Nominal (outside) diameter of the screw, e.g. 8 for Tr8.'),
    default: 8,
    min: 4,
    max: 60,
    step: 0.5,
    unit: 'mm',
  },
  {
    type: 'number',
    key: 'pitch',
    label: tr('Pitch'),
    help: tr('Distance between neighboring thread crests.'),
    default: 2,
    min: 1,
    max: 12,
    step: 0.5,
    unit: 'mm',
  },
  {
    type: 'number',
    key: 'starts',
    label: tr('Starts'),
    help: tr('Number of parallel threads. Lead = pitch × starts, so Tr8×8 is 2 mm pitch with 4 starts.'),
    default: 4,
    min: 1,
    max: 8,
    step: 1,
    integer: true,
  },
];

function trapezoidal(p: Params, warnings: string[]) {
  const diameter = num(p, 'diameter');
  let pitch = num(p, 'pitch');
  const max = diameter / 3;
  if (pitch > max) {
    warnings.push(tr('The pitch was limited to {max} mm for this diameter.', { max: max.toFixed(2) }));
    pitch = max;
  }
  const starts = Math.max(1, Math.round(num(p, 'starts')));
  return { diameter, pitch, starts, lead: pitch * starts };
}

const trapezoidalName = (d: number, pitch: number, starts: number) =>
  starts > 1 ? `Tr${d}×${+(pitch * starts).toFixed(2)} (P${+pitch.toFixed(2)})` : `Tr${d}×${+pitch.toFixed(2)}`;

export const leadScrew: GeneratorDef = {
  id: 'lead-screw',
  name: tr('Trapezoidal lead screw'),
  category: 'screws',
  summary: tr('ISO trapezoidal (Tr) screw for linear motion, single or multi-start.'),
  groups: [
    {
      title: tr('Thread'),
      params: [
        ...trapezoidalParams,
        { type: 'number', key: 'length', label: tr('Length'), default: 60, min: 5, max: 400, step: 1, unit: 'mm' },
        clearanceParam(0.1, tr('The thread is shrunk by this amount so that it runs freely in its nut.')),
        { type: 'boolean', key: 'chamfer', label: tr('Chamfered ends'), default: true },
        handParam,
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const { diameter, pitch, starts, lead } = trapezoidal(p, warnings);
    const length = num(p, 'length');
    const chamfer = bool(p, 'chamfer');
    const profile = trapezoidalProfile(diameter, pitch, { offset: -num(p, 'clearance') });
    const { rMin, rMax } = profileExtent(profile);
    const solid = threadedRod({
      profile,
      pitch,
      starts,
      length,
      leftHanded: isLeftHanded(p),
      q,
      chamferBottom: chamfer,
      chamferTop: chamfer,
    });
    return {
      solid,
      info: [
        { label: tr('Designation'), value: trapezoidalName(diameter, pitch, starts) },
        { label: tr('Major diameter'), value: mm(rMax * 2) },
        { label: tr('Minor diameter'), value: mm(rMin * 2) },
        { label: tr('Pitch'), value: mm(pitch) },
        { label: tr('Lead'), value: tr('{length} per turn', { length: mm(lead) }) },
        { label: tr('Total length'), value: mm(length, 1) },
      ],
      warnings,
    };
  },
};

export const leadScrewNut: GeneratorDef = {
  id: 'lead-screw-nut',
  name: tr('Lead screw nut'),
  category: 'screws',
  summary: tr('Flanged nut for a trapezoidal lead screw.'),
  groups: [
    {
      title: tr('Thread'),
      params: [
        ...trapezoidalParams,
        clearanceParam(0.2, tr('The thread is cut oversize by this amount so that the screw runs freely in it.')),
        handParam,
      ],
    },
    {
      title: tr('Body'),
      params: [
        { type: 'number', key: 'bodyDiameter', label: tr('Diameter'), default: 10.2, min: 5, max: 100, step: 0.1, unit: 'mm' },
        { type: 'number', key: 'length', label: tr('Length'), default: 15, min: 2, max: 100, step: 0.5, unit: 'mm' },
      ],
    },
    {
      title: tr('Flange'),
      params: [
        { type: 'boolean', key: 'flange', label: tr('Mounting flange'), default: true },
        {
          type: 'number',
          key: 'flangeDiameter',
          label: tr('Diameter'),
          default: 22,
          min: 8,
          max: 150,
          step: 0.5,
          unit: 'mm',
          visible: (p) => bool(p, 'flange'),
        },
        {
          type: 'number',
          key: 'flangeThickness',
          label: tr('Thickness'),
          default: 3.5,
          min: 1,
          max: 30,
          step: 0.5,
          unit: 'mm',
          visible: (p) => bool(p, 'flange'),
        },
        {
          type: 'number',
          key: 'mountHoles',
          label: tr('Mounting holes'),
          default: 4,
          min: 0,
          max: 8,
          step: 1,
          integer: true,
          visible: (p) => bool(p, 'flange'),
        },
        {
          type: 'number',
          key: 'mountHoleDiameter',
          label: tr('Hole diameter'),
          default: 3.5,
          min: 1,
          max: 12,
          step: 0.1,
          unit: 'mm',
          visible: (p) => bool(p, 'flange') && num(p, 'mountHoles') > 0,
        },
        {
          type: 'number',
          key: 'boltCircle',
          label: tr('Bolt circle'),
          help: tr('Diameter of the circle the mounting holes sit on.'),
          default: 16,
          min: 4,
          max: 140,
          step: 0.5,
          unit: 'mm',
          visible: (p) => bool(p, 'flange') && num(p, 'mountHoles') > 0,
        },
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const { diameter, pitch, starts, lead } = trapezoidal(p, warnings);
    const length = num(p, 'length');
    let bodyR = num(p, 'bodyDiameter') / 2;
    const profile = trapezoidalProfile(diameter, pitch, { internal: true, offset: num(p, 'clearance') });
    const { rMin, rMax } = profileExtent(profile);
    if (bodyR <= rMax) {
      bodyR = rMax + 1;
      warnings.push(tr('The body was widened to {diameter} mm to clear the thread.', { diameter: (2 * bodyR).toFixed(1) }));
    } else if (bodyR < rMax + 0.5) warnings.push(tr('The body wall around the thread is very thin.'));

    let body = cylinder(bodyR, length, q.circle);
    const cuts: Solid[] = [];
    if (bool(p, 'flange')) {
      const flangeR = num(p, 'flangeDiameter') / 2;
      const thickness = Math.min(num(p, 'flangeThickness'), length);
      if (flangeR <= bodyR) {
        warnings.push(tr('The flange is not larger than the body; it was skipped.'));
      } else {
        body = union(cylinder(flangeR, thickness, q.circle), body);
        const count = Math.round(num(p, 'mountHoles'));
        const holeR = num(p, 'mountHoleDiameter') / 2;
        const circleR = num(p, 'boltCircle') / 2;
        if (count > 0 && (circleR - holeR < bodyR || circleR + holeR > flangeR)) {
          warnings.push(tr('The mounting holes do not fit between the body and the flange edge.'));
        }
        for (let i = 0; i < count; i++) {
          const hole = translate(cylinder(holeR, thickness + 2, 24), [circleR, 0, -1]);
          cuts.push(rotate(hole, [0, 0, (360 * (i + 0.5)) / count]));
        }
      }
    }

    const cutter = threadSolid({
      profile,
      pitch,
      starts,
      length: length + 2 * pitch,
      leftHanded: isLeftHanded(p),
      q,
    });
    cuts.push(translate(cutter, [0, 0, -pitch]), ...countersinks(profile, length, q));

    return {
      solid: difference(body, ...cuts),
      info: [
        { label: tr('Designation'), value: trapezoidalName(diameter, pitch, starts) },
        { label: tr('Thread major diameter'), value: mm(rMax * 2) },
        { label: tr('Thread minor diameter'), value: mm(rMin * 2) },
        { label: tr('Crest clearance'), value: mm(trapezoidalClearance(pitch)) },
        { label: tr('Pitch'), value: mm(pitch) },
        { label: tr('Lead'), value: tr('{length} per turn', { length: mm(lead) }) },
        { label: tr('Total length'), value: mm(length, 1) },
      ],
      warnings,
    };
  },
};
