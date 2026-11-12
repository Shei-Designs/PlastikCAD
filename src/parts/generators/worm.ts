// Cylindrical worm with straight flanks in the axial section (ZA form), and the
// throated wheel it drives: a wheel whose teeth wrap round the worm, cut by the
// worm itself as the two turn together.
import { tr } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, boreShape, handParam, hubGroup, isLeftHanded } from '../features';
import { toDeg } from '../math2d';
import { pressureAngleProfile, profileExtent, threadedRod, threadSolid } from '../threads';
import { difference, extrude, intersection, revolve, rotate, tidy, translate, union } from '../types';
import type { Polygon, Quality, Solid } from '../types';
import { bool, degrees, lengthInfo, num, unitInfo } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';
import { lengthFixed } from '../../units';

export const worm: GeneratorDef = {
  id: 'worm',
  name: tr('Worm'),
  category: 'gears',
  summary: tr('Worm screw for a worm wheel.'),
  groups: [
    {
      title: tr('Worm'),
      params: [
        {
          type: 'number',
          key: 'module',
          label: tr('Module'),
          help: tr('Sets the axial module. The thread pitch is π × module.'),
          default: 1,
          min: 0.3,
          max: 10,
          step: 0.05,
          unit: 'mm',
        },
        {
          type: 'number',
          key: 'starts',
          label: tr('Starts'),
          help: tr('Sets the number of threads. The ratio is gear teeth ÷ starts.'),
          default: 1,
          min: 1,
          max: 6,
          step: 1,
          integer: true,
        },
        {
          type: 'number',
          key: 'pressureAngle',
          label: tr('Pressure angle'),
          default: 20,
          min: 14.5,
          max: 30,
          step: 0.5,
          unit: '°',
        },
        {
          type: 'number',
          key: 'pitchDiameter',
          label: tr('Pitch diameter'),
          help: tr('Sets the diameter at mid-thread.'),
          default: 12,
          min: 3,
          max: 200,
          step: 0.5,
          unit: 'mm',
        },
        { type: 'number', key: 'length', label: tr('Length'), default: 20, min: 2, max: 300, step: 1, unit: 'mm' },
        {
          type: 'number',
          key: 'backlash',
          label: tr('Backlash'),
          help: tr('Thins the thread by this amount, along the axis.'),
          default: 0.1,
          min: 0,
          max: 1,
          step: 0.01,
          unit: 'mm',
        },
        { type: 'boolean', key: 'chamfer', label: tr('Chamfered ends'), default: true },
        handParam,
      ],
    },
    boreGroup({ type: 'round', diameter: 5 }),
  ],
  build(p, q) {
    const warnings: string[] = [];
    const m = num(p, 'module');
    const starts = Math.max(1, Math.round(num(p, 'starts')));
    const alpha = (num(p, 'pressureAngle') * Math.PI) / 180;
    const d = num(p, 'pitchDiameter');
    const length = num(p, 'length');
    const chamfer = bool(p, 'chamfer');
    const leftHanded = isLeftHanded(p);
    const pitch = Math.PI * m;
    const lead = pitch * starts;
    const leadAngle = Math.atan(lead / (Math.PI * d));

    const rootRadius = d / 2 - 1.25 * m;
    if (rootRadius < 0.25 * m) warnings.push(tr('The pitch diameter is too small for this module.'));
    else if (rootRadius < boreRadius(p) + 1) warnings.push(tr('The wall between the bore and the thread root is very thin.'));

    const profile = pressureAngleProfile({
      pitch,
      pitchRadius: d / 2,
      addendum: m,
      dedendum: 1.25 * m,
      pressureAngle: alpha,
      thickness: Math.max(pitch / 2 - num(p, 'backlash'), pitch / 8),
    });
    const { rMin, rMax } = profileExtent(profile);
    let solid = threadedRod({
      profile,
      pitch,
      starts,
      length,
      leftHanded,
      q,
      chamferBottom: chamfer,
      chamferTop: chamfer,
    });
    const bore = boreShape(p, q);
    if (bore && boreRadius(p) >= rMax) warnings.push(tr('The bore is wider than the worm, so it was left out.'));
    else if (bore) solid = difference(solid, translate(extrude(bore, length + 2), [0, 0, -1]));

    return {
      solid,
      info: [
        lengthInfo(tr('Pitch diameter'), d),
        lengthInfo(tr('Outside diameter'), rMax * 2),
        lengthInfo(tr('Root diameter'), rMin * 2),
        lengthInfo(tr('Axial pitch'), pitch, 3),
        unitInfo(tr('Lead'), (unit) => tr('{length} per turn', { length: lengthFixed(lead, unit, 3) })),
        { label: tr('Lead angle'), value: degrees(toDeg(leadAngle)) },
        {
          label: tr('Mating gear'),
          value: leftHanded
            ? tr('Helical, {angle} helix, left-handed, normal module {module}', { angle: degrees(toDeg(leadAngle)), module: (m * Math.cos(leadAngle)).toFixed(3) })
            : tr('Helical, {angle} helix, right-handed, normal module {module}', { angle: degrees(toDeg(leadAngle)), module: (m * Math.cos(leadAngle)).toFixed(3) }),
        },
      ],
      warnings,
    };
  },
};

// --- the throated wheel ------------------------------------------------------------------------

/** What a worm and its wheel have to agree on, from the wheel's settings. */
export interface WormPair {
  module: number;
  starts: number;
  teeth: number;
  /** The worm's pitch radius and the wheel's. */
  wormRadius: number;
  wheelRadius: number;
  /** From the worm's axis to the wheel's. */
  center: number;
  faceWidth: number;
  pitch: number;
  leftHanded: boolean;
  /** How long the worm that cuts the wheel is: a whole, even number of pitches, so that its thread is the same about its middle as about its end. */
  cutterLength: number;
}

export function wormPair(p: Params): WormPair {
  const module = num(p, 'module');
  const starts = Math.max(1, Math.round(num(p, 'starts')));
  const teeth = Math.max(starts + 1, Math.round(num(p, 'teeth')));
  const wormRadius = num(p, 'wormDiameter') / 2;
  const wheelRadius = (module * teeth) / 2;
  const asked = num(p, 'faceWidth');
  // About three quarters of the worm across its threads is the usual proportion.
  const faceWidth = asked > 0 ? asked : Math.max(1, Math.round(0.75 * (2 * wormRadius + 2 * module) * 2) / 2);
  const pitch = Math.PI * module;
  // Long enough to reach across the wheel wherever the two overlap.
  const reach = 2 * Math.sqrt(Math.max(0, (wheelRadius + 1.5 * module) ** 2 - (wheelRadius - 1.25 * module) ** 2)) + 4 * pitch;
  return { module, starts, teeth, wormRadius, wheelRadius, center: wormRadius + wheelRadius, faceWidth, pitch, leftHanded: isLeftHanded(p), cutterLength: 2 * Math.ceil(reach / (2 * pitch)) * pitch };
}

/**
 * How far the worm turns for a turn of the wheel by `wheelTurn` (both in degrees, each about its
 * own axis as the wheel's builder places them): teeth to starts, and against it for a right-hand
 * thread, whose ridge at a fixed place moves back along the axis as the worm turns forward.
 */
export const wormTurn = (pair: WormPair, wheelTurn: number): number => ((pair.leftHanded ? 1 : -1) * wheelTurn * pair.teeth) / pair.starts;

/** A tooth's mesh is tidied to within this (mm): every cut leaves slivers by the thousand that no print would show, and a wheel of a quarter of a million triangles. */
const TIDY = 0.02;

function buildWheel(p: Params, q: Quality): BuildResult {
  const warnings: string[] = [];
  const pair = wormPair(p);
  const { module: m, starts, teeth, wormRadius: r1, wheelRadius: r2, center, faceWidth: b, pitch } = pair;
  const alpha = (num(p, 'pressureAngle') * Math.PI) / 180;
  if (r1 - 1.25 * m < 0.25 * m) warnings.push(tr('The pitch diameter is too small for this module.'));

  // The blank: a disc whose rim is hollowed to the worm's root, a quarter of a module clear of it, and no wider than the worm's threads reach.
  const throat = r1 - m;
  const rim = r2 + 1.5 * m;
  const steps = Math.max(8, Math.round(q.circle / 4));
  const outline: Polygon = [[0, 0]];
  for (let i = 0; i <= steps; i++) {
    const z = (b * i) / steps;
    const off = z - b / 2;
    outline.push([Math.min(rim, off * off < throat * throat ? center - Math.sqrt(throat * throat - off * off) : rim), z]);
  }
  outline.push([0, b]);
  const blank = revolve(outline, q.circle);

  // The worm that cuts it: the mating worm with its thread as thick as the wheel's tooth space is to be, and tall enough to clear the root.
  const profile = pressureAngleProfile({ pitch, pitchRadius: r1, addendum: 1.25 * m, dedendum: m, pressureAngle: alpha, thickness: pitch / 2 + num(p, 'backlash') });
  // Its own facets, and the steps it is carried in, both end up on every tooth: they are kept to what shows.
  const coarse: Quality = { ...q, circle: Math.min(q.circle, 48) };
  // Only its facets: the wheel is what forty and more cuts with it leave, which has no surfaces of its own to be written in.
  const thread = translate(threadSolid({ profile, pitch, starts, length: pair.cutterLength, leftHanded: pair.leftHanded, q: coarse, facetsOnly: true }), [0, 0, -pair.cutterLength / 2]);
  /** The worm where it is once the wheel has turned by `turn` degrees, seen from the wheel: lying across the wheel's rim at +X, halfway up it. */
  const cutter = (turn: number): Solid => rotate(translate(rotate(rotate(thread, [0, 0, wormTurn(pair, turn)]), [-90, 0, 0]), [center, 0, b / 2]), [0, 0, -turn]);

  // One tooth's worth of the wheel, cut at every step of the worm's way across it, then set round the wheel tooth by tooth.
  const toothAngle = 360 / teeth;
  const { rMax } = profileExtent(profile);
  const overlap = (Math.acos(Math.min(1, Math.max(-1, (center * center + rim * rim - rMax * rMax) / (2 * center * rim)))) * 180) / Math.PI;
  const perTooth = Math.min(9, Math.max(5, Math.round(q.flank / 2) + 2));
  const span = Math.ceil((overlap + toothAngle) / toothAngle) * perTooth;
  const cutters: Solid[] = [];
  for (let i = -span; i <= span; i++) cutters.push(cutter((i * toothAngle) / perTooth));
  const far = rim + 1;
  const half = (Math.PI / teeth) * 1.0001;
  const wedge = extrude([[[0, 0], [far * Math.cos(-half), far * Math.sin(-half)], [far, 0], [far * Math.cos(half), far * Math.sin(half)]]], b);
  // Each cut is taken from the one tooth's worth of blank, one after the other: together the cutters are forty threads through each
  // other, which is slow to make one solid of, while each alone takes a small bite of a small piece.
  let tooth = intersection(blank, wedge);
  for (const one of cutters) tooth = difference(tooth, one);
  tooth = tidy(tooth, TIDY);
  const body = union(...Array.from({ length: teeth }, (_, k) => (k === 0 ? tooth : rotate(tooth, [0, 0, k * toothAngle]))));

  const root = r2 - 1.25 * m;
  if (boreRadius(p) > root - 1) warnings.push(tr('The bore leaves very little material below the teeth.'));
  const { solid, height } = addHubAndBore(body, 0, b, p, q, warnings, root);
  const round: Polygon = Array.from({ length: q.circle }, (_, i) => [rim * Math.cos((2 * Math.PI * i) / q.circle), rim * Math.sin((2 * Math.PI * i) / q.circle)]);
  return {
    solid,
    outline: [round, ...(boreShape(p, q) ?? [])],
    info: [
      lengthInfo(tr('Pitch diameter'), 2 * r2),
      lengthInfo(tr('Outside diameter'), 2 * rim),
      lengthInfo(tr('Center distance'), center),
      { label: tr('Ratio'), value: `${Number((teeth / starts).toFixed(2))} : 1` },
      lengthInfo(tr('Face width'), b),
      lengthInfo(tr('Total height'), height),
    ],
    warnings,
  };
}

export const wormWheel: GeneratorDef = {
  id: 'worm-wheel',
  name: tr('Throated worm wheel'),
  category: 'gears',
  summary: tr('Worm wheel with teeth that wrap round the worm.'),
  groups: [
    {
      title: tr('Wheel'),
      params: [
        { type: 'number', key: 'module', label: tr('Module'), help: tr('Sets the axial module. Use the worm\'s.'), default: 1, min: 0.3, max: 10, step: 0.05, unit: 'mm' },
        { type: 'number', key: 'teeth', label: tr('Teeth'), default: 30, min: 8, max: 200, step: 1, integer: true },
        { type: 'number', key: 'faceWidth', label: tr('Face width'), help: tr('Sets the width of the rim. 0 takes three quarters of the worm\'s outside diameter.'), default: 0, min: 0, max: 100, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'backlash', label: tr('Backlash'), help: tr('Widens the tooth spaces by this amount.'), default: 0.1, min: 0, max: 1, step: 0.01, unit: 'mm' },
      ],
    },
    {
      title: tr('Worm'),
      params: [
        { type: 'number', key: 'starts', label: tr('Starts'), help: tr('Sets the number of threads of the worm. The ratio is teeth ÷ starts.'), default: 1, min: 1, max: 6, step: 1, integer: true },
        { type: 'number', key: 'wormDiameter', label: tr('Pitch diameter'), help: tr('Sets the pitch diameter of the worm. Use the worm\'s.'), default: 12, min: 3, max: 200, step: 0.5, unit: 'mm' },
        { type: 'number', key: 'pressureAngle', label: tr('Pressure angle'), default: 20, min: 14.5, max: 30, step: 0.5, unit: '°' },
        handParam,
      ],
    },
    hubGroup({ height: 0, diameter: 14, setScrews: 1, setScrewDiameter: 3.3 }),
    boreGroup({ type: 'round', diameter: 5 }),
  ],
  build: buildWheel,
};

