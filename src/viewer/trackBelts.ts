// A Track part with its belt running, while a test drive has it: the part's
// own mesh is then the belt without its lugs and the rail (see `TrackLooks`),
// and drawn here over it are the wheels, each turned about its axle, and the
// lugs, wherever the belt has carried them. Everything is drawn with the
// part's own material and edge lines, so it looks as the part does.
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, LineSegments, Mesh } from 'three';
import type { LineBasicMaterial, MeshStandardMaterial } from 'three';
import { trackInPart, trackLugNumbers, trackLugReach, trackLugs } from '../parts/generators/track';
import type { TrackFigures } from '../parts/generators/track';
import type { PieceMesh, TrackLooks } from '../worker/protocol';
import type { Drawn } from './sceneSync';
import type { Stage } from './stage';

/** A track whose belt is shown running: the object it is, its figures and pieces, and how far its belt has run along its path, mm. */
export interface Belt {
  id: string;
  figures: TrackFigures;
  looks: TrackLooks;
  travel: number;
}

/** A lug's triangles, by its corners as `trackLugs` gives them: its top, its two sides and its two ends. Its foot is inside the belt. */
const LUG_FACES = [4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 7, 3, 0, 4, 7, 1, 2, 6, 1, 6, 5];
/** A lug's edge lines: round its top, up its four corners from the belt, and where it meets the belt. */
const LUG_TOP = [4, 5, 5, 6, 6, 7, 7, 4];
export const LUG_TRIANGLE_NUMBERS = LUG_FACES.length * 3;
export const LUG_EDGE_NUMBERS = 2 * 3 * 12;

/**
 * Lays the lugs' boxes out as loose triangles with a normal per corner, and as edge lines. `corners` are eight
 * a lug (see `trackLugs`); `sunk` is how far up from a lug's foot to its top the belt's surface is, 0 to 1:
 * the lines begin there, where the lug comes out of the belt.
 */
export function lugMesh(corners: Float32Array, sunk: number, positions: Float32Array, normals: Float32Array, edges: Float32Array): void {
  const lugs = corners.length / 24;
  let [p, e] = [0, 0];
  for (let l = 0; l < lugs; l++) {
    const at = l * 24;
    for (let f = 0; f < LUG_FACES.length; f += 3) {
      const [a, b, c] = [at + 3 * LUG_FACES[f], at + 3 * LUG_FACES[f + 1], at + 3 * LUG_FACES[f + 2]];
      const [ux, uy, uz] = [corners[b] - corners[a], corners[b + 1] - corners[a + 1], corners[b + 2] - corners[a + 2]];
      const [vx, vy, vz] = [corners[c] - corners[a], corners[c + 1] - corners[a + 1], corners[c + 2] - corners[a + 2]];
      let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const n = Math.hypot(nx, ny, nz) || 1;
      [nx, ny, nz] = [nx / n, ny / n, nz / n];
      for (const from of [a, b, c]) {
        positions[p] = corners[from];
        positions[p + 1] = corners[from + 1];
        positions[p + 2] = corners[from + 2];
        normals[p] = nx;
        normals[p + 1] = ny;
        normals[p + 2] = nz;
        p += 3;
      }
    }
    const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      edges[e++] = ax;
      edges[e++] = ay;
      edges[e++] = az;
      edges[e++] = bx;
      edges[e++] = by;
      edges[e++] = bz;
    };
    for (let i = 0; i < LUG_TOP.length; i += 2) {
      const [a, b] = [at + 3 * LUG_TOP[i], at + 3 * LUG_TOP[i + 1]];
      line(corners[a], corners[a + 1], corners[a + 2], corners[b], corners[b + 1], corners[b + 2]);
    }
    // Where each corner comes out of the belt, between its foot and its top.
    const out = (k: number, i: number) => corners[at + 3 * k + i] + (corners[at + 3 * (k + 4) + i] - corners[at + 3 * k + i]) * sunk;
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      line(out(k, 0), out(k, 1), out(k, 2), corners[at + 3 * (k + 4)], corners[at + 3 * (k + 4) + 1], corners[at + 3 * (k + 4) + 2]);
      line(out(k, 0), out(k, 1), out(k, 2), out(next, 0), out(next, 1), out(next, 2));
    }
  }
}

/** One track as drawn: its wheels and lugs under the part's own place. */
interface Held {
  from: TrackLooks;
  group: Group;
  /** Each wheel, with the radius its rim turns at. */
  wheels: { mesh: Mesh<BufferGeometry, MeshStandardMaterial>; edges: LineSegments<BufferGeometry, LineBasicMaterial> | null; radius: number }[];
  lugs: Mesh<BufferGeometry, MeshStandardMaterial>;
  lugEdges: LineSegments<BufferGeometry, LineBasicMaterial>;
  corners: Float32Array;
  /** How far the belt had run when the lugs were last laid out; they are laid out again only when it has run on. */
  travel: number | null;
  geometries: BufferGeometry[];
}

export class TrackBelts {
  private held = new Map<string, Held>();

  constructor(
    private readonly stage: Pick<Stage, 'scene' | 'options'>,
    private readonly drawn: Map<string, Drawn>,
  ) {}

  /** Brings the wheels and lugs in line with the belts asked for and with the parts they belong to: made, moved, turned, or let go. */
  sync(): void {
    const wanted = new Map((this.stage.options.belts ?? []).map((b) => [b.id, b]));
    for (const [id, h] of this.held) {
      const belt = wanted.get(id);
      // The part's own mesh must be the piece these go with: until it is, or once it is no more, nothing is drawn over it.
      if (belt && belt.looks === h.from && this.drawn.get(id)?.shown === belt.looks.still) continue;
      this.discard(h);
      this.held.delete(id);
    }
    for (const [id, belt] of wanted) {
      const d = this.drawn.get(id);
      if (!d || d.shown !== belt.looks.still) continue;
      let h = this.held.get(id);
      if (!h) {
        h = this.make(belt, d);
        this.held.set(id, h);
      }
      this.lay(h, belt, d);
    }
  }

  private make(belt: Belt, d: Drawn): Held {
    const { figures: f, looks } = belt;
    const material = d.mesh.material;
    const group = new Group();
    group.matrixAutoUpdate = false;
    // The part is drawn centered on its box; its pieces are told in the axes it is built in.
    const frame = new Group();
    frame.position.set(-looks.center[0], -looks.center[1], -looks.center[2]);
    frame.updateMatrix();
    group.add(frame);
    const geometries: BufferGeometry[] = [];
    const shapes = new Map<PieceMesh, { geometry: BufferGeometry; edges: BufferGeometry | null }>();
    const shapeOf = (piece: PieceMesh) => {
      let s = shapes.get(piece);
      if (!s) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(piece.render.positions, 3));
        geometry.setAttribute('normal', new BufferAttribute(piece.render.normals, 3));
        const edges = piece.edges ? new BufferGeometry().setAttribute('position', new BufferAttribute(piece.edges, 3)) : null;
        geometries.push(geometry, ...(edges ? [edges] : []));
        s = { geometry, edges };
        shapes.set(piece, s);
      }
      return s;
    };
    const wheels = f.wheels.flatMap((w): Held['wheels'] => {
      const piece = w.kind === 'sprocket' ? looks.sprocket : w.kind === 'idler' ? looks.idler : looks.road;
      if (!piece) return [];
      const shape = shapeOf(piece);
      const mesh = new Mesh(shape.geometry, material);
      mesh.position.set(...trackInPart(w.center, 0));
      mesh.raycast = () => {};
      frame.add(mesh);
      let edges: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
      if (shape.edges) {
        // The material is the part's own edge lines', given when those are drawn (see `lay`).
        edges = new LineSegments<BufferGeometry, LineBasicMaterial>(shape.edges);
        edges.raycast = () => {};
        edges.visible = false;
        mesh.add(edges);
      }
      return [{ mesh, edges, radius: w.radius }];
    });
    const count = trackLugNumbers(f) / 24;
    const lugGeometry = new BufferGeometry();
    for (const name of ['position', 'normal']) lugGeometry.setAttribute(name, new BufferAttribute(new Float32Array(count * LUG_TRIANGLE_NUMBERS), 3).setUsage(DynamicDrawUsage));
    const lineGeometry = new BufferGeometry();
    lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(count * LUG_EDGE_NUMBERS), 3).setUsage(DynamicDrawUsage));
    geometries.push(lugGeometry, lineGeometry);
    const lugs = new Mesh(lugGeometry, material);
    const lugEdges = new LineSegments<BufferGeometry, LineBasicMaterial>(lineGeometry);
    // The lugs go round inside the part's box, which is what is asked whether the part is in view; they are never picked.
    for (const o of [lugs, lugEdges]) {
      o.frustumCulled = false;
      o.raycast = () => {};
    }
    lugEdges.visible = false;
    frame.add(lugs, lugEdges);
    this.stage.scene.add(group);
    return { from: looks, group, wheels, lugs, lugEdges, corners: new Float32Array(trackLugNumbers(f)), travel: null, geometries };
  }

  /** Where the part is, how far its wheels have turned and its lugs have gone, and the part's look. */
  private lay(h: Held, belt: Belt, d: Drawn): void {
    const f = belt.figures;
    h.group.matrix.copy(d.mesh.matrix);
    h.group.matrixWorldNeedsUpdate = true;
    h.group.visible = d.mesh.visible;
    for (const m of [h.lugs, ...h.wheels.map((w) => w.mesh)]) m.renderOrder = d.mesh.renderOrder;
    if (h.travel !== belt.travel) {
      h.travel = belt.travel;
      // The belt's path goes round the part's -Y: a wheel turns with it, by as much as the belt has run over its rim.
      for (const w of h.wheels) w.mesh.rotation.y = -belt.travel / w.radius;
      trackLugs(f, belt.travel, h.corners);
      const { foot, top } = trackLugReach(f);
      const position = h.lugs.geometry.getAttribute('position') as BufferAttribute;
      const normal = h.lugs.geometry.getAttribute('normal') as BufferAttribute;
      const line = h.lugEdges.geometry.getAttribute('position') as BufferAttribute;
      lugMesh(h.corners, (f.thickness - foot) / (top - foot), position.array as Float32Array, normal.array as Float32Array, line.array as Float32Array);
      position.needsUpdate = normal.needsUpdate = line.needsUpdate = true;
    }
    // Edge lines as the part has them, in its own color and strength: none when it has none.
    const lines = d.edges?.visible ? d.edges.material : null;
    for (const e of [h.lugEdges, ...h.wheels.map((w) => w.edges)]) {
      if (!e) continue;
      e.visible = Boolean(lines);
      if (lines) e.material = lines;
      e.renderOrder = d.mesh.renderOrder;
    }
  }

  private discard(h: Held): void {
    this.stage.scene.remove(h.group);
    // The materials are the part's own, and stay with it.
    for (const g of h.geometries) g.dispose();
  }

  dispose(): void {
    for (const h of this.held.values()) this.discard(h);
    this.held.clear();
  }
}
