// The WebGL context taken away and given back, as a tablet does to an app left in the
// background: the room the parts reflect was drawn on the GPU and goes with the old context, so
// the viewer builds it again. Brightness is read from a screenshot of the middle of the view.
import { brightness, contextLost, environment, expect, fitView, hitsObject, loseContext, openApp, pause, plate, press, redrawOnlyOnRestore, restoreContext, selection, settled, store, test } from './helpers';
import type { Plate } from './helpers';

test.describe('a lost WebGL context', () => {
  let p: Plate;
  /** How bright the part is before anything happens. */
  let lit: number;

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.select([]);
    });
    await settled(page);
    await fitView(page);
    p = await plate(page);
    expect(await hitsObject(page, p.cx, p.cy), 'the middle of the view is on the box').toBe(true);
    lit = await brightness(page, p.cx, p.cy);
  });

  test('answered with a redraw alone, a restored context leaves the part darker', async ({ page }) => {
    // Not how the app behaves: this shows that the test below would see the fault if it came back.
    await redrawOnlyOnRestore(page, true);
    await loseContext(page);
    await pause(page, 300);
    await restoreContext(page);
    await pause(page, 800);
    expect(await brightness(page, p.cx, p.cy)).toBeLessThan(lit - 8);
  });

  test('the environment is rebuilt when the context comes back, and the part is lit as before', async ({ page }) => {
    const before = await environment(page);
    await loseContext(page);
    await expect.poll(() => contextLost(page)).toBe(true);
    await pause(page, 300);
    await restoreContext(page);
    await expect.poll(async () => (await environment(page)).texture, 'a new environment is made').not.toBe(before.texture);
    expect((await environment(page)).inUse, 'and the scene uses it').toBe(true);
    // Rebuilding the environment and drawing with it again is the slowest thing the view does without a graphics card.
    await expect.poll(() => brightness(page, p.cx, p.cy), { message: 'the part is lit as before the loss', timeout: 45_000 }).toBeGreaterThan(lit - 3);
    expect(await brightness(page, p.cx, p.cy)).toBeLessThan(lit + 3);
  });

  test('the view still takes input after the context comes back', async ({ page }) => {
    await loseContext(page);
    await pause(page, 300);
    await restoreContext(page);
    await pause(page, 500);
    await press(page, p.cx, p.cy);
    await expect.poll(() => selection(page)).toHaveLength(1);
  });
});
