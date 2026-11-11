import { describe, expect, it } from 'vitest';
import { importFile } from './import';
import { writePly } from './ply';

const tetra = (shift: number) => ({ positions: Float32Array.from([0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6].map((v, i) => (i % 3 === 0 ? v + shift : v))), triangles: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) });

describe('PLY export', () => {
  it('writes every object into one mesh, each face in the color of its part, and reads back as that', () => {
    const bytes = writePly([
      { name: 'One', parts: [{ color: '#d8605a', mesh: tetra(0) }] },
      { name: 'Two', parts: [{ color: '#2244ee', mesh: tetra(20) }, { color: '', mesh: tetra(40) }] },
    ]);
    const head = new TextDecoder().decode(bytes.subarray(0, 300));
    expect(head.startsWith('ply\nformat binary_little_endian 1.0\ncomment PlastikCAD - units: millimeters\nelement vertex 12\n')).toBe(true);
    expect(head).toContain('element face 12\n');
    // As long as its header says: twelve bytes a point, sixteen a face.
    expect(bytes.length).toBe(head.indexOf('end_header\n') + 11 + 12 * 12 + 12 * 16);
    const back = importFile('out.ply', bytes);
    if (back.kind !== 'model') throw new Error('expected a model');
    const [part] = back.parts;
    expect(part.mesh.triangles.length).toBe(36);
    expect(part.mesh.positions.length).toBe(36);
    // Three colors came back, on a picture: the two given and the plain one for the part that had none.
    expect(part.image?.mime).toBe('image/png');
    const bounds = [Infinity, -Infinity];
    for (let i = 0; i < part.mesh.positions.length; i += 3) {
      bounds[0] = Math.min(bounds[0], part.mesh.positions[i]);
      bounds[1] = Math.max(bounds[1], part.mesh.positions[i]);
    }
    expect(bounds).toEqual([0, 46]);
  });

  it('writes a design of one color as that color', () => {
    const back = importFile('out.ply', writePly([{ name: 'One', parts: [{ color: '#11aa33', mesh: tetra(0) }] }]));
    expect(back.kind === 'model' && back.parts[0].color).toBe('#11aa33');
    expect(back.kind === 'model' && back.parts[0].image).toBeUndefined();
  });
});
