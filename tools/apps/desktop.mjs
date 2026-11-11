// The desktop app as it is built, tried from end to end: what the browser tests cannot see, because they never
// run the native file commands, the content policy, or the engine the desktop app draws with (WebKit).
//
//   node desktop.mjs <driver address> <the app's binary> <a folder for this run> <the repository>
//
// Started by run.sh, which builds the app, starts the driver off the screen and cut off from the real session.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { open } from './desktopHarness.mjs';
import { must, runner, sleep } from './steps.mjs';

const [base, binary, work, repo] = process.argv.slice(2);
const out = `${work}/out`;
mkdirSync(out, { recursive: true });

let app = null;
const { step, failed, count } = runner('desktop', () => (app ? app.faults() : Promise.resolve([])));

/** One start of the app for a group of checks: what a group leaves behind does not reach the next but through the projects folder. */
async function started(name, fn, args = []) {
  try {
    app = await open(base, binary, args);
    await sleep(2000);
    await fn();
  } catch (e) {
    await step(`${name}: ran to its end`, () => {
      throw e;
    });
  } finally {
    if (app) await app.close();
    app = null;
  }
}

const sizeOf = (path) => (existsSync(path) ? statSync(path).size : 0);
const files = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** Hands files in and waits for the design to have more objects than before; gives what came in. */
async function handIn(paths, seconds = 60) {
  const before = await app.count();
  await app.drop(paths);
  const grew = await app.until(`const s = S.getState(); return !s.busy && s.doc.scene.length > args[0] ? s.doc.scene.length : null;`, seconds, before);
  if (!grew) throw new Error(`nothing came in; box: ${JSON.stringify(await app.box())}; notice: ${await app.notice()}`);
  return app.run(`return S.getState().doc.scene.slice(args[0]).map((n) => n.name + ' (' + n.type + ')');`, before);
}

// --- cut off from the real session -----------------------------------------------------------
// The desktop app reads the Google Drive sign-in from the system's keychain. A run that reached the real one
// would sync, and what these checks delete would be deleted on the Drive. Nothing else runs unless this passes.
let safe = null;
await started('cut off', async () => {
  safe = await step('the app is cut off from the real session: its own projects folder, no Drive linked', async () => {
    const dir = await app.run(`return S.getState().storage.location;`);
    must(typeof dir === 'string' && dir.startsWith(work), `the projects folder is ${dir}, outside the folder of this run`);
    await app.run(`S.openProjects(); return null;`);
    const text = await app.until(`const d = document.querySelector('dialog[open]'); return d && /Google Drive/.test(d.textContent) ? d.textContent.replace(/\\s+/g, ' ') : null;`, 20);
    must(text && /Google Drive: not linked/.test(text) && !/Sync now/.test(text), `the Projects box does not say Drive is not linked: ${String(text).slice(0, 300)}`);
    await app.run(`S.closeProjects(); return null;`);
    return dir;
  });
});
if (!safe) {
  console.error('The app is not cut off from the real session: nothing more is tried.');
  process.exit(3);
}
const projects = safe;

// --- a design made, exported in every format, and each file handed back -----------------------
let formats = [];
await started('exports', async () => {
  await step('a box, a cylinder, a gear and lettering, saved as a project', async () => {
    await app.run(`S.addShape('box'); S.addShape('cylinder'); const c = S.getState().doc.scene[1]; S.updateNode(c.id, { pos: [40, 0, c.pos[2]], color: '#d9534f' }); await S.addPart('gears'); return null;`);
    await app.idle();
    await app.run(`const g = S.getState().doc.scene[2]; S.updateNode(g.id, { pos: [-50, 0, g.pos[2]] }); await S.addText(); const s = S.getState(); const n = s.doc.scene[s.doc.scene.length - 1]; await S.editText(n.id, { text: 'Été 42' }); S.updateNode(n.id, { pos: [0, 50, n.pos[2]] }); return null;`);
    await app.idle();
    must((await app.count()) === 4, `the design has ${await app.count()} objects, not 4`);
    await app.run(`S.renameProject('Checks'); await S.saveProject(); return null;`);
    await app.idle();
    must(files(projects).some((f) => f === 'Checks.plastikcad'), `no Checks.plastikcad in ${projects}: ${files(projects).join(', ')}`);
  });
  formats = (await app.run(`return M['/src/io/export.ts'].FORMATS.map((f) => ({ id: f.id, ext: f.extension }));`)) ?? [];
  // STEP first: the first STEP or compressed glTF file of a session once broke every export after it (#45).
  for (const f of [...formats.filter((f) => f.id === 'step'), ...formats.filter((f) => f.id !== 'step')]) {
    await step(`export as ${f.id}`, async () => {
      const path = `${out}/checks.${f.ext}`;
      await app.run(`t.saves.push(args[0]); return null;`, path);
      const done = await app.run(`return await S.exportDesign(args[0], false);`, f.id);
      await app.idle();
      must(sizeOf(path) > 0, `no file written (the export gave ${done}); notice: ${await app.notice()}`);
    });
  }
  await step('a name typed without its extension gets it', async () => {
    await app.run(`t.saves.push(args[0]); return await S.exportDesign('stl', false);`, `${out}/typed-name`);
    await app.idle();
    must(sizeOf(`${out}/typed-name.stl`) > 0 && !existsSync(`${out}/typed-name`), 'the file was not written as typed-name.stl');
  });
  await step('a file of a kind the app does not write is refused by the native side', async () => {
    const answer = await app.run(`try { await window.__TAURI_INTERNALS__.invoke('write_file', new Uint8Array([1, 2, 3]), { headers: { path: encodeURIComponent(args[0]) } }); return 'written'; } catch (e) { return 'refused'; }`, `${out}/not-ours.sh`);
    must(answer === 'refused' && !existsSync(`${out}/not-ours.sh`), `the native side wrote a .sh file (${answer})`);
  }, { allow: [/write_file/] });
  for (const f of formats) {
    if (!existsSync(`${out}/checks.${f.ext}`)) continue;
    await step(`the exported ${f.id} comes back in`, () => handIn(f.id === 'obj' ? [`${out}/checks.obj`, `${out}/checks.mtl`].filter((p) => existsSync(p)) : [`${out}/checks.${f.ext}`], f.id === 'step' ? 180 : 60));
  }
  await step('the design with all it took in is saved', async () => {
    await app.run(`await S.saveProject(); return null;`);
    await app.idle();
    must((await app.run(`return S.getState().saved !== null;`)) === true, `the design is not saved; notice: ${await app.notice()}`);
  });
});

// --- files from elsewhere ---------------------------------------------------------------------
await started('imports', async () => {
  await app.run(`await S.startProject('Imports'); return null;`);
  await app.idle();
  await step('a compressed glTF (its decoder is loaded under the content policy)', () => handIn([`${repo}/fixtures/gltf/box-draco.glb`], 90));
  await step('a STEP file from another program', () => handIn([`${repo}/fixtures/step/named.step`], 180));
  await step('a PLY with colors', async () => {
    const lines = ['ply', 'format ascii 1.0', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 6', 'property list uchar int vertex_indices', 'end_header'];
    const points = ['0 0 0 0 0 0', '20 0 0 255 0 0', '20 20 0 255 255 0', '0 20 0 0 255 0', '0 0 20 0 0 255', '20 0 20 255 0 255', '20 20 20 255 255 255', '0 20 20 0 255 255'];
    writeFileSync(`${out}/corners.ply`, [...lines, ...points, '4 0 3 2 1', '4 4 5 6 7', '4 0 1 5 4', '4 1 2 6 5', '4 2 3 7 6', '4 3 0 4 7', ''].join('\n'));
    return handIn([`${out}/corners.ply`]);
  });
  await step('a zip of a model', async () => {
    must(existsSync(`${out}/checks.stl`), 'the STL export it is made from is missing');
    writeFileSync(`${out}/packed.zip`, zipSync({ 'checks.stl': new Uint8Array(readFileSync(`${out}/checks.stl`)) }));
    return handIn([`${out}/packed.zip`]);
  });
  await step('the licenses of what the app is built from are in it', async () => {
    const sizes = await app.run(`const out = []; for (const f of ['THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES-NATIVE.txt']) { const r = await fetch('/' + f); out.push(r.ok ? (await r.text()).length : 0); } return out;`);
    must(sizes.every((n) => n > 1000), `the notices are missing or short: ${sizes}`);
  });
});

// --- projects in the folder --------------------------------------------------------------------
await started('projects', async () => {
  const names = () => app.run(`return (await S.listProjects()).map((p) => p.name);`);
  await step('a new project, and its file follows its name', async () => {
    await app.run(`await S.startProject('Bracket'); S.addShape('box'); await S.saveProject(); return null;`);
    await app.idle();
    must(files(projects).includes('Bracket.plastikcad'), `no Bracket.plastikcad: ${files(projects).join(', ')}`);
    await app.run(`S.renameProject('Bracket two'); await S.saveProject(); return null;`);
    await app.idle();
    must(files(projects).includes('Bracket two.plastikcad') && !files(projects).includes('Bracket.plastikcad'), `the file did not follow the name: ${files(projects).join(', ')}`);
  });
  await step('a second save keeps the one before', async () => {
    await app.run(`S.addShape('cylinder'); await S.saveProject(); return null;`);
    await app.idle();
    const kept = await app.run(`return (await S.listVersions(S.getState().doc.id)).length;`);
    must(kept >= 1, 'no earlier save is listed');
  });
  await step('duplicated, moved to the trash, put back, deleted for good', async () => {
    const copy = await app.run(`const p = (await S.listProjects()).find((x) => x.name === 'Bracket two'); return await S.duplicateProject(p.key);`);
    must(copy, 'no copy was made');
    const copies = (await names()).filter((n) => n.startsWith('Bracket two'));
    must(copies.length === 2, `after duplicating: ${copies.join(', ')}`);
    const other = `(await S.listProjects()).find((x) => x.name.startsWith('Bracket two') && x.key !== S.getState().projectKey)`;
    await app.run(`const p = ${other}; await S.deleteProject(p.key, p.name); return null;`);
    must((await app.run(`return (await S.listTrash()).length;`)) === 1, 'the deleted project is not in the trash');
    await app.run(`const trash = await S.listTrash(); await S.restoreProject(trash[0].key); return null;`);
    must((await names()).filter((n) => n.startsWith('Bracket two')).length === 2, 'the project did not come back from the trash');
    await app.run(`const p = ${other}; await S.deleteProject(p.key, p.name); await S.emptyTrash(); return null;`);
    must((await app.run(`return (await S.listTrash()).length;`)) === 0 && (await names()).filter((n) => n.startsWith('Bracket two')).length === 1, 'the project was not deleted for good');
  });
  await step('a copy saved elsewhere', async () => {
    await app.run(`t.saves.push(args[0]); return await S.saveCopy();`, `${out}/a copy`);
    await app.idle();
    must(sizeOf(`${out}/a copy.plastikcad`) > 0, 'no copy was written');
  });
  await step('a design file handed in becomes a project, and Escape leaves the file where it is', async () => {
    mkdirSync(`${out}/elsewhere`, { recursive: true });
    const doc = JSON.parse(readFileSync(`${out}/a copy.plastikcad`, 'utf8'));
    writeFileSync(`${out}/elsewhere/From elsewhere.plastikcad`, JSON.stringify({ ...doc, name: 'From elsewhere', id: 'elsewhere1' }));
    await app.drop([`${out}/elsewhere/From elsewhere.plastikcad`]);
    const box = await app.until(`const d = document.querySelector('dialog[open]'); return d && /Project added/.test(d.textContent) ? d.textContent.replace(/\\s+/g, ' ') : null;`, 30);
    must(box, `no "Project added" box; notice: ${await app.notice()}`);
    // Escape once deleted the file that was opened (#44).
    await app.key('Escape');
    await app.until(`return document.querySelector('dialog[open]') ? null : 'closed';`, 10);
    await app.idle();
    must(existsSync(`${out}/elsewhere/From elsewhere.plastikcad`), 'the file that was handed in is gone');
    must((await app.run(`return S.getState().doc.name;`)) === 'From elsewhere', 'the design that was handed in is not the one open');
    must(files(projects).includes('From elsewhere.plastikcad'), `it is not among the projects: ${files(projects).join(', ')}`);
  });
  await step('a design from a newer version is refused in place', async () => {
    const doc = JSON.parse(readFileSync(`${out}/a copy.plastikcad`, 'utf8'));
    writeFileSync(`${out}/elsewhere/Newer.plastikcad`, JSON.stringify({ ...doc, name: 'Newer', id: 'newer001', version: 99 }));
    await app.run(`t.answers.push(false); return null;`);
    await app.drop([`${out}/elsewhere/Newer.plastikcad`]);
    await sleep(2500);
    await app.box('Cancel|Close|OK|Keep');
    await app.idle();
    must((await app.run(`return S.getState().doc.name;`)) !== 'Newer', 'the newer design was opened');
  });
});

// --- a robot ----------------------------------------------------------------------------------
await started('robot', async () => {
  await step('the rover handed in, and robot mode', async () => {
    await app.drop([`${repo}/fixtures/robots/rover.plastikcad`]);
    const box = await app.until(`const d = document.querySelector('dialog[open]'); return d && /Project added/.test(d.textContent) ? 'box' : null;`, 30);
    must(box, `no "Project added" box; notice: ${await app.notice()}`);
    await app.box('Keep the file|OK');
    await app.idle();
    must(existsSync(`${repo}/fixtures/robots/rover.plastikcad`), 'the fixture was deleted');
    const joints = await app.run(`const s = S.getState(); return s.doc.robot ? s.doc.robot.joints.length : 0;`);
    must(joints > 0, 'the rover has no joints');
    await app.run(`S.enterRobotMode(); return null;`);
    await sleep(1500);
  });
  for (const format of ['urdf', 'sdf', 'mjcf', 'usd']) {
    await step(`the robot exported as ${format}`, async () => {
      const path = `${out}/rover-${format}.zip`;
      // Not waited for in one go: the export stops at a box of the app's own, which has to be pressed meanwhile.
      await app.run(`window.__done = null; t.saves.push(args[1]); S.exportRobot(args[0]).then((v) => (window.__done = 'gave ' + v), (e) => (window.__done = 'threw ' + (e && e.message ? e.message : e))); return null;`, format, path);
      await sleep(1500);
      await app.box('^Export$');
      const done = await app.until(`return window.__done;`, 180);
      await app.idle();
      must(sizeOf(path) > 0, `no file (${done}); notice: ${await app.notice()}`);
      const listed = Object.keys(unzipSync(new Uint8Array(readFileSync(path))));
      must(listed.length > 1, `the package holds ${listed.length} file`);
    });
  }
  await step('the test drive starts, drives and ends (the simulator is loaded under the content policy)', async () => {
    const pressed = await app.run(`const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Test drive'); if (!b || b.disabled) return false; b.click(); return true;`);
    must(pressed, 'no Test drive button to press');
    const running = await app.until(`if (/Building the model/.test(document.body.innerText)) return null; return [...document.querySelectorAll('button')].some((x) => /^(Stop|End|Reset)/.test(x.textContent.trim())) ? 'running' : null;`, 120);
    must(running, 'the test drive did not start');
    await app.hold('w', 2000);
    const ended = await app.run(`const b = [...document.querySelectorAll('button')].find((x) => /^(End|Stop)/.test(x.textContent.trim())); if (b) b.click(); return Boolean(b);`);
    must(ended, 'no button to end the test drive');
    await sleep(1000);
    await app.run(`S.leaveRobotMode(); return null;`);
  });
});

// --- started with a file -----------------------------------------------------------------------
await started(
  'started with a file',
  async () => {
    await step('started with an STL, the app opens with it on the plate', async () => {
      const there = await app.until(`const s = S.getState(); return !s.busy && s.doc.scene.length > 0 ? s.doc.scene.length : null;`, 60);
      must(there, `nothing on the plate; notice: ${await app.notice()}`);
    });
  },
  [`${out}/checks.stl`],
);

console.warn(`\ndesktop: ${count() - failed.length} of ${count()} checks passed.`);
for (const name of failed) console.error(`  failed: ${name}`);
process.exit(failed.length ? 1 : 0);
