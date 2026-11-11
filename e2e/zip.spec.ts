// Zip archives, in the built app: an archive dropped on the app is taken for the files in it, so a
// model comes in with the material library and pictures packed beside it.
import { strToU8, zipSync } from 'fflate';
import type { Page } from '@playwright/test';
import { cubeFile, dropFiles, expect, notices, openApp, pngBytes, sceneCount, settled, skins, store, test } from './helpers';

/** A cube of 20 mm laid out on the picture its material names. */
const CRATE = [
  'mtllib crate.mtl',
  ...['0 0 0', '20 0 0', '20 20 0', '0 20 0', '0 0 20', '20 0 20', '20 20 20', '0 20 20'].map((v) => `v ${v}`),
  ...['0 0', '1 0', '1 1', '0 1'].map((t) => `vt ${t}`),
  'usemtl wood',
  ...['1 4 3 2', '5 6 7 8', '1 2 6 5', '2 3 7 6', '3 4 8 7', '4 1 5 8'].map((f) => `f ${f.split(' ').map((v, i) => `${v}/${i + 1}`).join(' ')}`),
  '',
].join('\n');

const zipped = (files: Record<string, Uint8Array>): number[] => [...zipSync(files)];

/** What is on the plate: each object's kind and name, and the picture it wears by the name of its file. */
const plate = (page: Page): Promise<{ type: string; name: string; picture: string | null }[]> =>
  store(page, (m) =>
    m.getState().doc.scene.map((node) => {
      const key = node.type === 'import' ? node.texture?.asset : node.type === 'picture' ? node.asset : undefined;
      const picture = key ? m.getState().doc.assets[key] : undefined;
      return { type: node.type, name: node.name, picture: picture?.kind === 'image' ? picture.name : null };
    }),
  );

test.describe('zip archives', { tag: '@mouse' }, () => {
  test('a model comes in with the material library and the picture packed beside it, and nothing else of the archive', async ({ page, errors }) => {
    await openApp(page);
    const picture = Uint8Array.from(await pngBytes(page));
    await dropFiles(page, [
      {
        name: 'crate.zip',
        bytes: zipped({
          'crate/crate.obj': strToU8(CRATE),
          'crate/crate.mtl': strToU8('newmtl wood\nKd 1 1 1\nmap_Kd textures/wood.png\n'),
          'crate/textures/wood.png': picture,
          // The other maps and the preview a bundle comes with are no picture sheets.
          'crate/textures/wood_normal.png': picture,
          'crate/preview.jpg': picture,
          'crate/license.txt': strToU8('free to use'),
          '__MACOSX/crate/._crate.obj': strToU8('junk'),
        }),
      },
    ]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(await plate(page)).toEqual([{ type: 'import', name: 'crate', picture: 'crate/textures/wood.png' }]);
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('every model of an archive comes in, named after its file, beside a file dropped with it', async ({ page, errors }) => {
    await openApp(page);
    const cube = Uint8Array.from(await cubeFile(page, 'stl'));
    await dropFiles(page, [
      { name: 'kit.zip', bytes: zipped({ 'kit/meshes/base.stl': cube, 'kit/meshes/arm.stl': cube }) },
      { name: 'loose.stl', bytes: [...cube] },
    ]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(3);
    await settled(page);
    expect((await plate(page)).map((n) => n.name)).toEqual(['base', 'arm', 'loose']);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('an archive of pictures alone puts each on a sheet', async ({ page, errors }) => {
    await openApp(page);
    const picture = Uint8Array.from(await pngBytes(page));
    await dropFiles(page, [{ name: 'labels.zip', bytes: zipped({ 'labels/front.png': picture }) }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(await plate(page)).toEqual([{ type: 'picture', name: 'front', picture: 'labels/front.png' }]);
    expect(errors).toEqual([]);
  });

  test('an archive with nothing the app reads is said to hold nothing, by its name', async ({ page, errors }) => {
    await openApp(page);
    await dropFiles(page, [{ name: 'papers.zip', bytes: zipped({ 'report.txt': strToU8('words'), 'sheet.csv': strToU8('1,2') }) }]);
    await expect.poll(async () => (await notices(page)).filter((n) => n.kind === 'error').map((n) => n.text)).toEqual(['Nothing in "papers.zip" can be imported. Supported: STL, OBJ, 3MF, GLB, GLTF, DAE, PLY, STEP, STP, SVG, DXF, PNG, JPG, JPEG.']);
    expect(await sceneCount(page)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a robot package comes in as its robot, the meshes of its links found in the archive', async ({ page, errors }) => {
    await openApp(page);
    const cube = Uint8Array.from(await cubeFile(page, 'stl'));
    // A package as ROS keeps one, and as the app exports it: everything under the package's name, the meshes named by the URDF.
    const urdf = [
      '<?xml version="1.0"?>',
      '<robot name="crane">',
      '  <link name="base"><visual><geometry><mesh filename="package://crane/meshes/visual/base.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>',
      '  <link name="arm"><visual><geometry><mesh filename="package://crane/meshes/visual/arm.stl" scale="0.001 0.001 0.001"/></geometry></visual></link>',
      '  <joint name="lift" type="revolute">',
      '    <parent link="base"/><child link="arm"/><origin xyz="0 0 0.02"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/>',
      '  </joint>',
      '</robot>',
      '',
    ].join('\n');
    await dropFiles(page, [
      {
        name: 'crane.zip',
        bytes: zipped({
          'crane/package.xml': strToU8('<package format="3"><name>crane</name></package>'),
          'crane/launch/display.launch.py': strToU8('# launch'),
          'crane/urdf/crane.urdf': strToU8(urdf),
          'crane/meshes/visual/base.stl': cube,
          'crane/meshes/visual/arm.stl': cube,
        }),
      },
    ]);
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.links.length ?? 0), { timeout: 30_000 }).toBe(2);
    await settled(page);
    const robot = await store(page, (m) => ({
      mode: m.getState().robot,
      joints: m.getState().doc.robot?.joints.length ?? 0,
      // Both links have their shape: the meshes were found, not asked for.
      links: m.getState().doc.scene.map((n) => ({ name: n.name, type: n.type, size: n.size.map((v) => Math.round(v)) })),
    }));
    expect(robot).toEqual({ mode: true, joints: 1, links: [{ name: 'base', type: 'import', size: [10, 10, 10] }, { name: 'arm', type: 'import', size: [10, 10, 10] }] });
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
