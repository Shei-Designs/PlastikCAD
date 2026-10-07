import { describe, expect, it } from 'vitest';
import { emptyDoc, parseDoc, serializeDoc } from './file';
import { geomKey } from './geomKey';
import { apply, axisRotation, determinant, eulerOf, multiply, nodeMatrix, rotation } from './math';
import type { Mat } from './math';
import { alignNodes, boxBoundsOf, cloneNode, diffScenes, makeGroup, makeShape, mirrorNodes, rotateNodes, ungroup } from './ops';
import type { Doc, GroupNode, SceneNode, Vec3 } from './types';

const close = (a: number[], b: number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
};

const shape = (kind: Parameters<typeof makeShape>[0], patch: Partial<SceneNode> = {}): SceneNode => ({ ...makeShape(kind), ...patch }) as SceneNode;

describe('rotations', () => {
  it('applies X, then Y, then Z about fixed axes', () => {
    const m = rotation([90, 0, 90]);
    // +Y goes to +Z under the X turn, and stays there under the Z turn.
    close(apply(m, [0, 1, 0]), [0, 0, 1]);
    // +X is untouched by the X turn and goes to +Y under the Z turn.
    close(apply(m, [1, 0, 0]), [0, 1, 0]);
  });

  it('is exact at quarter turns', () => {
    expect(rotation([0, 0, 90])).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(rotation([180, 0, 0])).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0]);
    expect(rotation([0, -90, 270])).toEqual([0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
  });

  it('round-trips Euler angles, including gimbal lock', () => {
    const cases: Vec3[] = [
      [0, 0, 0],
      [10, 20, 30],
      [-170, 45, 120],
      [35, 90, 0],
      [35, -90, 60],
      [180, 0, 180],
    ];
    for (const rot of cases) close(rotation(eulerOf(rotation(rot))), rotation(rot));
  });

  it('turns nodes about a pivot', () => {
    const [node] = rotateNodes([shape('box', { pos: [10, 0, 5] })], 2, 90, [0, 0, 0]);
    close(node.pos, [0, 10, 5]);
    close(node.rot, [0, 0, 90]);
  });
});

describe('mirroring', () => {
  it('reflects the whole placement', () => {
    const node = shape('wedge', { pos: [10, 4, 5], rot: [20, 30, 40] });
    const [mirrored] = mirrorNodes([node], 0, [2, 0, 0]);
    const reflect: Mat = [-1, 0, 0, 0, 1, 0, 0, 0, 1, 4, 0, 0];
    close(nodeMatrix(mirrored), multiply(reflect, nodeMatrix(node)));
    expect(determinant(nodeMatrix(mirrored))).toBeLessThan(0);
  });

  it('is undone by mirroring again', () => {
    const node = shape('wedge', { pos: [10, 4, 5], rot: [20, 30, 40] });
    const [back] = mirrorNodes(mirrorNodes([node], 1, [0, 3, 0]), 1, [0, 3, 0]);
    close(nodeMatrix(back), nodeMatrix(node));
    expect(back.flip).toBeUndefined();
  });
});

describe('groups', () => {
  const children = (): SceneNode[] => [
    shape('box', { pos: [0, 0, 10] }),
    shape('wedge', { pos: [15, 5, 8], rot: [0, 0, 30], size: [10, 20, 16] }),
    shape('cylinder', { pos: [3, -4, 12], rot: [90, 0, 0], hole: true, flip: [false, true, false] }),
  ];
  const bounds = { min: [-10, -10, 0] as Vec3, max: [20, 15, 20] as Vec3 };

  it('centres children on the group', () => {
    const group = makeGroup(children(), bounds, 'Group');
    close(group.pos, [5, 2.5, 10]);
    close(group.size, [30, 25, 20]);
    close(group.children[0].pos, [-5, -2.5, 0]);
    expect(group.color).toBe(children()[0].color);
  });

  it('ungroups to exactly where the children were', () => {
    const before = children();
    const after = ungroup(makeGroup(before, bounds, 'Group'));
    after.forEach((node, i) => close(nodeMatrix(node), nodeMatrix(before[i])));
  });

  const placed = (group: GroupNode) => group.children.map((c) => multiply(nodeMatrix(group), nodeMatrix(c)));

  // "Exactly" below means to within the 0.0001 mm that positions and sizes are rounded to.
  it('ungroups a moved, turned, evenly scaled and mirrored group exactly', () => {
    const base = makeGroup(children(), bounds, 'Group');
    const group: GroupNode = { ...base, pos: [40, -20, 30], rot: [25, -40, 110], size: [60, 50, 40], flip: [true, false, false] };
    ungroup(group).forEach((node, i) => close(nodeMatrix(node), placed(group)[i], 1e-4));
  });

  it('ungroups an unevenly scaled group exactly when its children are square to it', () => {
    const square = [shape('box', { pos: [0, 0, 10] }), shape('cylinder', { pos: [5, 5, 10], rot: [0, 0, 90], size: [10, 20, 20] })];
    const base = makeGroup(square, bounds, 'Group');
    const group: GroupNode = { ...base, rot: [0, 0, 45], size: [60, 25, 10] };
    ungroup(group).forEach((node, i) => close(nodeMatrix(node), placed(group)[i], 1e-4));
  });

  it('scales millimetre parameters with an evenly scaled group', () => {
    const tube = shape('tube', { pos: [0, 0, 10] });
    const base = makeGroup([tube], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const [out] = ungroup({ ...base, size: [40, 40, 40] });
    expect(out.type === 'shape' && out.params.wall).toBe(4);
    close(out.size, [40, 40, 40]);
  });
});

describe('alignment and bookkeeping', () => {
  it('aligns to the lowest edge of a target', () => {
    const nodes = [shape('box', { pos: [0, 0, 10] }), shape('box', { pos: [50, 7, 30] })];
    const target = { min: [-10, -10, 0] as Vec3, max: [60, 17, 40] as Vec3 };
    const out = alignNodes(nodes, boxBoundsOf, 1, 'min', target);
    expect(out[0]).toBe(nodes[0]);
    close(out[1].pos, [50, 0, 30]);
  });

  it('gives copies fresh ids all the way down', () => {
    const group = makeGroup([shape('box'), shape('sphere')], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const copy = cloneNode(group);
    expect(copy.id).not.toBe(group.id);
    expect(copy.children[0].id).not.toBe(group.children[0].id);
  });

  it('counts what changed between scenes', () => {
    const a = shape('box');
    const b = shape('sphere');
    const c = shape('cone');
    expect(diffScenes([a, b], [{ ...a, pos: [1, 2, 3] }, c])).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(diffScenes([a, b], [{ ...a }, b])).toEqual({ added: 0, removed: 0, changed: 0 });
  });
});

describe('geometry keys', () => {
  it('ignore placement, and size where the shape just scales', () => {
    const box = shape('box');
    expect(geomKey({ ...box, pos: [5, 5, 5], rot: [0, 0, 45], size: [1, 2, 3], flip: [true, false, false] })).toBe(geomKey(box));
  });

  it('follow size where the shape depends on it', () => {
    const tube = shape('tube');
    expect(geomKey({ ...tube, size: [30, 30, 10] })).not.toBe(geomKey(tube));
    const rounded = shape('box');
    if (rounded.type === 'shape') rounded.params = { radius: 2 };
    expect(geomKey({ ...rounded, size: [30, 30, 10] })).not.toBe(geomKey(rounded));
  });

  it('follow the words, font and alignment of lettering, not its size', () => {
    const label = { ...shape('box'), type: 'text', text: 'A', font: 'sans', align: 'left', natural: [7, 7, 1] } as unknown as SceneNode;
    expect(geomKey({ ...label, size: [70, 70, 3], pos: [1, 2, 3] })).toBe(geomKey(label));
    expect(geomKey({ ...label, text: 'B' } as SceneNode)).not.toBe(geomKey(label));
    expect(geomKey({ ...label, font: 'mono' } as SceneNode)).not.toBe(geomKey(label));
  });

  it('follow the contents of a group but not where the group is', () => {
    const group = makeGroup([shape('box'), shape('sphere', { hole: true })], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    expect(geomKey({ ...group, pos: [9, 9, 9], size: [5, 5, 5] })).toBe(geomKey(group));
    const moved = { ...group, children: [group.children[0], { ...group.children[1], pos: [1, 0, 0] as Vec3 }] };
    expect(geomKey(moved)).not.toBe(geomKey(group));
  });
});

describe('design files', () => {
  const sample = (): Doc => {
    const box = shape('box');
    const group = makeGroup([shape('tube'), shape('cone', { hole: true, flip: [false, false, true] })], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const drawing: SceneNode = { ...shape('box'), type: 'import', asset: 'outline-1', natural: [10, 10, 1] } as unknown as SceneNode;
    delete (drawing as { shape?: unknown }).shape;
    delete (drawing as { params?: unknown }).params;
    const label: SceneNode = { ...shape('box'), type: 'text', text: 'M8\nleft', font: 'stencil', align: 'centre', natural: [14, 16, 1] } as unknown as SceneNode;
    delete (label as { shape?: unknown }).shape;
    delete (label as { params?: unknown }).params;
    return {
      name: 'Bracket',
      scene: [box, group, { ...drawing, hidden: true }, label],
      versions: [{ id: 'v1', parent: null, label: 'First', time: '2026-01-02T03:04:05.000Z', scene: [box], thumb: 'data:image/jpeg;base64,AAAA' }],
      head: 'v1',
      assets: {
        'outline-1': { kind: 'outline', shapes: [{ contours: [[[0, 0], [10, 0], [10, 10], [0, 10]]], evenodd: true }] },
        unused: { kind: 'mesh', positions: '', triangles: '' },
      },
    };
  };

  it('round-trips a design', () => {
    const doc = sample();
    const back = parseDoc(serializeDoc(doc));
    expect(back.scene).toEqual(doc.scene);
    expect(back.versions).toEqual(doc.versions);
    expect(back.head).toBe('v1');
    expect(back.name).toBe('Bracket');
  });

  it('drops imported data nothing uses', () => {
    expect(Object.keys(parseDoc(serializeDoc(sample())).assets)).toEqual(['outline-1']);
  });

  it('writes the same text for the same design, with vectors on one line', () => {
    const doc = sample();
    const text = serializeDoc(doc);
    expect(serializeDoc(parseDoc(text))).toBe(text);
    expect(text).toContain('"pos": [0,0,10]');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('round-trips an empty design', () => {
    expect(parseDoc(serializeDoc(emptyDoc()))).toEqual(emptyDoc());
  });

  it('rejects things that are not designs', () => {
    expect(() => parseDoc('not json')).toThrow(/JSON/);
    expect(() => parseDoc('{"format":"something-else"}')).toThrow(/not a design/);
    expect(() => parseDoc(serializeDoc(emptyDoc()).replace('"version": 1', '"version": 99'))).toThrow(/newer/);
  });

  it('skips nodes it cannot make sense of', () => {
    const text = serializeDoc(sample()).replace('"shape": "box"', '"shape": "teapot"');
    expect(parseDoc(text).scene.length).toBe(3);
  });

  it('stores lettering as its words, and falls back to a font it knows', () => {
    const text = serializeDoc(sample());
    expect(text).toContain('"text": "M8\\nleft"');
    const [label] = parseDoc(text.replace('"font": "stencil"', '"font": "comic"')).scene.slice(-1);
    expect(label.type === 'text' && label.font).toBe('sans');
  });
});

describe('axis rotation', () => {
  it('matches the Euler form', () => {
    close(axisRotation(1, 37), rotation([0, 37, 0]));
  });
});
