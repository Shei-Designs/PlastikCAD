// Number boxes with a keyboard: a value being typed goes to the object it was typed for, and a
// value outside the box's range shows the limit as soon as Enter is pressed.
import { cubeFile, dropFiles, expect, fitView, openApp, positions, sceneCount, sceneIds, screenPoint, selection, settled, store, test } from './helpers';

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

  test("an imported object shows where its file's origin is, and a value typed there moves the object", async ({ page }) => {
    // A cube from the file's origin to 10 mm each way: the origin is its low corner.
    await dropFiles(page, [{ name: 'cube.stl', bytes: await cubeFile(page, 'stl') }]);
    await expect.poll(() => sceneCount(page)).toBe(3);
    await settled(page);
    const origin = (axis: string) => page.locator(`.transform-box input[aria-label="${axis} of the file's origin"]`);
    await expect(origin('X')).toHaveValue('-5');
    await expect(origin('Y')).toHaveValue('-5');
    await expect(origin('Z')).toHaveValue('0');
    await origin('X').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('20');
    await page.keyboard.press('Enter');
    await expect(origin('X')).toHaveValue('20');
    expect((await positions(page))[2], 'the cube went with its origin').toEqual([25, 0, 5]);
    // A shape drawn in the app has no file, so no origin row.
    const [box] = await sceneIds(page);
    await store(page, (m, id) => m.select([id]), box);
    await expect(page.locator('.transform-box input[aria-label="X of the center"]')).toBeVisible();
    await expect(origin('X')).toHaveCount(0);
  });
});
