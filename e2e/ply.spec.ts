// A PLY file with colors, in the built app: the colors come in as a picture the reader writes
// itself, which the browser has to be able to decode and the viewer to draw.
import type { Page } from '@playwright/test';
import { brightness, dropFiles, expect, notices, openApp, pngBytes, sceneCount, screenPoint, settled, skinColors, skins, store, test } from './helpers';

/** A cube of 20 mm whose six sides each name a color. */
function coloredCube(): number[] {
  const points = ['0 0 0', '20 0 0', '20 20 0', '0 20 0', '0 0 20', '20 0 20', '20 20 20', '0 20 20'];
  const sides = ['4 0 3 2 1 255 0 0', '4 4 5 6 7 0 255 0', '4 0 1 5 4 0 0 255', '4 1 2 6 5 255 255 0', '4 2 3 7 6 0 255 255', '4 3 0 4 7 255 0 255'];
  const head = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices', 'property uchar red', 'property uchar green', 'property uchar blue', 'end_header'];
  return [...new TextEncoder().encode([...head, ...points, ...sides, ''].join('\n'))];
}

/** A cube of 20 mm whose points have colors: black at the bottom, white at the top. */
function shadedCube(): number[] {
  const points = ['0 0 0 0 0 0', '20 0 0 0 0 0', '20 20 0 0 0 0', '0 20 0 0 0 0', '0 0 20 255 255 255', '20 0 20 255 255 255', '20 20 20 255 255 255', '0 20 20 255 255 255'];
  const sides = ['4 0 3 2 1', '4 4 5 6 7', '4 0 1 5 4', '4 1 2 6 5', '4 2 3 7 6', '4 3 0 4 7'];
  const head = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 6', 'property list uchar int vertex_indices', 'end_header'];
  return [...new TextEncoder().encode([...head, ...points, ...sides, ''].join('\n'))];
}

/** A cube of 20 mm whose points are laid out on the picture it names. */
function skinnedCube(): number[] {
  const head = ['ply', 'format ascii 1.0', 'comment TextureFile skin.png', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property float s', 'property float t', 'element face 6', 'property list uchar int vertex_indices', 'end_header'];
  const points = ['0 0 0 0 0', '20 0 0 1 0', '20 20 0 1 1', '0 20 0 0 1', '0 0 20 0 0', '20 0 20 1 0', '20 20 20 1 1', '0 20 20 0 1'];
  const sides = ['4 0 3 2 1', '4 4 5 6 7', '4 0 1 5 4', '4 1 2 6 5', '4 2 3 7 6', '4 3 0 4 7'];
  return [...new TextEncoder().encode([...head, ...points, ...sides, ''].join('\n'))];
}

/** The picture the one object on the plate wears, by the name of its file; null when it wears none. */
const worn = (page: Page): Promise<string | null> =>
  store(page, (m) => {
    const node = m.getState().doc.scene[0];
    const picture = node.type === 'import' && node.texture ? m.getState().doc.assets[node.texture.asset] : undefined;
    return picture?.kind === 'image' ? picture.name : null;
  });

test.describe('PLY files', { tag: '@mouse' }, () => {
  test('a file that names a picture wears it when the two are dropped together', async ({ page, errors }) => {
    await openApp(page);
    await dropFiles(page, [
      { name: 'crate.ply', bytes: skinnedCube() },
      { name: 'skin.png', bytes: await pngBytes(page) },
    ]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    // One object: the picture went on the cube's faces, not onto a sheet of its own.
    expect(await worn(page)).toBe('skin.png');
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    expect(errors).toEqual([]);
  });

  test('a file dropped without the picture it names asks for it, and wears what is picked', async ({ page, errors }) => {
    await openApp(page);
    const picture = Buffer.from(await pngBytes(page));
    const asked: string[] = [];
    page.on('dialog', (dialog) => {
      asked.push(dialog.message());
      void dialog.accept();
    });
    page.on('filechooser', (chooser) => void chooser.setFiles({ name: 'skin.png', mimeType: 'image/png', buffer: picture }));
    await dropFiles(page, [{ name: 'crate.ply', bytes: skinnedCube() }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(asked).toEqual(['"crate.ply" names "skin.png" for its colors and pictures. Pick it now, or import the shapes without?']);
    expect(await worn(page)).toBe('skin.png');
    expect(errors).toEqual([]);
  });

  test('a file whose picture is turned down comes in plain', async ({ page, errors }) => {
    await openApp(page);
    page.on('dialog', (dialog) => void dialog.dismiss());
    await dropFiles(page, [{ name: 'crate.ply', bytes: skinnedCube() }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(await worn(page)).toBeNull();
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });


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

  test('a cube whose points have colors goes from one color to the next across each face', async ({ page, errors }) => {
    await openApp(page);
    await dropFiles(page, [{ name: 'shade.ply', bytes: shadedCube() }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    // Nothing selected: no handles over the cube.
    await store(page, (m) => m.select([]));
    await settled(page);
    // Three heights on the side that faces the view, all within one of its two triangles (the one under the
    // diagonal from the bottom left to the top right): one color all over would show the same at each.
    const shades: number[] = [];
    for (const z of [2, 8, 14]) {
      const [x, y] = await screenPoint(page, [6, -10, z]);
      shades.push(await brightness(page, x, y, 2));
    }
    expect(shades[1] - shades[0]).toBeGreaterThan(20);
    expect(shades[2] - shades[1]).toBeGreaterThan(20);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
