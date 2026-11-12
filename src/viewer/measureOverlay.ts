// Measure mode on the plate: the features the pointer can take hold of, the
// ones picked and hovered drawn lit, and the line between two picks with its
// figure on it.
import { BufferAttribute, BufferGeometry, DoubleSide, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial, Vector3 } from 'three';
import type { Group } from 'three';
import { indexFeatures, nearestFeature } from '../geometry/features';
import type { Feature, FeatureIndex } from '../geometry/features';
import { describe as describeFeature } from '../geometry/measure';
import { tr } from '../i18n';
import type { Vec3 } from '../model/types';
import type { BuildResult } from '../worker/protocol';
import type { Drawn, SceneSync } from './sceneSync';
import { THEMES, TOUCH_GRIP_SCALE, pixelSize } from './stage';
import type { Stage } from './stage';
import { dotTexture, textTexture } from './textures';

/** How far from a point or edge (px) the Measure tool still takes hold of it. */
const MEASURE_REACH = 10;
/** Height of the figure on a measuring line, px. */
const MEASURE_LABEL_PIXELS = 20;
/**
 * A mesh of more triangles than this is read away from the pointer's thread
 * (it takes about a second per half million), and cannot be measured until
 * that is done. Anything smaller is read on the spot, in a few milliseconds.
 */
export const READ_APART = 50_000;

/** Whether two features are the one thing: the same kind on the same object at the same place. */
function sameFeature(a: Feature | null, b: Feature | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.node !== b.node) return false;
  const at = (f: Feature): number[] => (f.kind === 'edge' ? [...f.a, ...f.b] : f.kind === 'circle' ? [...f.center, f.radius] : f.kind === 'face' ? [f.region] : [...f.at]);
  const p = at(a);
  const q = at(b);
  return p.length === q.length && p.every((v, i) => Math.abs(v - q[i]) < 1e-6);
}

/** Any unit vector at right angles to `n`. */
function perpendicular(n: Vec3): Vec3 {
  const v = new Vector3(...n).cross(Math.abs(n[0]) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
  return [v.x, v.y, v.z];
}

export class MeasureOverlay {
  /** What is drawn (the hovered feature, the picks, the line between them), the centre dots on offer and the indexed meshes. */
  private hot: Feature | null = null;
  private dots: { sprite: Sprite; feature: Feature }[] = [];
  private label: { sprite: Sprite; aspect: number } | null = null;
  private indexes = new Map<string, { shown: BuildResult; key: string; index: FeatureIndex }>();
  /** The large meshes being read (see `READ_APART`), or that could not be: asked for once per geometry and placement. */
  private reading = new Map<string, { shown: BuildResult; key: string }>();
  /** Whether the pointer is on an object that is still being read. */
  private waiting = false;
  /** The dots' materials, made for one theme and remade for the other. */
  private materials: { theme: 'dark' | 'light'; dot: SpriteMaterial; dotHot: SpriteMaterial } | null = null;

  /** `group` holds everything drawn here; it sits in the overlay. */
  constructor(
    private readonly stage: Pick<Stage, 'overlay' | 'camera' | 'raycaster' | 'renderer' | 'events' | 'options' | 'height' | 'gripScale' | 'requestRender'>,
    private readonly objects: SceneSync,
    private readonly group: Group,
  ) {}

  /** The features of a drawn object as placed, indexed once per geometry and placement and kept while they last. */
  private featureIndexOf(d: Drawn): FeatureIndex | null {
    const shown = d.shown;
    if (!shown) return null;
    d.mesh.updateMatrixWorld();
    const key = d.mesh.matrixWorld.elements.map((v) => v.toFixed(5)).join(',');
    const had = this.indexes.get(d.item.node.id);
    if (had && had.shown === shown && had.key === key) return had.index;
    const read = this.stage.events.featuresOf;
    if (read && shown.triangles > READ_APART) {
      const id = d.item.node.id;
      const asked = this.reading.get(id);
      if (asked && asked.shown === shown && asked.key === key) return null;
      const mine = { shown, key };
      this.reading.set(id, mine);
      // A copy to hand over: the mesh itself stays with the renderer.
      read(shown.render.positions.slice(), [...d.mesh.matrixWorld.elements]).then(
        (index) => {
          // The object has changed or moved meanwhile: this reading is of what it was.
          if (this.reading.get(id) !== mine) return;
          this.reading.delete(id);
          this.indexes.set(id, { shown, key, index });
          if (!this.stage.options.measure) return;
          this.sync();
          this.stage.requestRender();
        },
        (e: unknown) => {
          // Called off along with other work of the worker's: the pointer's next move asks again.
          if (e instanceof Error && e.name === 'Cancelled') {
            if (this.reading.get(id) === mine) this.reading.delete(id);
          }
          // Otherwise left as asked for, so that the pointer's every move does not ask, and fail, again.
          else console.warn(e);
        },
      );
      return null;
    }
    const src = shown.render.positions;
    const out = new Float32Array(src.length);
    const v = new Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(d.mesh.matrixWorld);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    const index = indexFeatures(out);
    this.indexes.set(d.item.node.id, { shown, key, index });
    return index;
  }

  /** The feature under the pointer: a centre dot first (the smaller target, and inside the object), else the nearest feature on the surface hit. */
  pick(event?: PointerEvent): Feature | null {
    const m = this.stage.options.measure;
    if (!m) return null;
    this.stage.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layout();
    this.stage.overlay.updateMatrixWorld();
    this.stage.gripScale = 1;
    let best: Feature | null = null;
    let bestDistance = Infinity;
    for (const dot of this.dots) {
      const hit = this.stage.raycaster.intersectObject(dot.sprite, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = dot.feature;
        bestDistance = hit.distance;
      }
    }
    if (best) return best;
    this.waiting = false;
    const hit = this.objects.pick();
    if (!hit) return null;
    const index = this.featureIndexOf(hit.drawn);
    if (!index) {
      this.waiting = this.reading.has(hit.item.node.id);
      return null;
    }
    return nearestFeature(index, hit.item.node.id, [hit.point.x, hit.point.y, hit.point.z], hit.triangle, new Set(m.kinds), MEASURE_REACH * pixelSize(this.stage, hit.point));
  }

  hover(feature: Feature | null, event: PointerEvent): void {
    const same = sameFeature(this.hot, feature);
    this.hot = feature;
    // Over a large object that is still being read, the pointer says to wait.
    const waiting = !feature && this.waiting;
    this.stage.renderer.domElement.style.cursor = feature ? 'crosshair' : waiting ? 'progress' : '';
    this.stage.events.onReadout(feature ? describeFeature(feature, this.stage.options.units).lines.join(' · ') : waiting ? tr('Reading the shape…') : null, event.clientX, event.clientY);
    if (same) return;
    this.sync();
    this.stage.requestRender();
  }

  /** The pointer has left the view: nothing is hovered any more. */
  unhover(): void {
    if (this.waiting) {
      this.waiting = false;
      this.stage.events.onReadout(null, 0, 0);
    }
    if (this.hot) {
      this.hot = null;
      this.stage.events.onReadout(null, 0, 0);
      this.sync();
      this.stage.requestRender();
    }
  }

  /** A feature index goes with the object, or the geometry, it was made from. */
  prune(): void {
    for (const [id, entry] of this.indexes) if (this.objects.drawn.get(id)?.shown !== entry.shown) this.indexes.delete(id);
    for (const [id, entry] of this.reading) if (this.objects.drawn.get(id)?.shown !== entry.shown) this.reading.delete(id);
  }

  /** Takes away everything measure mode drew; the dots' shared materials stay. */
  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof Mesh || child instanceof Line) {
        child.geometry.dispose();
        (child.material as MeshBasicMaterial | LineBasicMaterial).dispose();
      } else if (child instanceof Sprite && child === this.label?.sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    this.dots = [];
    this.label = null;
  }

  private disposeMaterials(): void {
    for (const material of this.materials ? [this.materials.dot, this.materials.dotHot] : []) {
      material.map?.dispose();
      material.dispose();
    }
    this.materials = null;
  }

  /** Redraws what measure mode shows: the picks, the hovered feature, the line between the picks with its figure, and the centre dots on offer. */
  sync(): void {
    this.clear();
    const m = this.stage.options.measure;
    if (!m) {
      this.hot = null;
      return;
    }
    const { theme } = this.stage.options;
    const t = THEMES[theme];
    const hotColor = theme === 'dark' ? 0xffffff : 0x1b1f27;
    if (this.materials?.theme !== theme) {
      this.disposeMaterials();
      this.materials = {
        theme,
        dot: new SpriteMaterial({ map: dotTexture('#17cdd3'), depthTest: false, depthWrite: false, transparent: true }),
        dotHot: new SpriteMaterial({ map: dotTexture(theme === 'dark' ? '#ffffff' : '#1b1f27', '#17cdd3'), depthTest: false, depthWrite: false, transparent: true }),
      };
    }
    for (const pick of m.picks) this.drawFeature(pick, t.accent, false);
    if (this.hot && !m.picks.some((p) => sameFeature(p, this.hot))) this.drawFeature(this.hot, hotColor, true);
    const r = m.result;
    if (r?.to) {
      const material = new LineBasicMaterial({ color: t.accent, transparent: true, opacity: 0.95, depthTest: false });
      const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([...r.from, ...r.to]), 3));
      const line = new Line(geometry, material);
      line.renderOrder = 13;
      this.group.add(line);
      for (const end of [r.from, r.to]) {
        const dot = new Sprite(this.materials.dot);
        dot.position.set(end[0], end[1], end[2]);
        dot.renderOrder = 13;
        dot.userData.pixels = 7;
        this.group.add(dot);
      }
      const label = textTexture(r.text, this.stage.options.theme);
      const sprite = new Sprite(new SpriteMaterial({ map: label.texture, depthTest: false, depthWrite: false, transparent: true }));
      sprite.position.set((r.from[0] + r.to[0]) / 2, (r.from[1] + r.to[1]) / 2, (r.from[2] + r.to[2]) / 2);
      sprite.renderOrder = 14;
      this.group.add(sprite);
      this.label = { sprite, aspect: label.aspect };
    }
    // The centre of each object, a dot inside it to take hold of.
    if (m.kinds.includes('center')) {
      for (const d of this.objects.drawn.values()) {
        if (!d.mesh.visible || d.item.ghost) continue;
        const index = this.featureIndexOf(d);
        if (!index) continue;
        const at = index.center;
        const feature: Feature = { kind: 'center', node: d.item.node.id, at };
        const lit = sameFeature(feature, this.hot) || m.picks.some((p) => sameFeature(p, feature));
        const sprite = new Sprite(lit ? this.materials.dotHot : this.materials.dot);
        sprite.position.set(at[0], at[1], at[2]);
        sprite.renderOrder = 12;
        sprite.userData.pixels = lit ? 15 : 10;
        this.group.add(sprite);
        this.dots.push({ sprite, feature });
      }
    }
    this.layout();
  }

  /** One feature, drawn in a colour: a dot, a line, a ring or the face's own triangles. */
  private drawFeature(f: Feature, color: number, hot: boolean): void {
    const materials = this.materials!;
    switch (f.kind) {
      case 'center':
        return; // drawn among the centre dots
      case 'point':
      case 'middle':
      case 'quadrant':
      case 'facecenter': {
        const dot = new Sprite(hot ? materials.dotHot : materials.dot);
        dot.position.set(f.at[0], f.at[1], f.at[2]);
        dot.renderOrder = 13;
        dot.userData.pixels = hot ? 15 : 11;
        this.group.add(dot);
        return;
      }
      case 'edge':
      case 'circle': {
        const pts: number[] = [];
        if (f.kind === 'edge') pts.push(...f.a, ...f.b);
        else {
          // Round the circle from its start (an arc's first end, or anywhere) through its sweep.
          const n = f.normal;
          const start = f.ends ? [f.ends[0][0] - f.center[0], f.ends[0][1] - f.center[1], f.ends[0][2] - f.center[2]] : perpendicular(n);
          const u = new Vector3(...start).normalize();
          const v = new Vector3(...n).cross(u).normalize();
          const steps = Math.max(8, Math.ceil(f.sweep / 5));
          for (let i = 0; i <= steps; i++) {
            const a = ((f.sweep * i) / steps) * (Math.PI / 180);
            pts.push(f.center[0] + f.radius * (u.x * Math.cos(a) + v.x * Math.sin(a)), f.center[1] + f.radius * (u.y * Math.cos(a) + v.y * Math.sin(a)), f.center[2] + f.radius * (u.z * Math.cos(a) + v.z * Math.sin(a)));
          }
        }
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
        const line = new Line(geometry, new LineBasicMaterial({ color, transparent: true, opacity: hot ? 0.9 : 1, depthTest: false }));
        line.renderOrder = 13;
        this.group.add(line);
        return;
      }
      case 'face': {
        const d = this.objects.drawn.get(f.node);
        const index = d ? this.featureIndexOf(d) : null;
        const region = index?.regions[f.region];
        if (!d?.shown || !region) return;
        const src = d.shown.render.positions;
        const pts = new Float32Array(region.triangles.length * 9);
        region.triangles.forEach((tri, i) => pts.set(src.subarray(tri * 9, tri * 9 + 9), i * 9));
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(pts, 3));
        const mesh = new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity: hot ? 0.3 : 0.45, depthTest: false, side: DoubleSide }));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(d.mesh.matrixWorld);
        mesh.renderOrder = 12;
        this.group.add(mesh);
        return;
      }
    }
  }

  /** Dots and the figure at the same size on screen whatever the zoom. */
  layout(): void {
    for (const child of this.group.children) {
      if (!(child instanceof Sprite)) continue;
      if (child === this.label?.sprite) {
        const h = MEASURE_LABEL_PIXELS * pixelSize(this.stage, child.position);
        child.scale.set(h * this.label.aspect, h, 1);
      } else child.scale.setScalar(((child.userData.pixels as number) ?? 10) * pixelSize(this.stage, child.position) * this.stage.gripScale);
    }
  }

  dispose(): void {
    this.clear();
    this.disposeMaterials();
    this.indexes.clear();
    this.reading.clear();
  }
}
