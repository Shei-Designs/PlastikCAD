// What the browser tests share: opening the app, calling the store, fingers on the screen, and
// every look into the viewer's private parts. The viewer does not export what the tests read
// (the press in progress, the drawn objects, the handle frame, the measure overlay), so each such
// field is read in one named function here: a rename in src/viewer is one edit in this file.
import { test as base, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export { expect };

type Store = typeof import('../src/state/store');
type InputMode = typeof import('../src/ui/inputMode');
type Projects = typeof import('../src/state/projects');
type Vec3 = [number, number, number];
/** The viewer as the page has it, private fields and all, and whatever else is reached into untyped. */
type Internals = any;

const STORE = '/src/state/store.ts';
const VIEWPORT = '/src/ui/Viewport.tsx';
const INPUT_MODE = '/src/ui/inputMode.ts';
const PROJECTS = '/src/state/projects.ts';
const APP_INFO = '/src/appInfo.ts';
const EXPORT = '/src/io/export.ts';
const THREEMF = '/src/io/threemf.ts';

/** Messages of the software GL driver, which say nothing about the app. */
const DRIVER_NOISE = /GPU stall|GL Driver Message/;

export const test = base.extend<{ errors: string[] }>({
  // Page errors and console errors and warnings, for the tests that say there were none.
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !DRIVER_NOISE.test(m.text())) errors.push(`[${m.type()}] ${m.text()}`);
      });
      await use(errors);
    },
    { auto: true },
  ],
});

// --- the page -------------------------------------------------------------------

/**
 * Runs `fn` in the page with some of the app's modules. The tests run against a build of the app
 * made for them, which puts the modules they use on the window (src/e2eHook.ts). Against the dev
 * server the modules are imported instead: after a source file changes, Vite serves it under a
 * `?t=` address, and a plain import of the path would make a second copy of the module that the
 * app does not use, so the address the page itself loaded is looked up. `fn` goes over as its
 * source, so it can use nothing but its arguments.
 */
function withModules<R>(page: Page, paths: string[], fn: (...args: Internals[]) => unknown, arg?: unknown): Promise<R> {
  return page.evaluate(
    async ({ paths, source, arg }) => {
      const built = (window as Internals).__plastikcadModules as Record<string, unknown> | undefined;
      const loaded = performance.getEntriesByType('resource').map((e) => e.name);
      const address = (path: string): string => loaded.findLast((name) => new URL(name).pathname === path) ?? path;
      const served = document.querySelector('script[src*="/src/main.tsx"]') !== null;
      // A build whose hook has not loaded yet has nothing to give: the caller asks again.
      if (!built && !served) throw new Error('The app has not put its modules out for the tests yet.');
      const modules = built ? paths.map((path) => built[path]) : await Promise.all(paths.map((path) => import(/* @vite-ignore */ address(path))));
      return (0, eval)(`(${source})`)(...modules, arg) as R;
    },
    { paths, source: fn.toString(), arg },
  );
}

/** Runs `fn` in the page with the store, as the app's own code would call it. */
export function store<R, A = undefined>(page: Page, fn: (m: Store, arg: A) => R | Promise<R>, arg?: A): Promise<Awaited<R>> {
  return withModules(page, [STORE], fn, arg);
}

/** The same with the projects store as well, for the tests that look at what was saved. */
export function storeAndProjects<R, A = undefined>(page: Page, fn: (m: Store, p: Projects, arg: A) => R | Promise<R>, arg?: A): Promise<Awaited<R>> {
  return withModules(page, [STORE, PROJECTS], fn, arg);
}

/** What `viewer` runs in the page: the function it was given, on the viewer the Viewport holds. */
const VIEWER_CALL = (view: Internals, call: { source: string; arg: unknown }): unknown => (0, eval)(`(${call.source})`)(view.viewerRef.current, call.arg);

/** Runs `fn` in the page with the viewer. Only the named helpers below use it. */
function viewer<R, A = undefined>(page: Page, fn: (v: Internals, arg: A) => R | Promise<R>, arg?: A): Promise<Awaited<R>> {
  return withModules(page, [VIEWPORT], VIEWER_CALL, { source: fn.toString(), arg });
}

/** Opens the app and waits until it has started: the view is up and the projects store is open. */
export async function openApp(page: Page): Promise<void> {
  // The page loads more files from Vite than the browser remembers by default (see `withModules`).
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.goto('/');
  // The app answers once it has started; on the dev server the first load may also reload itself
  // once while Vite prepares the dependencies, which throws the question away. It is asked until
  // the app answers.
  await expect(async () => {
    await expect(page.locator('.canvas-host canvas')).toBeVisible();
    const ready = await withModules<boolean>(page, [STORE, VIEWPORT], (m: Store, view: Internals) => m.getState().storage !== null && view.viewerRef.current !== null);
    expect(ready).toBe(true);
  }).toPass({ timeout: 45_000 });
}

/** Waits a moment, for what has no state to wait on (a gesture between two touches, a click that must do nothing). */
export const pause = (page: Page, ms = 150): Promise<void> => page.waitForTimeout(ms);

/** Waits until every object of the design is built and drawn, and the frame after that is on screen. */
export async function settled(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const scene = await store(page, (m) => ({ n: m.getState().doc.scene.length, busy: m.getState().busy }));
        const drawn = await viewer(page, (v) => [...v.objects.drawn.values()].map((d: Internals) => Boolean(d.shown)));
        return scene.busy === null && drawn.length >= scene.n && drawn.every(Boolean);
      },
      { message: 'every object is built and drawn', timeout: 20_000 },
    )
    .toBe(true);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The on-screen entry sheet is used for number boxes, as on a tablet with no keyboard attached. */
export function withoutKeyboard(page: Page): Promise<void> {
  return withModules(page, [INPUT_MODE], (m: InputMode) => m.setInputState({ hardwareKeyboard: false, keypadVisible: false, keypadHeight: 0 }));
}

// --- the design -------------------------------------------------------------------

/** Where each object is, to three places. */
export const positions = (page: Page): Promise<number[][]> => store(page, (m) => m.getState().doc.scene.map((n) => n.pos.map((x) => +x.toFixed(3))));

export const selection = (page: Page): Promise<string[]> => store(page, (m) => m.getState().selection);

export const sceneIds = (page: Page): Promise<string[]> => store(page, (m) => m.getState().doc.scene.map((n) => n.id));

export const sceneCount = (page: Page): Promise<number> => store(page, (m) => m.getState().doc.scene.length);

/** How many features are picked in measure mode; -1 when not measuring. */
export const measurePicks = (page: Page): Promise<number> => store(page, (m) => m.getState().measuring?.picks.length ?? -1);

/** A small picture file, red with a white patch, as the bytes of a PNG. */
export function pngBytes(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#d33';
    g.fillRect(0, 0, 64, 32);
    g.fillStyle = '#fff';
    g.fillRect(8, 8, 20, 16);
    const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
}

/** A 10 mm cube written by the app's own exporters, as the bytes of an STL or a 3MF. */
export function cubeFile(page: Page, format: 'stl' | '3mf'): Promise<number[]> {
  return withModules(
    page,
    [EXPORT, THREEMF],
    (stl: typeof import('../src/io/export'), threemf: typeof import('../src/io/threemf'), format: 'stl' | '3mf') => {
      const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]);
      const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
      const mesh = { positions, triangles };
      return [...(format === 'stl' ? stl.exportMesh('stl', mesh, 'cube') : threemf.write3mf([{ name: 'cube', parts: [{ color: '#8fa3bf', mesh }] }], 'cube'))];
    },
    format,
  );
}

/** The number design files are written with (see FILE_VERSION in src/appInfo.ts). */
export const fileVersion = (page: Page): Promise<number> => withModules(page, [APP_INFO], (m: typeof import('../src/appInfo')) => m.FILE_VERSION);

/** Hands the app files as a drop on the window would. Not waited for: an import may stop at a dialog. */
export function dropFiles(page: Page, files: { name: string; bytes: number[] }[]): Promise<void> {
  return store(
    page,
    (m, files) => {
      void m.receiveFiles(files.map((f) => ({ name: f.name, path: null, bytes: new Uint8Array(f.bytes) })));
    },
    files,
  );
}

// --- pointers -------------------------------------------------------------------

/** One finger: where it is, and which finger it is. */
export type Finger = [x: number, y: number, id: number];

export interface Fingers {
  /** A finger goes down; `down` lists every finger then on the screen. */
  start(down: Finger[]): Promise<void>;
  move(down: Finger[]): Promise<void>;
  /** A finger lifts; `down` lists those still on the screen. */
  end(down?: Finger[]): Promise<void>;
}

/** Real touch events, through the browser's debugging protocol: several fingers at once, which `page.touchscreen` cannot do. */
export async function fingers(page: Page): Promise<Fingers> {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', down: Finger[]): Promise<void> =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: down.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) }).then(() => undefined);
  return {
    start: (down) => send('touchStart', down),
    move: (down) => send('touchMove', down),
    end: (down = []) => send('touchEnd', down),
  };
}

/** The middle of an element on the page. */
export async function centre(locator: Locator): Promise<[number, number]> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Nothing on screen for ${locator}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/**
 * A tap with one finger in the middle of an element, once it has stopped moving and is the thing
 * a finger there would reach (the entry sheet settles into place a moment after it opens).
 */
export const tap = (locator: Locator): Promise<void> => locator.tap();

/** A tap where an element is, whatever lies over it: for showing that a tap does not get through. */
export async function tapThrough(page: Page, locator: Locator): Promise<void> {
  const [x, y] = await centre(locator);
  await page.touchscreen.tap(x, y);
}

/** A tap where the project has fingers, a click where it has a mouse. */
export async function press(page: Page, x: number, y: number): Promise<void> {
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

// --- the viewer -------------------------------------------------------------------

export interface Plate {
  /** The canvas on the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its middle, where a fitted design is. */
  cx: number;
  cy: number;
}

export async function plate(page: Page): Promise<Plate> {
  const box = await page.locator('.canvas-host canvas').boundingBox();
  if (!box) throw new Error('The view has no canvas');
  return { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/** Frames the design at once, with no animation to wait for. */
export async function fitView(page: Page): Promise<void> {
  await viewer(page, (v) => v.fit(true));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

export interface ViewState {
  /** From the camera to what it looks at. */
  distance: number;
  /** Which way round the plate the camera is, in radians. */
  azimuth: number;
  target: number[];
  /** What the press in progress is doing ('pending-move', 'move'…), or null with nothing pressed. */
  drag: string | null;
  /** How many fingers the viewer has left to the camera, and how many the camera controls hold. */
  cameraTouches: number;
  controlPointers: number;
}

export function viewState(page: Page): Promise<ViewState> {
  return viewer(page, (v) => ({
    distance: +v.camera.position.distanceTo(v.controls.target).toFixed(2),
    azimuth: +Math.atan2(v.camera.position.y - v.controls.target.y, v.camera.position.x - v.controls.target.x).toFixed(4),
    target: v.controls.target.toArray().map((x: number) => +x.toFixed(2)),
    drag: v.input.drag ? v.input.drag.mode : null,
    cameraTouches: v.input.cameraTouches.size,
    controlPointers: v.controls._pointers.length,
  }));
}

/** Whether a press at that point of the page would land on an object. */
export function hitsObject(page: Page, x: number, y: number): Promise<boolean> {
  return viewer(
    page,
    (v, [x, y]) => {
      const r = v.renderer.domElement.getBoundingClientRect();
      v.pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      v.raycaster.setFromCamera(v.pointer, v.camera);
      return Boolean(v.objects.pick());
    },
    [x, y],
  );
}

/** Where a point of the design (mm) is on the page. */
export function screenPoint(page: Page, point: Vec3): Promise<[number, number]> {
  return viewer(
    page,
    (v, p) => {
      const r = v.renderer.domElement.getBoundingClientRect();
      const q = v.controls.target.clone().set(p[0], p[1], p[2]).project(v.camera);
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height] as [number, number];
    },
    point,
  );
}

/** How many objects the viewer has a mesh for. */
export const drawnCount = (page: Page): Promise<number> => viewer(page, (v) => v.objects.drawn.size);

/** Whether the outlines of the objects that are not selected are on show. */
export const edgesShown = (page: Page): Promise<boolean> =>
  viewer(page, (v) => [...v.objects.drawn.values()].filter((d: Internals) => !d.item.selected).some((d: Internals) => d.edges && d.edges.visible));

/** Whether the box that points out a part of a group is on show. */
export const pointingBoxShown = (page: Page): Promise<boolean> => viewer(page, (v) => v.pointer3d.visible);

/** The handles round the selection: which set, how many, and whether they follow the object's own axes. */
export const handles = (page: Page): Promise<{ mode: string; count: number; local: boolean | null }> =>
  viewer(page, (v) => ({ mode: v.handles.mode, count: v.handles.list.length, local: v.handles.frame ? v.handles.frame.local : null }));

export interface ViewerCalls {
  /** Objects given their look again. */
  style: number;
  /** Passes over the whole scene. */
  sync: number;
  /** The handle frame worked out again. */
  frame: number;
  /** The measure overlay drawn again. */
  measure: number;
}

/** Starts counting the viewer's costly steps (see `viewerCalls`). */
export function countViewerCalls(page: Page): Promise<void> {
  return viewer(page, (v) => {
    const calls: Record<string, number> = { style: 0, sync: 0, frame: 0, measure: 0 };
    (window as Internals).__viewerCalls = calls;
    const watch = (owner: Internals, method: string, name: string): void => {
      const original = owner[method].bind(owner);
      owner[method] = (...args: unknown[]) => {
        calls[name]++;
        return original(...args);
      };
    };
    watch(v.objects, 'style', 'style');
    watch(v, 'sync', 'sync');
    watch(v.handles, 'updateFrame', 'frame');
    watch(v.measure, 'sync', 'measure');
  });
}

/**
 * Waits until the viewer has come to rest: none of its costly steps counted over a short while.
 * What an earlier change set going (a build arriving, edges being made) can land late on a slow
 * machine, and would otherwise be counted against the change a test is about. The save that
 * follows a change by a second is made now for the same reason: its picture of the design is taken
 * with nothing selected, which restyles what is. The counts start again from zero.
 */
export async function viewerAtRest(page: Page): Promise<void> {
  await store(page, (m) => m.saveProject());
  await expect
    .poll(
      async () => {
        await viewerCalls(page);
        await page.waitForTimeout(250);
        const calls = await viewerCalls(page);
        return calls.style + calls.sync + calls.frame + calls.measure;
      },
      { message: 'the viewer has come to rest', timeout: 30_000 },
    )
    .toBe(0);
}

/** The counts since the last call, which start again from zero. */
export function viewerCalls(page: Page): Promise<ViewerCalls> {
  return page.evaluate(() => {
    const calls = (window as Internals).__viewerCalls as Record<string, number>;
    const read = { ...calls };
    for (const k in calls) calls[k] = 0;
    return read as unknown as ViewerCalls;
  });
}

export interface MeasureOverlayState {
  /** The figure of the measurement is on show. */
  label: boolean;
  /** Lines drawn (the measurement's own, and a lit edge). */
  lines: number;
  /** The objects whose features have been indexed. */
  indexed: string[];
  /** Which theme the dots were made for. */
  theme: string | null;
  /** The centre dots: whose they are and where along X. */
  dots: { node: string; x: number }[];
}

export function measureOverlay(page: Page): Promise<MeasureOverlayState> {
  return viewer(page, (v) => ({
    label: v.measure.label !== null,
    lines: v.measure.group.children.filter((c: Internals) => c.isLine).length,
    indexed: [...v.measure.indexes.keys()] as string[],
    theme: v.measure.materials?.theme ?? null,
    dots: v.measure.dots.map((d: Internals) => ({ node: d.feature.node as string, x: d.sprite.position.x as number })),
  }));
}

export interface SkinState {
  /** The decoded pictures and how far each has got ('ready'…). */
  images: string[];
  /** Paintings kept (a picture laid out for one object). */
  painted: number;
  /** Objects drawn with a picture on them. */
  worn: number;
}

export function skins(page: Page): Promise<SkinState> {
  return viewer(page, (v) => ({
    images: [...v.objects.painter.images.values()].map((d: Internals) => d.state as string),
    painted: v.objects.painter.painted.size,
    worn: [...v.objects.drawn.values()].filter((d: Internals) => d.skin).length,
  }));
}

/** Whether one object is drawn with its picture. */
export const wearsSkin = (page: Page, id: string): Promise<boolean> => viewer(page, (v, id) => Boolean(v.objects.drawn.get(id)?.skin), id);

// --- the WebGL context -------------------------------------------------------------------

/** Takes the WebGL context away, as a tablet does to an app in the background. */
export function loseContext(page: Page): Promise<void> {
  return viewer(page, (v) => {
    const lose = v.renderer.getContext().getExtension('WEBGL_lose_context');
    (window as Internals).__loseContext = lose;
    lose.loseContext();
  });
}

export const restoreContext = (page: Page): Promise<void> => page.evaluate(() => (window as Internals).__loseContext.restoreContext());

export const contextLost = (page: Page): Promise<boolean> => viewer(page, (v) => v.renderer.getContext().isContextLost());

/** The room the parts reflect: which texture it is, and whether the scene uses it. */
export const environment = (page: Page): Promise<{ texture: string; inUse: boolean }> =>
  viewer(page, (v) => ({ texture: v.environment.texture.uuid as string, inUse: v.scene.environment === v.environment.texture }));

/**
 * Has a restored context answered with a redraw alone, or (`false`) by the viewer's own handler
 * again. The redraw alone is the fault the handler mends; a test uses it to show it would see it.
 */
export function redrawOnlyOnRestore(page: Page, on: boolean): Promise<void> {
  return viewer(
    page,
    (v, on) => {
      const canvas = v.renderer.domElement;
      canvas.removeEventListener('webglcontextrestored', on ? v.onContextRestored : v.requestRender);
      canvas.addEventListener('webglcontextrestored', on ? v.requestRender : v.onContextRestored);
    },
    on,
  );
}

/** Mean brightness (0 to 255) of a square of the page, from a screenshot. */
export async function brightness(page: Page, cx: number, cy: number, half = 40): Promise<number> {
  const png = await page.screenshot({ clip: { x: cx - half, y: cy - half, width: half * 2, height: half * 2 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return +(sum / (d.length / 4)).toFixed(1);
  }, png.toString('base64'));
}

// --- React -------------------------------------------------------------------

/**
 * Counts which components React draws in each commit, by standing in for its developer tools.
 * Call before `openApp`; read with `renders`.
 */
export async function countRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as Internals;
    w.__renders = {};
    let was = new WeakSet<object>();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: unknown) {
        const id = this.renderers.size + 1;
        this.renderers.set(id, renderer);
        return id;
      },
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
      checkDCE() {},
      onCommitFiberRoot(_id: number, root: Internals) {
        const now = new WeakSet<object>();
        const walk = (f: Internals): void => {
          for (; f; f = f.sibling) {
            now.add(f);
            const t = f.type;
            const name = typeof t === 'function' ? t.name : t && typeof t === 'object' && typeof t.type === 'function' ? t.type.name : null;
            // Flag 1 is "performed work": the component function ran in this commit.
            if (name && f.flags & 1 && !was.has(f)) w.__renders[name] = (w.__renders[name] || 0) + 1;
            walk(f.child);
          }
        };
        walk(root.current.child);
        was = now;
      },
    };
  });
}

/** How often each component was drawn since the last call, by name. */
export function renders(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const w = window as Internals;
    const read = w.__renders as Record<string, number>;
    w.__renders = {};
    return read;
  });
}
