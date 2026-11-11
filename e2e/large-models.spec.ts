// Large models: a mesh of over a hundred thousand triangles is read in the geometry worker, drawn,
// picked through the tree that came with it and measured once it has been read; a tiny model that
// names no unit is asked about; and slow work that is called off leaves the design as it was.
import type { Page } from '@playwright/test';
import { cubeFile, drawnCount, drawnMesh, dropFiles, expect, fitView, hitsObject, measureOverlay, measurePicks, notices, openApp, sceneCount, sceneIds, screenPoint, selection, settled, store, test } from './helpers';

/** Imports a bumpy ball of about `2 × rows²` triangles, 100 mm across, as a binary STL made in the page. */
async function importBall(page: Page, rows: number): Promise<void> {
  await store(
    page,
    async (m, rows) => {
      const at = (i: number, j: number): number[] => {
        const th = (Math.PI * i) / rows;
        const ph = (2 * Math.PI * (j % rows)) / rows;
        const r = i === 0 || i === rows ? 50 : 50 + 2 * Math.sin(th * 9) * Math.cos(ph * 7);
        return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
      };
      const count = 2 * rows * (rows - 1);
      const bytes = new Uint8Array(84 + count * 50);
      const view = new DataView(bytes.buffer);
      view.setUint32(80, count, true);
      let t = 0;
      const put = (corners: number[][]): void => {
        corners.forEach((p, c) => p.forEach((v, k) => view.setFloat32(84 + t * 50 + 12 + c * 12 + k * 4, v, true)));
        t++;
      };
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < rows; j++) {
          if (i > 0) put([at(i, j), at(i + 1, j), at(i, j + 1)]);
          if (i < rows - 1) put([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
        }
      await m.receiveFiles([{ name: 'ball.stl', path: null, bytes }]);
    },
    rows,
  );
}

test.describe('large models', { tag: '@mouse' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('a mesh of 120,000 triangles comes in, is drawn, and is picked by the pointer', async ({ page, errors }) => {
    await importBall(page, 246);
    expect(await sceneCount(page)).toBe(1);
    await settled(page);
    await fitView(page);
    const mesh = await drawnMesh(page);
    expect(mesh.triangles).toBe(2 * 246 * 245);
    expect(mesh.watertight, 'the ball is a closed solid').toBe(true);
    expect(mesh.indexed, 'every triangle is in the tree the pointer goes down').toBe(mesh.triangles);
    // The ball stands on the plate: its middle is 52 mm up, a bump's height above its radius.
    const [id] = await sceneIds(page);
    const on = await screenPoint(page, [0, 0, 52]);
    const off = await screenPoint(page, [90, 0, 52]);
    expect(await hitsObject(page, on[0], on[1]), 'the pointer over the ball is on it').toBe(true);
    expect(await hitsObject(page, off[0], off[1]), 'the pointer beside the ball is not').toBe(false);
    await store(page, (m) => m.select([]));
    await page.mouse.click(on[0], on[1]);
    expect(await selection(page)).toEqual([id]);
    expect(errors).toEqual([]);
  });

  test('a large mesh is measured once it has been read, away from the pointer', async ({ page, errors }) => {
    await importBall(page, 246);
    await settled(page);
    await fitView(page);
    const [id] = await sceneIds(page);
    await store(page, (m) => {
      m.select([]);
      m.toggleMeasuring();
      m.setMeasureKinds(['face']);
    });
    const on = await screenPoint(page, [0, 0, 52]);
    // The pointer over the ball asks for it to be read; until that is done there is nothing to take hold of.
    await page.mouse.move(on[0] - 3, on[1]);
    await page.mouse.move(on[0], on[1]);
    await expect.poll(async () => (await measureOverlay(page)).indexed, { message: 'the ball has been read', timeout: 20_000 }).toEqual([id]);
    await page.mouse.click(on[0], on[1]);
    await expect.poll(() => measurePicks(page)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a tiny model that names no unit is asked about, and comes in at the unit chosen', async ({ page, errors }) => {
    // A wedge 0.2 by 0.1 by 0.05: a robot's part written in meters.
    const facet = (c: number[]): string => `facet normal 0 0 0\nouter loop\nvertex ${c[0]} ${c[1]} ${c[2]}\nvertex ${c[3]} ${c[4]} ${c[5]}\nvertex ${c[6]} ${c[7]} ${c[8]}\nendloop\nendfacet`;
    const text = ['solid link', facet([0, 0, 0, 0.2, 0, 0, 0, 0.1, 0.05]), facet([0, 0, 0, 0, 0.1, 0.05, 0.2, 0, 0]), 'endsolid link', ''].join('\n');
    await dropFiles(page, [{ name: 'link.stl', bytes: [...new TextEncoder().encode(text)] }]);
    const box = page.getByRole('dialog').filter({ hasText: 'does not say which unit it was made in' });
    await expect(box).toBeVisible();
    await expect(box).toContainText('"link.stl" does not say which unit it was made in. As millimeters it is 0.2 × 0.1 × 0.05 mm. Which unit is it in?');
    // The import waits on the answer: the badge says so, with its way out.
    await expect(page.locator('.busy')).toContainText('Importing…');
    await expect(page.locator('.busy').getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(await sceneCount(page)).toBe(0);
    await box.getByRole('button', { name: 'Meters', exact: true }).click();
    await expect.poll(() => sceneCount(page)).toBe(1);
    expect(await store(page, (m) => m.getState().doc.scene[0].size)).toEqual([200, 100, 50]);
    await settled(page);
    await expect(page.locator('.busy')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('work that is called off leaves the design as it was, and the next import goes through', async ({ page, errors }) => {
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    const cube = await cubeFile(page, 'stl');
    // Called off in the same breath as it was asked for: the worker cannot have answered yet.
    const after = await store(
      page,
      async (m, bytes) => {
        const importing = m.receiveFiles([{ name: 'cube.stl', path: null, bytes: new Uint8Array(bytes) }]);
        const during = { busy: m.getState().busy, stoppable: m.getState().stoppable };
        m.stopWork();
        await importing;
        return { during, objects: m.getState().doc.scene.length, busy: m.getState().busy, stoppable: m.getState().stoppable, canUndo: m.getState().canUndo };
      },
      cube,
    );
    expect(after.during).toEqual({ busy: 'Importing…', stoppable: true });
    expect(after, 'nothing came in, nothing is left under way').toMatchObject({ objects: 1, busy: null, stoppable: false });
    expect(await notices(page), 'calling work off is no failure').toEqual([]);
    // The box that was there is still drawn, and what is asked next is done by a worker started afresh.
    await settled(page);
    expect(await drawnCount(page)).toBe(1);
    await dropFiles(page, [{ name: 'cube.stl', bytes: cube }]);
    await expect.poll(() => sceneCount(page)).toBe(2);
    await store(page, (m) => m.addShape('cylinder'));
    await settled(page);
    expect(await drawnCount(page)).toBe(3);
    expect(errors).toEqual([]);
  });
});
