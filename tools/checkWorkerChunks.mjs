// Run after a build: fails it when any built file imports the file a worker starts from.
//
// WebKit (the desktop app on Linux and macOS) runs a worker's first file a second time when another
// file of the worker imports from it; the second run takes the worker over with nothing of what the
// first was handed. The bundler makes such an import whenever the first file holds code that a part
// loaded later shares, which is why the workers start from files that hold none
// (src/worker/geometry.worker.ts). This holds the build to it.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The build's folder, from where the command is run: `dist` unless another is named.
const dir = `${resolve(process.argv[2] ?? 'dist')}/assets/`;
const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
const code = new Map(files.map((name) => [name, readFileSync(`${dir}${name}`, 'utf8')]));

/** The files workers are started from: what `new Worker(new URL("/assets/…"))` names. */
const starts = new Set();
for (const text of code.values()) for (const m of text.matchAll(/new Worker\(new URL\(\s*[`'"]\/?(?:assets\/)?([^`'"]+\.js)[`'"]/g)) starts.add(m[1].split('/').pop());
if (starts.size === 0) {
  console.error('checkWorkerChunks: found no worker in the build; the check needs a look.');
  process.exit(1);
}

const faults = [];
for (const [name, text] of code) {
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*[`'"]\.\/([^`'"]+\.js)[`'"]/g)) {
    if (starts.has(m[1])) faults.push(`${name} imports ${m[1]}, the file a worker starts from`);
  }
}
if (faults.length > 0) {
  console.error(`checkWorkerChunks: ${faults.join('; ')}. Keep the worker's code out of the file it starts from.`);
  process.exit(1);
}
console.log(`checkWorkerChunks: ${[...starts].join(', ')} imported by no other file.`);
