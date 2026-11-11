import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildBvh, castRay } from './bvh';

/** Loose triangles of a bumpy ball of radius about 50 around the origin, wound outwards. */
function ball(rows: number): Float32Array {
  const at = (i: number, j: number): number[] => {
    const th = (Math.PI * i) / rows;
    const ph = (2 * Math.PI * (j % rows)) / rows;
    const r = i === 0 || i === rows ? 50 : 50 + 2 * Math.sin(th * 9) * Math.cos(ph * 7);
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };
  const out: number[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < rows; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i > 0) out.push(...a, ...b, ...d);
      if (i < rows - 1) out.push(...b, ...c, ...d);
    }
  return new Float32Array(out);
}

/** What three.js finds trying every triangle in turn: what the tree has to agree with. */
function slow(positions: Float32Array, o: number[], d: number[]): { t: number; triangle: number } | null {
  const geometry = meshes.get(positions) ?? new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3));
  meshes.set(positions, geometry);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const length = Math.hypot(d[0], d[1], d[2]);
  const hit = new Raycaster(new Vector3(...o), new Vector3(...d).normalize()).intersectObject(mesh, false)[0];
  return hit ? { t: hit.distance / length, triangle: hit.faceIndex! } : null;
}
const meshes = new Map<Float32Array, BufferGeometry>();

/** Numbers that come out the same on every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('buildBvh', () => {
  it('puts every triangle in exactly one leaf, inside the boxes above it', () => {
    const positions = ball(40);
    const count = positions.length / 9;
    const { boxes, nodes, order } = buildBvh(positions);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
    const seen = new Uint8Array(count);
    const walk = (at: number, above: number[][]): void => {
      const box = [...boxes.subarray(at * 6, at * 6 + 6)];
      const n = nodes[at * 2];
      if (n === 0) {
        walk(at + 1, [...above, box]);
        walk(nodes[at * 2 + 1], [...above, box]);
        return;
      }
      expect(n).toBeLessThanOrEqual(8);
      for (let i = nodes[at * 2 + 1]; i < nodes[at * 2 + 1] + n; i++) {
        const t = order[i];
        seen[t]++;
        for (const b of [...above, box])
          for (let c = 0; c < 9; c++) {
            expect(positions[t * 9 + c]).toBeGreaterThanOrEqual(b[c % 3]);
            expect(positions[t * 9 + c]).toBeLessThanOrEqual(b[3 + (c % 3)]);
          }
      }
    };
    walk(0, []);
    expect([...seen].every((n) => n === 1)).toBe(true);
  });

  it('copes with no triangles, with one, and with many in the same place', () => {
    expect(castRay(buildBvh(new Float32Array(0)), new Float32Array(0), [0, 0, 5], [0, 0, -1])).toBeNull();
    const one = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(castRay(buildBvh(one), one, [0.2, 0.2, 5], [0, 0, -1])).toEqual({ t: 5, triangle: 0 });
    // A hundred copies of one triangle: their middles give nothing to cut by.
    const many = new Float32Array(900);
    for (let i = 0; i < 100; i++) many.set(one, i * 9);
    const tree = buildBvh(many);
    expect(tree.nodes.length / 2).toBeGreaterThan(1);
    expect(castRay(tree, many, [0.2, 0.2, 5], [0, 0, -1])?.t).toBe(5);
  });
});

describe('castRay', () => {
  it('finds what trying every triangle finds, for rays from all around', () => {
    const positions = ball(60);
    const tree = buildBvh(positions);
    const next = random(7);
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      const o = [next() * 300 - 150, next() * 300 - 150, next() * 300 - 150];
      // Towards somewhere near the ball, so that most rays hit; some start inside it and see only backs.
      const d = [next() * 80 - 40 - o[0], next() * 80 - 40 - o[1], next() * 80 - 40 - o[2]];
      const want = slow(positions, o, d);
      const got = castRay(tree, positions, o, d);
      if (!want) expect(got).toBeNull();
      else {
        hits++;
        expect(got).not.toBeNull();
        expect(got!.t).toBeCloseTo(want.t, 9);
        expect(got!.triangle).toBe(want.triangle);
      }
    }
    expect(hits).toBeGreaterThan(1000);
  });

  it('takes rays along the axes, where a slab has no width to divide by', () => {
    const positions = ball(24);
    const tree = buildBvh(positions);
    for (const [o, d] of [
      [[0.3, 0.2, 200], [0, 0, -1]],
      [[200, 0.3, 0.2], [-1, 0, 0]],
      [[0.2, -200, 0.3], [0, 1, 0]],
    ]) {
      const want = slow(positions, o, d)!;
      const got = castRay(tree, positions, o, d)!;
      expect(got.triangle).toBe(want.triangle);
      expect(got.t).toBeCloseTo(want.t, 9);
    }
  });

  it('sees triangles only from the front, and nothing behind the start or past the limit', () => {
    const one = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const tree = buildBvh(one);
    expect(castRay(tree, one, [0.2, 0.2, 5], [0, 0, -1])).not.toBeNull();
    expect(castRay(tree, one, [0.2, 0.2, -5], [0, 0, 1])).toBeNull();
    expect(castRay(tree, one, [0.2, 0.2, 5], [0, 0, 1])).toBeNull();
    expect(castRay(tree, one, [0.2, 0.2, 5], [0, 0, -1], 4)).toBeNull();
    // A direction twice as long reaches it in half as many lengths.
    expect(castRay(tree, one, [0.2, 0.2, 5], [0, 0, -2])?.t).toBe(2.5);
  });
});
