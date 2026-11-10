// A shape from the library put on the plate with a finger: carried there in one drag, or picked
// up with a tap and put down with another, with two fingers still the camera's on the way.
import { centre, expect, fingers, openApp, pause, plate, sceneCount, store, test, viewState } from './helpers';

test.describe('placing a shape with a finger', { tag: '@touch' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('a library tile dragged to the plate is put down where the finger lifts, with no second tap', async ({ page }) => {
    const finger = await fingers(page);
    const from = await centre(page.locator('.shape-grid .shape').first());
    const p = await plate(page);
    const to = [p.cx, p.cy + 60];
    await finger.start([[from[0], from[1], 0]]);
    await pause(page, 80);
    expect(await store(page, (m) => Boolean(m.getState().placing)), 'pressing a tile starts carrying the shape').toBe(true);
    for (let i = 1; i <= 12; i++) {
      await finger.move([[from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12, 0]]);
      await pause(page, 25);
    }
    expect(await store(page, (m) => m.getState().placing?.pos ?? null), 'the shape followed the finger over the plate').not.toBeNull();
    await finger.end();
    await expect.poll(() => sceneCount(page), 'lifting the finger puts the shape down').toBe(1);
    expect(await store(page, (m) => Boolean(m.getState().placing)), 'nothing is carried any more').toBe(false);
  });

  test('a tap on a library tile picks the shape up, and a tap on the plate puts it down', async ({ page }) => {
    const from = await centre(page.locator('.shape-grid .shape').first());
    const p = await plate(page);
    const finger = await fingers(page);
    await finger.tap(from[0], from[1]);
    await expect.poll(() => store(page, (m) => Boolean(m.getState().placing)), 'the tap picks the shape up').toBe(true);
    expect(await sceneCount(page), 'and puts nothing down yet').toBe(0);
    await finger.tap(p.x + 120, p.y + p.height - 260);
    await expect.poll(() => sceneCount(page), 'the tap on the plate puts it down').toBe(1);
    expect(await store(page, (m) => Boolean(m.getState().placing))).toBe(false);
  });

  test('while a shape is carried, a pinch on the plate zooms and puts nothing down', async ({ page }) => {
    const finger = await fingers(page);
    const from = await centre(page.locator('.shape-grid .shape').first());
    const p = await plate(page);
    await finger.tap(from[0], from[1]);
    await expect.poll(() => store(page, (m) => Boolean(m.getState().placing))).toBe(true);
    const before = await viewState(page);
    const px = p.x + 120;
    const py = p.y + p.height - 260;
    await finger.start([[px, py, 0]]);
    await pause(page, 60);
    await finger.start([[px, py, 0], [px + 40, py, 1]]);
    await pause(page, 60);
    for (let i = 1; i <= 8; i++) {
      await finger.move([[px - i * 6, py, 0], [px + 40 + i * 8, py, 1]]);
      await pause(page, 25);
    }
    await finger.end([[px + 104, py, 1]]);
    await pause(page, 60);
    await finger.end();
    await pause(page, 300);
    expect(await sceneCount(page), 'nothing was put down').toBe(0);
    expect(await store(page, (m) => Boolean(m.getState().placing)), 'the shape is still carried').toBe(true);
    expect((await viewState(page)).distance, 'the camera came closer').toBeLessThan(before.distance * 0.9);
    // The pinch has not used the shape up: the next tap still places it.
    await finger.tap(px, py);
    await expect.poll(() => sceneCount(page), 'the next tap puts the shape down').toBe(1);
  });
});
