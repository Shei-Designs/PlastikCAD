// The design as drawn: one mesh per node with its edge lines, kept in step
// with the items the viewer is given. Geometry is shared between nodes built
// alike; a node's picture and a mixed group's colors ride on geometry of its own.
import { Box3, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Color, LineBasicMaterial, LineSegments, Matrix3, Matrix4, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three';
import { castRay } from '../geometry/bvh';
import { skinAssets, skinKey, skinMesh, skinOf, skinRepeats } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { cornerColors, tintKey, underPicture } from '../geometry/tint';
import { builtSize, flipSigns, isEmptyBounds, rotation, unionBounds } from '../model/math';
import type { Bounds } from '../model/math';
import { HOLE_COLOR } from '../model/ops';
import type { GroupNode, SceneNode, Vec3 } from '../model/types';
import type { BuildResult } from '../worker/protocol';
import { SkinPainter } from './skin';
import { THEMES, toMatrix4 } from './stage';
import type { Stage } from './stage';
import type { ViewItem } from './types';

export const EMPTY_RADIUS = 70;
/** How much of a ghosted object's fill and outline is left. */
const GHOST_OPACITY = 0.14;
const GHOST_EDGE_OPACITY = 0.45;

/** What the viewer keeps per node on screen. */
export interface Drawn {
  item: ViewItem;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  edges: LineSegments<BufferGeometry, LineBasicMaterial> | null;
  /** Geometry currently shown, and the size it was built at (it may lag behind the node during a resize). */
  shown: BuildResult | null;
  built: Vec3;
  /**
   * The picture on the surface, if any: the geometry with its texture
   * coordinates and the pixels. `pixels` tells the painting, `shape` the mesh
   * and size the coordinates were made for; `own` when the geometry has
   * corners of its own (cut along a picture's edge) rather than the shared ones.
   * `faces` maps cut triangles back to the mesh's.
   */
  skin: { kind: Skin['kind']; pixels: string; shape: string; geometry: BufferGeometry; own: boolean; faces?: Uint32Array; map: CanvasTexture } | null;
  /**
   * The parts of a mixed group in their own colors: a geometry over the
   * corners of `base` (the shared or the skinned geometry) with a color per
   * corner. `key` tells the colors it was made with.
   */
  tint: { key: string; base: BufferGeometry; geometry: BufferGeometry } | null;
}

interface SharedGeometry {
  geometry: BufferGeometry;
  edges: BufferGeometry | null;
}

/** The middle, radius and reach from the origin of some items taken together; a stand-in size when there are none. */
export function extent(items: ViewItem[], boundsOf: (node: SceneNode) => Bounds): { center: Vector3; radius: number; reach: number } {
  const b = unionBounds(items.map((i) => boundsOf(i.node)));
  if (isEmptyBounds(b)) return { center: new Vector3(0, 0, 0), radius: EMPTY_RADIUS, reach: 0 };
  const box = new Box3(new Vector3(...b.min), new Vector3(...b.max));
  return {
    center: box.getCenter(new Vector3()),
    radius: Math.max(box.min.distanceTo(box.max) / 2, 2),
    reach: Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[1]), Math.abs(b.max[1])),
  };
}

export class SceneSync {
  readonly drawn = new Map<string, Drawn>();
  private shared = new Map<BuildResult, SharedGeometry>();
  /** Tells one build result from another in a skin's key. */
  private serials = new WeakMap<BuildResult, number>();
  private nextSerial = 1;
  readonly painter: SkinPainter;
  /** The images and paintings the objects wear, gathered on each pass over the scene; the painter lets go of the rest. */
  private readonly skinImages = new Set<string>();
  private readonly skinPaintings = new Set<string>();
  /** Pictures already reported as unreadable. */
  private readonly skinWarned = new Set<string>();
  /** Stands in until a node's geometry arrives. */
  private readonly empty = new BufferGeometry();

  /** `onPainted` is called when a picture that was still decoding is ready to be drawn. */
  constructor(
    private readonly stage: Pick<Stage, 'scene' | 'renderer' | 'raycaster' | 'options' | 'items' | 'assets'>,
    onPainted: () => void,
  ) {
    this.painter = new SkinPainter(onPainted);
  }

  /** Brings the meshes in line with the items: new nodes are given one, the rest their geometry, place, picture, colors and look, and those gone are let go. */
  update(): void {
    const seen = new Set<string>();
    this.skinImages.clear();
    this.skinPaintings.clear();
    for (const item of this.stage.items) {
      const { node } = item;
      seen.add(node.id);
      let d = this.drawn.get(node.id);
      if (!d) {
        const material = new MeshStandardMaterial({ metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new Mesh(this.empty, material);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        mesh.userData.id = node.id;
        this.stage.scene.add(mesh);
        d = { item, mesh, edges: null, shown: null, built: [1, 1, 1], skin: null, tint: null };
        this.drawn.set(node.id, d);
      }
      const before = d.item;
      d.item = item;

      let fresh = before === item;
      if (item.result && item.result !== d.shown) {
        fresh = true;
        const shared = this.share(item.result);
        d.mesh.geometry = shared.geometry;
        d.shown = item.result;
        d.built = builtSize(node);
        if (d.edges) {
          this.stage.scene.remove(d.edges);
          d.edges.material.dispose();
          d.edges = null;
        }
      }
      d.mesh.visible = Boolean(d.shown) && !node.hidden;
      this.place(d);
      const reskinned = this.applySkin(d);
      const retinted = this.applyTint(d);
      const same =
        !fresh &&
        !reskinned &&
        !retinted &&
        before.selected === item.selected &&
        before.ghost === item.ghost &&
        before.node.color === node.color &&
        before.node.hole === node.hole &&
        before.node.hidden === node.hidden &&
        before.node.ghost === node.ghost;
      if (!same) this.style(d, item.selected);
    }
    for (const [id, d] of this.drawn) {
      if (seen.has(id)) continue;
      this.discard(d);
      this.drawn.delete(id);
    }
    this.painter.retain(this.skinImages, this.skinPaintings);
  }

  /** Geometry nothing shows any more is released. */
  release(): void {
    const used = new Set<BuildResult>();
    for (const d of this.drawn.values()) if (d.shown) used.add(d.shown);
    for (const [result, s] of this.shared) {
      if (used.has(result)) continue;
      s.geometry.dispose();
      s.edges?.dispose();
      this.shared.delete(result);
    }
  }

  private share(result: BuildResult): SharedGeometry {
    let s = this.shared.get(result);
    if (!s) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(result.render.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(result.render.normals, 3));
      geometry.computeBoundingSphere();
      s = { geometry, edges: null };
      this.shared.set(result, s);
    }
    return s;
  }

  /**
   * Gives the node the picture on its surface, or takes it away: its own
   * geometry carrying texture coordinates, over the shared corners, and the
   * pixels as a texture. True when anything about it changed.
   */
  private applySkin(d: Drawn): boolean {
    const { node, ghost } = d.item;
    const worn = skinOf(node);
    // Its images are kept while the object has them, drawn or not: a ghost gets its picture back at once.
    if (worn) for (const key of skinAssets(worn)) this.skinImages.add(key);
    const skin = d.shown && !node.hole && !ghost ? worn : null;
    if (!skin || !d.shown) {
      if (!d.skin) return false;
      this.dropSkin(d);
      return true;
    }
    let serial = this.serials.get(d.shown);
    if (serial === undefined) {
      serial = this.nextSerial++;
      this.serials.set(d.shown, serial);
    }
    const pixels = skinKey(skin);
    this.skinPaintings.add(pixels);
    // The coordinates follow the mesh and, for a tiled texture, the size in millimeters; the pixels only the skin.
    const shape = `${serial}|${node.size.join(',')}`;
    if (d.skin?.pixels === pixels && d.skin.shape === shape) return false;
    let painted: ReturnType<SkinPainter['paint']> = null;
    try {
      painted = this.painter.paint(pixels, skin, this.stage.assets);
    } catch (e) {
      // Said once: the object is gone over again on every change to the scene.
      const text = e instanceof Error ? e.message : String(e);
      if (!this.skinWarned.has(text)) {
        this.skinWarned.add(text);
        console.warn(e);
      }
    }
    if (!painted) {
      // Still decoding: plain color meanwhile, and the painter calls back.
      if (!d.skin) return false;
      this.dropSkin(d);
      return true;
    }
    const mesh = skinMesh(skin, node, d.shown.render, d.shown.bounds, painted.rects);
    const shared = this.share(d.shown);
    const own = mesh.positions !== d.shown.render.positions;
    const geometry = new BufferGeometry();
    if (own) {
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    } else {
      geometry.setAttribute('position', shared.geometry.getAttribute('position'));
      geometry.setAttribute('normal', shared.geometry.getAttribute('normal'));
    }
    geometry.setAttribute('uv', new BufferAttribute(mesh.uv, 2));
    geometry.boundingSphere = shared.geometry.boundingSphere;
    // The same pixels stay on the GPU while the shape changes under them (a resize rebuilds only the coordinates).
    let map = d.skin && d.skin.pixels === pixels && d.skin.map.image === painted.canvas ? d.skin.map : null;
    if (!map) {
      map = new CanvasTexture(painted.canvas);
      map.colorSpace = SRGBColorSpace;
      map.wrapS = map.wrapT = skinRepeats(skin) ? RepeatWrapping : ClampToEdgeWrapping;
      map.anisotropy = Math.min(8, this.stage.renderer.capabilities.getMaxAnisotropy());
    }
    if (d.skin) this.dropSkin(d, map);
    d.skin = { kind: skin.kind, pixels, shape, geometry, own, map };
    if (mesh.faces) d.skin.faces = mesh.faces;
    d.mesh.geometry = geometry;
    return true;
  }

  /**
   * Gives a mixed group its parts' colors, or takes them off: a geometry over
   * whatever corners the node is drawn with (shared, or its skin's) and a
   * color per corner. The parts under a picture are left white, so the picture
   * shows as it is; a texture over the whole covers the parts, so it keeps the
   * group's one color. True when anything about it changed.
   */
  private applyTint(d: Drawn): boolean {
    const { node, ghost } = d.item;
    const faces = d.shown?.faces;
    const wanted = node.type === 'group' && node.mixed && !node.hole && !ghost && faces && d.skin?.kind !== 'texture';
    if (!wanted || !d.shown) {
      if (!d.tint) return false;
      this.dropTint(d);
      return true;
    }
    const base = d.skin?.geometry ?? this.share(d.shown).geometry;
    const key = tintKey(node as GroupNode, faces);
    if (d.tint && d.tint.base === base && d.tint.key === key) return false;
    const uv = d.skin ? ((base.getAttribute('uv') as BufferAttribute).array as Float32Array) : null;
    const triangles = base.getAttribute('position').count / 3;
    const colors = cornerColors(node as GroupNode, faces, triangles, { origin: d.skin?.faces, covered: uv ? (t) => underPicture(uv, t) : undefined });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('normal', base.getAttribute('normal'));
    if (uv) geometry.setAttribute('uv', base.getAttribute('uv'));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.boundingSphere = base.boundingSphere;
    if (d.tint) this.dropTint(d);
    d.tint = { key, base, geometry };
    d.mesh.geometry = geometry;
    return true;
  }

  /** Takes the corner colors off; the corners themselves stay with the geometry they belong to. */
  private dropTint(d: Drawn): void {
    if (!d.tint) return;
    for (const name of ['position', 'normal', 'uv']) d.tint.geometry.deleteAttribute(name);
    d.tint.geometry.dispose();
    d.tint = null;
    if (d.shown) d.mesh.geometry = d.skin?.geometry ?? this.share(d.shown).geometry;
  }

  /** Takes the skin off; `keep` is a texture the next skin carries on with, which stays. */
  private dropSkin(d: Drawn, keep: CanvasTexture | null = null): void {
    if (!d.skin) return;
    if (d.skin.map !== keep) d.skin.map.dispose();
    // Shared corners stay with the shared geometry; only the coordinates go.
    if (!d.skin.own) {
      d.skin.geometry.deleteAttribute('position');
      d.skin.geometry.deleteAttribute('normal');
    }
    d.skin.geometry.dispose();
    d.skin = null;
    // Colors laid over the skin's corners are made again over the shared ones (see applyTint).
    if (d.tint) this.dropTint(d);
    if (d.shown) d.mesh.geometry = this.share(d.shown).geometry;
  }

  /** Matrix from the geometry as built to where the node is (and how big it is by now). */
  private place(d: Drawn): void {
    const { node } = d.item;
    const sign = flipSigns(node.flip);
    const m = rotation(node.rot);
    for (let c = 0; c < 3; c++) {
      const s = (node.size[c] / d.built[c]) * sign[c];
      m[c * 3] *= s;
      m[c * 3 + 1] *= s;
      m[c * 3 + 2] *= s;
    }
    m[9] = node.pos[0];
    m[10] = node.pos[1];
    m[11] = node.pos[2];
    toMatrix4(m, d.mesh.matrix);
    d.mesh.matrixWorldNeedsUpdate = true;
    if (d.edges) {
      d.edges.matrix.copy(d.mesh.matrix);
      d.edges.matrixWorldNeedsUpdate = true;
    }
  }

  /** Colors, transparency and edge lines of one node. */
  style(d: Drawn, selected: boolean): void {
    const { node, ghost } = d.item;
    const t = THEMES[this.stage.options.theme];
    const material = d.mesh.material;
    const color = node.hole ? HOLE_COLOR : node.color;
    // A picture carries the object's own color in its pixels, so the material shows it as it is.
    const map = d.skin?.map ?? null;
    if (material.map !== map) {
      material.map = map;
      material.needsUpdate = true;
    }
    // The parts of a mixed group carry their colors on the corners.
    const tinted = Boolean(d.tint);
    if (material.vertexColors !== tinted) {
      material.vertexColors = tinted;
      material.needsUpdate = true;
    }
    // A picture sheet is see-through where its picture is transparent.
    const alphaTest = map && node.type === 'picture' ? 0.5 : 0;
    if (material.alphaTest !== alphaTest) {
      material.alphaTest = alphaTest;
      material.needsUpdate = true;
    }
    material.color.set(map || tinted ? '#ffffff' : color);
    // A ghosted object is a shadow of itself: a faint fill with its outline, so that it still shows where it is.
    const faded = Boolean(node.ghost);
    const faint = node.hole || ghost || faded;
    if (material.transparent !== Boolean(faint)) {
      material.transparent = Boolean(faint);
      material.needsUpdate = true;
    }
    material.opacity = faded ? GHOST_OPACITY : ghost ? 0.6 : node.hole ? 0.38 : 1;
    material.depthWrite = !faint;
    // Selected parts glow a little in their own color; the accent is kept for edges and handles.
    material.emissive.set(selected ? color : 0x000000);
    material.emissiveIntensity = selected ? 0.14 : 0;
    d.mesh.renderOrder = faint ? 1 : 0;

    const wantEdges = (this.stage.options.edges || selected || faded) && Boolean(d.shown) && !node.hidden;
    if (!wantEdges) {
      if (d.edges) d.edges.visible = false;
      return;
    }
    if (!d.edges && d.shown) {
      const shared = this.share(d.shown);
      // The lines come with the mesh from the geometry worker; a mesh with too many to be worth drawing has none.
      if (!shared.edges && d.shown.edges) shared.edges = new BufferGeometry().setAttribute('position', new BufferAttribute(d.shown.edges, 3));
      if (shared.edges) {
        d.edges = new LineSegments(shared.edges, new LineBasicMaterial({ transparent: true }));
        d.edges.matrixAutoUpdate = false;
        d.edges.matrix.copy(d.mesh.matrix);
        this.stage.scene.add(d.edges);
      }
    }
    if (!d.edges) return;
    d.edges.visible = true;
    d.edges.renderOrder = faint ? 1 : 0;
    if (selected) {
      d.edges.material.color.set(t.accent);
      d.edges.material.opacity = 1;
    } else {
      // A darkened shade of the part color reads on any color and theme.
      d.edges.material.color.copy(new Color(color)).multiplyScalar(faded ? 0.5 : 0.22);
      d.edges.material.opacity = node.hole ? 0.5 : faded ? GHOST_EDGE_OPACITY : t.edge;
    }
  }

  private discard(d: Drawn): void {
    this.stage.scene.remove(d.mesh);
    this.dropTint(d);
    this.dropSkin(d);
    d.mesh.material.dispose();
    if (d.edges) {
      this.stage.scene.remove(d.edges);
      d.edges.material.dispose();
    }
  }

  /**
   * The object under the pointer ray: the node, where it was hit, and which
   * triangle of its built mesh. Each object is asked through the tree that
   * came with its mesh (see geometry/bvh.ts), in the mesh's own coordinates:
   * the ray is taken there rather than the triangles to the ray. The mesh as
   * built is what is asked, whatever is drawn over it: a picture cuts the
   * triangles up along its edges, but the surface is the same.
   */
  pick(): { item: ViewItem; point: Vector3; normal: Vector3; triangle: number; drawn: Drawn } | null {
    const { origin, direction } = this.stage.raycaster.ray;
    const { near, far } = this.stage.raycaster;
    const inverse = new Matrix4();
    const linear = new Matrix3();
    const from = new Vector3();
    const along = new Vector3();
    let nearest: Drawn | null = null;
    let distance = far;
    let triangle = -1;
    for (const d of this.drawn.values()) {
      if (!d.mesh.visible || d.item.ghost || !d.shown) continue;
      d.mesh.updateMatrixWorld();
      // A mesh squashed flat has no way back from the design to its own coordinates, and nothing to hit.
      if (d.mesh.matrixWorld.determinant() === 0) continue;
      inverse.copy(d.mesh.matrixWorld).invert();
      from.copy(origin).applyMatrix4(inverse);
      // Turned and scaled but not made of unit length again: a length along it is then the same length along the ray in the design.
      along.copy(direction).applyMatrix3(linear.setFromMatrix4(inverse));
      const hit = castRay(d.shown.bvh, d.shown.render.positions, [from.x, from.y, from.z], [along.x, along.y, along.z], distance);
      if (!hit || hit.t < near) continue;
      nearest = d;
      distance = hit.t;
      triangle = hit.triangle;
    }
    if (!nearest?.shown) return null;
    const p = nearest.shown.render.positions;
    const a = new Vector3().fromArray(p, triangle * 9);
    const b = new Vector3().fromArray(p, triangle * 9 + 3);
    const c = new Vector3().fromArray(p, triangle * 9 + 6);
    // The face's normal goes to the design by the inverse transpose, which keeps it square to a stretched or mirrored face.
    const normal = b.sub(a).cross(c.sub(a)).applyMatrix3(new Matrix3().getNormalMatrix(nearest.mesh.matrixWorld)).normalize();
    return { item: nearest.item, point: origin.clone().addScaledVector(direction, distance), normal, triangle, drawn: nearest };
  }

  dispose(): void {
    for (const d of this.drawn.values()) this.discard(d);
    this.drawn.clear();
    this.painter.dispose();
    this.empty.dispose();
    for (const s of this.shared.values()) {
      s.geometry.dispose();
      s.edges?.dispose();
    }
    this.shared.clear();
  }
}
