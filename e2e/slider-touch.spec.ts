// A slider under a finger. It takes a touch anywhere on its track, so a finger on its way up the panel that
// happened to land on one set its value: a swipe to scroll made a gear fifteen times as wide. A finger that moves
// up or down is the panel's; one that moves sideways, or taps, is the slider's.
import type { Page } from '@playwright/test';
import { expect, fingers, openApp, settled, store, test } from './helpers';

test.describe('a slider under a finger', { tag: '@touch' }, () => {
  // Short enough that a gear's settings do not all fit: the panel scrolls.
  test.use({ viewport: { width: 1280, height: 520 } });

  // A part is built anew before it takes its figures: seconds, on a machine with much else to do.
  const built = { timeout: 30_000 };
  const width = (page: Page): Promise<number> => store(page, (m) => Number((m.getState().doc.scene[0] as { params: Record<string, unknown> }).params.faceWidth));
  /** The Face width slider: where it is on the page, and how far the panel that holds it has been scrolled. */
  const slider = (page: Page): Promise<{ x: number; y: number; w: number; scrolled: number }> =>
    page.evaluate(() => {
      const field = [...document.querySelectorAll('.inspector .field')].find((f) => f.querySelector('label')?.textContent?.startsWith('Face width'))!;
      const range = field.querySelector('input[type=range]')!;
      const r = range.getBoundingClientRect();
      let panel: Element | null = range;
      while (panel && !(panel.scrollHeight > panel.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(panel).overflowY))) panel = panel.parentElement;
      return { x: r.left, y: r.top + r.height / 2, w: r.width, scrolled: panel ? panel.scrollTop : -1 };
    });

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addPart('gears'));
    await settled(page);
    await page.evaluate(() => [...document.querySelectorAll('.inspector .field')].find((f) => f.querySelector('label')?.textContent?.startsWith('Face width'))!.scrollIntoView({ block: 'end' }));
  });

  test('a swipe up that begins on the slider scrolls the panel and leaves the value alone', async ({ page }) => {
    const before = await width(page);
    const at = await slider(page);
    const touch = await fingers(page);
    // Well along the track, where a touch would set a much larger value.
    const x = at.x + at.w * 0.8;
    await touch.swipe([x, at.y], [x + 1, at.y - 96]);
    await expect.poll(async () => (await slider(page)).scrolled, { message: 'the panel has scrolled' }).toBeGreaterThan(at.scrolled);
    // A part takes its new figures a moment after they are given, one change at a time: once a change made after
    // the swipe is in, anything the swipe gave is in too.
    await store(page, (m) => void m.editPart(m.getState().doc.scene[0].id, { params: { teeth: 31 } }));
    await expect.poll(() => store(page, (m) => Number((m.getState().doc.scene[0] as { params: Record<string, unknown> }).params.teeth)), built).toBe(31);
    expect(await width(page)).toBe(before);
  });

  test('a finger dragged sideways along it sets the value as it goes', async ({ page }) => {
    const before = await width(page);
    const at = await slider(page);
    const touch = await fingers(page);
    const x = at.x + at.w * 0.15;
    await touch.start([[x, at.y, 0]]);
    for (let dx = 6; dx <= 48; dx += 6) await touch.move([[x + dx, at.y + 1, 0]]);
    await touch.end();
    await expect.poll(() => width(page), { message: 'the gear is wider', ...built }).toBeGreaterThan(before);
    expect((await slider(page)).scrolled).toBe(at.scrolled);
  });

  test('a tap on the track sets the value there', async ({ page }) => {
    const before = await width(page);
    const at = await slider(page);
    const touch = await fingers(page);
    await touch.tap(at.x + at.w * 0.25, at.y);
    await expect.poll(() => width(page), { message: 'the gear is wider', ...built }).toBeGreaterThan(before);
  });
});
