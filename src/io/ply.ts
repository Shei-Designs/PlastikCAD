// Stanford PLY, written: every object's triangles in one mesh, each face in
// the color of the part it belongs to. Binary, little-endian, which is what
// scanners' and mesh tools' own files are; millimeters, Z up, as the design.
import { APP_NAME } from '../appInfo';
import type { ColoredObject } from '../worker/protocol';

/** The color of a part that has none of its own, as the app shows it. */
const PLAIN = [0x8f, 0xa3, 0xbf];

export function writePly(objects: ColoredObject[]): Uint8Array {
  const parts = objects.flatMap((o) => o.parts);
  const vertices = parts.reduce((n, p) => n + p.mesh.positions.length / 3, 0);
  const faces = parts.reduce((n, p) => n + p.mesh.triangles.length / 3, 0);
  const header = new TextEncoder().encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      `comment ${APP_NAME} - units: millimeters`,
      `element vertex ${vertices}`,
      'property float x',
      'property float y',
      'property float z',
      `element face ${faces}`,
      'property list uchar int vertex_indices',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header',
      '',
    ].join('\n'),
  );
  const out = new Uint8Array(header.length + vertices * 12 + faces * 16);
  out.set(header);
  const view = new DataView(out.buffer);
  let at = header.length;
  for (const part of parts) {
    for (const v of part.mesh.positions) {
      view.setFloat32(at, v, true);
      at += 4;
    }
  }
  let offset = 0;
  for (const part of parts) {
    const hex = /^#?([0-9a-f]{6})$/i.exec(part.color)?.[1];
    const [r, g, b] = hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : PLAIN;
    const t = part.mesh.triangles;
    for (let i = 0; i < t.length; i += 3) {
      view.setUint8(at, 3);
      view.setInt32(at + 1, t[i] + offset, true);
      view.setInt32(at + 5, t[i + 1] + offset, true);
      view.setInt32(at + 9, t[i + 2] + offset, true);
      out[at + 13] = r;
      out[at + 14] = g;
      out[at + 15] = b;
      at += 16;
    }
    offset += part.mesh.positions.length / 3;
  }
  return out;
}
