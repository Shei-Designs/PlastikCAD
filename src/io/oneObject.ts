// A file's parts as one object. A model file gives a part for every material (a robot's trunk in five), and the
// design keeps several parts together as a group, which is made of solids: parts that are open shells cannot be
// grouped, and used to come in loose, each set down on the plate by itself. Such a file comes in as one mesh
// instead, which wears its parts' colors as a picture, the way a PLY file's colors do.
import type { MeshData, MeshWithUV } from '../geometry/mesh';
import type { ImportedPart } from './import';
import { paint } from './importPly';
import { MeshBuilder } from './weld';

/** The color of a part that names none, among parts that do. */
const PLAIN = [128, 128, 128];

/** Whether a mesh is the skin of a solid: every edge used once each way. */
export function closed({ triangles: t }: MeshData): boolean {
  const edges = new Map<number, number>();
  // Corners are counted in a mesh of this size at most: two of them make one number.
  const span = 2 ** 26;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = t[i + k] * span + t[i + ((k + 1) % 3)];
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const [a, b] = [Math.floor(key / span), key % span];
    if (n !== 1 || edges.get(b * span + a) !== 1) return false;
  }
  return true;
}

const channels = (hex: string | undefined): number[] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : PLAIN;
};

/**
 * The parts of a file as one part, when they cannot be kept as a group: there are several, one of them is no
 * closed solid, and none wears a picture of its own (a picture goes by its part's own coordinates, which the one
 * mesh does not keep). Null when the
 * parts can stay as they are. The one mesh is all of theirs, corners at one place joined; where the parts differ
 * in color it wears a picture that holds each color once.
 */
export function asOne(parts: ImportedPart[]): ImportedPart | null {
  if (parts.length < 2 || parts.some((p) => p.image) || parts.every((p) => closed(p.mesh))) return null;
  const corners = parts.reduce((n, p) => n + p.mesh.positions.length / 3, 0);
  const count = parts.reduce((n, p) => n + p.mesh.triangles.length / 3, 0);
  const builder = new MeshBuilder(corners, count);
  const colors = new Uint8Array(count * 9);
  for (const part of parts) {
    const { positions, triangles } = part.mesh;
    const index = new Int32Array(positions.length / 3);
    for (let i = 0; i < index.length; i++) index[i] = builder.vertex(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    const color = channels(part.color);
    for (let i = 0; i < triangles.length; i += 3) {
      const before = builder.size;
      builder.triangle(index[triangles[i]], index[triangles[i + 1]], index[triangles[i + 2]]);
      // A triangle with no area, or a corner that is no number, is not kept, and has no color to keep.
      if (builder.size === before) continue;
      for (let k = 0; k < 9; k++) colors[before * 9 + k] = color[k % 3];
    }
  }
  if (builder.size === 0) return null;
  const mesh: MeshWithUV = builder.finish();
  const one: ImportedPart = { name: parts[0].name, mesh };
  if (parts.some((p) => p.color)) {
    const painted = paint(colors, builder.size);
    one.color = painted.color;
    if (painted.picture) {
      mesh.uv = painted.picture.uv;
      one.image = { name: `${parts[0].name}.png`, mime: 'image/png', bytes: painted.picture.png };
    }
  }
  return one;
}
