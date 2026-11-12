// Inches as the working unit: chosen in File → Units…, every length the app shows and takes is in
// inches from then on, while the design stays in millimeters. What a standard lays down in
// millimeters (a gear's module) stays so, and back in millimeters everything reads as it did.
import type { Locator, Page } from '@playwright/test';
import { expect, fitView, handlePoints, measureOverlay, openApp, plateGrid, sceneIds, screenPoint, settled, started, store, tap, test, withoutKeyboard } from './helpers';

const fileMenu = (page: Page, name = 'File'): Locator => page.locator('.file-bar').getByRole('button', { name, exact: true });
const unitsBox = (page: Page): Locator => page.locator('dialog.units[open]');

/** Opens File → Units… and picks a unit there; the box closes on the choice. */
async function chooseUnits(page: Page, name: 'Millimeters' | 'Inches'): Promise<void> {
  await fileMenu(page).click();
  await page.getByRole('menu').getByText('Units…').click();
  await unitsBox(page).getByRole('menuitemradio', { name }).click();
  await expect(unitsBox(page)).toHaveCount(0);
}

/** A number box of the Dimensions box, and the unit written in it. */
const dimension = (page: Page, label: string): Locator => page.locator(`.transform-box input[aria-label="${label}"]`);
const unitOf = (box: Locator): Locator => box.locator('xpath=..').locator('.unit');
/** A number box of a part's or shape's settings, by its label. */
const setting = (page: Page, label: string): Locator => page.locator(`.inspector input[type="text"][aria-label="${label}"]`);

const size = (page: Page): Promise<number[]> => store(page, (m) => [...m.getState().doc.scene[0].size]);
const prefs = (page: Page): Promise<{ units: string; snap: number }> => store(page, (m) => ({ units: m.getState().prefs.units, snap: m.getState().prefs.snap }));
const snapOptions = (page: Page): Promise<string[]> => page.locator('.view-toolbar .chip.select select option').allTextContents();

/** Types a value over what a box holds, and has it taken. */
async function type(page: Page, box: Locator, text: string): Promise<void> {
  await box.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('inches as the working unit', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    // A box 20 mm each way, selected.
    await store(page, (m) => m.addShape('box'));
    await settled(page);
  });

  test('the app starts in millimeters, which the Units box marks', async ({ page }) => {
    expect(await prefs(page)).toEqual({ units: 'mm', snap: 1 });
    await expect(dimension(page, 'Width (X)')).toHaveValue('20');
    await fileMenu(page).click();
    await page.getByRole('menu').getByText('Units…').click();
    await expect(unitsBox(page).getByRole('menuitemradio', { name: 'Millimeters' })).toHaveAttribute('aria-checked', 'true');
    await expect(unitsBox(page).getByRole('menuitemradio', { name: 'Inches' })).toHaveAttribute('aria-checked', 'false');
    await unitsBox(page).getByRole('button', { name: 'Close' }).click();
    await expect(unitsBox(page)).toHaveCount(0);
    expect((await prefs(page)).units, 'closing the box chooses nothing').toBe('mm');
  });

  test('Inches chosen in the Units box puts the Dimensions box in inches', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    for (const label of ['Width (X)', 'Depth (Y)', 'Height (Z)']) {
      await expect(dimension(page, label)).toHaveValue('0.7874');
      await expect(unitOf(dimension(page, label))).toHaveText('in');
    }
    // The box stands on the plate, in the middle of it.
    await expect(dimension(page, 'Height above the plate')).toHaveValue('0');
    await expect(unitOf(dimension(page, 'Height above the plate'))).toHaveText('in');
    await expect(unitOf(dimension(page, 'Rotation about Z')), 'an angle is no length').toHaveText('°');
    expect(await size(page), 'the design is as it was').toEqual([20, 20, 20]);
    // The box marks the unit in use.
    await fileMenu(page).click();
    await page.getByRole('menu').getByText('Units…').click();
    await expect(unitsBox(page).getByRole('menuitemradio', { name: 'Inches' })).toHaveAttribute('aria-checked', 'true');
  });

  test('a size typed in inches is kept in millimeters', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    await type(page, dimension(page, 'Width (X)'), '1');
    await expect.poll(() => size(page)).toEqual([25.4, 20, 20]);
    await expect(dimension(page, 'Width (X)')).toHaveValue('1');
    // A comma is read as the decimal point, as in millimeters.
    await type(page, dimension(page, 'Depth (Y)'), '0,5');
    await expect.poll(() => size(page)).toEqual([25.4, 12.7, 20]);
    await expect(dimension(page, 'Depth (Y)')).toHaveValue('0.5');
  });

  test('a box left as it reads changes nothing: what it shows is rounded', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    // 30 mm reads 1.1811 in, which is 29.99994 mm: Enter on it, or leaving the box, must not make the object that.
    await store(page, (m) => m.updateSelected((n) => ({ ...n, size: [30, 30, 30] })));
    await expect(dimension(page, 'Width (X)')).toHaveValue('1.1811');
    await dimension(page, 'Width (X)').click();
    await page.keyboard.press('Enter');
    await dimension(page, 'Depth (Y)').click();
    await page.keyboard.press('Tab');
    // A value typed afterwards is in once these are: boxes are taken in order.
    await type(page, dimension(page, 'Height (Z)'), '2');
    await expect.poll(() => size(page)).toEqual([30, 30, 50.8]);
  });

  test('an arrow key steps a twentieth of an inch', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    await dimension(page, 'Width (X)').click();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => size(page)).toEqual([21.27, 20, 20]);
    await expect(dimension(page, 'Width (X)')).toHaveValue('0.8374');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => size(page)).toEqual([8.57, 20, 20]);
    await expect(dimension(page, 'Width (X)')).toHaveValue('0.3374');
  });

  test('several objects selected give their overall size in inches', async ({ page }) => {
    await store(page, (m) => {
      m.addShape('box');
      m.nudgeSelected([30.8, 0, 0]);
      m.selectAll();
    });
    await settled(page);
    await expect(page.locator('.transform-facts')).toHaveText('50.8 × 20 × 20 mm');
    await chooseUnits(page, 'Inches');
    await expect(page.locator('.transform-facts')).toHaveText('2 × 0.7874 × 0.7874 in');
    await store(page, (m) => m.select([]));
    await expect(page.locator('.inspector .facts', { hasText: 'Overall size' })).toContainText('2 × 0.787 × 0.787 in');
  });

  test('a gear\'s face width shows and takes inches, its module stays in millimeters', async ({ page }) => {
    // A part is built anew before it takes its figures: seconds, on a machine with much else to do.
    const built = { timeout: 30_000 };
    const params = (): Promise<Record<string, unknown>> => store(page, (m) => ({ ...(m.getState().doc.scene[1] as { params: Record<string, unknown> }).params }));
    await store(page, (m) => m.addPart('gears'));
    await settled(page);
    await chooseUnits(page, 'Inches');
    // 10 mm wide, module 2.
    await expect(setting(page, 'Face width')).toHaveValue('0.3937');
    await expect(unitOf(setting(page, 'Face width'))).toHaveText('in');
    await expect(setting(page, 'Module')).toHaveValue('2');
    await expect(unitOf(setting(page, 'Module'))).toHaveText('mm');
    // The slider's track is the one it has in millimeters.
    const track = setting(page, 'Face width').locator('xpath=../..').locator('input[type="range"]');
    await expect(track).toHaveAttribute('min', '1');
    await expect(track).toHaveAttribute('max', '200');
    await expect(track).toHaveAttribute('step', '0.5');

    await type(page, setting(page, 'Face width'), '0.5');
    await expect.poll(async () => (await params()).faceWidth, built).toBe(12.7);
    await type(page, setting(page, 'Module'), '3');
    await expect.poll(async () => (await params()).module, built).toBe(3);
    await expect(setting(page, 'Face width')).toHaveValue('0.5');

    // The figures the gear works out: its diameters in inches, 20 teeth of module 3 being 60 mm across.
    await page.locator('.transform-dims-toggle').click();
    const figures = page.locator('.transform-dims .facts');
    await expect(figures.locator('div', { hasText: 'Pitch diameter' }).locator('dd')).toHaveText('2.3622 in');
    await chooseUnits(page, 'Millimeters');
    await expect(figures.locator('div', { hasText: 'Pitch diameter' }).locator('dd')).toHaveText('60.00 mm');
    await expect(setting(page, 'Face width')).toHaveValue('12.7');
    await expect(unitOf(setting(page, 'Face width'))).toHaveText('mm');
  });

  test('the snap steps are fractions of an inch, and the step moves to the nearest', async ({ page }) => {
    expect(await snapOptions(page)).toEqual(['Off', '0.1 mm', '0.25 mm', '0.5 mm', '1 mm', '2 mm', '5 mm', '10 mm']);
    const snap = page.locator('.view-toolbar .chip.select select');
    await snap.selectOption({ label: '5 mm' });
    await chooseUnits(page, 'Inches');
    expect(await snapOptions(page)).toEqual(['Off', '1/32 in', '1/16 in', '1/8 in', '1/4 in', '1/2 in', '1 in']);
    // 5 mm is nearest to a quarter of an inch, 6.35 mm.
    expect((await prefs(page)).snap).toBe(6.35);
    await expect(snap.locator('option:checked')).toHaveText('1/4 in');
    await snap.selectOption({ label: '1/2 in' });
    expect((await prefs(page)).snap, 'the step is kept in millimeters').toBe(12.7);
    await chooseUnits(page, 'Millimeters');
    expect((await prefs(page)).snap).toBe(10);
    await expect(snap.locator('option:checked')).toHaveText('10 mm');
    // No snapping stays no snapping.
    await snap.selectOption({ label: 'Off' });
    await chooseUnits(page, 'Inches');
    expect((await prefs(page)).snap).toBe(0);
    await expect(snap.locator('option:checked')).toHaveText('Off');
  });

  test('the ruler measures in inches', async ({ page }) => {
    const [box] = await sceneIds(page);
    await store(
      page,
      (m, node) => {
        m.select([]);
        m.toggleMeasuring();
        // Two corners of nothing in particular, an inch apart along X and the box's height apart along Z.
        m.pickMeasure({ kind: 'point', node, at: [-10, -10, 0] });
        m.pickMeasure({ kind: 'point', node, at: [15.4, -10, 20] });
      },
      box,
    );
    const result = page.locator('.measure-result');
    await expect(result).toHaveText('Distance 32.33 mm · X 25.4 mm · Z 20 mm');
    await chooseUnits(page, 'Inches');
    await expect(result).toHaveText('Distance 1.2728 in · X 1 in · Z 0.7874 in');
    await expect.poll(async () => (await measureOverlay(page)).label, { message: 'the figure is on the line' }).toBe(true);
    await chooseUnits(page, 'Millimeters');
    await expect(result).toHaveText('Distance 32.33 mm · X 25.4 mm · Z 20 mm');
  });

  test('the grid\'s lines fall on inches', async ({ page }) => {
    expect(await plateGrid(page)).toEqual({ half: 100, major: 10 });
    await chooseUnits(page, 'Inches');
    // Ten inches square, a heavy line every inch.
    await expect.poll(() => plateGrid(page)).toEqual({ half: 127, major: 25.4 });
    await chooseUnits(page, 'Millimeters');
    await expect.poll(() => plateGrid(page)).toEqual({ half: 100, major: 10 });
  });

  test('the grid goes to feet and to yards under a large design, to meters in millimeters', async ({ page }) => {
    const heavy = (): Promise<number> => plateGrid(page).then((grid) => grid.major);
    const wide = (width: number): Promise<void> => store(page, (m, width) => m.updateNode(m.getState().doc.scene[0].id, { size: [width, 20, 20] }), width);
    // Two meters wide: a heavy line every 100 mm, or every foot.
    await wide(2000);
    await expect.poll(heavy).toBe(100);
    await chooseUnits(page, 'Inches');
    await expect.poll(heavy).toBe(304.8);
    // Twenty meters wide: every yard, or every meter.
    await wide(20_000);
    await expect.poll(heavy).toBe(914.4);
    await chooseUnits(page, 'Millimeters');
    await expect.poll(heavy).toBe(1000);
  });

  test('a warning about a length the user set reads in inches', async ({ page }) => {
    const built = { timeout: 30_000 };
    await store(page, async (m) => {
      await m.addPart('gears');
      await m.editPart(m.getState().doc.scene[1].id, { params: { module: 0.5, backlash: 1 } });
    });
    await settled(page);
    const note = page.locator('.inspector-notes');
    await expect(note).toContainText('Backlash was limited to 0.63 mm so the teeth keep two flanks.', built);
    await chooseUnits(page, 'Inches');
    await expect(note).toContainText('Backlash was limited to 0.0247 in so the teeth keep two flanks.');
  });

  test('the choice is kept when the app starts again', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    await page.reload();
    await started(page);
    expect(await prefs(page)).toEqual({ units: 'in', snap: 0.79375 });
    expect(await snapOptions(page)).toContain('1/32 in');
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    await expect(dimension(page, 'Width (X)')).toHaveValue('0.7874');
    await expect(unitOf(dimension(page, 'Width (X)'))).toHaveText('in');
  });

  test('back in millimeters everything reads as it did', async ({ page }) => {
    await chooseUnits(page, 'Inches');
    await type(page, dimension(page, 'Width (X)'), '1');
    await expect.poll(() => size(page)).toEqual([25.4, 20, 20]);
    await chooseUnits(page, 'Millimeters');
    expect(await prefs(page)).toEqual({ units: 'mm', snap: 1 });
    await expect(dimension(page, 'Width (X)')).toHaveValue('25.4');
    await expect(dimension(page, 'Depth (Y)')).toHaveValue('20');
    // Millimeters go unsaid in the Dimensions box, as they always have.
    await expect(page.locator('.transform-box .unit')).toHaveText(['°', '°', '°']);
    expect(await snapOptions(page)).toEqual(['Off', '0.1 mm', '0.25 mm', '0.5 mm', '1 mm', '2 mm', '5 mm', '10 mm']);
    await type(page, dimension(page, 'Width (X)'), '30');
    await expect.poll(() => size(page)).toEqual([30, 20, 20]);
    await store(page, (m) => m.select([]));
    await expect(page.locator('.inspector .facts', { hasText: 'Overall size' })).toContainText('30 × 20 × 20 mm');
  });

  test('a grip clicked takes its size in inches', { tag: '@mouse' }, async ({ page }) => {
    await fitView(page);
    await chooseUnits(page, 'Inches');
    const grip = (await handlePoints(page)).find((h) => h.kind.type === 'height' && h.kind.side === 1)!;
    await page.mouse.click(grip.at[0], grip.at[1]);
    const height = page.locator('.prompt-boxes input[aria-label="Height"]');
    await expect(height).toHaveValue('0.7874');
    await expect(page.locator('.prompt-boxes .unit')).toHaveText('in');
    await expect(height).toBeFocused();
    await page.keyboard.type('1.5');
    await page.keyboard.press('Enter');
    await expect.poll(() => size(page)).toEqual([20, 20, 38.1]);
  });

  test('a corner grip takes the size typed and leaves the one that was not as it is', { tag: '@mouse' }, async ({ page }) => {
    // 30 mm reads 1.1811 in, which is 29.99994 mm.
    await store(page, (m) => m.updateSelected((n) => ({ ...n, size: [30, 30, 20] })));
    await settled(page);
    await fitView(page);
    await chooseUnits(page, 'Inches');
    const grip = (await handlePoints(page)).find((h) => h.kind.type === 'resize' && h.kind.sx === 1 && h.kind.sy === 1)!;
    await page.mouse.click(grip.at[0], grip.at[1]);
    const width = page.locator('.prompt-boxes input[aria-label="Width"]');
    await expect(width).toBeFocused();
    await expect(page.locator('.prompt-boxes input[aria-label="Depth"]')).toHaveValue('1.1811');
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await expect.poll(() => size(page)).toEqual([50.8, 30, 20]);
  });

  test('the readout of a drag is in inches', { tag: '@mouse' }, async ({ page }) => {
    await store(page, (m) => {
      m.setUnits('in');
      // A quarter of an inch.
      m.setPrefs({ snap: 6.35 });
      m.select([]);
    });
    await fitView(page);
    const [x, y] = await screenPoint(page, [0, 0, 20]);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 8, y);
    await page.mouse.move(x + 90, y, { steps: 6 });
    const readout = page.locator('.viewport > .readout');
    await expect(readout).toBeVisible();
    const moved = (await readout.textContent())!.split(', ').map(Number);
    await page.mouse.up();
    const at = await store(page, (m) => [...m.getState().doc.scene[0].pos]);
    expect(at[0], 'the box moved').not.toBe(0);
    // The figures are the move in inches: quarters, as the step is.
    expect(moved).toEqual([at[0], at[1]].map((v) => Number((v / 25.4).toFixed(4))));
    for (const v of moved) expect(Number.isInteger(v * 4), `${v} is a whole number of quarters`).toBe(true);
  });

  test('the entry sheet shows and takes inches', { tag: '@touch' }, async ({ page }) => {
    await withoutKeyboard(page);
    await chooseUnits(page, 'Inches');
    await tap(dimension(page, 'Width (X)'));
    const sheet = page.locator('.touch-entry');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.touch-entry-now')).toHaveText('now 0.7874 in');
    await expect(sheet.locator('.touch-entry-unit')).toHaveText('in');
    await page.locator('#touch-entry-box').fill('2');
    await tap(sheet.locator('.touch-entry-buttons .primary'));
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => size(page)).toEqual([50.8, 20, 20]);
    await expect(dimension(page, 'Width (X)')).toHaveValue('2');
    // Done on a sheet left empty keeps the value.
    await tap(dimension(page, 'Depth (Y)'));
    await expect(sheet).toBeVisible();
    await tap(sheet.locator('.touch-entry-buttons .primary'));
    await expect(sheet).toHaveCount(0);
    expect(await size(page)).toEqual([50.8, 20, 20]);
  });
});

test.describe('inches on a device set to French', () => {
  test.use({ locale: 'fr-FR' });

  test('the Units box and the unit are in French', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => m.addShape('box'));
    await settled(page);
    await fileMenu(page, 'Fichier').click();
    await page.getByRole('menu').getByText('Unités…').click();
    await expect(unitsBox(page).locator('h2')).toHaveText('Unités');
    await expect(unitsBox(page).getByRole('menuitemradio')).toHaveText(['Millimètres', 'Pouces']);
    await unitsBox(page).getByRole('menuitemradio', { name: 'Pouces' }).click();
    await expect(unitsBox(page)).toHaveCount(0);
    await expect(dimension(page, 'Largeur (X)')).toHaveValue('0.7874');
    await expect(unitOf(dimension(page, 'Largeur (X)'))).toHaveText('po');
    expect(await snapOptions(page)).toContain('1/4 po');
  });
});
