// Robot mode with fingers. Robot mode is experimental and its panels are not being polished yet;
// what is known to be wrong is written down here so that it is not forgotten.
import { readFileSync } from 'node:fs';
import { expect, openApp, settled, started, store, test } from './helpers';

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
    // Not before the app has started again: what it opens then would undo the mode.
    await started(page);
    await store(page, (m) => m.enterRobotMode());
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    expect(await shown()).toBe(false);
  });
});

test.describe('a plain collision shape', { tag: '@mouse' }, () => {
  test('takes a typed size and center, and is fitted to the object again', async ({ page }) => {
    await openApp(page);
    // A 20 mm box as the only link, colliding as a ball.
    await store(page, (m) => {
      m.addShape('box');
      m.enterRobotMode();
      const id = m.getState().doc.scene[0].id;
      m.select([id]);
      m.updateLink(id, { collision: 'sphere' });
    });
    await settled(page);
    const shape = () => store(page, (m) => m.getState().doc.robot?.links[0]?.shape);
    const box = (label: string) => page.locator(`.inspector input[aria-label="${label}"]`);
    // Until one is typed the boxes show the ball fitted to the box, and the link keeps nothing.
    await expect(box('Collision diameter')).toHaveValue('20');
    await expect(box('Collision center Z')).toHaveValue('0');
    expect(await shape()).toBeUndefined();
    await box('Collision diameter').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('30');
    await page.keyboard.press('Enter');
    await box('Collision center Z').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-5');
    await page.keyboard.press('Enter');
    expect(await shape()).toEqual({ size: [30, 30, 30], center: [0, 0, -5], rot: [0, 0, 0] });
    await page.getByRole('button', { name: 'Fit to the object' }).click();
    expect(await shape()).toBeUndefined();
    await expect(box('Collision diameter')).toHaveValue('20');
    await expect(page.getByRole('button', { name: 'Fit to the object' })).toHaveCount(0);
    // A cylinder stands along the object's Z until laid along another of its axes.
    await store(page, (m) => m.updateLink(m.getState().doc.scene[0].id, { collision: 'cylinder' }));
    const along = (axis: string) => page.getByRole('radiogroup', { name: 'Along' }).getByRole('radio', { name: axis });
    await expect(along('Z')).toHaveAttribute('aria-checked', 'true');
    await along('X').click();
    await expect(along('X')).toHaveAttribute('aria-checked', 'true');
    expect(await shape()).toEqual({ size: [20, 20, 20], center: [0, 0, 0], rot: [0, 90, 0] });
    // A box has a size each way.
    await store(page, (m) => m.updateLink(m.getState().doc.scene[0].id, { collision: 'box', shape: undefined }));
    await box('Collision size X').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    expect(await shape()).toEqual({ size: [12, 20, 20], center: [0, 0, 0], rot: [0, 0, 0] });
  });
});

test.describe('a hull collision shape', { tag: '@mouse' }, () => {
  test('takes how many convex pieces each part may be split into', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.enterRobotMode();
      m.select([m.getState().doc.scene[0].id]);
    });
    await settled(page);
    const pieces = () => store(page, (m) => m.getState().doc.robot?.links[0]?.pieces);
    const box = page.locator('.inspector input[aria-label="Pieces"]');
    await expect(box).toHaveValue('1');
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('6');
    await page.keyboard.press('Enter');
    expect(await pieces()).toBe(6);
    // One piece is the hull as it always was: nothing is kept for it.
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    expect(await pieces()).toBeUndefined();
    // Only a hull is split.
    await store(page, (m) => m.updateLink(m.getState().doc.scene[0].id, { collision: 'mesh' }));
    await expect(box).toHaveCount(0);
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
    // With no wheels to say which way it faces, it faces +Y until told another way.
    const forward = (way: string) => page.getByRole('radiogroup', { name: 'Forward' }).getByRole('radio', { name: way });
    await expect(forward('+Y')).toHaveAttribute('aria-checked', 'true');
    await forward('+X').click();
    await expect(forward('+X')).toHaveAttribute('aria-checked', 'true');
    expect(await store(page, (m) => m.getState().doc.robot?.faces)).toEqual([1, 0, 0]);
    await page.getByRole('button', { name: 'Test drive' }).click();
    // The engine is fetched and the model built before the controls show.
    const hold = page.getByRole('button', { name: 'Hold in the air' });
    await expect(hold).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await hold.click();
    await expect(hold).toHaveAttribute('aria-pressed', 'true');
    await hold.click();
    await expect(hold).toHaveAttribute('aria-pressed', 'false');
    // The dots where it touches the floor are on until turned off, and stay as set.
    const contacts = page.getByRole('button', { name: 'Contacts' });
    await expect(contacts).toHaveAttribute('aria-pressed', 'true');
    // It stands on its four lower legs, and the line says so.
    await expect(page.locator('.inspector').getByText(/^On the floor: (Lower leg [a-z ]+(, )?){4}$/)).toBeVisible();
    await contacts.click();
    await expect(contacts).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => store(page, (m) => m.getState().prefs.robotContacts)).toBe(false);
    await contacts.click();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(hold).toHaveCount(0);
  });
  test('says when a link stands on a collision shape larger than it', async ({ page }) => {
    await openApp(page);
    const bytes = [...readFileSync(new URL('../fixtures/robots/rover.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        // Not waited for: the import ends in a "Project added" box that holds it until OK is pressed.
        void m.receiveFiles([{ name: 'rover.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(4);
    await settled(page);
    // A ball around the body reaches under the wheels.
    await store(page, (m) => {
      m.enterRobotMode();
      m.updateLink(m.getState().doc.robot!.root!, { collision: 'sphere' });
    });
    await page.getByRole('button', { name: 'Test drive' }).click();
    await expect(page.locator('.inspector .problem.warn')).toContainText(/"Body" stands on its collision shape, \d+ mm clear of the floor\./, { timeout: 30_000 });
  });
});
