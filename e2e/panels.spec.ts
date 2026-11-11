// The side panels: hidden to give the plate their room, brought back, remembered, and laid over
// the plate one at a time where the window is too narrow to hold them beside it.
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, store, test } from './helpers';

const stageWidth = async (page: Page): Promise<number> => (await page.locator('.stage').boundingBox())!.width;
const tab = (page: Page, side: 'left' | 'right'): Locator => page.locator(`.panel-tab.${side}`);

test.describe('the side panels', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('each tab hides its panel and gives the plate its room, and brings it back', async ({ page }) => {
    const whole = page.viewportSize()!.width;
    const start = await stageWidth(page);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(tab(page, 'left')).toHaveAttribute('aria-expanded', 'true');
    await tab(page, 'left').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(tab(page, 'left')).toHaveAccessibleName('Show left panel');
    expect(await stageWidth(page)).toBeGreaterThan(start + 150);
    await tab(page, 'right').click();
    await expect(page.locator('.inspector')).toBeHidden();
    expect(await stageWidth(page)).toBe(whole);
    await tab(page, 'left').click();
    await tab(page, 'right').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.inspector')).toBeVisible();
    expect(await stageWidth(page)).toBe(start);
  });

  test('what is hidden stays hidden the next time the app opens', async ({ page }) => {
    await tab(page, 'right').click();
    await expect(page.locator('.inspector')).toBeHidden();
    await page.reload();
    await openApp(page);
    await expect(page.locator('.inspector')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('a name being typed in a panel is still there when the panel comes back', async ({ page }) => {
    await store(page, (m) => m.renameProject('Bracket'));
    const name = page.locator('input.doc-name');
    await name.fill('Half typed');
    await tab(page, 'left').click();
    await tab(page, 'left').click();
    await expect(name).toHaveValue('Half typed');
  });
});

test.describe('the side panels on a tablet held upright', { tag: '@touch' }, () => {
  test.use({ viewport: { width: 800, height: 1280 } });

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('both start out of the way, and the plate has the whole width', async ({ page }) => {
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.inspector')).toBeHidden();
    expect(await stageWidth(page)).toBe(800);
  });

  test('a panel lies over the plate without squeezing it, with its tab on its outer edge, and showing one puts the other away', async ({ page }) => {
    await tab(page, 'left').tap();
    await expect(page.locator('.sidebar')).toBeVisible();
    expect(await stageWidth(page)).toBe(800);
    const panel = (await page.locator('.sidebar').boundingBox())!;
    const handle = (await tab(page, 'left').boundingBox())!;
    expect(handle.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    await tab(page, 'right').tap();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    // And away again, by the same tab.
    await tab(page, 'right').tap();
    await expect(page.locator('.inspector')).toBeHidden();
  });
});
