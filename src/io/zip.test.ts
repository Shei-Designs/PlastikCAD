import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fileKind, IMPORT_EXTENSIONS } from './import';
import { write3mf } from './threemf';
import { unpackZip } from './zip';

const tetra = { positions: Float32Array.from([0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6]), triangles: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };

describe('a zip archive', () => {
  it('gives up the files the app reads, under their paths, and leaves the rest packed', () => {
    const archive = zipSync({
      'chair/chair.obj': strToU8('v 0 0 0\n'),
      'chair/chair.mtl': strToU8('newmtl wood\n'),
      'chair/textures/Wood.PNG': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'chair/scene.bin': new Uint8Array(4),
      'robot/urdf/arm.urdf': strToU8('<robot/>'),
      'Box.plastikcad': strToU8('{}'),
      // What no importer has a use for.
      'chair/README.txt': strToU8('read me'),
      'chair/preview.mp4': new Uint8Array(8),
      'chair/more.zip': new Uint8Array(8),
      'chair/noextension': new Uint8Array(8),
      // What a Mac and a file manager add.
      '__MACOSX/chair/._chair.obj': new Uint8Array(8),
      'chair/.DS_Store': new Uint8Array(8),
      'chair/.hidden.stl': new Uint8Array(8),
      'empty/': new Uint8Array(0),
    });
    const files = unpackZip(archive);
    expect(files.map((f) => f.name)).toEqual(['chair/chair.obj', 'chair/chair.mtl', 'chair/textures/Wood.PNG', 'chair/scene.bin', 'robot/urdf/arm.urdf', 'Box.plastikcad']);
    expect(new TextDecoder().decode(files[1].bytes)).toBe('newmtl wood\n');
    expect(unpackZip(zipSync({ 'notes.txt': strToU8('nothing here') }))).toEqual([]);
  });

  it('writes the folders of an archive made on Windows the one way', () => {
    expect(unpackZip(zipSync({ 'kit\\meshes\\base.stl': new Uint8Array(4) })).map((f) => f.name)).toEqual(['kit/meshes/base.stl']);
  });

  it('is not unpacked past what fits', () => {
    const archive = zipSync({ 'a.stl': new Uint8Array(600), 'b.stl': new Uint8Array(600), 'c.txt': new Uint8Array(5000) });
    // What is left packed does not count.
    expect(unpackZip(archive, 1200)).toHaveLength(2);
    expect(() => unpackZip(archive, 1199)).toThrow('This zip file is too large to open.');
  });

  it('says so when it is no archive, or a broken one', () => {
    expect(() => unpackZip(strToU8('PK\u0003\u0004 and then nothing of the kind'))).toThrow('This zip file is damaged or not supported.');
    expect(() => unpackZip(new Uint8Array(0))).toThrow('This zip file is damaged or not supported.');
    const archive = zipSync({ 'a.stl': new Uint8Array(600) });
    expect(() => unpackZip(archive.slice(0, archive.length - 30))).toThrow('This zip file is damaged or not supported.');
  });

  it('is told from a 3MF file, which is an archive too, by what it holds', () => {
    const archive = zipSync({ 'chair.obj': strToU8('v 0 0 0\n') });
    expect(fileKind('chair.zip', archive)).toBe('zip');
    expect(fileKind('Chair.ZIP', archive)).toBe('zip');
    // Picked on Android, where a document may come without a name to go by.
    expect(fileKind('msf:41', archive)).toBe('zip');
    const model = write3mf([{ name: 'T', parts: [{ color: '#d8605a', mesh: tetra }] }], 't');
    expect(fileKind('msf:42', model)).toBe('3mf');
    expect(fileKind('t.3mf', model)).toBe('3mf');
    // An archive is taken for its files: it is not itself something to import.
    expect(IMPORT_EXTENSIONS).not.toContain('zip');
  });
});
