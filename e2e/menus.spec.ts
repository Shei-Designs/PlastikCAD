// The File menu, the About box, the list of export formats and the rows of the Objects tab:
// what they offer, how they say it to a screen reader, and how they close.
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, sceneIds, selection, settled, store, test } from './helpers';

/** The modifier as the app writes it (see src/ui/keys.ts): ⌘ on a Mac, Ctrl+ everywhere else. */
const MOD = process.platform === 'darwin' ? '⌘' : 'Ctrl+';

test.describe('menus and boxes', { tag: '@mouse' }, () => {
  const about = (page: Page): Locator => page.locator('dialog.about[open]');

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
  });

  async function openAbout(page: Page): Promise<void> {
    await page.locator('button[aria-label="File"]').click();
    await page.locator('.menu-item', { hasText: 'About' }).click();
    await expect(about(page)).toBeVisible();
  }

  test('the File menu lists its commands with their shortcuts, and Language and About below a rule', async ({ page }) => {
    await page.locator('button[aria-label="File"]').click();
    const menu = page.locator('.file-bar .menu');
    const items = await menu.evaluate((m) => [...m.children].map((c) => (c.tagName === 'HR' ? '—' : [...c.children].map((k) => k.textContent).join(' | '))));
    expect(items).toEqual([`New project | ${MOD}N`, `Projects… | ${MOD}O`, `Open project file… | ${MOD}Shift+O`, `Save a copy… | ${MOD}Shift+S`, '—', 'Language…', 'About PlastikCAD…']);
  });

  test('the About box opens from the File menu and has a name', async ({ page }) => {
    await openAbout(page);
    await expect(about(page)).toHaveAttribute('aria-label', 'About PlastikCAD');
  });

  test('a click beside the About box closes it', async ({ page }) => {
    await openAbout(page);
    await page.mouse.click(20, 20);
    await expect(about(page)).toHaveCount(0);
  });

  test('Escape closes the About box and leaves the selection as it was', async ({ page }) => {
    expect(await selection(page), 'the box is selected').toEqual(await sceneIds(page));
    await openAbout(page);
    await page.keyboard.press('Escape');
    await expect(about(page)).toHaveCount(0);
    expect(await selection(page)).toEqual(await sceneIds(page));
  });

  test('the export formats are a list box with the format in use marked', async ({ page }) => {
    await page.locator('.export-row .select-button').click();
    const list = page.locator('.export-row .menu');
    await expect(list).toHaveAttribute('role', 'listbox');
    await expect(list).toHaveAttribute('aria-label', 'File format');
    const options = await list.locator('[role=option]').evaluateAll((all) => all.map((o) => `${o.getAttribute('aria-selected')} ${o.textContent}`));
    expect(options).toEqual([
      'true STLBinary mesh for any slicer',
      'false 3MFMesh with colors and units for slicers',
      'false OBJText mesh with colors for modeling tools',
      'false GLBMesh with pictures for scenes',
      'false SVGTop-down outline for lasers',
      'false DXFTop-down outline for CAD',
    ]);
  });

  test('picking a format sets it, shows it on the button and closes the list', async ({ page }) => {
    const button = page.locator('.export-row .select-button');
    await button.click();
    await page.locator('.export-row .menu-item', { hasText: '3MF' }).click();
    await expect(page.locator('.export-row .menu')).toHaveCount(0);
    await expect(button).toHaveText('3MF');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toHaveAttribute('aria-label', 'File format');
    await expect(button).toHaveAttribute('title', 'File format');
    expect(await store(page, (m) => m.getState().prefs.format)).toBe('3mf');
  });

  test('a row of the Objects tab names its object and its Ghost, Lock and Hide buttons in tooltips', async ({ page }) => {
    await store(page, (m) => {
      m.setPrefs({ sidebar: 'objects' });
      m.addShape('cylinder');
    });
    const rows = page.locator('.objects li');
    await expect(rows).toHaveCount(2);
    const tips = await rows.evaluateAll((all) => all.map((row) => [...row.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join(' / ')));
    expect(tips.sort()).toEqual(['Box / Ghost / Lock / Hide', 'Cylinder / Ghost / Lock / Hide']);
  });
});
