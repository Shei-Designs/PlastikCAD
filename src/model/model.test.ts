import { describe, expect, it } from 'vitest';
import { emptyDoc, legacyVersions, parseDoc, readHeader, serializeDoc } from './file';
import { geomKey } from './geomKey';
import { apply, axisRotation, determinant, eulerOf, multiply, nodeMatrix, rotation } from './math';
import type { Mat } from './math';
import { alignNodes, arrayNodes, arrayPlaces, boxBoundsOf, cloneNode, dissolve, frameAlong, layerMembers, makeGroup, makeShape, mirrorNodes, nodeAt, picturesOf, regroup, rotateNodes, scaleNodes, sourceColor, ungroup, usedAssets } from './ops';
import type { Doc, GroupNode, PictureNode, SceneNode, ShapeNode, Vec3 } from './types';

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

describe('stretching several nodes as one box', () => {
  it('moves each with the stretch about the anchor and sizes it along the fixed axes', () => {
    // Two 20 mm boxes side by side along X: the box round them runs from x = 0 to x = 50.
    const a = shape('box', { pos: [10, 0, 10] });
    const b = shape('box', { pos: [40, 0, 10] });
    const [sa, sb] = scaleNodes([a, b], [2, 1, 0.5], [0, 0, 0]);
    close(sa.pos, [20, 0, 5]);
    close(sa.size, [40, 20, 10]);
    close(sb.pos, [80, 0, 5]);
    close(sb.size, [40, 20, 10]);
  });

  it('is exact for a node turned a quarter turn: its own axes swap roles', () => {
    const [turned] = scaleNodes([shape('box', { rot: [0, 0, 90], size: [10, 20, 30] })], [2, 1, 1], [0, 0, 0]);
    // The node's local Y runs along the scene's X, so that is the side that doubles.
    close(turned.size, [10, 40, 30]);
    close(turned.rot, [0, 0, 90]);
  });

  it('keeps every side at least the minimum and the shape parameters in range', () => {
    const [tiny] = scaleNodes([shape('box', { size: [20, 20, 20] })], [0.0001, 1, 1], [0, 0, 0], 0.5);
    expect(tiny.size[0]).toBe(0.5);
    const [rounded] = scaleNodes([shape('box', { params: { radius: 8 }, size: [20, 20, 20] } as Partial<SceneNode>)], [0.25, 0.25, 1], [0, 0, 0]);
    expect((rounded as ShapeNode).params.radius).toBeLessThanOrEqual(2.5);
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

describe('arrays', () => {
  const hole = shape('cylinder', { pos: [10, 20, 5], size: [3.2, 3.2, 10], hole: true });

  it('spaces a grid by its pitch, the original staying put', () => {
    const { originals, copies } = arrayNodes([hole], boxBoundsOf, { kind: 'grid', count: [3, 2, 1], pitch: [15, -8, 0] });
    expect(originals).toEqual([hole]);
    expect(copies).toHaveLength(5);
    expect(copies.map((c) => c.pos)).toEqual([
      [25, 20, 5],
      [40, 20, 5],
      [10, 12, 5],
      [25, 12, 5],
      [40, 12, 5],
    ]);
    expect(new Set([hole, ...copies].map((c) => c.id)).size).toBe(6);
    expect(copies.every((c) => c.hole && c.size[0] === 3.2 && c.rot.every((r) => r === 0))).toBe(true);
    expect(arrayPlaces({ kind: 'grid', count: [3, 2, 4] })).toBe(24);
  });

  it('fits a grid inside a box, centers a set distance in from its edges', () => {
    const plate = { min: [0, 0, 0] as Vec3, max: [80, 50, 4] as Vec3 };
    const { originals, copies } = arrayNodes([hole], boxBoundsOf, { kind: 'grid', count: [2, 2, 1], pitch: [1, 1, 1], fit: { bounds: plate, inset: 5 } });
    // The original moves to the first corner and keeps its height.
    expect(originals[0].pos).toEqual([5, 5, 5]);
    expect(originals[0].id).toBe(hole.id);
    expect(copies.map((c) => c.pos)).toEqual([
      [75, 5, 5],
      [5, 45, 5],
      [75, 45, 5],
    ]);
    // One place along an axis leaves that axis where it was.
    const row = arrayNodes([hole], boxBoundsOf, { kind: 'grid', count: [3, 1, 1], pitch: [1, 1, 1], fit: { bounds: plate, inset: 10 } });
    expect(row.originals[0].pos).toEqual([10, 20, 5]);
    expect(row.copies.map((c) => c.pos[0])).toEqual([40, 70]);
    expect(row.copies.every((c) => c.pos[1] === 20)).toBe(true);
    // Several seeds move together, by their common center.
    const pair = arrayNodes([hole, shape('box', { pos: [14, 20, 5], size: [2, 2, 10] })], boxBoundsOf, { kind: 'grid', count: [2, 1, 1], pitch: [1, 1, 1], fit: { bounds: plate, inset: 5 } });
    expect(pair.originals.map((n) => n.pos[0])).toEqual([3.3, 7.3]);
    expect(pair.copies.map((n) => n.pos[0])).toEqual([73.3, 77.3]);
  });

  it('rings copies round a center, turned with the ring or not', () => {
    const seed = shape('box', { pos: [30, 0, 5], size: [6, 4, 10] });
    const { originals, copies } = arrayNodes([seed], boxBoundsOf, { kind: 'ring', count: 4, sweep: 360, center: [0, 0], turn: true });
    expect(originals).toEqual([seed]);
    expect(copies).toHaveLength(3);
    close(copies[0].pos, [0, 30, 5]);
    close(copies[1].pos, [-30, 0, 5]);
    close(copies[2].pos, [0, -30, 5]);
    expect(copies.map((c) => c.rot[2])).toEqual([90, 180, -90]);
    const still = arrayNodes([seed], boxBoundsOf, { kind: 'ring', count: 4, sweep: 360, center: [0, 0], turn: false });
    close(still.copies[1].pos, [-30, 0, 5]);
    expect(still.copies.every((c) => c.rot.every((r) => r === 0))).toBe(true);
    // An arc puts a copy at either end.
    const arc = arrayNodes([seed], boxBoundsOf, { kind: 'ring', count: 3, sweep: 90, center: [0, 0], turn: true });
    expect(arc.copies.map((c) => c.rot[2])).toEqual([45, 90]);
    close(arc.copies[1].pos, [0, 30, 5]);
    // Round another center.
    const off = arrayNodes([seed], boxBoundsOf, { kind: 'ring', count: 2, sweep: 360, center: [30, 10], turn: false });
    close(off.copies[0].pos, [30, 20, 5]);
  });

  it('rings round the selection itself, moving it out to the radius first', () => {
    const seed = shape('cylinder', { pos: [40, 25, 5], size: [3, 3, 10], hole: true });
    const { originals, copies } = arrayNodes([seed], boxBoundsOf, { kind: 'ring', count: 4, sweep: 360, center: [40, 25], radius: 15, turn: false });
    expect(originals[0].id).toBe(seed.id);
    expect(originals[0].pos).toEqual([55, 25, 5]);
    close(copies[0].pos, [40, 40, 5]);
    close(copies[1].pos, [25, 25, 5]);
    close(copies[2].pos, [40, 10, 5]);
    // Two seeds keep their offset from each other.
    const pair = arrayNodes([seed, shape('box', { pos: [40, 29, 5], size: [3, 3, 10] })], boxBoundsOf, { kind: 'ring', count: 2, sweep: 360, center: [40, 25], radius: 15, turn: true });
    expect(pair.originals.map((n) => n.pos)).toEqual([
      [55, 23, 5],
      [55, 27, 5],
    ]);
    close(pair.copies[0].pos, [25, 27, 5]);
    close(pair.copies[1].pos, [25, 23, 5]);
  });
});

describe('groups', () => {
  const children = (): SceneNode[] => [
    shape('box', { pos: [0, 0, 10] }),
    shape('wedge', { pos: [15, 5, 8], rot: [0, 0, 30], size: [10, 20, 16] }),
    shape('cylinder', { pos: [3, -4, 12], rot: [90, 0, 0], hole: true, flip: [false, true, false] }),
  ];
  const bounds = { min: [-10, -10, 0] as Vec3, max: [20, 15, 20] as Vec3 };

  it('centers children on the group', () => {
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

  it('scales millimeter parameters with an evenly scaled group', () => {
    const rounded = shape('box', { pos: [0, 0, 10] });
    if (rounded.type === 'shape') rounded.params = { radius: 2 };
    const base = makeGroup([rounded], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const [out] = ungroup({ ...base, size: [40, 40, 40] });
    expect(out.type === 'shape' && out.params.radius).toBe(4);
    close(out.size, [40, 40, 40]);
  });

  it('scales the ring of a torus and the pitch of a tiled picture with the group, and nothing else', () => {
    const ring = shape('torus', { pos: [0, 0, 10], texture: { asset: 'img', mode: 'tile', scale: 15, turn: 0 } });
    if (ring.type === 'shape') ring.params = { sides: 48, ring: 3 };
    const base = makeGroup([ring], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const [out] = ungroup({ ...base, size: [40, 40, 40] });
    expect(out.type === 'shape' && out.params).toEqual({ sides: 48, ring: 6 });
    expect(out.texture).toEqual({ asset: 'img', mode: 'tile', scale: 30, turn: 0 });
    // An unevenly scaled group leaves them alone: there is no one factor to grow them by.
    const [stretched] = ungroup({ ...base, size: [40, 20, 20] });
    expect(stretched.type === 'shape' && stretched.params.ring).toBe(3);
    expect(stretched.texture?.scale).toBe(15);
  });
});

describe('the colors of a group', () => {
  const bounds = { min: [-10, -10, 0] as Vec3, max: [10, 10, 20] as Vec3 };
  const red = shape('box', { id: 'r', color: '#ff0000' });
  const blue = shape('sphere', { id: 'b', color: '#0000ff' });
  const bore = shape('cylinder', { id: 'h', color: '#00ff00', hole: true });

  it('starts mixed, standing for its first solid, unless told otherwise', () => {
    const group = makeGroup([bore, red, blue], bounds, 'G');
    expect(group.mixed).toBe(true);
    expect(group.color).toBe('#ff0000');
    expect(makeGroup([red, blue], bounds, 'G', { mixed: false }).mixed).toBeUndefined();
    expect(makeGroup([red, blue], bounds, 'G', { color: '#123456', mixed: false })).toMatchObject({ color: '#123456' });
  });

  it('colors each face by the part it came from, cut faces by the first solid beside the hole', () => {
    const group = makeGroup([red, blue, bore], bounds, 'G');
    expect(sourceColor(group, ['r'])).toBe('#ff0000');
    expect(sourceColor(group, ['b'])).toBe('#0000ff');
    expect(sourceColor(group, ['h'])).toBe('#ff0000');
    expect(sourceColor(group, ['nope'])).toBe(group.color);
  });

  it('lets a painted group inside color everything beneath it, and a mixed one show through', () => {
    const inner = makeGroup([red, blue], bounds, 'Inner');
    const outer = makeGroup([inner, bore], bounds, 'Outer');
    expect(sourceColor(outer, [inner.id, 'b'])).toBe('#0000ff');
    const painted = makeGroup([{ ...inner, mixed: undefined, color: '#abcdef' }, bore], bounds, 'Outer');
    expect(sourceColor(painted, [inner.id, 'b'])).toBe('#abcdef');
    // The hole's cut faces take the first solid's paint, through a mixed group to its first solid.
    expect(sourceColor(outer, ['h'])).toBe('#ff0000');
    expect(sourceColor(painted, ['h'])).toBe('#abcdef');
  });

  it('remembers through dissolving and regrouping whether a group was mixed', () => {
    const mixed = makeGroup([red, blue], bounds, 'M');
    const painted = makeGroup([{ ...red, id: 'r2' }, { ...blue, id: 'b2' }], bounds, 'P', { mixed: false });
    const scene = [mixed, painted];
    const apart = dissolve(scene, [mixed.id, 'r']);
    expect(apart.layers[0].mixed).toBe(true);
    expect(dissolve(scene, [painted.id, 'r2']).layers[0].mixed).toBe(false);
    const back = regroup(apart.scene, apart.layers, boxBoundsOf);
    expect((back[0] as GroupNode).mixed).toBe(true);
    const together = dissolve(scene, [painted.id, 'r2']);
    expect((regroup(together.scene, together.layers, boxBoundsOf)[1] as GroupNode).mixed).toBeUndefined();
  });
});

describe('taking groups apart and finding parts', () => {
  const nested = () => {
    const a = shape('box', { pos: [0, 0, 10] });
    const b = shape('cylinder', { pos: [10, 0, 10], hole: true });
    const inner = makeGroup([a, b], { min: [-10, -10, 0], max: [20, 10, 20] }, 'Inner');
    const c = shape('sphere', { pos: [40, 0, 10] });
    const outer = makeGroup([inner, c], { min: [-10, -10, 0], max: [50, 10, 20] }, 'Outer', { color: '#5fa777' });
    return { a, b, c, inner, outer, scene: [outer, shape('cone', { pos: [-50, 0, 10] })] };
  };

  it('finds a node by its path', () => {
    const { a, inner, outer, scene } = nested();
    expect(nodeAt(scene, [outer.id, inner.id, a.id])?.name).toBe('Box');
    expect(nodeAt(scene, [outer.id, a.id])).toBeNull();
  });

  it('places a part through its groups', () => {
    const { a, inner, outer, scene } = nested();
    const moved = { ...outer, pos: [outer.pos[0] + 5, outer.pos[1], outer.pos[2]] as Vec3 };
    const frame = frameAlong([moved, scene[1]], [moved.id, inner.id, a.id])!;
    close(apply(frame, [0, 0, 0]), [5, 0, 10]);
  });

  it('dissolves the groups down to a part, and remembers how to rebuild them', () => {
    const { a, b, c, inner, outer, scene } = nested();
    const { scene: out, layers } = dissolve(scene, [outer.id, inner.id, a.id]);
    expect(out.map((n) => n.name)).toEqual(['Box', 'Cylinder', 'Sphere', 'Cone']);
    expect(layers.map((l) => l.id)).toEqual([outer.id, inner.id]);
    expect(layers[0].children).toEqual([inner.id, c.id]);
    expect(layers[1].children).toEqual([a.id, b.id]);
    expect(layers[0].color).toBe('#5fa777');
    // Parts end up where they were.
    close(out[0].pos, a.pos);
    close(out[1].pos, b.pos);
    expect(out[1].hole).toBe(true);
    // And can be put back together under the same ids.
    const rebuilt = makeGroup([out[0], out[1]], { min: [-10, -10, 0], max: [20, 10, 20] }, layers[1].name, layers[1]);
    expect(rebuilt.id).toBe(inner.id);
    expect(rebuilt.children.map((n) => n.id)).toEqual([a.id, b.id]);
  });

  it('stops at the first layer that is not a group', () => {
    const { a, outer, scene } = nested();
    const { scene: out, layers } = dissolve(scene, [outer.id, a.id, 'nothing']);
    expect(layers.map((l) => l.id)).toEqual([outer.id]);
    expect(out.length).toBe(3);
  });

  // A cutter with a cavity: a solid box with a cylinder cut out of it, the whole marked as a hole.
  const cutter = () => {
    const box = shape('box', { pos: [0, 0, 10] });
    const bore = shape('cylinder', { pos: [0, 0, 10], size: [5, 5, 20], hole: true });
    const label: PictureNode = { id: 'pic', type: 'picture', name: 'Label', asset: 'img', mapping: 'flat', angle: 120, natural: [1, 1, 1], pos: [0, 0, 21], rot: [0, 0, 0], size: [10, 10, 1], hole: false, color: '#ffffff' };
    const group = makeGroup([box, bore, label], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Cutter', { hole: true });
    return { box, bore, label, group };
  };

  it('shows the parts of a dissolved hole group as holes, but remembers which really were', () => {
    const { box, bore, label, group } = cutter();
    const { scene, layers } = dissolve([group], [group.id, box.id]);
    expect(scene.map((n) => n.hole)).toEqual([true, true, false]);
    expect(layers[0].hole).toBe(true);
    expect(layers[0].children).toEqual([box.id, bore.id, label.id]);
    expect(layers[0].holes).toEqual([bore.id]);
  });

  it('gives the parts of a hole group their own flags back when it is put together again', () => {
    const { box, bore, group } = cutter();
    const { scene, layers } = dissolve([group], [group.id, box.id]);
    const back = layerMembers(layers[0], scene);
    expect(back.hole).toBe(true);
    expect(back.members.map((n) => n.hole)).toEqual([false, true, false]);
    // A part made solid meanwhile stays solid.
    const freed = scene.map((n) => (n.id === bore.id ? { ...n, hole: false } : n));
    expect(layerMembers(layers[0], freed).members.map((n) => n.hole)).toEqual([false, false, false]);
  });

  it('keeps a group of holes one hole, and a solid group as its members are', () => {
    const a = shape('cylinder', { pos: [0, 0, 10], hole: true });
    const b = shape('cylinder', { pos: [10, 0, 10], hole: true });
    // Grouped on their own, holes fold into one hole group with solid parts.
    const holes = makeGroup([{ ...a, hole: false }, { ...b, hole: false }], { min: [-10, -10, 0], max: [20, 10, 20] }, 'Holes', { hole: true });
    const apart = dissolve([holes], [holes.id, a.id]);
    expect(apart.scene.map((n) => n.hole)).toEqual([true, true]);
    const back = layerMembers(apart.layers[0], apart.scene);
    expect(back.hole).toBe(true);
    expect(back.members.map((n) => n.hole)).toEqual([false, false]);
    // A solid group takes its members as they are now, holes included.
    const { inner, outer, a: box, scene } = nested();
    const { scene: out, layers } = dissolve(scene, [outer.id, inner.id, box.id]);
    const members = layerMembers(layers[1], out.filter((n) => layers[1].children.includes(n.id)));
    expect(members.hole).toBe(false);
    expect(members.members.map((n) => n.hole)).toEqual([false, true]);
  });

  it('puts the layers back together around what is left, in place', () => {
    const { a, b, c, inner, outer, scene } = nested();
    const { scene: apart, layers } = dissolve(scene, [outer.id, inner.id, a.id]);
    const moved = apart.map((n) => (n.id === a.id ? { ...n, pos: [n.pos[0], n.pos[1], n.pos[2] + 5] as Vec3 } : n));
    const back = regroup(moved, layers, boxBoundsOf);
    expect(back.map((n) => n.id)).toEqual([outer.id, scene[1].id]);
    const top = back[0] as GroupNode;
    expect(top.hole).toBe(false);
    expect(top.children.map((n) => n.id)).toEqual([inner.id, c.id]);
    const mid = top.children[0] as GroupNode;
    expect(mid.children.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(mid.children[1].hole).toBe(true);
    // The moved part is where it was moved to, seen from the top.
    const place = (path: string[]) => apply(frameAlong(back, path)!, [0, 0, 0]);
    close(place([outer.id, inner.id, a.id]), [a.pos[0], a.pos[1], a.pos[2] + 5]);
    close(place([outer.id, c.id]), c.pos);
    // A layer whose contents are all gone is left out; a hole group's parts come back as they were.
    expect(regroup(apart.filter((n) => n.id !== a.id && n.id !== b.id), layers, boxBoundsOf).map((n) => n.id)).toEqual([outer.id, scene[1].id]);
    const { box, bore, group } = cutter();
    const whole = regroup(dissolve([group], [group.id, box.id]).scene, dissolve([group], [group.id, box.id]).layers, boxBoundsOf)[0] as GroupNode;
    expect(whole.hole).toBe(true);
    expect(whole.children.map((n) => [n.id, n.hole])).toEqual([[box.id, false], [bore.id, true], ['pic', false]]);
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

});

describe('geometry keys', () => {
  it('ignore placement, and size where the shape just scales', () => {
    const box = shape('box');
    expect(geomKey({ ...box, pos: [5, 5, 5], rot: [0, 0, 45], size: [1, 2, 3], flip: [true, false, false] })).toBe(geomKey(box));
  });

  it('follow size where the shape depends on it', () => {
    const ring = shape('torus');
    expect(geomKey({ ...ring, size: [30, 30, 10] })).not.toBe(geomKey(ring));
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
    const group = makeGroup([shape('torus'), shape('cone', { hole: true, flip: [false, false, true] })], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Group');
    const drawing: SceneNode = { ...shape('box'), type: 'import', asset: 'outline-1', natural: [10, 10, 1] } as unknown as SceneNode;
    delete (drawing as { shape?: unknown }).shape;
    delete (drawing as { params?: unknown }).params;
    const label: SceneNode = { ...shape('box'), type: 'text', text: 'M8\nleft', font: 'stencil', align: 'center', natural: [14, 16, 1] } as unknown as SceneNode;
    delete (label as { shape?: unknown }).shape;
    delete (label as { params?: unknown }).params;
    return {
      id: 'bracket01',
      name: 'Bracket',
      scene: [box, { ...group, ghost: true }, { ...drawing, hidden: true }, { ...label, note: 'Engrave 0.6 mm deep' }],
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
    expect(back.name).toBe('Bracket');
    // Notes travel; a group made now is mixed, and says so.
    expect(back.scene[3].note).toBe('Engrave 0.6 mm deep');
    expect((back.scene[1] as GroupNode).mixed).toBe(true);
    expect(back.scene[1].ghost).toBe(true);
    expect(back.scene[0].ghost).toBeUndefined();
    expect(serializeDoc(doc)).toContain('"mixed": true');
  });

  it('reads a group from before mixed groups as painted, and ignores a blank note', () => {
    const doc = sample();
    const text = serializeDoc(doc).replace('"mixed": true,\n', '').replace('"note": "Engrave 0.6 mm deep"', '"note": "   "');
    const back = parseDoc(text);
    expect((back.scene[1] as GroupNode).mixed).toBeUndefined();
    expect(back.scene[3].note).toBeUndefined();
  });

  it('reads the versions an old file carries as designs of their own, and drops them from the design', () => {
    const box = shape('box');
    const old = {
      format: 'plastikcad',
      version: 1,
      name: 'Bracket',
      head: 'v2',
      scene: [box],
      versions: [
        { id: 'v1', parent: null, label: 'First', time: '2026-01-02T03:04:05.000Z', scene: [box, shape('cone')] },
        { id: 'v2', parent: 'v1', label: '', time: '2026-01-03T03:04:05.000Z', scene: [] },
        { id: 'v3', parent: 'v1', label: 'Taller', time: '2026-01-04T03:04:05.000Z', scene: [{ ...box, size: [20, 20, 40] }] },
      ],
      assets: {},
    };
    const doc = parseDoc(JSON.stringify(old));
    // A file from before projects had ids gets one.
    expect(doc.id).toMatch(/^[a-z0-9]{8}$/);
    expect(doc).toEqual({ id: doc.id, name: 'Bracket', scene: [box], assets: {} });
    expect(serializeDoc(doc)).not.toContain('versions');
    const kept = legacyVersions(JSON.stringify(old));
    expect(kept.map((d) => d.name)).toEqual(['Bracket - First', 'Bracket - Taller']);
    expect(kept[0].scene).toHaveLength(2);
    expect(legacyVersions(serializeDoc(doc))).toEqual([]);
  });

  it('drops imported data nothing uses', () => {
    expect(Object.keys(parseDoc(serializeDoc(sample())).assets)).toEqual(['outline-1']);
  });

  it('drops a part of a kind the app no longer has, keeps the rest, and carries a renamed one over', () => {
    const doc = sample();
    const gone: SceneNode = { ...shape('box'), type: 'part', part: 'port-cutout', params: { port: 'usb-c' }, natural: [10, 10, 10] } as unknown as SceneNode;
    delete (gone as { shape?: unknown }).shape;
    const kept: SceneNode = { ...shape('box'), type: 'part', part: 'fan-cutout', params: { size: '80', opening: 'guard' }, natural: [80, 80, 20] } as unknown as SceneNode;
    delete (kept as { shape?: unknown }).shape;
    const back = parseDoc(serializeDoc({ ...doc, scene: [...doc.scene, gone, kept] }));
    expect(back.scene.length).toBe(doc.scene.length + 1);
    expect(back.scene.some((n) => n.type === 'part' && n.part === 'port-cutout')).toBe(false);
    const fan = back.scene.find((n) => n.type === 'part' && n.part === 'fan');
    expect(fan && fan.type === 'part' ? fan.params : null).toMatchObject({ size: '80', form: 'cutout', pattern: 'rings' });
  });

  it('writes the same text for the same design, with vectors on one line', () => {
    const doc = sample();
    const text = serializeDoc(doc);
    expect(serializeDoc(parseDoc(text))).toBe(text);
    expect(text).toContain('"pos": [0,0,10]');
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('round-trips an empty design', () => {
    const empty = emptyDoc();
    expect(parseDoc(serializeDoc(empty))).toEqual(empty);
    // Every new design gets an id of its own.
    expect(emptyDoc().id).not.toBe(empty.id);
  });

  it('rejects things that are not designs', () => {
    expect(() => parseDoc('not json')).toThrow(/JSON/);
    expect(() => parseDoc('{"format":"something-else"}')).toThrow(/not a design/);
    expect(() => parseDoc(serializeDoc(emptyDoc()).replace('"version": 2', '"version": 99'))).toThrow(/newer/);
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

  it('drops a part named like an object method instead of choking on it', () => {
    const doc = sample();
    const parts = ['toString', 'constructor', '__proto__', 'hasOwnProperty'].map((part, i) => {
      const node = { ...shape('box'), id: `p${i}`, type: 'part', part, params: {}, natural: [10, 10, 10] } as unknown as SceneNode;
      delete (node as { shape?: unknown }).shape;
      return node;
    });
    const back = parseDoc(serializeDoc({ ...doc, scene: [...doc.scene, ...parts] }));
    expect(back.scene.length).toBe(doc.scene.length);
    expect(back.scene.some((n) => n.type === 'part')).toBe(false);
  });

  it('does not let an asset called __proto__ change the asset table itself', () => {
    const text = `{"format":"plastikcad","version":1,"name":"x","scene":[],"assets":{"__proto__":{"kind":"mesh","positions":"","triangles":""},"constructor":{"kind":"mesh","positions":"AA","triangles":"AA"}}}`;
    const doc = parseDoc(text);
    expect(Object.getPrototypeOf(doc.assets)).toBe(Object.prototype);
    expect(Object.keys(doc.assets)).toEqual(['constructor']);
    expect(Object.prototype.hasOwnProperty.call(doc.assets, '__proto__')).toBe(false);
  });

  it('refuses a design nested too deeply to read', () => {
    const nest = (depth: number): string => {
      let inner = `{"id":"leaf","type":"shape","shape":"box"}`;
      for (let i = 0; i < depth; i++) inner = `{"id":"g${i}","type":"group","children":[${inner}]}`;
      return `{"format":"plastikcad","version":1,"name":"x","scene":[${inner}],"assets":{}}`;
    };
    expect(parseDoc(nest(10)).scene.length).toBe(1);
    expect(() => parseDoc(nest(2000))).toThrow('This design is nested too deeply.');
  });

  it('turns an old tube into a group of two cylinders, keeping its flags on the group', () => {
    const tube = {
      id: 't',
      type: 'shape',
      shape: 'tube',
      name: 'Pipe',
      size: [20, 20, 30],
      pos: [1, 2, 3],
      rot: [0, 0, 45],
      flip: [true, false, false],
      hidden: true,
      locked: true,
      texture: { asset: 'img', mode: 'tile', scale: 10, turn: 0 },
      params: { wall: 3, sides: 100000, radius: 50 },
    };
    const image = { kind: 'image', name: 'P', mime: 'image/png', data: 'AAAA', width: 2, height: 2 };
    const text = JSON.stringify({ format: 'plastikcad', version: 1, name: 'x', scene: [tube], assets: { img: image } });
    const [group] = parseDoc(text).scene;
    expect(group.type).toBe('group');
    if (group.type !== 'group') return;
    expect(group.hidden).toBe(true);
    expect(group.locked).toBe(true);
    expect(group.flip).toEqual([true, false, false]);
    expect(group.texture?.asset).toBe('img');
    expect(group.children.length).toBe(2);
    const [outer, inner] = group.children;
    for (const child of [outer, inner]) {
      expect(child.type).toBe('shape');
      expect(child.hidden).toBeUndefined();
      expect(child.locked).toBeUndefined();
      expect(child.texture).toBeUndefined();
      expect(child.flip).toBeUndefined();
      // Clamped like any cylinder: at most 128 sides, no edge radius.
      if (child.type === 'shape') expect(child.params).toEqual({ sides: 128, radius: 0 });
    }
    expect(outer.hole).toBe(false);
    expect(inner.hole).toBe(true);
    expect(inner.size).toEqual([14, 14, 60]);
  });
});

describe('file headers', () => {
  const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const body = { ...makeShape('box'), id: 'body0001', name: 'Body' };
  const doc = (): Doc => ({ id: 'proj0001', name: 'Hinge "left"', scene: [body], assets: {}, thumb: THUMB });

  it('writes the header before the scene and reads it back from the start of the file', () => {
    const text = serializeDoc(doc());
    expect(text.indexOf('"id": "proj0001"')).toBeLessThan(text.indexOf('"scene"'));
    expect(text.indexOf('"thumb"')).toBeLessThan(text.indexOf('"scene"'));
    expect(readHeader(text)).toEqual({ id: 'proj0001', name: 'Hinge "left"', revision: null, thumb: THUMB });
    // A file from when the app was BashCAD is the same file under another marker.
    const old = text.replace('"format": "plastikcad"', '"format": "bashcad"');
    expect(readHeader(old)).toEqual(readHeader(text));
    expect(parseDoc(old)).toEqual(parseDoc(text));
    expect(() => parseDoc(text.replace('"format": "plastikcad"', '"format": "othercad"'))).toThrow(/not a design made with this app/);
    // Only the start of the file, cut off inside the scene.
    expect(readHeader(text.slice(0, text.indexOf('"scene"') + 40))).toEqual({ id: 'proj0001', name: 'Hinge "left"', revision: null, thumb: THUMB });
    expect(parseDoc(text)).toEqual(doc());
  });

  it('does not mistake an object for the header of a file without an id', () => {
    const text = serializeDoc(doc()).replace('  "id": "proj0001",\n', '').replace(`  "thumb": "${THUMB}",\n`, '');
    expect(readHeader(text)).toEqual({ id: null, name: 'Hinge "left"', revision: null, thumb: null });
    // Cut off before the scene: the objects' names and ids are nowhere near.
    const head = text.slice(0, text.indexOf('"scene"'));
    expect(readHeader(head)).toEqual({ id: null, name: 'Hinge "left"', revision: null, thumb: null });
  });

  it('refuses what is not a design laid out by the app', () => {
    expect(readHeader('{"format":"plastikcad","version":2,"name":"Flat"}')).toBeNull();
    expect(readHeader('<svg/>')).toBeNull();
    expect(readHeader('{\n  "format": "plastikcad",\n  "version": 2')).toBeNull();
  });

  it('drops a thumbnail that is not a small picture', () => {
    expect(parseDoc(serializeDoc({ ...doc(), thumb: 'javascript:alert(1)' })).thumb).toBeUndefined();
    expect(parseDoc(serializeDoc({ ...doc(), thumb: `data:image/jpeg;base64,${'A'.repeat(300_000)}` })).thumb).toBeUndefined();
  });
});

describe('pictures and textures', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const picture = (over: Partial<PictureNode> = {}): PictureNode => ({ id: 'pic', type: 'picture', name: 'Pun', asset: 'img', mapping: 'wrap', angle: 140, natural: [1, 1, 1], pos: [0, 0, 5], rot: [0, 0, -90], size: [82, 82, 40], hole: false, color: '#ffffff', ...over });
  const doc = (): Doc => {
    const mug = makeGroup([shape('cylinder', { color: '#f2f2f0' }), picture()], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Mug');
    const crate = shape('box', { texture: { asset: 'img', mode: 'tile', scale: 25, turn: 0 } });
    return { id: 'pun00001', name: 'Pun', scene: [mug, crate], assets: { img: { kind: 'image', name: 'pun.png', mime: 'image/png', data: PNG, width: 1, height: 1 } } };
  };

  it('round-trips pictures, textures and the images they use', () => {
    const d = doc();
    const back = parseDoc(serializeDoc(d));
    expect(back.scene).toEqual(d.scene);
    expect(back.assets).toEqual(d.assets);
    expect(serializeDoc(back)).toBe(serializeDoc(d));
  });

  it('counts the images pictures and textures use as live', () => {
    expect([...usedAssets(doc().scene)]).toEqual(['img']);
    expect(Object.keys(parseDoc(serializeDoc(doc())).assets)).toEqual(['img']);
  });

  it('drops a picture or texture whose image is gone, and never makes a picture a hole', () => {
    const d = doc();
    delete d.assets.img;
    const text = serializeDoc({ ...d, assets: { img: { kind: 'image', name: 'x', mime: 'image/png', data: PNG, width: 1, height: 1 } } }).replace('"kind": "image"', '"kind": "nothing"');
    const back = parseDoc(text);
    expect(picturesOf(back.scene[0])).toEqual([]);
    expect(back.scene[1].texture).toBeUndefined();
    const holed = parseDoc(serializeDoc({ ...doc(), scene: [picture({ hole: true })] }));
    expect(holed.scene[0].hole).toBe(false);
  });

  it('keeps a picture out of the group\'s geometry key and out of its color', () => {
    const plain = makeGroup([shape('cylinder', { color: '#f2f2f0' })], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Mug');
    const withPicture = makeGroup([picture(), shape('cylinder', { color: '#f2f2f0' })], { min: [-10, -10, 0], max: [10, 10, 20] }, 'Mug');
    expect(geomKey(withPicture)).toBe(geomKey(plain));
    expect(geomKey(picture({ angle: 90 }))).not.toBe(geomKey(picture()));
    expect(withPicture.color).toBe('#f2f2f0');
    expect(picturesOf(withPicture).map((p) => p.id)).toEqual(['pic']);
  });
});

describe('axis rotation', () => {
  it('matches the Euler form', () => {
    close(axisRotation(1, 37), rotation([0, 37, 0]));
  });
});

describe('the robot in a file', () => {
  const base = (id: string, name: string): SceneNode => ({ id, name, type: 'shape', shape: 'box', params: {}, pos: [0, 0, 10], rot: [0, 0, 0], size: [20, 20, 20], hole: false, color: '#8fa3bf' });
  it('round-trips links and joints, and drops what names an object that is gone', () => {
    const doc = emptyDoc();
    doc.scene = [base('aaaaaaaa', 'Body'), base('bbbbbbbb', 'Arm')];
    doc.robot = {
      root: 'aaaaaaaa',
      base: 'free',
      sensors: [],
      control: true,
      links: [
        { node: 'bbbbbbbb', name: 'arm_link', mass: { kind: 'measured', grams: 120 }, collision: 'box', friction: 0.5 },
        { node: 'gone0000', mass: { kind: 'material', material: 'steel', infill: 100, shell: 1.2 }, collision: 'hull', friction: 0.8 },
      ],
      joints: [
        { id: 'j1', name: 'shoulder', type: 'revolute', parent: 'aaaaaaaa', child: 'bbbbbbbb', origin: [0, 0, 20], axis: [0, 1, 0], lower: -45, upper: 90, effort: 5, velocity: 60, damping: 0.1, friction: 0.02, mimic: { joint: 'j9', multiplier: 1, offset: 0 } },
        { id: 'j2', name: 'lost', type: 'fixed', parent: 'aaaaaaaa', child: 'gone0000', origin: [0, 0, 0], axis: [0, 0, 1], lower: 0, upper: 0, effort: 0, velocity: 0, damping: 0, friction: 0 },
      ],
    };
    const text = serializeDoc(doc);
    // The robot comes after the scene, so its name never passes for the design's in the header.
    expect(text.indexOf('"robot"')).toBeGreaterThan(text.indexOf('"scene"'));
    expect(readHeader(text)?.name).toBe('Untitled');
    const back = parseDoc(text);
    expect(back.robot?.root).toBe('aaaaaaaa');
    expect(back.robot?.links).toEqual([doc.robot!.links[0]]);
    // The follower of a joint that is gone follows nothing.
    expect(back.robot?.joints).toEqual([{ ...doc.robot!.joints[0], mimic: undefined }].map(({ mimic: _m, ...j }) => j));
    // Reading what was written gives the same text again.
    expect(serializeDoc(parseDoc(serializeDoc(back)))).toBe(serializeDoc(back));
  });

  it('leaves a design without a robot without one', () => {
    const doc = emptyDoc();
    doc.scene = [base('aaaaaaaa', 'Body')];
    expect(serializeDoc(doc)).not.toContain('"robot"');
    expect(parseDoc(serializeDoc(doc)).robot).toBeUndefined();
  });
});
