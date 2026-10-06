import type { MeshData } from '../geometry/mesh';
import { ByteReader } from './scan';
import { MeshBuilder } from './weld';

const NEWLINE = 10;
const RETURN = 13;
const SPACE = 32;
const TAB = 9;
const BACKSLASH = 92;

/**
 * Wavefront OBJ: only the geometry (`v` and `f` lines). OBJ has no units and
 * no agreed up axis; coordinates are taken as millimetres, as they are.
 */
export function parseObj(bytes: Uint8Array): MeshData {
  const n = bytes.length;
  if (n === 0) throw new Error('This OBJ file is empty.');
  const reader = new ByteReader(bytes);
  const estimate = Math.ceil(n / 100);
  const builder = new MeshBuilder(estimate, estimate * 2);
  // Welded index of each `v` line, in file order, which is how faces refer to them.
  let welded = new Int32Array(1024);
  let vertexCount = 0;
  // Faces, fan-triangulated, as indices into `welded`. Resolved at the end so
  // that a face may come before the vertices it uses.
  let faces = new Int32Array(3072);
  let faceLength = 0;
  const polygon: number[] = [];

  // Steps over blanks within a line; a backslash at the end of a line continues it on the next.
  const skipBlanks = () => {
    for (;;) {
      const c = bytes[reader.pos];
      if (c === SPACE || c === TAB) reader.pos++;
      else if (c === BACKSLASH && (bytes[reader.pos + 1] === NEWLINE || bytes[reader.pos + 1] === RETURN)) {
        reader.pos += bytes[reader.pos + 1] === RETURN && bytes[reader.pos + 2] === NEWLINE ? 3 : 2;
      } else break;
    }
  };

  while (reader.pos < n) {
    skipBlanks();
    const c = bytes[reader.pos];
    const blank = bytes[reader.pos + 1] === SPACE || bytes[reader.pos + 1] === TAB;
    if (c === 118 && blank) {
      // v x y z [w] or v x y z r g b
      reader.pos++;
      skipBlanks();
      reader.end = lineEnd(bytes, reader.pos);
      const x = reader.number();
      const y = reader.number();
      const z = reader.number();
      reader.end = n;
      if (vertexCount === welded.length) welded = grow(welded);
      welded[vertexCount++] = builder.vertex(x, y, z);
    } else if (c === 102 && blank) {
      // f v v/vt v/vt/vn v//vn ...: only the first number of each corner matters here.
      reader.pos++;
      polygon.length = 0;
      for (;;) {
        skipBlanks();
        if (bytes[reader.pos] === NEWLINE || bytes[reader.pos] === RETURN) break;
        const index = reader.number();
        if (!Number.isInteger(index)) break;
        // Negative indices count back from the last vertex defined so far.
        const v = index < 0 ? vertexCount + index : index - 1;
        polygon.push(v >= 0 && v < 0x7fffffff ? v : -1);
        while (reader.pos < n && bytes[reader.pos] > SPACE && bytes[reader.pos] !== BACKSLASH) reader.pos++;
      }
      for (let i = 2; i < polygon.length; i++) {
        if (faceLength + 3 > faces.length) faces = grow(faces);
        faces[faceLength++] = polygon[0];
        faces[faceLength++] = polygon[i - 1];
        faces[faceLength++] = polygon[i];
      }
    }
    reader.pos = lineEnd(bytes, reader.pos) + 1;
  }

  const resolve = (i: number) => (i >= 0 && i < vertexCount ? welded[i] : -1);
  for (let i = 0; i < faceLength; i += 3) {
    builder.triangle(resolve(faces[i]), resolve(faces[i + 1]), resolve(faces[i + 2]));
  }
  if (builder.size === 0) {
    throw new Error(faceLength ? 'This OBJ file has no usable faces.' : 'This OBJ file has no faces.');
  }
  return builder.finish();
}

function lineEnd(bytes: Uint8Array, from: number): number {
  const i = bytes.indexOf(NEWLINE, from);
  return i < 0 ? bytes.length : i;
}

function grow(a: Int32Array) {
  const grown = new Int32Array(a.length * 2);
  grown.set(a);
  return grown;
}
