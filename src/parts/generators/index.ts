import { bevelGear } from './bevel';
import { BOARDS } from './boards';
import { DUCTS } from './ducts';
import { extrusion } from './extrusion';
import { helicalGear, herringboneGear, rack, ringGear, spurGear } from './gears';
import { leadScrew, leadScrewNut, metricBolt, metricNut } from './screws';
import { sprocket } from './sprocket';
import { gt2Pulley, htdPulley, mxlPulley, tPulley } from './timingPulley';
import type { Category, GeneratorDef } from './types';
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
];

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'gears', label: 'Gears' },
  { id: 'pulleys', label: 'Pulleys & sprockets' },
  { id: 'screws', label: 'Screws & threads' },
  { id: 'frames', label: 'Rails & frames' },
  { id: 'ducts', label: 'Pipes & ducts' },
  { id: 'boards', label: 'Dev boards' },
];

export function getGenerator(id: string): GeneratorDef {
  const def = GENERATORS.find((g) => g.id === id);
  if (!def) throw new Error(`Unknown part type "${id}"`);
  return def;
}
