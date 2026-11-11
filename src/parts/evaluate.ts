// Ported from Gearwright (src/geometry/evaluate.ts). Turns a Solid description
// into a Manifold: what PlastikCAD's kernel builds a part with. The generator
// tests go through `evaluate` in testing.ts, which calls this the same way.
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Solid } from './types';

/** Turns a Solid description into a Manifold. Every kernel object made along the way is handed to `keep`. */
export function buildSolid(k: ManifoldToplevel, solid: Solid, keep: <T extends { delete(): void }>(o: T) => T): Manifold {
  const build = (s: Solid): Manifold => {
    switch (s.op) {
      case 'extrude': {
        const cs = keep(new k.CrossSection(s.shape, 'EvenOdd'));
        const twist = s.twist ?? 0;
        const divisions = s.divisions ?? (twist ? Math.ceil(Math.abs(twist) / 3) : 0);
        const scale = s.scaleTop ?? 1;
        // The scalar form of scaleTop is mishandled by the JS bindings; always pass a vector.
        return keep(cs.extrude(s.height, divisions, twist, [scale, scale]));
      }
      case 'revolve': {
        const cs = keep(new k.CrossSection([s.profile], 'EvenOdd'));
        return keep(cs.revolve(s.segments ?? 0));
      }
      case 'cylinder':
        return keep(k.Manifold.cylinder(s.height, s.radius, s.radiusTop ?? s.radius, s.segments ?? 0));
      case 'mesh': {
        const mesh = new k.Mesh({
          numProp: 3,
          vertProperties: Float32Array.from(s.positions),
          triVerts: Uint32Array.from(s.triangles),
        });
        mesh.merge();
        // Through the class behind `k.Manifold`: the wrapper throws on a mesh that is not manifold
        // without freeing the solid it made. Made this way it is kept, so it is freed with the rest.
        const Raw = Object.getPrototypeOf(k.Manifold.prototype).constructor as new (mesh: unknown) => Manifold;
        const made = keep(new Raw(mesh));
        const status = made.status();
        if (status !== 'NoError') throw new Error(`Geometry kernel error: ${status}`);
        return made;
      }
      case 'union':
        return keep(k.Manifold.union(s.children.map(build)));
      case 'intersection':
        return keep(k.Manifold.intersection(s.children.map(build)));
      case 'difference': {
        const [base, ...cutters] = s.children.map(build);
        if (cutters.length === 0) return base;
        return keep(base.subtract(cutters.length === 1 ? cutters[0] : keep(k.Manifold.union(cutters))));
      }
      case 'transform': {
        let m = build(s.child);
        if (s.mirror) m = keep(m.mirror(s.mirror));
        if (s.rotate) m = keep(m.rotate(s.rotate));
        if (s.translate) m = keep(m.translate(s.translate));
        return m;
      }
    }
  };
  return build(solid);
}
