// The viewer does only what a change needs: pointing out a part restyles nothing, a look that
// changes restyles each object once, and a drag redraws the view but not the toolbar.
import { countRenders, countViewerCalls, edgesShown, expect, fitView, handles, openApp, pause, pointingBoxShown, renders, sceneIds, screenPoint, settled, store, test, viewerAtRest, viewerCalls } from './helpers';

test.describe('what a change costs the viewer', { tag: '@mouse' }, () => {
  let box: string;

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.addShape('cylinder');
      m.nudgeSelected([60, 0, 0]);
      m.select([]);
    });
    await settled(page);
    await fitView(page);
    [box] = await sceneIds(page);
    await countViewerCalls(page);
  });

  test('pointing out a part ten times restyles nothing and syncs nothing', async ({ page }) => {
    await store(
      page,
      (m, id) => {
        m.setPrefs({ sidebar: 'structure' });
        m.select([id]);
      },
      box,
    );
    await viewerAtRest(page);
    for (let i = 0; i < 10; i++) {
      await store(page, (m, [id, i]) => m.setHighlight(i % 2 ? null : [id]), [box, i] as [string, number]);
      await pause(page, 30);
    }
    expect(await viewerCalls(page)).toMatchObject({ style: 0, sync: 0, frame: 0 });
  });

  test('pointing out a part shows the box round it', async ({ page }) => {
    await store(page, (m, id) => m.setHighlight([id]), box);
    await expect.poll(() => pointingBoxShown(page)).toBe(true);
    await store(page, (m) => m.setHighlight(null));
    await expect.poll(() => pointingBoxShown(page)).toBe(false);
  });

  test('turning edges off restyles every object once, without a pass over the scene, and the edges go', async ({ page }) => {
    expect(await edgesShown(page), 'the edges start on show').toBe(true);
    await viewerAtRest(page);
    await store(page, (m) => m.setPrefs({ edges: false }));
    await pause(page, 200);
    expect(await viewerCalls(page)).toMatchObject({ style: 2, sync: 0 });
    expect(await edgesShown(page)).toBe(false);
  });

  test('Object axes rebuilds the handle frame once without restyling, on the object\'s own axes', async ({ page }) => {
    await store(page, (m, id) => m.select([id]), box);
    await viewerAtRest(page);
    await store(page, (m) => m.toggleObjectAxes());
    await pause(page, 200);
    expect(await viewerCalls(page)).toMatchObject({ frame: 1, style: 0 });
    expect((await handles(page)).local).toBe(true);
  });

  test('align mode shows its nine dots in place of the handles', async ({ page }) => {
    await store(page, (m) => {
      m.selectAll();
      m.toggleAligning();
    });
    await expect.poll(() => handles(page)).toMatchObject({ mode: 'align', count: 9 });
  });
});

test('a drag redraws the viewport for each move and not the toolbar', { tag: '@mouse' }, async ({ page }) => {
  await countRenders(page);
  await openApp(page);
  await store(page, (m) => {
    m.addShape('box');
    m.select([]);
  });
  await settled(page);
  await fitView(page);
  const [x, y] = await screenPoint(page, [0, 0, 20]);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y);
  await pause(page, 100);
  await renders(page);
  const moves = 20;
  for (let i = 2; i <= moves + 1; i++) {
    await page.mouse.move(x + i * 6, y);
    await pause(page, 20);
  }
  const drawn = await renders(page);
  await page.mouse.up();
  // The readout follows the pointer, so the Viewport component is drawn again for about every move.
  expect(drawn.Viewport ?? 0, 'the viewport followed the drag').toBeGreaterThanOrEqual(moves / 2);
  // The toolbar and its parts have nothing to show for a move. A generous bound: a redraw per move would be twenty.
  for (const name of ['Toolbar', 'Actions', 'History', 'ViewWidget']) expect(drawn[name] ?? 0, `${name} redrawn during the drag`).toBeLessThanOrEqual(3);
});
