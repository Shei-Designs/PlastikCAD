// Robot mode with fingers. Robot mode is experimental and its panels are not being polished yet;
// what is known to be wrong is written down here so that it is not forgotten.
import { readFileSync } from 'node:fs';
import { drawnBelts, drawnKeys, expect, fitView, openApp, screenPoint, settled, started, steer, store, test, testDrive } from './helpers';

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

test.describe("a loop's motors", { tag: '@mouse' }, () => {
  test('are asked for before the test drive, on the plate or in the list, and the other joints become passive', async ({ page }) => {
    await openApp(page);
    // The reference linkage, read here and handed to the page: the built app does not serve the repository.
    const bytes = [...readFileSync(new URL('../fixtures/robots/linkage.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        // Not waited for: the import ends in a "Project added" box that holds it until OK is pressed.
        void m.receiveFiles([{ name: 'linkage.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(4);
    await settled(page);
    // As it is first built: every joint with a motor.
    await store(page, (m) => {
      m.enterRobotMode();
      for (const j of m.getState().doc.robot!.joints) m.updateJoint(j.id, { passive: undefined });
    });
    await fitView(page);
    const passive = () => store(page, (m) => m.getState().doc.robot!.joints.filter((j) => j.passive).map((j) => j.name));
    const panel = page.getByRole('dialog', { name: 'Which joint has the motor?' });
    const row = (name: string) => panel.getByRole('button', { name: new RegExp(`^${name}`) });
    const ok = panel.getByRole('button', { name: 'OK' });
    const drive = page.getByRole('button', { name: 'Test drive' });

    // Escape drops the question, and the drive with it.
    await drive.click();
    await expect(panel).toBeVisible();
    await expect(ok).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(drive).toBeVisible();
    expect(await passive()).toEqual([]);

    await drive.click();
    // Every joint picked leaves the loop none to move by: the box says so and does not go on.
    for (const name of ['Crank joint', 'Rocker joint', 'Coupler joint', 'Closing joint']) await row(name).click();
    await expect(panel.getByText('Leave a joint of each loop without a motor.')).toBeVisible();
    await expect(ok).toBeDisabled();
    for (const name of ['Crank joint', 'Rocker joint', 'Coupler joint', 'Closing joint']) await row(name).click();
    await expect(ok).toBeDisabled();
    // A click on the joint on the plate picks it: the crank's hinge is on top of the plate, 50 mm to the -Y side.
    const [x, y] = await screenPoint(page, [0, -50, 15]);
    await page.mouse.click(x, y);
    await expect(row('Crank joint')).toHaveAttribute('aria-pressed', 'true');
    await expect(row('Rocker joint')).toHaveAttribute('aria-pressed', 'false');
    await expect(ok).toBeEnabled();
    await ok.click();
    await expect(panel).toHaveCount(0);
    expect(await passive()).toEqual(['Rocker joint', 'Coupler joint', 'Closing joint']);
    // The drive goes ahead, with a slider for the crank alone.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.inspector label').getByText('Crank joint')).toBeVisible();
    await expect(page.locator('.inspector label').getByText('Rocker joint')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop' }).click();
    // Asked once: the answer is the robot's.
    await drive.click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop' }).click();
    // One step back takes the answer away, and the question comes again, before an export as well.
    await store(page, (m) => m.undo());
    expect(await passive()).toEqual([]);
    await page.getByRole('button', { name: 'Export package' }).or(page.getByRole('button', { name: 'Export model' })).or(page.getByRole('button', { name: 'Export stage' })).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // No motor: a loop nothing drives, every joint of it passive, and not asked about again.
    await drive.click();
    await row('Crank joint').click();
    await panel.getByRole('button', { name: 'No motor' }).click();
    await expect(panel).toHaveCount(0);
    expect(await passive()).toEqual(['Crank joint', 'Rocker joint', 'Coupler joint', 'Closing joint']);
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Stop' }).click();
    await drive.click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop' }).click();
  });

  test("a joint's motor is taken away and given back in its settings", async ({ page }) => {
    await openApp(page);
    const bytes = [...readFileSync(new URL('../fixtures/robots/linkage.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        void m.receiveFiles([{ name: 'linkage.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(4);
    await settled(page);
    const joint = (name: string) => store(page, (m, n) => m.getState().doc.robot!.joints.find((j) => j.name === n)!, name);
    await store(page, (m) => {
      m.enterRobotMode();
      m.selectJoint(m.getState().doc.robot!.joints.find((j) => j.name === 'Rocker joint')!.id);
    });
    const moved = page.getByRole('radiogroup', { name: 'Moved by' });
    await expect(moved.getByRole('radio', { name: 'Nothing' })).toHaveAttribute('aria-checked', 'true');
    // A passive joint is sent nothing: it has no command to choose.
    await expect(page.getByRole('radiogroup', { name: 'Command' })).toHaveCount(0);
    await moved.getByRole('radio', { name: 'Motor' }).click();
    await expect(moved.getByRole('radio', { name: 'Motor' })).toHaveAttribute('aria-checked', 'true');
    expect((await joint('Rocker joint')).passive).toBeUndefined();
    await expect(page.getByRole('radiogroup', { name: 'Command' })).toBeVisible();
    await moved.getByRole('radio', { name: 'Nothing' }).click();
    expect((await joint('Rocker joint')).passive).toBe(true);
    // The joint the loop closes on cannot have a motor while the other joint into its link has one.
    await store(page, (m) => {
      const joints = m.getState().doc.robot!.joints;
      m.updateJoint(joints.find((j) => j.name === 'Coupler joint')!.id, { passive: undefined });
      m.selectJoint(joints.find((j) => j.name === 'Closing joint')!.id);
    });
    await expect(moved.getByRole('radio', { name: 'Motor' })).toBeDisabled();
  });
});

test.describe('a mecanum drive on wheels that are not the part', { tag: '@mouse' }, () => {
  test('offers to replace each with a Mecanum wheel, as one step, and the wheel then collides as rollers or nothing', async ({ page }) => {
    await openApp(page);
    const bytes = [...readFileSync(new URL('../fixtures/robots/mecanum.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        void m.receiveFiles([{ name: 'mecanum.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(4);
    await settled(page);
    // The four wheels made plain wheels of the same size: what a drawn or an imported wheel is to the drive.
    await store(page, async (m) => {
      for (const n of m.getState().doc.scene) if (n.type === 'part') await m.editPart(n.id, { part: 'wheel', params: { diameter: 100, width: 50 } });
      m.enterRobotMode();
      m.select([]);
    });
    await settled(page);
    const wheels = () => store(page, (m) => m.getState().doc.scene.flatMap((n) => (n.type === 'part' ? [{ name: n.name, part: n.part, size: n.params.size, hand: n.params.hand, box: n.size.map((x) => Math.round(x * 10) / 10) }] : [])));
    const faults = page.locator('.inspector .problem.error', { hasText: 'not a Mecanum wheel part' });
    await expect(faults).toHaveCount(4);
    const before = await wheels();
    expect(before.every((w) => w.part === 'wheel')).toBe(true);
    const roles = await store(page, (m) => m.getState().doc.robot!.drive!.roles);
    const joints = await store(page, (m) => m.getState().doc.robot!.joints.map((j) => ({ id: j.id, child: j.child })));
    await faults.first().getByRole('button', { name: 'Replace' }).click();
    await expect(faults).toHaveCount(3);
    // One step back and the wheel is the plain one again.
    await store(page, (m) => m.undo());
    await expect(faults).toHaveCount(4);
    expect(await wheels()).toEqual(before);
    // A wheel too thin for rollers comes out wider, and says so.
    const thin = before[0].name;
    await store(page, async (m, name) => m.editPart(m.getState().doc.scene.find((n) => n.name === name)!.id, { part: 'wheel', params: { diameter: 100, width: 12 } }), thin);
    await settled(page);
    await faults.filter({ hasText: thin }).getByRole('button', { name: 'Replace' }).click();
    await expect(faults).toHaveCount(3);
    const now = await store(page, (m, name) => m.getState().doc.scene.find((n) => n.name === name)!.size[2], thin);
    expect(now).toBeGreaterThan(12);
    expect(await store(page, (m) => m.getState().notice?.text)).toBe(`${thin} is ${now} mm wide, up from 12 mm: its rollers need the room.`);
    await store(page, (m) => {
      m.undo();
      m.undo();
    });
    await expect(faults).toHaveCount(4);
    expect(await wheels()).toEqual(before);
    for (let left = 4; left > 0; left--) {
      await faults.first().getByRole('button', { name: 'Replace' }).click();
      await expect(faults).toHaveCount(left - 1);
    }
    await settled(page);
    await expect(page.locator('.inspector .problem.error')).toHaveCount(0);
    // Each is the 100 mm wheel where the plain one stood, of the hand its corner wants, on the joint and in the part of the drive it had.
    const after = await wheels();
    expect(after.map((w) => w.name)).toEqual(before.map((w) => w.name));
    for (const w of after) {
      expect(w).toMatchObject({ part: 'mecanum-wheel', size: '100', box: [100, 100, 50] });
      expect(w.hand).toBe(/front left|rear right/.test(w.name) ? 'left' : 'right');
    }
    expect(await store(page, (m) => m.getState().doc.robot!.drive!.roles)).toEqual(roles);
    expect(await store(page, (m) => m.getState().doc.robot!.joints.map((j) => ({ id: j.id, child: j.child })))).toEqual(joints);

    // A replaced wheel collides as its rollers or as nothing: no other shape, no size, no pieces.
    await store(page, (m) => m.select([m.getState().doc.scene.find((n) => n.type === 'part')!.id]));
    const shape = page.locator('.inspector select[aria-label="Collision shape"]');
    await expect(shape).toHaveValue('rollers');
    expect(await shape.locator('option').allTextContents()).toEqual(['Rollers', 'None']);
    await expect(page.locator('.inspector input[aria-label="Pieces"]')).toHaveCount(0);
    const picked = () => store(page, (m) => m.getState().doc.robot!.links.find((l) => l.node === m.getState().selection[0])?.collision);
    await shape.selectOption('none');
    expect(await picked()).toBe('none');
    await expect(shape).toHaveValue('none');
    await shape.selectOption('rollers');
    expect(await picked()).toBe('hull');
    // A link kept as a box from before it was a wheel reads as rollers too, and shows no box to size.
    await store(page, (m) => m.updateLink(m.getState().selection[0], { collision: 'box' }));
    await expect(shape).toHaveValue('rollers');
    await expect(page.locator('.inspector input[aria-label^="Collision size"]')).toHaveCount(0);
    // The body still has every shape to choose from.
    await store(page, (m) => m.select([m.getState().doc.robot!.root!]));
    await expect(shape.locator('option')).toHaveCount(6);
  });
});

test.describe('a rover on tracks', { tag: '@mouse' }, () => {
  test("mirroring a track makes the other side's, a new joint comes on its sprocket's axle, and it collides as Track or None", async ({ page }) => {
    await openApp(page);
    const bytes = [...readFileSync(new URL('../fixtures/robots/tracked.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        void m.receiveFiles([{ name: 'tracked.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(2);
    await settled(page);
    const right = await store(page, (m) => {
      const { doc } = m.getState();
      const node = doc.scene.find((n) => n.name === 'Track right')!;
      return { id: node.id, flip: node.flip ?? [false, false, false], pos: node.pos, joint: doc.robot!.joints.find((j) => j.child === node.id)! };
    });
    // The left track taken away, and made again as a user makes it: the right one copied, mirrored and moved across.
    const made = await store(page, (m) => {
      m.leaveRobotMode();
      m.select([m.getState().doc.scene.find((n) => n.name === 'Track left')!.id]);
      m.deleteSelected();
      m.select([m.getState().doc.scene.find((n) => n.name === 'Track right')!.id]);
      m.duplicateSelected();
      m.mirrorSelected(0);
      const id = m.getState().selection[0];
      const at = m.getState().doc.scene.find((n) => n.id === id)!.pos;
      m.updateNode(id, { name: 'Track left', pos: [-at[0], at[1], at[2]] });
      m.enterRobotMode();
      return id;
    });
    expect(made).not.toBe(right.id);
    await settled(page);
    const left = await store(
      page,
      (m, id) => {
        // The copy brought no joint to the body with it: one is added, and given its side.
        const robot = m.getState().doc.robot!;
        const joint = robot.joints.find((j) => j.child === id)?.id ?? m.addJoint(robot.root!, id)!;
        m.setDriveRole(joint, 'left');
        m.select([]);
        const node = m.getState().doc.scene.find((n) => n.id === id)!;
        return { part: node.type === 'part' ? node.part : '', flip: node.flip ?? [false, false, false], pos: node.pos, joint: m.getState().doc.robot!.joints.find((j) => j.id === joint)! };
      },
      made,
    );
    expect(left.part).toBe('track');
    [-right.pos[0], right.pos[1], right.pos[2]].forEach((v, i) => expect(left.pos[i]).toBeCloseTo(v, 6));
    // Mirrored: one of its own sides is flipped that the right track's is not.
    expect(left.flip.filter((f, i) => f !== right.flip[i]).length).toBe(1);
    // The joint is the track's motor: continuous, on the sprocket's axle, where the right track's is.
    expect(left.joint.type).toBe('continuous');
    left.joint.origin.forEach((v, i) => expect(Math.abs(v)).toBeCloseTo(Math.abs(right.joint.origin[i]), 3));
    expect(left.joint.axis.map((v) => Math.abs(v))).toEqual([0, 1, 0]);
    await settled(page);
    // Both tracks are tracks to the checks: nothing is faulted.
    await expect(page.locator('.inspector .problem')).toHaveCount(0);

    // A track collides as the wheels that stand in for its belt, or as nothing.
    await store(page, (m, id) => m.select([id]), made);
    const shape = page.locator('.inspector select[aria-label="Collision shape"]');
    await expect(shape).toHaveValue('rollers');
    expect(await shape.locator('option').allTextContents()).toEqual(['Track', 'None']);
    await expect(page.locator('.inspector input[aria-label="Pieces"]')).toHaveCount(0);
    const picked = () => store(page, (m) => m.getState().doc.robot!.links.find((l) => l.node === m.getState().selection[0])?.collision);
    await shape.selectOption('none');
    expect(await picked()).toBe('none');
    await shape.selectOption('rollers');
    expect(await picked()).toBe('hull');

    // The test drive takes the robot as it is: it loads, and the robot stands on its tracks.
    await store(page, (m) => m.select([]));
    await page.getByRole('button', { name: 'Test drive' }).click();
    const hold = page.getByRole('button', { name: 'Hold in the air' });
    await expect(hold).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
  });

  test('its belts are seen to run in the test drive: ahead, back, and opposite ways in a turn', async ({ page, errors }) => {
    await openApp(page);
    const bytes = [...readFileSync(new URL('../fixtures/robots/tracked.plastikcad', import.meta.url))];
    await store(
      page,
      (m, b) => {
        void m.receiveFiles([{ name: 'tracked.plastikcad', path: null, bytes: new Uint8Array(b) }]);
      },
      bytes,
    );
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => store(page, (m) => m.getState().doc.robot?.joints.length ?? 0)).toBe(2);
    await settled(page);
    await store(page, (m) => {
      m.enterRobotMode();
      m.select([]);
    });
    await settled(page);
    const whole = await drawnKeys(page);
    expect(Object.keys(whole).sort()).toEqual(['Body', 'Track left', 'Track right']);
    expect(await drawnBelts(page)).toEqual({});

    await page.getByRole('button', { name: 'Test drive' }).click();
    await expect.poll(async () => (await testDrive(page)).status, { timeout: 30_000 }).toBe('ready');
    // Each track is now drawn as its belt and rail, with its wheels and its lugs over them: two lugs a pitch, as the part has.
    await expect.poll(async () => Object.keys(await drawnBelts(page)).sort()).toEqual(['Track left', 'Track right']);
    const TRACKS = ['Track left', 'Track right'] as const;
    const at = async () => {
      const [drive, drawn] = [await testDrive(page), await drawnBelts(page)];
      return TRACKS.map((name) => ({ travel: drive.belts[name], ...drawn[name] }));
    };
    const rest = await at();
    for (const t of rest) {
      expect(t).toMatchObject({ still: true, shown: true, edges: true, lugs: 112 });
      expect(t.wheels.length).toBe(5);
      // Standing on its tracks, nothing has run to speak of.
      expect(Math.abs(t.travel)).toBeLessThan(5);
    }

    // Ahead: both belts run the same way along their paths, the left track being the right one mirrored.
    await steer(page, 1, 0);
    await expect.poll(async () => Math.min(...(await at()).map((t) => Math.abs(t.travel)))).toBeGreaterThan(150);
    const ahead = await at();
    const way = Math.sign(ahead[0].travel);
    expect(Math.sign(ahead[1].travel)).toBe(way);
    // Back: they run back past where they stood.
    await steer(page, -1, 0);
    await expect.poll(async () => Math.max(...(await at()).map((t) => t.travel * way))).toBeLessThan(-150);
    // Stopped, they hold still: two looks in a row say the same once the rover has come to rest.
    await steer(page, 0, 0);
    await expect
      .poll(async () => {
        const [a, b] = [await at(), await at()];
        return Math.max(...a.map((t, i) => Math.abs(t.travel - b[i].travel)));
      })
      .toBeLessThan(0.5);
    const stopped = await at();
    // A turn to the left on the spot: the right belt drives ahead and the left one back.
    await steer(page, 0, 1);
    await expect
      .poll(async () => {
        const now = await at();
        return Math.min((stopped[0].travel - now[0].travel) * way, (now[1].travel - stopped[1].travel) * way);
      })
      .toBeGreaterThan(100);
    await steer(page, 0, 0);

    // What is drawn is what the drive tells, at whatever moment it is looked at: each wheel turned by the belt's run over its rim, the lugs moved.
    // Time is held for the look, so that the drive and the picture are of one moment.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect
      .poll(async () => {
        const [a, b] = [await at(), await at()];
        return a.every((t, i) => t.travel === b[i].travel);
      })
      .toBe(true);
    const held = await at();
    held.forEach((t, i) => {
      // The sprocket and the idler are 30 mm to the belt's inside, the road wheels 20.
      t.wheels.forEach((w, k) => expect(w * [30, 20, 20, 20, 30][k]).toBeCloseTo(-t.travel, 6));
      expect(t.first.some((v, k) => Math.abs(v - rest[i].first[k]) > 0.01)).toBe(true);
      expect(t).toMatchObject({ still: true, shown: true, lugs: 112 });
    });
    // Back at the start pose, no belt has run and no wheel is turned.
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect.poll(async () => (await at()).map((t) => Math.abs(t.travel) + Math.max(...t.wheels.map(Math.abs)))).toEqual([0, 0]);

    // The drive ended, the tracks are the whole parts again and nothing is drawn over them.
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => (await testDrive(page)).status).toBe('off');
    await expect.poll(() => drawnBelts(page)).toEqual({});
    expect(await drawnKeys(page)).toEqual(whole);
    expect(errors).toEqual([]);
  });
});
