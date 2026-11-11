import { describe, expect, it } from 'vitest';
import { canonicalRobot, emptyDoc, legacyVersions, NewerVersion, parseDoc, parseDocWithout, readHeader, ROBOT_FIELDS, savedTime, serializeDoc } from './file';
import { geomKey } from './geomKey';
import { apply, axisRotation, determinant, eulerOf, multiply, nodeMatrix, rotation } from './math';
import type { Mat } from './math';
import { alignNodes, arrayNodes, arrayPlaces, boxBoundsOf, cloneNode, dissolve, frameAlong, layerMembers, makeGroup, makeShape, mirrorNodes, nodeAt, picturesOf, regroup, rotateNodes, scaleNodes, sourceColor, ungroup, usedAssets } from './ops';
import type { Doc, GroupNode, PictureNode, SceneNode, ShapeNode, Vec3 } from './types';
import { defaultJoint, defaultSensor, emptyRobot } from '../robot/types';
import type { Robot } from '../robot/types';
import { FILE_VERSION } from '../appInfo';
import { GENERATORS } from '../parts/generators';
import { defaultParams } from '../parts/generators/types';

/** A design file as an older build wrote it: the same text under the format version before this one read strictly. */
const older = (text: string): string => text.replace(`"version": ${FILE_VERSION}`, '"version": 2');

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

  it('turns a node about its own axis (Object axes)', () => {
    const start = shape('box', { pos: [5, 0, 0], rot: [0, 0, 45] });
    const frame: Mat = [...rotation(start.rot).slice(0, 9), 0, 0, 0] as Mat;
    // A quarter turn about the box's own X, through its middle: its X stays put, its Z lies down along -Y of its own.
    const [node] = rotateNodes([start], 0, 90, start.pos, frame);
    close(node.pos, [5, 0, 0]);
    close(rotation(node.rot), multiply(rotation(start.rot), axisRotation(0, 90)));
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
    expect(sourceColor(group, [0])).toBe('#ff0000');
    expect(sourceColor(group, [1])).toBe('#0000ff');
    expect(sourceColor(group, [2])).toBe('#ff0000');
    expect(sourceColor(group, [7])).toBe(group.color);
    // A copy has ids of its own, and the same places.
    expect(sourceColor(cloneNode(group), [1])).toBe('#0000ff');
  });

  it('lets a painted group inside color everything beneath it, and a mixed one show through', () => {
    const inner = makeGroup([red, blue], bounds, 'Inner');
    const outer = makeGroup([inner, bore], bounds, 'Outer');
    expect(sourceColor(outer, [0, 1])).toBe('#0000ff');
    const painted = makeGroup([{ ...inner, mixed: undefined, color: '#abcdef' }, bore], bounds, 'Outer');
    expect(sourceColor(painted, [0, 1])).toBe('#abcdef');
    // The hole's cut faces take the first solid's paint, through a mixed group to its first solid.
    expect(sourceColor(outer, [1])).toBe('#ff0000');
    expect(sourceColor(painted, [1])).toBe('#abcdef');
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
    const label: SceneNode = { ...shape('box'), type: 'text', text: 'M8\nleft', font: 'stencil', align: 'center', curve: { kind: 'arc', angle: 120, flip: true, thickness: 1.5 }, natural: [14, 16, 1] } as unknown as SceneNode;
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
    const back = parseDoc(older(serializeDoc({ ...doc, scene: [...doc.scene, gone, kept] })));
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
    expect(() => parseDoc(serializeDoc(emptyDoc()).replace(`"version": ${FILE_VERSION}`, '"version": 99'))).toThrow(/newer/);
    expect(() => parseDoc('{"format":"plastikcad","scene":[]}')).toThrow(/which version/);
  });

  it('skips what a file from an older version of the format names that the app no longer has', () => {
    const text = older(serializeDoc(sample())).replace('"shape": "box"', '"shape": "teapot"');
    expect(parseDoc(text).scene.length).toBe(3);
  });

  /** A design with a robot over it and a part that has a choice, as text, and the changes a newer build might have made to it. */
  const withRobot = () => {
    const robot: Robot = { ...emptyRobot(), root: 'a', links: [{ node: 'a', mass: { kind: 'material', material: 'pla', infill: 20, shell: 1.2 }, collision: 'hull', friction: 0.8 }], joints: [{ id: 'j1', name: 'j', type: 'revolute', parent: 'a', child: 'b', origin: [0, 0, 0], axis: [0, 0, 1], lower: -90, upper: 90, effort: 1, velocity: 1, damping: 0, friction: 0 }], sensors: [defaultSensor('s1', 'cam', 'camera', 'a', [0, 0, 0])], drive: { kind: 'differential', roles: { j1: 'left' } }, world: 'slope' };
    const def = GENERATORS.find((g) => g.groups.some((group) => group.params.some((d) => d.type === 'select')))!;
    const choice = def.groups.flatMap((g) => g.params).find((d) => d.type === 'select')!;
    const params = defaultParams(def);
    const gear = { ...shape('box'), id: 'b', type: 'part', part: def.id, params, natural: [20, 20, 5] } as unknown as SceneNode;
    delete (gear as { shape?: unknown }).shape;
    const text = serializeDoc({ ...sample(), scene: [{ ...shape('box'), id: 'a' }, gear, ...sample().scene.slice(1)], robot });
    return { text, def, option: [`"${choice.key}": "${String(params[choice.key])}"`, `"${choice.key}": "from-the-future"`] as [string, string] };
  };

  it('refuses a file in its own format that names something it does not know, rather than dropping it and saving the rest', () => {
    const { text, def, option } = withRobot();
    expect(parseDoc(text).robot?.sensors.length).toBe(1);
    const key = Object.keys(defaultParams(def)).sort()[0];
    const newer: [string, string][] = [
      // A kind of thing this build has not got: a shape, an object, a part, a choice, a font, imported data, and the same in the robot.
      ['"shape": "torus"', '"shape": "teapot"'],
      ['"type": "text"', '"type": "hologram"'],
      [`"part": "${def.id}"`, '"part": "warp-gear"'],
      option,
      ['"font": "stencil"', '"font": "comic"'],
      ['"kind": "outline"', '"kind": "voxels"'],
      ['"kind": "camera"', '"kind": "sonar"'],
      ['"type": "revolute"', '"type": "spherical"'],
      ['"collision": "hull"', '"collision": "capsules"'],
      ['"kind": "differential"', '"kind": "tracked"'],
      ['"world": "slope"', '"world": "moon"'],
      // A field it has no name for: on an object, on lettering, among a part's settings, in the robot, on the design itself.
      ['"shape": "torus",', '"shape": "torus",\n          "fillet": 2,'],
      ['"kind": "arc",', '"kind": "arc",\n        "spiral": true,'],
      [`"${key}": `, `"aaa-new-setting": 4,\n        "${key}": `],
      ['"collision": "hull",', '"collision": "hull",\n        "restitution": 0.4,'],
      ['"units": "mm",', '"units": "mm",\n  "materials": {},'],
    ];
    for (const [known, unknown] of newer) {
      expect(text, known).toContain(known);
      const changed = text.replace(known, unknown);
      expect(() => parseDoc(changed), unknown).toThrow(NewerVersion);
      expect(() => parseDoc(changed), unknown).toThrow(/newer version/);
      // The same in a file from before: read as it always was, without the thing.
      expect(() => parseDoc(older(changed)), unknown).not.toThrow();
    }
  });

  it('refuses a strict file whose imported data carries a field it does not know, and reads the same from before', () => {
    const withAssets = (extra: Record<string, unknown>, version: number): string => {
      const raw = JSON.parse(serializeDoc(emptyDoc())) as Record<string, unknown>;
      raw.version = version;
      raw.assets = {
        m1: { kind: 'mesh', positions: 'AAAA', triangles: 'AAAA', ...(extra.mesh as object) },
        o1: { kind: 'outline', shapes: [{ contours: [[[0, 0], [1, 0], [0, 1]]], evenodd: false, ...(extra.shape as object) }], ...(extra.outline as object) },
        i1: { kind: 'image', name: 'a.png', mime: 'image/png', data: 'AAAA', width: 2, height: 2, ...(extra.image as object) },
      };
      return JSON.stringify(raw, null, 2);
    };
    expect(Object.keys(parseDoc(withAssets({}, 3)).assets).sort()).toEqual(['i1', 'm1', 'o1']);
    for (const extra of [{ mesh: { normals: 'AAAA' } }, { outline: { units: 'mm' } }, { shape: { stroke: 1 } }, { image: { dpi: 300 } }]) {
      expect(() => parseDoc(withAssets(extra, 3)), JSON.stringify(extra)).toThrow(NewerVersion);
      expect(Object.keys(parseDoc(withAssets(extra, 2)).assets).length, JSON.stringify(extra)).toBe(3);
    }
  });

  it('reads a newer build\'s file for a copy, leaving out what it does not know and saying how much that was', () => {
    const { text, def, option } = withRobot();
    const whole = parseDoc(text);
    // Nothing unknown: nothing left out, and the same design.
    expect(parseDocWithout(text)).toEqual({ doc: whole, left: 0 });
    // An object of a kind this build has not got is left out, and the rest is all there.
    const without = parseDocWithout(text.replace('"type": "text"', '"type": "hologram"'));
    expect(without.left).toBe(1);
    expect(without.doc.scene.length).toBe(whole.scene.length - 1);
    expect(without.doc.scene.some((n) => n.type === 'text')).toBe(false);
    // One inside a group goes, and the group stays with what is left of it.
    const torus = parseDocWithout(text.replace('"shape": "torus"', '"shape": "teapot"'));
    expect(torus.left).toBe(1);
    expect(torus.doc.scene.find((n) => n.type === 'group')).toMatchObject({ children: [{ shape: 'cone' }] });
    // A choice this build does not offer comes back as the first one that it does; a field it has no name for goes, and the object stays.
    const choice = parseDocWithout(text.replace(...option));
    expect(choice.left).toBe(1);
    expect(choice.doc.scene.find((n) => n.type === 'part')).toEqual(whole.scene.find((n) => n.type === 'part'));
    const field = parseDocWithout(text.replace('"shape": "torus",', '"shape": "torus",\n          "fillet": 2,'));
    expect(field).toEqual({ doc: whole, left: 1 });
    // A sensor of a kind it does not know goes; the robot stays.
    const sonar = parseDocWithout(text.replace('"kind": "camera"', '"kind": "sonar"'));
    expect(sonar.left).toBe(1);
    expect(sonar.doc.robot).toMatchObject({ root: 'a', sensors: [] });
    expect(sonar.doc.robot?.joints.length).toBe(1);
    // Several things at once are each counted.
    const many = text.replace('"type": "text"', '"type": "hologram"').replace('"shape": "torus"', '"shape": "teapot"').replace(`"part": "${def.id}"`, '"part": "warp-gear"');
    expect(parseDocWithout(many).left).toBe(3);
    // What comes of it is this build's own: it is read back whole, with nothing more to leave out.
    expect(parseDocWithout(serializeDoc(parseDocWithout(many).doc)).left).toBe(0);
    // And the next file is read strictly again.
    expect(() => parseDoc(many)).toThrow(NewerVersion);
  });

  it('refuses a file of a later version of the format, and reads what it can of it for a copy', () => {
    const text = serializeDoc(sample()).replace(`"version": ${FILE_VERSION}`, `"version": ${FILE_VERSION + 1}`);
    expect(() => parseDoc(text)).toThrow(NewerVersion);
    expect(parseDocWithout(text).doc.scene.length).toBe(parseDoc(serializeDoc(sample())).scene.length);
    // What is not a design at all is not one for a copy either.
    expect(() => parseDocWithout('{"format": "other", "version": 9}')).toThrow(/not a design/);
  });

  it('knows every field it writes for a robot as one it can read', () => {
    const robot: Robot = {
      ...emptyRobot(),
      root: 'a',
      links: [
        { node: 'a', name: 'base', mass: { kind: 'material', material: 'pla', infill: 20, shell: 1.2 }, collision: 'hull', friction: 0.8 },
        { node: 'b', mass: { kind: 'measured', grams: 12 }, collision: 'hull', friction: 0.8 },
      ],
      joints: [
        { id: 'j1', name: 'j', type: 'revolute', parent: 'a', child: 'b', origin: [0, 0, 0], axis: [0, 0, 1], lower: -90, upper: 90, effort: 1, velocity: 1, damping: 0, friction: 0, motor: 'sg90' },
        { id: 'j2', name: 'k', type: 'revolute', parent: 'a', child: 'b', origin: [0, 0, 0], axis: [0, 0, 1], lower: -90, upper: 90, effort: 1, velocity: 1, damping: 0, friction: 0, mimic: { joint: 'j1', multiplier: 1, offset: 0 } },
      ],
      sensors: [defaultSensor('s1', 'cam', 'camera', 'a', [0, 0, 0]), defaultSensor('s2', 'scan', 'lidar', 'a', [0, 0, 0])],
      drive: { kind: 'differential', roles: { j1: 'left' } },
      control: false,
      world: 'slope',
      scripts: false,
    };
    const written = canonicalRobot(robot) as Record<string, Record<string, unknown>[] & Record<string, unknown>>;
    const fields = (record: object): string[] => Object.entries(record).filter(([, v]) => v !== undefined).map(([k]) => k);
    const check = (records: object[], known: ReadonlySet<string>, what: string): void => {
      expect(records.length, what).toBeGreaterThan(0);
      for (const record of records) expect(fields(record).filter((k) => !known.has(k)), what).toEqual([]);
    };
    const part = (records: Record<string, unknown>[], key: string): object[] => records.map((r) => r[key]).filter((v): v is object => typeof v === 'object' && v !== null);
    check([written], ROBOT_FIELDS.robot, 'robot');
    // Everything the robot can hold is in this one: no field goes unchecked for want of an example.
    expect(fields(written).sort()).toEqual([...ROBOT_FIELDS.robot].sort());
    check(written.links, ROBOT_FIELDS.link, 'link');
    check(part(written.links, 'mass'), ROBOT_FIELDS.mass, 'mass');
    check(written.joints, ROBOT_FIELDS.joint, 'joint');
    check(part(written.joints, 'mimic'), ROBOT_FIELDS.mimic, 'mimic');
    check(written.sensors, ROBOT_FIELDS.sensor, 'sensor');
    check(part(written.sensors, 'camera'), ROBOT_FIELDS.camera, 'camera');
    check(part(written.sensors, 'lidar'), ROBOT_FIELDS.lidar, 'lidar');
    check([written.drive], ROBOT_FIELDS.drive, 'drive');
    // And the design with it is read back as this build's own.
    const doc = parseDoc(serializeDoc({ ...sample(), scene: [{ ...shape('box'), id: 'a' }, { ...shape('box'), id: 'b' }], assets: {}, robot }));
    expect(doc.robot?.joints.length).toBe(2);
    expect(doc.robot?.sensors.length).toBe(2);
  });

  it('stores lettering as its words, and falls back to a font it knows', () => {
    const text = serializeDoc(sample());
    expect(text).toContain('"text": "M8\\nleft"');
    const [label] = parseDoc(older(text).replace('"font": "stencil"', '"font": "comic"')).scene.slice(-1);
    expect(label.type === 'text' && label.font).toBe('sans');
  });

  it('drops a part named like an object method instead of choking on it', () => {
    const doc = sample();
    const parts = ['toString', 'constructor', '__proto__', 'hasOwnProperty'].map((part, i) => {
      const node = { ...shape('box'), id: `p${i}`, type: 'part', part, params: {}, natural: [10, 10, 10] } as unknown as SceneNode;
      delete (node as { shape?: unknown }).shape;
      return node;
    });
    const text = serializeDoc({ ...doc, scene: [...doc.scene, ...parts] });
    expect(() => parseDoc(text)).toThrow(/newer version/);
    expect(parseDocWithout(text)).toMatchObject({ left: 4, doc: { scene: { length: doc.scene.length } } });
    const back = parseDoc(older(text));
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
    expect(readHeader(text)).toEqual({ id: 'proj0001', name: 'Hinge "left"', revision: null, saved: null, thumb: THUMB });
    // A file from when the app was BashCAD is the same file under another marker.
    const old = text.replace('"format": "plastikcad"', '"format": "bashcad"');
    expect(readHeader(old)).toEqual(readHeader(text));
    expect(parseDoc(old)).toEqual(parseDoc(text));
    expect(() => parseDoc(text.replace('"format": "plastikcad"', '"format": "othercad"'))).toThrow(/not a design made with this app/);
    // Only the start of the file, cut off inside the scene.
    expect(readHeader(text.slice(0, text.indexOf('"scene"') + 40))).toEqual({ id: 'proj0001', name: 'Hinge "left"', revision: null, saved: null, thumb: THUMB });
    // When it was saved is in the header too, for a folder to be listed newest first by.
    expect(readHeader(serializeDoc({ ...emptyDoc(), saved: '2026-11-08T09:30:00.000Z' }))?.saved).toBe(Date.parse('2026-11-08T09:30:00.000Z'));
    expect(parseDoc(text)).toEqual(doc());
  });

  it('does not mistake an object for the header of a file without an id', () => {
    const text = serializeDoc(doc()).replace('  "id": "proj0001",\n', '').replace(`  "thumb": "${THUMB}",\n`, '');
    expect(readHeader(text)).toEqual({ id: null, name: 'Hinge "left"', revision: null, saved: null, thumb: null });
    // Cut off before the scene: the objects' names and ids are nowhere near.
    const head = text.slice(0, text.indexOf('"scene"'));
    expect(readHeader(head)).toEqual({ id: null, name: 'Hinge "left"', revision: null, saved: null, thumb: null });
  });

  it('refuses what is not a design laid out by the app', () => {
    expect(readHeader('{"format":"plastikcad","version":2,"name":"Flat"}')).toBeNull();
    expect(readHeader('<svg/>')).toBeNull();
    // A design padded with a quarter of a megabyte of blank lines is read as quickly as any other: as one pattern over
    // any white space this took a minute, at every start of the app, for a file that only sat in the projects folder.
    const padded = serializeDoc({ ...emptyDoc(), id: 'proj0002', name: 'Padded' }).replace('"name"', `${'\n'.repeat(250_000)}  "name"`);
    expect(readHeader(padded)?.name).toBe('Padded');
    expect(readHeader(`{\n${'\n'.repeat(250_000)}`)).toBeNull();
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
    const text = serializeDoc({ ...d, assets: { img: { kind: 'image', name: 'x', mime: 'image/png', data: PNG, width: 1, height: 1 } } }).replace('"kind": "image"', '"kind": 0');
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

describe('when a design says it was saved', () => {
  const zone = process.env.TZ;
  const noon = Date.UTC(2026, 10, 10, 12, 0, 0);

  it('reads the form the app writes, and the same moment written with an offset, alike in every time zone', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      expect(savedTime(new Date(noon).toISOString()), tz).toBe(noon);
      expect(savedTime('2026-11-10T12:00:00Z'), tz).toBe(noon);
      expect(savedTime('2026-11-10T12:00:00.250Z'), tz).toBe(noon + 250);
      expect(savedTime('2026-11-10T12:00:00.123456789Z'), tz).toBe(noon + 123);
      expect(savedTime('2026-11-10T13:00:00+01:00'), tz).toBe(noon);
      expect(savedTime('2026-11-10T04:00:00-08:00'), tz).toBe(noon);
    }
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('takes nothing an engine might read its own way, or that no design was saved at', () => {
    const not = [
      '2026-11-10', // no time
      '2026-11-10T12:00:00', // no offset: local time on one device, UTC on another
      '2026-11-10 12:00:00Z',
      '11/10/2026 12:00',
      'Tue Nov 10 2026 12:00:00 GMT+0100',
      '10 November 2026',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-11-10T24:00:00Z',
      '2026-11-10T12:60:00Z',
      '1970-01-21T19:25:00Z', // what a clock that was never set stamps
      '2400-01-01T00:00:00Z',
      '',
      1794310320000,
      null,
      undefined,
    ];
    for (const raw of not) expect(savedTime(raw), String(raw)).toBeNull();
  });

  it('keeps the stamp in a design as the app writes it, and drops one it cannot trust', () => {
    const at = (saved: string) => parseDoc(serializeDoc({ ...emptyDoc(), saved })).saved;
    expect(at('2026-11-10T12:00:00.000Z')).toBe('2026-11-10T12:00:00.000Z');
    expect(at('2026-11-10T13:00:00+01:00')).toBe('2026-11-10T12:00:00.000Z');
    expect(at('Tue Nov 10 2026 12:00:00')).toBeUndefined();
    expect(readHeader(serializeDoc({ ...emptyDoc(), saved: '11/10/2026' }))?.saved).toBeNull();
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

  it('reads the two sides of a drive from before drive kinds as a differential drive', () => {
    const doc = emptyDoc();
    doc.scene = [base('aaaaaaaa', 'Body'), base('bbbbbbbb', 'Wheel')];
    doc.robot = { root: 'aaaaaaaa', base: 'free', links: [], joints: [{ ...defaultJoint('j1', 'wheel', 'aaaaaaaa', 'bbbbbbbb', [0, 0, 0]), type: 'continuous' }], sensors: [], control: true };
    const text = serializeDoc(doc).replace('"root": "aaaaaaaa"', '"root": "aaaaaaaa", "drive": { "left": ["j1"], "right": ["gone"] }');
    expect(text).toContain('"left"');
    expect(parseDoc(text).robot?.drive).toEqual({ kind: 'differential', roles: { j1: 'left' } });
  });

  it('leaves a design without a robot without one', () => {
    const doc = emptyDoc();
    doc.scene = [base('aaaaaaaa', 'Body')];
    expect(serializeDoc(doc)).not.toContain('"robot"');
    expect(parseDoc(serializeDoc(doc)).robot).toBeUndefined();
  });
});
