// Android's Back, as the app answers it (src/ui/back.ts): what Escape does, one thing at a press, and word of
// whether there was anything, since with nothing open the app goes behind the others. The key itself is the
// system's; what it is given to do is tried here.
import type { Locator, Page } from '@playwright/test';
import { back, expect, openApp, sceneIds, selection, settled, store, test } from './helpers';

test.describe('going back', () => {
  const about = (page: Page): Locator => page.locator('dialog.about[open]');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
  });

  test('with nothing open and nothing selected there is nothing to go back from', async ({ page }) => {
    await store(page, (m) => m.select([]));
    expect(await back(page)).toBe(false);
  });

  test('lets go of the selection, and after that has nothing left to do', async ({ page }) => {
    expect(await selection(page)).toEqual(await sceneIds(page));
    expect(await back(page)).toBe(true);
    expect(await selection(page)).toEqual([]);
    expect(await back(page)).toBe(false);
  });

  test('closes a box and leaves the selection as it was', async ({ page }) => {
    await page.locator('button[aria-label="File"]').click();
    await page.locator('.menu-item', { hasText: 'About' }).click();
    await expect(about(page)).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(about(page)).toHaveCount(0);
    expect(await selection(page)).toEqual(await sceneIds(page));
  });

  test('closes a list that dropped down and leaves the selection as it was', async ({ page }) => {
    await page.locator('.export-row .select-button').click();
    await expect(page.locator('.export-row .menu')).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(page.locator('.export-row .menu')).toHaveCount(0);
    expect(await selection(page)).toEqual(await sceneIds(page));
  });

  test('puts a tool away before the selection: the ruler, then what was selected', async ({ page }) => {
    await store(page, (m) => m.toggleMeasuring());
    expect(await store(page, (m) => m.getState().measuring !== null)).toBe(true);
    expect(await back(page)).toBe(true);
    expect(await store(page, (m) => m.getState().measuring !== null)).toBe(false);
  });
});
