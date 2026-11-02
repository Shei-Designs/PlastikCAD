// 3MF core package: an OPC (zip) container holding the model. Every object
// of the design is a 3MF object of its own; one with parts of several colors
// is made of components, one closed mesh per color, so that a slicer can
// give each its own material. Colors travel as base materials.
import { zipSync } from 'fflate';
import { APP_NAME } from '../appInfo';
import { PALETTE } from '../geometry/shapes';
import type { ColoredObject } from '../worker/protocol';
import { encodeText, escapeXml, fmt } from './format';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** What a color is called in the file: its palette name, or the hex itself. */
const colorName = (color: string): string => PALETTE.find((c) => c.value.toLowerCase() === color.toLowerCase())?.name ?? color;

export function modelXml(objects: ColoredObject[], name: string): string {
  const title = escapeXml(name);
  // The base materials, one per distinct color, in order of first use.
  const colors: string[] = [];
  for (const o of objects) for (const p of o.parts) if (!colors.includes(p.color)) colors.push(p.color);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${title}</metadata>`,
    `  <metadata name="Application">${escapeXml(APP_NAME)}</metadata>`,
    '  <resources>',
    '    <basematerials id="1">',
  ];
  for (const c of colors) out.push(`      <base name="${escapeXml(colorName(c))}" displaycolor="${c.toUpperCase()}FF"/>`);
  out.push('    </basematerials>');
  let nextId = 2;
  const items: number[] = [];
  for (const o of objects) {
    const ids: number[] = [];
    for (const part of o.parts) {
      const id = nextId++;
      ids.push(id);
      const { positions: p, triangles: t } = part.mesh;
      const partName = o.parts.length === 1 ? o.name : `${o.name} (${colorName(part.color)})`;
      out.push(`    <object id="${id}" type="model" name="${escapeXml(partName)}" pid="1" pindex="${colors.indexOf(part.color)}">`, '      <mesh>', '        <vertices>');
      for (let i = 0; i < p.length; i += 3) out.push(`          <vertex x="${fmt(p[i])}" y="${fmt(p[i + 1])}" z="${fmt(p[i + 2])}"/>`);
      out.push('        </vertices>', '        <triangles>');
      for (let i = 0; i < t.length; i += 3) out.push(`          <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
      out.push('        </triangles>', '      </mesh>', '    </object>');
    }
    if (ids.length === 1) {
      items.push(ids[0]);
      continue;
    }
    // Several colors: one object made of the parts, so that they stay one thing on the plate.
    const id = nextId++;
    out.push(`    <object id="${id}" type="model" name="${escapeXml(o.name)}">`, '      <components>');
    for (const part of ids) out.push(`        <component objectid="${part}"/>`);
    out.push('      </components>', '    </object>');
    items.push(id);
  }
  out.push('  </resources>', '  <build>');
  for (const id of items) out.push(`    <item objectid="${id}"/>`);
  out.push('  </build>', '</model>', '');
  return out.join('\n');
}

export function write3mf(objects: ColoredObject[], name: string): Uint8Array {
  // Key order is the order in the archive; OPC readers expect the content types part first.
  return zipSync(
    {
      '[Content_Types].xml': encodeText(CONTENT_TYPES),
      '_rels/.rels': encodeText(RELS),
      '3D/3dmodel.model': encodeText(modelXml(objects, name)),
    },
    { level: 6 },
  );
}
