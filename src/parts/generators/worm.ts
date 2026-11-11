// Cylindrical worm with straight flanks in the axial section (ZA form).
import { tr } from '../../i18n';
import { boreGroup, boreRadius, boreShape, handParam, isLeftHanded } from '../features';
import { toDeg } from '../math2d';
import { pressureAngleProfile, profileExtent, threadedRod } from '../threads';
import { difference, extrude, translate } from '../types';
import { bool, degrees, mm, num } from './types';
import type { GeneratorDef } from './types';

export const worm: GeneratorDef = {
  id: 'worm',
  name: tr('Worm'),
  category: 'gears',
  summary: tr('Worm screw for high-ratio drives. Pair it with a helical gear cut at the lead angle.'),
  groups: [
    {
      title: tr('Worm'),
      params: [
        {
          type: 'number',
          key: 'module',
          label: tr('Module'),
          help: tr('Axial module: the thread pitch is π × module. Must match the transverse module of the mating gear.'),
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
          help: tr('Number of threads. The ratio is gear teeth ÷ starts.'),
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
          help: tr('A larger diameter gives a smaller lead angle (more self-locking) and room for a bigger bore.'),
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
          help: tr('The thread is thinned by this amount (measured along the axis).'),
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
        { label: tr('Pitch diameter'), value: mm(d) },
        { label: tr('Outside diameter'), value: mm(rMax * 2) },
        { label: tr('Root diameter'), value: mm(rMin * 2) },
        { label: tr('Axial pitch'), value: mm(pitch, 3) },
        { label: tr('Lead'), value: tr('{length} per turn', { length: mm(lead, 3) }) },
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
