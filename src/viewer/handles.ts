// The handles round the selection: the box they sit on, the grips, move
// arrows and turn rings (or, lining things up, the anchor dots), where each
// goes for the camera as it stands, and which one the pointer is on. Also the
// padlocks over selected objects that are locked.
import { Group, Mesh, MeshBasicMaterial, Sprite, Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, ConeGeometry, LineBasicMaterial, LineSegments, Object3D, SpriteMaterial, TorusGeometry } from 'three';
import { boundsCenter, boxBounds, frameMatrix, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import { ALIGN_MODES, alignDot } from '../model/ops';
import type { SceneNode, Vec3 } from '../model/types';
import { pointOf } from './dragMath';
import { SLIDE_ARROW, moveArrow } from './markers';
import { AXIS_COLORS, TOUCH_GRIP_SCALE, UP, pixelSize, toMatrix4 } from './stage';
import type { Stage } from './stage';
import type { AlignMode, HandleKind } from './types';

/** Distance of the anchor dots from the box, in pixels. */
const ALIGN_GAP = 22;
/** Size of a unit of the move arrows on a selection, in pixels; each arrow stands out from a face of the selection's box, `SLIDE_ARROW` units long. */
export const MOVE_ARROW_PIXELS = 54;
/** An anchor dot with nothing left to do: grey, dim and not for clicking. */
export const DONE_DOT = { fill: '#3c4146', rim: '#8a9094', opacity: 0.45, scale: 0.8 };
const LOCK_BADGE_PIXELS = 22;
/** A move arrow seen this nearly end-on is hidden: it would sit over the grip it stands out from, and the pointer cannot drag along it. */
const ARROW_END_ON = 0.97;

export interface Handle {
  kind: HandleKind;
  object: Object3D;
  /** Pixel size on screen. */
  pixels: number;
  cursor: string;
}

/** The box the handles sit on: an oriented frame and half extents. */
export interface Frame {
  matrix: Mat;
  half: Vec3;
  /** Axis-aligned bounds of the selection, for the handles that work along fixed axes. */
  bounds: Bounds;
  single: SceneNode | null;
  /** The frame is the one object's own (Object axes): the handles work along its axes. */
  local: boolean;
}

/** The shared pieces the handles are made of and the lines they are drawn with, made once by the viewer. */
export interface HandleParts {
  /** Unit cube edges, scaled to the selection's box. */
  outline: LineSegments<BufferGeometry, LineBasicMaterial>;
  /** One line per axis through its three anchor dots. */
  alignLines: LineSegments<BufferGeometry, LineBasicMaterial>;
  /** Quarter ring with an arrowhead at each end, in the XY plane from +X to +Y. */
  arcParts: { arc: TorusGeometry; head: ConeGeometry; hit: TorusGeometry };
}

export class Handles {
  frame: Frame | null = null;
  list: Handle[] = [];
  mode: 'none' | 'single' | 'several' | 'locked' | 'align' = 'none';
  hovered: Handle | null = null;
  /** A padlock over each selected object that is locked, by id: it shows why a drag leaves that one where it is. */
  readonly lockBadges = new Map<string, Sprite>();

  /** `typing` tells the handle whose value is being typed, if any. */
  constructor(
    private readonly stage: Pick<Stage, 'overlay' | 'camera' | 'raycaster' | 'renderer' | 'events' | 'grips' | 'options' | 'items' | 'height' | 'placing' | 'gripScale' | 'requestRender'>,
    readonly parts: HandleParts,
    private readonly typing: () => Handle | undefined,
  ) {}

  /** One padlock per selected object that is locked (and in reach). */
  syncLockBadges(): void {
    const wanted = new Set<string>();
    for (const i of this.stage.items) if (i.selected && i.node.locked && !i.node.hidden && !i.ghost) wanted.add(i.node.id);
    for (const [id, badge] of this.lockBadges) {
      if (wanted.has(id)) continue;
      this.stage.overlay.remove(badge);
      this.lockBadges.delete(id);
    }
    for (const id of wanted) {
      if (this.lockBadges.has(id)) continue;
      const badge = new Sprite(this.stage.grips.lock);
      badge.renderOrder = 12;
      this.stage.overlay.add(badge);
      this.lockBadges.set(id, badge);
    }
  }

  /** Each padlock over the middle of its object, the same size at any zoom; bigger while a drag is leaving the object behind. */
  layoutLockBadges(editing: boolean): void {
    if (this.lockBadges.size === 0) return;
    const byId = new Map(this.stage.items.map((i) => [i.node.id, i.node]));
    for (const [id, badge] of this.lockBadges) {
      const node = byId.get(id);
      if (!node) continue;
      const at = new Vector3(...boundsCenter(this.stage.events.boundsOf(node)));
      badge.position.copy(at);
      badge.scale.setScalar(LOCK_BADGE_PIXELS * pixelSize(this.stage, at) * (editing ? 1.4 : 1));
    }
  }

  clear(): void {
    for (const h of this.list) {
      this.stage.overlay.remove(h.object);
      h.object.traverse((o) => {
        const material = (o as Mesh).material as MeshBasicMaterial | SpriteMaterial | undefined;
        // Grip sprites share their materials; the rings own theirs.
        if (material && !(o instanceof Sprite)) material.dispose();
      });
    }
    this.list = [];
    // A look at an anchor dot ends with the dot: the objects come back from where it showed them.
    if (this.hovered?.kind.type === 'align') this.stage.events.onAlignHover(null, 'center');
    this.hovered = null;
    this.mode = 'none';
    this.parts.alignLines.visible = false;
  }

  /** Recompute the selection's box and which handles it gets. */
  updateFrame(): void {
    const picked = this.stage.items.filter((i) => i.selected && !i.ghost && !i.node.hidden);
    const align = this.stage.options.align;
    // Nothing picked and nothing to line up: no frame. (Lining up a joint or sensor has dots with no selection.)
    if (picked.length === 0 && !align) {
      this.frame = null;
      this.parts.outline.visible = false;
      if (this.mode !== 'none') this.clear();
      return;
    }
    const bounds = align ? align.bounds : unionBounds(picked.map((i) => this.stage.events.boundsOf(i.node)));
    const single = !align && picked.length === 1 ? picked[0].node : null;
    // The handles sit on a box square to the design's axes whichever way the selection is turned, so that
    // they keep still while it turns: one object's own box as it stands (its size exactly, for a square
    // turn), several the box round them all.
    // With Object axes on, one object's handles follow its own box instead.
    if (single && this.stage.options.objectAxes) {
      this.frame = { matrix: frameMatrix(single), half: [single.size[0] / 2, single.size[1] / 2, single.size[2] / 2], bounds, single, local: true };
    } else {
      const box = single ? boxBounds(single) : bounds;
      const c = boundsCenter(box);
      this.frame = {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, c[0], c[1], c[2]],
        half: [(box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2],
        bounds,
        single,
        local: false,
      };
    }
    const mode = align ? 'align' : picked.every((i) => i.node.locked) ? 'locked' : single ? 'single' : 'several';
    if (mode !== this.mode) this.build(mode);

    const f = this.frame;
    const m = [...f.matrix] as Mat;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(f.half[c] * 2, 1e-6);
    toMatrix4(m, this.parts.outline.matrix);
    this.parts.outline.matrixWorldNeedsUpdate = true;
    this.parts.outline.visible = true;
  }

  private build(mode: 'single' | 'several' | 'locked' | 'align'): void {
    this.clear();
    this.mode = mode;
    if (mode === 'locked') return;
    const add = (kind: HandleKind, object: Object3D, pixels: number, cursor: string) => {
      object.renderOrder = 10;
      this.stage.overlay.add(object);
      this.list.push({ kind, object, pixels, cursor });
    };
    if (mode === 'align') {
      for (const axis of [0, 1, 2] as const) for (const m of ALIGN_MODES) add({ type: 'align', axis, mode: m }, new Sprite(this.stage.grips.axisDot[axis].idle), 15, 'pointer');
      this.parts.alignLines.visible = true;
      return;
    }
    // One object gets grips on its own box; several get them on the box round them all, which stretches them together.
    for (const sx of [-1, 0, 1] as const) {
      for (const sy of [-1, 0, 1] as const) {
        if (sx === 0 && sy === 0) continue;
        const corner = sx !== 0 && sy !== 0;
        add({ type: 'resize', sx, sy }, new Sprite(corner ? this.stage.grips.corner : this.stage.grips.edge), corner ? 13 : 11, 'nwse-resize');
      }
    }
    add({ type: 'height', side: 1 }, new Sprite(this.stage.grips.corner), 13, 'ns-resize');
    add({ type: 'height', side: -1 }, new Sprite(this.stage.grips.corner), 13, 'ns-resize');
    for (const axis of [0, 1, 2] as const) add({ type: 'move', axis }, moveArrow(axis, SLIDE_ARROW), MOVE_ARROW_PIXELS, 'move');
    for (const axis of [0, 1, 2] as const) {
      const ring = new Group();
      const material = new MeshBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false, toneMapped: false, transparent: true });
      const arc = new Mesh(this.parts.arcParts.arc, material);
      const head = new Mesh(this.parts.arcParts.head, material);
      head.position.set(1, 0, 0);
      head.rotation.z = Math.PI; // tip towards -Y: past the start of the arc
      head.position.y = -0.1;
      const tail = new Mesh(this.parts.arcParts.head, material);
      tail.position.set(-0.1, 1, 0);
      tail.rotation.z = Math.PI / 2; // tip towards -X: past the end of the arc
      // A fat invisible ring makes the thin one easy to grab.
      const hit = new Mesh(this.parts.arcParts.hit, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
      for (const part of [arc, head, tail, hit]) part.renderOrder = 10;
      ring.add(arc, head, tail, hit);
      ring.matrixAutoUpdate = false;
      add({ type: 'rotate', axis }, ring, 30, 'grab');
    }
  }

  /** Whether the line along a direction through a point is seen nearly end-on. */
  private endOn(at: Vector3, dir: Vector3): boolean {
    const view = at.clone().sub(this.stage.camera.position).normalize();
    return Math.abs(view.dot(dir)) > ARROW_END_ON;
  }

  /** One of the frame's axes in the scene: a design axis, or the object's own with Object axes on. */
  frameAxis(axis: 0 | 1 | 2): Vector3 {
    const m = this.frame!.matrix;
    return new Vector3(m[axis * 3], m[axis * 3 + 1], m[axis * 3 + 2]).normalize();
  }

  /** The frame's turn alone, for turning about its axes; none when they are the design's. */
  frameTurn(): Mat | undefined {
    const f = this.frame!;
    return f.local ? ([...f.matrix.slice(0, 9), 0, 0, 0] as Mat) : undefined;
  }

  framePoint(local: Vec3): Vector3 {
    return pointOf(this.frame!.matrix, local);
  }

  /** Where the turn handle of an axis sits, and the two directions its quarter ring spans. */
  private ringPlacement(axis: 0 | 1 | 2): { at: Vector3; from: Vector3; to: Vector3 } {
    if (this.frame!.local) {
      // The same corners and edges of the object's own box.
      const [hx, hy, hz] = this.frame!.half;
      const [x, y, z] = [this.frameAxis(0), this.frameAxis(1), this.frameAxis(2)];
      if (axis === 2) return { at: this.framePoint([hx, -hy, -hz]), from: y.negate(), to: x };
      if (axis === 0) return { at: this.framePoint([0, -hy, hz]), from: y.negate(), to: z };
      return { at: this.framePoint([-hx, 0, hz]), from: x.negate(), to: z };
    }
    const { min, max } = this.frame!.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    if (axis === 2) return { at: new Vector3(max[0], min[1], min[2]), from: new Vector3(0, -1, 0), to: new Vector3(1, 0, 0) };
    if (axis === 0) return { at: new Vector3(cx, min[1], max[2]), from: new Vector3(0, -1, 0), to: new Vector3(0, 0, 1) };
    // On the -X side: the +X side has the X move arrow.
    return { at: new Vector3(min[0], cy, max[2]), from: new Vector3(-1, 0, 0), to: new Vector3(0, 0, 1) };
  }

  /** Put every handle where it belongs for the current camera. Called before each draw. */
  layout(): void {
    const f = this.frame;
    if (!f) return;
    const [hx, hy, hz] = f.half;
    if (this.mode === 'align') {
      this.layoutAlignDots();
      return;
    }
    // The handle whose value is being typed stays lit until the boxes go.
    const typing = this.typing();
    for (const h of this.list) {
      const k = h.kind;
      if (k.type === 'resize' || k.type === 'height') {
        const at = k.type === 'resize' ? this.framePoint([k.sx * hx, k.sy * hy, -hz]) : this.framePoint([0, 0, k.side * hz]);
        h.object.position.copy(at);
        h.object.scale.setScalar(h.pixels * pixelSize(this.stage, at) * (h === typing ? 1.6 : h === this.hovered ? 1.35 : 1) * this.stage.gripScale);
        const corner = k.type === 'height' || (k.sx !== 0 && k.sy !== 0);
        (h.object as Sprite).material = h === typing ? this.stage.grips.typing : corner ? this.stage.grips.corner : this.stage.grips.edge;
      } else if (k.type === 'move') {
        // Out of the selection along the design's axes: from the middle of its +X and +Y sides, and
        // straight up from the top grip, past the highest point.
        // With Object axes, out of the middle of the object's own +X, +Y and top sides, along its axes.
        const dir = this.frameAxis(k.axis);
        let at: Vector3;
        if (f.local) at = this.framePoint([k.axis === 0 ? hx : 0, k.axis === 1 ? hy : 0, k.axis === 2 ? hz : 0]);
        else {
          at = k.axis === 2 ? this.framePoint([0, 0, hz]) : this.framePoint([0, 0, 0]);
          at.setComponent(k.axis, Math.max(at.getComponent(k.axis), f.bounds.max[k.axis]));
        }
        h.object.position.copy(at);
        h.object.quaternion.setFromUnitVectors(UP, dir);
        h.object.scale.setScalar(h.pixels * pixelSize(this.stage, at) * (h === typing ? 1.3 : h === this.hovered ? 1.15 : 1) * this.stage.gripScale);
        h.object.visible = !this.endOn(at, dir);
      } else {
        const { at, from, to } = this.ringPlacement(k.axis);
        // The ring's hit tube is already several times fatter than the drawn arc, so it is not scaled.
        const s = h.pixels * pixelSize(this.stage, at) * (h === typing ? 1.3 : h === this.hovered ? 1.15 : 1);
        const normal = from.clone().cross(to);
        h.object.matrix.makeBasis(from.multiplyScalar(s), to.multiplyScalar(s), normal.multiplyScalar(s)).setPosition(at);
        h.object.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /** Whether an anchor dot has nothing left to do: the objects already line up there. */
  private alignDone(kind: { axis: 0 | 1 | 2; mode: AlignMode }): boolean {
    return this.stage.options.align?.done[alignDot(kind.axis, kind.mode)] ?? false;
  }

  /**
   * The nine anchor dots: three along X in front of the box, three along Y
   * beside it, three along Z up its front-left corner, all a little outside.
   */
  private layoutAlignDots(): void {
    const { min, max } = this.frame!.bounds;
    const corner = new Vector3(min[0], min[1], min[2]);
    const gap = ALIGN_GAP * pixelSize(this.stage, corner);
    const at = (axis: number, mode: AlignMode): Vector3 => {
      const v = mode === 'min' ? min[axis] : mode === 'max' ? max[axis] : (min[axis] + max[axis]) / 2;
      if (axis === 0) return new Vector3(v, min[1] - gap, min[2]);
      if (axis === 1) return new Vector3(min[0] - gap, v, min[2]);
      return new Vector3(min[0] - gap, min[1] - gap, v);
    };
    for (const h of this.list) {
      if (h.kind.type !== 'align') continue;
      const p = at(h.kind.axis, h.kind.mode);
      const done = this.alignDone(h.kind);
      const hot = !done && h === this.hovered;
      const dots = this.stage.grips.axisDot[h.kind.axis];
      (h.object as Sprite).material = done ? this.stage.grips.dotDone : hot ? dots.hot : dots.idle;
      h.object.position.copy(p);
      h.object.scale.setScalar(h.pixels * pixelSize(this.stage, p) * (done ? DONE_DOT.scale : hot ? 1.3 : 1) * this.stage.gripScale);
    }
    const pts = this.parts.alignLines.geometry.getAttribute('position') as BufferAttribute;
    for (const axis of [0, 1, 2]) {
      at(axis, 'min').toArray(pts.array as Float32Array, axis * 6);
      at(axis, 'max').toArray(pts.array as Float32Array, axis * 6 + 3);
    }
    pts.needsUpdate = true;
  }

  pick(event?: PointerEvent): Handle | null {
    if (!this.frame || this.list.length === 0) return null;
    this.stage.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layout();
    this.stage.overlay.updateMatrixWorld();
    this.stage.gripScale = 1;
    let best: Handle | null = null;
    let bestDistance = Infinity;
    for (const h of this.list) {
      // A greyed anchor dot is not there to be clicked, nor a hidden move arrow.
      if ((h.kind.type === 'align' && this.alignDone(h.kind)) || !h.object.visible) continue;
      const hit = this.stage.raycaster.intersectObject(h.object, true)[0];
      // Grips win over rings when both are under the pointer: they are the smaller target.
      const distance = hit ? hit.distance - (h.kind.type === 'rotate' ? 0 : 1e6) : Infinity;
      if (distance < bestDistance) {
        best = h;
        bestDistance = distance;
      }
    }
    return best;
  }

  hover(handle: Handle | null): void {
    if (handle === this.hovered) return;
    const was = this.hovered?.kind;
    this.hovered = handle;
    // Over an anchor dot the objects move there for a look; off it, they come back.
    if (handle?.kind.type === 'align') this.stage.events.onAlignHover(handle.kind.axis, handle.kind.mode);
    else if (was?.type === 'align') this.stage.events.onAlignHover(null, 'center');
    if (!this.stage.placing) this.stage.renderer.domElement.style.cursor = handle ? handle.cursor : '';
    this.stage.requestRender();
  }
}
