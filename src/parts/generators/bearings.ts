// Seats for ball bearings: the bore a bearing's outer ring sits in, as deep as
// the bearing is wide, with a narrower hole below it that the outer ring rests
// on and the inner ring turns clear of. A cutter: it comes in as a hole.
import { tr, trx } from '../../i18n';
import { cylinder, translate, union } from '../types';
import { bool, lengthInfo, num, str } from './types';
import type { GeneratorDef, Params } from './types';

interface Bearing {
  /** Bore, outside diameter and width, mm (ISO 15 boundary dimensions; a linear bearing's length for its width). */
  d: number;
  D: number;
  B: number;
}

// Deep groove ball bearings by their usual numbers, and the LM-UU linear bearings of 3D printers.
const BEARINGS: Record<string, Bearing> = {
  '623': { d: 3, D: 10, B: 4 },
  '624': { d: 4, D: 13, B: 5 },
  '625': { d: 5, D: 16, B: 5 },
  '626': { d: 6, D: 19, B: 6 },
  '608': { d: 8, D: 22, B: 7 },
  '688': { d: 8, D: 16, B: 5 },
  '698': { d: 8, D: 19, B: 6 },
  '6000': { d: 10, D: 26, B: 8 },
  '6001': { d: 12, D: 28, B: 8 },
  '6002': { d: 15, D: 32, B: 9 },
  '6200': { d: 10, D: 30, B: 9 },
  '6201': { d: 12, D: 32, B: 10 },
  '6202': { d: 15, D: 35, B: 11 },
  '6800': { d: 10, D: 19, B: 5 },
  '6801': { d: 12, D: 21, B: 5 },
  '6802': { d: 15, D: 24, B: 5 },
  LM6UU: { d: 6, D: 12, B: 19 },
  LM8UU: { d: 8, D: 15, B: 24 },
  LM10UU: { d: 10, D: 19, B: 29 },
  LM12UU: { d: 12, D: 21, B: 30 },
};

export const BEARING_IDS = Object.keys(BEARINGS);

const isCustom = (p: Params) => str(p, 'bearing') === 'custom';
const hasHole = (p: Params) => bool(p, 'through');

export const bearingSeat: GeneratorDef = {
  id: 'bearing-seat',
  name: tr('Bearing seat'),
  category: 'bearings',
  summary: tr('Seat for a ball bearing, with a hole its outer ring rests on.'),
  cutter: true,
  groups: [
    {
      title: tr('Bearing'),
      params: [
        {
          type: 'select',
          key: 'bearing',
          label: tr('Bearing'),
          default: '608',
          options: [...BEARING_IDS.map((value) => ({ value, label: `${value} (${BEARINGS[value].d} × ${BEARINGS[value].D} × ${BEARINGS[value].B})` })), { value: 'custom', label: trx('bearing', 'Custom') }],
        },
        { type: 'number', key: 'outer', label: tr('Outer diameter'), default: 22, min: 2, max: 200, step: 0.5, unit: 'mm', visible: isCustom },
        { type: 'number', key: 'width', label: tr('Width'), default: 7, min: 1, max: 100, step: 0.5, unit: 'mm', visible: isCustom },
        { type: 'number', key: 'bore', label: tr('Bore'), default: 8, min: 1, max: 190, step: 0.5, unit: 'mm', visible: isCustom },
        {
          type: 'number',
          key: 'clearance',
          label: tr('Clearance'),
          help: tr('Adds this much all round the bearing.'),
          default: 0.1,
          min: 0,
          max: 1,
          step: 0.05,
          unit: 'mm',
        },
        { type: 'number', key: 'depth', label: tr('Seat depth'), help: tr('Sets the seat depth. 0 takes the width of the bearing.'), default: 0, min: 0, max: 100, step: 0.5, unit: 'mm' },
        { type: 'boolean', key: 'through', label: tr('Through hole'), help: tr('Adds a hole below the seat that the inner ring turns clear of.'), default: true },
        { type: 'number', key: 'length', label: tr('Hole length'), default: 10, min: 0.5, max: 200, step: 0.5, unit: 'mm', visible: hasHole },
      ],
    },
  ],
  build(p, q) {
    const warnings: string[] = [];
    const custom = isCustom(p);
    const bearing: Bearing = custom ? { d: num(p, 'bore'), D: num(p, 'outer'), B: num(p, 'width') } : { ...BEARINGS[str(p, 'bearing')] };
    if (bearing.d >= bearing.D) {
      warnings.push(tr('The bore is as wide as the bearing; it was made half as wide.'));
      bearing.d = bearing.D / 2;
    }
    const seat = bearing.D + 2 * num(p, 'clearance');
    const depth = num(p, 'depth') > 0 ? num(p, 'depth') : bearing.B;
    // Half way between the bore and the outside: clear of the inner ring, under the outer one.
    const hole = (bearing.d + bearing.D) / 2;
    const length = hasHole(p) ? num(p, 'length') : 0;
    // Standing on the plate, the seat's mouth at the top.
    const parts = [translate(cylinder(seat / 2, depth, q.circle), [0, 0, length])];
    if (length > 0) parts.push(cylinder(hole / 2, length, q.circle));
    const info = [
      lengthInfo(tr('Seat diameter'), seat),
      lengthInfo(tr('Seat depth'), depth, 1),
    ];
    if (length > 0) info.push(lengthInfo(tr('Hole diameter'), hole, 1));
    return { solid: parts.length === 1 ? parts[0] : union(...parts), info, warnings };
  },
};
