// Writes public/THIRD-PARTY-NOTICES.txt: the licenses of the libraries that
// ship inside the app, taken from the packages themselves. Run it after adding
// or removing a dependency (`pnpm notices`); a test fails when one is missing.
// The fonts are left out: their licenses are in public/font-licenses/.
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

const rule = `\n\n${'-'.repeat(72)}\n\n`;
const intro = `${pkg.name === 'plastikcad' ? 'PlastikCAD' : pkg.name} includes the following libraries. Each is the work of its authors, under the license given with it.\nThe fonts that ship with the app have their licenses in the font-licenses folder beside this file.`;
writeFileSync(join(root, 'public/THIRD-PARTY-NOTICES.txt'), `${[intro, ...sections, `Apache License 2.0\n\n${apache}`].join(rule)}\n`);
console.log(`Wrote the notices of ${names.length} libraries: ${names.join(', ')}`);
