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

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'gears', label: 'Gears' },
  { id: 'pulleys', label: 'Pulleys & sprockets' },
  { id: 'screws', label: 'Screws & threads' },
  { id: 'frames', label: 'Rails & frames' },
  { id: 'ducts', label: 'Pipes & ducts' },
  { id: 'boards', label: 'Dev boards' },
  { id: 'fans', label: 'Fans' },
  { id: 'cutouts', label: 'Panel cutouts' },
  { id: 'motors', label: 'Motor mounts' },
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
