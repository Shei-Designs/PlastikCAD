// V-belt pulleys (sheaves) for the classical sections Z, A, B and C and the
// narrow ones SPZ, SPA, SPB and SPC, grooved as ISO 4183 lays them out: the
// belt rides on its flanks at the datum diameter, a little below the rim,
// and never touches the bottom of the groove. A pulley of several grooves
// carries as many belts side by side.
import { tr, trx } from '../../i18n';
import { addHubAndBore, boreGroup, boreRadius, boreShape, hubGroup } from '../features';
import { arcSegments, TAU } from '../math2d';
import { revolve } from '../types';
import type { Polygon, Quality } from '../types';
import { lengthInfo, num, str } from './types';
import type { BuildResult, GeneratorDef, Params } from './types';

interface Section {
  label: string;
  /** Width of the groove at the datum diameter, where the belt's pitch line runs. */
  datumWidth: number;
  /** How far the rim stands above the datum diameter. */
  above: number;
  /** How far the groove goes on below it. */
  below: number;
  /** From the middle of one groove to the middle of the next. */
  spacing: number;
  /** From the side of the pulley to the middle of its first groove. */
  edge: number;
  /** Datum diameters up to this get a 34° groove, larger ones 38°: a belt wedges tighter round a small pulley. */
  narrowUpTo: number;
}

const SECTIONS: Record<string, Section> = {
  Z: { label: 'Z (10 mm)', datumWidth: 8.5, above: 2, below: 7, spacing: 12, edge: 8, narrowUpTo: 80 },
  A: { label: 'A (13 mm)', datumWidth: 11, above: 2.75, below: 8.7, spacing: 15, edge: 10, narrowUpTo: 118 },
  B: { label: 'B (17 mm)', datumWidth: 14, above: 3.5, below: 10.8, spacing: 19, edge: 12.5, narrowUpTo: 190 },
  C: { label: 'C (22 mm)', datumWidth: 19, above: 4.8, below: 14.3, spacing: 25.5, edge: 17, narrowUpTo: 315 },
  SPZ: { label: 'SPZ', datumWidth: 8.5, above: 2, below: 9, spacing: 12, edge: 8, narrowUpTo: 80 },
  SPA: { label: 'SPA', datumWidth: 11, above: 2.75, below: 11, spacing: 15, edge: 10, narrowUpTo: 118 },
  SPB: { label: 'SPB', datumWidth: 14, above: 3.5, below: 14, spacing: 19, edge: 12.5, narrowUpTo: 190 },
  SPC: { label: 'SPC', datumWidth: 19, above: 4.8, below: 19, spacing: 25.5, edge: 17, narrowUpTo: 315 },
};

/** The angle between a groove's flanks, in degrees: the one asked for, or the standard's for the diameter. */
function grooveAngle(p: Params, s: Section): number {
  const asked = str(p, 'grooveAngle');
  return asked === 'auto' ? (num(p, 'diameter') <= s.narrowUpTo ? 34 : 38) : Number(asked);
}

/** How far a pulley's rim stands from its axis: the datum radius and what the section adds above it. */
export function vBeltRim(p: Params): number {
  return num(p, 'diameter') / 2 + (SECTIONS[str(p, 'section')]?.above ?? 0);
}

/** The datum diameters a pulley can be given. */
export const V_BELT_DIAMETERS = { min: 20, max: 500 };

function build(p: Params, q: Quality): BuildResult {
  const s = SECTIONS[str(p, 'section')];
  if (!s) throw new Error(`Unknown belt section "${str(p, 'section')}"`);
  const warnings: string[] = [];
  const grooves = Math.round(num(p, 'grooves'));
  const datum = num(p, 'diameter');
  const angle = grooveAngle(p, s);
  const slope = Math.tan((angle * Math.PI) / 360);
  const rim = datum / 2 + s.above;
  const depth = s.above + s.below;
  const bottom = rim - depth;
  const top = s.datumWidth / 2 + s.above * slope;
  const floor = s.datumWidth / 2 - s.below * slope;
  const width = (grooves - 1) * s.spacing + 2 * s.edge;

  // The rim's outline, (radius, height) from the axis up the side: down each groove's flank, along its floor and up again.
  const profile: Polygon = [[0, 0], [rim, 0]];
  for (let g = 0; g < grooves; g++) {
    const middle = s.edge + g * s.spacing;
    profile.push([rim, middle - top], [bottom, middle - floor], [bottom, middle + floor], [rim, middle + top]);
  }
  profile.push([rim, width], [0, width]);

  if (boreRadius(p) > bottom - 1) warnings.push(tr('The bore leaves less than 1 mm of material below the belt grooves.'));
  const { solid, height } = addHubAndBore(revolve(profile, Math.max(48, arcSegments(q, TAU))), 0, width, p, q, warnings, rim);
  const round: Polygon = Array.from({ length: q.circle }, (_, i) => [rim * Math.cos((TAU * i) / q.circle), rim * Math.sin((TAU * i) / q.circle)]);
  return {
    solid,
    outline: [round, ...(boreShape(p, q) ?? [])],
    info: [
      lengthInfo(tr('Datum diameter'), datum),
      lengthInfo(tr('Outside diameter'), 2 * rim),
      { label: tr('Groove angle'), value: `${angle}°` },
      lengthInfo(tr('Width'), width),
      lengthInfo(tr('Total height'), height),
    ],
    warnings,
  };
}

export const vBeltPulley: GeneratorDef = {
  id: 'v-belt-pulley',
  name: tr('V-belt pulley'),
  category: 'pulleys',
  summary: tr('Pulley for V-belts, with one groove or several.'),
  groups: [
    {
      title: tr('Belt'),
      params: [
        { type: 'select', key: 'section', label: tr('Section'), default: 'Z', options: Object.entries(SECTIONS).map(([value, s]) => ({ value, label: s.label })) },
        { type: 'number', key: 'diameter', label: tr('Datum diameter'), help: tr('Sets the diameter the belt runs at, a little below the rim.'), default: 60, min: V_BELT_DIAMETERS.min, max: V_BELT_DIAMETERS.max, step: 1, unit: 'mm' },
        { type: 'number', key: 'grooves', label: tr('Grooves'), default: 1, min: 1, max: 8, step: 1, integer: true },
        {
          type: 'select',
          key: 'grooveAngle',
          label: tr('Groove angle'),
          default: 'auto',
          options: [
            { value: 'auto', label: trx('groove angle', 'Standard') },
            { value: '34', label: '34°' },
            { value: '36', label: '36°' },
            { value: '38', label: '38°' },
          ],
        },
      ],
    },
    hubGroup({ height: 0, diameter: 24, setScrews: 1, setScrewDiameter: 3.3 }),
    boreGroup({ type: 'round', diameter: 8 }),
  ],
  build,
};
