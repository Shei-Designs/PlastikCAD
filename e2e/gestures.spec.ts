// Fingers on the plate: one finger edits (tap, drag, long press), two belong to the camera, and
// a press that has not become an edit yet is handed over when the second finger lands.
import { expect, fingers, fitView, hitsObject, measurePicks, openApp, pause, plate, positions, selection, settled, store, test, viewState } from './helpers';
import type { Page } from '@playwright/test';
import type { Fingers, Plate } from './helpers';

test.describe('fingers on the plate', { tag: '@touch' }, () => {
  let finger: Fingers;
  let p: Plate;
  /** A point of the plate with nothing on it. */
  let empty: [number, number];

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.select([]);
    });
    await settled(page);
    await fitView(page);
    finger = await fingers(page);
    p = await plate(page);
    empty = [p.x + 60, p.y + p.height - 200];
    // The view was fitted to the box, so the middle of the canvas is on it.
    expect(await hitsObject(page, p.cx, p.cy), 'the middle of the canvas is on the box').toBe(true);
    expect(await hitsObject(page, empty[0], empty[1]), 'the corner of the canvas is empty').toBe(false);
  });

  /** Two fingers that start together at the middle and move apart. */
  async function pinchOut(page: Page): Promise<void> {
    const { cx, cy } = p;
    await finger.start([[cx, cy, 0]]);
    await pause(page, 60);
    await finger.start([[cx, cy, 0], [cx + 30, cy + 10, 1]]);
    await pause(page, 60);
    for (let i = 1; i <= 12; i++) {
      await finger.move([[cx - i * 8, cy - i * 3, 0], [cx + 30 + i * 8, cy + 10 + i * 3, 1]]);
      await pause(page, 25);
    }
    await finger.end([[cx + 30 + 96, cy + 10 + 36, 1]]);
    await pause(page, 60);
    await finger.end();
    await pause(page, 300);
  }

  test('a first finger on an object waits as a move, and a second finger hands both to the camera', async ({ page }) => {
    const { cx, cy } = p;
    await finger.start([[cx, cy, 0]]);
    await pause(page, 60);
    expect((await viewState(page)).drag, 'the first finger is a move that has not started').toBe('pending-move');
    await finger.start([[cx, cy, 0], [cx + 30, cy + 10, 1]]);
    await pause(page, 60);
    expect(await viewState(page), 'the press is called off and the camera has both fingers').toMatchObject({ drag: null, cameraTouches: 2, controlPointers: 2 });
    await finger.end();
  });

  test('pinching out from an object zooms the camera in and leaves the object where it is', async ({ page }) => {
    const before = { view: await viewState(page), at: await positions(page) };
    await pinchOut(page);
    const after = await viewState(page);
    expect(after.distance, 'the camera came closer').toBeLessThan(before.view.distance * 0.8);
    expect(await positions(page), 'the object did not move').toEqual(before.at);
    expect(await selection(page), 'nothing was selected by it').toHaveLength(0);
    expect(after, 'nothing is left pressed').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
  });

  test('pinching in on an object zooms the camera out and leaves the object where it is', async ({ page }) => {
    const { cx, cy } = p;
    const before = { view: await viewState(page), at: await positions(page) };
    await finger.start([[cx - 80, cy - 30, 0]]);
    await pause(page, 60);
    await finger.start([[cx - 80, cy - 30, 0], [cx + 80, cy + 30, 1]]);
    await pause(page, 60);
    for (let i = 1; i <= 10; i++) {
      await finger.move([[cx - 80 + i * 6, cy - 30 + i * 2, 0], [cx + 80 - i * 6, cy + 30 - i * 2, 1]]);
      await pause(page, 25);
    }
    await finger.end();
    await pause(page, 300);
    expect((await viewState(page)).distance, 'the camera went back').toBeGreaterThan(before.view.distance * 1.2);
    expect(await positions(page), 'the object did not move').toEqual(before.at);
  });

  test('one finger dragged on empty space orbits the camera', async ({ page }) => {
    const before = await viewState(page);
    await finger.start([[empty[0], empty[1], 0]]);
    await pause(page, 60);
    for (let i = 1; i <= 6; i++) {
      await finger.move([[empty[0] + i * 6, empty[1], 0]]);
      await pause(page, 25);
    }
    const during = await viewState(page);
    expect(during.azimuth, 'the camera turned').not.toBe(before.azimuth);
    expect(during, 'the finger is the camera\'s, not an edit').toMatchObject({ drag: null, cameraTouches: 1 });
    await finger.end();
  });

  test('a second finger landing on an object while the first orbits belongs to the camera, and moves nothing', async ({ page }) => {
    const { cx, cy } = p;
    const at = await positions(page);
    await finger.start([[empty[0], empty[1], 0]]);
    await pause(page, 60);
    for (let i = 1; i <= 6; i++) {
      await finger.move([[empty[0] + i * 6, empty[1], 0]]);
      await pause(page, 25);
    }
    await finger.start([[empty[0] + 36, empty[1], 0], [cx, cy, 1]]);
    await pause(page, 60);
    expect(await viewState(page), 'the second finger is the camera\'s, not a move').toMatchObject({ drag: null, cameraTouches: 2, controlPointers: 2 });
    for (let i = 1; i <= 10; i++) {
      await finger.move([[empty[0] + 36, empty[1], 0], [cx + i * 10, cy - i * 6, 1]]);
      await pause(page, 25);
    }
    await finger.end();
    await pause(page, 300);
    expect(await positions(page), 'the object did not move').toEqual(at);
    expect(await selection(page), 'nothing was selected').toHaveLength(0);
    expect(await viewState(page), 'nothing is left pressed').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
  });

  test('a tap on an object selects it without moving it', async ({ page }) => {
    const at = await positions(page);
    await finger.start([[p.cx, p.cy, 0]]);
    await pause(page, 60);
    await finger.end();
    await expect.poll(() => selection(page)).toHaveLength(1);
    expect(await positions(page)).toEqual(at);
  });

  test('one finger dragged on an object moves it and not the camera', async ({ page }) => {
    const { cx, cy } = p;
    const before = { view: await viewState(page), at: await positions(page) };
    await finger.start([[cx, cy, 0]]);
    await pause(page, 60);
    for (let i = 1; i <= 10; i++) {
      await finger.move([[cx + i * 8, cy, 0]]);
      await pause(page, 25);
    }
    expect((await viewState(page)).drag, 'the drag is a move').toBe('move');
    await finger.end();
    await pause(page, 200);
    expect(await positions(page), 'the object moved').not.toEqual(before.at);
    expect((await viewState(page)).distance, 'the camera stayed').toBe(before.view.distance);
  });

  test('a second finger during a move neither zooms nor ends the move', async ({ page }) => {
    const { cx, cy } = p;
    const before = { view: await viewState(page), at: await positions(page) };
    await finger.start([[cx, cy, 0]]);
    await pause(page, 60);
    for (let i = 1; i <= 6; i++) {
      await finger.move([[cx - i * 8, cy, 0]]);
      await pause(page, 25);
    }
    // On a slow machine the slide may not have reached the app yet: the second finger waits for the move to begin.
    await expect.poll(async () => (await viewState(page)).drag, 'the slide became a move').toBe('move');
    await finger.start([[cx - 48, cy, 0], [cx + 120, cy + 100, 1]]);
    await pause(page, 60);
    expect(await viewState(page), 'the move goes on and the camera gets no finger').toMatchObject({ drag: 'move', cameraTouches: 0 });
    for (let i = 1; i <= 6; i++) {
      await finger.move([[cx - 48 - i * 8, cy, 0], [cx + 120 + i * 10, cy + 100, 1]]);
      await pause(page, 25);
    }
    expect((await viewState(page)).drag, 'still a move while both fingers slide').toBe('move');
    await finger.end();
    await pause(page, 300);
    const after = await viewState(page);
    expect(after.distance, 'the camera did not zoom').toBe(before.view.distance);
    expect(await positions(page), 'the object moved').not.toEqual(before.at);
    expect(after, 'all released at the end').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
  });

  test('a tap on empty space clears the selection', async ({ page }) => {
    await store(page, (m) => m.selectAll());
    expect(await selection(page)).toHaveLength(1);
    await finger.start([[empty[0], empty[1], 0]]);
    await pause(page, 60);
    await finger.end();
    await expect.poll(() => selection(page)).toHaveLength(0);
  });

  test('measuring, a pinch on an object zooms and picks nothing', async ({ page }) => {
    const { cx, cy } = p;
    await store(page, (m) => m.toggleMeasuring());
    const before = await viewState(page);
    await finger.start([[cx, cy, 0]]);
    await pause(page, 60);
    await finger.start([[cx, cy, 0], [cx + 40, cy, 1]]);
    await pause(page, 60);
    for (let i = 1; i <= 8; i++) {
      await finger.move([[cx - i * 8, cy, 0], [cx + 40 + i * 8, cy, 1]]);
      await pause(page, 25);
    }
    await finger.end();
    await pause(page, 300);
    expect(await measurePicks(page), 'nothing was picked').toBe(0);
    expect((await viewState(page)).distance, 'the camera came closer').toBeLessThan(before.distance * 0.9);
  });

  test('measuring, a tap on an object picks a feature', async ({ page }) => {
    await store(page, (m) => m.toggleMeasuring());
    await finger.start([[p.cx, p.cy, 0]]);
    await pause(page, 60);
    await finger.end();
    await expect.poll(() => measurePicks(page)).toBe(1);
  });
});
