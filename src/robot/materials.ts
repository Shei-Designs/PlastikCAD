// What things are made of, for the mass a link gets when nobody has weighed
// it. Densities in g/cm³. Printed materials are usually hollow inside: their
// effective density comes from the infill and the solid shell (see `inertia.ts`).

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
  { id: 'nylon', name: 'Nylon', density: 1.14, printed: true },
  { id: 'pc', name: 'Polycarbonate', density: 1.2, printed: true },
  { id: 'resin', name: 'Resin (SLA)', density: 1.15 },
  { id: 'aluminium', name: 'Aluminium', density: 2.7 },
  { id: 'steel', name: 'Steel', density: 7.85 },
  { id: 'stainless', name: 'Stainless steel', density: 8.0 },
  { id: 'brass', name: 'Brass', density: 8.5 },
  { id: 'copper', name: 'Copper', density: 8.96 },
  { id: 'titanium', name: 'Titanium', density: 4.43 },
  { id: 'acrylic', name: 'Acrylic', density: 1.18 },
  { id: 'cfrp', name: 'Carbon fibre', density: 1.6 },
  { id: 'plywood', name: 'Plywood', density: 0.6 },
  { id: 'hardwood', name: 'Hardwood', density: 0.75 },
  { id: 'rubber', name: 'Rubber', density: 1.1 },
  { id: 'pcb', name: 'Circuit board (FR4)', density: 1.85 },
  { id: 'foam', name: 'Foam', density: 0.05 },
];

export function materialOf(id: string): Material {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}
