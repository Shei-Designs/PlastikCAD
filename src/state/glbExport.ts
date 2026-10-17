// The GLB export: every object as its own mesh with its color and, when it has
// one, its skin painted and embedded. Runs on the main thread, where the
// pictures can be decoded and drawn; the kernel merges each object in the
// worker as for any other export.
import { CREASE_ANGLE, creasedNormals } from '../geometry/mesh';
import { skinMesh, skinOf, skinRepeats } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { writeGlb } from '../io/glb';
import type { GlbObject } from '../io/glb';
import { nodeMatrix } from '../model/math';
import type { Asset, SceneNode } from '../model/types';
import { SkinPainter } from '../viewer/skin';
import type { Painted } from '../viewer/skin';
import { geometry } from './geometry';

export async function exportGlb(nodes: SceneNode[], assets: Record<string, Asset>, name: string): Promise<Uint8Array> {
  const worker = await geometry.prepare(nodes, assets);
  let wake: (() => void) | null = null;
  const painter = new SkinPainter(() => wake?.());
  const paint = async (skin: Skin): Promise<Painted> => {
    for (;;) {
      const painted = painter.paint(JSON.stringify(skin), skin, assets, true);
      if (painted) return painted;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  try {
    const objects: GlbObject[] = [];
    for (const node of nodes) {
      if (node.hole || node.hidden) continue;
      const result = await worker.export([node], false, true, true);
      const render = creasedNormals(result.mesh.positions, result.mesh.triangles, CREASE_ANGLE);
      const object: GlbObject = { name: node.name, positions: render.positions, normals: render.normals, matrix: nodeMatrix(node), color: node.color };
      const skin = skinOf(node);
      if (skin) {
        const painted = await paint(skin);
        // Stickers smaller than the triangles under them are cut out, so their atlas cells do not bleed into each other.
        const mesh = skinMesh(skin, node, render, result.bounds, painted.rects);
        object.positions = mesh.positions;
        object.normals = mesh.normals;
        const uv = mesh.uv;
        const asset = skin.kind === 'stickers' ? null : assets[skin.asset];
        // A JPEG has no transparency, so it goes out as it is; anything else is flattened onto the object's color.
        if (asset?.kind === 'image' && asset.mime === 'image/jpeg') object.skin = { uv, image: SkinPainter.bytes(asset), mime: asset.mime, repeat: skinRepeats(skin) };
        else object.skin = { uv, image: await SkinPainter.png(painted), mime: 'image/png', repeat: skinRepeats(skin) };
      }
      objects.push(object);
    }
    if (objects.length === 0) throw new Error('There is nothing to export.');
    return writeGlb(objects, name);
  } finally {
    painter.dispose();
  }
}
