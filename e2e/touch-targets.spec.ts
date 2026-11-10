// Finger-sized controls on a tablet: what can be tapped in the inspector, the menus and the
// Array, Mirror and Mate panels is at least 40 px high, and stays inside its panel.
import type { Page } from '@playwright/test';
import { expect, openApp, settled, store, tap, test } from './helpers';

/** The least width and height of something a finger has to hit, in CSS pixels. */
const FINGER = 40;

/**
 * What is smaller than that today and was left so, with the size each has now: these may not
 * shrink, and a control that is not listed here may not be smaller than a finger.
 */
const SMALLER: { what: RegExp; least: number }[] = [
  // The color swatches: eight across the inspector.
  { what: /^button\.swatch/, least: 29 },
  // The "i" beside a label: 13 px to the eye, 39 px to the touch.
  { what: /^span\.hint/, least: 39 },
  // The project's name above the sidebar's tabs.
  { what: /^input\.doc-name/, least: 38 },
  // A row of the Structure tab.
  { what: /^div\.outline-row/, least: 34 },
];

interface Control {
  /** What it is: tag, classes and where it sits, e.g. "button.swatch < .swatch-row". */
  what: string;
  /** The size a finger can hit: the element, or the larger area a ::before gives it. */
  width: number;
  height: number;
  /** How far it reaches past its panel's left and right edges, when it does. */
  sticksOut: string | null;
  /** Cut off by the left or right edge of the window. */
  offWindow: boolean;
}

/** Every control under `root` that can be tapped, with its size. */
function controls(page: Page, root: string): Promise<Control[]> {
  return page.evaluate((root) => {
    const panel = document.querySelector(root);
    if (!panel) throw new Error(`Nothing on the page for ${root}`);
    const edge = panel.getBoundingClientRect();
    const out: Control[] = [];
    for (const el of panel.querySelectorAll<HTMLElement>('button, input, select, textarea, .number-box, .hint, [role=treeitem]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // The box inside a number box and the color well inside a swatch are hit through what holds them.
      if (el.matches('.number-box input, .swatch-input')) continue;
      // A control drawn small for the eye may answer over a larger area, given by its ::before.
      const before = getComputedStyle(el, '::before');
      const grown = before.content !== 'none' && before.position === 'absolute';
      const grow = (side: string): number => (grown ? Math.max(0, -parseFloat(before.getPropertyValue(side)) || 0) : 0);
      const classes = typeof el.className === 'string' ? el.className.split(' ').filter((c) => c && c !== 'on' && c !== 'selected') : [];
      const parent = typeof el.parentElement?.className === 'string' ? el.parentElement.className.split(' ')[0] : '';
      out.push({
        what: `${el.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join('')}${parent ? ` < .${parent}` : ''}`,
        width: Math.round(r.width + grow('left') + grow('right')),
        height: Math.round(r.height + grow('top') + grow('bottom')),
        sticksOut: r.left < edge.left - 1 || r.right > edge.right + 1 ? `${Math.round(r.left - edge.left)}..${Math.round(r.right - edge.right)}` : null,
        offWindow: r.left < -1 || r.right > innerWidth + 1,
      });
    }
    return out;
  }, root);
}

/** The controls under `root` are finger-sized, none reaches past its panel, and none is cut off by the window. */
async function expectFingerSized(page: Page, root: string, name: string): Promise<void> {
  const all = await controls(page, root);
  expect(all.length, `${name} has controls to measure`).toBeGreaterThan(0);
  const least = (c: Control): number => SMALLER.find((s) => s.what.test(c.what))?.least ?? FINGER;
  const small = all.filter((c) => Math.min(c.width, c.height) < least(c)).map((c) => `${c.what} ${c.width}x${c.height}`);
  expect.soft([...new Set(small)], `${name}: controls smaller than a finger`).toEqual([]);
  expect.soft(all.filter((c) => c.sticksOut).map((c) => `${c.what} ${c.sticksOut}`), `${name}: controls that reach past their panel`).toEqual([]);
  expect.soft(all.filter((c) => c.offWindow).map((c) => c.what), `${name}: controls cut off by the window`).toEqual([]);
}

// The tablet held sideways, as the project has it, and upright.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 800, height: 1280 },
]) {
  const upright = viewport.height > viewport.width;

  test.describe(`finger-sized controls at ${viewport.width} x ${viewport.height}`, { tag: '@touch' }, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await openApp(page);
    });

    // Upright there is no room for the panels beside the plate: they start out of the way and lie over it when
    // called for, one at a time. A test that measures a panel puts it on show, as a tap on its tab would.
    const show = async (page: Page, side: 'left' | 'right'): Promise<void> => {
      if (upright) await store(page, (m, left) => m.setPrefs({ leftPanel: left, rightPanel: !left }), side === 'left');
    };

    test('the inspector of a shape, of a text and of a part', async ({ page }) => {
      await show(page, 'right');
      await store(page, (m) => m.addShape('fillet'));
      await settled(page);
      await expectFingerSized(page, '.inspector', 'a shape in the inspector');
      await expectFingerSized(page, '.transform-box', 'the Dimensions box');
      await store(page, async (m) => {
        await m.addText();
      });
      await settled(page);
      await expectFingerSized(page, '.inspector', 'a text in the inspector');
      await store(page, async (m) => {
        await m.addPart('gears');
      });
      await settled(page);
      await expectFingerSized(page, '.inspector', 'a gear in the inspector');
    });

    test('the Mate panel', async ({ page }) => {
      await store(page, async (m) => {
        await m.addPart('gears');
        m.startMate(m.getState().selection[0]);
      });
      await expect(page.locator('.mate-panel')).toBeVisible();
      await expect.poll(() => store(page, (m) => m.getState().mating?.building)).toBe(false);
      await expectFingerSized(page, '.mate-panel', 'the Mate panel');
    });

    test('the Array panel, as a grid and as a ring, and the Mirror panel', async ({ page }) => {
      await store(page, (m) => m.addShape('box'));
      await settled(page);
      await tap(page.locator('button[aria-label="Array"]'));
      await expect(page.locator('.array-panel')).toBeVisible();
      await expectFingerSized(page, '.popover-panel', 'the Array panel');
      await tap(page.locator('.array-panel .segmented button', { hasText: 'Ring' }));
      await expectFingerSized(page, '.popover-panel', 'the Array panel for a ring');
      await page.keyboard.press('Escape');
      await expect(page.locator('.popover-panel')).toHaveCount(0);
      await tap(page.locator('button[aria-label^="Mirror"]'));
      await expect(page.locator('.popover-panel')).toBeVisible();
      await expectFingerSized(page, '.popover-panel', 'the Mirror panel');
    });

    test('the File menu and the list of export formats', async ({ page }) => {
      await show(page, 'left');
      await store(page, (m) => {
        m.addShape('box');
        m.select([]);
      });
      await settled(page);
      await tap(page.locator('button[aria-label="File"]'));
      await expect(page.locator('.popover-panel')).toBeVisible();
      await expectFingerSized(page, '.popover-panel', 'the File menu');
      await page.keyboard.press('Escape');
      await expect(page.locator('.popover-panel')).toHaveCount(0);
      await tap(page.locator('.export-row .select-button'));
      await expect(page.locator('.popover-panel')).toBeVisible();
      await expectFingerSized(page, '.popover-panel', 'the list of export formats');
    });

    test('the measure bar', async ({ page }) => {
      await store(page, (m) => {
        m.addShape('box');
        m.select([]);
        m.toggleMeasuring();
      });
      await expect(page.locator('.hint-bar.measure')).toBeVisible();
      await expectFingerSized(page, '.hint-bar.measure', 'the measure bar');
    });

    test('the Structure tab and the parts bin', async ({ page }) => {
      await store(page, (m) => {
        m.addShape('box');
        m.setPrefs({ sidebar: 'structure' });
      });
      await settled(page);
      await show(page, 'left');
      await expect(page.locator('.outline-row').first()).toBeVisible();
      await expectFingerSized(page, '.sidebar', 'the Structure tab');
      await store(page, (m) => {
        m.select([]);
        m.openPartsBin();
      });
      await show(page, 'right');
      await expectFingerSized(page, '.inspector', 'the parts bin');
    });

    test('the Dimensions box leaves the sidebar\'s Import and Export controls free', async ({ page }) => {
      await store(page, (m) => m.addShape('box'));
      await settled(page);
      await show(page, 'left');
      await expect(page.locator('.transform-box')).toBeVisible();
      // A trial tap: Playwright checks that a finger there would reach the control, and taps nothing.
      await page.locator('.export-row .select-button').tap({ trial: true });
      await page.locator('.sidebar .import-button').tap({ trial: true });
    });

    test('the page itself does not scroll', async ({ page }) => {
      await store(page, async (m) => {
        m.addShape('fillet');
        await m.addPart('gears');
      });
      await settled(page);
      const spill = await page.evaluate(() => {
        const d = document.documentElement;
        return { sideways: d.scrollWidth - d.clientWidth, down: d.scrollHeight - d.clientHeight };
      });
      expect(spill).toEqual({ sideways: 0, down: 0 });
    });
  });
}
