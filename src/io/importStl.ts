import type { MeshData } from '../geometry/mesh';
import { ByteReader, isSpace } from './scan';
import { MeshBuilder } from './weld';

const HEADER = 84;
const FACET = 50;

/** Binary or ASCII STL. STL has no units; millimeters are assumed, as every slicer does. */
export function parseStl(bytes: Uint8Array): MeshData {
  if (bytes.length === 0) throw new Error('This STL file is empty.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length >= HEADER ? view.getUint32(80, true) : 0;

  // The header of a binary file is free text and sometimes begins with
  // "solid" like an ASCII file, so the length test comes first: only a binary
  // file is exactly as long as its triangle count says.
  let mesh: MeshData;
  if (bytes.length >= HEADER && HEADER + count * FACET === bytes.length) mesh = parseBinary(view, count);
  else if (looksAscii(bytes)) mesh = parseAscii(bytes);
  else if (bytes.length < HEADER) throw new Error('This is not an STL file, or it is incomplete.');
  else if (HEADER + count * FACET > bytes.length) {
    const present = Math.floor((bytes.length - HEADER) / FACET);
    throw new Error(`This STL file is incomplete: it should hold ${count} triangles but ends after ${present}.`);
  }
  // Longer than it needs to be: some writers pad the file or append their own data.
  else mesh = parseBinary(view, count);

  if (mesh.triangles.length === 0) throw new Error('This STL file has no triangles.');
  return mesh;
}

function parseBinary(view: DataView, count: number): MeshData {
  // A closed mesh has about half as many vertices as triangles.
  const builder = new MeshBuilder((count >> 1) + 16, count);
  const corner = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    // Skip the normal: it is recomputed from the winding wherever it is needed.
    let o = HEADER + i * FACET + 12;
    for (let k = 0; k < 3; k++) {
      corner[k] = builder.vertexBits(view.getUint32(o, true), view.getUint32(o + 4, true), view.getUint32(o + 8, true));
      o += 12;
    }
    builder.triangle(corner[0], corner[1], corner[2]);
  }
  return builder.finish();
}

/** Starts with "solid" and mentions a facet somewhere. */
function looksAscii(bytes: Uint8Array): boolean {
  let i = 0;
  // UTF-8 byte order mark
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && isSpace(bytes[i])) i++;
  const reader = new ByteReader(bytes);
  reader.pos = i;
  if (!reader.word('solid')) return false;
  // "facet", in either case
  for (i = reader.pos; i + 5 <= bytes.length; i++) {
    if (
      (bytes[i] | 0x20) === 0x66 &&
      (bytes[i + 1] | 0x20) === 0x61 &&
      (bytes[i + 2] | 0x20) === 0x63 &&
      (bytes[i + 3] | 0x20) === 0x65 &&
      (bytes[i + 4] | 0x20) === 0x74
    ) {
      return true;
    }
  }
  return false;
}

function parseAscii(bytes: Uint8Array): MeshData {
  // An ASCII facet takes 150 to 300 bytes.
  const estimate = Math.ceil(bytes.length / 200);
  const builder = new MeshBuilder((estimate >> 1) + 16, estimate);
  const reader = new ByteReader(bytes);
  const corner = [0, 0, 0];
  let corners = 0;
  for (;;) {
    reader.skipSpace();
    if (reader.pos >= reader.end) break;
    if (reader.word('vertex')) {
      // A missing or malformed number reads as NaN, which drops the triangle.
      const x = reader.number();
      const y = reader.number();
      const z = reader.number();
      corner[corners] = builder.vertex(x, y, z);
      if (++corners === 3) {
        builder.triangle(corner[0], corner[1], corner[2]);
        corners = 0;
      }
    } else if (reader.word('endloop') || reader.word('endfacet')) {
      // Starting afresh at the end of each loop keeps a facet that lost a vertex from shifting all those after it.
      corners = 0;
    } else reader.skipToken();
  }
  return builder.finish();
}
