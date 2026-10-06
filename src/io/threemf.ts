import { zipSync } from 'fflate';
import { APP_NAME } from '../app';
import type { MeshData } from '../geometry/mesh';
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

export function modelXml(mesh: MeshData, name: string): string {
  const { positions: p, triangles: t } = mesh;
  const title = escapeXml(name);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${title}</metadata>`,
    `  <metadata name="Application">${escapeXml(APP_NAME)}</metadata>`,
    '  <resources>',
    `    <object id="1" type="model" name="${title}">`,
    '      <mesh>',
    '        <vertices>',
  ];
  for (let i = 0; i < p.length; i += 3) {
    out.push(`          <vertex x="${fmt(p[i])}" y="${fmt(p[i + 1])}" z="${fmt(p[i + 2])}"/>`);
  }
  out.push('        </vertices>', '        <triangles>');
  for (let i = 0; i < t.length; i += 3) {
    out.push(`          <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
  }
  out.push(
    '        </triangles>',
    '      </mesh>',
    '    </object>',
    '  </resources>',
    '  <build>',
    '    <item objectid="1"/>',
    '  </build>',
    '</model>',
    '',
  );
  return out.join('\n');
}

/** 3MF core package: an OPC (zip) container holding a single mesh object. */
export function write3mf(mesh: MeshData, name: string): Uint8Array {
  // Key order is the order in the archive; OPC readers expect the content types part first.
  return zipSync(
    {
      '[Content_Types].xml': encodeText(CONTENT_TYPES),
      '_rels/.rels': encodeText(RELS),
      '3D/3dmodel.model': encodeText(modelXml(mesh, name)),
    },
    { level: 6 },
  );
}
