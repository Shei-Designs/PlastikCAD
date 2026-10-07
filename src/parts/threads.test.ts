import { beforeAll, describe, expect, it } from 'vitest';
import { evaluate, initKernel } from './evaluate';
import {
  isoMetricProfile,
  pressureAngleProfile,
  profileExtent,
  profileRadius,
  threadedRod,
  threadSolid,
  trapezoidalProfile,
  trapezoidProfile,
} from './threads';
import { extrude, intersection, QUALITY, rotate, translate } from './types';
import type { Solid } from './types';

const q = QUALITY.normal;

beforeAll(async () => {
  await initKernel();
});

describe('thread profiles', () => {
  it('ISO metric M8 has the basic dimensions', () => {
    const profile = isoMetricProfile(8, 1.25);
    const { rMin, rMax } = profileExtent(profile);
    expect(rMax).toBeCloseTo(4, 9);
    expect(rMin * 2).toBeCloseTo(8 - 1.082532 * 1.25, 4);
    expect(profile[0][0]).toBe(0);
    expect(profile[profile.length - 1][0]).toBe(1);
    expect(profile[0][1]).toBe(profile[profile.length - 1][1]);
    // crest flat P/8, root flat P/4, 60° included angle
    expect(profile[3][0] - profile[2][0]).toBeCloseTo(1 / 8, 9);
    expect(profile[1][0] * 2).toBeCloseTo(1 / 4, 9);
    const run = (profile[2][0] - profile[1][0]) * 1.25;
    expect(Math.atan2(run, rMax - rMin)).toBeCloseTo(Math.PI / 6, 9);
    // pitch diameter d - 0.6495P is where tooth and gap are equally wide
    expect(profileRadius(profile, 0.25)).toBeCloseTo(4 - 0.649519 * 1.25 * 0.5, 4);
  });

  it('offsets shift the metric form radially, limiting crest and root truncation to P/8', () => {
    const base = isoMetricProfile(8, 1.25);
    const shrunk = isoMetricProfile(8, 1.25, -0.2);
    expect(profileExtent(shrunk).rMax).toBeCloseTo(4 - 1.25 / 8, 9);
    expect(profileExtent(shrunk).rMin).toBeCloseTo(profileExtent(base).rMin - 0.2, 9);
    expect(profileRadius(base, 0.25) - profileRadius(shrunk, 0.25)).toBeCloseTo(0.2, 9);
    const grown = isoMetricProfile(8, 1.25, 0.2);
    expect(profileExtent(grown).rMax).toBeCloseTo(4.2, 9);
    expect(profileExtent(grown).rMin).toBeCloseTo(profileExtent(base).rMin + 1.25 / 8, 9);
    expect(profileRadius(grown, 0.25) - profileRadius(base, 0.25)).toBeCloseTo(0.2, 9);
    // small clearances are a plain radial shift
    expect(profileExtent(isoMetricProfile(8, 1.25, -0.15)).rMax).toBeCloseTo(3.85, 9);
  });

  it('steep flanks get at least half the offset as normal gap', () => {
    const base = trapezoidalProfile(8, 2);
    const shrunk = trapezoidalProfile(8, 2, { offset: -0.1 });
    expect(profileExtent(shrunk).rMax).toBeCloseTo(3.9, 9);
    expect(profileExtent(shrunk).rMin).toBeCloseTo(2.65, 9);
    const radialDrop = profileRadius(base, 0.25) - profileRadius(shrunk, 0.25);
    expect(radialDrop * Math.sin(Math.PI / 12)).toBeCloseTo(0.05, 9);
  });

  it('degenerate offsets stay valid', () => {
    const pointed = isoMetricProfile(3, 0.5, -0.3);
    const ext = profileExtent(pointed);
    expect(pointed.filter(([, r]) => r === ext.rMax).length).toBe(1);
    expect(ext.rMax).toBeLessThan(1.5 - 0.5 / 8);
    expect(ext.rMin).toBeGreaterThan(0);
    expect(ext.rMax).toBeGreaterThan(ext.rMin);
    const filled = trapezoidProfile({ pitch: 1, crestRadius: 3, rootRadius: 1, crestHalfWidth: 0.2, flankAngle: 0.5 });
    expect(profileExtent(filled).rMin).toBeGreaterThan(1);
    for (const p of [pointed, filled]) {
      for (let i = 1; i < p.length; i++) expect(p[i][0]).toBeGreaterThan(p[i - 1][0]);
    }
  });

  it('trapezoidal Tr8x2 follows ISO 2904', () => {
    const ext = profileExtent(trapezoidalProfile(8, 2));
    expect(ext.rMax * 2).toBeCloseTo(8, 9);
    expect(ext.rMin * 2).toBeCloseTo(5.5, 9); // d3 = d - P - 2ac
    const int = profileExtent(trapezoidalProfile(8, 2, { internal: true }));
    expect(int.rMax * 2).toBeCloseTo(8.5, 9); // D4 = d + 2ac
    expect(int.rMin * 2).toBeCloseTo(6, 9); // D1 = d - P
    // half the pitch is tooth at the pitch diameter d2 = d - P/2
    const profile = trapezoidalProfile(8, 2);
    expect(profileRadius(profile, 0.25)).toBeCloseTo(3.5, 9);
    expect(profileRadius(profile, 0.75)).toBeCloseTo(3.5, 9);
  });

  it('pressure-angle profile is rack shaped', () => {
    const m = 2;
    const profile = pressureAngleProfile({
      pitch: Math.PI * m,
      pitchRadius: 10,
      addendum: m,
      dedendum: 1.25 * m,
      pressureAngle: (20 * Math.PI) / 180,
    });
    const ext = profileExtent(profile);
    expect(ext.rMax).toBeCloseTo(12, 9);
    expect(ext.rMin).toBeCloseTo(7.5, 9);
    expect(profileRadius(profile, 0.25)).toBeCloseTo(10, 9);
  });
});

/** Volume of the solid inside a thin slab on the half-plane at `angle` (degrees), between z0 and z1. */
function slabVolume(solid: Solid, angle: number, z0: number, z1: number): number {
  const slab = rotate(translate(extrude([[[0, -0.01], [20, -0.01], [20, 0.01], [0, 0.01]]], z1 - z0), [0, 0, z0]), [0, 0, angle]);
  return evaluate(intersection(solid, slab)).stats.volume;
}

/** Integral of the profile radius between t0 and t1, times the slab thickness. */
function expectedSlab(profile: [number, number][], pitch: number, t0: number, t1: number): number {
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) sum += profileRadius(profile, t0 + ((t1 - t0) * (i + 0.5)) / n);
  return 0.02 * (sum / n) * (t1 - t0) * pitch;
}

describe('threadSolid', () => {
  // Asymmetric (buttress-like) profile: crest near t = 0.2.
  const buttress: [number, number][] = [
    [0, 3],
    [0.15, 4],
    [0.25, 4],
    [0.9, 3],
    [1, 3],
  ];
  const pitch = 2;

  it('reads the axial profile along +Z at angle 0 for both hands', () => {
    for (const leftHanded of [false, true]) {
      const solid = threadSolid({ profile: buttress, pitch, length: 3 * pitch, leftHanded, q });
      for (const [t0, t1] of [[0, 0.25], [0.25, 0.6], [1.1, 1.4], [2.5, 3]]) {
        expect(slabVolume(solid, 0, t0 * pitch, t1 * pitch)).toBeCloseTo(expectedSlab(buttress, pitch, t0, t1), 3);
      }
    }
  });

  it('right-handed threads climb counter-clockwise', () => {
    // A quarter turn CCW the same profile appears a quarter of a lead higher (lower for left-handed).
    const right = threadSolid({ profile: buttress, pitch, length: 3 * pitch, q });
    const left = threadSolid({ profile: buttress, pitch, length: 3 * pitch, leftHanded: true, q });
    const want = expectedSlab(buttress, pitch, 0.1, 0.3);
    const other = expectedSlab(buttress, pitch, 0.6, 0.8);
    expect(Math.abs(want - other)).toBeGreaterThan(0.002);
    expect(slabVolume(right, 90, (1.1 + 0.25) * pitch, (1.3 + 0.25) * pitch)).toBeCloseTo(want, 3);
    expect(slabVolume(left, 90, (1.1 - 0.25) * pitch, (1.3 - 0.25) * pitch)).toBeCloseTo(want, 3);
    expect(slabVolume(left, 90, (1.1 + 0.25) * pitch, (1.3 + 0.25) * pitch)).toBeCloseTo(other, 3);
  });

  it('interleaves multiple starts', () => {
    const profile = trapezoidalProfile(8, 2);
    const solid = threadSolid({ profile, pitch: 2, starts: 4, length: 16, q });
    // With four starts the profile repeats every quarter turn at the same height.
    const reference = slabVolume(solid, 0, 4, 5);
    for (const angle of [90, 180, 270]) expect(slabVolume(solid, angle, 4, 5)).toBeCloseTo(reference, 3);
    expect(reference).toBeCloseTo(expectedSlab(profile, 2, 0, 0.5), 3);
    const r = evaluate(solid);
    expect(r.stats.min[2]).toBeCloseTo(0, 6);
    expect(r.stats.max[2]).toBeCloseTo(16, 6);
  });

  it('keeps triangle counts low', () => {
    const fine = evaluate(threadSolid({ profile: isoMetricProfile(3, 0.5, -0.15), pitch: 0.5, length: 60, q }));
    expect(fine.stats.triangles).toBeLessThan(150_000);
    const m8 = evaluate(threadSolid({ profile: isoMetricProfile(8, 1.25), pitch: 1.25, length: 30, q }));
    expect(m8.stats.triangles).toBeLessThan(40_000);
    const minor = Math.PI * (4 - 0.6766) ** 2 * 30;
    expect(m8.stats.volume).toBeGreaterThan(minor);
    expect(m8.stats.volume).toBeLessThan(Math.PI * 16 * 30);
  });
});

describe('threadedRod', () => {
  it('spans exactly 0..length with and without chamfers', () => {
    const profile = isoMetricProfile(8, 1.25);
    for (const [chamferBottom, chamferTop] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      const r = evaluate(threadedRod({ profile, pitch: 1.25, length: 8, q, chamferBottom, chamferTop }));
      expect(r.stats.min[2]).toBeCloseTo(0, 5);
      expect(r.stats.max[2]).toBeCloseTo(8, 5);
      expect(r.stats.max[0]).toBeLessThanOrEqual(4 + 1e-6);
      expect(r.stats.max[0]).toBeGreaterThan(3.98);
      const minor = Math.PI * (4 - 0.6766) ** 2 * 8;
      const major = Math.PI * 16 * 8;
      expect(r.stats.volume).toBeGreaterThan(minor);
      expect(r.stats.volume).toBeLessThan(major);
    }
  });

  it('chamfers reduce the end diameter to the thread root', () => {
    const profile = isoMetricProfile(8, 1.25);
    const { rMin } = profileExtent(profile);
    const { positions } = evaluate(threadedRod({ profile, pitch: 1.25, length: 8, q, chamferTop: true })).mesh;
    let rTop = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i + 2] > 8 - 1e-4) rTop = Math.max(rTop, Math.hypot(positions[i], positions[i + 1]));
    }
    expect(rTop).toBeLessThanOrEqual(rMin + 1e-3);
    expect(rTop).toBeGreaterThan(rMin - 0.05);
  });
});
