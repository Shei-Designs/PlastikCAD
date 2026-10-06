import { APP_NAME } from '../app';
import type { MeshData } from '../geometry/mesh';
import { encodeText, fmt } from './format';

/** Wavefront OBJ with shared vertices and 1-based triangle faces. */
export function writeObj(mesh: MeshData, name: string): Uint8Array {
  const { positions: p, triangles: t } = mesh;
  const lines: string[] = [`# ${APP_NAME} - units: millimetres`, `o ${name.trim().replace(/\s+/g, '_') || 'part'}`];
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
  for (let i = 0; i < t.length; i += 3) lines.push(`f ${t[i] + 1} ${t[i + 1] + 1} ${t[i + 2] + 1}`);
  lines.push('');
  return encodeText(lines.join('\n'));
}
