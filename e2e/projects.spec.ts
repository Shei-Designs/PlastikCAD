// The projects browser: a card's menu, renaming a card in place, and Escape. Only what each test
// needs is looked at: the browser has more on it (versions, the trash, sync) than is checked here.
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, settled, store, test } from './helpers';

test.describe('the projects browser', { tag: '@mouse' }, () => {
  const dialog = (page: Page): Locator => page.locator('dialog.projects[open]');
  /** The card of the project the test made. */
  const card = (page: Page, name = 'Bracket'): Locator => page.locator('.projects-grid .project').filter({ has: page.locator('.project-name', { hasText: name }) });
  const renameBox = (page: Page): Locator => page.locator('.projects-grid .project input.text-input');

  // Two saved projects: Bracket, and Lid, which is the one open.
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, async (m) => {
      for (const name of ['Bracket', 'Lid']) {
        await m.startProject(name);
        m.addShape('box');
        await m.saveProject(true);
      }
      void m.openProjects();
    });
    await settled(page);
    await expect(dialog(page)).toBeVisible();
    await expect(card(page)).toHaveCount(1);
    await expect(card(page, 'Lid')).toHaveCount(1);
  });

  async function startRename(page: Page, name = 'Bracket'): Promise<void> {
    await card(page, name).getByRole('button', { name: 'Actions' }).click();
    await page.locator('.projects .menu-item', { hasText: 'Rename' }).click();
    await expect(renameBox(page)).toBeVisible();
  }

  /** The names of the saved projects, as the store has them. */
  const savedNames = (page: Page): Promise<string[]> => store(page, async (m) => (await m.listProjects()).map((p) => p.name).sort());

  test('a card\'s menu offers Open, Rename, Duplicate and, set apart, Delete', async ({ page }) => {
    await card(page).getByRole('button', { name: 'Actions' }).click();
    const menu = page.locator('.projects .menu');
    for (const label of ['Open', 'Rename', 'Duplicate']) await expect(menu.locator('.menu-item', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
    await expect(menu.locator('.menu-item.danger', { hasText: 'Delete…' })).toBeVisible();
    // Delete is last, below a rule.
    expect(await menu.evaluate((m) => [...m.children].slice(-2).map((c) => c.tagName))).toEqual(['HR', 'BUTTON']);
  });

  test('Rename puts a box on the card, focused, with the whole name selected', async ({ page }) => {
    await startRename(page);
    await expect(renameBox(page)).toHaveAttribute('aria-label', 'Project name');
    await expect(renameBox(page)).toHaveValue('Bracket');
    await expect(renameBox(page)).toBeFocused();
    expect(await renameBox(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'Bracket'.length]);
  });

  test('Enter in the rename box renames the project, on its card and in the store', async ({ page }) => {
    await startRename(page);
    await page.keyboard.type('Renamed');
    await page.keyboard.press('Enter');
    await expect(card(page, 'Renamed')).toHaveCount(1);
    await expect(renameBox(page)).toHaveCount(0);
    expect(await savedNames(page)).toEqual(['Lid', 'Renamed']);
  });

  test('renaming the open project from its card renames the design', async ({ page }) => {
    await startRename(page, 'Lid');
    await page.keyboard.type('Cover');
    await page.keyboard.press('Enter');
    await expect.poll(() => store(page, (m) => m.getState().doc.name)).toBe('Cover');
    // Written with the next save, a second after the change.
    await expect.poll(() => savedNames(page)).toEqual(['Bracket', 'Cover']);
  });

  test('the card of the open project shows its new name once it is renamed', async ({ page }) => {
    await startRename(page, 'Lid');
    await page.keyboard.type('Cover');
    await page.keyboard.press('Enter');
    await expect(card(page, 'Cover')).toHaveCount(1);
  });

  test('Escape in the rename box keeps the old name', async ({ page }) => {
    await startRename(page);
    await page.keyboard.type('Never');
    await page.keyboard.press('Escape');
    await expect(renameBox(page)).toHaveCount(0);
    expect(await savedNames(page)).toEqual(['Bracket', 'Lid']);
  });

  test('Escape in the rename box leaves the browser open', async ({ page }) => {
    await startRename(page);
    await page.keyboard.press('Escape');
    await expect(renameBox(page)).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
  });

  test('an empty name in the rename box keeps the old one', async ({ page }) => {
    await startRename(page);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    await expect(renameBox(page)).toHaveCount(0);
    await expect(card(page)).toHaveCount(1);
    expect(await savedNames(page)).toEqual(['Bracket', 'Lid']);
  });

  test('Escape closes the browser', async ({ page }) => {
    await page.locator('.projects-search').focus();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(await store(page, (m) => m.getState().browsing)).toBe(false);
  });
});
