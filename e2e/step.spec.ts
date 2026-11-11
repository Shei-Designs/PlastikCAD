// The formats read and written by a library that is fetched for them, in the built app: STEP files
// by OpenCascade, and glTF files compressed with Draco by its decoder. Neither is fetched until a file
// asks for it, and what comes in is the size the file gives it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawnCount, dropFiles, expect, notices, openApp, sceneCount, settled, store, test } from './helpers';

const fixture = (name: string, folder = 'step'): number[] => [...readFileSync(fileURLToPath(new URL(`../fixtures/${folder}/${name}`, import.meta.url)))];

test.describe('STEP and compressed glTF', { tag: '@mouse' }, () => {
  test('a STEP file of two solids comes in as a group of two parts, at their sizes and where the file put them', async ({ page, errors }) => {
    await openApp(page);
    // Nothing of OpenCascade is fetched until a STEP file asks for it.
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (/replicad_single.*\.wasm/.test(r.url())) fetched.push(r.url());
    });
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    expect(fetched).toEqual([]);
    await dropFiles(page, [{ name: 'kit.step', bytes: fixture('plate-and-post.step') }]);
    await expect.poll(() => sceneCount(page), { message: 'the kit is on the plate', timeout: 30_000 }).toBe(2);
    expect(fetched).toHaveLength(1);
    await settled(page);
    const kit = await store(page, (m) => {
      const node = m.getState().doc.scene[1];
      return { type: node.type, name: node.name, size: node.size, parts: node.type === 'group' ? node.children.map((c) => ({ name: c.name, size: c.size.map((v) => Math.round(v * 10) / 10) })) : [] };
    });
    // The plate from 0 to 40 and the post out to 65: 65 across, 30 deep, 20 tall.
    expect(kit.type).toBe('group');
    expect(kit.name).toBe('kit');
    expect(kit.size.map((v) => Math.round(v))).toEqual([65, 30, 20]);
    expect(kit.parts).toEqual([
      { name: 'kit 1', size: [40, 30, 10] },
      { name: 'kit 2', size: [10, 10, 20] },
    ]);
    expect(await drawnCount(page)).toBe(2);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    // A second file is read with what is already loaded.
    await dropFiles(page, [{ name: 'plate.stp', bytes: fixture('plate.step') }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(3);
    expect(fetched).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a plate with a hole drilled through it goes out as a STEP solid whose hole is a cylinder, and comes back the same size', async ({ page, errors }) => {
    await openApp(page);
    await store(page, async (m) => {
      m.addShape('box');
      m.updateNode(m.getState().doc.scene[0].id, { size: [40, 30, 4], pos: [0, 0, 2] });
      m.addShape('cylinder');
      m.updateNode(m.getState().doc.scene[1].id, { size: [8, 8, 10], pos: [5, 3, 2], hole: true });
      m.selectAll();
      await m.groupSelected();
      m.setPrefs({ format: 'step' });
    });
    await settled(page);
    expect(await sceneCount(page)).toBe(1);
    const download = page.waitForEvent('download');
    expect(await store(page, (m) => m.exportDesign('step', false))).toBe(true);
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.step$/);
    const step = readFileSync(await saved.path(), 'utf8');
    const count = (entity: string): number => (step.match(new RegExp(`\\b${entity}\\(`, 'g')) ?? []).length;
    // The plate's six sides and the wall of the hole.
    expect(count('MANIFOLD_SOLID_BREP')).toBe(1);
    expect(count('ADVANCED_FACE')).toBe(7);
    expect(count('CYLINDRICAL_SURFACE')).toBe(1);
    expect(count('PLANE')).toBe(6);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    // And back in: a second object, the size of the first.
    await dropFiles(page, [{ name: 'back.step', bytes: [...Buffer.from(step)] }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(2);
    expect(await store(page, (m) => m.getState().doc.scene[1].size.map((v) => Math.round(v * 100) / 100))).toEqual([40, 30, 4]);
    expect(errors).toEqual([]);
  });

  test('a glTF file compressed with Draco is unpacked by a decoder fetched for it, and comes in at its size', async ({ page, errors }) => {
    await openApp(page);
    const fetched: string[] = [];
    page.on('request', (r) => {
      if (/draco_decoder.*\.wasm/.test(r.url())) fetched.push(r.url());
    });
    await dropFiles(page, [{ name: 'box.glb', bytes: fixture('box-draco.glb', 'gltf') }]);
    await expect.poll(() => sceneCount(page), { timeout: 30_000 }).toBe(1);
    expect(fetched).toHaveLength(1);
    const box = await store(page, (m) => {
      const node = m.getState().doc.scene[0];
      return { size: node.size.map((v) => Math.round(v * 10) / 10), color: node.color };
    });
    expect(box).toEqual({ size: [40, 30, 10], color: '#ff0000' });
    await settled(page);
    expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
