import type { MeshData } from '../geometry/mesh';
import type { Polygon } from '../model/types';
import { writeDxf } from './dxf';
import { writeObj } from './obj';
import { writeStl } from './stl';
import { writeSvg } from './svg';
import { write3mf } from './threemf';

export type FormatId = 'stl' | '3mf' | 'obj' | 'svg' | 'dxf';

export interface ExportFormat {
  id: FormatId;
  label: string;
  extension: string;
  description: string;
  kind: '3d' | '2d';
  mime: string;
}

export const FORMATS: ExportFormat[] = [
  {
    id: 'stl',
    label: 'STL',
    extension: 'stl',
    description: 'Binary mesh, accepted by every slicer',
    kind: '3d',
    mime: 'model/stl',
  },
  {
    id: '3mf',
    label: '3MF',
    extension: '3mf',
    description: 'Compact mesh with units, preferred by modern slicers',
    kind: '3d',
    mime: 'model/3mf',
  },
  {
    id: 'obj',
    label: 'OBJ',
    extension: 'obj',
    description: 'Text mesh for modeling and rendering tools',
    kind: '3d',
    mime: 'model/obj',
  },
  {
    id: 'svg',
    label: 'SVG',
    extension: 'svg',
    description: "The design's outline seen from above, for laser cutters and vector editors",
    kind: '2d',
    mime: 'image/svg+xml',
  },
  {
    id: 'dxf',
    label: 'DXF',
    extension: 'dxf',
    description: "The design's outline seen from above, to extrude in CAD or cut on a laser / CNC",
    kind: '2d',
    mime: 'image/vnd.dxf',
  },
];

export function exportMesh(id: 'stl' | '3mf' | 'obj', mesh: MeshData, name: string): Uint8Array {
  switch (id) {
    case 'stl':
      return writeStl(mesh, name);
    case '3mf':
      return write3mf(mesh, name);
    case 'obj':
      return writeObj(mesh, name);
  }
}

/** `outline` is a set of even-odd contours: holes are simply contours inside other contours. */
export function exportOutline(id: 'dxf' | 'svg', outline: Polygon[], name: string): Uint8Array {
  switch (id) {
    case 'dxf':
      return writeDxf(outline, name);
    case 'svg':
      return writeSvg(outline, name);
  }
}
