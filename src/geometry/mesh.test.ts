import { BufferAttribute, BufferGeometry, EdgesGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { CREASE_ANGLE, creaseEdges, creasedNormals, samePlace } from './mesh';
import type { MeshData } from './mesh';

/** A box from -1 to 1 with its corners shared, wound outwards. */
function box(): MeshData {
  const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  return { positions, triangles };
}

/** A ball of `rows` bands with bumps, corners shared; `open` leaves the top cap off. */
function ball(rows: number, open = false): MeshData {
  const positions: number[] = [];
  const triangles: number[] = [];
  const id = (i: number, j: number): number => (i === 0 ? 0 : i === rows ? 1 + (rows - 1) * rows : 1 + (i - 1) * rows + (j % rows));
  for (let i = 0; i <= rows; i++)
    for (let j = 0; j < (i === 0 || i === rows ? 1 : rows); j++) {
      const th = (Math.PI * i) / rows;
      const ph = (2 * Math.PI * j) / rows;
      const r = i === 0 || i === rows ? 50 : 50 + 6 * Math.sin(th * 5) * Math.cos(ph * 4);
      positions.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  for (let i = open ? 1 : 0; i < rows; i++)
    for (let j = 0; j < rows; j++) {
      if (i > 0) triangles.push(id(i, j), id(i + 1, j), id(i, j + 1));
      if (i < rows - 1) triangles.push(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions: new Float32Array(positions), triangles: new Uint32Array(triangles) };
}

/** Lines as text, each with its ends in a fixed order, sorted: two sets of lines compare whatever order they come in. */
function lines(segments: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 6) {
    const a = [segments[i], segments[i + 1], segments[i + 2]].map((v) => v.toFixed(3)).join(',');
    const b = [segments[i + 3], segments[i + 4], segments[i + 5]].map((v) => v.toFixed(3)).join(',');
    out.push(a < b ? `${a} ${b}` : `${b} ${a}`);
  }
  return out.sort();
}

/** What three.js draws for the same mesh. */
function threeEdges(mesh: MeshData): string[] {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(creasedNormals(mesh.positions, mesh.triangles, CREASE_ANGLE).positions, 3));
  return lines(new EdgesGeometry(geometry, CREASE_ANGLE).getAttribute('position').array);
}

describe('creaseEdges', () => {
  it('draws the twelve edges of a box and none of the diagonals across its faces', () => {
    const { positions, triangles } = box();
    const edges = creaseEdges(positions, triangles, CREASE_ANGLE)!;
    expect(edges.length / 6).toBe(12);
    expect(lines(edges)).toEqual(threeEdges(box()));
  });

  it('draws what three.js draws on a bumpy ball, closed and open', () => {
    for (const mesh of [ball(48), ball(48, true)]) {
      const edges = creaseEdges(mesh.positions, mesh.triangles, CREASE_ANGLE)!;
      expect(edges.length).toBeGreaterThan(0);
      expect(lines(edges)).toEqual(threeEdges(mesh));
    }
  });

  it('draws the rim of an open mesh', () => {
    // One square of two triangles: four sides on the rim, the diagonal flat.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const edges = creaseEdges(positions, new Uint32Array([0, 1, 2, 0, 2, 3]), CREASE_ANGLE)!;
    expect(lines(edges)).toEqual(lines([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]));
  });

  it('takes vertices at one place for one, so that a seam is no edge', () => {
    // The same square with the diagonal's ends written twice, as a mesh with texture coordinates has them.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
    const triangles = new Uint32Array([0, 1, 2, 3, 4, 5]);
    expect(creaseEdges(positions, triangles, CREASE_ANGLE)!.length / 6).toBe(6);
    const same = samePlace(positions);
    expect([...same]).toEqual([0, 1, 2, 0, 2, 5]);
    expect(creaseEdges(positions, triangles, CREASE_ANGLE, Infinity, same)!.length / 6).toBe(4);
  });

  it('gives up past the limit', () => {
    const { positions, triangles } = box();
    expect(creaseEdges(positions, triangles, CREASE_ANGLE, 12)).not.toBeNull();
    expect(creaseEdges(positions, triangles, CREASE_ANGLE, 11)).toBeNull();
  });

  it('skips slivers with two corners in one place', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(creaseEdges(positions, new Uint32Array([0, 1, 1]), CREASE_ANGLE)!.length).toBe(0);
  });
});

describe('samePlace', () => {
  it('takes -0 and 0 for the same place', () => {
    expect([...samePlace(new Float32Array([0, 0, 0, -0, 0, -0, 1, 0, 0]))]).toEqual([0, 0, 2]);
  });
});
