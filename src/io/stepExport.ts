// STEP out (ISO 10303-21, AP214), written by OpenCascade (see occ.ts): every
// object a solid of its own, with its name and its color, in millimeters.
//
// The geometry kernel hands over triangles. Here they are made into faces and
// sewn into a closed shell, and the faces that lie in one plane are then
// joined into one: a box goes out as six planes, a plate with holes as two
// planes and their walls, and a CAD program can pick, measure and build on
// them. A curved surface is still as many flat strips as it was built with.
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { samePlace } from '../geometry/mesh';
import type { MeshData } from '../geometry/mesh';
import { tr } from '../i18n';

/** One object to write: closed or not, placed in the design (mm, Z up). */
export interface StepObject {
  name: string;
  /** Hex sRGB, as a node's `color`. */
  color: string;
  mesh: MeshData;
}

/**
 * Past this many triangles an object is left out: every triangle is a face to
 * sew, and a scan of a million of them would hold the export for minutes to
 * write a file no CAD program opens gladly.
 */
export const STEP_TRIANGLES = 200_000;

type Deletable = { delete(): void };

/** Corners are taken for one place when they agree to this many parts of a millimeter. */
const WELD = 1e5;

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Writes the objects as a STEP file. Returns its bytes and what there is to
 * say of it: the objects left out for being too detailed, and those that are
 * not closed and went out as surfaces.
 */
export function writeStep(oc: OpenCascadeInstance, objects: StepObject[]): { bytes: Uint8Array; warnings: string[] } {
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
    for (const object of objects) {
      if (object.mesh.triangles.length / 3 > STEP_TRIANGLES) {
        warnings.push(tr('"{name}" is too detailed for a STEP file and was left out.', { name: object.name }));
        continue;
      }
      const solid = facetedSolid(oc, object.mesh, keep);
      if (!solid.closed) warnings.push(tr('"{name}" is not watertight and was exported as a surface.', { name: object.name }));
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
    return { bytes: oc.FS.readFile(path).slice(), warnings };
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

/**
 * A mesh as a B-rep: a face per triangle, sewn along the edges they share,
 * made a solid when the shell closes, and its faces joined wherever they lie
 * in one plane.
 */
function facetedSolid(oc: OpenCascadeInstance, mesh: MeshData, keep: <T extends Deletable>(o: T) => T): { shape: InstanceType<typeof oc.TopoDS_Shape>; closed: boolean } {
  const { positions, triangles } = mesh;
  const points: InstanceType<typeof oc.gp_Pnt>[] = [];
  for (let i = 0; i < positions.length; i += 3) points.push(keep(new oc.gp_Pnt(positions[i], positions[i + 1], positions[i + 2])));
  // The kernel's meshes hold corners that are one place under two numbers, and slivers between them
  // with no area: an edge from a point to itself cannot be made, and the sliver adds nothing.
  // Corners within a hundredth of a micron count as one: the library takes points nearer than that for the same
  // point, and refuses the edge between them.
  const same = samePlace(Float32Array.from(positions, (v) => Math.round(v * WELD) / WELD));
  const sewing = keep(new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false));
  for (let t = 0; t < triangles.length; t += 3) {
    const [ia, ib, ic] = [same[triangles[t]], same[triangles[t + 1]], same[triangles[t + 2]]];
    if (ia === ib || ib === ic || ic === ia) continue;
    const [a, b, c] = [points[ia], points[ib], points[ic]];
    // Built and let go triangle by triangle: a large mesh would otherwise hold four objects a face until the end.
    const edges = [new oc.BRepBuilderAPI_MakeEdge(a, b), new oc.BRepBuilderAPI_MakeEdge(b, c), new oc.BRepBuilderAPI_MakeEdge(c, a)];
    const parts: Deletable[] = [...edges];
    // A triangle the library can make nothing of (its corners in a line) is a sliver like the others.
    if (edges.every((e) => e.IsDone())) {
      const wire = new oc.BRepBuilderAPI_MakeWire(edges[0].Edge(), edges[1].Edge(), edges[2].Edge());
      parts.push(wire);
      if (wire.IsDone()) {
        const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true);
        parts.push(face);
        if (face.IsDone()) sewing.Add(face.Face());
      }
    }
    for (const o of parts) o.delete();
  }
  sewing.Perform(keep(new oc.Message_ProgressRange()));
  const sewn = keep(sewing.SewedShape());
  let shape = sewn;
  let closed = false;
  // A closed mesh sews into one shell, which is then the skin of a solid; anything else stays the surface it is.
  if (sewn.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
    const shell = keep(oc.TopoDS.Shell(sewn));
    if (shell.Closed()) {
      shape = keep(keep(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid());
      closed = true;
    }
  }
  const unify = keep(new oc.ShapeUpgrade_UnifySameDomain(shape, true, true, false));
  unify.Build();
  return { shape: keep(unify.Shape()), closed };
}
