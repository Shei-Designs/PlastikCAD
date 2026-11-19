// The reference robots that drive on plain wheels are their own mirror image across their middle: a robot that is
// not would drift off its line in every simulator, and rightly. Each part named for one side has its twin on the
// other, the same shape and size, turned the same way (so the twins' axles lie on one line) and placed alike but for
// the side; each part named for neither stands on the middle; the twins' links and joints carry the same figures.
import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../model/types';
import { ROBOTS } from './fixtures';

const side = (n: string): 'left' | 'right' | null => (/\bleft\b/i.test(n) ? 'left' : /\bright\b/i.test(n) ? 'right' : null);
const twinName = (n: string): string => n.replace(/\bleft\b/i, (m) => (m[0] === 'L' ? 'Right' : 'right'));

describe.each(['car', 'rover', 'long', 'two'])('the reference %s', (which) => {
  const doc = ROBOTS.find((r) => r.file === which)!.make();
  const robot = doc.robot!;
  const nodes = new Map(doc.scene.map((n) => [n.id, n]));
  const byName = new Map(doc.scene.map((n) => [n.name, n]));
  const pairs: [SceneNode, SceneNode][] = doc.scene.filter((n) => side(n.name) === 'left').map((n) => [n, byName.get(twinName(n.name))!]);

  it('has a twin across its middle for every part named for a side, and nothing else off the middle', () => {
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length * 2 + doc.scene.filter((n) => !side(n.name)).length).toBe(doc.scene.length);
    for (const [l, r] of pairs) {
      expect(r, l.name).toBeDefined();
      const kind = (n: SceneNode) => (n.type === 'shape' ? n.shape : n.type);
      expect([kind(r), r.size, r.rot], l.name).toEqual([kind(l), l.size, l.rot]);
      expect([-r.pos[0], r.pos[1], r.pos[2]], l.name).toEqual(l.pos);
      expect(l.pos[0], l.name).toBeLessThan(0);
    }
    for (const n of doc.scene.filter((x) => !side(x.name))) {
      expect(n.pos[0], n.name).toBe(0);
      expect(n.rot[1] === 0 && n.rot[2] === 0, n.name).toBe(true);
    }
    for (const s of robot.sensors) expect(s.origin[0], s.name).toBe(0);
  });

  it('gives each twin the same link and joint figures, and the drive role of its own side', () => {
    const linkOf = (id: string) => robot.links.find((l) => l.node === id)!;
    const jointTo = (id: string) => robot.joints.find((j) => j.child === id);
    for (const [l, r] of pairs) {
      const { node: _a, ...ll } = linkOf(l.id);
      const { node: _b, ...rl } = linkOf(r.id);
      expect(rl, l.name).toEqual(ll);
      const lj = jointTo(l.id);
      const rj = jointTo(r.id);
      if (!lj) {
        expect(rj, l.name).toBeUndefined();
        continue;
      }
      const figures = (j: typeof lj) => ({ type: j.type, origin: j.origin, axis: j.axis, lower: j.lower, upper: j.upper, effort: j.effort, velocity: j.velocity, damping: j.damping, friction: j.friction, motor: j.motor, parent: side(nodes.get(j.parent)!.name) });
      expect({ ...figures(rj!), parent: side(nodes.get(rj!.parent)!.name) === 'right' ? 'left' : side(nodes.get(rj!.parent)!.name) }, l.name).toEqual(figures(lj));
      const roles = robot.drive?.roles ?? {};
      expect(roles[rj!.id], l.name).toBe(roles[lj.id]?.replace('left', 'right'));
    }
  });
});
