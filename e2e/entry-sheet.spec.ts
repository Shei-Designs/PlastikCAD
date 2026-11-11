// The on-screen entry sheet a number box opens on a tablet with no keyboard, from inside the
// Array panel: the sheet and its backdrop are outside the panel, and must not count as a tap
// beside it (which closes the panel and drops its preview). The panel itself stays while the view
// is turned for a look at the pattern, and goes with Cancel, Escape or a tap on another tool.
import type { Locator, Page } from '@playwright/test';
import { expect, fingers, openApp, pause, plate, sceneCount, sceneIds, screenPoint, selection, settled, store, tap, tapThrough, test, withoutKeyboard } from './helpers';

test.describe('the entry sheet over the Array panel', { tag: '@touch' }, () => {
  const arrayPanel = (page: Page): Locator => page.locator('.array-panel');
  const sheet = (page: Page): Locator => page.locator('.touch-entry');
  const count = (page: Page, axis: 'X' | 'Y'): Locator => page.locator(`.array-panel input[aria-label="Count along ${axis}"]`);

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await withoutKeyboard(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
  });

  async function openArray(page: Page): Promise<void> {
    await tap(page.locator('button[aria-label="Array"]'));
    await expect(arrayPanel(page)).toBeVisible();
  }

  /** Opens the Array panel and gives Count along X the value 4 through the sheet: four boxes in a row. */
  async function arrayOfFour(page: Page): Promise<void> {
    await openArray(page);
    await tap(count(page, 'X'));
    await expect(sheet(page)).toBeVisible();
    await page.locator('#touch-entry-box').fill('4');
    await tap(page.locator('.touch-entry-buttons .primary'));
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => sceneCount(page)).toBe(4);
  }

  test('the Array panel opens with a preview of its default pattern, two in a row', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
  });

  test('tapping a Count box opens the entry sheet and leaves the panel open under it', async ({ page }) => {
    await openArray(page);
    await tap(count(page, 'X'));
    await expect(sheet(page)).toBeVisible();
    await expect(arrayPanel(page)).toBeVisible();
  });

  test('Done in the sheet gives the box its value and keeps the panel and its pattern', async ({ page }) => {
    await openArray(page);
    await tap(count(page, 'X'));
    await page.locator('#touch-entry-box').fill('4');
    await tap(page.locator('.touch-entry-buttons .primary'));
    await expect(sheet(page), 'Done closes the sheet').toHaveCount(0);
    await expect(arrayPanel(page), 'the panel is still open').toBeVisible();
    await expect(count(page, 'X'), 'the box took the value').toHaveValue('4');
    await expect.poll(() => sceneCount(page), 'the pattern has four places and was not cancelled').toBe(4);
  });

  test('a tap on the backdrop closes the sheet and does not reach the library tile under it', async ({ page }) => {
    await arrayOfFour(page);
    await tap(count(page, 'Y'));
    await expect(sheet(page)).toBeVisible();
    await tapThrough(page, page.locator('.shape-grid .shape').first());
    await expect(sheet(page), 'the tap closes the sheet').toHaveCount(0);
    await pause(page, 300);
    expect(await store(page, (m) => Boolean(m.getState().placing)), 'no shape was picked up from the library').toBe(false);
    await expect(arrayPanel(page), 'the panel survived').toBeVisible();
    expect(await sceneCount(page), 'and so did its pattern').toBe(4);
  });

  test('a tap on the backdrop over Delete deletes nothing', async ({ page }) => {
    await arrayOfFour(page);
    await tap(count(page, 'Y'));
    await expect(sheet(page)).toBeVisible();
    await tapThrough(page, page.locator('button[aria-label="Delete"]'));
    await expect(sheet(page)).toHaveCount(0);
    await pause(page, 300);
    expect(await sceneCount(page)).toBe(4);
  });

  test('Cancel in the sheet keeps the panel', async ({ page }) => {
    await arrayOfFour(page);
    await tap(count(page, 'Y'));
    await expect(sheet(page)).toBeVisible();
    await tap(page.locator('.touch-entry-buttons .chip'));
    await expect(sheet(page)).toHaveCount(0);
    await expect(arrayPanel(page)).toBeVisible();
  });

  test('Apply keeps the pattern and closes the panel', async ({ page }) => {
    await arrayOfFour(page);
    await tap(page.locator('.array-foot .primary'));
    await expect(arrayPanel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(4);
  });

  test('a tap on the plate or on an object, as the view is turned for a look, keeps the panel and its pattern', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
    const picked = await selection(page);
    const p = await plate(page);
    const finger = await fingers(page);
    await finger.tap(p.x + 80, p.y + p.height - 220);
    // The box at the middle of the plate: tapped, it is neither picked alone nor moved.
    const [x, y] = await screenPoint(page, [0, 0, 10]);
    await finger.tap(x, y);
    await pause(page, 300);
    await expect(arrayPanel(page)).toBeVisible();
    expect(await sceneCount(page)).toBe(2);
    expect(await selection(page), 'the pattern is still what is selected').toEqual(picked);
  });

  test('a tap on another tool drops the pattern and closes the panel', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
    await tap(page.locator('.view-toolbar button', { hasText: 'Grid' }));
    await expect(arrayPanel(page)).toHaveCount(0);
    await expect.poll(() => sceneCount(page)).toBe(1);
  });

  test('Cancel and Escape each drop the pattern and close the panel', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
    await tap(page.locator('.array-foot .chip'));
    await expect(arrayPanel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(1);
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
    await page.keyboard.press('Escape');
    await expect(arrayPanel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(1);
    // Dropped, not undone: there is no step to go back over.
    expect(await store(page, (m) => m.getState().canUndo && m.getState().doc.scene.length === 1)).toBe(true);
  });

  test('a sheet opened from an inspector box stays open after the tap that opened it', async ({ page }) => {
    const [id] = await sceneIds(page);
    await store(page, (m, id) => m.select([id]), id);
    await tap(page.locator('.transform-box input[aria-label]').first());
    await expect(sheet(page)).toBeVisible();
    // The click the tap leaves behind comes a moment later; it must not count as a tap beside the sheet.
    await pause(page, 500);
    await expect(sheet(page)).toBeVisible();
  });
});
