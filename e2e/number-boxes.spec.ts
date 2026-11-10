// Number boxes with a keyboard: a value being typed goes to the object it was typed for, and a
// value outside the box's range shows the limit as soon as Enter is pressed.
import { expect, fitView, openApp, positions, sceneIds, screenPoint, selection, settled, store, test } from './helpers';

test.describe('number boxes', { tag: '@mouse' }, () => {
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
  });

  test('a value typed for one object goes to it when a click in the view selects another', async ({ page }) => {
    const [box, cylinder] = await sceneIds(page);
    const onBox = await screenPoint(page, [0, 0, 20]);
    const onCylinder = await screenPoint(page, [60, 0, 20]);
    await page.mouse.click(onBox[0], onBox[1]);
    await expect.poll(() => selection(page)).toEqual([box]);
    await page.locator('.transform-box input[aria-label="X of the center"]').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('37');
    // No Enter and no Tab: the click on the cylinder is what ends the typing.
    await page.mouse.click(onCylinder[0], onCylinder[1]);
    await expect.poll(() => selection(page)).toEqual([cylinder]);
    const [boxAt, cylinderAt] = await positions(page);
    expect(boxAt[0], 'the value went to the box').toBe(37);
    expect(cylinderAt[0], 'the cylinder kept its place').toBe(60);
  });

  test('Enter on a value over the limit shows the limit at once and keeps the focus for more typing', async ({ page }) => {
    const [box] = await sceneIds(page);
    await store(page, (m, id) => m.select([id]), box);
    await page.locator('button[aria-label="Array"]').click();
    const count = page.locator('.array-panel input[aria-label="Count along X"]');
    await count.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('500');
    await page.keyboard.press('Enter');
    // A count stops at 100.
    await expect(count).toHaveValue('100');
    await expect(count).toBeFocused();
    await page.keyboard.type('3');
    await page.keyboard.press('Enter');
    await expect(count, 'typing replaces the value, as before').toHaveValue('3');
  });
});
