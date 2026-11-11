// STEP files in the built app: OpenCascade is fetched when the first one is read, in the geometry
// worker, and the solids come in as objects of the size the file gives them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawnCount, dropFiles, expect, notices, openApp, sceneCount, settled, store, test } from './helpers';

const fixture = (name: string): number[] => [...readFileSync(fileURLToPath(new URL(`../fixtures/step/${name}`, import.meta.url)))];

test.describe('STEP import', { tag: '@mouse' }, () => {
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
});
