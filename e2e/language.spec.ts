// The app in another language: it follows the device, the Language box overrides that, and a
// change of language starts the app again with the design as it was.
import type { Page } from '@playwright/test';
import { expect, openApp, sceneCount, settled, started, store, test } from './helpers';

const fileMenu = (page: Page, name: string) => page.locator('.file-bar').getByRole('button', { name, exact: true });

test.describe('on a device set to French', () => {
  test.use({ locale: 'fr-FR' });

  test('the app opens in French, and says so to the browser', async ({ page }) => {
    await openApp(page);
    await expect(fileMenu(page, 'Fichier')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('English chosen in the Language box is kept over the device\'s French', async ({ page }) => {
    await openApp(page);
    await fileMenu(page, 'Fichier').click();
    await page.getByRole('menu').getByText('Langue…').click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    // The app starts again.
    await expect(fileMenu(page, 'File')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(fileMenu(page, 'File')).toBeVisible();
  });
});

test.describe('on a device set to English', () => {
  test('the app opens in English', async ({ page }) => {
    await openApp(page);
    await expect(fileMenu(page, 'File')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('French chosen in the Language box starts the app again in French, with the design as it was', async ({ page }) => {
    await openApp(page);
    await store(page, (m) => {
      m.addShape('box');
      m.addShape('cylinder');
    });
    await settled(page);
    await fileMenu(page, 'File').click();
    await page.getByRole('menu').getByText('Language…').click();
    const box = page.locator('dialog.language[open]');
    await expect(box.getByRole('menuitemradio', { name: 'Same as this device' })).toHaveAttribute('aria-checked', 'true');
    await box.getByRole('menuitemradio', { name: 'Français' }).click();
    await expect(fileMenu(page, 'Fichier')).toBeVisible();
    await started(page);
    await settled(page);
    expect(await sceneCount(page), 'the design came back').toBe(2);
    // The box now marks the language chosen, and going back to the device's is one press.
    await fileMenu(page, 'Fichier').click();
    await page.getByRole('menu').getByText('Langue…').click();
    await expect(page.locator('dialog.language[open]').getByRole('menuitemradio', { name: 'Français' })).toHaveAttribute('aria-checked', 'true');
    await page.locator('dialog.language[open]').getByRole('menuitemradio', { name: 'Celle de l’appareil' }).click();
    await expect(fileMenu(page, 'File')).toBeVisible();
  });

  test('the language in use picked again changes nothing and closes the box', async ({ page }) => {
    await openApp(page);
    await fileMenu(page, 'File').click();
    await page.getByRole('menu').getByText('Language…').click();
    await page.locator('dialog.language[open]').getByRole('menuitemradio', { name: 'Same as this device' }).click();
    await expect(page.locator('dialog.language[open]')).toHaveCount(0);
    await expect(fileMenu(page, 'File')).toBeVisible();
  });
});
