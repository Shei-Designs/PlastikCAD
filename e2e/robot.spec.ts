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

test.describe('a weighed link', { tag: '@mouse' }, () => {
  test('takes a typed center of mass and inertia, and gives them back to the shape', async ({ page }) => {
    await openApp(page);
    // A 20 mm box as the only link.
    await store(page, (m) => {
      m.addShape('box');
      m.enterRobotMode();
      m.select([m.getState().doc.scene[0].id]);
    });
    await settled(page);
    const mass = () => store(page, (m) => m.getState().doc.robot?.links[0]?.mass);
    const box = (label: string) => page.locator(`.inspector input[aria-label="${label}"]`);
    await page.getByRole('radio', { name: 'Weighed' }).click();
    await box('Mass').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('60');
    await page.keyboard.press('Enter');
    // Until one is typed the boxes show what the shape gives: its middle, and a 60 g cube's 60 × (20² + 20²) / 12 g·mm² = 40 g·cm².
    await expect(box('Center of mass Z')).toHaveValue('0');
    await expect(box('Inertia XX')).toHaveValue('40');
    await expect(box('Inertia XY')).toHaveValue('0');
    expect(await mass()).toEqual({ kind: 'measured', grams: 60 });
    await box('Center of mass Z').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-4');
    await page.keyboard.press('Enter');
    await box('Inertia ZZ').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('55');
    await page.keyboard.press('Enter');
    expect(await mass()).toEqual({ kind: 'measured', grams: 60, center: [0, 0, -4], inertia: [4000, 4000, 5500, 0, 0, 0] });
    // In kg·m² the same figures read a ten-millionth as large, and one typed is kept in the design's g·mm².
    await page.getByRole('radio', { name: 'kg·m²' }).click();
    await expect(box('Inertia ZZ')).toHaveValue('0.0000055');
    await expect(page.locator('.inspector dl')).toContainText('kg·m²');
    await box('Inertia XX').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('1.2e-5');
    await page.keyboard.press('Enter');
    await expect(box('Inertia XX')).toHaveValue('0.000012');
    expect(await mass()).toEqual({ kind: 'measured', grams: 60, center: [0, 0, -4], inertia: [12000, 4000, 5500, 0, 0, 0] });
    await page.getByRole('radio', { name: 'g·cm²' }).click();
    await expect(box('Inertia XX')).toHaveValue('120');
    await page.getByRole('button', { name: 'From the shape' }).click();
    expect(await mass()).toEqual({ kind: 'measured', grams: 60 });
    await expect(box('Inertia ZZ')).toHaveValue('40');
    await expect(page.getByRole('button', { name: 'From the shape' })).toHaveCount(0);
  });
});

test.describe('the collision shapes', { tag: '@mouse' }, () => {
  test('are shown and hidden by their button, and the app remembers which', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.enterRobotMode();
    });
    await settled(page);
    const shown = () => store(page, (m) => m.getState().prefs.robotCollisions);
    const button = page.getByRole('button', { name: 'Shows what each link collides as' });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await shown()).toBe(true);
    await page.reload();
    await store(page, (m) => m.enterRobotMode());
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    expect(await shown()).toBe(false);
  });
});

test.describe("a joint's start", { tag: '@mouse' }, () => {
  test('is typed, or taken from the slider', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.addShape('box');
      m.nudgeSelected([30, 0, 0]);
      m.enterRobotMode();
      const [a, b] = m.getState().doc.scene;
      m.setRobotRoot(a.id);
      m.addJoint(a.id, b.id);
    });
    await settled(page);
    const start = () => store(page, (m) => m.getState().doc.robot!.joints[0].start);
    const box = page.locator('.inspector input[aria-label="Start"]');
    const take = page.getByRole('button', { name: 'Set as start' });
    await expect(box).toHaveValue('0');
    // Nothing to take until the slider has moved the joint.
    await expect(take).toBeDisabled();
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('30');
    await page.keyboard.press('Enter');
    expect(await start()).toBe(30);
    await store(page, (m) => m.setPose(-45));
    await take.click();
    expect(await start()).toBe(-45);
    await expect(box).toHaveValue('-45');
    // Zero is the pose it was designed in: nothing is kept for it.
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('0');
    await page.keyboard.press('Enter');
    expect(await start()).toBeUndefined();
  });

  test('takes a torque command while the robot has controllers', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.addShape('box');
      m.nudgeSelected([30, 0, 0]);
      m.enterRobotMode();
      const [a, b] = m.getState().doc.scene;
      m.setRobotRoot(a.id);
      m.addJoint(a.id, b.id);
    });
    await settled(page);
    const command = () => store(page, (m) => m.getState().doc.robot!.joints[0].command);
    const group = page.getByRole('radiogroup', { name: 'Command' });
    await expect(group.getByRole('radio', { name: 'Position' })).toBeChecked();
    // With the controllers off nothing commands the joint, and there is nothing to choose.
    await store(page, (m) => m.setControl(false));
    await expect(group).toHaveCount(0);
    await store(page, (m) => m.setControl(true));
    await group.getByRole('radio', { name: 'Torque' }).click();
    expect(await command()).toBe('torque');
    await expect(group.getByRole('radio', { name: 'Torque' })).toBeChecked();
    await group.getByRole('radio', { name: 'Position' }).click();
    expect(await command()).toBeUndefined();
  });
});

test.describe('the test drive', { tag: '@mouse' }, () => {
  test('holds a walker in the air and lets it go', async ({ page }) => {
    await openApp(page);
    // The reference quadruped, read here and handed to the page: the built app does not serve the repository.
    const bytes = [...readFileSync(new URL('../fixtures/robots/quadruped.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        // Not waited for: the import ends in a "Project added" box that holds it until OK is pressed.
        void m.receiveFiles([{ name: 'quadruped.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(8);
    await settled(page);
    await store(page, (m) => m.enterRobotMode());
    await page.getByRole('button', { name: 'Test drive' }).click();
    // The engine is fetched and the model built before the controls show.
    const hold = page.getByRole('button', { name: 'Hold in the air' });
    await expect(hold).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await hold.click();
    await expect(hold).toHaveAttribute('aria-pressed', 'true');
    await hold.click();
    await expect(hold).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(hold).toHaveCount(0);
  });
});
