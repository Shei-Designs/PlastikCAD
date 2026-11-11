// The design's objects rebuilt as true solids for a STEP file: a cylinder as
// a cylinder, a ball as a sphere, a drilled plate as a box with a round hole
// cut through it, a part from the profiles and operations its generator
// describes it by. The geometry kernel builds the same things from flat
// facets; OpenCascade (see occ.ts) can build them from the surfaces
// themselves, which is what a CAD program wants to pick and measure.
//
// Not everything can be rebuilt: a twisted extrusion (a helical gear, a
// thread), an imported mesh, lettering, a rounded rim, a shape stretched in a
// way that leaves no simple surface (a ball into an egg, an oval cone). `exactShape` then answers null, and the
// writer falls back on the kernel's own facets (see stepExport.ts). It also
// falls back when what was rebuilt does not match the kernel's solid in
// volume and extent, or does not come back from a STEP file as it went in:
// nothing goes out on trust.
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { clampParams, regularPolygon, ROUND } from '../geometry/shapes';
import { flipSigns, rotation } from '../model/math';
import type { Bounds } from '../model/math';
import type { GroupNode, PartNode, SceneNode, ShapeNode, Vec3 } from '../model/types';
import { getGenerator } from '../parts/generators';
import { sanitizeParams } from '../parts/generators/types';
import { QUALITY } from '../parts/types';
import type { Polygon, Shape2D, Solid, Swept } from '../parts/types';
import { traceArcs } from './arcs';
import { signedArea } from './outline';

type Oc = OpenCascadeInstance;
type Shape = InstanceType<Oc['TopoDS_Shape']>;
type Deletable = { delete(): void };
export type Keep = <T extends Deletable>(o: T) => T;

/** What the kernel knows of a part that its description does not say: its box as its generator makes it. */
export interface ExactTools {
  partBox(node: PartNode): Bounds | null;
}

/** Thrown inside the builders for something that has no exact form; caught by `exactShape`. */
class NoExactForm extends Error {}
const none = (): never => {
  throw new NoExactForm();
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

class Builder {
  constructor(
    readonly oc: Oc,
    readonly keep: Keep,
    readonly tools: ExactTools,
    /** Whether faces on one surface are made one (see `tidy`). */
    readonly join = true,
  ) {}

  point(x: number, y: number, z: number): InstanceType<Oc['gp_Pnt']> {
    return this.keep(new this.oc.gp_Pnt(x, y, z));
  }

  /** A frame at `at` whose main axis is `axis` and whose X is `x`. */
  frame(at: Vec3, axis: Vec3, x: Vec3): InstanceType<Oc['gp_Ax2']> {
    return this.keep(new this.oc.gp_Ax2(this.point(...at), this.keep(new this.oc.gp_Dir(...axis)), this.keep(new this.oc.gp_Dir(...x))));
  }

  /**
   * The solid a builder makes, or no exact form if it did not come off. The builders of solids do their
   * work when the shape is asked for, and say only then whether it came off.
   */
  result(builder: { Shape(): Shape; IsDone(): boolean } & Deletable): Shape {
    this.keep(builder);
    const shape = builder.Shape();
    if (!builder.IsDone()) none();
    return this.keep(shape);
  }

  /** A builder that has done its work on being made (an edge, a wire, a face), or no exact form if it did not come off. */
  done<T extends { IsDone(): boolean } & Deletable>(builder: T): T {
    this.keep(builder);
    if (!builder.IsDone()) none();
    return builder;
  }

  // --- flat outlines ---------------------------------------------------------------------------

  /**
   * A closed contour in a plane as a wire, its runs of corners on one circle as arcs (see arcs.ts).
   * `place` says where a point of the contour is in space.
   */
  wire(contour: Polygon, place: (p: [number, number]) => Vec3): InstanceType<Oc['TopoDS_Wire']> {
    const { oc } = this;
    const traced = traceArcs(contour);
    const maker = this.keep(new oc.BRepBuilderAPI_MakeWire());
    const at = (p: [number, number]) => this.point(...place(p));
    if ('circle' in traced) {
      // A circle in the contour's plane: found again from three of its points, wherever the plane lies.
      const { center, radius } = traced.circle;
      // Round the way the contour goes: that is what tells a hole from a rim.
      const way = signedArea(contour) < 0 ? -1 : 1;
      const arc = (from: number, to: number) => {
        const p = (a: number): [number, number] => [center[0] + radius * Math.cos(way * a), center[1] + radius * Math.sin(way * a)];
        const curve = this.done(new oc.GC_MakeArcOfCircle(at(p(from)), at(p((from + to) / 2)), at(p(to))));
        maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.keep(curve.Value()))).Edge());
      };
      arc(0, Math.PI);
      arc(Math.PI, 2 * Math.PI);
    } else {
      let from = traced.start;
      for (const side of traced.sides) {
        // A corner written twice makes a side of no length, which is no side.
        if (Math.hypot(side.to[0] - from[0], side.to[1] - from[1]) < 1e-6) continue;
        if (side.arc) {
          // The point half way round the arc, which with its ends says which arc it is.
          const { center, radius, sweep } = side.arc;
          const begin = Math.atan2(from[1] - center[1], from[0] - center[0]);
          const mid: [number, number] = [center[0] + radius * Math.cos(begin + sweep / 2), center[1] + radius * Math.sin(begin + sweep / 2)];
          const curve = this.done(new oc.GC_MakeArcOfCircle(at(from), at(mid), at(side.to)));
          maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.keep(curve.Value()))).Edge());
        } else maker.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(at(from), at(side.to))).Edge());
        from = side.to;
      }
    }
    if (!maker.IsDone()) none();
    return this.keep(maker.Wire());
  }

  /**
   * The faces of a flat shape filled by the even-odd rule: every contour that lies inside an even
   * number of the others is the rim of a face, and the contours right inside it are its holes.
   */
  faces(shape: Shape2D, place: (p: [number, number]) => Vec3): Shape[] {
    const { oc } = this;
    const contours = shape.filter((c) => c.length >= 3);
    const inside = (p: [number, number], c: Polygon): boolean => {
      let odd = false;
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
        if (c[i][1] > p[1] !== c[j][1] > p[1] && p[0] < ((c[j][0] - c[i][0]) * (p[1] - c[i][1])) / (c[j][1] - c[i][1]) + c[i][0]) odd = !odd;
      }
      return odd;
    };
    const depth = contours.map((c, i) => contours.filter((other, j) => j !== i && inside(c[0], other)).length);
    const out: Shape[] = [];
    // A rim goes round counterclockwise and its holes clockwise, whichever way they were drawn.
    const turned = (c: Polygon, ccw: boolean): Polygon => (signedArea(c) > 0 === ccw ? c : [...c].reverse());
    contours.forEach((rim, i) => {
      if (depth[i] % 2) return;
      const face = this.done(new oc.BRepBuilderAPI_MakeFace(this.wire(turned(rim, true), place), true));
      contours.forEach((hole, j) => {
        if (depth[j] === depth[i] + 1 && inside(hole[0], rim)) face.Add(this.wire(turned(hole, false), place));
      });
      if (!face.IsDone()) none();
      out.push(this.keep(face.Face()));
    });
    if (out.length === 0) none();
    return out;
  }

  /**
   * A flat face outlined by an arc of an oval and straight sides. The oval is centered at `center`,
   * reaches `across` along the plane's first direction and `up` along its second, and the arc runs
   * from angle `from` to `to` round it (radians, from the first direction towards the second); the
   * straight sides go on from the arc's end through `corners` and back to its start. `place` says
   * where a point of the plane is in space.
   */
  ovalFace(center: [number, number], across: number, up: number, from: number, to: number, corners: [number, number][], place: (p: [number, number]) => Vec3): Shape {
    const { oc } = this;
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const origin = place(center);
    const u = sub(place([center[0] + 1, center[1]]), origin);
    const v = sub(place([center[0], center[1] + 1]), origin);
    const normal: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    // An oval is given by its longer half first: when that is the one across, its angles are the arc's own; when it is the one up, a quarter turn less.
    const wide = across >= up;
    const oval = this.keep(new oc.gp_Elips(this.frame(origin, normal, wide ? u : v), Math.max(across, up), Math.min(across, up)));
    const turn = wide ? 0 : Math.PI / 2;
    const at = (a: number): [number, number] => [center[0] + across * Math.cos(a), center[1] + up * Math.sin(a)];
    const wire = this.keep(new oc.BRepBuilderAPI_MakeWire());
    wire.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(oval, from - turn, to - turn)).Edge());
    const path = [at(to), ...corners, at(from)];
    for (let i = 0; i + 1 < path.length; i++) {
      if (Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) < 1e-9) continue;
      wire.Add(this.done(new oc.BRepBuilderAPI_MakeEdge(this.point(...place(path[i])), this.point(...place(path[i + 1])))).Edge());
    }
    if (!wire.IsDone()) none();
    return this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(this.keep(wire.Wire()), true)).Face());
  }

  // --- solids ------------------------------------------------------------------------------------

  fuse(shapes: Shape[]): Shape {
    if (shapes.length === 0) none();
    let all = shapes[0];
    for (const next of shapes.slice(1)) all = this.result(new this.oc.BRepAlgoAPI_Fuse(all, next, this.keep(new this.oc.Message_ProgressRange())));
    return all;
  }

  cut(from: Shape, cutters: Shape[]): Shape {
    let left = from;
    for (const cutter of cutters) left = this.result(new this.oc.BRepAlgoAPI_Cut(left, cutter, this.keep(new this.oc.Message_ProgressRange())));
    return left;
  }

  /** A flat shape in the XY plane at `z`, raised by `height`. */
  prism(shape: Shape2D, z: number, height: number): Shape {
    const up = this.keep(new this.oc.gp_Vec(0, 0, height));
    return this.fuse(this.faces(shape, ([x, y]) => [x, y, z]).map((face) => this.result(new this.oc.BRepPrimAPI_MakePrism(face, up, false, true))));
  }

  /** A contour of (radius, height) points turned once round the Z axis. */
  turned(profile: Polygon): Shape {
    const axis = this.keep(new this.oc.gp_Ax1(this.point(0, 0, 0), this.keep(new this.oc.gp_Dir(0, 0, 1))));
    const [face] = this.faces([profile], ([r, z]) => [r, 0, z]);
    return this.result(new this.oc.BRepPrimAPI_MakeRevol(face, axis, false));
  }

  /** `shape` moved by a matrix of the app's (the images of X, Y and Z, then the translation): a turn and a move, and one size change for all three axes. */
  moved(shape: Shape, m: number[]): Shape {
    const move = this.keep(new this.oc.gp_Trsf());
    move.SetValues(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11]);
    return this.result(new this.oc.BRepBuilderAPI_Transform(shape, move, true, false));
  }

  /** `shape` seen in a mirror standing on the origin, square to `axis`. */
  mirrored(shape: Shape, axis: Vec3): Shape {
    const move = this.keep(new this.oc.gp_Trsf());
    move.SetMirror(this.frame([0, 0, 0], axis, axis[2] ? [1, 0, 0] : [0, 0, 1]));
    return this.result(new this.oc.BRepBuilderAPI_Transform(shape, move, true, false));
  }

  // --- sweeps: a pipe's section carried along its path ------------------------------------------

  /**
   * A lofted mesh from what it was lofted from, stretch by stretch: a section carried straight on
   * is a prism, one carried round a bend is turned about the bend's axis, and one that changes
   * size on the way is a cone when it is round and stays on its axis, and otherwise the surface
   * of straight lines from the one outline to the other. Anything else has no exact form.
   */
  swept({ stations, rings }: Swept): Shape {
    const { oc } = this;
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const along = (p: Vec3, d: Vec3, by: number): Vec3 => [p[0] + d[0] * by, p[1] + d[1] * by, p[2] + d[2] * by];
    const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
    const close = (a: Vec3, b: Vec3, within = 1e-6): boolean => length(sub(a, b)) <= within;
    const sameRing = (a: Polygon, b: Polygon): boolean => a.length === b.length && a.every((q, k) => Math.hypot(q[0] - b[k][0], q[1] - b[k][1]) <= 1e-9);
    type Station = Swept['stations'][number];
    const place = (s: Station) => ([x, y]: [number, number]): Vec3 => along(along(s.p, s.u, x), s.v, y);
    /** The section at a station as a face. */
    const section = (i: number): Shape => {
      const [face] = this.faces([rings[i]], place(stations[i]));
      return face;
    };
    /** The bend two stations are on, if they are on one: the section's plane turned about an axis along `v`. */
    const bend = (a: Station, b: Station): { center: Vec3; angle: number } | null => {
      if (!close(a.v, b.v)) return null;
      const turn = sub(a.u, b.u);
      if (length(turn) < 1e-9) return null;
      // The one point both sections stand off by the same distance along their `u`: the middle of the bend.
      const off = dot(sub(b.p, a.p), turn) / dot(turn, turn);
      const center = along(a.p, a.u, off);
      if (!close(center, along(b.p, b.u, off), 1e-6 * Math.max(1, Math.abs(off)))) return null;
      return { center, angle: Math.atan2(dot(cross(a.u, b.u), a.v), dot(a.u, b.u)) };
    };
    const pieces: Shape[] = [];
    let i = 0;
    while (i + 1 < stations.length) {
      const a = stations[i];
      const b = stations[i + 1];
      const step = sub(b.p, a.p);
      if (close(a.u, b.u) && close(a.v, b.v)) {
        // Carried on without turning: straight along the section's own normal, or it is skewed.
        const normal = cross(a.u, a.v);
        const run = dot(step, normal);
        if (!close(step, along([0, 0, 0], normal, run), 1e-6 * Math.max(1, length(step))) || Math.abs(run) < 1e-9) none();
        if (sameRing(rings[i], rings[i + 1])) pieces.push(this.result(new oc.BRepPrimAPI_MakePrism(section(i), this.keep(new oc.gp_Vec(...step)), false, true)));
        else pieces.push(this.taper(rings[i], rings[i + 1], a, b, normal, run));
        i++;
        continue;
      }
      // Turned: every station from here on that is on the same bend makes one piece with it.
      const first = sameRing(rings[i], rings[i + 1]) ? bend(a, b) : null;
      if (!first || first.angle === 0) return none();
      let total = first.angle;
      let j = i + 1;
      while (j + 1 < stations.length && sameRing(rings[j], rings[j + 1])) {
        const next = bend(stations[j], stations[j + 1]);
        if (!next || !close(next.center, first.center, 1e-6 * Math.max(1, length(first.center))) || next.angle * first.angle <= 0) break;
        total += next.angle;
        j++;
      }
      // A full turn or more would run into itself.
      if (Math.abs(total) >= 2 * Math.PI - 1e-9) none();
      const way = total > 0 ? 1 : -1;
      const axis = this.keep(new oc.gp_Ax1(this.point(...first.center), this.keep(new oc.gp_Dir(a.v[0] * way, a.v[1] * way, a.v[2] * way))));
      pieces.push(this.result(new oc.BRepPrimAPI_MakeRevol(section(i), axis, Math.abs(total), false)));
      i = j;
    }
    return this.fuse(pieces);
  }

  /** A section that changes from one outline to another between two stations facing the same way, `run` apart along `normal`. */
  private taper(from: Polygon, to: Polygon, a: Swept['stations'][number], b: Swept['stations'][number], normal: Vec3, run: number): Shape {
    const { oc } = this;
    const [near0, far] = [traceArcs(from), traceArcs(to)];
    const centered = (t: ReturnType<typeof traceArcs>): t is { circle: { center: [number, number]; radius: number } } => 'circle' in t && Math.hypot(t.circle.center[0], t.circle.center[1]) <= 1e-9;
    if (centered(near0) && centered(far)) {
      // Round and on its axis at both ends: a cone, its side a straight line turned round the axis.
      const [r0, r1] = [near0.circle.radius, far.circle.radius];
      const at = ([r, z]: [number, number]): Vec3 => [a.p[0] + a.u[0] * r + normal[0] * z, a.p[1] + a.u[1] * r + normal[1] * z, a.p[2] + a.u[2] * r + normal[2] * z];
      const [face] = this.faces([[[0, 0], [r0, 0], [r1, run], [0, run]]], at);
      const axis = this.keep(new oc.gp_Ax1(this.point(...a.p), this.keep(new oc.gp_Dir(...normal))));
      return this.result(new oc.BRepPrimAPI_MakeRevol(face, axis, false));
    }
    // Any other pair of outlines: straight lines from each point of the one to its like on the other.
    const through = this.keep(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    const put = (s: Swept['stations'][number]) => ([x, y]: [number, number]): Vec3 => [s.p[0] + s.u[0] * x + s.v[0] * y, s.p[1] + s.u[1] * x + s.v[1] * y, s.p[2] + s.u[2] * x + s.v[2] * y];
    through.AddWire(this.wire(from, put(a)));
    through.AddWire(this.wire(to, put(b)));
    through.Build(this.keep(new oc.Message_ProgressRange()));
    if (!through.IsDone()) none();
    return this.keep(through.Shape());
  }

  // --- parts: a generator's description --------------------------------------------------------

  described(solid: Solid): Shape {
    const { oc } = this;
    switch (solid.op) {
      case 'cylinder': {
        const top = solid.radiusTop ?? solid.radius;
        if (near(top, solid.radius)) return this.result(new oc.BRepPrimAPI_MakeCylinder(solid.radius, solid.height));
        // A frustum, or a cone when one end comes to a point.
        const profile: Polygon = [[0, 0], [solid.radius, 0], [top, solid.height], [0, solid.height]];
        return this.turned(profile.filter((p, i) => !(i > 0 && near(p[0], 0) && near(profile[i - 1][0], 0) && near(p[1], profile[i - 1][1]))));
      }
      case 'extrude':
        // Twisted or tapered as it rises: the kernel's facets are the only form it has.
        if (solid.twist || (solid.scaleTop !== undefined && !near(solid.scaleTop, 1))) return none();
        return this.prism(solid.shape, 0, solid.height);
      case 'revolve':
        return this.turned(solid.profile);
      case 'mesh':
        // Only one that says what it was lofted from has another form than its triangles.
        return solid.swept ? this.swept(solid.swept) : none();
      case 'union':
        return this.fuse(solid.children.map((c) => this.described(c)));
      case 'intersection': {
        const [first, ...rest] = solid.children.map((c) => this.described(c));
        let all = first ?? none();
        for (const next of rest) all = this.result(new oc.BRepAlgoAPI_Common(all, next, this.keep(new oc.Message_ProgressRange())));
        return all;
      }
      case 'difference': {
        const [first, ...rest] = solid.children.map((c) => this.described(c));
        return this.cut(first ?? none(), rest);
      }
      case 'transform': {
        let shape = this.described(solid.child);
        if (solid.mirror) shape = this.mirrored(shape, solid.mirror);
        if (solid.rotate || solid.translate) {
          const m = rotation(solid.rotate ?? [0, 0, 0]);
          const t = solid.translate ?? [0, 0, 0];
          shape = this.moved(shape, [...m.slice(0, 9), t[0], t[1], t[2]]);
        }
        return shape;
      }
    }
  }

  /** A part as its generator describes it, centered on its box and at the size it has been given: all three axes by the one factor, or not at all. */
  part(node: PartNode): Shape {
    const def = getGenerator(node.part);
    const built = def.build(sanitizeParams(def, node.params), QUALITY.fine);
    const box = this.tools.partBox(node) ?? none();
    const scale = node.size[0] / node.natural[0];
    if (!node.size.every((s, i) => near(s / node.natural[i], scale))) none();
    const center = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
    return this.moved(this.tidy(this.described(built.solid)), [scale, 0, 0, 0, scale, 0, 0, 0, scale, -center[0] * scale, -center[1] * scale, -center[2] * scale]);
  }

  /**
   * `shape` with its faces that are parts of one surface made one face: the two halves a round wall
   * is drawn in, the pieces a cut left of a flat. Left as it is when the builder was told not to.
   */
  tidy(shape: Shape): Shape {
    if (!this.join) return shape;
    const unify = this.keep(new this.oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
    unify.Build();
    return this.keep(unify.Shape());
  }

  // --- the basic shapes ----------------------------------------------------------------------------

  /** A shape at its size, centered on the origin, as `buildShape` makes it of facets. */
  shape(node: ShapeNode): Shape {
    const { oc } = this;
    const [w, d, h] = node.size;
    const p = clampParams(node);
    const round = (p.sides ?? 0) >= (ROUND[node.shape] ?? Infinity);
    /** The regular polygon of the shape's sides, fitted to its width and depth as the kernel fits it. */
    const footprint = (): Polygon => {
      const unit = regularPolygon(p.sides);
      const xs = unit.map((q) => q[0]);
      const ys = unit.map((q) => q[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      return unit.map(([x, y]) => [((x - (x0 + x1) / 2) / (x1 - x0)) * w, ((y - (y0 + y1) / 2) / (y1 - y0)) * d]);
    };
    /** A section drawn in the XZ plane, run through the shape's depth along Y. */
    const lying = (section: Polygon): Shape => {
      const [face] = this.faces([section], ([x, z]) => [x, -d / 2, z]);
      return this.result(new oc.BRepPrimAPI_MakePrism(face, this.keep(new oc.gp_Vec(0, d, 0)), false, true));
    };
    /** Points along a curve, close enough together to be found again as the arc they lie on (see arcs.ts). */
    const arc = (steps: number, at: (a: number) => [number, number]): Polygon => Array.from({ length: steps + 1 }, (_, i) => at(i / steps));
    switch (node.shape) {
      case 'box': {
        const box = this.result(new oc.BRepPrimAPI_MakeBox(this.point(-w / 2, -d / 2, -h / 2), w, d, h));
        if (!(p.radius > 0)) return box;
        // Rounded all over: every edge by the radius, which only comes off while flats are left between them.
        if (p.radius * 2 >= Math.min(w, d, h) - 1e-6) return none();
        const fillet = this.keep(new oc.BRepFilletAPI_MakeFillet(box, oc.ChFi3d_FilletShape.ChFi3d_Rational));
        const edges = this.keep(new oc.TopExp_Explorer(box, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
        const seen: Shape[] = [];
        for (; edges.More(); edges.Next()) {
          const edge = this.keep(edges.Current());
          // Every edge is met twice, once from each face.
          if (seen.some((e) => e.IsSame(edge))) continue;
          seen.push(edge);
          fillet.Add(p.radius, oc.TopoDS.Edge(edge));
        }
        fillet.Build(this.keep(new oc.Message_ProgressRange()));
        if (!fillet.IsDone()) none();
        return this.keep(fillet.Shape());
      }
      case 'cylinder':
      case 'prism': {
        if (p.radius > 0) return none();
        if (!round || node.shape === 'prism') return this.prism([footprint()], -h / 2, h);
        // Round: as wide as its box across the flats the kernel gives it, so the true circle is the one inside its box.
        if (near(w, d)) return this.result(new oc.BRepPrimAPI_MakeCylinder(this.frame([0, 0, -h / 2], [0, 0, 1], [1, 0, 0]), w / 2, h));
        const wide = w >= d;
        const oval = this.keep(new oc.gp_Elips(this.frame([0, 0, -h / 2], [0, 0, 1], wide ? [1, 0, 0] : [0, 1, 0]), Math.max(w, d) / 2, Math.min(w, d) / 2));
        const rim = this.keep(this.done(new oc.BRepBuilderAPI_MakeWire(this.done(new oc.BRepBuilderAPI_MakeEdge(oval)).Edge())).Wire());
        const face = this.keep(this.done(new oc.BRepBuilderAPI_MakeFace(rim, true)).Face());
        return this.result(new oc.BRepPrimAPI_MakePrism(face, this.keep(new oc.gp_Vec(0, 0, h)), false, true));
      }
      case 'cone':
      case 'pyramid': {
        // Round and as deep as wide: a profile turned round. Anything else is flat faces, or an oval cone, which the facets say as well.
        const top = node.shape === 'pyramid' ? 0 : p.top;
        if (!round || node.shape === 'pyramid' || !near(w, d)) return none();
        const profile: Polygon = [[0, -h / 2], [w / 2, -h / 2], [(w / 2) * top, h / 2]];
        if (top > 0) profile.push([0, h / 2]);
        return this.turned(profile);
      }
      case 'sphere':
        // A ball stretched into an egg is an oval turned round an axis, which a STEP file has been seen not to keep (it is read back as another shape): left to the facets.
        return round && near(w, d) && near(d, h) ? this.result(new oc.BRepPrimAPI_MakeSphere(w / 2)) : none();
      case 'wedge':
        return lying([[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2]]);
      case 'roof':
        return lying([[-w / 2, -h / 2], [w / 2, -h / 2], [0, h / 2]]);
      case 'torus': {
        if (!round || !near(w, d)) return none();
        const r = h / 2;
        const a = p.ring > 0 ? Math.min(p.ring / 2, w / 4) : Math.min(r, w / 4);
        const center = w / 2 - a;
        // A round section on a ring with a hole in it; a flattened one is no torus to OpenCascade, and a closed hole is no solid of revolution.
        if (!near(a, r) || center - a < 1e-6) return none();
        return this.result(new oc.BRepPrimAPI_MakeTorus(center, r));
      }
      case 'roundroof': {
        // Half a round bar lying on its flat: a cylinder while it is half as tall as it is wide, and half an oval bar when it is not. Of few steps it is flat faces, which the facets say as well.
        if (!round) return none();
        if (near(h, w / 2)) return lying(arc(64, (a) => [(Math.cos(a * Math.PI) * w) / 2, Math.sin(a * Math.PI) * h - h / 2]));
        return this.result(new oc.BRepPrimAPI_MakePrism(this.ovalFace([0, -h / 2], w / 2, h, 0, Math.PI, [], ([x, z]) => [x, -d / 2, z]), this.keep(new oc.gp_Vec(0, d, 0)), false, true));
      }
      case 'fillet': {
        // What a quarter-round bar leaves of a square one: the solid corner at +X +Z, the hollow running from the top at -X down to the bottom at +X.
        if (!round) return none();
        if (near(w, h)) return lying([[w / 2, h / 2], ...arc(32, (a) => [Math.cos(((1 - a) * Math.PI) / 2) * w - w / 2, Math.sin(((1 - a) * Math.PI) / 2) * h - h / 2])]);
        // Wider than tall, or taller than wide: the hollow is a quarter of an oval.
        return this.result(new oc.BRepPrimAPI_MakePrism(this.ovalFace([-w / 2, -h / 2], w, h, 0, Math.PI / 2, [[w / 2, h / 2]], ([x, z]) => [x, -d / 2, z]), this.keep(new oc.gp_Vec(0, d, 0)), false, true));
      }
      case 'dome': {
        // Half a ball on its flat: a quarter circle turned round, while it is as deep as wide and half as tall. Taller or flatter it is an oval turned round, which is left to the facets like the egg.
        if (!round || !near(w, d) || !near(h, w / 2)) return none();
        return this.turned([[0, -h / 2], ...arc(32, (a) => [Math.cos((a * Math.PI) / 2) * h, Math.sin((a * Math.PI) / 2) * h - h / 2])]);
      }
      default:
        return none();
    }
  }

  // --- groups ----------------------------------------------------------------------------------------

  /** A group: its solids together, less its holes, as the kernel combines them. */
  group(node: GroupNode): Shape {
    const scale = node.size[0] / node.natural[0];
    if (!node.size.every((s, i) => near(s / node.natural[i], scale))) none();
    const solids: Shape[] = [];
    const holes: Shape[] = [];
    for (const child of node.children) {
      if (child.type === 'picture') continue;
      (child.hole ? holes : solids).push(this.placed(child));
    }
    const all = this.cut(this.fuse(solids), holes);
    return near(scale, 1) ? all : this.moved(all, [scale, 0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0]);
  }

  /** A node at its built size, centered on the origin. */
  built(node: SceneNode): Shape {
    switch (node.type) {
      case 'shape':
        // Built at its size rather than stretched to it: only a round rim or a ring's width depend on the size, and both are read from it.
        return this.shape(node);
      case 'part':
        return this.part(node);
      case 'group':
        return this.group(node);
      default:
        return none();
    }
  }

  /** A node where it is in its parent: mirrored, turned and moved, as `nodeMatrix` does it (its size is already in what was built). */
  placed(node: SceneNode): Shape {
    let shape = this.built(node);
    const sign = flipSigns(node.flip);
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    axes.forEach((axis, i) => {
      if (sign[i] < 0) shape = this.mirrored(shape, axis);
    });
    const m = rotation(node.rot);
    return this.moved(shape, [...m.slice(0, 9), node.pos[0], node.pos[1], node.pos[2]]);
  }
}

/**
 * The volume and the box of a shape, to hold against the kernel's. The box is worked out from the
 * surfaces themselves; with `facets` it is that of fine facets laid over them instead, which is the
 * one to go by where the library's own is loose (it is for an oval turned round an axis, once the
 * shape is turned off the axes).
 */
function measured(oc: Oc, shape: Shape, keep: Keep, facets = false): { volume: number; bounds: Bounds } {
  const props = keep(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  const box = keep(new oc.Bnd_Box());
  if (facets) {
    keep(new oc.BRepMesh_IncrementalMesh(shape, 0.01, false, 0.1, false));
    oc.BRepBndLib.Add(shape, box, true);
  } else oc.BRepBndLib.AddOptimal(shape, box, false, false);
  const min = keep(box.CornerMin());
  const max = keep(box.CornerMax());
  return { volume: props.Mass(), bounds: { min: [min.X(), min.Y(), min.Z()], max: [max.X(), max.Y(), max.Z()] } };
}

/**
 * Whether a shape written to a STEP file of its own is read back with the
 * volume it should have. What the library holds in memory and what it writes
 * are not always the same thing: an oval turned round an axis is right in
 * memory and comes back from the file as nothing, or as another shape.
 */
function survives(oc: Oc, shape: Shape, volume: number, keep: Keep): boolean {
  const path = '/exact-check.step';
  try {
    const writer = keep(new oc.STEPControl_Writer());
    const progress = keep(new oc.Message_ProgressRange());
    if (writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, progress) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    const reader = keep(new oc.STEPControl_Reader());
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) return false;
    reader.TransferRoots(progress);
    const back = keep(reader.OneShape());
    if (back.IsNull()) return false;
    const props = keep(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(back, props, false, false, false);
    return Math.abs(props.Mass() - volume) <= 0.005 * Math.abs(volume);
  } catch {
    return false;
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // Never written.
    }
  }
}

/**
 * How far the box of a true solid may be from the box of the kernel's facets
 * of it, in millimeters: a twentieth of a millimeter, and a quarter of a
 * percent of its largest side, which is what the flats of a curve of some
 * fifty sides stand back from the curve itself.
 */
export const boxSlack = (bounds: Bounds): number => 0.05 + 0.0025 * Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);

/**
 * The node as a true solid, placed in the design; null when it has no exact
 * form, or when the form it was given does not match `expect`, the kernel's
 * own solid: its volume to within the difference between a curve and its
 * facets, its box to within `boxSlack`.
 */
export function exactShape(oc: Oc, node: SceneNode, expect: { volume: number; bounds: Bounds }, tools: ExactTools, keep: Keep): Shape | null {
  // With its faces joined where they lie on one surface, and failing that as it was built: two round
  // pipes of one size that cross touch along a line, and joining faces there has been seen to lose one of them.
  for (const join of [true, false]) {
    let shape: Shape;
    try {
      shape = new Builder(oc, keep, tools, join).placed(node);
    } catch {
      // No exact form, or OpenCascade gave up on it (it says so by an exception of its own).
      continue;
    }
    try {
      let got = measured(oc, shape, keep);
      if (!(Math.abs(got.volume - expect.volume) <= 0.005 * expect.volume)) continue;
      // A round shape turned off the axes reaches a little further than its facets do, by more the larger it is.
      const slack = boxSlack(expect.bounds);
      const off = (): boolean => [0, 1, 2].some((i) => Math.abs(got.bounds.min[i] - expect.bounds.min[i]) > slack || Math.abs(got.bounds.max[i] - expect.bounds.max[i]) > slack);
      if (off()) {
        got = measured(oc, shape, keep, true);
        if (off()) continue;
      }
      // And it has to come out of a STEP file as it went in: a solid that is right here has been seen to be read back as another.
      if (!survives(oc, shape, expect.volume, keep)) continue;
      return shape;
    } catch {
      continue;
    }
  }
  return null;
}
