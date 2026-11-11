// The Array panel with a mouse: it stays while the view is clicked and turned for a look at the
// pattern, the keyboard edits nothing meanwhile, and Apply keeps the pattern as one step.
import type { Locator, Page } from '@playwright/test';
import { expect, fitView, openApp, plate, sceneCount, screenPoint, selection, settled, store, test } from './helpers';

test.describe('the Array panel', { tag: '@mouse' }, () => {
  const panel = (page: Page): Locator => page.locator('.array-panel');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    await fitView(page);
    await page.locator('button[aria-label="Array"]').click();
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => sceneCount(page)).toBe(2);
  });

  test('clicks and drags in the view, and keys that edit, leave the panel and its pattern alone', async ({ page, errors }) => {
    const picked = await selection(page);
    const p = await plate(page);
    // On the empty plate, where a click would clear the selection and a drag draw a marquee.
    await page.mouse.click(p.x + 60, p.y + p.height - 200);
    await page.mouse.move(p.x + 60, p.y + p.height - 200);
    await page.mouse.down();
    await page.mouse.move(p.x + 200, p.y + p.height - 120, { steps: 4 });
    await page.mouse.up();
    // On the box itself, where a drag would move it.
    const [x, y] = await screenPoint(page, [0, 0, 10]);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 4 });
    await page.mouse.up();
    // Turning the view with the right button is what the panel stays open for.
    await page.mouse.move(p.x + 300, p.y + 300);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(p.x + 380, p.y + 320, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+d');
    await expect(panel(page)).toBeVisible();
    expect(await sceneCount(page)).toBe(2);
    expect(await selection(page)).toEqual(picked);
    expect(await store(page, (m) => m.getState().doc.scene[0].pos), 'the box is where it was').toEqual([0, 0, 10]);
    expect(errors).toEqual([]);
  });

  test('Apply keeps the pattern as one step, which Undo takes back whole', async ({ page }) => {
    await panel(page).locator('input[aria-label="Count along X"]').fill('3');
    await page.keyboard.press('Enter');
    await expect.poll(() => sceneCount(page)).toBe(3);
    await panel(page).getByRole('button', { name: 'Apply' }).click();
    await expect(panel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(3);
    await store(page, (m) => m.undo());
    expect(await sceneCount(page)).toBe(1);
  });

  test('the Array button again, or a press on another tool, drops the pattern', async ({ page }) => {
    await page.locator('button[aria-label="Array"]').click();
    await expect(panel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(1);
    await page.locator('button[aria-label="Array"]').click();
    await expect.poll(() => sceneCount(page)).toBe(2);
    await page.locator('.view-toolbar button', { hasText: 'Edges' }).click();
    await expect(panel(page)).toHaveCount(0);
    expect(await sceneCount(page)).toBe(1);
  });
});
