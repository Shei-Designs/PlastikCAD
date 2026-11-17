// A wheel that is not the Mecanum wheel part made into one where it stands:
// the settings it is given, where it is put, and what of the robot is kept.
import { describe, expect, it } from 'vitest';
import { apply } from '../model/math';
import type { Doc, PartNode, SceneNode, Vec3 } from '../model/types';
import { defaultParams } from '../geometry/shapes';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { MECANUM_SIZES, mecanumRollers } from '../parts/generators/wheels';
import { checkRobot } from './check';
import { mecanumRover } from './fixtures';
import { ownFrame } from './inertia';
import { jointInDesign, linkNodes, sensorInDesign } from './model';
import { mecanumSettings, withMecanumWheel } from './replaceWheel';
import { defaultLink, defaultSensor } from './types';
import type { Robot } from './types';
import { handFor, leansRight, mecanumOf } from './wheels';

const figuresOf = (p: Record<string, string | number | boolean>) => mecanumRollers(sanitizeParams(getGenerator('mecanum-wheel'), p));
const whole = (p: Record<string, string | number | boolean>) => figuresOf(p).reach >= (2 * Math.PI) / figuresOf(p).count - 1e-9;

/** The reference mecanum rover with each wheel a plain cylinder of the same box: what a robot file brings in. */
function onCylinders(size: Vec3 = [100, 100, 50]): Doc {
  const doc = mecanumRover();
  const scene = doc.scene.map((n): SceneNode => (n.type === 'part' ? { id: n.id, name: n.name, type: 'shape', shape: 'cylinder', params: defaultParams('cylinder'), pos: n.pos, rot: n.rot, size, hole: false, color: '#445566' } : n));
  return { ...doc, scene };
}

const errors = (doc: Doc) => checkRobot(doc, new Map()).filter((p) => p.level === 'error');
const replaceAll = (doc: Doc): Doc => {
  let { scene, robot } = { scene: doc.scene, robot: doc.robot! };
  for (const p of errors(doc)) {
    if (p.fix !== 'mecanum-wheel') continue;
    const next = withMecanumWheel(scene, robot, p.link!)!;
    ({ scene, robot } = next);
  }
  return { ...doc, scene, robot };
};

describe('the settings a replaced wheel is given', () => {
  it('are a size sold where the wheel measures as one', () => {
    for (const size of MECANUM_SIZES) {
      const m = figuresOf({ size });
      expect(mecanumSettings(2 * m.radius + 0.2, m.width - 0.3)).toEqual({ size });
    }
  });

  it("are a custom wheel of its diameter and width otherwise, with the nearest size's count where that leaves no gaps", () => {
    const p = mecanumSettings(96, 48);
    expect(p).toMatchObject({ size: 'custom', diameter: 96, width: 48 });
    expect(whole(p)).toBe(true);
    // The 100 mm wheel's nine.
    expect(p.rollers).toBe(9);
  });

  it('never leave gaps: another count is taken, and a thin disc is made as much wider as it takes', () => {
    for (const d of [30, 48, 65, 90, 127, 180, 250, 300]) {
      for (const w of [10, 15, 20, 30, 45, 80, 150]) {
        const p = mecanumSettings(d, w);
        expect(whole(p), `${d} × ${w}`).toBe(true);
        if (p.size === 'custom') {
          expect(p.diameter).toBe(d);
          expect(p.width as number).toBeGreaterThanOrEqual(w);
        }
      }
    }
    const thin = mecanumSettings(100, 12);
    expect(thin.width as number).toBeGreaterThan(12);
    // And no wider than it must be: half a millimeter less leaves gaps at every count.
    expect(Array.from({ length: 15 }, (_, i) => whole({ ...thin, width: (thin.width as number) - 0.5, rollers: 6 + i })).some(Boolean)).toBe(false);
  });

  it('keep to what the part can be', () => {
    expect(mecanumSettings(1000, 500)).toMatchObject({ diameter: 300, width: 150 });
    expect(mecanumSettings(5, 1).diameter).toBe(30);
  });
});

describe('replacing a wheel with the Mecanum wheel part', () => {
  it('is offered for a wheel that is not the part, and clears every error of the drive', () => {
    const doc = onCylinders();
    const before = errors(doc);
    expect(before.length).toBe(4);
    expect(before.every((p) => p.fix === 'mecanum-wheel' && p.link)).toBe(true);
    expect(errors(replaceAll(doc))).toEqual([]);
  });

  it('puts the part where the wheel was: same id and name, its axle on the joint, its middle where the box had it', () => {
    const doc = onCylinders();
    const after = replaceAll(doc);
    const reference = mecanumRover();
    for (const old of doc.scene.slice(1)) {
      const node = after.scene.find((n) => n.id === old.id) as PartNode;
      expect(node.type).toBe('part');
      expect(node.part).toBe('mecanum-wheel');
      expect(node.name).toBe(old.name);
      expect(node.color).toBe(old.color);
      expect(node.params.size).toBe('100');
      expect(node.size).toEqual([100, 100, 50]);
      node.pos.forEach((x, i) => expect(x).toBeCloseTo(old.pos[i], 6));
      const joint = after.robot!.joints.find((j) => j.child === old.id)!;
      const was = jointInDesign(doc.robot!.joints.find((j) => j.child === old.id)!, old);
      const now = jointInDesign(joint, node);
      now.origin.forEach((x, i) => expect(x).toBeCloseTo(was.origin[i], 3));
      now.axis.forEach((x, i) => expect(x).toBeCloseTo(was.axis[i], 3));
      // The part's own Z is the axle.
      const z = apply(ownFrame({ ...node, pos: [0, 0, 0] }), [0, 0, 1]);
      expect(Math.abs(z[0] * was.axis[0] + z[1] * was.axis[1] + z[2] * was.axis[2])).toBeCloseTo(1, 6);
      // Of the hand its corner wants, as the reference rover's wheel there is.
      const role = after.robot!.drive!.roles[joint.id];
      expect(node.params.hand).toBe(handFor(role));
      expect(node.params.hand).toBe((reference.scene.find((n) => n.name === old.name) as PartNode).params.hand);
      const found = mecanumOf(node);
      expect(typeof found).not.toBe('string');
      if (typeof found !== 'string') expect(leansRight(found, role, [0, 1, 0])).toBe(true);
    }
    // The drive and its parts are as they were.
    expect(after.robot!.drive).toEqual(doc.robot!.drive);
    expect(after.robot!.joints.map((j) => j.id)).toEqual(doc.robot!.joints.map((j) => j.id));
  });

  it("takes its size from the box about and along the axle, whichever of the object's own sides that is", () => {
    const doc = onCylinders();
    const wheel = doc.scene[1];
    const joint = doc.robot!.joints.find((j) => j.child === wheel.id)!;
    // The same wheel drawn lying along its own X: 80 across, 37.4 wide.
    const lying: SceneNode = { ...wheel, size: [37.4, 80, 80], rot: [0, 0, 0] };
    const robot: Robot = { ...doc.robot!, joints: doc.robot!.joints.map((j) => (j.id === joint.id ? { ...j, axis: [1, 0, 0] } : j)) };
    const next = withMecanumWheel(doc.scene.map((n) => (n.id === wheel.id ? lying : n)), robot, wheel.id)!;
    const node = next.scene.find((n) => n.id === wheel.id) as PartNode;
    expect(node.params.size).toBe('80');
    expect(node.size).toEqual([80, 80, 37.4]);
    const z = apply(ownFrame({ ...node, pos: [0, 0, 0] }), [0, 0, 1]);
    expect(Math.abs(z[0])).toBeCloseTo(1, 6);
  });

  it('keeps the link: its name, its friction, its weighed mass with the center where it was, and sensors where they were', () => {
    const doc = onCylinders();
    const wheel = doc.scene[1];
    const sensor = { ...defaultSensor('s1', 'Touch', 'touch', wheel.id, [3, -4, 5]), rot: [10, 20, 30] as Vec3 };
    const link = { ...defaultLink(wheel.id), name: 'wheel_fl', friction: 0.6, collision: 'cylinder' as const, shape: { size: [100, 100, 50] as Vec3, center: [0, 0, 0] as Vec3, rot: [0, 0, 0] as Vec3 }, mass: { kind: 'measured' as const, grams: 240, center: [1, 2, 3] as Vec3, inertia: [300, 300, 500, 0, 0, 0] as [number, number, number, number, number, number] } };
    const robot: Robot = { ...doc.robot!, links: [...doc.robot!.links, link], sensors: [...doc.robot!.sensors, sensor] };
    const next = withMecanumWheel(doc.scene, robot, wheel.id)!;
    const node = next.scene.find((n) => n.id === wheel.id)!;
    const kept = next.robot.links.find((l) => l.node === wheel.id)!;
    expect(kept.name).toBe('wheel_fl');
    expect(kept.friction).toBe(0.6);
    expect(kept.collision).toBe('cylinder');
    expect(kept.shape).toBeUndefined();
    expect(kept.mass.kind).toBe('measured');
    if (kept.mass.kind !== 'measured') return;
    expect(kept.mass.grams).toBe(240);
    const was = apply(ownFrame(wheel), [1, 2, 3]);
    apply(ownFrame(node), kept.mass.center!).forEach((x, i) => expect(x).toBeCloseTo(was[i], 3));
    // Round about the axle before and after: 500 about it, 300 across.
    expect(kept.mass.inertia![2]).toBeCloseTo(500, 6);
    expect(kept.mass.inertia![0]).toBeCloseTo(300, 6);
    const before = sensorInDesign(sensor, wheel);
    const after = sensorInDesign(next.robot.sensors.find((x) => x.id === 's1')!, node);
    after.origin.forEach((x, i) => expect(x).toBeCloseTo(before.origin[i], 3));
    after.matrix.slice(0, 9).forEach((x, i) => expect(x).toBeCloseTo(before.matrix[i], 3));
  });

  it('makes a wheel that collided with nothing collide: its rollers are what carries the robot', () => {
    const doc = onCylinders();
    const wheel = doc.scene[1];
    const robot: Robot = { ...doc.robot!, links: [...doc.robot!.links, { ...defaultLink(wheel.id), collision: 'none' }] };
    const next = withMecanumWheel(doc.scene, robot, wheel.id)!;
    expect(next.robot.links.find((l) => l.node === wheel.id)!.collision).toBe('hull');
    // A wheel with no settings of its own stays without: it is a link with the defaults, and a wheel part's grip.
    const bare = withMecanumWheel(doc.scene, doc.robot!, wheel.id)!;
    expect(bare.robot.links.some((l) => l.node === wheel.id)).toBe(false);
  });

  it('is offered for a part stretched unevenly too, and gives back a whole wheel of its box', () => {
    const doc = mecanumRover();
    const wheel = doc.scene[1] as PartNode;
    const stretched: Doc = { ...doc, scene: doc.scene.map((n) => (n.id === wheel.id ? { ...wheel, size: [100, 100, 70] as Vec3 } : n)) };
    const [problem] = errors(stretched);
    expect(problem.fix).toBe('mecanum-wheel');
    const next = withMecanumWheel(stretched.scene, stretched.robot!, wheel.id)!;
    const node = next.scene.find((n) => n.id === wheel.id) as PartNode;
    expect(node.params).toMatchObject({ size: 'custom', diameter: 100, width: 70 });
    expect(errors({ ...stretched, ...next })).toEqual([]);
  });

  it('tells of a wheel it had to widen, and of no other', () => {
    const thin = onCylinders([100, 100, 12]);
    const made = withMecanumWheel(thin.scene, thin.robot!, errors(thin).find((p) => p.fix === 'mecanum-wheel')!.link!)!;
    expect(made.widened!.was).toBe(12);
    expect(made.widened!.now).toBeGreaterThan(12);
    expect(made.widened!.now).toBe((made.scene.find((n) => n.type === 'part') as PartNode).size[2]);
    // A wheel of a size sold, and one wide enough as it is, keep their width and say nothing.
    for (const size of [[100, 100, 50], [100, 100, 49.6], [90, 90, 60]] as Vec3[]) {
      const doc = onCylinders(size);
      expect(withMecanumWheel(doc.scene, doc.robot!, errors(doc).find((p) => p.fix === 'mecanum-wheel')!.link!)!.widened).toBeUndefined();
    }
  });

  it('does nothing for an object that is no wheel of a mecanum drive', () => {
    const doc = onCylinders();
    expect(withMecanumWheel(doc.scene, doc.robot!, doc.scene[0].id)).toBeNull();
    expect(withMecanumWheel(doc.scene, { ...doc.robot!, drive: { ...doc.robot!.drive!, kind: 'differential' } }, doc.scene[1].id)).toBeNull();
    expect(linkNodes(doc.scene).length).toBe(5);
  });
});
