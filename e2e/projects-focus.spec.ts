// Where the focus goes when the projects are opened: into the search with a keyboard, so that typing finds a
// project at once; onto the box itself by touch, where the search taking the focus raised the keypad over the
// projects every time.
import { expect, withoutKeyboard, openApp, store, test } from './helpers';

test.describe('the projects box as it opens', () => {
  const openProjects = async (page: Parameters<typeof openApp>[0]): Promise<void> => {
    await store(page, (m) => m.openProjects());
    await expect(page.locator('dialog.projects[open]')).toBeVisible();
  };

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('with a mouse and keyboard the search has the focus', { tag: '@mouse' }, async ({ page }) => {
    await openProjects(page);
    await expect(page.locator('.projects-search')).toBeFocused();
  });

  test('by touch with a keyboard attached the search has it too', { tag: '@touch' }, async ({ page }) => {
    await openProjects(page);
    await expect(page.locator('.projects-search')).toBeFocused();
  });

  test('by touch with no keyboard the box has it, and a tap on the search still gives it the focus', { tag: '@touch' }, async ({ page }) => {
    await withoutKeyboard(page);
    await openProjects(page);
    await expect(page.locator('dialog.projects[open]')).toBeFocused();
    await page.locator('.projects-search').tap();
    await expect(page.locator('.projects-search')).toBeFocused();
  });
});
