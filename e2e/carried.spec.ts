// A design that holds what a newer version of the app made: an older version shows the rest,
// says what it is not showing, and saves the design back with all of it still there.
import { readFileSync } from 'node:fs';
import { expect, openApp, sceneCount, settled, store, storeAndProjects, test } from './helpers';

test('a design from a newer version opens without what this one does not know, says so, and keeps it through a save', async ({ page }) => {
  await openApp(page);
  // The reference rover as a newer version might have saved it: one wheel is a shape this version has never heard of.
  const rover = readFileSync(new URL('../fixtures/robots/rover.plastikcad', import.meta.url), 'utf8');
  const shapes = (rover.match(/"type": "shape"/g) ?? []).length;
  const newer = rover.replace('"shape": "cylinder"', '"shape": "hypercylinder"');
  await store(
    page,
    (m, text) => {
      // Not waited for: the import ends in a "Project added" box that holds it until OK is pressed.
      void m.receiveFiles([{ name: 'rover.plastikcad', path: null, bytes: new TextEncoder().encode(text) }]);
    },
    newer,
  );
  await page.getByRole('button', { name: 'OK' }).click();
  await settled(page);
  // Every object but the one is there to work on.
  expect(await sceneCount(page)).toBe(shapes - 1);
  // The Objects tab says what has no row in it: the wheel, and the robot that is laid over it.
  await store(page, (m) => m.setPrefs({ sidebar: 'objects', leftPanel: true }));
  const note = page.locator('.objects .carried');
  await expect(note).toContainText('1 object needs a newer version of PlastikCAD');
  await expect(note).toContainText('The robot needs a newer version of PlastikCAD');
  // Robot mode has no robot to work on here, and stays off.
  await store(page, (m) => m.toggleRobotMode());
  expect(await store(page, (m) => m.getState().robot)).toBe(false);
  // The design is worked on and saved: the wheel and the robot are in the file as they came.
  const saved = await storeAndProjects(page, async (m, p) => {
    m.addShape('box');
    await m.saveProject(true);
    return p.projectStore().read(m.getState().projectKey!);
  });
  expect(saved).toContain('"shape": "hypercylinder"');
  expect(saved).toContain('"root": "fx000001"');
  // The rover's shapes, the wheel among them, and the box added here.
  expect((saved.match(/"type": "shape"/g) ?? []).length).toBe(shapes + 1);
});
