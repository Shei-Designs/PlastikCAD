// The core flows from end to end, through the store as the menus and shortcuts call it: shapes,
// a hole, a group, a gear and its mate, saving and reopening, every export format, and files
// brought back in. None of it may put an error on the console.
import type { Page } from '@playwright/test';
import { cubeFile, drawnCount, dropFiles, expect, fileVersion, notices, openApp, sceneCount, settled, store, storeAndProjects, test } from './helpers';

test.describe('core flows', { tag: '@mouse' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.startProject('Flows'));
  });

  test.afterEach(async ({ errors }) => {
    expect(errors, 'no page errors or console errors along the way').toEqual([]);
  });

  const noErrorNotice = async (page: Page): Promise<void> => expect((await notices(page)).filter((n) => n.kind === 'error'), 'nothing was said to have gone wrong').toEqual([]);

  /** A box with a cylinder cut out of it, grouped into one object. */
  async function boxWithHole(page: Page): Promise<void> {
    await store(page, async (m) => {
      m.addShape('box');
      m.addShape('cylinder');
      const [box, cylinder] = m.getState().doc.scene;
      m.select([cylinder.id]);
      m.setHole(true);
      m.nudgeSelected([0, 0, 5]);
      m.select([box.id, cylinder.id]);
      await m.groupSelected();
    });
    await settled(page);
  }

  /** A gear, and the gear that meshes with it, made through the mate wizard. */
  async function gearAndMate(page: Page): Promise<void> {
    await store(page, async (m) => {
      await m.addPart('gears');
      const gear = m.getState().doc.scene.find((n) => n.type === 'part')!;
      m.startMate(gear.id);
      await m.previewMate({ kind: 'gear', teeth: 21, backlash: 0.1, extra: 0, angle: 0 });
      await m.commitMate();
    });
    await settled(page);
  }

  test('a box with a hole groups into one object, drawn, with no error', async ({ page }) => {
    await boxWithHole(page);
    expect(await store(page, (m) => m.getState().doc.scene.map((n) => n.type))).toEqual(['group']);
    expect(await drawnCount(page)).toBe(1);
    await noErrorNotice(page);
  });

  test('a gear gets a mating gear through the wizard', async ({ page }) => {
    await gearAndMate(page);
    expect(await store(page, (m) => m.getState().doc.scene.filter((n) => n.type === 'part').length)).toBe(2);
    expect(await store(page, (m) => m.getState().mating), 'the wizard is closed').toBeNull();
    await noErrorNotice(page);
  });

  test('a pulley gets its mate through the wizard, a belt of the length typed away', async ({ page }) => {
    await store(page, (m) => m.addPart('pulleys'));
    await settled(page);
    await page.getByRole('button', { name: 'Add mating pulley…' }).click();
    const panel = page.getByRole('dialog', { name: 'Mating pulley' });
    await expect(panel).toBeVisible();
    // The pulley the tile gives has 20 teeth of GT2 at 2 mm; a belt of 100 teeth leaves 80 mm between two of them.
    await panel.getByRole('textbox', { name: 'Belt teeth' }).fill('100');
    await page.keyboard.press('Enter');
    await expect(panel).toContainText('Center distance 80 mm');
    await expect(panel).toContainText('Belt length 200 mm');
    await expect.poll(() => store(page, (m) => m.getState().mating?.building)).toBe(false);
    await panel.getByRole('button', { name: 'Accept' }).click();
    await expect(panel).toHaveCount(0);
    await settled(page);
    const parts = await store(page, (m) => m.getState().doc.scene.map((n) => (n.type === 'part' ? { part: n.part, teeth: n.params.teeth, pos: n.pos } : null)));
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => [p?.part, p?.teeth])).toEqual([['gt2-pulley', 20], ['gt2-pulley', 20]]);
    expect(parts[1]!.pos[0] - parts[0]!.pos[0]).toBeCloseTo(80, 3);
    expect(parts[1]!.pos[1]).toBeCloseTo(parts[0]!.pos[1], 6);
    expect(await drawnCount(page)).toBe(2);
    await noErrorNotice(page);
  });

  test('a torus resized to an oval builds and is drawn', async ({ page }) => {
    await store(page, (m) => {
      m.addShape('torus');
      m.updateNode(m.getState().doc.scene[0].id, { size: [60, 20, 8] });
    });
    await settled(page);
    expect(await store(page, (m) => m.getState().doc.scene[0].size)).toEqual([60, 20, 8]);
    expect(await drawnCount(page)).toBe(1);
    await noErrorNotice(page);
  });

  test('a project is saved in the current file format and reopens as it was', async ({ page }) => {
    await boxWithHole(page);
    await gearAndMate(page);
    const saved = await storeAndProjects(page, async (m, p) => {
      await m.saveProject(true);
      const key = m.getState().projectKey!;
      const before = m.getState().doc.scene;
      const listed = (await p.projectStore().list()).find((x) => x.key === key);
      const text = await p.projectStore().read(key);
      await m.startProject('Other');
      const between = m.getState().doc.scene.length;
      await m.openProject(key);
      return { before, after: m.getState().doc.scene, between, name: listed?.name, version: Number(/"version": (\d+)/.exec(text)?.[1]) };
    });
    expect(saved.before, 'the group, the gear and its mate').toHaveLength(3);
    expect(saved.between, 'another project was open in between').toBe(0);
    expect(saved.after, 'the design reopens as it was').toEqual(saved.before);
    expect(saved.name, 'the store lists it by its name').toBe('Flows');
    expect(saved.version, 'the file says the current format').toBe(await fileVersion(page));
    await noErrorNotice(page);
  });

  for (const format of ['stl', '3mf', 'obj', 'glb', 'svg', 'dxf'] as const) {
    test(`the design exports as ${format.toUpperCase()}`, async ({ page }) => {
      await boxWithHole(page);
      await store(page, (m) => m.select([]));
      const download = page.waitForEvent('download');
      const done = await store(page, (m, format) => m.exportDesign(format, false), format);
      expect(done, 'the export was not backed out of').toBe(true);
      expect((await download).suggestedFilename()).toBe(`Flows.${format}`);
      await expect.poll(() => notices(page)).toContainEqual({ kind: 'ok', text: expect.stringContaining(`Flows.${format}`) });
    });
  }

  test('an STL and a 3MF are imported beside a file that cannot be read, which is named', async ({ page }) => {
    await dropFiles(page, [
      { name: 'cube.stl', bytes: await cubeFile(page, 'stl') },
      { name: 'bad.stl', bytes: [] },
      { name: 'cube.3mf', bytes: await cubeFile(page, '3mf') },
    ]);
    await expect.poll(() => sceneCount(page)).toBe(2);
    await expect.poll(() => notices(page)).toContainEqual({ kind: 'error', text: expect.stringContaining('bad.stl') });
    await settled(page);
    expect(await drawnCount(page)).toBe(2);
  });

  test('undo and redo step back and forth through what was made', async ({ page }) => {
    await boxWithHole(page);
    await gearAndMate(page);
    await store(page, (m) => {
      m.undo();
      m.undo();
    });
    expect(await sceneCount(page), 'the gear and its mate are undone').toBe(1);
    await store(page, (m) => m.redo());
    expect(await sceneCount(page), 'the gear is back').toBe(2);
    await settled(page);
    expect(await drawnCount(page)).toBe(2);
  });
});
