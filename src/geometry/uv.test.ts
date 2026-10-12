import { describe, expect, it } from 'vitest';
import { multiply, rotation, scaling, translation } from '../model/math';
import type { Mat } from '../model/math';
import { FILL_UV, azimuth, coverSurface, projectPictures, sheetUVs } from './uv';
import type { Projector } from './uv';

/** A unit cube centered on the origin as unindexed, outward-facing corners: twelve triangles. */
function cube(size = 1): Float32Array {
  const h = size / 2;
  const faces: [number[], number[], number[], number[]][] = [
    // +X, -X, +Y, -Y, +Z, -Z: four corners each, counter-clockwise seen from outside.
    [[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]],
    [[-h, h, -h], [-h, -h, -h], [-h, -h, h], [-h, h, h]],
    [[h, h, -h], [-h, h, -h], [-h, h, h], [h, h, h]],
    [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]],
    [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]],
    [[-h, h, -h], [h, h, -h], [h, -h, -h], [-h, -h, -h]],
  ];
  const out: number[] = [];
  for (const [a, b, c, d] of faces) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return new Float32Array(out);
}

/** A closed cylinder of radius r and height h around Z, from z = 0 to h, with n sides. */
function cylinder(r: number, h: number, n: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)];
    const p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h, p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
    out.push(0, 0, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0);
  }
  return new Float32Array(out);
}

const corner = (uv: Float32Array, i: number): [number, number] => [uv[i * 2], uv[i * 2 + 1]];
const isFill = (uv: Float32Array, i: number) => uv[i * 2] === FILL_UV[0] && uv[i * 2 + 1] === FILL_UV[1];
const whole: Projector['rect'] = [0, 0, 1, 1];

describe('flat pictures', () => {
  it('lands on the face that looks back at the sheet, and nowhere else', () => {
    // A 10 mm sheet 2 mm above the top of a 10 mm cube, facing up: only the +Z face gets it.
    const matrix: Mat = multiply(translation([0, 0, 7]), scaling([10, 10, 1]));
    const uv = projectPictures(cube(10), [{ matrix, mapping: 'flat', angle: 0, rect: whole }]);
    // Corners 24..29 are the +Z face: its corner at (-5, -5) is the picture's bottom-left.
    expect(corner(uv, 24)).toEqual([0, 0]);
    expect(corner(uv, 25)).toEqual([1, 0]);
    expect(corner(uv, 26)).toEqual([1, 1]);
    for (let i = 0; i < 24; i++) expect(isFill(uv, i), `corner ${i}`).toBe(true);
    for (let i = 30; i < 36; i++) expect(isFill(uv, i), `corner ${i}`).toBe(true);
  });

  it('keeps a small picture in the middle of a big face and drops faces beside it', () => {
    // A 4 mm sheet over the middle of the top face.
    const matrix: Mat = multiply(translation([0, 0, 7]), scaling([4, 4, 1]));
    const uv = projectPictures(cube(10), [{ matrix, mapping: 'flat', angle: 0, rect: whole }]);
    // The face's corners lie well outside the picture, so the picture shows in its middle.
    expect(corner(uv, 24)).toEqual([-0.75, -0.75]);
    expect(corner(uv, 26)).toEqual([1.75, 1.75]);
    // Moved off to one side, the picture reaches no face: all fill.
    const aside = projectPictures(cube(10), [{ matrix: multiply(translation([20, 0, 7]), scaling([4, 4, 1])), mapping: 'flat', angle: 0, rect: whole }]);
    for (let i = 0; i < 36; i++) expect(isFill(aside, i)).toBe(true);
  });

  it('follows the sheet when it is turned to face a side', () => {
    // Stood up facing -Y (turned 90° about X) in front of the -Y face.
    const matrix: Mat = multiply(translation([0, -7, 0]), multiply(rotation([90, 0, 0]), scaling([10, 10, 1])));
    const uv = projectPictures(cube(10), [{ matrix, mapping: 'flat', angle: 0, rect: whole }]);
    // Corners 18..23 are the -Y face; it is the only one that receives the picture.
    expect(isFill(uv, 18)).toBe(false);
    expect(isFill(uv, 24)).toBe(true);
    // The sheet's +Y (picture up) points up +Z after the turn: the face's lower corners sit at v = 0, the upper at v = 1.
    expect(corner(uv, 18)[1]).toBeCloseTo(0, 6);
    expect(corner(uv, 20)[1]).toBeCloseTo(1, 6);
  });

  it('puts the picture in its place in an atlas', () => {
    const matrix: Mat = multiply(translation([0, 0, 7]), scaling([10, 10, 1]));
    const uv = projectPictures(cube(10), [{ matrix, mapping: 'flat', angle: 0, rect: [0.25, 0.5, 0.75, 1] }]);
    expect(corner(uv, 24)).toEqual([0.25, 0.5]);
    expect(corner(uv, 26)).toEqual([0.75, 1]);
  });
});

describe('wrapped pictures', () => {
  it('goes round the outside of a cylinder and leaves the ends and the bore alone', () => {
    const mesh = cylinder(10, 20, 32);
    // A band the size of the cylinder, a quarter of the way round, centered on the front (-Y), as tall as the cylinder.
    const matrix: Mat = multiply(translation([0, 0, 10]), scaling([20, 20, 20]));
    const uv = projectPictures(mesh, [{ matrix, mapping: 'wrap', angle: 90, rect: whole }]);
    let onSide = 0;
    for (let s = 0; s < 32; s++) {
      const base = s * 12;
      // The side's two triangles: both or neither get the picture (they share the same angle range).
      const got = !isFill(uv, base);
      if (got) onSide++;
      // The cap triangles never do.
      expect(isFill(uv, base + 6)).toBe(true);
      expect(isFill(uv, base + 9)).toBe(true);
    }
    // Over a 90° band every side triangle whose span touches ±45° (plus those straddling it) is in.
    expect(onSide).toBeGreaterThanOrEqual(8);
    expect(onSide).toBeLessThanOrEqual(10);
    // Side 24 starts at 270°, the front: the picture's middle, so u from 0.5 up.
    expect(corner(uv, 24 * 12)[0]).toBeCloseTo(0.5, 6);
    expect(corner(uv, 24 * 12)[1]).toBeCloseTo(0, 6);
    expect(corner(uv, 24 * 12 + 2)[1]).toBeCloseTo(1, 6);
    expect(azimuth(0, -1)).toBe(0);
    expect(azimuth(1, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(azimuth(0, 1)).toBeCloseTo(Math.PI, 9);
  });

  it('does not smear across the seam opposite the picture', () => {
    const mesh = cylinder(10, 20, 8);
    const matrix: Mat = multiply(translation([0, 0, 10]), scaling([20, 20, 20]));
    // A full wrap: every side faces outwards, but the side straddling 180° must be left out rather than streaked.
    const uv = projectPictures(mesh, [{ matrix, mapping: 'wrap', angle: 360, rect: whole }]);
    const got = Array.from({ length: 8 }, (_, s) => !isFill(uv, s * 12));
    // The seam is at the back (+Y, 90°): side 2 runs 90°..135° and straddles it.
    expect(got[2]).toBe(false);
    expect(got.filter(Boolean).length).toBe(7);
  });

  it('stops at the first surface: the far wall of a cup stays clean', () => {
    // A cup: outer wall of radius 10 and inner wall of radius 8, both 20 tall; the inner wall faces inwards.
    const outer = cylinder(10, 20, 24);
    const bore = cylinder(8, 20, 24);
    const inner = new Float32Array(bore.length);
    for (let i = 0; i < bore.length; i += 9) {
      inner.set(bore.subarray(i, i + 3), i);
      inner.set(bore.subarray(i + 6, i + 9), i + 3);
      inner.set(bore.subarray(i + 3, i + 6), i + 6);
    }
    const cup = new Float32Array(outer.length + inner.length);
    cup.set(outer);
    cup.set(inner, outer.length);
    // A 10 mm flat sheet in front of the cup at mid height, facing the viewer (-Y) with the cup behind it.
    const matrix: Mat = multiply(translation([0, -12, 10]), multiply(rotation([90, 0, 0]), scaling([10, 10, 1])));
    const uv = projectPictures(cup, [{ matrix, mapping: 'flat', angle: 0, rect: whole }]);
    const sides = 24;
    const got = (base: number, s: number) => !isFill(uv, base + s * 12);
    // The outer wall's front sides (around 270°) receive the picture...
    expect(got(0, 18)).toBe(true);
    expect(got(0, 17)).toBe(true);
    // ...its back sides face away, and the far side of the bore, which faces the sheet, is hidden behind the front wall.
    expect(got(0, 6)).toBe(false);
    expect(got(outer.length / 3, 6)).toBe(false);
    expect(got(outer.length / 3, 5)).toBe(false);
    for (let s = 0; s < sides; s++) expect(got(outer.length / 3, s), `bore side ${s}`).toBe(false);
  });

  it('leaves alone what sticks out past the band, like a handle', () => {
    // A cup of radius 10 with a ring of radius 14 round it, both facing outwards.
    const body = cylinder(10, 20, 24);
    const ring = cylinder(14, 20, 24);
    const mesh = new Float32Array(body.length + ring.length);
    mesh.set(body);
    mesh.set(ring, body.length);
    // A band the size of the body, most of the way round.
    const matrix: Mat = multiply(translation([0, 0, 10]), scaling([20, 20, 20]));
    const uv = projectPictures(mesh, [{ matrix, mapping: 'wrap', angle: 300, rect: whole }]);
    // The body's front receives the picture, even though the ring stands between it and the band's axis.
    expect(isFill(uv, 18 * 12)).toBe(false);
    // The ring is outside the band: nothing lands on it anywhere.
    for (let s = 0; s < 24; s++) expect(isFill(uv, body.length / 3 + s * 12), `ring side ${s}`).toBe(true);
    // A flat sheet behaves the same way: a surface in front of it is passed over.
    const sheet: Mat = multiply(translation([0, -12, 10]), multiply(rotation([90, 0, 0]), scaling([10, 10, 1])));
    const flat = projectPictures(mesh, [{ matrix: sheet, mapping: 'flat', angle: 0, rect: whole }]);
    expect(isFill(flat, 18 * 12)).toBe(false);
    for (let s = 0; s < 24; s++) expect(isFill(flat, body.length / 3 + s * 12), `ring side ${s}`).toBe(true);
  });

  it('hides slivers behind a wall even when they are smaller than a pixel of the depth map', () => {
    // A 10 mm wall facing -Y, towards the sheet, and 20 mm behind it a sliver 0.01 mm across, facing the same way.
    const wall = new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, -5, 5, 0, 5, -5, 0, 5]);
    const sliver = new Float32Array([0, 20, 0, 0.01, 20, 0, 0.005, 20, 0.01]);
    const mesh = new Float32Array(27);
    mesh.set(wall);
    mesh.set(sliver, 18);
    const sheet: Mat = multiply(translation([0, -5, 0]), multiply(rotation([90, 0, 0]), scaling([10, 10, 1])));
    const uv = projectPictures(mesh, [{ matrix: sheet, mapping: 'flat', angle: 0, rect: whole }]);
    expect(isFill(uv, 0)).toBe(false);
    expect(isFill(uv, 6)).toBe(true);
  });

  it('ignores the inside of a tube', () => {
    // A bore: the same cylinder with its triangles turned inwards.
    const outer = cylinder(10, 20, 16);
    const inner = new Float32Array(outer.length);
    for (let i = 0; i < outer.length; i += 9) {
      inner.set(outer.subarray(i, i + 3), i);
      inner.set(outer.subarray(i + 6, i + 9), i + 3);
      inner.set(outer.subarray(i + 3, i + 6), i + 6);
    }
    const matrix: Mat = multiply(translation([0, 0, 10]), scaling([20, 20, 20]));
    const uv = projectPictures(inner, [{ matrix, mapping: 'wrap', angle: 360, rect: whole }]);
    for (let i = 0; i < uv.length / 2; i++) expect(isFill(uv, i)).toBe(true);
  });
});

describe('coverings', () => {
  it('wraps once around and up a cylinder, repeating over the seam', () => {
    const mesh = cylinder(10, 20, 16);
    const uv = coverSurface(mesh, { mode: 'wrap', scale: 50, mm: [1, 1, 1], z: [0, 20] });
    // Side 12 starts at 270°, the front: u = 0.5, with v from 0 at the foot to 1 at the top.
    expect(corner(uv, 12 * 12)[0]).toBeCloseTo(0.5, 9);
    expect(corner(uv, 12 * 12)[1]).toBe(0);
    expect(corner(uv, 12 * 12 + 2)[1]).toBe(1);
    // Side 4 runs from 90° (the back, the seam) on: its corners sit together at the start of the picture.
    const seamSide = 4 * 12;
    const us = [0, 1, 2].map((c) => corner(uv, seamSide + c)[0]);
    expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.5);
    expect(Math.max(...us)).toBeLessThanOrEqual(0.1);
    // Side 3 ends at the seam: it is carried on to u = 1 rather than wrapping back to 0.
    const before = [0, 1, 2].map((c) => corner(uv, 3 * 12 + c)[0]);
    expect(Math.max(...before) - Math.min(...before)).toBeLessThan(0.5);
    expect(Math.max(...before)).toBeCloseTo(1, 6);
  });

  it('turns a wrapped picture round the object', () => {
    const mesh = cylinder(10, 20, 16);
    // Turned a quarter the way round to the right: the side at +X (0°) now carries the picture's middle.
    const uv = coverSurface(mesh, { mode: 'wrap', scale: 50, turn: 90, mm: [1, 1, 1], z: [0, 20] });
    expect(corner(uv, 0)[0]).toBeCloseTo(0.5, 6);
    // No triangle is streaked across the seam, which moved with the picture.
    for (let s = 0; s < 16; s++) {
      const us = [0, 1, 2].map((c) => corner(uv, s * 12 + c)[0]);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.5);
    }
  });

  it('tiles every face of a box from the side it faces, in millimeters', () => {
    // A 20 mm cube built at unit size: the mm factor carries the scale.
    const uv = coverSurface(cube(1), { mode: 'tile', scale: 10, mm: [20, 20, 20], z: [-0.5, 0.5] });
    // The top face's corner at (-0.5, -0.5) is at (-10, -10) mm: one tile out each way.
    expect(corner(uv, 24)).toEqual([-1, -1]);
    expect(corner(uv, 26)).toEqual([1, 1]);
    // The +X face is tiled from Y and Z, so its corners differ by two tiles across and up.
    const xs = [0, 1, 2].map((c) => corner(uv, c));
    expect(Math.max(...xs.map((p) => p[0])) - Math.min(...xs.map((p) => p[0]))).toBe(2);
  });
});

describe('sheets', () => {
  it('shows the whole picture once on a flat sheet and across a band', () => {
    const flat = sheetUVs(new Float32Array([-0.5, -0.5, 0, 0.5, 0.5, 0]), 'flat', 0);
    expect(Array.from(flat)).toEqual([0, 0, 1, 1]);
    const band = sheetUVs(new Float32Array([0.5 * Math.cos(-(3 * Math.PI) / 4), 0.5 * Math.sin(-(3 * Math.PI) / 4), -0.5, 0.5 * Math.cos(-Math.PI / 4), 0.5 * Math.sin(-Math.PI / 4), 0.5]), 'wrap', 90);
    expect(band[0]).toBeCloseTo(0, 6);
    expect(band[1]).toBeCloseTo(0, 6);
    expect(band[2]).toBeCloseTo(1, 6);
    expect(band[3]).toBeCloseTo(1, 6);
  });
});
