// What keeps work from being lost by a slip, and what tells the user about it: the trash, the
// earlier saves of a project, word from sync that stays until read, and the report in the About box.
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, settled, store, storeAndProjects, test } from './helpers';

const dialog = (page: Page): Locator => page.locator('dialog.projects[open]');
const card = (page: Page, name: string): Locator => page.locator('.projects-grid .project').filter({ hasText: name });

test.describe('the trash and the versions of a project', { tag: '@mouse' }, () => {
  // The browser's own storage has neither; the store kept in memory has both, as the projects folder on disk does.
  // Bracket is saved twice, so that an earlier save of it is kept; Lid is the project open.
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    page.on('dialog', (question) => void question.accept());
    await storeAndProjects(page, async (m, p) => {
      p.setProjectStore(new p.MemoryProjects());
      await m.startProject('Bracket');
      m.addShape('box');
      await m.saveProject(true);
      m.addShape('sphere');
      await m.saveProject(true);
      await m.startProject('Lid');
      m.addShape('cylinder');
      await m.saveProject(true);
      void m.openProjects();
    });
    await settled(page);
    await expect(card(page, 'Bracket')).toHaveCount(1);
  });

  test('a deleted project waits in the trash and can be put back', async ({ page }) => {
    await card(page, 'Bracket').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menu').getByText('Delete…').click();
    await expect(card(page, 'Bracket')).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Trash (1)' })).toBeVisible();
    await dialog(page).getByRole('button', { name: /^Trash/ }).click();
    await expect(dialog(page).locator('h2')).toHaveText('Trash');
    await expect(card(page, 'Bracket')).toHaveCount(1);
    await card(page, 'Bracket').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menu').getByText('Put back').click();
    await expect(dialog(page)).toContainText('The trash is empty');
    await dialog(page).getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(card(page, 'Bracket')).toHaveCount(1);
    await expect(card(page, 'Lid')).toHaveCount(1);
  });

  test('emptying the trash destroys what is in it and nothing else', async ({ page }) => {
    await card(page, 'Bracket').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menu').getByText('Delete…').click();
    await dialog(page).getByRole('button', { name: /^Trash/ }).click();
    await dialog(page).getByRole('button', { name: 'Empty Trash…' }).click();
    await expect(dialog(page)).toContainText('The trash is empty');
    await dialog(page).getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(card(page, 'Lid')).toHaveCount(1);
    await expect(card(page, 'Bracket')).toHaveCount(0);
  });

  test('the versions of a project are listed, and Escape goes back to the projects before it closes the browser', async ({ page }) => {
    await card(page, 'Bracket').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menu').getByText('Versions…').click();
    await expect(dialog(page).locator('h2')).toHaveText('Versions of Bracket');
    await expect(dialog(page).locator('.version')).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page).locator('h2')).toHaveText('Projects');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('an earlier save opens as a project of its own and leaves the project as it is', async ({ page }) => {
    await card(page, 'Bracket').getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menu').getByText('Versions…').click();
    await dialog(page).getByRole('button', { name: 'Open as a copy' }).first().click();
    await expect(dialog(page)).toHaveCount(0);
    const now = await store(page, (m) => ({ name: m.getState().doc.name, objects: m.getState().doc.scene.length }));
    expect(now.name).toMatch(/^Bracket \(.+\)$/);
    expect(now.objects).toBeLessThan(2);
    const names = await store(page, async (m) => (await m.listProjects()).map((p) => p.name));
    expect(names.filter((n) => n === 'Bracket')).toHaveLength(1);
    expect(names).toHaveLength(3);
  });
});

test.describe('word from sync, and the report', { tag: '@mouse' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('what sync did stays on the projects button and in the browser until it is dismissed', async ({ page }) => {
    const dot = page.locator('.file-bar .news-dot');
    await expect(dot).toHaveCount(0);
    await store(page, (m) =>
      m.applySyncReport({ uploaded: [], downloaded: [], merged: [], kept: ['Plate'], deletedLocally: ['Lid'], deletedRemotely: [], changedKeys: [], removedKeys: [], movedKeys: [], busy: [], held: [], errors: [] }),
    );
    await expect(dot).toHaveCount(1);
    await page.locator('.file-bar button[aria-label^="Projects"]').click();
    const notes = dialog(page).locator('.sync-notes');
    await expect(notes.locator('li')).toHaveText(['"Plate" was changed on two devices at once; both versions were kept.', 'Deleted on another device: "Lid".']);
    await notes.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notes).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dot).toHaveCount(0);
  });

  test('the About box copies a report of the app, the device and what went wrong this session', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await store(page, (m) => m.notify('Could not save: disk full', 'error'));
    await page.locator('.file-bar').getByRole('button', { name: 'File' }).click();
    await page.getByRole('menu').getByText(/^About/).click();
    await page.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const report = await page.evaluate(() => navigator.clipboard.readText());
    expect(report).toMatch(/^PlastikCAD \d+\.\d+\.\d+\n/);
    expect(report).toContain('Platform: browser');
    expect(report).toContain('[error] Could not save: disk full');
  });
});
