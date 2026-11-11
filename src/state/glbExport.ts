// The GLB export: every object as its own mesh with its color and, when it has
// one, its skin painted and embedded; a group whose parts have colors of their
// own as one mesh of a primitive per color. Runs on the main thread, where the
// pictures can be decoded and drawn; the kernel merges each object in the
// worker as for any other export.
import { CREASE_ANGLE, creasedNormals } from '../geometry/mesh';
import type { RenderMesh } from '../geometry/mesh';
import { skinMesh, skinOf, skinRepeats } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { tr } from '../i18n';
import { writeGlb } from '../io/glb';
import type { GlbObject } from '../io/glb';
import { emptyBounds, expandBounds, nodeMatrix } from '../model/math';
import type { Bounds } from '../model/math';
import type { Asset, ImageAsset, SceneNode } from '../model/types';
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
  // The bytes of each picture, read or encoded once however many objects wear it: a JPEG by its asset, a painting by itself.
  const jpegs = new Map<string, Uint8Array>();
  const pngs = new Map<Painted, Uint8Array>();
  const jpeg = (key: string, asset: ImageAsset): Uint8Array => jpegs.get(key) ?? jpegs.set(key, SkinPainter.bytes(asset)).get(key)!;
  const png = async (painted: Painted): Promise<Uint8Array> => pngs.get(painted) ?? pngs.set(painted, await SkinPainter.png(painted)).get(painted)!;
  /** One glTF primitive: the mesh (in the node's built frame) with its color and, if the node wears one, its skin. */
  const object = async (node: SceneNode, render: RenderMesh, bounds: Bounds, color: string, skin: Skin | null): Promise<GlbObject> => {
    const out: GlbObject = { name: node.name, of: node.id, positions: render.positions, normals: render.normals, matrix: nodeMatrix(node), color };
    if (!skin) return out;
    // The fill around and under the pictures is this part's color (a part is one color, whatever its group is).
    const painted = await paint(skin.kind === 'stickers' ? { ...skin, color, mixed: false } : { ...skin, color });
    // Stickers smaller than the triangles under them are cut out, so their atlas cells do not bleed into each other.
    const mesh = skinMesh(skin, node, render, bounds, painted.rects);
    out.positions = mesh.positions;
    out.normals = mesh.normals;
    const asset = skin.kind === 'stickers' ? null : assets[skin.asset];
    // A JPEG has no transparency, so it goes out as it is; anything else is flattened onto the object's color.
    if (skin.kind !== 'stickers' && asset?.kind === 'image' && asset.mime === 'image/jpeg') out.skin = { uv: mesh.uv, image: jpeg(skin.asset, asset), mime: asset.mime, repeat: skinRepeats(skin) };
    else out.skin = { uv: mesh.uv, image: await png(painted), mime: 'image/png', repeat: skinRepeats(skin) };
    return out;
  };
  try {
    const objects: GlbObject[] = [];
    for (const node of nodes) {
      if (node.hole || node.hidden) continue;
      const skin = skinOf(node);
      // A texture over the whole covers the parts of a mixed group, which then keeps its one color.
      if (node.type === 'group' && node.mixed && skin?.kind !== 'texture') {
        const colored = await worker.exportColored([node], true, true);
        const parts = colored.objects[0]?.parts ?? [];
        const bounds = emptyBounds();
        for (const part of parts) for (let i = 0; i < part.mesh.positions.length; i += 3) expandBounds(bounds, [part.mesh.positions[i], part.mesh.positions[i + 1], part.mesh.positions[i + 2]]);
        for (const part of parts) objects.push(await object(node, creasedNormals(part.mesh.positions, part.mesh.triangles, CREASE_ANGLE), bounds, part.color, skin));
        continue;
      }
      const result = await worker.export([node], false, true, true);
      const render = creasedNormals(result.mesh.positions, result.mesh.triangles, CREASE_ANGLE);
      if (result.uv) render.uv = result.uv;
      objects.push(await object(node, render, result.bounds, node.color, skin));
    }
    if (objects.length === 0) throw new Error(tr('There is nothing to export.'));
    return writeGlb(objects, name);
  } finally {
    painter.dispose();
  }
}
