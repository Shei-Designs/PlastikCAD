// The browser tests in e2e/: the app in Chromium, driven with a mouse and keyboard at a desktop
// size and with fingers at a tablet size. `pnpm e2e` runs them against a Vite server of their own.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
// Not 1430: that port is `pnpm dev` and `pnpm tauri dev`, which may be running.
const PORT = 1440;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-results',
  // Every test gets a browser context of its own, so its projects (IndexedDB) and preferences
  // (localStorage) start empty and go when it ends: tests can run side by side and in any order.
  fullyParallel: true,
  // The view is drawn in software, and the gesture tests are timed (a finger held still is a long
  // press): a few workers, not one per core.
  workers: 4,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  // The CI runners draw in software on few cores: what takes a moment here can take several there.
  expect: { timeout: CI ? 20_000 : 5_000 },
  reporter: CI ? [['github'], ['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]] : [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    launchOptions: {
      // WebGL without a GPU: ANGLE on SwiftShader, which headless Chromium otherwise refuses.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    // A mouse and a keyboard. Tests tagged @touch need fingers.
    { name: 'desktop', grepInvert: /@touch/, use: { browserName: 'chromium', viewport: { width: 1400, height: 900 } } },
    // A tablet held sideways: fingers, so `(pointer: coarse)` matches. Tests tagged @mouse need a mouse.
    { name: 'tablet', grepInvert: /@mouse/, use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, hasTouch: true } },
  ],
  webServer: {
    // The root is named, so the server does not depend on where the command is run from.
    command: `pnpm exec vite "${root}" --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
