// What makes fingers and a pen on the plate pleasant: two fingers tapped undo and three redo, a
// ring fills at a finger while a long press builds, and the hand that holds a pen is not a finger.
import { centre, expect, fingers, fitView, hitsObject, openApp, pause, pen, penWatch, plate, positions, sceneCount, selection, settled, store, test, viewState } from './helpers';
import type { Page } from '@playwright/test';
import type { Fingers, Pen, Plate } from './helpers';

/** The long press of the viewer (LONG_PRESS_MS in src/viewer/gesture.ts). */
const LONG_PRESS = 450;
/** How long a word at the finger stays (NOTE_MS there). */
const NOTE = 900;
/** How long after the pen fingers count again (PALM_GRACE_MS there). */
const PALM_GRACE = 400;

test.describe('touch polish', { tag: '@touch' }, () => {
  let finger: Fingers;
  let p: Plate;
  /** A point of the plate with nothing on it, and another well away from it. */
  let empty: [number, number];
  let aside: [number, number];

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.select([]);
    });
    await settled(page);
    await fitView(page);
    finger = await fingers(page);
    p = await plate(page);
    empty = [p.x + 60, p.y + p.height - 200];
    aside = [p.x + p.width - 140, p.y + p.height - 200];
    expect(await hitsObject(page, p.cx, p.cy), 'the middle of the canvas is on the box').toBe(true);
    expect(await hitsObject(page, empty[0], empty[1]), 'the corner of the canvas is empty').toBe(false);
    expect(await hitsObject(page, aside[0], aside[1]), 'so is the other corner').toBe(false);
  });

  const ring = (page: Page) => page.locator('.canvas-host .hold-ring');
  const note = (page: Page) => page.locator('.canvas-host .touch-note');

  /** Fingers that land one after the other at the points, rest a moment and lift together. */
  async function tapWith(page: Page, points: [number, number][], rest = 40): Promise<void> {
    for (let n = 1; n <= points.length; n++) await finger.start(points.slice(0, n).map(([x, y], id) => [x, y, id]));
    await pause(page, rest);
    await finger.end();
  }

  /** What a tap must leave as it was: the camera. */
  const camera = async (page: Page) => {
    const { distance, azimuth, target } = await viewState(page);
    return { distance, azimuth, target };
  };

  test.describe('a tap of two or three fingers', () => {
    test('two fingers tapped undo the last step, and say so', async ({ page }) => {
      const view = await camera(page);
      await tapWith(page, [empty, [empty[0] + 70, empty[1] - 20]]);
      await expect.poll(() => sceneCount(page), 'the box was taken back').toBe(0);
      await expect(note(page)).toHaveText('Undo');
      await expect(note(page)).toBeVisible();
      expect(await camera(page), 'the camera is where it was').toEqual(view);
      expect(await viewState(page), 'nothing is left pressed').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
      await pause(page, NOTE + 100);
      await expect(note(page), 'the word goes after a moment').toBeHidden();
    });

    test('three fingers tapped redo it', async ({ page }) => {
      await store(page, (m) => m.undo());
      expect(await sceneCount(page)).toBe(0);
      await tapWith(page, [empty, [empty[0] + 70, empty[1] - 20], [empty[0] + 140, empty[1]]]);
      await expect.poll(() => sceneCount(page), 'the box is back').toBe(1);
      await expect(note(page)).toHaveText('Redo');
    });

    test('two fingers tapped on an object undo all the same, and move nothing', async ({ page }) => {
      const at = await positions(page);
      await store(page, (m) => {
        m.selectAll();
        m.nudgeSelected([10, 0, 0]);
        m.select([]);
      });
      expect(await positions(page)).not.toEqual(at);
      await tapWith(page, [
        [p.cx, p.cy],
        [p.cx + 40, p.cy + 10],
      ]);
      await expect.poll(() => positions(page), 'the nudge was taken back, and the object is where it was before it').toEqual(at);
      expect(await sceneCount(page), 'one step and no more').toBe(1);
      expect(await viewState(page), 'nothing is left pressed').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
    });

    test('with nothing to undo, two fingers tapped say so and change nothing', async ({ page }) => {
      await store(page, (m) => m.undo());
      expect(await store(page, (m) => m.getState().canUndo)).toBe(false);
      await tapWith(page, [empty, [empty[0] + 70, empty[1] - 20]]);
      await expect(note(page)).toHaveText('Nothing to undo');
      expect(await store(page, (m) => m.getState().canRedo), 'the step that can be brought back is still there').toBe(true);
    });

    test('two fingers that move are a pinch, and undo nothing', async ({ page }) => {
      const before = await viewState(page);
      const [x, y] = empty;
      await finger.start([[x, y, 0]]);
      await finger.start([[x, y, 0], [x + 60, y, 1]]);
      for (let i = 1; i <= 4; i++) await finger.move([[x - i * 10, y, 0], [x + 60 + i * 10, y, 1]]);
      await finger.end();
      await pause(page, 300);
      expect(await sceneCount(page), 'nothing was undone').toBe(1);
      expect((await viewState(page)).distance, 'the camera came closer').toBeLessThan(before.distance);
      await expect(note(page)).toHaveCount(0);
    });

    test('two fingers held too long undo nothing', async ({ page }) => {
      await tapWith(page, [empty, [empty[0] + 70, empty[1] - 20]], 400);
      await pause(page, 200);
      expect(await sceneCount(page)).toBe(1);
      await expect(note(page)).toHaveCount(0);
    });

    test('a second finger that lands late beside the first undoes nothing', async ({ page }) => {
      await finger.start([[empty[0], empty[1], 0]]);
      await pause(page, 230);
      await finger.start([[empty[0], empty[1], 0], [empty[0] + 70, empty[1] - 20, 1]]);
      await finger.end();
      await pause(page, 200);
      expect(await sceneCount(page)).toBe(1);
      await expect(note(page)).toHaveCount(0);
    });

    test('two fingers tapped beside a finger dragging an object undo nothing, and the move goes on', async ({ page }) => {
      const { cx, cy } = p;
      const at = await positions(page);
      await finger.start([[cx, cy, 0]]);
      await pause(page, 60);
      for (let i = 1; i <= 6; i++) {
        await finger.move([[cx - i * 8, cy, 0]]);
        await pause(page, 25);
      }
      expect((await viewState(page)).drag).toBe('move');
      const held: [number, number, number] = [cx - 48, cy, 0];
      // Twice, as fingers that tap and tap again.
      for (let tap = 0; tap < 2; tap++) {
        await finger.start([held, [aside[0], aside[1], 1]]);
        await finger.start([held, [aside[0], aside[1], 1], [aside[0] + 70, aside[1] - 20, 2]]);
        await pause(page, 40);
        // The protocol lifts the fingers it is given, and leaves the one that drags.
        await finger.end([[aside[0], aside[1], 1], [aside[0] + 70, aside[1] - 20, 2]]);
        await pause(page, 120);
      }
      expect(await viewState(page), 'still the move').toMatchObject({ drag: 'move', cameraTouches: 0 });
      await finger.end();
      await pause(page, 200);
      expect(await sceneCount(page), 'the box is still there').toBe(1);
      expect(await positions(page), 'and where the finger left it').not.toEqual(at);
      await expect(note(page)).toHaveCount(0);
    });
  });

  test.describe('the ring of a long press', () => {
    test('fills at a finger resting on the plate, and goes when the box selection starts', async ({ page }) => {
      await finger.start([[empty[0], empty[1], 0]]);
      await expect(ring(page)).toBeVisible();
      const [x, y] = await centre(ring(page));
      expect(Math.hypot(x - empty[0], y - empty[1]), 'the ring is round the finger').toBeLessThan(1.5);
      await pause(page, LONG_PRESS - 50);
      expect((await viewState(page)).drag, 'not a long press yet').toBe('pending-tap');
      await pause(page, 50);
      expect((await viewState(page)).drag, 'the long press came').toBe('marquee');
      await expect(ring(page)).toBeHidden();
      await finger.end();
    });

    test('fills at a finger resting on an object, and goes when the object joins the selection', async ({ page }) => {
      await finger.start([[p.cx, p.cy, 0]]);
      await expect(ring(page)).toBeVisible();
      expect(await selection(page), 'not selected while the ring fills').toHaveLength(0);
      await pause(page, LONG_PRESS);
      expect(await selection(page), 'the long press came').toHaveLength(1);
      await expect(ring(page)).toBeHidden();
      await finger.end();
    });

    test('goes the moment the finger slides off into a drag', async ({ page }) => {
      for (const [x, y, becomes] of [[empty[0], empty[1], null], [p.cx, p.cy, 'move']] as const) {
        await finger.start([[x, y, 0]]);
        await expect(ring(page)).toBeVisible();
        // Within the wobble a finger is allowed, the press is still building.
        await finger.move([[x + 5, y, 0]]);
        await expect(ring(page)).toBeVisible();
        await finger.move([[x + 30, y, 0]]);
        await expect(ring(page)).toBeHidden();
        expect((await viewState(page)).drag).toBe(becomes);
        await finger.end();
        await pause(page, 100);
      }
    });

    test('goes the moment a second finger lands', async ({ page }) => {
      for (const [x, y] of [empty, [p.cx, p.cy]]) {
        await finger.start([[x, y, 0]]);
        await expect(ring(page)).toBeVisible();
        await finger.start([[x, y, 0], [x + 60, y + 10, 1]]);
        await expect(ring(page)).toBeHidden();
        await pause(page, LONG_PRESS + 100);
        expect(await viewState(page), 'and no long press comes of it').toMatchObject({ drag: null, cameraTouches: 2 });
        await finger.end();
        await pause(page, 100);
      }
      expect(await selection(page)).toHaveLength(0);
    });

    test('goes the moment the finger lifts', async ({ page }) => {
      await finger.start([[p.cx, p.cy, 0]]);
      await expect(ring(page)).toBeVisible();
      await finger.end();
      await expect(ring(page)).toBeHidden();
    });

    test('takes no pointer, wears the accent of the theme and fills in the time of a long press', async ({ page }) => {
      /** The accent as the page has it now, as a color. */
      const accent = () =>
        page.evaluate(() => {
          const probe = document.createElement('i');
          probe.style.color = 'var(--accent)';
          document.body.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        });
      const look = () =>
        ring(page).evaluate((el) => {
          const fill = getComputedStyle(el.querySelector('.fill')!);
          return { pointer: getComputedStyle(el).pointerEvents, color: fill.stroke, animation: fill.animationName, duration: fill.animationDuration, timing: fill.animationTimingFunction };
        });
      const colors: string[] = [];
      for (const theme of ['dark', 'light'] as const) {
        await store(page, (m, theme) => m.setPrefs({ theme }), theme);
        await finger.start([[empty[0], empty[1], 0]]);
        await expect(ring(page)).toBeVisible();
        const seen = await look();
        expect(seen, `${theme}: an animation as long as the press, at an even pace`).toMatchObject({ pointer: 'none', animation: 'hold-ring-fill', duration: `${LONG_PRESS / 1000}s`, timing: 'linear' });
        expect(seen.color, `${theme}: in the accent`).toBe(await accent());
        colors.push(seen.color);
        // A press where the ring is reaches the canvas under it.
        expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, empty)).toBe('CANVAS');
        await finger.end();
        await pause(page, 100);
      }
      expect(colors[0], 'the two themes have accents of their own').not.toBe(colors[1]);
    });

    test('stands still, whole, for those who asked for less motion', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await finger.start([[empty[0], empty[1], 0]]);
      await expect(ring(page)).toBeVisible();
      const fill = await ring(page).evaluate((el) => {
        const style = getComputedStyle(el.querySelector('.fill')!);
        return { animation: style.animationName, offset: parseFloat(style.strokeDashoffset) };
      });
      expect(fill, 'no animation, and the ring drawn all the way round').toEqual({ animation: 'none', offset: 0 });
      // It still goes when the press comes.
      await pause(page, LONG_PRESS);
      expect((await viewState(page)).drag).toBe('marquee');
      await expect(ring(page)).toBeHidden();
      await finger.end();
    });

    test('is not for a mouse, which has no long press', async ({ page }) => {
      for (const [x, y] of [empty, [p.cx, p.cy]]) {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await pause(page, 200);
        await expect(ring(page)).toBeHidden();
        await pause(page, LONG_PRESS);
        expect((await viewState(page)).drag, 'the press is what it was').toMatch(/^pending-/);
        await page.mouse.up();
      }
    });
  });

  test.describe('the hand that holds a pen', () => {
    let stylus: Pen;
    /** Where the pen is held over the plate: empty space, away from the fingers. */
    let over: [number, number];

    test.beforeEach(async ({ page }) => {
      stylus = await pen(page);
      over = [aside[0], aside[1] - 120];
      expect(await hitsObject(page, over[0], over[1])).toBe(false);
    });

    /** One finger dragged sideways from a point, which on empty space turns the camera. */
    async function swipe(page: Page, [x, y]: [number, number], id = 0): Promise<void> {
      await finger.start([[x, y, id]]);
      await pause(page, 40);
      for (let i = 1; i <= 6; i++) {
        await finger.move([[x + i * 8, y, id]]);
        await pause(page, 20);
      }
    }

    /** A touch on the plate, in each of the ways a finger is read, does nothing at all. */
    async function touchesAreIgnored(page: Page): Promise<void> {
      const view = await camera(page);
      // A drag on empty space, which would turn the camera.
      await swipe(page, empty);
      expect(await penWatch(page), 'the touch is taken for the hand').toMatchObject({ palms: 1 });
      expect(await viewState(page), 'neither the viewer nor the camera has it').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
      await finger.end();
      expect(await camera(page), 'the camera did not turn').toEqual(view);
      // A tap on an object, which would select it.
      await tapWith(page, [[p.cx, p.cy]]);
      await pause(page, 100);
      expect(await selection(page), 'nothing was selected').toHaveLength(0);
      // A finger held still on empty space, which would start a box selection.
      await finger.start([[empty[0], empty[1], 0]]);
      await pause(page, 150);
      await expect(ring(page), 'no long press builds').toBeHidden();
      await pause(page, LONG_PRESS);
      expect((await viewState(page)).drag, 'no box selection started').not.toBe('marquee');
      await expect(page.locator('.canvas-host .marquee')).toBeHidden();
      await finger.end();
      // Two fingers tapped, which would undo.
      await tapWith(page, [empty, [empty[0] + 70, empty[1] - 20]]);
      await pause(page, 100);
      expect(await sceneCount(page), 'nothing was undone').toBe(1);
      expect(await penWatch(page), 'no touch is kept once all have lifted').toMatchObject({ palms: 0 });
    }

    test('while the pen hovers over the plate, touches neither turn the camera, nor select, nor box-select, nor undo', async ({ page }) => {
      await stylus.hover(over[0], over[1]);
      await stylus.hover(over[0] + 4, over[1]);
      expect(await penWatch(page)).toMatchObject({ down: false, near: true });
      await touchesAreIgnored(page);
    });

    test('while the pen hovers over a panel beside the plate, touches on the plate are ignored as well', async ({ page }) => {
      const [x, y] = await centre(page.getByRole('heading', { name: 'Shapes' }));
      await stylus.hover(x, y);
      expect(await penWatch(page)).toMatchObject({ down: false, near: true });
      await touchesAreIgnored(page);
    });

    test('while the pen is down on a panel beside the plate, touches on the plate are ignored', async ({ page }) => {
      const [x, y] = await centre(page.getByRole('heading', { name: 'Shapes' }));
      await stylus.hover(x, y);
      await stylus.down(x, y);
      expect(await penWatch(page)).toMatchObject({ down: true });
      // Longer than a hover would be believed without a word from the pen: a tip at rest says nothing.
      await pause(page, 2200);
      await touchesAreIgnored(page);
      await stylus.up(x, y);
    });

    test('while the pen is down on the plate, touches are ignored and the pen does its own work', async ({ page }) => {
      await stylus.hover(over[0], over[1]);
      await stylus.down(over[0], over[1]);
      expect(await viewState(page), 'the pen has a press of its own, as a mouse would').toMatchObject({ drag: 'pending-marquee' });
      const view = await camera(page);
      await swipe(page, empty);
      expect(await penWatch(page)).toMatchObject({ down: true, palms: 1 });
      await finger.end();
      expect(await camera(page), 'the camera did not turn').toEqual(view);
      // The pen draws its box round the object meanwhile.
      await stylus.drag(p.cx - 200, p.cy - 200);
      expect((await viewState(page)).drag).toBe('marquee');
      await stylus.up(p.cx - 200, p.cy - 200);
      await expect.poll(() => selection(page), 'the box selection of the pen took the object').toHaveLength(1);
    });

    test('a finger already turning the camera goes on when the pen arrives and presses', async ({ page }) => {
      const [x, y] = empty;
      const at = await positions(page);
      const start = await viewState(page);
      await swipe(page, empty);
      const turned = await viewState(page);
      expect(turned.azimuth, 'the finger turns the camera').not.toBe(start.azimuth);
      await stylus.hover(over[0], over[1]);
      expect(await penWatch(page)).toMatchObject({ near: true, palms: 0 });
      for (let i = 7; i <= 12; i++) {
        await finger.move([[x + i * 8, y, 0]]);
        await pause(page, 20);
      }
      const hovering = await viewState(page);
      expect(hovering.azimuth, 'and goes on turning it under a hovering pen').not.toBe(turned.azimuth);
      expect(hovering, 'the finger is still the camera\'s').toMatchObject({ cameraTouches: 1, controlPointers: 1 });
      await stylus.down(over[0], over[1]);
      for (let i = 13; i <= 18; i++) {
        await finger.move([[x + i * 8, y, 0]]);
        await pause(page, 20);
      }
      const pressed = await viewState(page);
      expect(pressed.azimuth, 'and under a pen that is pressed').not.toBe(hovering.azimuth);
      // A second touch now is the hand, not a pinch.
      await finger.start([[x + 144, y, 0], [p.cx, p.cy, 1]]);
      for (let i = 1; i <= 6; i++) {
        await finger.move([[x + 144, y, 0], [p.cx + i * 10, p.cy, 1]]);
        await pause(page, 20);
      }
      const palmed = await viewState(page);
      expect(palmed, 'the hand is not a second finger').toMatchObject({ cameraTouches: 1, controlPointers: 1 });
      expect(palmed.distance, 'so nothing zoomed').toBeCloseTo(pressed.distance, 1);
      await stylus.up(over[0], over[1]);
      await finger.end();
      await pause(page, 200);
      expect(await viewState(page), 'nothing is left pressed').toMatchObject({ drag: null, cameraTouches: 0, controlPointers: 0 });
      expect(await penWatch(page)).toMatchObject({ down: false, palms: 0 });
      expect(await positions(page), 'the object the hand lay on did not move').toEqual(at);
    });

    test('a finger already dragging an object goes on when the pen arrives', async ({ page }) => {
      const { cx, cy } = p;
      const at = await positions(page);
      await finger.start([[cx, cy, 0]]);
      await pause(page, 60);
      for (let i = 1; i <= 5; i++) {
        await finger.move([[cx + i * 8, cy, 0]]);
        await pause(page, 20);
      }
      expect((await viewState(page)).drag).toBe('move');
      const part = await positions(page);
      await stylus.hover(over[0], over[1]);
      for (let i = 6; i <= 10; i++) {
        await finger.move([[cx + i * 8, cy, 0]]);
        await pause(page, 20);
      }
      expect((await viewState(page)).drag, 'still the move').toBe('move');
      await finger.end();
      await pause(page, 200);
      const end = await positions(page);
      expect(part, 'the object had moved before the pen came').not.toEqual(at);
      expect(end, 'and went on moving under it').not.toEqual(part);
    });

    test('touches count again a moment after the pen has left, and not before', async ({ page }) => {
      await stylus.hover(over[0], over[1]);
      await stylus.down(over[0], over[1]);
      await stylus.up(over[0], over[1]);
      await stylus.leave();
      expect(await penWatch(page), 'the pen is heard to leave').toMatchObject({ down: false, near: false });
      // At once: the hand often lifts after the pen, and comes down again as it does.
      await tapWith(page, [[p.cx, p.cy]], 20);
      await pause(page, 100);
      expect(await selection(page), 'a tap inside the grace period selects nothing').toHaveLength(0);
      await pause(page, PALM_GRACE);
      await tapWith(page, [[p.cx, p.cy]]);
      await expect.poll(() => selection(page), 'a tap after it selects').toHaveLength(1);
    });

    test('a pen that lifts and says no more is taken as gone after the grace period', async ({ page }) => {
      await stylus.hover(over[0], over[1]);
      await stylus.down(over[0], over[1]);
      await stylus.up(over[0], over[1]);
      await pause(page, PALM_GRACE + 150);
      const before = await viewState(page);
      await swipe(page, empty);
      expect((await viewState(page)).azimuth, 'a finger turns the camera again').not.toBe(before.azimuth);
      await finger.end();
    });

    test('a hand that was resting when the pen left stays ignored until it lifts, and a finger beside it counts', async ({ page }) => {
      await stylus.hover(over[0], over[1]);
      await finger.start([[empty[0], empty[1], 0]]);
      expect(await penWatch(page)).toMatchObject({ palms: 1 });
      await stylus.leave();
      expect(await penWatch(page), 'the pen is heard to leave, and the hand stays what it was').toMatchObject({ near: false, palms: 1 });
      await pause(page, PALM_GRACE + 150);
      const view = await camera(page);
      for (let i = 1; i <= 6; i++) {
        await finger.move([[empty[0] + i * 8, empty[1], 0]]);
        await pause(page, 20);
      }
      expect(await camera(page), 'the resting hand does not turn the camera by sliding').toEqual(view);
      // A finger of the other hand taps the object.
      await finger.start([[empty[0] + 48, empty[1], 0], [p.cx, p.cy, 1]]);
      await pause(page, 40);
      await finger.end([[p.cx, p.cy, 1]]);
      await expect.poll(() => selection(page), 'the finger selects').toHaveLength(1);
      expect(await penWatch(page), 'the hand is still down, and still ignored').toMatchObject({ palms: 1 });
      await finger.end();
      expect(await penWatch(page)).toMatchObject({ palms: 0 });
    });
  });
});
