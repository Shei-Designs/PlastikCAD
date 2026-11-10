// The 3D view as a part of the page: its name for a screen reader, where the readout of a drag
// sits, and a press that ends when the browser takes the pointer away.
import { expect, fingers, fitView, openApp, pause, sceneIds, screenPoint, selection, settled, store, test, viewState } from './helpers';

test.describe('the 3D view', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.select([]);
    });
    await settled(page);
    await fitView(page);
  });

  test('the canvas has a role and a name', async ({ page }) => {
    const canvas = page.locator('.canvas-host canvas');
    await expect(canvas).toHaveAttribute('role', 'img');
    await expect(canvas).toHaveAttribute('aria-label', /\S/);
  });

  test('the readout of a drag stays inside the view at its bottom-right corner', { tag: '@mouse' }, async ({ page }) => {
    const [x, y] = await screenPoint(page, [0, 0, 20]);
    const host = (await page.locator('.canvas-host').boundingBox())!;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y);
    await page.mouse.move(x + 60, y, { steps: 5 });
    await page.mouse.move(host.x + host.width - 4, host.y + host.height - 4, { steps: 5 });
    const readout = page.locator('.viewport > .readout');
    await expect(readout).toBeVisible();
    const box = (await readout.boundingBox())!;
    await page.mouse.up();
    expect(box.x).toBeGreaterThanOrEqual(host.x);
    expect(box.y).toBeGreaterThanOrEqual(host.y);
    expect(box.x + box.width).toBeLessThanOrEqual(host.x + host.width);
    expect(box.y + box.height).toBeLessThanOrEqual(host.y + host.height);
  });

  test('the readout of a drag sits above the finger, centred on it', { tag: '@touch' }, async ({ page }) => {
    const finger = await fingers(page);
    const [x, y] = await screenPoint(page, [0, 0, 20]);
    await finger.start([[x, y, 0]]);
    await pause(page, 60);
    for (let i = 1; i <= 8; i++) {
      await finger.move([[x + i * 6, y, 0]]);
      await pause(page, 25);
    }
    const readout = page.locator('.viewport > .readout');
    await expect(readout).toBeVisible();
    const box = (await readout.boundingBox())!;
    await finger.end();
    // Clear of the fingertip, which would cover a readout beside it.
    expect(box.y + box.height, 'the readout is above the finger').toBeLessThanOrEqual(y - 30);
    expect(Math.abs(box.x + box.width / 2 - (x + 48)), 'and centred on it').toBeLessThan(3);
  });

  test('a press ends when the canvas loses the pointer capture, and the next click works', { tag: '@mouse' }, async ({ page }) => {
    const [x, y] = await screenPoint(page, [0, 0, 20]);
    await page.mouse.move(x, y);
    await page.mouse.down();
    // The capture asked for at the press is the canvas's from the pointer's next event on, and only a capture it
    // has can be lost: a move too small to start a drag.
    await page.mouse.move(x + 1, y);
    expect((await viewState(page)).drag).toBe('pending-move');
    const had = await page.evaluate(() => {
      const canvas = document.querySelector('.canvas-host canvas')!;
      // The mouse is pointer 1.
      const had = canvas.hasPointerCapture(1);
      canvas.releasePointerCapture(1);
      return had;
    });
    expect(had, 'the canvas had the mouse captured').toBe(true);
    // The browser tells of the loss when the pointer next does something.
    await page.mouse.move(x + 2, y);
    await expect.poll(async () => (await viewState(page)).drag).toBeNull();
    await page.mouse.up();
    await store(page, (m) => m.select([]));
    await page.mouse.click(x, y);
    await expect.poll(() => selection(page)).toEqual(await sceneIds(page));
  });
});
