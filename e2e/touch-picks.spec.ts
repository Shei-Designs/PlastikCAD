// A finger on a handle takes that handle. A finger is given room round the grips (they are small to the eye), and
// that room once decided for it: the three align dots at a corner lie over one another when grown, and a corner
// grip lies over the turn arrow beside it, so that a finger dead on one took another.
import { expect, fitView, handlePoints, handleUnder, openApp, settled, store, test } from './helpers';

test.describe('a finger on a handle', { tag: '@touch' }, () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('takes the align dot it is on, of the three at a corner', async ({ page }) => {
    await store(page, (m) => {
      m.addShape('box');
      m.addShape('cylinder');
      m.nudgeSelected([50, 10, 5]);
      m.selectAll();
      m.toggleAligning();
    });
    await settled(page);
    await fitView(page);
    const dots = (await handlePoints(page)).filter((h) => h.kind.type === 'align');
    expect(dots.length).toBeGreaterThanOrEqual(9);
    for (const dot of dots) expect(await handleUnder(page, dot.at[0], dot.at[1]), `the dot at ${dot.at.map(Math.round)}`).toEqual(dot.kind);
    // And a real tap on the one for the fronts brings the fronts in line, not the left sides.
    const front = dots.find((d) => d.kind.axis === 1 && d.kind.mode === 'min')!;
    const before = await store(page, (m) => m.getState().doc.scene.map((n) => n.pos));
    await page.touchscreen.tap(front.at[0], front.at[1]);
    await settled(page);
    const after = await store(page, (m) => m.getState().doc.scene.map((n) => n.pos));
    expect(after.map((p) => p[0])).toEqual(before.map((p) => p[0]));
    expect(after.map((p) => p[1])).not.toEqual(before.map((p) => p[1]));
  });

  test('takes the turn arrow where it is on the arrow, close to a corner grip as that is', async ({ page }) => {
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    await fitView(page);
    const all = await handlePoints(page);
    const grips = all.filter((h) => h.kind.type !== 'rotate');
    const near = (p: [number, number]): number => Math.min(...grips.map((g) => Math.hypot(g.at[0] - p[0], g.at[1] - p[1])));
    // Places on the drawn arrows that are inside the room a finger is given round a grip, and clear of the grip as drawn.
    const places = all.filter((h) => h.kind.type === 'rotate').flatMap((h) => h.drawn.filter((p) => near(p) > 11 && near(p) < 22).map((at) => ({ kind: h.kind, at })));
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) expect((await handleUnder(page, place.at[0], place.at[1]))?.type, `at ${place.at.map(Math.round)}`).toBe('rotate');
    // Beside a grip and on nothing drawn, the finger still gets the grip: that is what the room is for.
    const grip = grips[0];
    expect(await handleUnder(page, grip.at[0] + 9, grip.at[1] - 9)).not.toBeNull();
    // A mouse is given no room: it takes what it is on.
    expect((await handleUnder(page, places[0].at[0], places[0].at[1], 'mouse'))?.type).toBe('rotate');
  });
});
