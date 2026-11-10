// The on-screen entry sheet a number box opens on a tablet with no keyboard, from inside a
// popover: the sheet and its backdrop are outside the popover, and must not count as a tap
// beside it (which closes a popover and drops its preview).
import type { Locator, Page } from '@playwright/test';
import { expect, fingers, openApp, pause, plate, sceneCount, sceneIds, settled, store, tap, tapThrough, test, withoutKeyboard } from './helpers';

test.describe('the entry sheet over a popover', { tag: '@touch' }, () => {
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

  /** Opens the Array popover and gives Count along X the value 4 through the sheet: four boxes in a row. */
  async function arrayOfFour(page: Page): Promise<void> {
    await openArray(page);
    await tap(count(page, 'X'));
    await expect(sheet(page)).toBeVisible();
    await page.locator('#touch-entry-box').fill('4');
    await tap(page.locator('.touch-entry-buttons .primary'));
    await expect(sheet(page)).toHaveCount(0);
    await expect.poll(() => sceneCount(page)).toBe(4);
  }

  test('the Array popover opens with a preview of its default pattern, two in a row', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
  });

  test('tapping a Count box opens the entry sheet and leaves the popover open under it', async ({ page }) => {
    await openArray(page);
    await tap(count(page, 'X'));
    await expect(sheet(page)).toBeVisible();
    await expect(arrayPanel(page)).toBeVisible();
  });

  test('Done in the sheet gives the box its value and keeps the popover and its pattern', async ({ page }) => {
    await openArray(page);
    await tap(count(page, 'X'));
    await page.locator('#touch-entry-box').fill('4');
    await tap(page.locator('.touch-entry-buttons .primary'));
    await expect(sheet(page), 'Done closes the sheet').toHaveCount(0);
    await expect(arrayPanel(page), 'the popover is still open').toBeVisible();
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
    await expect(arrayPanel(page), 'the popover survived').toBeVisible();
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

  test('Cancel in the sheet keeps the popover', async ({ page }) => {
    await arrayOfFour(page);
    await tap(count(page, 'Y'));
    await expect(sheet(page)).toBeVisible();
    await tap(page.locator('.touch-entry-buttons .chip'));
    await expect(sheet(page)).toHaveCount(0);
    await expect(arrayPanel(page)).toBeVisible();
  });

  test('Apply keeps the pattern and closes the popover', async ({ page }) => {
    await arrayOfFour(page);
    await tap(page.locator('.array-foot .primary'));
    await expect(arrayPanel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(4);
  });

  test('a tap on the plate closes the popover and drops its preview', async ({ page }) => {
    await openArray(page);
    await expect.poll(() => sceneCount(page)).toBe(2);
    const p = await plate(page);
    await (await fingers(page)).tap(p.x + 80, p.y + p.height - 220);
    await expect(arrayPanel(page)).toHaveCount(0);
    await expect.poll(() => sceneCount(page)).toBe(1);
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
