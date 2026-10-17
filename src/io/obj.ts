import { APP_NAME } from '../app';
import { PALETTE } from '../geometry/shapes';
import type { ColoredObject } from '../worker/protocol';
import { encodeText, fmt } from './format';

const objName = (name: string): string => name.trim().replace(/\s+/g, '_') || 'part';

/** What a color is called in the material library: its palette name, or its hex digits. */
const materialName = (color: string): string => objName(PALETTE.find((c) => c.value.toLowerCase() === color.toLowerCase())?.name ?? color.replace('#', 'color_'));

/**
 * Wavefront OBJ with shared vertices and 1-based triangle faces: one `o` per
 * object, one `g` and `usemtl` per colored part. The colors go in a material
 * library (`mtl`) to save beside the file, named as `mtllib` says; a part
 * with no color (an empty string) needs none.
 */
export function writeObj(objects: ColoredObject[], name: string): { obj: Uint8Array; mtl: Uint8Array | null; mtlName: string } {
  const colors: string[] = [];
  for (const o of objects) for (const p of o.parts) if (p.color && !colors.includes(p.color)) colors.push(p.color);
  const mtlName = `${objName(name)}.mtl`;
  const lines: string[] = [`# ${APP_NAME} - units: millimeters`];
  if (colors.length) lines.push(`mtllib ${mtlName}`);
  let offset = 0;
  for (const o of objects) {
    lines.push(`o ${objName(o.name)}`);
    for (const part of o.parts) {
      const { positions: p, triangles: t } = part.mesh;
      if (o.parts.length > 1) lines.push(`g ${objName(o.name)}_${part.color ? materialName(part.color) : 'part'}`);
      if (part.color) lines.push(`usemtl ${materialName(part.color)}`);
      for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
      for (let i = 0; i < t.length; i += 3) lines.push(`f ${t[i] + 1 + offset} ${t[i + 1] + 1 + offset} ${t[i + 2] + 1 + offset}`);
      offset += p.length / 3;
    }
  }
  lines.push('');
  const obj = encodeText(lines.join('\n'));
  if (colors.length === 0) return { obj, mtl: null, mtlName };
  const mtl: string[] = [`# ${APP_NAME} materials`];
  for (const color of colors) {
    const channel = (i: number) => fmt(parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) / 255);
    mtl.push(`newmtl ${materialName(color)}`, `Kd ${channel(0)} ${channel(1)} ${channel(2)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1', '');
  }
  return { obj, mtl: encodeText(mtl.join('\n')), mtlName };
}
