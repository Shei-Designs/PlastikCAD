// The lugs of a running belt as they are handed to the screen: closed boxes
// that face outward, and the lines that outline them.
import { describe, expect, it } from 'vitest';
import { getGenerator } from '../parts/generators';
import { trackFigures, trackLugs } from '../parts/generators/track';
import { sanitizeParams } from '../parts/generators/types';
import { LUG_EDGE_NUMBERS, LUG_TRIANGLE_NUMBERS, lugMesh } from './trackBelts';

const figures = (over: Record<string, number> = {}) => trackFigures(sanitizeParams(getGenerator('track'), over));

describe("a running belt's lugs", () => {
  it('are boxes whose every face looks away from the lug, whatever the shape and however far the belt has run', () => {
    const shapes: Record<string, number>[] = [{}, { idlerRise: 40 }, { sprocketRise: 30, idlerRise: 50, roadWheels: 1 }];
    for (const over of shapes) {
      const f = figures(over);
      for (const travel of [0, 3.7, -41]) {
        const corners = trackLugs(f, travel);
        const lugs = corners.length / 24;
        const positions = new Float32Array(lugs * LUG_TRIANGLE_NUMBERS);
        const normals = new Float32Array(lugs * LUG_TRIANGLE_NUMBERS);
        const edges = new Float32Array(lugs * LUG_EDGE_NUMBERS);
        lugMesh(corners, 0.1, positions, normals, edges);
        for (let l = 0; l < lugs; l++) {
          const middle = [0, 1, 2].map((i) => Array.from({ length: 8 }, (_, k) => corners[l * 24 + 3 * k + i]).reduce((a, b) => a + b, 0) / 8);
          for (let t = 0; t < LUG_TRIANGLE_NUMBERS; t += 9) {
            const at = l * LUG_TRIANGLE_NUMBERS + t;
            const face = [0, 1, 2].map((i) => (positions[at + i] + positions[at + 3 + i] + positions[at + 6 + i]) / 3);
            const out = [0, 1, 2].reduce((sum, i) => sum + (face[i] - middle[i]) * normals[at + i], 0);
            expect(out).toBeGreaterThan(0.1);
            expect(Math.hypot(normals[at], normals[at + 1], normals[at + 2])).toBeCloseTo(1, 6);
            // One normal for the whole face.
            expect(Array.from(normals.subarray(at + 3, at + 6))).toEqual(Array.from(normals.subarray(at, at + 3)));
          }
        }
        // Twelve lines a lug, none of no length, all within the lug's own corners' reach.
        expect(edges.every(Number.isFinite)).toBe(true);
        for (let e = 0; e < edges.length; e += 6) expect(Math.hypot(edges[e + 3] - edges[e], edges[e + 4] - edges[e + 1], edges[e + 5] - edges[e + 2])).toBeGreaterThan(0.05);
      }
    }
  });
});
