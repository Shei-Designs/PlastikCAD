import { describe, expect, it } from 'vitest';
import { gearOutline, halfThicknessAt, inv, ringOutline, standardTooth, toothProfile } from './involute';
import { selfIntersects, signedArea } from './math2d';
import { QUALITY } from './types';

const q = QUALITY.fine;

describe('toothProfile', () => {
  it('matches the textbook dimensions of a 20T module 2 gear', () => {
    const p = toothProfile(standardTooth({ teeth: 20, module: 2, pressureAngle: 20 }), q);
    expect(p.pitchRadius).toBeCloseTo(20);
    expect(p.outerRadius).toBeCloseTo(22, 6);
    expect(p.rootRadius).toBeCloseTo(17.5, 6);
    expect(p.flank[0].r).toBeCloseTo(17.5, 6);
    expect(p.undercut).toBe(false);
    expect(p.pointed).toBe(false);
  });

  it('has the standard tooth thickness on the pitch circle', () => {
    for (const [teeth, x, backlash] of [[20, 0, 0], [35, 0.3, 0.1], [12, 0.4, 0], [60, -0.2, 0.05]]) {
      const spec = standardTooth({ teeth, module: 2, pressureAngle: 20, profileShift: x, backlash });
      const p = toothProfile(spec, q);
      const expected = (Math.PI * 2) / 2 + 2 * x * 2 * Math.tan(spec.pressureAngle) - backlash;
      expect(2 * halfThicknessAt(p, p.pitchRadius) * p.pitchRadius).toBeCloseTo(expected, 3);
    }
  });

  it('follows the closed-form involute above the fillet', () => {
    const spec = standardTooth({ teeth: 24, module: 1.5, pressureAngle: 20 });
    const p = toothProfile(spec, q);
    const sp = (Math.PI * 1.5) / 2;
    for (const radius of [p.pitchRadius - 1, p.pitchRadius, p.pitchRadius + 0.7, p.outerRadius - 0.01]) {
      const expected = sp / (2 * p.pitchRadius) + inv(spec.pressureAngle) - inv(Math.acos(p.baseRadius / radius));
      expect(halfThicknessAt(p, radius)).toBeCloseTo(expected, 4);
    }
  });

  it('joins fillet and involute smoothly when there is no undercut', () => {
    const p = toothProfile(standardTooth({ teeth: 30, module: 2, pressureAngle: 20 }), q);
    const pts = p.flank.map((s) => [s.r * Math.cos(s.half), s.r * Math.sin(s.half)]);
    for (let i = 1; i < pts.length - 1; i++) {
      const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      let turn = Math.abs(b - a);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      expect(turn).toBeLessThan(0.35);
    }
  });

  it('undercuts small pinions and profile shift removes it', () => {
    expect(toothProfile(standardTooth({ teeth: 8, module: 2, pressureAngle: 20 }), q).undercut).toBe(true);
    expect(toothProfile(standardTooth({ teeth: 8, module: 2, pressureAngle: 20, profileShift: 0.55 }), q).undercut).toBe(false);
    expect(toothProfile(standardTooth({ teeth: 18, module: 2, pressureAngle: 20 }), q).undercut).toBe(false);
  });

  it('truncates pointed teeth instead of crossing over', () => {
    const p = toothProfile(standardTooth({ teeth: 9, module: 2, pressureAngle: 25, profileShift: 0.9 }), q);
    expect(p.pointed).toBe(true);
    expect(p.flank[p.flank.length - 1].half).toBeCloseTo(0, 9);
    expect(p.outerRadius).toBeLessThan(9 + 2 * 1.9);
  });
});

describe('gearOutline', () => {
  it('is a simple CCW polygon for a wide range of gears', () => {
    const bad: string[] = [];
    for (const teeth of [6, 8, 10, 13, 17, 24, 51, 120])
      for (const alpha of [14.5, 20, 25])
        for (const x of [-0.3, 0, 0.5]) {
          const p = toothProfile(standardTooth({ teeth, module: 1.5, pressureAngle: alpha, profileShift: x, backlash: 0.05 }), QUALITY.normal);
          const outline = gearOutline(p, teeth, QUALITY.normal);
          const label = `z=${teeth} a=${alpha} x=${x}`;
          if (selfIntersects(outline)) bad.push(label);
          expect(signedArea(outline), label).toBeGreaterThan(Math.PI * p.rootRadius ** 2 * 0.98);
          expect(signedArea(outline), label).toBeLessThan(Math.PI * p.outerRadius ** 2);
          for (const [x0, y0] of outline) {
            expect(Math.hypot(x0, y0), label).toBeGreaterThan(p.rootRadius - 1e-6);
            expect(Math.hypot(x0, y0), label).toBeLessThan(p.outerRadius + 1e-6);
          }
        }
    expect(bad).toEqual([]);
  });

  it('works for helical transverse sections', () => {
    const spec = standardTooth({ teeth: 18, module: 2, pressureAngle: 20, helixAngle: 30 });
    expect(spec.module).toBeCloseTo(2 / Math.cos(Math.PI / 6));
    const p = toothProfile(spec, QUALITY.normal);
    expect(p.outerRadius).toBeCloseTo(p.pitchRadius + 2, 6);
    expect(selfIntersects(gearOutline(p, 18, QUALITY.normal))).toBe(false);
  });
});

describe('ringOutline', () => {
  it('produces a simple outline with the right radii', () => {
    for (const teeth of [24, 40, 72]) {
      const ring = ringOutline({ teeth, module: 2, pressureAngle: (20 * Math.PI) / 180, backlash: 0.1, clearance: 0.25 }, QUALITY.normal);
      expect(ring.pitchRadius).toBe(teeth);
      expect(ring.rootRadius).toBeCloseTo(teeth + 2.5, 6);
      expect(ring.innerRadius).toBeGreaterThanOrEqual(teeth - 2 - 1e-9);
      expect(signedArea(ring.outline)).toBeGreaterThan(0);
      expect(selfIntersects(ring.outline)).toBe(false);
    }
  });

  it('leaves room for the planet teeth: space width at the pitch circle is half a pitch plus backlash', () => {
    const ring = ringOutline({ teeth: 40, module: 2, pressureAngle: (20 * Math.PI) / 180, backlash: 0.1, clearance: 0.25 }, q);
    // Find the angular extent of the hole "tooth" 0 at the pitch radius.
    let half = 0;
    for (let i = 0; i < ring.outline.length - 1; i++) {
      const [x0, y0] = ring.outline[i];
      const [x1, y1] = ring.outline[i + 1];
      const r0 = Math.hypot(x0, y0);
      const r1 = Math.hypot(x1, y1);
      if (y0 < 0 && y1 < 0 && r0 <= 40 && r1 >= 40 && Math.abs(Math.atan2(y0, x0)) < Math.PI / 40) {
        const t = (40 - r0) / (r1 - r0);
        half = -Math.atan2(y0 + (y1 - y0) * t, x0 + (x1 - x0) * t);
      }
    }
    expect(2 * half * 40).toBeCloseTo(Math.PI + 0.1, 2);
  });
});
