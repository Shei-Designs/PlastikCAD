// 3MF core package: an OPC (zip) container holding the model. Every object
// of the design is a 3MF object of its own; one with parts of several colors
// is made of components, one closed mesh per color, so that a slicer can
// give each its own material. Colors travel as base materials.
import { Zip, ZipDeflate } from 'fflate';
import { APP_NAME } from '../appInfo';
import { PALETTE } from '../geometry/shapes';
import type { ColoredObject } from '../worker/protocol';
import { encodeText, escapeXml, fmt, joinBytes, TextPieces, zipTime } from './format';

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

/** The model part, a line at a time. */
function writeModel(objects: ColoredObject[], name: string, line: (text: string) => void): void {
  const lines = (...text: string[]) => {
    for (const each of text) line(each);
  };
  const title = escapeXml(name);
  // The base materials, one per distinct color, in order of first use.
  const colors: string[] = [];
  for (const o of objects) for (const p of o.parts) if (!colors.includes(p.color)) colors.push(p.color);
  lines(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${title}</metadata>`,
    `  <metadata name="Application">${escapeXml(APP_NAME)}</metadata>`,
    '  <resources>',
    '    <basematerials id="1">',
  );
  for (const c of colors) lines(`      <base name="${escapeXml(colorName(c))}" displaycolor="${c.toUpperCase()}FF"/>`);
  lines('    </basematerials>');
  let nextId = 2;
  const items: number[] = [];
  for (const o of objects) {
    const ids: number[] = [];
    for (const part of o.parts) {
      const id = nextId++;
      ids.push(id);
      const { positions: p, triangles: t } = part.mesh;
      const partName = o.parts.length === 1 ? o.name : `${o.name} (${colorName(part.color)})`;
      lines(`    <object id="${id}" type="model" name="${escapeXml(partName)}" pid="1" pindex="${colors.indexOf(part.color)}">`, '      <mesh>', '        <vertices>');
      for (let i = 0; i < p.length; i += 3) line(`          <vertex x="${fmt(p[i])}" y="${fmt(p[i + 1])}" z="${fmt(p[i + 2])}"/>`);
      lines('        </vertices>', '        <triangles>');
      for (let i = 0; i < t.length; i += 3) line(`          <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
      lines('        </triangles>', '      </mesh>', '    </object>');
    }
    if (ids.length === 1) {
      items.push(ids[0]);
      continue;
    }
    // Several colors: one object made of the parts, so that they stay one thing on the plate.
    const id = nextId++;
    lines(`    <object id="${id}" type="model" name="${escapeXml(o.name)}">`, '      <components>');
    for (const part of ids) lines(`        <component objectid="${part}"/>`);
    lines('      </components>', '    </object>');
    items.push(id);
  }
  lines('  </resources>', '  <build>');
  for (const id of items) lines(`    <item objectid="${id}"/>`);
  lines('  </build>', '</model>');
}

export function write3mf(objects: ColoredObject[], name: string): Uint8Array {
  // Packed as it is written, so that only the packed file is ever held whole: the model's text is several times its size.
  const packed: Uint8Array[] = [];
  const zip = new Zip((error, bytes) => {
    if (error) throw error;
    packed.push(bytes);
  });
  const stamp = zipTime();
  const part = (path: string): ZipDeflate => {
    const file = new ZipDeflate(path, { level: 6 });
    file.mtime = stamp;
    zip.add(file);
    return file;
  };
  // The order added is the order in the archive; OPC readers expect the content types part first.
  part('[Content_Types].xml').push(encodeText(CONTENT_TYPES), true);
  part('_rels/.rels').push(encodeText(RELS), true);
  const model = part('3D/3dmodel.model');
  const text = new TextPieces((bytes) => model.push(bytes));
  writeModel(objects, name, (line) => text.line(line));
  text.flush();
  model.push(new Uint8Array(0), true);
  zip.end();
  return joinBytes(packed);
}
