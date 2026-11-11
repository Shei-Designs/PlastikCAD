import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import { parseStep } from './importStep';
import { loadOcc } from './occ';
import { STEP_TRIANGLES, writeStep } from './stepExport';

let oc: OpenCascadeInstance;

beforeAll(async () => {
  oc = await loadOcc({ wasmBinary: readFileSync(fileURLToPath(new URL('../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))) });
}, 60_000);

/** A box from the origin, its corners shared, facing outwards. */
function box(w: number, d: number, h: number, at: [number, number, number] = [0, 0, 0]): MeshData {
  const positions = new Float32Array([0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h].map((v, i) => v + at[i % 3]));
  const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, triangles };
}

/** A ball of `n` bands round the origin. */
function ball(n: number, radius: number): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  const id = (i: number, j: number): number => (i === 0 ? 0 : i === n ? 1 + (n - 1) * n : 1 + (i - 1) * n + (j % n));
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < (i === 0 || i === n ? 1 : n); j++) {
      const th = (Math.PI * i) / n;
      const ph = (2 * Math.PI * j) / n;
      positions.push(radius * Math.sin(th) * Math.cos(ph), radius * Math.sin(th) * Math.sin(ph), radius * Math.cos(th));
    }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i > 0) triangles.push(id(i, j), id(i + 1, j), id(i, j + 1));
      if (i < n - 1) triangles.push(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}

function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t] * 3, mesh.triangles[t + 1] * 3, mesh.triangles[t + 2] * 3];
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const count = (step: string, entity: string): number => (step.match(new RegExp(`\\b${entity}\\(`, 'g')) ?? []).length;

describe('STEP export', () => {
  it('writes a box as one solid of six planes, with its name and its color', () => {
    const { bytes, warnings } = writeStep(oc, [{ name: 'Plate é', color: '#d8605a', mesh: box(40, 30, 10) }]);
    expect(warnings).toEqual([]);
    const step = text(bytes);
    expect(step.startsWith('ISO-10303-21;')).toBe(true);
    expect(count(step, 'MANIFOLD_SOLID_BREP')).toBe(1);
    // Twelve triangles in, six faces out: the two of each side are one plane.
    expect(count(step, 'ADVANCED_FACE')).toBe(6);
    expect(count(step, 'PLANE')).toBe(6);
    expect(step).toContain("PRODUCT('Plate");
    // The color as written in the design: sRGB d8 60 5a.
    const rgb = /COLOUR_RGB\('',([\d.]+),([\d.]+),([\d.]+)\)/.exec(step)!.slice(1).map(Number);
    [0xd8, 0x60, 0x5a].forEach((c, i) => expect(rgb[i]).toBeCloseTo(c / 255, 3));
    // Millimeters.
    expect(step).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  });

  it('writes what reads back as the same solids: their sizes, places and volumes', () => {
    const sphere = ball(24, 20);
    for (let i = 0; i < sphere.positions.length; i += 3) sphere.positions[i] += 100;
    const { bytes } = writeStep(oc, [
      { name: 'Box', color: '#8fa3bf', mesh: box(40, 30, 10, [5, 6, 7]) },
      { name: 'Ball', color: '#5b8fd9', mesh: sphere },
    ]);
    const back = parseStep(oc, bytes, 'back');
    expect(back.parts).toHaveLength(2);
    const [first, second] = back.parts.map((p) => p.mesh);
    expect(volume(first)).toBeCloseTo(12000, 3);
    expect(Math.min(...first.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(5, 5);
    expect(Math.max(...first.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(17, 5);
    // The ball's flat sides are flat in the file too: nothing is added or lost.
    expect(volume(second)).toBeCloseTo(volume(sphere), 2);
    expect(Math.max(...second.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(120, 4);
  });

  it('writes a mesh that is not closed as a surface, and says so', () => {
    // A box without its top.
    const open = box(10, 10, 10);
    const tray: MeshData = { positions: open.positions, triangles: new Uint32Array([...open.triangles.subarray(0, 6), ...open.triangles.subarray(12)]) };
    const { bytes, warnings } = writeStep(oc, [{ name: 'Tray', color: '#ffffff', mesh: tray }]);
    expect(warnings).toEqual(['"Tray" is not watertight and was exported as a surface.']);
    const step = text(bytes);
    expect(count(step, 'MANIFOLD_SOLID_BREP')).toBe(0);
    expect(count(step, 'ADVANCED_FACE')).toBe(5);
  });

  it('leaves out an object too detailed to sew, and refuses a file with nothing left in it', () => {
    const huge: MeshData = { positions: new Float32Array(9), triangles: new Uint32Array((STEP_TRIANGLES + 1) * 3) };
    const mixed = writeStep(oc, [{ name: 'Scan', color: '#ffffff', mesh: huge }, { name: 'Box', color: '#ffffff', mesh: box(1, 1, 1) }]);
    expect(mixed.warnings).toEqual(['"Scan" is too detailed for a STEP file and was left out.']);
    expect(count(text(mixed.bytes), 'MANIFOLD_SOLID_BREP')).toBe(1);
    expect(() => writeStep(oc, [{ name: 'Scan', color: '#ffffff', mesh: huge }])).toThrow('"Scan" is too detailed for a STEP file and was left out.');
    expect(() => writeStep(oc, [])).toThrow('There is nothing to export.');
    // With a coarser mesh to write in its place, that one is counted and written.
    const coarse = writeStep(oc, [{ name: 'Scan', color: '#ffffff', mesh: huge, facets: box(2, 2, 2) }]);
    expect(coarse.warnings).toEqual([]);
    expect(count(text(coarse.bytes), 'ADVANCED_FACE')).toBe(6);
  });

  it('counts the triangles of the whole file: what would take it past the limit is left out, and said', () => {
    // Twelve triangles to a box, and room for thirty: two go out, the third does not, a smaller fourth would not either.
    const boxes = ['One', 'Two', 'Three'].map((name) => ({ name, color: '#ffffff', mesh: box(1, 1, 1) }));
    const { bytes, warnings } = writeStep(oc, boxes, { partBox: () => null }, 30);
    expect(warnings).toEqual(['"Three" was left out: the file had reached the detail a STEP file can hold.']);
    expect(count(text(bytes), 'MANIFOLD_SOLID_BREP')).toBe(2);
    // The same three with the room they need all go out.
    expect(writeStep(oc, boxes, { partBox: () => null }, 36).warnings).toEqual([]);
  });
});
