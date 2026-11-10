// The keyboard: where the focus shows, what the tooltips and the Shortcuts list say the keys
// are (both read src/ui/keymap.ts), and Ctrl+N from inside the Projects dialog.
import { expect, openApp, sceneIds, settled, store, test, withoutKeyboard } from './helpers';

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

  test('the Shortcuts list drops its keys when the keyboard is taken away', async ({ page }) => {
    const rows = async () => (await page.locator('.facts.keys > div').allInnerTexts()).map((row) => row.replace(/\n/g, ' = '));
    expect(await rows()).toEqual(expect.arrayContaining(['Orbit = Right drag', 'Move = Drag · arrow keys · Shift ×10', 'Measure = M']));
    await withoutKeyboard(page);
    await expect.poll(rows).toEqual(['Orbit = Right drag', 'Pan = Middle drag · Shift+right drag', 'Zoom = Wheel', 'Move = Drag', 'Raise or lower = Arrow handle', 'Resize height = Drag top or bottom grip', 'Type a size = Click a grip']);
  });

  test('the keys run their commands on the selection, and keep out of a text box', async ({ page }) => {
    const [box] = await sceneIds(page);
    const pick = () => store(page, (m, id) => m.select([id]), box);
    const node = () =>
      store(page, (m) => {
        const n = m.getState().doc.scene[0];
        return { pos: n.pos.map((x) => +x.toFixed(3)), rot: n.rot.map((x) => +x.toFixed(3)), hole: n.hole, ghost: Boolean(n.ghost), flip: Boolean(n.flip?.[0]) };
      });
    const count = () => store(page, (m) => m.getState().doc.scene.length);
    const picked = () => store(page, (m) => m.getState().selection.length);
    const snap = await store(page, (m) => m.getState().prefs.snap || 1);
    await pick();
    const start = await node();

    // The arrows move by the snap step, ten of them with Shift; Ctrl raises.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect((await node()).pos).toEqual([start.pos[0] - snap, start.pos[1] + 9 * snap, start.pos[2] + snap]);
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
    expect((await node()).pos[2]).toBe(start.pos[2] - 9 * snap);

    await page.keyboard.press('h');
    expect((await node()).hole, 'H makes a hole').toBe(true);
    await page.keyboard.press('s');
    expect((await node()).hole, 'S makes it solid').toBe(false);
    await page.keyboard.press('x');
    expect((await node()).flip, 'X flips').toBe(true);
    await page.keyboard.press('x');
    const before = await node();
    await page.keyboard.press('Shift+X');
    const turned = await node();
    expect(turned.rot, 'Shift+X turns').not.toEqual(before.rot);
    await page.keyboard.press('Alt+Shift+X');
    expect((await node()).rot, 'with Alt it turns back').toEqual(before.rot);

    await page.keyboard.press('g');
    expect((await node()).ghost, 'G ghosts').toBe(true);
    await page.keyboard.press('Shift+G');
    expect((await node()).ghost, 'Shift+G brings it back').toBe(false);

    await pick();
    await page.keyboard.press('ControlOrMeta+d');
    expect(await count(), 'Ctrl+D duplicates').toBe(2);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await count(), 'Ctrl+Z undoes').toBe(1);
    await page.keyboard.press('ControlOrMeta+y');
    expect(await count(), 'Ctrl+Y redoes').toBe(2);
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    expect(await count(), 'Ctrl+Shift+Z redoes too').toBe(2);
    await page.keyboard.press('ControlOrMeta+a');
    expect(await picked(), 'Ctrl+A selects all').toBe(2);
    await page.keyboard.press('Escape');
    expect(await picked(), 'Escape clears the selection').toBe(0);

    // In a text box the same keys are typing: nothing is deleted, and the name takes the letter.
    await page.keyboard.press('ControlOrMeta+a');
    const name = page.locator('.doc-name');
    await name.focus();
    await page.keyboard.press('Delete');
    await page.keyboard.press('h');
    expect(await count(), 'Delete in a text box deletes no object').toBe(2);
    await expect(name).toHaveValue(/h$/);
    await page.keyboard.press('Escape');
    await name.blur();
    await page.keyboard.press('Backspace');
    expect(await count(), 'Backspace deletes the selection').toBe(0);
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
