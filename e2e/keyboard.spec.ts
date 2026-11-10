// The keyboard: where the focus shows, what the tooltips and the Shortcuts list say the keys
// are, and Ctrl+N from inside the Projects dialog.
import { expect, openApp, sceneIds, settled, store, test } from './helpers';

/** The modifier as the app writes it (see src/ui/keys.ts): ⌘ on a Mac, Ctrl+ everywhere else. */
const MOD = process.platform === 'darwin' ? '⌘' : 'Ctrl+';

test.describe('the keyboard', { tag: '@mouse' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.select([]);
    });
    await settled(page);
  });

  test('the Snap chip shows the keyboard focus of the select inside it', async ({ page }) => {
    await page.locator('.toolbar .chip', { hasText: 'Grid' }).focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement!;
      const chip = el.closest('.chip.select');
      const style = chip && getComputedStyle(chip);
      return { tag: el.tagName, outline: style?.outlineStyle, width: style?.outlineWidth };
    });
    expect(focus).toEqual({ tag: 'SELECT', outline: 'solid', width: '2px' });
  });

  test('a row of the Structure tab shows the keyboard focus as a ring', async ({ page }) => {
    const [box] = await sceneIds(page);
    await store(
      page,
      (m, id) => {
        m.setPrefs({ sidebar: 'structure' });
        m.select([id]);
      },
      box,
    );
    await page.locator('.page-tabs button', { hasText: 'Structure' }).focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement!;
      return { row: el.classList.contains('outline-row'), outline: getComputedStyle(el).outlineStyle };
    });
    expect(focus).toEqual({ row: true, outline: 'solid' });
  });

  test('the toolbar tooltips name their shortcuts, with the shared modifier', async ({ page }) => {
    const title = (label: string) => page.locator(`.toolbar button[aria-label="${label}"]`);
    await expect(title('Group')).toHaveAttribute('title', `Group (${MOD}G)`);
    await expect(title('Redo')).toHaveAttribute('title', `Redo (${MOD}Y)`);
    await expect(title('Delete')).toHaveAttribute('title', 'Delete (Delete)');
    await expect(title('Ghost')).toHaveAttribute('title', 'Ghost (G)');
  });

  test('the Shortcuts list has Measure, Object axes, select all, cut, delete and redo', async ({ page }) => {
    const rows = (await page.locator('.facts.keys > div').allInnerTexts()).map((row) => row.replace(/\n/g, ' = '));
    expect(rows).toEqual(
      expect.arrayContaining(['Measure = M', 'Object axes = O', `Select all = ${MOD}A`, 'Delete = Delete', `Undo / redo = ${MOD}Z / ${MOD}Y`, `Copy / cut / paste = ${MOD}C / ${MOD}X / ${MOD}V`]),
    );
  });

  test('Ctrl+N in the Projects dialog asks for a name and starts the project', async ({ page }) => {
    const before = await store(page, (m) => m.getState().epoch);
    await store(page, (m) => void m.openProjects());
    await expect(page.locator('dialog.projects[open]')).toBeVisible();
    await page.locator('.projects-search').focus();
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page.locator('dialog.ask[open] h2', { hasText: 'New project' })).toBeVisible();
    const name = page.locator('dialog.ask[open] input.text-input');
    await expect(name).toBeFocused();
    // Put in whole, not key by key: the box selects its text a tick after it opens, and keys that
    // arrive before that (a script's, not a person's) would be typed over.
    await name.fill('From the shortcut');
    await page.keyboard.press('Enter');
    await expect.poll(() => store(page, (m) => m.getState().doc.name)).toBe('From the shortcut');
    const after = await store(page, (m) => ({ browsing: m.getState().browsing, objects: m.getState().doc.scene.length, epoch: m.getState().epoch }));
    expect(after.objects, 'the new project is empty').toBe(0);
    expect(after.epoch, 'a different design was loaded').not.toBe(before);
    expect(after.browsing, 'the Projects dialog closed').toBe(false);
  });
});
