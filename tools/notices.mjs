// Writes public/THIRD-PARTY-NOTICES.txt: the licenses of the libraries that
// ship inside the app, taken from the packages themselves. Run it after adding
// or removing a dependency (`pnpm notices`); a test fails when one is missing.
// The fonts are left out: their licenses are in public/font-licenses/.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const names = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@fontsource/')).sort();

// The Apache License is printed once, after the list, for the packages that name it without carrying its text.
const apache = readFileSync(join(root, 'node_modules/manifold-3d/LICENSE'), 'utf8').trim();
const isApacheText = (text) => /Apache License\s+Version 2\.0/.test(text) && text.length > 8000;

const where = (meta) => {
  const repository = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  return (meta.homepage ?? repository ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
};

const sections = names.map((name) => {
  const dir = join(root, 'node_modules', name);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f) && !f.endsWith('.spdx')).sort() : [];
  const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).filter((text) => !isApacheText(text));
  const head = [`${name}`, `License: ${meta.license}`, where(meta)].filter(Boolean).join('\n');
  const apacheNote = /Apache-2\.0/.test(meta.license) ? ['The Apache License 2.0 is printed at the end of this file.'] : [];
  return [head, ...apacheNote, ...texts].join('\n\n');
});

// What ships inside another package under a license of its own: the Draco decoder, which three.js carries a copy of.
sections.push(['draco (the decoder, as shipped inside three)', 'License: Apache-2.0', 'https://github.com/google/draco', '', 'The Apache License 2.0 is printed at the end of this file.'].join('\n'));

const rule = `\n\n${'-'.repeat(72)}\n\n`;
const intro = `${pkg.name === 'plastikcad' ? 'PlastikCAD' : pkg.name} includes the following libraries. Each is the work of its authors, under the license given with it.\nThe fonts that ship with the app have their licenses in the font-licenses folder beside this file.`;
writeFileSync(join(root, 'public/THIRD-PARTY-NOTICES.txt'), `${[intro, ...sections, `Apache License 2.0\n\n${apache}`].join(rule)}\n`);
console.log(`Wrote the notices of ${names.length} libraries: ${names.join(', ')}`);

// --- the native side -------------------------------------------------------------------------
//
// public/THIRD-PARTY-NOTICES-NATIVE.txt: the Rust crates built into the desktop and Android apps.
// There are some four hundred of them, so they are listed a line each, and every license text
// they carry is printed once, with the crates it came with. Cargo says which crates those are:
// everything the app depends on to run, on any of its platforms; what only builds it or tests it
// is left out, as is the app's own code.

const cargo = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], { cwd: join(root, 'src-tauri'), maxBuffer: 1 << 28, encoding: 'utf8' }));
const own = new Set(cargo.workspace_members);
const nodes = new Map(cargo.resolve.nodes.map((n) => [n.id, n]));
const shipped = new Set();
const walk = (id) => {
  if (shipped.has(id)) return;
  shipped.add(id);
  for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) walk(dep.pkg);
};
for (const id of own) walk(id);
// A local crate (the app, its own plugin) has no source: it is the app's own code, under the app's license.
const crates = cargo.packages.filter((p) => shipped.has(p.id) && p.source !== null).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const squeeze = (text) => text.replace(/\s+/g, ' ').trim();
/** Every license text the crates carry, by the text with its spacing evened out, and the crates each came with. */
const texts = new Map();
const lines = crates.map((crate) => {
  const dir = dirname(crate.manifest_path);
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying|copyright|unlicense)/i.test(f)).sort();
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!text || isApacheText(text)) continue;
    const key = squeeze(text);
    const entry = texts.get(key) ?? { text, crates: [] };
    entry.crates.push(crate.name);
    texts.set(key, entry);
  }
  return `${crate.name} ${crate.version}  (${crate.license ?? 'see the license it carries'})${crate.repository ? `  ${crate.repository.replace(/\.git$/, '')}` : ''}`;
});
const nativeIntro = [
  'The desktop and Android apps of PlastikCAD are built with the following Rust crates. Each is the work of its authors, under the license given with it.',
  'The license texts the crates carry follow the list, each once, under the names of the crates it came with. The Apache License 2.0 is printed at the end.',
].join('\n');
const carried = [...texts.values()]
  .sort((a, b) => a.crates[0].localeCompare(b.crates[0]) || a.text.localeCompare(b.text))
  .map((entry) => `${[...new Set(entry.crates)].join(', ')}\n\n${entry.text}`);
writeFileSync(join(root, 'public/THIRD-PARTY-NOTICES-NATIVE.txt'), `${[nativeIntro, lines.join('\n'), ...carried, `Apache License 2.0\n\n${apache}`].join(rule)}\n`);
console.log(`Wrote the notices of ${crates.length} Rust crates, with ${carried.length} license texts`);
