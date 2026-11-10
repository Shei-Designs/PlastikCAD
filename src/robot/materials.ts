// What things are made of, for the mass a link gets when nobody has weighed
// it. Densities in g/cm³. Printed materials are usually hollow inside: their
// effective density comes from the infill and the solid shell (see `inertia.ts`).

import { tr } from '../i18n';

export interface Material {
  id: string;
  name: string;
  /** g/cm³ of the solid material. */
  density: number;
  /** A filament: the part is printed with a shell and infill. */
  printed?: boolean;
}

export const MATERIALS: Material[] = [
  { id: 'pla', name: 'PLA', density: 1.24, printed: true },
  { id: 'petg', name: 'PETG', density: 1.27, printed: true },
  { id: 'abs', name: 'ABS', density: 1.04, printed: true },
  { id: 'asa', name: 'ASA', density: 1.07, printed: true },
  { id: 'tpu', name: 'TPU', density: 1.21, printed: true },
  { id: 'nylon', name: tr('Nylon'), density: 1.14, printed: true },
  { id: 'pc', name: tr('Polycarbonate'), density: 1.2, printed: true },
  { id: 'resin', name: tr('Resin (SLA)'), density: 1.15 },
  { id: 'aluminium', name: tr('Aluminium'), density: 2.7 },
  { id: 'steel', name: tr('Steel'), density: 7.85 },
  { id: 'stainless', name: tr('Stainless steel'), density: 8.0 },
  { id: 'brass', name: tr('Brass'), density: 8.5 },
  { id: 'copper', name: tr('Copper'), density: 8.96 },
  { id: 'titanium', name: tr('Titanium'), density: 4.43 },
  { id: 'acrylic', name: tr('Acrylic'), density: 1.18 },
  { id: 'cfrp', name: tr('Carbon fibre'), density: 1.6 },
  { id: 'plywood', name: tr('Plywood'), density: 0.6 },
  { id: 'hardwood', name: tr('Hardwood'), density: 0.75 },
  { id: 'rubber', name: tr('Rubber'), density: 1.1 },
  { id: 'pcb', name: tr('Circuit board (FR4)'), density: 1.85 },
  { id: 'foam', name: tr('Foam'), density: 0.05 },
];

export function materialOf(id: string): Material {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}
