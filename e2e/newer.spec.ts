// A design that a newer version of the app saved: this one does not open it as it is, and offers
// a copy without what it does not know.
import { readFileSync } from 'node:fs';
import { expect, openApp, sceneCount, settled, store, storeAndProjects, test } from './helpers';

test('a design from a newer version is offered as a copy without what this one does not know', async ({ page }) => {
  await openApp(page);
  // The reference rover as a newer version might have saved it: one wheel is a shape this version has never heard of.
  const rover = readFileSync(new URL('../fixtures/robots/rover.plastikcad', import.meta.url), 'utf8');
  const shapes = (rover.match(/"type": "shape"/g) ?? []).length;
  const newer = rover.replace('"shape": "cylinder"', '"shape": "hypercylinder"');
  await store(
    page,
    (m, text) => {
      // Not waited for: it ends in a box that holds it until answered.
      void m.receiveFiles([{ name: 'rover.plastikcad', path: null, bytes: new TextEncoder().encode(text) }]);
    },
    newer,
  );
  // The box says what the design is, what a copy would lack, and that the design stays as it is.
  const box = page.getByRole('dialog').filter({ hasText: 'Made with a newer version' });
  await expect(box).toContainText('"Reference rover" was saved by a newer version of PlastikCAD. Update the app to open it as it is.');
  await expect(box).toContainText('This version can open a copy of it without 1 thing it does not know.');
  // Turned down: nothing is opened.
  await box.getByRole('button', { name: 'Cancel' }).click();
  expect(await sceneCount(page)).toBe(0);
  // Taken: the copy is a project of its own, with every object but the one, and its robot.
  await store(
    page,
    (m, text) => {
      void m.receiveFiles([{ name: 'rover.plastikcad', path: null, bytes: new TextEncoder().encode(text) }]);
    },
    newer,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Open a copy' }).click();
  await expect.poll(() => sceneCount(page)).toBe(shapes - 1);
  await settled(page);
  const copy = await storeAndProjects(page, async (m, p) => {
    await m.saveProject(true);
    const doc = m.getState().doc;
    return { name: doc.name, id: doc.id, joints: doc.robot?.joints.length ?? 0, text: await p.projectStore().read(m.getState().projectKey!) };
  });
  expect(copy.name).toBe('Reference rover copy');
  expect(copy.id).not.toBe('fxreferencerover');
  expect(copy.joints).toBeGreaterThan(0);
  expect(copy.text).not.toContain('hypercylinder');
});
