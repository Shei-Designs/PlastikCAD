import { tr } from '../../i18n';
import { bevelGear } from './bevel';
import { BOARDS } from './boards';
import { CUTOUTS } from './cutouts';
import { MOTORS } from './motors';
import { DUCTS } from './ducts';
import { extrusion } from './extrusion';
import { FAN_PARTS } from './fans';
import { helicalGear, herringboneGear, rack, ringGear, spurGear } from './gears';
import { leadScrew, leadScrewNut, metricBolt, metricNut } from './screws';
import { sprocket } from './sprocket';
import { gt2Pulley, htdPulley, mxlPulley, tPulley } from './timingPulley';
import type { Category, GeneratorDef, Params } from './types';
import { worm } from './worm';

export const GENERATORS: GeneratorDef[] = [
  spurGear,
  helicalGear,
  herringboneGear,
  ringGear,
  rack,
  bevelGear,
  worm,
  gt2Pulley,
  htdPulley,
  tPulley,
  mxlPulley,
  sprocket,
  metricBolt,
  metricNut,
  leadScrew,
  leadScrewNut,
  extrusion,
  ...DUCTS,
  ...BOARDS,
  ...FAN_PARTS,
  ...CUTOUTS,
  ...MOTORS,
];

export const CATEGORIES: { id: Category; label: string; summary: string }[] = [
  { id: 'gears', label: tr('Gears'), summary: tr('Spur, helical, bevel, worm and other common gear types.') },
  { id: 'pulleys', label: tr('Pulleys & sprockets'), summary: tr('Pulleys & sprockets used for belt and chain driven systems.') },
  { id: 'screws', label: tr('Screws & threads'), summary: tr('Screws, bolts, nuts and threaded parts.') },
  { id: 'frames', label: tr('Rails & frames'), summary: tr('Aluminum extrusion rails for frames and structures.') },
  { id: 'ducts', label: tr('Pipes & ducts'), summary: tr('Pipe and duct sections for routing air or cables.') },
  { id: 'boards', label: tr('Dev boards'), summary: tr('Mounts and cutouts for common dev boards.') },
  { id: 'fans', label: tr('Fans'), summary: tr('Cutouts, grills and mounting holes for axial fans.') },
  { id: 'cutouts', label: tr('Panel cutouts'), summary: tr('Panel cutouts for common connectors and switches.') },
  { id: 'motors', label: tr('Motor mounts'), summary: tr('Mounting plates and brackets for steppers, gearmotors, servos and DC motors.') },
];

/**
 * Parts that have been renamed since designs were saved with them: the old id, the part it is
 * now, and how its settings carry over. The fan cutout became one form of the fan family.
 */
export const RENAMED_PARTS: Record<string, { part: string; params: (old: Params) => Params }> = {
  'fan-cutout': {
    part: 'fan',
    params: (old) => ({ ...old, form: old.opening === 'none' ? 'holes' : 'cutout', pattern: old.opening === 'guard' ? 'rings' : 'open' }),
  },
};

export function getGenerator(id: string): GeneratorDef {
  const def = GENERATORS.find((g) => g.id === id);
  if (!def) throw new Error(`Unknown part type "${id}"`);
  return def;
}
