// STEP out (ISO 10303-21, AP214), written by OpenCascade (see occ.ts): every
// object a solid of its own, with its name and its color, in millimeters.
//
// An object that can be rebuilt from what it is (a shape, a part, a group of
// them: see stepExact.ts) goes out as true surfaces: a hole is a cylinder, a
// ball a sphere. Anything else goes out as the geometry kernel's triangles,
// made into faces and sewn into a closed shell, with the faces that lie in
// one plane joined into one: flat sides are then true planes, and a curved
// surface is as many flat strips as it was built with.
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { samePlace } from '../geometry/mesh';
import type { MeshData } from '../geometry/mesh';
import { tr } from '../i18n';
import type { Bounds } from '../model/math';
import type { SceneNode } from '../model/types';
import { exactShape } from './stepExact';
import type { ExactTools } from './stepExact';

/** One object to write: closed or not, placed in the design (mm, Z up). */
export interface StepObject {
  name: string;
  /** Hex sRGB, as a node's `color`. */
  color: string;
  mesh: MeshData;
  /** The node the mesh is the whole of, when it is: it is then rebuilt as true surfaces if it can be, and checked against the mesh. */
  node?: SceneNode;
  /** The same object with fewer facets on its curves, to write when it cannot be rebuilt: every facet is a face in the file. */
  facets?: MeshData;
}

/**
 * Past this many triangles an object that cannot be rebuilt is left out, and so is one that would take the
 * triangles of the whole file past it: every triangle is a face to sew, some 2.5 kB of file and some 22 kB of
 * memory while it is written, so this many already take half a minute, make a file of 150 MB and need well over
 * a gigabyte. Counted over the whole file because that is what runs out: twenty imported meshes of a few thousand
 * triangles each passed one by one, and on a tablet the system closed the app for the memory they took together.
 */
export const STEP_TRIANGLES = 60_000;

type Deletable = { delete(): void };

/** Corners are taken for one place when they agree to this many parts of a millimeter: a tenth of a micron. */
const WELD = 1e4;
/** A triangle lower than this over its longest side, in millimeters, is a line: no face can be made of it. */
const SLIVER = 1e-6;

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Writes the objects as a STEP file. Returns its bytes and what there is to
 * say of it: the objects left out for being too detailed, and those that are
 * not closed and went out as surfaces.
 */
export function writeStep(oc: OpenCascadeInstance, objects: StepObject[], tools: ExactTools = { partBox: () => null }, budget = STEP_TRIANGLES): { bytes: Uint8Array; warnings: string[]; exact: number } {
  // Everything made here lives in the library's own memory, which is not collected: it is let go at the end.
  const made: Deletable[] = [];
  const keep = <T extends Deletable>(o: T): T => {
    made.push(o);
    return o;
  };
  const warnings: string[] = [];
  const path = '/export.step';
  try {
    const progress = keep(new oc.Message_ProgressRange());
    const doc = keep(new oc.TDocStd_Document(keep(new oc.TCollection_ExtendedString('XmlXCAF', false))));
    const shapes = keep(oc.XCAFDoc_DocumentTool.ShapeTool(keep(doc.Main())));
    const colors = keep(oc.XCAFDoc_DocumentTool.ColorTool(keep(doc.Main())));
    let written = 0;
    let exact = 0;
    /** The triangles written as faces so far. */
    let sewn = 0;
    for (const object of objects) {
      const rebuilt = object.node ? exactShape(oc, object.node, measure(object.mesh), tools, keep) : null;
      const facets = object.facets ?? object.mesh;
      const count = facets.triangles.length / 3;
      if (rebuilt) exact++;
      else if (count > budget) {
        warnings.push(tr('"{name}" is too detailed for a STEP file and was left out.', { name: object.name }));
        continue;
      } else if (sewn + count > budget) {
        warnings.push(tr('"{name}" was left out: the file had reached the detail a STEP file can hold.', { name: object.name }));
        continue;
      } else sewn += count;
      let solid: { shape: InstanceType<typeof oc.TopoDS_Shape>; closed: boolean };
      try {
        solid = rebuilt ? { shape: rebuilt, closed: true } : facetedSolid(oc, facets, keep);
      } catch {
        // The library gave up on it (it says so by an exception of its own): the others still go out.
        warnings.push(tr('"{name}" could not be written to the STEP file and was left out.', { name: object.name }));
        continue;
      }
      if (!solid.closed) warnings.push(tr('"{name}" is not watertight and was exported as a surface.', { name: object.name }));
      else if (!rebuilt) {
        // Nothing goes out on trust: the sewn solid has to enclose what its triangles do.
        const props = keep(new oc.GProp_GProps());
        oc.BRepGProp.VolumeProperties(solid.shape, props, false, false, false);
        const { volume } = measure(facets);
        if (Math.abs(props.Mass() - volume) > 1e-3 * Math.abs(volume)) warnings.push(tr('"{name}" may not be whole in the STEP file: check it where it is opened.', { name: object.name }));
      }
      const label = keep(shapes.AddShape(solid.shape, false, false));
      keep(oc.TDataStd_Name.Set(label, keep(new oc.TCollection_ExtendedString(object.name, true))));
      // The library keeps colors linear and writes them as sRGB.
      const hex = /^#?([0-9a-f]{6})$/i.exec(object.color)?.[1] ?? '8fa3bf';
      const [r, g, b] = [0, 2, 4].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
      colors.SetColor(label, keep(new oc.Quantity_ColorRGBA(r, g, b, 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorGen);
      written++;
    }
    if (written === 0) throw new Error(warnings[0] ?? tr('There is nothing to export.'));
    const writer = keep(new oc.STEPCAFControl_Writer());
    writer.SetNameMode(true);
    writer.SetColorMode(true);
    if (!writer.Perform(doc, path, progress)) throw new Error(tr('The STEP file could not be written.'));
    return { bytes: oc.FS.readFile(path).slice(), warnings, exact };
  } finally {
    for (const o of made.reverse()) {
      try {
        o.delete();
      } catch {
        // Already let go with what held it.
      }
    }
    try {
      oc.FS.unlink(path);
    } catch {
      // Never written.
    }
  }
}

/** The volume a mesh encloses and the box round it: what a rebuilt solid has to match. */
function measure(mesh: MeshData): { volume: number; bounds: Bounds } {
  const p = mesh.positions;
  const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < p.length; i++) {
    if (p[i] < bounds.min[i % 3]) bounds.min[i % 3] = p[i];
    if (p[i] > bounds.max[i % 3]) bounds.max[i % 3] = p[i];
  }
  let six = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t] * 3, mesh.triangles[t + 1] * 3, mesh.triangles[t + 2] * 3];
    six += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return { volume: six / 6, bounds };
}

/**
 * The triangles of a mesh that a face can be made of, as corners named by the
 * first vertex at their place.
 *
 * The kernel's meshes hold corners that are one place under two numbers, and
 * triangles of no area between them: a thread has them by the thousand. An
 * edge from a point to itself cannot be made, and such a triangle adds
 * nothing, so corners that agree to a tenth of a micron count as one and the
 * triangles that lose a corner to that are left out: what remains is as
 * closed as the mesh was. A few triangles are then still lines, their corners
 * a hair apart on either side of that measure; the two nearest corners of
 * each are made one as well, for as long as that finds any.
 */
function tidied(mesh: MeshData): number[] {
  const { positions, triangles } = mesh;
  const first = samePlace(Float32Array.from(positions, (v) => Math.round(v * WELD) / WELD));
  const at = (v: number): number => {
    while (first[v] !== v) v = first[v] = first[first[v]];
    return v;
  };
  const distance = (a: number, b: number): number => Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
  for (let round = 0; round < 8; round++) {
    let joined = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [at(triangles[t]), at(triangles[t + 1]), at(triangles[t + 2])];
      if (a === b || b === c || c === a) continue;
      const sides: [number, number, number][] = [
        [distance(a, b), a, b],
        [distance(b, c), b, c],
        [distance(c, a), c, a],
      ];
      sides.sort((p, q) => p[0] - q[0]);
      // Its height over its longest side, from its sides (Heron's rule, in the form that holds for a needle).
      const [x, y, z] = [sides[2][0], sides[1][0], sides[0][0]];
      const sixteen = (x + (y + z)) * (z - (x - y)) * (z + (x - y)) * (x + (y - z));
      const height = sixteen > 0 ? Math.sqrt(sixteen) / (2 * x) : 0;
      // Only where two of its corners are all but one place: a corner that sits on the middle of a long side is left as it is.
      if (height >= SLIVER || sides[0][0] > 10 / WELD) continue;
      first[Math.max(sides[0][1], sides[0][2])] = Math.min(sides[0][1], sides[0][2]);
      joined++;
    }
    if (joined === 0) break;
  }
  const corners: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [at(triangles[t]), at(triangles[t + 1]), at(triangles[t + 2])];
    if (a !== b && b !== c && c !== a) corners.push(a, b, c);
  }
  return corners;
}

/**
 * A mesh as a B-rep: a face per triangle, sewn along the edges they share,
 * made a solid when the shell closes, and its faces joined wherever they lie
 * in one plane.
 *
 * Two lumps of one mesh may touch along an edge, which four triangles then
 * share. Sewn as one they come out as one shell with one of the lumps inside
 * out, so each lump (the triangles that hang together through edges shared by
 * two) is sewn on its own, and the object is the lumps together.
 */
function facetedSolid(oc: OpenCascadeInstance, mesh: MeshData, keep: <T extends Deletable>(o: T) => T): { shape: InstanceType<typeof oc.TopoDS_Shape>; closed: boolean } {
  const { positions } = mesh;
  const points: InstanceType<typeof oc.gp_Pnt>[] = [];
  for (let i = 0; i < positions.length; i += 3) points.push(keep(new oc.gp_Pnt(positions[i], positions[i + 1], positions[i + 2])));
  const count = points.length;
  const corners = tidied(mesh);
  // The lumps: triangles joined through every edge that exactly two of them share.
  const lump = Array.from({ length: corners.length / 3 }, (_, i) => i);
  const find = (i: number): number => {
    while (lump[i] !== i) i = lump[i] = lump[lump[i]];
    return i;
  };
  const edges = new Map<number, number[]>();
  for (let t = 0; t < corners.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = corners[t + k];
      const b = corners[t + ((k + 1) % 3)];
      const key = Math.min(a, b) * count + Math.max(a, b);
      const list = edges.get(key);
      if (list) list.push(t / 3);
      else edges.set(key, [t / 3]);
    }
  for (const list of edges.values()) if (list.length === 2) lump[find(list[0])] = find(list[1]);
  const lumps = new Map<number, number[]>();
  lump.forEach((_, t) => {
    const root = find(t);
    const list = lumps.get(root);
    if (list) list.push(t);
    else lumps.set(root, [t]);
  });

  const shapes: InstanceType<typeof oc.TopoDS_Shape>[] = [];
  let closed = true;
  for (const list of lumps.values()) {
    const sewing = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
    for (const t of list) {
      const [a, b, c] = [points[corners[t * 3]], points[corners[t * 3 + 1]], points[corners[t * 3 + 2]]];
      // Built and let go triangle by triangle: a large mesh would otherwise hold four objects a face until the end.
      const sides = [new oc.BRepBuilderAPI_MakeEdge(a, b), new oc.BRepBuilderAPI_MakeEdge(b, c), new oc.BRepBuilderAPI_MakeEdge(c, a)];
      const parts: Deletable[] = [...sides];
      // A triangle the library can make nothing of (its corners in a line) is left out: it says so by not being done, or by throwing.
      try {
        if (sides.every((e) => e.IsDone())) {
          const wire = new oc.BRepBuilderAPI_MakeWire(sides[0].Edge(), sides[1].Edge(), sides[2].Edge());
          parts.push(wire);
          if (wire.IsDone()) {
            const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true);
            parts.push(face);
            if (face.IsDone()) sewing.Add(face.Face());
          }
        }
      } catch {
        // Left out.
      }
      for (const o of parts) o.delete();
    }
    sewing.Perform(keep(new oc.Message_ProgressRange()));
    const sewn = keep(sewing.SewedShape());
    let shape = sewn;
    // A closed lump sews into one shell, which is then the skin of a solid; anything else stays the surface it is.
    let solid = false;
    if (sewn.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      const shell = keep(oc.TopoDS.Shell(sewn));
      if (shell.Closed()) {
        const made = keep(keep(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid());
        // Outside out, whichever way the sewing left it.
        oc.BRepLib.OrientClosedSolid(made);
        shape = made;
        solid = true;
      }
    }
    if (!solid) closed = false;
    const unify = keep(new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
    unify.Build();
    shapes.push(keep(unify.Shape()));
  }
  if (shapes.length === 1) return { shape: shapes[0], closed };
  const all = keep(new oc.TopoDS_Compound());
  const builder = keep(new oc.TopoDS_Builder());
  builder.MakeCompound(all);
  for (const shape of shapes) builder.Add(all, shape);
  return { shape: all, closed };
}
