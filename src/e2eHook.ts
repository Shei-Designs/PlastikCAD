// What the browser tests reach the app through when it runs as a built
// bundle. On the dev server they import the app's modules by address; a build
// has no such addresses, so the modules they use are put on the window here.
// This file is only loaded by a build made for the tests (`vite build --mode
// e2e`): no other build carries it.
import * as appInfo from './appInfo';
import * as exporting from './io/export';
import * as threemf from './io/threemf';
import * as projects from './state/projects';
import * as store from './state/store';
import * as inputMode from './ui/inputMode';
import * as viewport from './ui/Viewport';

/** The modules, under the paths the tests know them by on the dev server. */
const modules: Record<string, unknown> = {
  '/src/appInfo.ts': appInfo,
  '/src/io/export.ts': exporting,
  '/src/io/threemf.ts': threemf,
  '/src/state/projects.ts': projects,
  '/src/state/store.ts': store,
  '/src/ui/inputMode.ts': inputMode,
  '/src/ui/Viewport.tsx': viewport,
};

(window as unknown as { __plastikcadModules?: Record<string, unknown> }).__plastikcadModules = modules;
