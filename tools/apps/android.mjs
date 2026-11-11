// The Android app on the emulator, tried from end to end over its WebView's devtools: the real native side and
// bundled files, with the tests' hook in the page. What only the device can show: the app's own folders, the
// exports into Downloads, the share sheet, the Back key, the app sent behind the others.
//
//   node android.mjs <a folder for this run> <the app's package>
//
// Started by android.sh, which builds and installs the app and has put the files to hand in under the app's
// own files (files/in). ANDROID_SERIAL names the emulator, so no other device is touched.
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { must, runner, sleep } from './steps.mjs';

const [, pkg] = process.argv.slice(2);
const IN = `/data/user/0/${pkg}/files/in`;
const adb = (cmd) => execSync(`adb ${cmd}`, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const inApp = (cmd) => adb(`shell "run-as ${pkg} sh -c '${cmd}'"`);
const focus = () => adb('shell dumpsys window').match(/mCurrentFocus=.*/)?.[0] ?? '';
const launch = () => adb(`shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
const back = async () => {
  adb('shell input keyevent 4');
  await sleep(1500);
};

const socket = adb('shell "cat /proc/net/unix"').match(/webview_devtools_remote_\d+/)?.[0];
if (!socket) {
  console.error('The app has no web view up on the emulator.');
  process.exit(1);
}
adb(`forward tcp:9333 localabstract:${socket}`);
const browser = await chromium.connectOverCDP('http://localhost:9333');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(180000);
const reported = [];
page.on('pageerror', (e) => reported.push(`error: ${String(e).slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') reported.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
await page.waitForFunction(() => window.__plastikcadModules && document.querySelector('canvas'), null, { timeout: 60000 });
await page.evaluate(() => {
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`content policy: ${e.violatedDirective} ${e.blockedURI}`));
});

/** Runs a function in the page with the store, an argument and the app's modules. */
const run = (fn, arg) =>
  page.evaluate(
    ({ source, arg }) => {
      const M = window.__plastikcadModules;
      return (0, eval)(`(${source})`)(M['/src/state/store.ts'], arg, M);
    },
    { source: fn.toString(), arg },
  );
const idle = (seconds = 150) =>
  page.waitForFunction(
    () => {
      const s = window.__plastikcadModules['/src/state/store.ts'].getState();
      return !s.busy && !s.saving;
    },
    null,
    { timeout: seconds * 1000 },
  );
const notice = () => run((S) => (S.getState().notice ? `${S.getState().notice.text} [${S.getState().notice.kind}]` : null));
const count = () => run((S) => S.getState().doc.scene.length);
/** The app's own box, if one is open: its text, and a press on the button whose label matches. */
const box = (label) =>
  page.evaluate((label) => {
    const d = document.querySelector('dialog[open]');
    if (!d) return null;
    const b = label ? [...d.querySelectorAll('button')].find((x) => new RegExp(label).test(x.textContent.trim())) : null;
    if (b) b.click();
    return { text: d.textContent.trim().replace(/\s+/g, ' ').slice(0, 300), pressed: Boolean(b) };
  }, label ?? null);
const boxSays = (re, seconds = 180) => page.waitForFunction((source) => Boolean(document.querySelector('dialog[open]')) && new RegExp(source).test(document.querySelector('dialog[open]').textContent), re.source, { timeout: seconds * 1000 });
/** Every file under Downloads/PlastikCAD, folders gone into (an OBJ goes out as a folder of its files). */
const downloads = () => {
  try {
    return adb('shell "find /sdcard/Download/PlastikCAD -type f 2>/dev/null"').trim().split('\n').filter(Boolean).map((path) => path.replace('/sdcard/Download/PlastikCAD/', ''));
  } catch {
    return [];
  }
};

const { step, failed, count: checks } = runner('android', async () => {
  // A page that is gone has nothing more to report: the check that lost it has said so.
  const kept = await page.evaluate(() => window.__violations.splice(0)).catch(() => []);
  return [...reported.splice(0), ...kept];
});

/**
 * Sees an export through the app's own boxes: presses Export in each that has it (the robot's options, then the
 * name), waits for the one that says where the file went, and presses `last` there.
 */
async function throughBoxes(last = '^Done$', seconds = 400) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const open = await box();
    if (open && /Exported/.test(open.text)) return box(last);
    const done = await page.evaluate(() => window.__done);
    if (done) throw new Error(`the export ended with no box to say where the file went (${done}); notice: ${await notice()}`);
    if (open) await box('^Export$');
    if (Date.now() > until) throw new Error(`the export did not end; box: ${JSON.stringify(open)}; notice: ${await notice()}`);
    await sleep(700);
  }
}

/** Exports the design, to the last box, and presses `last` there. */
async function exported(format, last = '^Done$') {
  await run((S, id) => {
    window.__done = null;
    S.exportDesign(id, false).then(
      (v) => (window.__done = `gave ${v}`),
      (e) => (window.__done = `threw ${e && e.message ? e.message : e}`),
    );
  }, format);
  return throughBoxes(last);
}

/** Hands in files of the app's own folder and waits for the design to have more objects. */
async function handIn(names, seconds = 60) {
  const before = await count();
  await run((S, paths) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths, position: { x: 300, y: 400 } } }), names.map((n) => `${IN}/${n}`));
  try {
    await page.waitForFunction(
      (before) => {
        const s = window.__plastikcadModules['/src/state/store.ts'].getState();
        return !s.busy && s.doc.scene.length > before;
      },
      before,
      { timeout: seconds * 1000 },
    );
  } catch {
    throw new Error(`nothing came in; box: ${JSON.stringify(await box())}; notice: ${await notice()}`);
  }
}

try {
  await step('a box, a cylinder, a gear and lettering, saved as a project in the app\'s folder', async () => {
    await run(async (S) => {
      await S.startProject('Checks');
      S.addShape('box');
      S.addShape('cylinder');
      const c = S.getState().doc.scene[1];
      S.updateNode(c.id, { pos: [40, 0, c.pos[2]], color: '#d9534f' });
      await S.addPart('gears');
    });
    await idle();
    await run(async (S) => {
      await S.addText();
      const s = S.getState();
      await S.editText(s.doc.scene[s.doc.scene.length - 1].id, { text: 'Été 42' });
    });
    await idle();
    await run((S) => S.saveProject());
    await idle();
    must(/Checks\.plastikcad/.test(inApp('ls projects')), `no Checks.plastikcad among the projects: ${inApp('ls projects')}`);
  });

  const formats = (await run((S, _, M) => M['/src/io/export.ts'].FORMATS.map((f) => ({ id: f.id, ext: f.extension })))) ?? [];
  // STEP first: the first STEP file of a session once broke every export after it.
  for (const f of [...formats.filter((f) => f.id === 'step'), ...formats.filter((f) => f.id !== 'step')]) {
    await step(`export as ${f.id}, kept in Downloads`, async () => {
      await exported(f.id);
      await page.waitForFunction(() => window.__done, null, { timeout: 60000 });
      await idle();
      must(downloads().some((n) => n.endsWith(`.${f.ext}`)), `no .${f.ext} in Downloads/PlastikCAD: ${downloads().join(', ')}; notice: ${await notice()}`);
    });
  }
  await step('Share… opens the system\'s share sheet', async () => {
    await exported('stl', '^Share');
    await sleep(3000);
    const shown = focus();
    const chooser = /intentresolver|Chooser|ResolverActivity/.test(shown);
    // Back closes the sheet; pressed without it, it would close the app.
    if (chooser) await back();
    must(chooser, `the share sheet did not open: ${shown.slice(0, 160)}`);
  });

  await run((S) => S.startProject('Imports'));
  await idle();
  for (const [what, names, seconds] of [
    ['an STL', ['cube.stl'], 60],
    ['a PLY with colors', ['corners.ply'], 60],
    ['a compressed glTF', ['box-draco.glb'], 90],
    ['a STEP file', ['named.step'], 240],
  ]) {
    await step(`handed in: ${what}`, () => handIn(names, seconds));
  }

  await step('the rover handed in, robot mode, and a URDF export', async () => {
    await run((S, path) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths: [path], position: { x: 300, y: 400 } } }), `${IN}/rover.plastikcad`);
    await boxSays(/Project added/, 60);
    await box('Keep the file|OK');
    await idle();
    must((await run((S) => (S.getState().doc.robot ? S.getState().doc.robot.joints.length : 0))) > 0, 'the rover has no joints');
    await run((S) => S.enterRobotMode());
    await sleep(1500);
    await run((S) => {
      window.__done = null;
      S.exportRobot('urdf').then(
        (v) => (window.__done = `gave ${v}`),
        (e) => (window.__done = `threw ${e && e.message ? e.message : e}`),
      );
    });
    await throughBoxes();
    await run((S) => S.leaveRobotMode());
    must(downloads().some((n) => /\.zip$/.test(n)), `no robot package in Downloads/PlastikCAD: ${downloads().join(', ')}`);
  });

  await step('Back closes a box, puts the ruler away, lets go of the selection, then puts the app behind the others, alive', async () => {
    await run(async (S) => {
      await S.startProject('Back');
      S.addShape('box');
      S.openProjects();
    });
    await sleep(1200);
    await back();
    must(!(await page.evaluate(() => Boolean(document.querySelector('dialog[open]')))), 'Back did not close the Projects box');
    must((await run((S) => S.getState().selection.length)) === 1, 'Back let go of the selection behind the box');
    await run((S) => S.toggleMeasuring());
    await back();
    must(!(await run((S) => S.getState().measuring !== null)), 'Back did not put the ruler away');
    await back();
    must((await run((S) => S.getState().selection.length)) === 0, 'Back did not let go of the selection');
    await back();
    must(!focus().includes(pkg), `the app is still in front: ${focus().slice(0, 120)}`);
    must(adb(`shell pidof ${pkg}`).trim() !== '', 'the app was closed, not put behind the others');
    must(/Back\.plastikcad/.test(inApp('ls projects')), 'the design was not saved when the app went behind the others');
    launch();
    await sleep(3000);
    must((await run((S) => S.getState().doc.name)) === 'Back', 'the app did not come back as it was');
  });
} catch (e) {
  // Between two checks: most often the app itself has gone away (the system's log of the run says why).
  await step('the run reached its end', () => {
    throw e;
  });
} finally {
  console.warn(`\nandroid: ${checks() - failed.length} of ${checks()} checks passed.`);
  for (const name of failed) console.error(`  failed: ${name}`);
  await browser.close().catch(() => undefined);
}
process.exit(failed.length ? 1 : 0);
