import type { MeshData } from '../geometry/mesh';
import { tr } from '../i18n';
import type { Polygon } from '../model/types';
import { writeDxf } from './dxf';
import { writeObj } from './obj';
import { writeStl } from './stl';
import { writeSvg } from './svg';

export type FormatId = 'stl' | '3mf' | 'obj' | 'glb' | 'step' | 'svg' | 'dxf';

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
    description: tr('Binary mesh for any slicer'),
    kind: '3d',
    mime: 'model/stl',
  },
  {
    id: '3mf',
    label: '3MF',
    extension: '3mf',
    description: tr('Mesh with colors and units for slicers'),
    kind: '3d',
    mime: 'model/3mf',
  },
  {
    id: 'obj',
    label: 'OBJ',
    extension: 'obj',
    description: tr('Text mesh with colors for modeling tools'),
    kind: '3d',
    mime: 'model/obj',
  },
  {
    id: 'glb',
    label: 'GLB',
    extension: 'glb',
    description: tr('Mesh with pictures for scenes'),
    kind: '3d',
    mime: 'model/gltf-binary',
  },
  {
    id: 'step',
    label: 'STEP',
    extension: 'step',
    description: tr('Solids with flat faces for CAD programs'),
    kind: '3d',
    mime: 'model/step',
  },
  {
    id: 'svg',
    label: 'SVG',
    extension: 'svg',
    description: tr('Top-down outline for lasers'),
    kind: '2d',
    mime: 'image/svg+xml',
  },
  {
    id: 'dxf',
    label: 'DXF',
    extension: 'dxf',
    description: tr('Top-down outline for CAD'),
    kind: '2d',
    mime: 'image/vnd.dxf',
  },
];

/** The single-mesh, colorless formats; a 3MF or OBJ with colors is written from colored parts instead (see `write3mf`, `writeObj`). */
export function exportMesh(id: 'stl' | 'obj', mesh: MeshData, name: string): Uint8Array {
  switch (id) {
    case 'stl':
      return writeStl(mesh, name);
    case 'obj':
      return writeObj([{ name, parts: [{ color: '', mesh }] }], name).obj;
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
