// The colors on the surface of a mixed group: each face in the color of the
// part it came from (see `Faces`), which the viewer draws and the GLB export
// writes as corner colors. Pure.
import { linearColor } from '../io/glb';
import { sourceColor } from '../model/ops';
import type { GroupNode } from '../model/types';
import { NO_SOURCE } from './mesh';
import type { Faces } from './mesh';

const WHITE: [number, number, number] = [1, 1, 1];

/** Tells one coloring of a group's faces from another: same key, same corner colors (for the same mesh). */
export const tintKey = (group: GroupNode, faces: Faces): string => `${group.color}|${faces.sources.map((path) => sourceColor(group, path)).join(',')}`;

/**
 * Linear RGB for every corner of a mesh of `triangles` unindexed triangles
 * made from the group's faces. `origin` maps each triangle to the face it was
 * cut from when the mesh is not the group's own (see `SkinMesh.faces`);
 * triangles under a picture (`covered`) come out white, so that the picture
 * shows as it is where the corner colors multiply into it.
 */
export function cornerColors(group: GroupNode, faces: Faces, triangles: number, options: { origin?: Uint32Array; covered?: (triangle: number) => boolean } = {}): Float32Array {
  const palette = faces.sources.map((path) => linearColor(sourceColor(group, path)));
  const own = linearColor(group.color);
  const out = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const face = options.origin ? options.origin[t] : t;
    const s = faces.source[face];
    const rgb = options.covered?.(t) ? WHITE : s === undefined || s === NO_SOURCE || s >= palette.length ? own : palette[s];
    for (let k = 0; k < 3; k++) out.set(rgb, t * 9 + k * 3);
  }
  return out;
}

/** Whether a triangle of a skinned mesh lies under a picture: its corners sample the atlas rather than the fill (see `FILL_UV`). */
export const underPicture = (uv: Float32Array, triangle: number): boolean => uv[triangle * 6] >= 0;
