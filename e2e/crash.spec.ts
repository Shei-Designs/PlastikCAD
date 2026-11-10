// A part of the window that fails to draw shows a message of its own, offers to save a copy and
// to reload, and leaves the rest of the window working.
import type { Page } from '@playwright/test';
import { expect, openApp, sceneCount, sceneIds, settled, store, test } from './helpers';

test.describe('a part of the window that stops working', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
  });

  /** Turns the box into a part of a kind the app does not know, which the inspector and the Objects tab cannot draw. */
  async function breakTheBox(page: Page): Promise<void> {
    const [id] = await sceneIds(page);
    await store(page, (m, id) => m.updateNode(id, { type: 'part', part: 'no-such-part', params: {} } as never), id);
  }

  const inspectorCrash = (page: Page) => page.locator('aside.inspector.crashed');

  test('a failure in the inspector shows its message and leaves the other areas standing', async ({ page }) => {
    await breakTheBox(page);
    await expect(inspectorCrash(page)).toContainText('stopped working');
    await expect(inspectorCrash(page).getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(inspectorCrash(page).getByRole('button', { name: /Save a copy/ })).toBeVisible();
    await expect(page.locator('aside.sidebar:not(.crashed)'), 'the sidebar stands').toBeVisible();
    await expect(page.locator('.viewport:not(.crashed) canvas'), 'the view stands').toBeVisible();
    await expect(page.locator('.crashed.whole'), 'the window as a whole has not failed').toHaveCount(0);
  });

  test('with the inspector failed, the library still adds a shape', async ({ page }) => {
    await breakTheBox(page);
    await expect(inspectorCrash(page)).toBeVisible();
    await page.locator('.shape-grid .shape').first().dblclick();
    await expect.poll(() => sceneCount(page)).toBe(2);
  });

  test('Save a copy in a failed panel hands over the design', async ({ page }) => {
    await breakTheBox(page);
    const download = page.waitForEvent('download');
    await inspectorCrash(page).getByRole('button', { name: /Save a copy/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.plastikcad$/);
  });

  test('Reload in a failed panel loads the app again', async ({ page }) => {
    await breakTheBox(page);
    const loaded = page.waitForEvent('load');
    await inspectorCrash(page).getByRole('button', { name: 'Reload' }).click();
    await loaded;
    await expect(page.locator('.canvas-host canvas')).toBeVisible();
  });

  test('a failure in the sidebar shows its message and leaves the view and the inspector standing', async ({ page }) => {
    // The Objects tab lists the bad part; with nothing selected the inspector does not meet it.
    await store(page, (m) => {
      m.select([]);
      m.setPrefs({ sidebar: 'objects' });
    });
    await breakTheBox(page);
    await expect(page.locator('aside.sidebar.crashed')).toContainText('This panel stopped working');
    await expect(page.locator('.viewport:not(.crashed) canvas')).toBeVisible();
    await expect(page.locator('aside.inspector:not(.crashed)')).toBeVisible();
    await expect(page.locator('.crashed.whole')).toHaveCount(0);
  });

  test('a failure in the 3D view shows its message and leaves the panels standing', async ({ page }) => {
    // A measurement of a feature that is not one.
    await store(page, (m) => {
      m.select([]);
      m.toggleMeasuring();
      m.pickMeasure({ kind: 'edge', node: 'nope' } as never);
    });
    await expect(page.locator('.viewport.crashed')).toContainText('The 3D view stopped working');
    await expect(page.locator('aside.sidebar:not(.crashed)')).toBeVisible();
    await expect(page.locator('aside.inspector:not(.crashed)')).toBeVisible();
    await expect(page.locator('.crashed.whole')).toHaveCount(0);
  });
});
