// Robot mode on the plate: the picked joint or sensor as a marker with its
// move arrows, the others drawn small, a lidar's rays while the test drive
// runs, the snap points on offer, and the drag of a marker by its handles.
import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments, Sprite, Vector3 } from 'three';
import type { Group } from 'three';
import { tidyVec } from '../model/math';
import type { Mat } from '../model/math';
import type { Vec3 } from '../model/types';
import { lidarAngles } from '../robot/types';
import { alongAxis, snapTo } from './dragMath';
import { disposeMarker, lightPad, markerObject } from './markers';
import { THEMES, TOUCH_GRIP_SCALE, axisVector, fmt, pixelSize, toMatrix4 } from './stage';
import type { Stage } from './stage';

/** On-screen length of a marker's unit, in pixels: the joint axis reaches this far each way from its origin. */
const MARKER_PIXELS = 60;
/** The same for the markers of the joints and sensors not picked. */
const DIM_MARKER_PIXELS = 34;

/** A move arrow (the design's X, Y or Z) or the joint's own axis rod. */
export type MarkerHandle = 0 | 1 | 2 | 'slide';

/** A marker being dragged: by which handle, from where, along which line, and where on the line it was taken hold of. */
export interface MarkerDrag {
  how: MarkerHandle;
  origin: Vector3;
  axis: Vector3;
  grabT: number;
}

/** The objects the markers are drawn with, made once by the viewer and kept in the overlay. */
export interface RobotParts {
  /** The picked joint or sensor. */
  marker: Group;
  /** Its move arrows, one per design axis in the axis colors. */
  markerArrows: Group;
  /** The line through the hovered snap point along its axis. */
  snapAxis: LineSegments<BufferGeometry, LineBasicMaterial>;
}

export class RobotOverlay {
  /** What the picked marker's lines were last built for. */
  private markerKey = '';
  /** The move arrow under the pointer. */
  private hotArrow: number | null = null;
  /** The other joints and sensors, drawn small, by id. */
  private dimMarkers = new Map<string, Group>();
  private dimKey = '';
  /** The rays of the lidars among the dim markers, by marker id, while the test drive reports them. */
  private rays = new Map<string, LineSegments<BufferGeometry, LineBasicMaterial>>();
  /** Dots at the snap points on offer, one sprite each, and the hovered one. */
  private snapDots: Sprite[] = [];
  private snapHot: number | null = null;

  constructor(
    private readonly stage: Pick<Stage, 'overlay' | 'camera' | 'raycaster' | 'events' | 'grips' | 'options' | 'height' | 'gripScale' | 'requestRender'>,
    readonly parts: RobotParts,
  ) {}

  /** Whether there is anything of Robot mode to lay out and draw. */
  get shown(): boolean {
    return this.parts.marker.visible || this.dimMarkers.size > 0 || this.snapDots.length > 0;
  }

  /** Rebuilds the picked marker and the small ones when what they show has changed; where they stand is laid out every frame. */
  syncMarkers(): void {
    const { theme } = this.stage.options;
    const t = THEMES[theme];
    const mk = this.stage.options.marker;
    const markerKey = mk ? `${theme}:${JSON.stringify({ ...mk, matrix: undefined, ranges: undefined })}` : '';
    if (markerKey !== this.markerKey) {
      this.markerKey = markerKey;
      disposeMarker(this.parts.marker);
      if (mk) {
        const built = markerObject(mk, t.accent);
        this.parts.marker.add(...built.children);
      }
    }
    this.parts.marker.visible = Boolean(mk);
    this.parts.markerArrows.visible = Boolean(mk);
    const dims = this.stage.options.markers ?? [];
    const dimKey = `${theme}:${JSON.stringify(dims.map((d) => ({ id: d.id, marker: { ...d.marker, matrix: undefined, pressed: undefined, ranges: d.marker.kind === 'lidar' ? d.marker.ranges?.length : undefined } })))}`;
    if (dimKey !== this.dimKey) {
      this.dimKey = dimKey;
      for (const g of this.dimMarkers.values()) {
        disposeMarker(g);
        this.stage.overlay.remove(g);
      }
      this.dimMarkers.clear();
      this.disposeRays();
      for (const d of dims) {
        const g = markerObject(d.marker, t.accent, true);
        this.stage.overlay.add(g);
        this.dimMarkers.set(d.id, g);
        if (d.marker.kind === 'lidar' && d.marker.ranges) {
          // One line per ray, from the lidar to what the ray met; laid out with the readings every frame.
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(new Float32Array(d.marker.ranges.length * 6), 3));
          const rays = new LineSegments(geometry, new LineBasicMaterial({ color: t.accent, transparent: true, opacity: 0.8, depthTest: false }));
          rays.matrixAutoUpdate = false;
          rays.renderOrder = 9;
          rays.frustumCulled = false;
          this.stage.overlay.add(rays);
          this.rays.set(d.id, rays);
        }
      }
    }
  }

  /** One dot per snap point on offer; the dots are kept across option changes and only remade when the count changes. */
  syncSnaps(): void {
    const wanted = this.stage.options.snaps?.length ?? 0;
    while (this.snapDots.length > wanted) {
      const dot = this.snapDots.pop()!;
      this.stage.overlay.remove(dot);
    }
    while (this.snapDots.length < wanted) {
      const dot = new Sprite(this.stage.grips.dot);
      dot.renderOrder = 11;
      this.stage.overlay.add(dot);
      this.snapDots.push(dot);
    }
    if (this.snapHot !== null && this.snapHot >= wanted) this.hoverSnap(null);
    this.parts.snapAxis.visible = false;
  }

  /** The markers at their origins, each unit scaled to its pixel size on screen; the picked one's grips beside it. */
  layoutMarker(): void {
    const place = (group: Group, matrix: Mat, pixels: number) => {
      const scale = pixels * pixelSize(this.stage, new Vector3(matrix[9], matrix[10], matrix[11]));
      const m = [...matrix] as Mat;
      for (let i = 0; i < 9; i++) m[i] *= scale;
      toMatrix4(m, group.matrix);
      group.matrixWorldNeedsUpdate = true;
    };
    const mk = this.stage.options.marker;
    if (mk) {
      place(this.parts.marker, mk.matrix, MARKER_PIXELS);
      // The arrows stand on the design's axes whatever way the marker is turned; bigger to a finger, and the hot one a little more.
      place(this.parts.markerArrows, [1, 0, 0, 0, 1, 0, 0, 0, 1, mk.matrix[9], mk.matrix[10], mk.matrix[11]], MARKER_PIXELS * this.stage.gripScale);
      this.parts.markerArrows.children.forEach((arrow, i) => arrow.scale.setScalar(i === this.hotArrow ? 1.15 : 1));
    }
    for (const d of this.stage.options.markers ?? []) {
      const g = this.dimMarkers.get(d.id);
      if (g) place(g, d.marker.matrix, DIM_MARKER_PIXELS);
      const rays = d.marker.kind === 'lidar' ? this.rays.get(d.id) : undefined;
      if (rays && d.marker.kind === 'lidar' && d.marker.ranges) this.layoutRays(rays, d.marker.matrix, d.marker.hfov, d.marker.ranges);
      if (g && d.marker.kind === 'touch') lightPad(g, Boolean(d.marker.pressed));
    }
  }

  /** A lidar's rays in the design's own scale: each from the origin to the point its reading puts, in the sweep's plane; misses are left out. */
  private layoutRays(rays: LineSegments<BufferGeometry, LineBasicMaterial>, matrix: Mat, hfov: number, ranges: number[]): void {
    const angles = lidarAngles(ranges.length, (Math.min(Math.max(hfov, 1), 360) * Math.PI) / 180);
    const position = rays.geometry.getAttribute('position') as BufferAttribute;
    const p = position.array as Float32Array;
    const [ox, oy, oz] = [matrix[9], matrix[10], matrix[11]];
    let n = 0;
    for (let i = 0; i < ranges.length && n * 6 + 5 < p.length; i++) {
      const r = ranges[i];
      if (!(r >= 0)) continue;
      const c = Math.cos(angles[i]);
      const s = Math.sin(angles[i]);
      p[n * 6] = ox;
      p[n * 6 + 1] = oy;
      p[n * 6 + 2] = oz;
      p[n * 6 + 3] = ox + (matrix[0] * c + matrix[3] * s) * r;
      p[n * 6 + 4] = oy + (matrix[1] * c + matrix[4] * s) * r;
      p[n * 6 + 5] = oz + (matrix[2] * c + matrix[5] * s) * r;
      n++;
    }
    position.needsUpdate = true;
    rays.geometry.setDrawRange(0, n * 2);
    rays.visible = n > 0;
  }

  private disposeRays(): void {
    for (const r of this.rays.values()) {
      r.geometry.dispose();
      r.material.dispose();
      this.stage.overlay.remove(r);
    }
    this.rays.clear();
  }

  /** Which handle of the picked marker is under the pointer: one of its move arrows, or (a joint) its axis rod. */
  pickMarkerHandle(event?: PointerEvent): MarkerHandle | null {
    if (!this.stage.options.marker || !this.parts.marker.visible) return null;
    this.stage.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutMarker();
    this.stage.overlay.updateMatrixWorld();
    this.stage.gripScale = 1;
    let best: MarkerHandle | null = null;
    let bestDistance = Infinity;
    for (const arrow of this.parts.markerArrows.children) {
      const target = arrow.children.find((c) => c.userData.hit);
      const hit = target && this.stage.raycaster.intersectObject(target, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = arrow.userData.axis as 0 | 1 | 2;
        bestDistance = hit.distance;
      }
    }
    if (best !== null) return best;
    const slide = this.parts.marker.children.find((c) => c.userData.slide);
    return slide && this.stage.raycaster.intersectObject(slide, false).length ? 'slide' : null;
  }

  hoverArrow(handle: MarkerHandle | null): void {
    const hot = typeof handle === 'number' ? handle : null;
    if (hot === this.hotArrow) return;
    this.hotArrow = hot;
    this.stage.requestRender();
  }

  /** The unpicked marker under the pointer, by id. */
  pickDimMarker(): string | null {
    if (this.dimMarkers.size === 0) return null;
    this.layoutMarker();
    this.stage.overlay.updateMatrixWorld();
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const [id, g] of this.dimMarkers) {
      const target = g.children.find((c) => c.userData.pick);
      const hit = target && this.stage.raycaster.intersectObject(target, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = id;
        bestDistance = hit.distance;
      }
    }
    return best;
  }

  /** What a drag of the picked marker by this handle starts from. */
  grab(how: MarkerHandle): MarkerDrag {
    const mk = this.stage.options.marker!;
    const origin = new Vector3(mk.matrix[9], mk.matrix[10], mk.matrix[11]);
    const axis = how === 'slide' ? new Vector3(mk.matrix[6], mk.matrix[7], mk.matrix[8]).normalize() : axisVector(how);
    return { how, origin, axis, grabT: alongAxis(this.stage.raycaster.ray, origin, axis) ?? 0 };
  }

  /** The marker follows the pointer along the handle's axis; steps snap to the grid. */
  dragTo(drag: MarkerDrag, event: PointerEvent): void {
    const t = alongAxis(this.stage.raycaster.ray, drag.origin, drag.axis);
    if (t === null) return;
    const d = snapTo(t - drag.grabT, this.stage.options.snap);
    const next = drag.origin.clone().addScaledVector(drag.axis, d);
    this.stage.events.onMarkerMove(tidyVec(next.toArray() as Vec3));
    this.stage.events.onReadout(`${drag.how === 'slide' ? 'Along the axis' : 'XYZ'[drag.how]} ${d >= 0 ? '+' : ''}${fmt(d)}`, event.clientX, event.clientY);
  }

  layoutSnaps(): void {
    const snaps = this.stage.options.snaps;
    if (!snaps) return;
    snaps.forEach((snap, i) => {
      const dot = this.snapDots[i];
      if (!dot) return;
      const hot = i === this.snapHot;
      dot.material = hot ? this.stage.grips.dotHot : this.stage.grips.dot;
      dot.position.set(snap.at[0], snap.at[1], snap.at[2]);
      dot.scale.setScalar((hot ? 16 : 11) * pixelSize(this.stage, dot.position) * this.stage.gripScale);
    });
    // The hovered point's axis, drawn through it.
    const hot = this.snapHot !== null ? snaps[this.snapHot] : undefined;
    this.parts.snapAxis.visible = Boolean(hot?.axis);
    if (hot?.axis) {
      const reach = 40 * pixelSize(this.stage, new Vector3(...hot.at));
      const pts = this.parts.snapAxis.geometry.getAttribute('position') as BufferAttribute;
      for (let k = 0; k < 3; k++) {
        pts.setComponent(0, k, hot.at[k] - hot.axis[k] * reach);
        pts.setComponent(1, k, hot.at[k] + hot.axis[k] * reach);
      }
      pts.needsUpdate = true;
    }
  }

  pickSnap(event?: PointerEvent): number | null {
    if (!this.stage.options.snaps?.length) return null;
    this.stage.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutSnaps();
    this.stage.overlay.updateMatrixWorld();
    this.stage.gripScale = 1;
    let best: number | null = null;
    let bestDistance = Infinity;
    this.snapDots.forEach((dot, i) => {
      const hit = this.stage.raycaster.intersectObject(dot, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = i;
        bestDistance = hit.distance;
      }
    });
    return best;
  }

  hoverSnap(index: number | null): void {
    if (index === this.snapHot) return;
    this.snapHot = index;
    this.stage.requestRender();
  }

  dispose(): void {
    disposeMarker(this.parts.marker);
    for (const g of this.dimMarkers.values()) disposeMarker(g);
    this.disposeRays();
  }
}
