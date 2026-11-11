// The measure tool with a mouse: two picks make a measurement, the picks follow the scene (a
// measured object that changes drops them, any other change does not), and the feature dots keep
// up with their objects.
import type { Page } from '@playwright/test';
import { expect, fitView, measureOverlay, measurePicks, openApp, sceneIds, screenPoint, settled, store, test } from './helpers';

test.describe('measuring', { tag: '@mouse' }, () => {
  /** The box at the origin and the cylinder 60 mm along X. */
  let box: string;
  let cylinder: string;

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
    [box, cylinder] = await sceneIds(page);
    await store(page, (m) => m.toggleMeasuring());
  });

  /** Clicks the top face of the box and of the cylinder, wherever the cylinder now is along X. */
  async function pickBoth(page: Page, cylinderX = 60): Promise<void> {
    const a = await screenPoint(page, [0, 0, 20]);
    const b = await screenPoint(page, [cylinderX, 0, 20]);
    await page.mouse.click(a[0], a[1]);
    await expect.poll(() => measurePicks(page)).toBe(1);
    await page.mouse.click(b[0], b[1]);
    await expect.poll(() => measurePicks(page)).toBe(2);
  }

  test('a click on each of two objects makes a measurement, with its figure on show', async ({ page }) => {
    await pickBoth(page);
    await expect.poll(async () => (await measureOverlay(page)).label).toBe(true);
  });

  test('a change to an object that is not measured keeps the picks', async ({ page }) => {
    await pickBoth(page);
    await store(page, (m) => {
      m.addShape('sphere');
      m.nudgeSelected([0, 60, 0]);
    });
    await settled(page);
    expect(await measurePicks(page)).toBe(2);
  });

  test('nudging a measured object clears the picks and the line', async ({ page }) => {
    await pickBoth(page);
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.nudgeSelected([5, 0, 0]);
      },
      cylinder,
    );
    await expect.poll(() => measurePicks(page)).toBe(0);
    await expect.poll(() => measureOverlay(page)).toMatchObject({ label: false, lines: 0 });
  });

  test('undoing a nudge of a measured object clears the picks made since', async ({ page }) => {
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.nudgeSelected([5, 0, 0]);
        m.select([]);
      },
      cylinder,
    );
    await settled(page);
    await pickBoth(page, 65);
    await store(page, (m) => m.undo());
    await expect.poll(() => measurePicks(page)).toBe(0);
  });

  test('pointing at an object indexes its features', async ({ page }) => {
    const a = await screenPoint(page, [0, 0, 20]);
    const b = await screenPoint(page, [60, 0, 20]);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.move(b[0], b[1]);
    await expect.poll(async () => (await measureOverlay(page)).indexed).toEqual(expect.arrayContaining([box, cylinder]));
  });

  test('a centre dot moves with its object', async ({ page }) => {
    const b = await screenPoint(page, [60, 0, 20]);
    await page.mouse.move(b[0] - 4, b[1]);
    await page.mouse.move(b[0], b[1]);
    const dotX = async (): Promise<number | null> => (await measureOverlay(page)).dots.find((d) => d.node === cylinder)?.x ?? null;
    await expect.poll(dotX, 'the cylinder has a dot').not.toBeNull();
    const before = (await dotX())!;
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.nudgeSelected([10, 0, 0]);
      },
      cylinder,
    );
    await expect.poll(dotX).toBeCloseTo(before + 10, 6);
  });

  test('deleting an object drops its feature index', async ({ page }) => {
    const b = await screenPoint(page, [60, 0, 20]);
    await page.mouse.move(b[0] - 4, b[1]);
    await page.mouse.move(b[0], b[1]);
    await expect.poll(async () => (await measureOverlay(page)).indexed).toContain(cylinder);
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.deleteSelected();
      },
      cylinder,
    );
    await expect.poll(async () => (await measureOverlay(page)).indexed).not.toContain(cylinder);
  });

  test('the dots are remade for the other theme when the theme changes', async ({ page }) => {
    const b = await screenPoint(page, [60, 0, 20]);
    await page.mouse.move(b[0] - 4, b[1]);
    await page.mouse.move(b[0], b[1]);
    await expect.poll(async () => (await measureOverlay(page)).theme).not.toBeNull();
    const before = (await measureOverlay(page)).theme;
    await store(page, (m) => m.setPrefs({ theme: m.getState().prefs.theme === 'dark' ? 'light' : 'dark' }));
    await expect.poll(async () => (await measureOverlay(page)).theme).toBe(before === 'dark' ? 'light' : 'dark');
  });
});
