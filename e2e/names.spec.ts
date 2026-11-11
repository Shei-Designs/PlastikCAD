// The name boxes that take their value when typing is done: the object's name in the inspector,
// the project's name above the sidebar, and the name of the picked layer in the Structure tab.
// Enter (or leaving the box) takes the name, Escape puts the old one back, an empty name is not
// taken, and the spaces round a name are dropped.
import type { Locator, Page } from '@playwright/test';
import { expect, openApp, sceneIds, settled, store, test } from './helpers';

interface NameBox {
  where: string;
  box: (page: Page) => Locator;
  /** The name as the design has it. */
  name: (page: Page) => Promise<string>;
  /** What the box needs on the page before it is there. */
  show: (page: Page) => Promise<void>;
}

const objectName = (page: Page): Promise<string> => store(page, (m) => m.getState().doc.scene[0].name);

const BOXES: NameBox[] = [
  { where: 'the inspector', box: (page) => page.locator('.inspector .name-input'), name: objectName, show: async () => {} },
  { where: 'the file bar', box: (page) => page.locator('.file-bar .doc-name'), name: (page) => store(page, (m) => m.getState().doc.name), show: async () => {} },
  {
    where: 'the Structure tab',
    box: (page) => page.locator('.details-field input.text-input'),
    name: objectName,
    show: async (page) => {
      await store(page, (m) => m.setPrefs({ sidebar: 'structure' }));
      await page.locator('.outline-row').first().click();
    },
  },
];

test.describe('name boxes', { tag: '@mouse' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, async (m) => {
      await m.startProject('Bracket');
      m.addShape('box');
    });
    await settled(page);
    const [box] = await sceneIds(page);
    await store(page, (m, id) => m.select([id]), box);
  });

  /** Types over what the box holds and ends with a key. */
  async function type(page: Page, box: Locator, text: string, end: 'Enter' | 'Escape' | 'Tab'): Promise<void> {
    await box.click();
    await page.keyboard.press('ControlOrMeta+a');
    if (text === '') await page.keyboard.press('Delete');
    else await page.keyboard.type(text);
    await page.keyboard.press(end);
  }

  for (const { where, box, name, show } of BOXES) {
    test.describe(`in ${where}`, () => {
      test.beforeEach(async ({ page }) => {
        await show(page);
        await expect(box(page)).toBeVisible();
      });

      test('Enter takes the name that was typed', async ({ page }) => {
        await type(page, box(page), 'Alpha', 'Enter');
        await expect.poll(() => name(page)).toBe('Alpha');
        await expect(box(page)).toHaveValue('Alpha');
      });

      test('Escape puts the old name back', async ({ page }) => {
        const before = await name(page);
        await type(page, box(page), 'Never', 'Escape');
        await expect(box(page)).toHaveValue(before);
        expect(await name(page)).toBe(before);
      });

      test('an empty name, or one of spaces alone, is not taken', async ({ page }) => {
        const before = await name(page);
        await type(page, box(page), '', 'Enter');
        await expect(box(page)).toHaveValue(before);
        await type(page, box(page), '   ', 'Enter');
        await expect(box(page)).toHaveValue(before);
        expect(await name(page)).toBe(before);
      });

      test('the spaces round a name are dropped', async ({ page }) => {
        await type(page, box(page), '  Gamma  ', 'Enter');
        await expect.poll(() => name(page)).toBe('Gamma');
        await expect(box(page)).toHaveValue('Gamma');
      });

      test('leaving the box with Tab takes the name', async ({ page }) => {
        await type(page, box(page), 'Delta', 'Tab');
        await expect.poll(() => name(page)).toBe('Delta');
        await expect(box(page)).not.toBeFocused();
      });
    });
  }

  test('each name box says what it names and is not spell-checked', async ({ page }) => {
    await expect(page.locator('.inspector .name-input')).toHaveAttribute('aria-label', 'Name');
    await expect(page.locator('.inspector .name-input')).toHaveAttribute('spellcheck', 'false');
    await expect(page.locator('.file-bar .doc-name')).toHaveAttribute('aria-label', 'Project name');
    await expect(page.locator('.file-bar .doc-name')).toHaveAttribute('title', 'Project name');
    await expect(page.locator('.file-bar .doc-name')).toHaveAttribute('spellcheck', 'false');
    await BOXES[2].show(page);
    await expect(BOXES[2].box(page)).toHaveAttribute('aria-label', 'Name');
    await expect(BOXES[2].box(page)).toHaveAttribute('spellcheck', 'false');
  });
});
