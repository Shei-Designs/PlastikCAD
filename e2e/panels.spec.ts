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

  test('a window that becomes narrow with both panels on show puts both away, and a tab brings one back', async ({ page }) => {
    // Held sideways first, with both panels beside the plate.
    await page.setViewportSize({ width: 1280, height: 800 });
    await store(page, (m) => m.setPrefs({ leftPanel: true, rightPanel: true }));
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.inspector')).toBeVisible();
    // Then turned upright.
    await page.setViewportSize({ width: 800, height: 1280 });
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.inspector')).toBeHidden();
    expect(await stageWidth(page)).toBe(800);
    await tab(page, 'right').tap();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    // Opened again upright, the app is as it was left: one panel, not two.
    await page.reload();
    await openApp(page);
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
  });

  test('on a narrow window the inspector makes way for the panels that open where it lies: the mating gear, the array', async ({ page }) => {
    await store(page, async (m) => {
      m.setPrefs({ leftPanel: false, rightPanel: true });
      await m.addPart('gears');
    });
    await expect(page.locator('.inspector')).toBeVisible();
    /** Whether the middle of a panel is the panel itself and nothing lying over it. */
    const inTheClear = (selector: string): Promise<boolean> =>
      page.evaluate((selector) => {
        const panel = document.querySelector(selector)!;
        const r = panel.getBoundingClientRect();
        return panel.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      }, selector);
    await page.getByRole('button', { name: 'Add mating gear…' }).tap();
    await expect(page.locator('.mate-panel')).toBeVisible();
    await expect(page.locator('.inspector')).toBeHidden();
    expect(await inTheClear('.mate-panel')).toBe(true);
    await store(page, (m) => m.cancelMate());
    await expect(page.locator('.mate-panel')).toHaveCount(0);
    // The inspector brought back by its tab, and the array asked for with it on show.
    await tab(page, 'right').tap();
    await expect(page.locator('.inspector')).toBeVisible();
    await store(page, (m) => m.startArray());
    await expect(page.locator('.array-panel')).toBeVisible();
    await expect(page.locator('.inspector')).toBeHidden();
    expect(await inTheClear('.array-panel')).toBe(true);
  });
});
