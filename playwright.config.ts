// The browser tests in e2e/: the app in Chromium, driven with a mouse and keyboard at a desktop
// size and with fingers at a tablet size. `pnpm e2e` builds the app for them and serves that build.
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
  // press): a few workers, not one per core, and on the CI runners no more workers than their two cores.
  workers: CI ? 2 : 4,
  forbidOnly: CI,
  // No test is tried twice, here or on CI: one that fails now and then says nothing when it fails, so a test must
  // pass on a slow machine for the same reason it passes on a fast one (see `stopClock` in e2e/helpers.ts for how
  // the timed gestures do).
  retries: 0,
  timeout: 60_000,
  // The CI runners draw in software on few cores: what takes a moment here can take several there.
  expect: { timeout: CI ? 20_000 : 5_000 },
  reporter: CI ? [['github'], ['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]] : [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    // A click waits for the page to answer. On a CI runner the page stops answering for some ten seconds after it
    // loads, while the picture is drawn in software for the first time (a trace of a failed run shows 10.6 s with
    // no frame, and 9.6 s for the first load): a limit of ten seconds failed a click made right after a reload
    // whenever that took a little longer. The limit there is well clear of it; a test still has its minute.
    actionTimeout: CI ? 30_000 : 10_000,
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
    // The tests run against the app as it is built, served as plain files: every page of every test loads a few
    // bundled files instead of the hundreds of modules the dev server hands out one by one, which is what made the
    // suite slow, and its timing a matter of luck, on a machine with few cores. The build is made for the tests
    // (`--mode e2e` puts the hook they reach the app through into it) and made afresh for every run. The root is
    // named, so nothing depends on where the command is run from.
    command: `pnpm exec vite build "${root}" --mode e2e --outDir e2e-dist --emptyOutDir && pnpm exec vite preview "${root}" --outDir e2e-dist --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
