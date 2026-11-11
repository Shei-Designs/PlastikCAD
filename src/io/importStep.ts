// STEP (ISO 10303-21, AP203 / AP214 / AP242): the solids of a file from a CAD
// program, read by OpenCascade and cut into triangles, one part per solid,
// where the file put them. STEP says its unit, and OpenCascade hands the
// shapes over in millimeters.
//
// OpenCascade is a large library (see occ.ts): it is loaded when the first
// STEP file is read, not with the app, which is why this reader is the one
// that does not answer at once.
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { tr, trx } from '../i18n';
import type { ImportedModel, ImportedPart } from './import';
import { MeshBuilder } from './weld';

/** How far a flat triangle may stray from the true surface, mm, and how far it may turn from it, radians. */
const DEFLECTION = 0.02;
const ANGLE = 0.25;
const MAX_TRIANGLES = 5_000_000;

type Deletable = { delete(): void };

/**
 * Reads a STEP file with `oc`. Every solid is a part; a file with surfaces
 * but no solid comes in as one part of what it has, which the app then shows
 * as an open mesh.
 */
export function parseStep(oc: OpenCascadeInstance, bytes: Uint8Array, name = trx('object name', 'Import')): ImportedModel {
  if (bytes.length === 0) throw new Error(tr('This STEP file is empty.'));
  // Everything made here lives in the library's own memory, which is not collected: it is let go at the end.
  const made: Deletable[] = [];
  const keep = <T extends Deletable>(o: T): T => {
    made.push(o);
    return o;
  };
  const path = '/import.step';
  try {
    oc.FS.writeFile(path, bytes);
    const reader = keep(new oc.STEPControl_Reader());
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(tr('This {format} file is damaged or not supported.', { format: 'STEP' }));
    reader.TransferRoots(keep(new oc.Message_ProgressRange()));
    const shape = keep(reader.OneShape());
    if (shape.IsNull()) throw new Error(tr('This STEP file has no shapes.'));
    keep(new oc.BRepMesh_IncrementalMesh(shape, DEFLECTION, false, ANGLE, false));

    const parts: ImportedPart[] = [];
    let triangles = 0;
    /** The faces of a shape as one mesh; null when it has none with triangles. */
    const meshOf = (of: InstanceType<typeof oc.TopoDS_Shape>): ImportedPart['mesh'] | null => {
      const builder = new MeshBuilder();
      const faces = keep(new oc.TopExp_Explorer(of, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; faces.More(); faces.Next()) {
        const face = keep(oc.TopoDS.Face(faces.Current()));
        const location = keep(new oc.TopLoc_Location());
        const mesh = oc.BRep_Tool.Triangulation(face, location, 0);
        if (!mesh || mesh.isNull()) continue;
        keep(mesh);
        const count = mesh.NbTriangles();
        triangles += count;
        if (triangles > MAX_TRIANGLES) throw new Error(tr('This STEP file is too detailed to open.'));
        const move = location.IsIdentity() ? null : keep(location.Transformation());
        const index = new Int32Array(mesh.NbNodes() + 1);
        for (let i = 1; i <= mesh.NbNodes(); i++) {
          const at = mesh.Node(i);
          const placed = move ? at.Transformed(move) : at;
          index[i] = builder.vertex(placed.X(), placed.Y(), placed.Z());
          if (placed !== at) placed.delete();
          at.delete();
        }
        // A face that looks the other way than its surface has its triangles the other way round.
        const flipped = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        for (let i = 1; i <= count; i++) {
          const triangle = mesh.Triangle(i);
          const a = index[triangle.Value(1)];
          const b = index[triangle.Value(2)];
          const c = index[triangle.Value(3)];
          triangle.delete();
          if (flipped) builder.triangle(a, c, b);
          else builder.triangle(a, b, c);
        }
      }
      return builder.size ? builder.finish() : null;
    };

    const solids = keep(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; solids.More(); solids.Next()) {
      const mesh = meshOf(keep(solids.Current()));
      if (mesh) parts.push({ name, mesh });
    }
    // No solids: surfaces on their own, taken together.
    if (parts.length === 0) {
      const mesh = meshOf(shape);
      if (mesh) parts.push({ name, mesh });
    }
    if (parts.length === 0) throw new Error(tr('This STEP file has no shapes.'));
    if (parts.length > 1) parts.forEach((part, i) => (part.name = `${name} ${i + 1}`));
    return { kind: 'model', parts, used: [] };
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
