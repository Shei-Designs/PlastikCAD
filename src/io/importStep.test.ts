import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MeshData } from '../geometry/mesh';
import { parseStep } from './importStep';
import { loadOcc } from './occ';

let oc: OpenCascadeInstance;
const fixture = (name: string): Uint8Array => readFileSync(fileURLToPath(new URL(`../../fixtures/step/${name}`, import.meta.url)));

beforeAll(async () => {
  oc = await loadOcc({ wasmBinary: readFileSync(fileURLToPath(new URL('../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))) });
}, 60_000);

function bounds(mesh: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min: min.map((v) => +v.toFixed(3)), max: max.map((v) => +v.toFixed(3)) };
}

/** The volume a closed mesh encloses, positive when its triangles face outwards. */
function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t] * 3, mesh.triangles[t + 1] * 3, mesh.triangles[t + 2] * 3];
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

/** Whether every edge of the mesh is shared by two triangles that run along it in opposite ways. */
function closed(mesh: MeshData): boolean {
  const seen = new Map<string, number>();
  for (let t = 0; t < mesh.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = mesh.triangles[t + k];
      const b = mesh.triangles[t + ((k + 1) % 3)];
      seen.set(`${a},${b}`, (seen.get(`${a},${b}`) ?? 0) + 1);
    }
  for (const [key, n] of seen) {
    const [a, b] = key.split(',');
    if (n !== 1 || seen.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

describe('STEP import', () => {
  it('reads a plate with a hole as one closed solid of the right size, facing outwards', () => {
    const got = parseStep(oc, fixture('plate.step'), 'plate');
    expect(got.parts).toHaveLength(1);
    const { mesh } = got.parts[0];
    expect(got.parts[0].name).toBe('plate');
    expect(bounds(mesh)).toEqual({ min: [0, 0, 0], max: [40, 30, 10] });
    expect(closed(mesh)).toBe(true);
    // 40 x 30 x 10 less a hole of radius 4: the hole of flat sides is a little smaller than the round one.
    const exact = 12000 - Math.PI * 16 * 10;
    expect(volume(mesh)).toBeGreaterThan(exact);
    expect(volume(mesh)).toBeLessThan(exact + 5);
  });

  it('reads each solid of a file as a part, where the file put it', () => {
    const got = parseStep(oc, fixture('plate-and-post.step'), 'kit');
    expect(got.parts.map((p) => p.name)).toEqual(['kit 1', 'kit 2']);
    expect(bounds(got.parts[0].mesh)).toEqual({ min: [0, 0, 0], max: [40, 30, 10] });
    // Round: its corners fall within the tolerance of the box round the true cylinder.
    const post = bounds(got.parts[1].mesh);
    [55, 10, 0].forEach((v, i) => expect(Math.abs(post.min[i] - v)).toBeLessThanOrEqual(0.02));
    [65, 20, 20].forEach((v, i) => expect(Math.abs(post.max[i] - v)).toBeLessThanOrEqual(0.02));
    for (const part of got.parts) expect(closed(part.mesh)).toBe(true);
    // A cylinder of radius 5, 20 tall, to within its flat sides.
    expect(volume(got.parts[1].mesh)).toBeGreaterThan(Math.PI * 25 * 20 * 0.99);
    expect(volume(got.parts[1].mesh)).toBeLessThanOrEqual(Math.PI * 25 * 20);
  });

  it('gives each solid the name a CAD program gave it, where the file placed it', () => {
    // Written by FreeCAD: three shapes, each a product placed in the file's assembly.
    const model = parseStep(oc, fixture('named.step'), 'kit');
    expect(model.parts.map((p) => p.name)).toEqual(['Bracket', 'Shaft', 'Knob été']);
    expect(bounds(model.parts[0].mesh)).toEqual({ min: [0, 0, 0], max: [40, 30, 10] });
    // The shaft stands 60 along X and the knob 100, where the file places them: round, to within their flat sides.
    const shaft = bounds(model.parts[1].mesh);
    [55, -5, 0].forEach((v, i) => expect(Math.abs(shaft.min[i] - v)).toBeLessThanOrEqual(0.02));
    [65, 5, 60].forEach((v, i) => expect(Math.abs(shaft.max[i] - v)).toBeLessThanOrEqual(0.02));
    const knob = bounds(model.parts[2].mesh);
    [92, -8, 12].forEach((v, i) => expect(Math.abs(knob.min[i] - v)).toBeLessThanOrEqual(0.05));
    // A file whose writer named its solids after itself keeps the names the file's own name gives.
    expect(parseStep(oc, fixture('plate-and-post.step'), 'kit').parts.map((p) => [p.name, p.color])).toEqual([
      ['kit 1', undefined],
      ['kit 2', undefined],
    ]);
  });

  it('refuses what is not a STEP file, and reads the next one all the same', () => {
    expect(() => parseStep(oc, new Uint8Array(0))).toThrow('This STEP file is empty.');
    expect(() => parseStep(oc, new TextEncoder().encode('ISO-10303-21;\nHEADER;\nnonsense'))).toThrow(/damaged or not supported|no shapes/);
    expect(parseStep(oc, fixture('plate.step')).parts).toHaveLength(1);
  });
});
