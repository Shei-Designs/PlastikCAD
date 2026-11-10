// Robot mode with fingers. Robot mode is experimental and its panels are not being polished yet;
// what is known to be wrong is written down here so that it is not forgotten.
import { readFileSync } from 'node:fs';
import { expect, openApp, settled, store, test } from './helpers';

test.describe('robot mode on a tablet', { tag: '@touch' }, () => {
  // Known to fail: with a joint picked, the "Fixed" button of the base's Free / Fixed row ends
  // 7 px past the right edge of the inspector at 1280 x 800 with a coarse pointer, where the
  // buttons are made larger. Left as it is until robot mode's panels are worked on.
  test.fixme('no control of the robot inspector or the sidebar sticks out of its panel', async ({ page }) => {
    await openApp(page);
    // The reference rover, read here and handed to the page: the built app does not serve the repository.
    const rover = [...readFileSync(new URL('../fixtures/robots/rover.plastikcad', import.meta.url))];
    await store(
      page,
      (m, bytes) => {
        // Not waited for: the import ends in a "Project added" box that holds it until OK is pressed.
        void m.receiveFiles([{ name: 'rover.plastikcad', path: null, bytes: new Uint8Array(bytes) }]);
      },
      rover,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBeGreaterThan(0);
    await settled(page);
    await store(page, (m) => {
      m.enterRobotMode();
      m.selectJoint(m.getState().doc.robot!.joints[0].id);
    });
    await expect(page.locator('.inspector')).toBeVisible();
    await page.waitForTimeout(500);
    const sticking = await page.evaluate(() => {
      const out: string[] = [];
      for (const panel of ['.inspector', '.sidebar']) {
        const root = document.querySelector(panel)!;
        const edge = root.getBoundingClientRect();
        for (const el of root.querySelectorAll('button, input, select, .number-box, .chip')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.left < edge.left - 1 || r.right > edge.right + 1)) out.push(`${panel}: ${el.className || el.tagName} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.left - edge.left)}..${Math.round(r.right - edge.right)}`);
        }
      }
      return out;
    });
    expect(sticking).toEqual([]);
  });
});
