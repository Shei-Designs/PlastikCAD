// A PLY file with colors, in the built app: the colors come in as a picture the reader writes
// itself, which the browser has to be able to decode and the viewer to draw.
import { dropFiles, expect, notices, openApp, sceneCount, settled, skinColors, skins, store, test } from './helpers';

/** A cube of 20 mm whose six sides each name a color. */
function coloredCube(): number[] {
  const points = ['0 0 0', '20 0 0', '20 20 0', '0 20 0', '0 0 20', '20 0 20', '20 20 20', '0 20 20'];
  const sides = ['4 0 3 2 1 255 0 0', '4 4 5 6 7 0 255 0', '4 0 1 5 4 0 0 255', '4 1 2 6 5 255 255 0', '4 2 3 7 6 0 255 255', '4 3 0 4 7 255 0 255'];
  const head = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices', 'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  return [...new TextEncoder().encode([...head, ...points, ...sides, ''].join('\n'))];
}

test.describe('PLY files', { tag: '@mouse' }, () => {
  test('a cube with a color on each side comes in as one solid wearing those colors', async ({ page, errors }) => {
    await openApp(page);
    await dropFiles(page, [{ name: 'die.ply', bytes: coloredCube() }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    const die = await store(page, (m) => {
      const node = m.getState().doc.scene[0];
      const picture = node.type === 'import' && node.texture ? m.getState().doc.assets[node.texture.asset] : undefined;
      return { id: node.id, type: node.type, name: node.name, size: node.size, mode: node.type === 'import' ? node.texture?.mode : undefined, picture: picture?.kind === 'image' ? [picture.width, picture.height] : null };
    });
    expect(die).toMatchObject({ type: 'import', name: 'die', size: [20, 20, 20], mode: 'own', picture: [4, 2] });
    // The picture the reader wrote is one the browser reads, and the cube is drawn with it.
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    expect(await skinColors(page, die.id)).toEqual(['#0000ff', '#00ff00', '#00ffff', '#ff0000', '#ff00ff', '#ffff00']);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
