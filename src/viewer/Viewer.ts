// Framework-agnostic three.js editor view. Model space is millimeters, Z up,
// with the build plate at z=0. The viewer draws the scene it is given and
// turns pointer input into edits (select, move, lift, resize, turn), which it
// reports through callbacks; it never owns the design.
import {
  Box3,
  BufferAttribute,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  CanvasTexture,
  SphereGeometry,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  MOUSE,
  NeutralToneMapping,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Line,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CREASE_ANGLE } from '../geometry/mesh';
import { clampParams } from '../geometry/shapes';
import { skinKey, skinMesh, skinOf, skinRepeats } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { cornerColors, tintKey, underPicture } from '../geometry/tint';
import { boundsCenter, builtSize, flipSigns, frameMatrix, isEmptyBounds, rotation, tidy, tidyVec, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import { ALIGN_MODES, HOLE_COLOR, alignDot, rotateNodes, scaleNodes } from '../model/ops';
import type { Asset, GroupNode, SceneNode, Vec3 } from '../model/types';
import type { BuildResult } from '../worker/protocol';
import { SkinPainter } from './skin';
import { terrain, worldBlocks } from '../io/mjcf';
import type { World } from '../robot/types';
import { lidarAngles } from '../robot/types';
import { indexFeatures, nearestFeature } from '../geometry/features';
import type { Feature, FeatureIndex } from '../geometry/features';
import type { FeatureKind } from '../geometry/features';
import { describe as describeFeature } from '../geometry/measure';
import type { Measurement } from '../geometry/measure';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export interface ViewerOptions {
  theme: 'dark' | 'light';
  edges: boolean;
  grid: boolean;
  /** Grid step that drags snap to, in mm; 0 = free. */
  snap: number;
  /** False while an old version is shown: look, don't touch. */
  interactive: boolean;
  /**
   * Align mode: anchor dots on this box instead of the usual handles; `done` (one flag per dot, see
   * `alignDot`) greys out the dots that would change nothing. With `marker` the dots place the picked
   * joint or sensor, there need be no selection, and a click on any object makes it the anchor.
   */
  align: { bounds: Bounds; anchor: string | null; done: boolean[]; marker?: boolean } | null;
  /** A box to point out (a part inside a group): its frame and size. */
  highlight: { matrix: Mat; size: Vec3 } | null;
  /** Points to pick from (Robot mode, placing a joint): dots at each, in the scene. */
  snaps: SnapPoint[] | null;
  /** The joint or sensor picked in Robot mode, drawn as a frame with its motion or view, with an arrow per axis to drag it by. */
  marker: Marker | null;
  /** The other joints and sensors, drawn small; a click on one picks it. */
  markers: { id: string; marker: Marker }[] | null;
  /** The floor of a test drive when it is not the plate: the rough field or the slope, as the MuJoCo model has them. */
  /** The floor of a test drive when it is not the plate itself, with which way the robot faces for a course of steps or a ramp. */
  ground: { world: Exclude<World, 'flat'>; forward: Vec3 } | null;
  /**
   * The picked camera's picture: a small inset in the bottom-right corner shows the scene from this frame, with its field
   * of view and clip distances; a depth camera's in greys, near light and far dark. Null for no inset.
   */
  preview: Extract<Marker, { kind: 'camera' }> | null;
  /**
   * Measure mode: the kinds of feature the pointer takes hold of, the one or two picked (drawn lit), and what
   * they measure, drawn as a line between the nearest points with the figure on it.
   */
  measure: { kinds: FeatureKind[]; picks: Feature[]; result: Measurement | null } | null;
}

/**
 * A joint or sensor pointed out on the plate: a frame (`matrix` holds its X,
 * Y and Z columns and its origin, in the design) drawn at a fixed size on
 * screen, the way RViz draws a TF frame. A joint's axis is its Z, a camera
 * looks along its X, a lidar sweeps about its Z.
 */
export type Marker =
  | { kind: 'joint'; type: 'fixed' | 'revolute' | 'continuous' | 'prismatic'; matrix: Mat }
  /** `hfov` degrees across the picture; `near` and `far` the clip distances, mm. */
  | { kind: 'camera'; matrix: Mat; hfov: number; aspect: number; depth: boolean; near: number; far: number }
  /** `ranges`: what each ray measures while the test drive runs, mm from the origin, -1 for a miss; drawn as rays in the design's own scale. */
  | { kind: 'lidar'; matrix: Mat; hfov: number; ranges?: number[] }
  | { kind: 'imu'; matrix: Mat }
  /** `pressed`: the pad feels a force while the test drive runs; drawn lit. */
  | { kind: 'touch'; matrix: Mat; pressed?: boolean };

export interface SnapPoint {
  at: Vec3;
  /** A direction the point carries (the axis of a round shape), shown as a line through it. */
  axis?: Vec3;
}

export type AlignMode = 'min' | 'center' | 'max';

export interface ViewItem {
  node: SceneNode;
  /** Built geometry, or null while the worker is still at it. */
  result: BuildResult | null;
  selected: boolean;
  /** Drawn faintly and ignored by picking: a shape being placed, or an object ghosted by the user (`node.ghost`, fainter still). */
  ghost?: boolean;
}

export interface ViewerEvents {
  onSelect(ids: string[], mode: 'replace' | 'add' | 'toggle'): void;
  /** A drag begins; every `onGestureChange` until `onGestureEnd` belongs to one edit. */
  onGestureStart(): void;
  onGestureChange(nodes: SceneNode[]): void;
  onGestureEnd(canceled: boolean): void;
  /** While placing a new shape: where it would land (null when the pointer leaves). */
  onPlaceMove(point: Vec3 | null): void;
  onPlaceCommit(): void;
  /** Live measurement to show next to the pointer during a drag. */
  onReadout(text: string | null, clientX: number, clientY: number): void;
  /** Tight bounds of a node (the viewer only knows its box). */
  boundsOf(node: SceneNode): Bounds;
  /** Align mode: the pointer is over a dot (or has left one: axis null), and a dot was clicked. */
  onAlignHover(axis: 0 | 1 | 2 | null, mode: AlignMode): void;
  onAlignPick(axis: 0 | 1 | 2, mode: AlignMode): void;
  /** Align mode: one of the selected objects was clicked, to line the others up with it. */
  onAnchor(id: string): void;
  /** A handle was clicked rather than dragged: offer to type the value it would set (see `applyTyped`). */
  /** A grip was clicked rather than dragged: show boxes to type its values. `null` takes them away again. */
  onHandleClick(prompt: HandlePrompt | null): void;
  /** A snap point was hovered (null: left) or clicked. */
  onSnapHover(index: number | null): void;
  onSnapPick(index: number): void;
  /** Robot mode: the picked joint or sensor is dragged to `origin` (design mm); `onMarkerDrop` ends the drag. */
  onMarkerMove(origin: Vec3): void;
  onMarkerDrop(): void;
  /** Robot mode: one of the other joints or sensors drawn on the plate was clicked. */
  onMarkerPick(id: string): void;
  /** Measure mode: a feature clicked on the plate. */
  onMeasurePick(feature: Feature): void;
}

export interface HandlePrompt {
  kind: HandleKind;
  unit: string;
  /** The middle of the object, in the scene. */
  center: Vec3;
  /** One box per value, each sitting just outside the edge of the object it measures, with its place on screen. */
  fields: {
    tag: string;
    value: number;
    /** The point measured: the middle of an edge, or a grip. */
    anchor: Vec3;
    /** The point the box keeps away from, on screen: the middle of the face the grips sit on. Away from the object's middle when missing. */
    ref?: Vec3;
    /** A fixed way out instead, for a box that is not on an edge. */
    out?: Vec3;
    /** How far out, instead of the usual pad. */
    pad?: number;
    /** Sit right beside the anchor instead, level with it: for a grip the box must stay close to. */
    beside?: boolean;
    /** Points of a handle the box must not cover: it is pushed out until it clears their extent on screen. */
    keepOut?: Vec3[];
    /** Which way the edge runs, so the box keeps clear of it. */
    along?: Vec3;
    /** Which way the box went from its anchor on screen, settled when the boxes appeared and kept while they follow the camera. */
    heading?: [number, number];
    clientX: number;
    clientY: number;
  }[];
}

const DEFAULTS: ViewerOptions = { theme: 'dark', edges: true, grid: true, snap: 1, interactive: true, align: null, highlight: null, snaps: null, marker: null, markers: null, ground: null, preview: null, measure: null };
/** Distance of the anchor dots from the box, in pixels. */
const ALIGN_GAP = 22;

const FOV = 35;
const FIT_MARGIN = 1.25;
const ANIMATION_MS = 250;
/** Above this, sharp-edge extraction costs more than it is worth. */
const EDGE_TRIANGLE_LIMIT = 300_000;
const MIN_PHI = 1e-3; // keeps the camera off the Z axis, where "up" is undefined
export const GIZMO_SIZE = 92;
const GIZMO_MARGIN = 8;
const EMPTY_RADIUS = 70;
const PLATE_HALF = 100;
const DRAG_THRESHOLD = 4; // px
/** A typing box sits this far out from the edge it measures: clear of the grip drawn there. */
const PROMPT_PAD = 14; // px
/** A box beside a grip starts this far from the grip's center, and no box comes nearer than this to the edge of the view (more at the top, under the toolbar). */
const PROMPT_BESIDE = 30; // px
/** Size of a unit of the move arrows on a selection, in pixels; each arrow stands out from a face of the selection's box, `SLIDE_ARROW` units long. */
const MOVE_ARROW_PIXELS = 54;
const PROMPT_MARGIN = 8; // px
const PROMPT_MARGIN_TOP = 52; // px
const PROMPT_BOX: [number, number] = [100, 28]; // px, about the size of a box
/** A finger wobbles more than a mouse before it means to drag. */
const TOUCH_DRAG_THRESHOLD = 10; // px
/** How much bigger a grip is to a finger than to the eye. */
const TOUCH_GRIP_SCALE = 2.5;
/** How far from a point or edge (px) the Measure tool still takes hold of it. */
const MEASURE_REACH = 10;
/** Height of the figure on a measuring line, px. */
const MEASURE_LABEL_PIXELS = 20;
/** A finger held still this long means "more": add to the selection, or box-select. */
const LONG_PRESS_MS = 450;
const dragThreshold = (event: PointerEvent) => (event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD);
const MIN_SIZE = 0.1; // mm
/** How much of a ghosted object's fill and outline is left. */
const GHOST_OPACITY = 0.14;
const GHOST_EDGE_OPACITY = 0.45;
const ROTATE_STEP = 15;
const ROTATE_COARSE = 45;

/** Unit vectors from the scene towards the camera. */
const VIEW_DIRECTIONS: Record<ViewPreset, Vector3> = {
  iso: new Vector3(1, -1.2, 0.9).normalize(),
  // Tilted a hair towards -Y so that +Y ends up at the top of the screen.
  top: new Vector3(0, -Math.sin(MIN_PHI), Math.cos(MIN_PHI)),
  front: new Vector3(0, -1, 0),
  side: new Vector3(1, 0, 0),
};

const THEMES = {
  dark: { grid: 0x879390, major: 0.3, minor: 0.1, accent: 0x17cdd3, edge: 0.85, stage: ['#263130', '#0a0d0d'] },
  light: { grid: 0x5f6b68, major: 0.34, minor: 0.12, accent: 0x0f9ea3, edge: 0.7, stage: ['#ffffff', '#d3dbd8'] },
};

const AXIS_COLORS = ['#e5484d', '#3fae5a', '#4c8dff'];
/** On-screen length of a marker's unit, in pixels: the joint axis reaches this far each way from its origin. */
const MARKER_PIXELS = 60;
/** The same for the markers of the joints and sensors not picked. */
const DIM_MARKER_PIXELS = 34;

/**
 * A marker as solid strokes in its own frame, one unit = `MARKER_PIXELS` on
 * screen: a small X/Y/Z triad in the axis colors, then what the thing does in
 * the accent color. A joint's axis with a turn arrow about it (a ring for one
 * that turns freely), or arrowheads both ways for one that slides; a camera's
 * frustum with an "up" mark; a lidar's sweep as an arc with its edge rays; an
 * IMU as a box on a larger triad. Drawn as tubes and cones rather than lines,
 * which WebGL keeps one pixel wide.
 */
function markerObject(mk: Marker, accent: number, dim = false): Group {
  const group = new Group();
  group.matrixAutoUpdate = false;
  const materials = new Map<string, MeshBasicMaterial>();
  const material = (color: string | number) => {
    const key = String(color);
    let m = materials.get(key);
    if (!m) {
      m = new MeshBasicMaterial({ color, transparent: true, opacity: dim ? 0.5 : 0.95, depthTest: false });
      materials.set(key, m);
    }
    return m;
  };
  const R = 0.028;
  const put = (geometry: BufferGeometry, color: string | number, at: Vec3, dir?: Vec3, spin?: number) => {
    const mesh = new Mesh(geometry, material(color));
    mesh.position.set(at[0], at[1], at[2]);
    if (dir) mesh.quaternion.setFromUnitVectors(UP, new Vector3(dir[0], dir[1], dir[2]).normalize());
    if (spin !== undefined) mesh.rotateZ(spin);
    mesh.renderOrder = 10;
    group.add(mesh);
  };
  const add = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const unit = (v: Vec3): Vec3 => {
    const n = Math.hypot(...v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  /** A rod from `a` to `b`. */
  const rod = (a: Vec3, b: Vec3, color: string | number, r = R) => {
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    if (len < 1e-6) return;
    put(new CylinderGeometry(r, r, len, 10), color, add(a, d, 0.5), d);
  };
  /** A cone whose point is at `tip`, pointing along `dir`. */
  const cone = (tip: Vec3, dir: Vec3, color: string | number, h = 0.2, r = 0.075) => {
    const d = unit(dir);
    put(new ConeGeometry(r, h, 14), color, add(tip, d, -h / 2), d);
  };
  /** The frame's axes with arrowheads; without Z when the axis drawn through the origin is already the Z. */
  const triad = (len: number, withZ = true) => {
    const ends: Vec3[] = [
      [len, 0, 0],
      [0, len, 0],
      [0, 0, len],
    ];
    ends.slice(0, withZ ? 3 : 2).forEach((end, i) => {
      rod([0, 0, 0], end, AXIS_COLORS[i]);
      cone(add(end, unit(end), 0.1), end, AXIS_COLORS[i], 0.12, 0.05);
    });
  };
  const cube = (h: number, color: string | number) => put(new BoxGeometry(2 * h, 2 * h, 2 * h), color, [0, 0, 0]);
  /** An arc about Z at height `z`, from angle `from` through `sweep` radians, counter-clockwise seen from +Z. The torus lies in XY as made; only its start is turned. */
  const arc = (radius: number, from: number, sweep: number, z: number, color: string | number) => {
    const torus = new TorusGeometry(radius, R, 8, Math.max(12, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 64)), Math.abs(sweep));
    put(torus, color, [0, 0, z], undefined, sweep < 0 ? from + sweep : from);
  };
  switch (mk.kind) {
    case 'joint': {
      if (mk.type === 'fixed') {
        triad(0.3);
        cube(0.14, accent);
        break;
      }
      triad(0.3, false);
      rod([0, 0, -1], [0, 0, 1], accent);
      if (mk.type === 'prismatic') {
        cone([0, 0, 1.12], [0, 0, 1], accent);
        cone([0, 0, -1.12], [0, 0, -1], accent);
      } else {
        // The positive turn, by the right hand about the axis: an open arc for a joint with limits, a ring for a wheel.
        const r = 0.6;
        const start = mk.type === 'continuous' ? -Math.PI / 2 : Math.PI / 6;
        const end = Math.PI * 1.5;
        arc(r, start, end - start, 0, accent);
        cone([r * Math.cos(end), r * Math.sin(end), 0], [-Math.sin(end), Math.cos(end), 0], accent, 0.22, 0.08);
      }
      break;
    }
    case 'camera': {
      triad(0.35);
      const hw = Math.min(Math.tan((Math.min(Math.max(mk.hfov, 10), 170) * Math.PI) / 360), 1.4);
      const hh = hw / Math.max(mk.aspect, 0.2);
      const face = (d: number) => {
        const c = [-1, 1].flatMap((y) => [-1, 1].map((z): Vec3 => [d, y * hw * d, z * hh * d]));
        rod(c[0], c[1], accent);
        rod(c[1], c[3], accent);
        rod(c[3], c[2], accent);
        rod(c[2], c[0], accent);
        return c;
      };
      for (const c of face(1)) rod([0, 0, 0], c, accent);
      // The picture's top, so that a camera held sideways shows.
      rod([1, -hw * 0.35, hh], [1, 0, hh + hw * 0.3], accent);
      rod([1, 0, hh + hw * 0.3], [1, hw * 0.35, hh], accent);
      if (mk.depth) face(0.55);
      break;
    }
    case 'lidar': {
      triad(0.35);
      const half = (Math.min(Math.max(mk.hfov, 1), 360) * Math.PI) / 360;
      arc(1, -half, 2 * half, 0, accent);
      rod([0, 0, 0], [1, 0, 0], accent);
      if (mk.hfov < 360) {
        rod([0, 0, 0], [Math.cos(half), Math.sin(half), 0], accent);
        rod([0, 0, 0], [Math.cos(half), -Math.sin(half), 0], accent);
      }
      break;
    }
    case 'imu':
      triad(0.45);
      cube(0.16, accent);
      break;
    case 'touch': {
      // A pad where the link meets things: a flat disc with a short stem. The disc lights up (full strength, its own material) while the pad is pressed.
      const pad = new Mesh(new CylinderGeometry(0.4, 0.4, 0.08, 24), new MeshBasicMaterial({ color: accent, transparent: true, opacity: dim ? 0.5 : 0.95, depthTest: false }));
      pad.position.set(0, 0, 0.04);
      pad.quaternion.setFromUnitVectors(UP, new Vector3(0, 0, 1));
      pad.userData.pad = true;
      pad.renderOrder = 10;
      group.add(pad);
      rod([0, 0, 0.08], [0, 0, 0.4], accent);
      break;
    }
  }
  // Unseen targets for the pointer: the axis of a picked joint, to slide it along; the whole of an unpicked marker, to pick it.
  if (dim) {
    const hit = new Mesh(new SphereGeometry(0.5, 8, 6), material(accent));
    hit.visible = false;
    hit.userData.pick = true;
    group.add(hit);
  } else if (mk.kind === 'joint' && mk.type !== 'fixed') {
    const hit = new Mesh(new CylinderGeometry(0.14, 0.14, 2.3, 8), material(accent));
    hit.quaternion.setFromUnitVectors(UP, new Vector3(0, 0, 1));
    hit.visible = false;
    hit.userData.slide = true;
    group.add(hit);
  }
  return group;
}

const UP = new Vector3(0, 1, 0);

/** A touch marker's disc lit while its pad is pressed: solid, and half again as wide. */
function lightPad(group: Group, pressed: boolean): void {
  for (const child of group.children) {
    if (!child.userData.pad || !(child instanceof Mesh)) continue;
    (child.material as MeshBasicMaterial).opacity = pressed ? 1 : 0.5;
    child.scale.setScalar(pressed ? 1.5 : 1);
  }
}
const axisVector = (axis: 0 | 1 | 2): Vector3 => new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);

/** The pieces a move arrow of each length is made of, shared: a shaft, a head, and the fat unseen tube the pointer hits. Built up Y. */
const arrowParts = new Map<string, { shaft: CylinderGeometry; head: ConeGeometry; hit: CylinderGeometry }>();

/** How far a move arrow reaches, in units from where it is placed: its shaft from `from` to `to`, then the head. */
interface ArrowReach {
  from: number;
  to: number;
}

/** A move arrow along one of the design's axes in that axis's color, one unit = the pixel size it is laid out at. */
function moveArrow(axis: 0 | 1 | 2, { from, to }: ArrowReach): Group {
  const key = `${from}:${to}`;
  let parts = arrowParts.get(key);
  if (!parts) {
    parts = {
      shaft: new CylinderGeometry(0.045, 0.045, to - from, 10),
      head: new ConeGeometry(0.12, ARROW_HEAD, 14),
      hit: new CylinderGeometry(0.18, 0.18, to + ARROW_HEAD - from + 0.1, 8),
    };
    arrowParts.set(key, parts);
  }
  const material = new MeshBasicMaterial({ color: AXIS_COLORS[axis], transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const arrow = new Group();
  arrow.userData.axis = axis;
  arrow.quaternion.setFromUnitVectors(UP, axisVector(axis));
  const shaft = new Mesh(parts.shaft, material);
  shaft.position.y = (from + to) / 2;
  const head = new Mesh(parts.head, material);
  head.position.y = to + ARROW_HEAD / 2;
  const hit = new Mesh(parts.hit, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  hit.position.y = (from + to + ARROW_HEAD) / 2;
  hit.userData.hit = true;
  for (const part of [shaft, head, hit]) {
    part.renderOrder = 13;
    arrow.add(part);
  }
  return arrow;
}

/** Frees what a marker was built from. */
function disposeMarker(group: Group): void {
  for (const child of group.children) {
    if (child instanceof Mesh) {
      child.geometry.dispose();
      (child.material as MeshBasicMaterial).dispose();
    }
  }
  group.clear();
}
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

/** The figure on a measuring line: a rounded pill with the text, sized to fit it. */
function textTexture(text: string, theme: 'dark' | 'light'): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const height = 64;
  const g = canvas.getContext('2d');
  const font = `600 ${height * 0.5}px system-ui, sans-serif`;
  if (g) g.font = font;
  const width = Math.ceil((g?.measureText(text).width ?? height) + height * 0.8);
  canvas.width = width;
  canvas.height = height;
  if (g) {
    g.font = font;
    const r = height / 2;
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(width, 0, width, height, r);
    g.arcTo(width, height, 0, height, r);
    g.arcTo(0, height, 0, 0, r);
    g.arcTo(0, 0, width, 0, r);
    g.closePath();
    g.fillStyle = theme === 'dark' ? '#14171c' : '#ffffff';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = theme === 'dark' ? '#17cdd3' : '#0f9ea3';
    g.stroke();
    g.fillStyle = theme === 'dark' ? '#e8ecef' : '#1b1f27';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, width / 2, height / 2 + 1);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: width / height };
}

/** An anchor dot with nothing left to do: grey, dim and not for clicking. */
const DONE_DOT = { fill: '#3c4146', rim: '#8a9094', opacity: 0.45, scale: 0.8 };
/** Rim of the padlock badge: the warm color the hot align dot uses, for something that will not follow a drag. */
const LOCK_COLOR = '#ff9f4d';
const LOCK_BADGE_PIXELS = 22;

/** Camera placement in Z-up spherical coordinates around `target`. */
interface Pose {
  theta: number; // azimuth from +X towards +Y
  phi: number; // angle from +Z
  distance: number;
  target: Vector3;
}

interface Animation {
  start: number;
  duration: number;
  from: Pose;
  to: Pose;
}

/** What the viewer keeps per node on screen. */
interface Drawn {
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

export type HandleKind =
  | { type: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  /** Height grip at the top (side 1, base stays put) or at the bottom (side -1, top stays put). */
  | { type: 'height'; side: 1 | -1 }
  /** An arrow along one of the design's axes, from the middle of the selection, to move it along that axis alone. */
  | { type: 'move'; axis: 0 | 1 | 2 }
  | { type: 'rotate'; axis: 0 | 1 | 2 }
  | { type: 'align'; axis: 0 | 1 | 2; mode: AlignMode };

interface Handle {
  kind: HandleKind;
  object: Object3D;
  /** Pixel size on screen. */
  pixels: number;
  cursor: string;
}

/** The box the handles sit on: an oriented frame and half extents. */
interface Frame {
  matrix: Mat;
  half: Vec3;
  /** Axis-aligned bounds of the selection, for the handles that work along fixed axes. */
  bounds: Bounds;
  single: SceneNode | null;
}

/** The box a grip stretches, as it was when the grip was pressed: one object's own, or the whole selection's (square to the axes). */
interface GripBox {
  matrix: Mat;
  size: Vec3;
  single: SceneNode | null;
}

const gripBox = (f: Frame): GripBox => ({ matrix: f.matrix, size: [f.half[0] * 2, f.half[1] * 2, f.half[2] * 2], single: f.single });

type Drag =
  /** `select` is the node a finger landed on, selected only once the press turns out to be a tap or a drag (a long press adds it instead). */
  | { mode: 'pending-move'; x: number; y: number; nodes: SceneNode[]; plane: Plane; origin: Vector3; select?: string }
  /** A finger on empty space: the camera has it unless it lifts without moving (clears the selection) or stays put (box selection). */
  | { mode: 'pending-tap'; x: number; y: number }
  | { mode: 'move'; nodes: SceneNode[]; plane: Plane; origin: Vector3 }
  | { mode: 'pending-marquee'; x: number; y: number; additive: boolean }
  | { mode: 'marquee'; x: number; y: number; additive: boolean }
  /** `axisOnly` restricts a corner grip to one base axis when the base is seen edge-on and the other cannot be followed. */
  | { mode: 'resize'; box: GripBox; nodes: SceneNode[]; sx: number; sy: number; grab: Vector3; axisOnly?: 0 | 1 }
  /** A grip pressed from an angle it cannot be dragged from: a click still brings up its typing boxes. */
  | { mode: 'held' }
  | { mode: 'height'; box: GripBox; nodes: SceneNode[]; side: 1 | -1; grab: number }
  | { mode: 'slide'; nodes: SceneNode[]; origin: Vector3; axis: 0 | 1 | 2; grab: number }
  | { mode: 'rotate'; nodes: SceneNode[]; axis: 0 | 1 | 2; pivot: Vec3; start: number | null; x: number }
  /** The picked joint or sensor dragged along one of the design's axes by its arrow, or along its own axis by the rod. */
  | { mode: 'marker'; how: MarkerHandle; origin: Vector3; axis: Vector3; grabT: number }
  | { mode: 'place' };

/** A move arrow (the design's X, Y or Z) or the joint's own axis rod. */
type MarkerHandle = 0 | 1 | 2 | 'slide';
/** The move arrows of a joint or sensor reach from here to here from its origin, in marker units, with the head on the end. */
const MARKER_ARROW: ArrowReach = { from: 0.5, to: 1.45 };
/**
 * The move arrows of a selection stand out from the middle of its faces (+X, +Y and the top), a gap
 * first so that they keep clear of the grips there; shorter than a marker's, which start in the middle.
 */
const SLIDE_ARROW: ArrowReach = { from: 0.4, to: 1.1 };
const ARROW_HEAD = 0.3;
/** A move arrow seen this nearly end-on is hidden: it would sit over the grip it stands out from, and the pointer cannot drag along it. */
const ARROW_END_ON = 0.97;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (v: number) => String(Number(v.toFixed(2)));

/**
 * The floor of a test drive, as the MuJoCo model has it: the rough field's
 * 64×64 heights over 6 m, 30 mm high; a 10 m plane tilted 0.14 rad about X;
 * or the blocks of a course of steps or a ramp standing on the plate ahead of
 * the robot. Sand-colored and faceted, so that the bumps read.
 */
function groundMesh(ground: NonNullable<ViewerOptions['ground']>, color: number): Object3D {
  const material = new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, flatShading: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const kind = ground.world;
  if (kind === 'steps' || kind === 'ramp') {
    const group = new Group();
    for (const b of worldBlocks(kind, ground.forward)) {
      const mesh = new Mesh(new BoxGeometry(b.size[0] * 1000, b.size[1] * 1000, b.size[2] * 1000), material);
      mesh.position.set(b.pos[0] * 1000, b.pos[1] * 1000, b.pos[2] * 1000);
      mesh.rotation.set(0, -b.pitch, b.yaw, 'ZYX');
      mesh.renderOrder = -1;
      group.add(mesh);
    }
    return group;
  }
  let geometry: BufferGeometry;
  if (kind === 'rough') {
    const n = 64;
    const heights = terrain(n);
    const size = 6000;
    const plane = new PlaneGeometry(size, size, n - 1, n - 1);
    const pos = plane.getAttribute('position') as BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      // MuJoCo stores rows along Y, the first row at the least Y; a PlaneGeometry's vertices run from +Y down.
      const j = Math.round((pos.getX(v) / size + 0.5) * (n - 1));
      const i = Math.round((pos.getY(v) / size + 0.5) * (n - 1));
      pos.setZ(v, heights[i * n + j] * 30);
    }
    plane.computeVertexNormals();
    geometry = plane;
  } else {
    geometry = new PlaneGeometry(10000, 10000);
    geometry.rotateX(0.14);
  }
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -1;
  return mesh;
}

/** Frees a ground's meshes; a course shares one material among its blocks. */
function disposeGround(ground: Object3D): void {
  const materials = new Set<MeshStandardMaterial>();
  ground.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      materials.add(o.material as MeshStandardMaterial);
    }
  });
  for (const m of materials) m.dispose();
}

function gridLines(half: number, step: number, skipStep: number): BufferGeometry {
  const pts: number[] = [];
  const n = Math.round(half / step);
  for (let i = -n; i <= n; i++) {
    if (skipStep && i % Math.round(skipStep / step) === 0) continue;
    const v = i * step;
    pts.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  return g;
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) draw(g, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function labelTexture(letter: string, color: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.font = 'bold 38px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(letter, size / 2, size / 2 + 2);
  });
}

/** Square grip: light with a dark rim (corners) or the reverse (edges). */
function gripTexture(fill: string, rim: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.fillStyle = rim;
    g.fillRect(6, 6, size - 12, size - 12);
    g.fillStyle = fill;
    g.fillRect(14, 14, size - 28, size - 28);
  });
}

/** A round dot: an align anchor or a snap point. */
function dotTexture(fill: string, rim = '#ffffff'): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = rim;
    g.stroke();
  });
}

/** Padlock badge for a selected object that is locked: a drag leaves it where it is. */
function lockTexture(): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2);
    g.fillStyle = '#14171c';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = LOCK_COLOR;
    g.stroke();
    // Shackle, then body.
    g.lineWidth = 5;
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(32, 28, 8, Math.PI, 0);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(19, 28, 26, 20, 4);
    g.fill();
    g.fillStyle = '#14171c';
    g.beginPath();
    g.arc(32, 37, 3, 0, Math.PI * 2);
    g.fill();
  });
}


const toMatrix4 = (m: Mat, target: Matrix4): Matrix4 =>
  target.set(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1);

export class Viewer {
  private readonly container: HTMLElement;
  private readonly events: ViewerEvents;
  private options: ViewerOptions;
  private ok = false;
  private disposed = false;
  private raf = 0;
  private width = 0;
  private height = 0;

  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private resizeObserver!: ResizeObserver;
  private environment!: WebGLRenderTarget;

  private items: ViewItem[] = [];
  private assets: Record<string, Asset> = {};
  private drawn = new Map<string, Drawn>();
  private shared = new Map<BuildResult, SharedGeometry>();
  /** Tells one build result from another in a skin's key. */
  private serials = new WeakMap<BuildResult, number>();
  private nextSerial = 1;
  private readonly painter = new SkinPainter(() => {
    if (!this.ok || this.disposed) return;
    this.sync();
    this.requestRender();
  });
  /** Stands in until a node's geometry arrives. */
  private readonly empty = new BufferGeometry();
  private readonly center = new Vector3();
  private radius = EMPTY_RADIUS;
  private reach = 0;

  private gridMajor!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private gridMinor!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private axes!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private gridHalf = 0;
  private ground: Object3D | null = null;
  private groundKey = '';
  private gridStep = 0;

  private triadScene!: Scene;
  private triadCamera!: OrthographicCamera;
  /** Where the triad is drawn, from the canvas's bottom-left corner; the view widget around it sets this. */
  private triadOrigin = { x: GIZMO_MARGIN, y: GIZMO_MARGIN };
  /** The camera the preview inset is drawn from, posed from the picked sensor's frame each draw. */
  private readonly previewCamera = new PerspectiveCamera();
  /** What everything is drawn with for a depth camera's inset: a grey for its distance from the camera, white at `near`, black at `far`. */
  private readonly depthMaterial = new ShaderMaterial({
    uniforms: { near: { value: 1 }, far: { value: 1000 } },
    vertexShader: 'varying float vDepth; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float near; uniform float far; varying float vDepth; void main() { float t = clamp((vDepth - near) / (far - near), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - t), 1.0); }',
  });
  private disposables: { dispose(): void }[] = [];

  // Handles around the selection, drawn over everything else.
  private overlay!: Scene;
  private frame: Frame | null = null;
  private outline!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private pointer3d!: LineSegments<BufferGeometry, LineBasicMaterial>;
  /** The picked joint or sensor (Robot mode), and what its lines were last built for. */
  private marker!: Group;
  private markerKey = '';
  /** Its move arrows, one per design axis in the axis colors, and the one under the pointer. */
  private markerArrows!: Group;
  private hotArrow: number | null = null;
  /** The other joints and sensors, drawn small, by id. */
  private dimMarkers = new Map<string, Group>();
  private dimKey = '';
  /** The rays of the lidars among the dim markers, by marker id, while the test drive reports them. */
  private rays = new Map<string, LineSegments<BufferGeometry, LineBasicMaterial>>();
  private handles: Handle[] = [];
  private handleMode: 'none' | 'single' | 'several' | 'locked' | 'align' = 'none';
  private alignLines!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private hovered: Handle | null = null;
  /** Dots at the snap points on offer, one sprite each, and the hovered one. */
  private snapDots: Sprite[] = [];
  private snapHot: number | null = null;
  /** Measure mode: what is drawn (the hovered feature, the picks, the line between them), the centre dots on offer and the indexed meshes. */
  private measureGroup!: Group;
  private measureHot: Feature | null = null;
  private measureDots: { sprite: Sprite; feature: Feature }[] = [];
  private measureLabel: { sprite: Sprite; aspect: number } | null = null;
  private measureIndexes = new Map<string, { shown: BuildResult; key: string; index: FeatureIndex }>();
  private measureMaterials: { dot: SpriteMaterial; dotHot: SpriteMaterial } | null = null;
  private snapAxis!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private grips!: {
    corner: SpriteMaterial;
    edge: SpriteMaterial;
    dot: SpriteMaterial;
    dotHot: SpriteMaterial;
    lock: SpriteMaterial;
    /** Align anchor dots, one pair per axis in that axis's color: as they sit, and lit under the pointer. */
    axisDot: { idle: SpriteMaterial; hot: SpriteMaterial }[];
    /** An anchor dot that would change nothing. */
    dotDone: SpriteMaterial;
  };
  /** A padlock over each selected object that is locked, by id: it shows why a drag leaves that one where it is. */
  private lockBadges = new Map<string, Sprite>();
  /** How many of the selection a gesture in progress leaves behind for being locked; said in the readout. */
  private heldBack = 0;
  private arcParts!: { arc: TorusGeometry; head: ConeGeometry; hit: TorusGeometry };

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private drag: Drag | null = null;
  private placing = false;
  private marquee: HTMLElement | null = null;

  private animation: Animation | null = null;
  private fallback: HTMLElement | null = null;

  constructor(container: HTMLElement, events: ViewerEvents, options: Partial<ViewerOptions> = {}) {
    this.container = container;
    this.events = events;
    this.options = { ...DEFAULTS, ...options };
    try {
      this.init();
      this.ok = true;
    } catch (err) {
      console.warn('3D view unavailable:', err);
      this.showFallback();
      return;
    }
    this.onResize();
    this.applyPose(this.poseFor(VIEW_DIRECTIONS.iso));
    this.requestRender();
  }

  /** The scene to draw, and the images its pictures are made of. Cheap to call often: only what changed is touched. */
  setItems(items: ViewItem[], assets: Record<string, Asset> = this.assets): void {
    this.items = items;
    this.assets = assets;
    if (!this.ok || this.disposed) return;
    this.sync();
    this.syncLockBadges();
    this.requestRender();
  }

  /** One padlock per selected object that is locked (and in reach). */
  private syncLockBadges(): void {
    const wanted = new Set<string>();
    if (this.options.interactive) {
      for (const i of this.items) if (i.selected && i.node.locked && !i.node.hidden && !i.ghost) wanted.add(i.node.id);
    }
    for (const [id, badge] of this.lockBadges) {
      if (wanted.has(id)) continue;
      this.overlay.remove(badge);
      this.lockBadges.delete(id);
    }
    for (const id of wanted) {
      if (this.lockBadges.has(id)) continue;
      const badge = new Sprite(this.grips.lock);
      badge.renderOrder = 12;
      this.overlay.add(badge);
      this.lockBadges.set(id, badge);
    }
  }

  /** Each padlock over the middle of its object, the same size at any zoom; bigger while a drag is leaving the object behind. */
  private layoutLockBadges(): void {
    if (this.lockBadges.size === 0) return;
    const editing = this.drag !== null && this.drag.mode !== 'pending-move' && this.drag.mode !== 'pending-tap' && this.drag.mode !== 'pending-marquee' && this.drag.mode !== 'marquee';
    const byId = new Map(this.items.map((i) => [i.node.id, i.node]));
    for (const [id, badge] of this.lockBadges) {
      const node = byId.get(id);
      if (!node) continue;
      const at = new Vector3(...boundsCenter(this.events.boundsOf(node)));
      badge.position.copy(at);
      badge.scale.setScalar(LOCK_BADGE_PIXELS * this.pixelSize(at) * (editing ? 1.4 : 1));
    }
  }

  /** The live measurement beside the pointer, with a word on what the drag leaves behind. */
  private say(text: string, event: PointerEvent): void {
    const n = this.heldBack;
    this.events.onReadout(n ? `${text} · ${n} locked ${n === 1 ? 'stays' : 'stay'} put` : text, event.clientX, event.clientY);
  }

  setOptions(options: Partial<ViewerOptions>): void {
    this.options = { ...this.options, ...options };
    if (!this.ok || this.disposed) return;
    this.applyOptions();
    this.sync();
    this.syncLockBadges();
    this.requestRender();
  }

  /** While true, the pointer positions a new shape instead of selecting. */
  setPlacing(placing: boolean): void {
    this.placing = placing;
    if (this.ok) this.renderer.domElement.style.cursor = placing ? 'copy' : '';
  }

  /** Moves the axis triad, in CSS pixels from the canvas's bottom-left corner. */
  setTriadOrigin(x: number, y: number): void {
    this.triadOrigin = { x, y };
    this.requestRender();
  }

  setView(preset: ViewPreset): void {
    if (!this.ok || this.disposed) return;
    this.animateTo(this.poseFor(VIEW_DIRECTIONS[preset]));
  }

  /** Frame the selection, or everything when nothing is selected. */
  /** Carries the view along by `delta` (mm), as a camera following a driving robot: the view keeps its angle and distance. */
  follow(delta: Vec3): void {
    if (!this.ok || this.disposed || this.animation) return;
    const d = new Vector3(...delta);
    this.controls.target.add(d);
    this.camera.position.add(d);
    this.controls.update();
    this.requestRender();
  }

  fit(immediate = false): void {
    if (!this.ok || this.disposed) return;
    const picked = this.items.filter((i) => i.selected && !i.ghost);
    const { center, radius } = this.extent(picked.length ? picked : this.items.filter((i) => !i.ghost && !i.node.hidden));
    const pose = this.currentPose();
    pose.distance = this.fitDistance(radius);
    pose.target.copy(center);
    if (immediate) {
      this.animation = null;
      this.controls.enabled = true;
      this.applyPose(pose);
      this.requestRender();
    } else {
      this.animateTo(pose);
    }
  }

  /** Abandon the drag in progress, if any. Returns whether there was one. */
  cancelGesture(): boolean {
    const drag = this.drag;
    if (!drag) return false;
    this.drag = null;
    this.hideMarquee();
    this.events.onReadout(null, 0, 0);
    this.endHold();
    if (drag.mode !== 'pending-move' && drag.mode !== 'pending-tap' && drag.mode !== 'pending-marquee' && drag.mode !== 'marquee' && drag.mode !== 'place') {
      this.events.onGestureEnd(true);
    }
    return true;
  }

  /**
   * Small picture (JPEG data URL) of the whole design from the current angle,
   * for the project's thumbnail; or, given `only`, of those objects alone from
   * the standard angle without the grid, for a custom part's.
   */
  capture(width = 320, height = 200, only?: string[]): string | null {
    if (!this.ok || this.disposed || !this.width || !this.height) return null;
    const wanted = only ? new Set(only) : null;
    const visible = this.items.filter((i) => !i.ghost && !i.node.hidden && (!wanted || wanted.has(i.node.id)));
    if (visible.length === 0) return null;
    const saved = this.currentPose();
    const { center, radius } = this.extent(visible);
    const pose = { ...(wanted ? this.poseFor(VIEW_DIRECTIONS.iso) : saved), target: center, distance: this.fitDistance(radius, width / height) };
    const selected = [...this.drawn.values()].filter((d) => d.item.selected);
    const others = wanted ? [...this.drawn.values()].filter((d) => d.mesh.visible && !wanted.has(d.item.node.id)) : [];
    const grid = this.gridMajor.visible;
    const shown = (d: Drawn, on: boolean) => {
      d.mesh.visible = on;
      if (d.edges) d.edges.visible = on;
    };
    try {
      for (const d of selected) this.style(d, false);
      for (const d of others) shown(d, false);
      if (wanted) this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = false;
      this.applyPose(pose);
      this.draw(false);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      if (!g) return null;
      const [inner, outer] = THEMES[this.options.theme].stage;
      const gradient = g.createRadialGradient(width / 2, height * 0.42, 0, width / 2, height * 0.42, width * 0.7);
      gradient.addColorStop(0, inner);
      gradient.addColorStop(1, outer);
      g.fillStyle = gradient;
      g.fillRect(0, 0, width, height);
      // Crop the middle of the view to the picture's proportions.
      const source = this.renderer.domElement;
      const scale = Math.min(source.width / width, source.height / height);
      const sw = width * scale;
      const sh = height * scale;
      g.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    } finally {
      for (const d of selected) this.style(d, true);
      for (const d of others) shown(d, true);
      this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = grid;
      this.applyPose(saved);
      this.draw();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fallback?.remove();
    this.marquee?.remove();
    if (!this.ok) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.ground) {
      disposeGround(this.ground);
    }
    this.depthMaterial.dispose();
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.requestRender);
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.removeEventListener('change', this.requestRender);
    this.controls.removeEventListener('change', this.onCameraChange);
    this.controls.dispose();

    for (const d of this.drawn.values()) this.discard(d);
    this.drawn.clear();
    this.painter.dispose();
    this.empty.dispose();
    for (const s of this.shared.values()) {
      s.geometry.dispose();
      s.edges?.dispose();
    }
    this.shared.clear();
    disposeMarker(this.marker);
    for (const g of this.dimMarkers.values()) disposeMarker(g);
    this.disposeRays();
    for (const grid of [this.gridMajor, this.gridMinor, this.axes, this.outline, this.pointer3d, this.alignLines]) {
      grid.geometry.dispose();
      grid.material.dispose();
    }
    this.clearHandles();
    for (const d of this.disposables) d.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  // --- setup -------------------------------------------------------------

  private init(): void {
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;

    const canvas = renderer.domElement;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none' });
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.requestRender);

    const scene = new Scene();
    this.scene = scene;
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    scene.environment = this.environment.texture;
    scene.environmentIntensity = 0.6;
    // RoomEnvironment is Y-up; turn its ceiling lights towards +Z.
    scene.environmentRotation.set(Math.PI / 2, 0, 0);

    const camera = new PerspectiveCamera(FOV, 1, 0.1, 1000);
    this.camera = camera;
    camera.up.set(0, 0, 1); // must be set before OrbitControls is created
    scene.add(camera);

    const fill = new HemisphereLight(0xffffff, 0x444b57, 0.9);
    fill.position.set(0, 0, 1);
    scene.add(fill);
    // The key light rides with the camera (from over the viewer's left shoulder)
    // so that parts are well lit from every direction.
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(-0.6, 0.9, 1);
    camera.add(key);
    camera.add(key.target);

    const lineMaterial = () => new LineBasicMaterial({ transparent: true, depthWrite: false });
    this.gridMajor = new LineSegments(new BufferGeometry(), lineMaterial());
    this.gridMinor = new LineSegments(new BufferGeometry(), lineMaterial());
    // The X and Y axes drawn on the plate, in the colors of the corner triad.
    const axes = new BufferGeometry();
    axes.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]), 3));
    const tint = [...new Color(AXIS_COLORS[0]).toArray(), ...new Color(AXIS_COLORS[0]).toArray(), ...new Color(AXIS_COLORS[1]).toArray(), ...new Color(AXIS_COLORS[1]).toArray()];
    axes.setAttribute('color', new BufferAttribute(new Float32Array(tint), 3));
    this.axes = new LineSegments(axes, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    scene.add(this.gridMinor, this.gridMajor, this.axes);

    this.initTriad();
    this.initOverlay();

    const controls = new OrbitControls(camera, canvas);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.9;
    // The left button edits; the camera is on the other two (as in Tinkercad).
    controls.mouseButtons = { LEFT: -1 as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    controls.addEventListener('change', this.requestRender);
    controls.addEventListener('change', this.onCameraChange);

    // Captured, so that an edit can start before OrbitControls sees the press: a finger on a grip or
    // an object must not also turn the camera, as a finger on empty space does.
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.applyOptions();
    this.updateGrid();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private initTriad(): void {
    this.triadScene = new Scene();
    const e = 1.5;
    this.triadCamera = new OrthographicCamera(-e, e, e, -e, 0.1, 10);

    const shaft = new CylinderGeometry(0.045, 0.045, 1, 10); // along +Y, centered
    this.disposables.push(shaft);
    const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    ['X', 'Y', 'Z'].forEach((label, i) => {
      const color = AXIS_COLORS[i];
      const material = new MeshBasicMaterial({ color, toneMapped: false });
      const mesh = new Mesh(shaft, material);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dirs[i]);
      mesh.position.copy(dirs[i]).multiplyScalar(0.5);

      const map = labelTexture(label, color);
      const spriteMaterial = new SpriteMaterial({ map, toneMapped: false });
      const sprite = new Sprite(spriteMaterial);
      sprite.scale.setScalar(0.52);
      sprite.position.copy(dirs[i]).multiplyScalar(1.16);

      this.triadScene.add(mesh, sprite);
      this.disposables.push(material, map, spriteMaterial);
    });
  }

  private initOverlay(): void {
    this.overlay = new Scene();
    this.measureGroup = new Group();
    this.overlay.add(this.measureGroup);
    // Unit cube edges; scaled to the selection's box.
    const c = 0.5;
    const corners = [-c, -c, -c, c, -c, -c, c, c, -c, -c, c, -c, -c, -c, c, c, -c, c, c, c, c, -c, c, c];
    const pairs = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const pts: number[] = [];
    for (const i of pairs) pts.push(corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]);
    const box = new BufferGeometry();
    box.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    this.outline = new LineSegments(box, new LineBasicMaterial({ transparent: true, opacity: 0.7, depthTest: false }));
    this.outline.matrixAutoUpdate = false;
    this.outline.visible = false;
    this.overlay.add(this.outline);
    // The same box again, for pointing at a part of a group from the structure graph.
    this.pointer3d = new LineSegments(box, new LineBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, linewidth: 2 }));
    this.pointer3d.matrixAutoUpdate = false;
    this.pointer3d.visible = false;
    this.overlay.add(this.pointer3d);
    this.marker = new Group();
    this.marker.matrixAutoUpdate = false;
    this.marker.visible = false;
    this.overlay.add(this.marker);

    const grip = (map: CanvasTexture) => {
      const material = new SpriteMaterial({ map, depthTest: false, toneMapped: false });
      this.disposables.push(map, material);
      return material;
    };
    this.grips = {
      corner: grip(gripTexture('#ffffff', '#14171c')),
      edge: grip(gripTexture('#14171c', '#ffffff')),
      dot: grip(dotTexture('#14171c')),
      dotHot: grip(dotTexture(LOCK_COLOR)),
      lock: grip(lockTexture()),
      axisDot: AXIS_COLORS.map((color) => ({ idle: grip(dotTexture(color)), hot: grip(dotTexture('#ffffff', color)) })),
      dotDone: grip(dotTexture(DONE_DOT.fill, DONE_DOT.rim)),
    };
    this.grips.dotDone.opacity = DONE_DOT.opacity;
    this.markerArrows = new Group();
    this.markerArrows.matrixAutoUpdate = false;
    this.markerArrows.visible = false;
    this.overlay.add(this.markerArrows);
    for (const axis of [0, 1, 2] as const) {
      const arrow = moveArrow(axis, MARKER_ARROW);
      arrow.traverse((o) => {
        const material = (o as Mesh).material as MeshBasicMaterial | undefined;
        if (material) this.disposables.push(material);
      });
      this.markerArrows.add(arrow);
    }
    // One line per axis through its three dots, in the axis's color.
    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    const lineTint = AXIS_COLORS.flatMap((color) => {
      const c = new Color(color).toArray();
      return [...c, ...c];
    });
    lines.setAttribute('color', new BufferAttribute(new Float32Array(lineTint), 3));
    this.alignLines = new LineSegments(lines, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthTest: false }));
    this.alignLines.visible = false;
    this.overlay.add(this.alignLines);
    const axisLine = new BufferGeometry();
    axisLine.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    this.snapAxis = new LineSegments(axisLine, new LineBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }));
    this.snapAxis.visible = false;
    this.overlay.add(this.snapAxis);
    // Quarter ring with an arrowhead at each end, in the XY plane from +X to +Y.
    this.arcParts = {
      arc: new TorusGeometry(1, 0.07, 8, 20, Math.PI / 2),
      head: new ConeGeometry(0.2, 0.46, 12),
      hit: new TorusGeometry(1, 0.32, 6, 12, Math.PI / 2),
    };
    this.disposables.push(this.arcParts.arc, this.arcParts.head, this.arcParts.hit);
  }

  private showFallback(): void {
    const el = document.createElement('div');
    el.textContent = '3D view unavailable: WebGL could not be initialized.';
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      textAlign: 'center',
      fontSize: '13px',
      opacity: '0.7',
    });
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(el);
    this.fallback = el;
  }

  // --- scene ---------------------------------------------------------------

  private applyOptions(): void {
    const { theme, grid } = this.options;
    const t = THEMES[theme];
    this.gridMajor.material.color.set(t.grid);
    this.gridMajor.material.opacity = t.major;
    this.gridMinor.material.color.set(t.grid);
    this.gridMinor.material.opacity = t.minor;
    this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = grid;
    this.outline.material.color.set(t.accent);
    this.snapAxis.material.color.set(t.accent);
    this.syncSnaps();
    this.syncMeasure();
    this.pointer3d.material.color.set(theme === 'dark' ? 0xffffff : 0x1b1f27);
    const h = this.options.highlight;
    if (h) {
      const m = [...h.matrix] as Mat;
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(h.size[c], 1e-6);
      toMatrix4(m, this.pointer3d.matrix);
      this.pointer3d.matrixWorldNeedsUpdate = true;
    }
    this.pointer3d.visible = Boolean(h);
    const mk = this.options.marker;
    const markerKey = mk ? `${theme}:${JSON.stringify({ ...mk, matrix: undefined, ranges: undefined })}` : '';
    if (markerKey !== this.markerKey) {
      this.markerKey = markerKey;
      disposeMarker(this.marker);
      if (mk) {
        const built = markerObject(mk, t.accent);
        this.marker.add(...built.children);
      }
    }
    this.marker.visible = Boolean(mk);
    this.markerArrows.visible = Boolean(mk) && this.options.interactive;
    const dims = this.options.markers ?? [];
    const dimKey = `${theme}:${JSON.stringify(dims.map((d) => ({ id: d.id, marker: { ...d.marker, matrix: undefined, pressed: undefined, ranges: d.marker.kind === 'lidar' ? d.marker.ranges?.length : undefined } })))}`;
    if (dimKey !== this.dimKey) {
      this.dimKey = dimKey;
      for (const g of this.dimMarkers.values()) {
        disposeMarker(g);
        this.overlay.remove(g);
      }
      this.dimMarkers.clear();
      this.disposeRays();
      for (const d of dims) {
        const g = markerObject(d.marker, t.accent, true);
        this.overlay.add(g);
        this.dimMarkers.set(d.id, g);
        if (d.marker.kind === 'lidar' && d.marker.ranges) {
          // One line per ray, from the lidar to what the ray met; laid out with the readings every frame.
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(new Float32Array(d.marker.ranges.length * 6), 3));
          const rays = new LineSegments(geometry, new LineBasicMaterial({ color: t.accent, transparent: true, opacity: 0.8, depthTest: false }));
          rays.matrixAutoUpdate = false;
          rays.renderOrder = 9;
          rays.frustumCulled = false;
          this.overlay.add(rays);
          this.rays.set(d.id, rays);
        }
      }
    }
    const groundKey = this.options.ground ? `${theme}:${this.options.ground.world}:${this.options.ground.forward.join(',')}` : '';
    if (groundKey !== this.groundKey) {
      this.groundKey = groundKey;
      if (this.ground) {
        this.scene.remove(this.ground);
        disposeGround(this.ground);
        this.ground = null;
      }
      if (this.options.ground) {
        this.ground = groundMesh(this.options.ground, theme === 'dark' ? 0x4a4639 : 0xd8ccb0);
        this.scene.add(this.ground);
      }
    }
    for (const d of this.drawn.values()) this.style(d, d.item.selected);
  }

  private sync(): void {
    const seen = new Set<string>();
    for (const item of this.items) {
      const { node } = item;
      seen.add(node.id);
      let d = this.drawn.get(node.id);
      if (!d) {
        const material = new MeshStandardMaterial({ metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        const mesh = new Mesh(this.empty, material);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        mesh.userData.id = node.id;
        this.scene.add(mesh);
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
          this.scene.remove(d.edges);
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
    // Geometry nothing shows any more is released.
    const used = new Set<BuildResult>();
    for (const d of this.drawn.values()) if (d.shown) used.add(d.shown);
    for (const [result, s] of this.shared) {
      if (used.has(result)) continue;
      s.geometry.dispose();
      s.edges?.dispose();
      this.shared.delete(result);
    }

    const all = this.extent(this.items.filter((i) => !i.ghost && !i.node.hidden));
    this.center.copy(all.center);
    this.radius = all.radius;
    this.reach = all.reach;
    this.updateGrid();
    this.controls.minDistance = 1;
    this.controls.maxDistance = Math.max(this.radius, PLATE_HALF) * 40;
    this.updateFrame();
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
    const skin = d.shown && !node.hole && !ghost ? skinOf(node) : null;
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
    // The coordinates follow the mesh and, for a tiled texture, the size in millimeters; the pixels only the skin.
    const shape = `${serial}|${node.size.join(',')}`;
    if (d.skin?.pixels === pixels && d.skin.shape === shape) return false;
    let painted: ReturnType<SkinPainter['paint']> = null;
    try {
      painted = this.painter.paint(pixels, skin, this.assets);
    } catch (e) {
      console.warn(e);
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
      map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
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
  private style(d: Drawn, selected: boolean): void {
    const { node, ghost } = d.item;
    const t = THEMES[this.options.theme];
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

    const wantEdges = (this.options.edges || selected || faded) && Boolean(d.shown) && !node.hidden;
    if (!wantEdges) {
      if (d.edges) d.edges.visible = false;
      return;
    }
    if (!d.edges && d.shown) {
      const shared = this.share(d.shown);
      if (!shared.edges && d.shown.triangles <= EDGE_TRIANGLE_LIMIT) shared.edges = new EdgesGeometry(shared.geometry, CREASE_ANGLE);
      if (shared.edges) {
        d.edges = new LineSegments(shared.edges, new LineBasicMaterial({ transparent: true }));
        d.edges.matrixAutoUpdate = false;
        d.edges.matrix.copy(d.mesh.matrix);
        this.scene.add(d.edges);
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
    this.scene.remove(d.mesh);
    this.dropTint(d);
    this.dropSkin(d);
    d.mesh.material.dispose();
    if (d.edges) {
      this.scene.remove(d.edges);
      d.edges.material.dispose();
    }
  }

  private extent(items: ViewItem[]): { center: Vector3; radius: number; reach: number } {
    const b = unionBounds(items.map((i) => this.events.boundsOf(i.node)));
    if (isEmptyBounds(b)) return { center: new Vector3(0, 0, 0), radius: EMPTY_RADIUS, reach: 0 };
    const box = new Box3(new Vector3(...b.min), new Vector3(...b.max));
    return {
      center: box.getCenter(new Vector3()),
      radius: Math.max(box.min.distanceTo(box.max) / 2, 2),
      reach: Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[1]), Math.abs(b.max[1])),
    };
  }

  /** Build-plate grid centered on the origin: 200 mm square, growing with the design. */
  private updateGrid(): void {
    const wanted = Math.max(this.reach * 1.2, PLATE_HALF);
    const major = wanted <= 300 ? 10 : wanted <= 3000 ? 100 : 1000;
    const half = Math.ceil(wanted / (major * 5)) * major * 5;
    if (half === this.gridHalf && major === this.gridStep) return;
    this.gridHalf = half;
    this.gridStep = major;
    this.gridMajor.geometry.dispose();
    this.gridMinor.geometry.dispose();
    this.gridMajor.geometry = gridLines(half, major, 0);
    // A millimeter grid on a big plate is more lines than it is help.
    this.gridMinor.geometry = gridLines(half, half <= 150 ? major / 10 : major / 2, major);
    this.axes.scale.set(half, half, 1);
  }

  // --- handles -------------------------------------------------------------

  private clearHandles(): void {
    for (const h of this.handles) {
      this.overlay.remove(h.object);
      h.object.traverse((o) => {
        const material = (o as Mesh).material as MeshBasicMaterial | SpriteMaterial | undefined;
        // Grip sprites share their materials; the rings own theirs.
        if (material && !(o instanceof Sprite)) material.dispose();
      });
    }
    this.handles = [];
    // A look at an anchor dot ends with the dot: the objects come back from where it showed them.
    if (this.hovered?.kind.type === 'align') this.events.onAlignHover(null, 'center');
    this.hovered = null;
    this.handleMode = 'none';
    this.alignLines.visible = false;
  }

  /** Recompute the selection's box and which handles it gets. */
  private updateFrame(): void {
    const picked = this.options.interactive ? this.items.filter((i) => i.selected && !i.ghost && !i.node.hidden) : [];
    const align = this.options.align;
    // Nothing picked and nothing to line up: no frame. (Lining up a joint or sensor has dots with no selection.)
    if (picked.length === 0 && !align) {
      this.frame = null;
      this.outline.visible = false;
      if (this.handleMode !== 'none') this.clearHandles();
      return;
    }
    const bounds = align ? align.bounds : unionBounds(picked.map((i) => this.events.boundsOf(i.node)));
    const single = !align && picked.length === 1 ? picked[0].node : null;
    if (single) {
      this.frame = { matrix: frameMatrix(single), half: [single.size[0] / 2, single.size[1] / 2, single.size[2] / 2], bounds, single };
    } else {
      const c = boundsCenter(bounds);
      this.frame = {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, c[0], c[1], c[2]],
        half: [(bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2, (bounds.max[2] - bounds.min[2]) / 2],
        bounds,
        single: null,
      };
    }
    const mode = align ? 'align' : picked.every((i) => i.node.locked) ? 'locked' : single ? 'single' : 'several';
    if (mode !== this.handleMode) this.buildHandles(mode);

    const f = this.frame;
    const m = [...f.matrix] as Mat;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(f.half[c] * 2, 1e-6);
    toMatrix4(m, this.outline.matrix);
    this.outline.matrixWorldNeedsUpdate = true;
    this.outline.visible = true;
  }

  private buildHandles(mode: 'single' | 'several' | 'locked' | 'align'): void {
    this.clearHandles();
    this.handleMode = mode;
    if (mode === 'locked') return;
    const add = (kind: HandleKind, object: Object3D, pixels: number, cursor: string) => {
      object.renderOrder = 10;
      this.overlay.add(object);
      this.handles.push({ kind, object, pixels, cursor });
    };
    if (mode === 'align') {
      for (const axis of [0, 1, 2] as const) for (const m of ALIGN_MODES) add({ type: 'align', axis, mode: m }, new Sprite(this.grips.axisDot[axis].idle), 15, 'pointer');
      this.alignLines.visible = true;
      return;
    }
    // One object gets grips on its own box; several get them on the box round them all, which stretches them together.
    for (const sx of [-1, 0, 1] as const) {
      for (const sy of [-1, 0, 1] as const) {
        if (sx === 0 && sy === 0) continue;
        const corner = sx !== 0 && sy !== 0;
        add({ type: 'resize', sx, sy }, new Sprite(corner ? this.grips.corner : this.grips.edge), corner ? 13 : 11, 'nwse-resize');
      }
    }
    add({ type: 'height', side: 1 }, new Sprite(this.grips.corner), 13, 'ns-resize');
    add({ type: 'height', side: -1 }, new Sprite(this.grips.corner), 13, 'ns-resize');
    for (const axis of [0, 1, 2] as const) add({ type: 'move', axis }, moveArrow(axis, SLIDE_ARROW), MOVE_ARROW_PIXELS, 'move');
    for (const axis of [0, 1, 2] as const) {
      const ring = new Group();
      const material = new MeshBasicMaterial({ color: AXIS_COLORS[axis], depthTest: false, toneMapped: false, transparent: true });
      const arc = new Mesh(this.arcParts.arc, material);
      const head = new Mesh(this.arcParts.head, material);
      head.position.set(1, 0, 0);
      head.rotation.z = Math.PI; // tip towards -Y: past the start of the arc
      head.position.y = -0.1;
      const tail = new Mesh(this.arcParts.head, material);
      tail.position.set(-0.1, 1, 0);
      tail.rotation.z = Math.PI / 2; // tip towards -X: past the end of the arc
      // A fat invisible ring makes the thin one easy to grab.
      const hit = new Mesh(this.arcParts.hit, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
      for (const part of [arc, head, tail, hit]) part.renderOrder = 10;
      ring.add(arc, head, tail, hit);
      ring.matrixAutoUpdate = false;
      add({ type: 'rotate', axis }, ring, 30, 'grab');
    }
  }

  /** Whether the line along a design axis through a point is seen nearly end-on. */
  private endOn(at: Vector3, axis: 0 | 1 | 2): boolean {
    const view = at.clone().sub(this.camera.position).normalize();
    return Math.abs(view.getComponent(axis)) > ARROW_END_ON;
  }

  /** World length of one pixel at a point, for handles that keep their size on screen. */
  private pixelSize(at: Vector3): number {
    const depth = at.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
    return (2 * Math.max(depth, 1e-3) * Math.tan((FOV * Math.PI) / 360)) / Math.max(this.height, 1);
  }

  private framePoint(local: Vec3): Vector3 {
    return this.pointOf(this.frame!.matrix, local);
  }

  /** A point of a box (frame or grip box) in the scene. */
  private pointOf(m: Mat, local: Vec3): Vector3 {
    return new Vector3(
      m[0] * local[0] + m[3] * local[1] + m[6] * local[2] + m[9],
      m[1] * local[0] + m[4] * local[1] + m[7] * local[2] + m[10],
      m[2] * local[0] + m[5] * local[1] + m[8] * local[2] + m[11],
    );
  }

  /** Where the turn handle of an axis sits, and the two directions its quarter ring spans. */
  private ringPlacement(axis: 0 | 1 | 2): { at: Vector3; from: Vector3; to: Vector3 } {
    const { min, max } = this.frame!.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    if (axis === 2) return { at: new Vector3(max[0], min[1], min[2]), from: new Vector3(0, -1, 0), to: new Vector3(1, 0, 0) };
    if (axis === 0) return { at: new Vector3(cx, min[1], max[2]), from: new Vector3(0, -1, 0), to: new Vector3(0, 0, 1) };
    // On the -X side: the +X side has the X move arrow.
    return { at: new Vector3(min[0], cy, max[2]), from: new Vector3(-1, 0, 0), to: new Vector3(0, 0, 1) };
  }

  /** Put every handle where it belongs for the current camera. Called before each draw. */
  private layoutHandles(): void {
    const f = this.frame;
    if (!f) return;
    const [hx, hy, hz] = f.half;
    if (this.handleMode === 'align') {
      this.layoutAlignDots();
      return;
    }
    for (const h of this.handles) {
      const k = h.kind;
      if (k.type === 'resize' || k.type === 'height') {
        const at = k.type === 'resize' ? this.framePoint([k.sx * hx, k.sy * hy, -hz]) : this.framePoint([0, 0, k.side * hz]);
        h.object.position.copy(at);
        h.object.scale.setScalar(h.pixels * this.pixelSize(at) * (h === this.hovered ? 1.35 : 1) * this.gripScale);
      } else if (k.type === 'move') {
        // Out of the selection along the design's axes, whichever way the box is turned: from the middle of
        // its +X and +Y sides, and straight up from the top grip, past the highest point.
        const at = k.axis === 2 ? this.framePoint([0, 0, hz]) : this.framePoint([0, 0, 0]);
        at.setComponent(k.axis, Math.max(at.getComponent(k.axis), f.bounds.max[k.axis]));
        h.object.position.copy(at);
        h.object.scale.setScalar(h.pixels * this.pixelSize(at) * (h === this.hovered ? 1.15 : 1) * this.gripScale);
        h.object.visible = !this.endOn(at, k.axis);
      } else {
        const { at, from, to } = this.ringPlacement(k.axis);
        // The ring's hit tube is already several times fatter than the drawn arc, so it is not scaled.
        const s = h.pixels * this.pixelSize(at) * (h === this.hovered ? 1.15 : 1);
        const normal = from.clone().cross(to);
        h.object.matrix.makeBasis(from.multiplyScalar(s), to.multiplyScalar(s), normal.multiplyScalar(s)).setPosition(at);
        h.object.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /** Whether an anchor dot has nothing left to do: the objects already line up there. */
  private alignDone(kind: { axis: 0 | 1 | 2; mode: AlignMode }): boolean {
    return this.options.align?.done[alignDot(kind.axis, kind.mode)] ?? false;
  }

  /**
   * The nine anchor dots: three along X in front of the box, three along Y
   * beside it, three along Z up its front-left corner, all a little outside.
   */
  private layoutAlignDots(): void {
    const { min, max } = this.frame!.bounds;
    const corner = new Vector3(min[0], min[1], min[2]);
    const gap = ALIGN_GAP * this.pixelSize(corner);
    const at = (axis: number, mode: AlignMode): Vector3 => {
      const v = mode === 'min' ? min[axis] : mode === 'max' ? max[axis] : (min[axis] + max[axis]) / 2;
      if (axis === 0) return new Vector3(v, min[1] - gap, min[2]);
      if (axis === 1) return new Vector3(min[0] - gap, v, min[2]);
      return new Vector3(min[0] - gap, min[1] - gap, v);
    };
    for (const h of this.handles) {
      if (h.kind.type !== 'align') continue;
      const p = at(h.kind.axis, h.kind.mode);
      const done = this.alignDone(h.kind);
      const hot = !done && h === this.hovered;
      const dots = this.grips.axisDot[h.kind.axis];
      (h.object as Sprite).material = done ? this.grips.dotDone : hot ? dots.hot : dots.idle;
      h.object.position.copy(p);
      h.object.scale.setScalar(h.pixels * this.pixelSize(p) * (done ? DONE_DOT.scale : hot ? 1.3 : 1) * this.gripScale);
    }
    const pts = this.alignLines.geometry.getAttribute('position') as BufferAttribute;
    for (const axis of [0, 1, 2]) {
      at(axis, 'min').toArray(pts.array as Float32Array, axis * 6);
      at(axis, 'max').toArray(pts.array as Float32Array, axis * 6 + 3);
    }
    pts.needsUpdate = true;
  }

  // --- pointer -------------------------------------------------------------

  private setRay(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** Grips are laid out this much bigger than drawn while a finger is picking one. */
  private gripScale = 1;

  private pickHandle(event?: PointerEvent): Handle | null {
    if (!this.frame || this.handles.length === 0) return null;
    this.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutHandles();
    this.overlay.updateMatrixWorld();
    this.gripScale = 1;
    let best: Handle | null = null;
    let bestDistance = Infinity;
    for (const h of this.handles) {
      // A greyed anchor dot is not there to be clicked, nor a hidden move arrow.
      if ((h.kind.type === 'align' && this.alignDone(h.kind)) || !h.object.visible) continue;
      const hit = this.raycaster.intersectObject(h.object, true)[0];
      // Grips win over rings when both are under the pointer: they are the smaller target.
      const distance = hit ? hit.distance - (h.kind.type === 'rotate' ? 0 : 1e6) : Infinity;
      if (distance < bestDistance) {
        best = h;
        bestDistance = distance;
      }
    }
    return best;
  }

  private pickNode(): { item: ViewItem; point: Vector3; normal: Vector3; triangle: number; drawn: Drawn } | null {
    const meshes: Mesh[] = [];
    for (const d of this.drawn.values()) if (d.mesh.visible && !d.item.ghost) meshes.push(d.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const d = this.drawn.get(hit.object.userData.id as string);
    if (!d) return null;
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new Vector3(0, 0, 1);
    // The triangle of the built mesh that was hit; a picture's cut-up geometry maps its triangles back to the mesh's.
    const face = hit.faceIndex ?? -1;
    const triangle = d.skin?.faces && face >= 0 ? d.skin.faces[face] ?? -1 : face;
    return { item: d.item, point: hit.point, normal, triangle, drawn: d };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // A camera button must not take the focus off a typing box: a pan keeps the boxes.
    if (event.button !== 0 && this.prompt) event.preventDefault();
    if (this.drag) {
      // A second finger while the first rests on empty space makes a two-finger camera gesture (pan,
      // pinch): the press is the camera's from here on, not a tap or a long press.
      if (this.drag.mode === 'pending-tap') {
        this.endHold();
        this.drag = null;
        return;
      }
      // A second finger during an edit is neither ours nor the camera's.
      if (event.pointerId !== this.dragPointer) event.stopImmediatePropagation();
      return;
    }
    if (event.button !== 0) return;
    // Whatever the press does next, the boxes from the last click are stale.
    this.dismissPrompt();
    this.animation = null;
    this.controls.enabled = true;
    const canvas = this.renderer.domElement;
    canvas.setPointerCapture(event.pointerId);
    this.dragPointer = event.pointerId;
    this.setRay(event);

    // Whatever starts here is ours alone: the camera does not get the press as well.
    const claim = () => event.stopImmediatePropagation();
    if (this.placing) {
      this.drag = { mode: 'place' };
      claim();
      return;
    }
    if (!this.options.interactive) return;

    // Measuring, a press takes hold of a feature; on empty space it is the camera's.
    if (this.options.measure) {
      const feature = this.pickMeasure(event);
      if (feature) {
        this.events.onMeasurePick(feature);
        claim();
      }
      return;
    }
    const snap = this.pickSnap(event);
    if (snap !== null) {
      this.events.onSnapPick(snap);
      claim();
      return;
    }
    const markerHandle = this.pickMarkerHandle(event);
    if (markerHandle !== null) {
      this.startMarkerDrag(markerHandle);
      claim();
      return;
    }
    const other = this.pickDimMarker();
    if (other !== null) {
      this.events.onMarkerPick(other);
      claim();
      return;
    }
    const handle = this.pickHandle(event);
    if (handle?.kind.type === 'align') {
      this.events.onAlignPick(handle.kind.axis, handle.kind.mode);
      claim();
      return;
    }
    if (handle && this.frame) {
      this.startHandleDrag(handle, event);
      claim();
      return;
    }

    const hit = this.pickNode();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const touch = event.pointerType === 'touch';
    // In align mode a click on a selected object makes it the anchor instead of starting a drag; lining up a joint or sensor, any object will do.
    if (this.options.align && hit && (hit.item.selected || this.options.align.marker) && !additive) {
      this.events.onAnchor(hit.item.node.id);
      claim();
      return;
    }
    if (!hit) {
      // Empty space: a mouse draws a marquee. A finger turns the camera (OrbitControls takes it from
      // here), unless it lifts without moving (a tap clears the selection) or stays put (box selection).
      if (!touch) this.drag = { mode: 'pending-marquee', x: event.clientX, y: event.clientY, additive };
      else {
        this.drag = { mode: 'pending-tap', x: event.clientX, y: event.clientY };
        this.holdFor(() => {
          this.controls.enabled = false;
          this.drag = { mode: 'marquee', x: event.clientX, y: event.clientY, additive: true };
          this.showMarquee(event.clientX, event.clientY, event.clientX, event.clientY);
        });
      }
      return;
    }
    claim();
    const { node } = hit.item;
    if (additive) {
      this.events.onSelect([node.id], 'toggle');
      return;
    }
    // Dragging something that is not selected yet selects it and moves it alone. A mouse selects it at
    // once; a finger only once the press turns out to be a tap or a drag, since a long press adds it instead.
    const selected = hit.item.selected ? this.items.filter((i) => i.selected).map((i) => i.node) : [node];
    const later = touch && !hit.item.selected;
    if (!hit.item.selected && !later) this.events.onSelect([node.id], 'replace');
    const movable = selected.filter((n) => !n.locked);
    this.heldBack = selected.length - movable.length;
    this.drag = {
      mode: 'pending-move',
      x: event.clientX,
      y: event.clientY,
      nodes: movable,
      plane: new Plane(new Vector3(0, 0, 1), -hit.point.z),
      origin: hit.point.clone(),
      ...(later ? { select: node.id } : {}),
    };
    if (touch) {
      this.holdFor(() => {
        // Held still on an object: it joins (or leaves) the selection, and nothing moves.
        this.drag = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        this.events.onSelect([node.id], 'toggle');
      });
    }
  };

  private longPress: ReturnType<typeof setTimeout> | undefined;

  /** Runs `then` if the finger is still down and has not moved by then. */
  private holdFor(then: () => void): void {
    clearTimeout(this.longPress);
    this.longPress = setTimeout(() => {
      this.longPress = undefined;
      if (this.drag?.mode === 'pending-tap' || this.drag?.mode === 'pending-move') then();
    }, LONG_PRESS_MS);
  }

  private endHold(): void {
    clearTimeout(this.longPress);
    this.longPress = undefined;
  }

  private startHandleDrag(handle: Handle, event: PointerEvent): void {
    const f = this.frame!;
    const k = handle.kind;
    const nodes = this.items.filter((i) => i.selected && !i.ghost && !i.node.locked).map((i) => i.node);
    if (nodes.length === 0) return;
    this.heldBack = this.items.filter((i) => i.selected && !i.ghost && !i.node.hidden).length - nodes.length;
    const box = gripBox(f);
    if (k.type === 'resize') {
      // A corner grip seen with the base edge-on cannot follow both axes: it follows the one seen best.
      const axisOnly = k.sx !== 0 && k.sy !== 0 && this.baseEdgeOn(box) ? this.bestBaseAxis(box) : undefined;
      const grab = this.resizePoint(box, k.sx, k.sy, axisOnly);
      const handleLocal = new Vector3(k.sx * f.half[0], k.sy * f.half[1], 0);
      this.drag = grab ? { mode: 'resize', box, nodes, sx: k.sx, sy: k.sy, grab: grab.sub(handleLocal), axisOnly } : { mode: 'held' };
    } else if (k.type === 'height') {
      // Measured from the end that stays put: the base for the top grip, the top for the bottom one.
      const t = this.alongAxis(this.framePoint([0, 0, -k.side * f.half[2]]), this.boxAxis(box, 2));
      this.drag = t === null ? { mode: 'held' } : { mode: 'height', box, nodes, side: k.side, grab: t - k.side * box.size[2] };
    } else if (k.type === 'move') {
      const origin = handle.object.position.clone();
      const t = this.alongAxis(origin, axisVector(k.axis));
      this.drag = t === null ? { mode: 'held' } : { mode: 'slide', nodes, origin, axis: k.axis, grab: t };
    } else if (k.type === 'rotate') {
      const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
      this.drag = { mode: 'rotate', nodes, axis: k.axis, pivot, start: this.angleAbout(k.axis, pivot), x: event.clientX };
    } else {
      return;
    }
    this.renderer.domElement.style.cursor = k.type === 'rotate' ? 'grabbing' : handle.cursor;
    this.press = { handle, x: event.clientX, y: event.clientY };
    this.events.onGestureStart();
  }

  /** The handle just pressed, until the pointer has moved far enough to count as a drag. */
  private press: { handle: Handle; x: number; y: number } | null = null;
  /** The pointer the current drag was started with: another finger neither steers it nor ends it. */
  private dragPointer = -1;

  /** True for a pointer other than the one dragging, which is kept from the camera as well. */
  private otherPointer(event: PointerEvent): boolean {
    if (!this.drag || event.pointerId === this.dragPointer) return false;
    event.stopImmediatePropagation();
    return true;
  }
  /** The typing boxes on show, with the camera's heading when they appeared: a turn takes them away, a zoom or pan moves them. */
  private prompt: { prompt: HandlePrompt; heading: Quaternion } | null = null;

  /** Where a point of the scene is on screen. */
  private toClient(p: Vector3): { clientX: number; clientY: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = p.clone().project(this.camera);
    return { clientX: rect.left + ((v.x + 1) / 2) * rect.width, clientY: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** Of some points in the object's frame, the one nearest the camera. */
  private nearest<T extends { at: Vec3 }>(choices: T[]): T {
    let best = choices[0];
    let bestD = this.framePoint(best.at).distanceTo(this.camera.position);
    for (const c of choices.slice(1)) {
      const d = this.framePoint(c.at).distanceTo(this.camera.position);
      if (d < bestD) [best, bestD] = [c, d];
    }
    return best;
  }

  /** A direction of the object's frame, in the scene. */
  private frameDir(local: Vec3): Vec3 {
    return this.framePoint(local).sub(this.framePoint([0, 0, 0])).normalize().toArray() as Vec3;
  }

  /**
   * What typing a value for this handle would set. Each box sits just outside
   * the middle of an edge running along the dimension it changes, on the side
   * of the grip (or the side facing the camera), so it reads like a dimension
   * line and keeps off the object.
   */
  private promptFor(handle: Handle): HandlePrompt | null {
    const f = this.frame;
    if (!f) return null;
    const k = handle.kind;
    const [hx, hy, hz] = f.half;
    const center = this.framePoint([0, 0, 0]).toArray() as Vec3;
    type Field = HandlePrompt['fields'][number];
    /**
     * A box on the middle of an edge of the frame: `at` its middle, `along` its run, `ref` the point it
     * keeps away from. For the bottom edges that is the middle of the bottom face: seen from above, a
     * box on a back edge then goes up the picture, over the object but on the side the edge is read
     * from, rather than down into the drawing of the underside.
     */
    const edge = (tag: string, value: number, at: Vec3, along: Vec3, ref: Vec3): Field => ({
      tag,
      value,
      anchor: this.framePoint(at).toArray() as Vec3,
      ref: this.framePoint(ref).toArray() as Vec3,
      along: this.frameDir(along),
      clientX: 0,
      clientY: 0,
    });
    let made: HandlePrompt | null = null;
    switch (k.type) {
      case 'height':
        // Right beside the height grip, so that it stays to hand on a big object seen close up; level with
        // the grip, it covers neither the grip nor the move arrows in the middle.
        made = { kind: k, unit: 'mm', center, fields: [{ tag: 'H', value: hz * 2, anchor: handle.object.getWorldPosition(new Vector3()).toArray() as Vec3, beside: true, clientX: 0, clientY: 0 }] };
        break;
      case 'resize': {
        const fields: Field[] = [];
        if (k.sx !== 0) {
          // Width goes on a bottom edge running along X: at the grip's side, else the side facing the camera.
          const side = k.sy !== 0 ? k.sy : this.nearest([{ at: [0, -hy, -hz] as Vec3, s: -1 }, { at: [0, hy, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge('W', hx * 2, [0, side * hy, -hz], [1, 0, 0], [0, 0, -hz]));
        }
        if (k.sy !== 0) {
          const side = k.sx !== 0 ? k.sx : this.nearest([{ at: [-hx, 0, -hz] as Vec3, s: -1 }, { at: [hx, 0, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge('D', hy * 2, [side * hx, 0, -hz], [0, 1, 0], [0, 0, -hz]));
        }
        made = { kind: k, unit: 'mm', center, fields };
        break;
      }
      case 'move':
        // Only the Z arrow has a value worth typing: how high the selection stands. The box sits past the arrow's head.
        if (k.axis === 2) made = { kind: k, unit: 'mm', center, fields: [{ tag: 'Z', value: f.bounds.min[2], anchor: handle.object.position.toArray() as Vec3, out: [0, 0, 1], pad: MOVE_ARROW_PIXELS * (SLIDE_ARROW.to + ARROW_HEAD) + PROMPT_PAD, clientX: 0, clientY: 0 }] };
        break;
      case 'rotate': {
        // The arc with its two arrowheads, sampled, so that the box can keep off the whole of it.
        const ring = handle.object;
        const keepOut = [0, 0.25, 0.5, 0.75, 1].map((t) => new Vector3(Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2), 0));
        keepOut.push(new Vector3(1.2, -0.35, 0), new Vector3(-0.35, 1.2, 0), new Vector3(0, 0, 0));
        made = {
          kind: k,
          unit: '°',
          center,
          fields: [{ tag: 'XYZ'[k.axis], value: 0, anchor: ring.getWorldPosition(new Vector3()).toArray() as Vec3, keepOut: keepOut.map((p) => ring.localToWorld(p).toArray() as Vec3), clientX: 0, clientY: 0 }],
        };
        break;
      }
      default:
        return null;
    }
    return made && this.placePrompt(made);
  }

  /**
   * Where the boxes go on screen. Each box is pushed out from its anchor along
   * the way out of the object there, which is the way from the object's middle
   * through the edge, square to the edge as seen on screen, far enough that the
   * box's near corner sits a pad off the anchor. That holds for an edge behind
   * the object too: the box then lies over the object, but on the side a
   * dimension of that edge would be read from. The boxes are the same size at
   * any zoom, so a small-looking object gets them hugging its edges just the
   * same; two that would still land on each other are moved apart.
   */
  private placePrompt(prompt: HandlePrompt): HandlePrompt {
    const EPS = 1e-3;
    const center = this.toClient(new Vector3(...prompt.center));
    const [bw, bh] = PROMPT_BOX;
    /**
     * The center of a box pushed out from `at` along `n`: its near corner a pad off `at` when `n` is well
     * off the axes, sliding towards centered on the pad line as `n` lines up with an axis. The slide is
     * continuous, so a small change of view moves the box a little rather than snapping it across.
     */
    const centerFor = (at: { clientX: number; clientY: number }, n: [number, number], pad = PROMPT_PAD): [number, number] => {
      const lean = (c: number) => Math.max(-1, Math.min(1, c / 0.45));
      return [at.clientX + n[0] * pad + lean(n[0]) * (bw / 2), at.clientY + n[1] * pad + lean(n[1]) * (bh / 2)];
    };
    const dirOnScreen = (from: Vec3, dir: Vec3): [number, number] => {
      const a = this.toClient(new Vector3(...from));
      const b = this.toClient(new Vector3(from[0] + dir[0] * EPS, from[1] + dir[1] * EPS, from[2] + dir[2] * EPS));
      return [b.clientX - a.clientX, b.clientY - a.clientY];
    };
    const unit = ([x, y]: [number, number]): [number, number] | null => {
      const l = Math.hypot(x, y);
      return l < 1e-9 ? null : [x / l, y / l];
    };
    const view = this.renderer.domElement.getBoundingClientRect();
    const fields = prompt.fields.map((field) => {
      const at = this.toClient(new Vector3(...field.anchor));
      if (field.beside) {
        // To the right of the grip, or to the left when the right would run off the view.
        const right = at.clientX + PROMPT_BESIDE + bw / 2;
        const cx = right + bw / 2 + PROMPT_MARGIN <= view.right ? right : at.clientX - PROMPT_BESIDE - bw / 2;
        return { ...field, clientX: cx, clientY: at.clientY };
      }
      if (field.keepOut) {
        // Away from the object's middle, starting at the handle's middle, out until the box clears the handle by a pad.
        const pts = field.keepOut.map((p) => this.toClient(new Vector3(...p)));
        const box = { l: Math.min(...pts.map((p) => p.clientX)), r: Math.max(...pts.map((p) => p.clientX)), t: Math.min(...pts.map((p) => p.clientY)), b: Math.max(...pts.map((p) => p.clientY)) };
        const mid = { clientX: (box.l + box.r) / 2, clientY: (box.t + box.b) / 2 };
        let n = unit([mid.clientX - center.clientX, mid.clientY - center.clientY]) ?? [0, -1];
        if (field.heading && n[0] * field.heading[0] + n[1] * field.heading[1] < 0) n = [-n[0], -n[1]];
        const clear = (cx: number, cy: number) => cx + bw / 2 + PROMPT_PAD / 2 <= box.l || cx - bw / 2 - PROMPT_PAD / 2 >= box.r || cy + bh / 2 + PROMPT_PAD / 2 <= box.t || cy - bh / 2 - PROMPT_PAD / 2 >= box.b;
        let t = 0;
        while (t < 400 && !clear(mid.clientX + n[0] * t, mid.clientY + n[1] * t)) t += 2;
        return { ...field, heading: n, clientX: mid.clientX + n[0] * t, clientY: mid.clientY + n[1] * t };
      }
      // Out of the object on screen: away from the box's reference point, a fixed way out, or away from the middle; then square to the edge.
      const from = field.ref ? this.toClient(new Vector3(...field.ref)) : center;
      let n: [number, number] | null = field.out ? unit(dirOnScreen(field.anchor, field.out)) : null;
      n ??= unit([at.clientX - from.clientX, at.clientY - from.clientY]);
      const e = field.along ? unit(dirOnScreen(field.anchor, field.along)) : null;
      if (n && e) {
        const d = n[0] * e[0] + n[1] * e[1];
        n = unit([n[0] - d * e[0], n[1] - d * e[1]]) ?? n;
      }
      n ??= [0, 1];
      // The side was settled when the boxes first appeared; a zoom or pan afterwards must not swap it.
      if (field.heading && n[0] * field.heading[0] + n[1] * field.heading[1] < 0) n = [-n[0], -n[1]];
      const [cx, cy] = centerFor(at, n, field.pad);
      return { ...field, heading: n, clientX: cx, clientY: cy };
    });
    // Boxes that would overlap are moved apart along the line between them until they clear.
    for (let a = 0; a < fields.length; a++)
      for (let b = a + 1; b < fields.length; b++) {
        const dx = fields[b].clientX - fields[a].clientX;
        const dy = fields[b].clientY - fields[a].clientY;
        if (Math.abs(dx) >= bw || Math.abs(dy) >= bh) continue;
        // Clear whichever way needs the smaller move, up and down for a level pair.
        const needX = bw - Math.abs(dx);
        const needY = bh - Math.abs(dy);
        if (needY <= needX) {
          const sign = dy >= 0 ? 1 : -1;
          fields[a].clientY -= (sign * (needY + 2)) / 2;
          fields[b].clientY += (sign * (needY + 2)) / 2;
        } else {
          const sign = dx >= 0 ? 1 : -1;
          fields[a].clientX -= (sign * (needX + 2)) / 2;
          fields[b].clientX += (sign * (needX + 2)) / 2;
        }
      }
    // Nothing goes off the view: a box that would is brought back to the margin.
    for (const f of fields) {
      f.clientX = Math.min(Math.max(f.clientX, view.left + PROMPT_MARGIN + bw / 2), view.right - PROMPT_MARGIN - bw / 2);
      f.clientY = Math.min(Math.max(f.clientY, view.top + PROMPT_MARGIN_TOP + bh / 2), view.bottom - PROMPT_MARGIN - bh / 2);
    }
    return { ...prompt, fields };
  }

  /** Take the typing boxes away (the boxes call this too when they close themselves). */
  dismissPrompt(): void {
    if (!this.prompt) return;
    this.prompt = null;
    this.events.onHandleClick(null);
  }

  /** After the camera moved: boxes follow a zoom or a pan, and go away when the view turns. */
  private followPrompt(): void {
    if (!this.prompt) return;
    if (this.camera.quaternion.angleTo(this.prompt.heading) > 1e-4) {
      this.dismissPrompt();
      return;
    }
    const prompt = this.placePrompt(this.prompt.prompt);
    this.prompt = { prompt, heading: this.prompt.heading };
    this.events.onHandleClick(prompt);
  }

  /** Apply a typed value as if the handle had been dragged there (one undo step). */
  applyTyped(kind: HandleKind, values: number[]): void {
    const f = this.frame;
    if (!f || !this.options.interactive || values.length === 0) return;
    const nodes = this.items.filter((i) => i.selected && !i.ghost && !i.node.locked).map((i) => i.node);
    if (nodes.length === 0) return;
    let changed: SceneNode[] | null = null;
    const v = values[0];
    const box = gripBox(f);
    if (kind.type === 'height') {
      if (v >= MIN_SIZE) changed = this.stretched(box, nodes, [box.size[0], box.size[1], v], [0, 0, -kind.side]);
    } else if (kind.type === 'resize') {
      const size: Vec3 = [...box.size];
      const w = values[0];
      const d = values.length > 1 ? values[1] : values[0];
      if (kind.sx !== 0 && w >= MIN_SIZE) size[0] = w;
      if (kind.sy !== 0 && d >= MIN_SIZE) size[1] = d;
      changed = this.stretched(box, nodes, size, [-kind.sx as -1 | 0 | 1, -kind.sy as -1 | 0 | 1, 0]);
    } else if (kind.type === 'move' && kind.axis === 2) {
      const dz = v - f.bounds.min[2];
      changed = nodes.map((n) => ({ ...n, pos: [n.pos[0], n.pos[1], n.pos[2] + dz] as Vec3 }));
    } else if (kind.type === 'rotate') {
      const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
      changed = rotateNodes(nodes, kind.axis, v, pivot);
    }
    if (!changed) return;
    this.events.onGestureStart();
    this.events.onGestureChange(changed);
    this.events.onGestureEnd(false);
  }

  private boxAxis(box: GripBox, axis: 0 | 1 | 2): Vector3 {
    const m = box.matrix;
    return new Vector3(m[axis * 3], m[axis * 3 + 1], m[axis * 3 + 2]);
  }

  /** Distance along a line (from `origin` in direction `axis`) of the point nearest to the pointer ray. */
  private alongAxis(origin: Vector3, axis: Vector3): number | null {
    const ray = this.raycaster.ray;
    const w = origin.clone().sub(ray.origin);
    const b = axis.dot(ray.direction);
    const denominator = 1 - b * b;
    // Looking straight down the line: the pointer says nothing about where along it.
    if (denominator < 1e-3) return null;
    return (b * w.dot(ray.direction) - w.dot(axis)) / denominator;
  }

  /** True when the box's base plane is seen so nearly edge-on that a pointer cannot be placed on it. */
  private baseEdgeOn(box: GripBox): boolean {
    return Math.abs(this.raycaster.ray.direction.dot(this.boxAxis(box, 2))) < 0.06;
  }

  /** Of the box's two base axes, the one squarer to the view, which the pointer can follow. */
  private bestBaseAxis(box: GripBox): 0 | 1 {
    const d = this.raycaster.ray.direction;
    return Math.abs(d.dot(this.boxAxis(box, 0))) <= Math.abs(d.dot(this.boxAxis(box, 1))) ? 0 : 1;
  }

  /**
   * Pointer position on the plane of the box's base, in the box's own (unscaled) frame, relative to
   * its center. With `axisOnly`, or for an edge grip, the pointer is followed along one axis only and
   * the other is held at the grip, which works from any viewing angle.
   */
  private resizePoint(box: GripBox, sx: number, sy: number, axisOnly?: 0 | 1): Vector3 | null {
    const m = box.matrix;
    const x = new Vector3(m[0], m[1], m[2]);
    const y = new Vector3(m[3], m[4], m[5]);
    const z = new Vector3(m[6], m[7], m[8]);
    const center = new Vector3(m[9], m[10], m[11]);
    const base = center.clone().addScaledVector(z, -box.size[2] / 2);
    const single = axisOnly ?? (sx !== 0 && sy !== 0 ? null : sx !== 0 ? 0 : 1);
    if (single === null) {
      const plane = new Plane().setFromNormalAndCoplanarPoint(z, base);
      if (Math.abs(this.raycaster.ray.direction.dot(z)) < 0.06) return null;
      const p = this.raycaster.ray.intersectPlane(plane, new Vector3());
      if (!p) return null;
      p.sub(center);
      return new Vector3(p.dot(x), p.dot(y), 0);
    }
    const t = this.alongAxis(base, single === 0 ? x : y);
    if (t === null) return null;
    // The axis not followed stays at the grip's own place, so that side keeps its size.
    return single === 0 ? new Vector3(t, (sy * box.size[1]) / 2, 0) : new Vector3((sx * box.size[0]) / 2, t, 0);
  }

  /** Angle of the pointer around a fixed axis through `pivot`, or null when that axis is seen side-on. */
  private angleAbout(axis: 0 | 1 | 2, pivot: Vec3): number | null {
    const normal = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    if (Math.abs(this.raycaster.ray.direction.dot(normal)) < 0.2) return null;
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...pivot));
    const p = this.raycaster.ray.intersectPlane(plane, new Vector3());
    if (!p) return null;
    p.sub(new Vector3(...pivot));
    const u = [p.y, p.z, p.x][axis];
    const v = [p.z, p.x, p.y][axis];
    return (Math.atan2(v, u) * 180) / Math.PI;
  }

  private snap(v: number): number {
    const step = this.options.snap;
    return step > 0 ? Math.round(v / step) * step : v;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.otherPointer(event)) return;
    this.setRay(event);
    const drag = this.drag;

    if (this.placing) {
      this.events.onPlaceMove(this.landingPoint());
      return;
    }
    if (!drag) {
      if (event.buttons === 0 && this.options.interactive) {
        if (this.options.measure) {
          this.hoverMeasure(this.pickMeasure(event), event);
          return;
        }
        const snap = this.pickSnap(event);
        this.hoverSnap(snap);
        const markerHandle = snap === null ? this.pickMarkerHandle(event) : null;
        this.hoverArrow(markerHandle);
        this.hover(snap === null && markerHandle === null ? this.pickHandle(event) : null);
        const other = snap === null && markerHandle === null && !this.hovered ? this.pickDimMarker() : null;
        const cursor = this.renderer.domElement.style;
        if (snap !== null || other !== null) cursor.cursor = 'pointer';
        else if (markerHandle !== null) cursor.cursor = 'move';
        else if (!this.hovered && !this.placing) cursor.cursor = '';
      }
      return;
    }
    if (this.press && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= dragThreshold(event)) this.press = null;

    switch (drag.mode) {
      case 'held':
        return;
      case 'pending-tap':
        // The finger is moving: the camera has it after all.
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) return;
        this.endHold();
        this.drag = null;
        return;
      case 'pending-move': {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event) || drag.nodes.length === 0) return;
        this.endHold();
        if (drag.select) this.events.onSelect([drag.select], 'replace');
        this.drag = { mode: 'move', nodes: drag.nodes, plane: drag.plane, origin: drag.origin };
        this.renderer.domElement.style.cursor = 'move';
        this.events.onGestureStart();
        this.moveTo(this.drag, event);
        return;
      }
      case 'move':
        this.moveTo(drag, event);
        return;
      case 'pending-marquee':
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) return;
        this.drag = { ...drag, mode: 'marquee' };
        this.showMarquee(drag.x, drag.y, event.clientX, event.clientY);
        return;
      case 'marquee':
        this.showMarquee(drag.x, drag.y, event.clientX, event.clientY);
        return;
      case 'resize':
        this.resizeTo(drag, event);
        return;
      case 'height':
        this.heightTo(drag, event);
        return;
      case 'slide':
        this.slideTo(drag, event);
        return;
      case 'rotate':
        this.rotateTo(drag, event);
        return;
      case 'marker':
        this.markerTo(drag, event);
        return;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.otherPointer(event)) return;
    this.endHold();
    const drag = this.drag;
    this.drag = null;
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!drag) {
      // A shape dragged in from the palette is put down where the button is released.
      if (this.placing && event.type === 'pointerup' && event.button === 0) {
        this.setRay(event);
        this.events.onPlaceMove(this.landingPoint());
        this.events.onPlaceCommit();
      }
      return;
    }
    canvas.style.cursor = this.placing ? 'copy' : '';
    this.events.onReadout(null, 0, 0);

    switch (drag.mode) {
      case 'place':
        if (event.type === 'pointerup') {
          this.setRay(event);
          this.events.onPlaceMove(this.landingPoint());
          this.events.onPlaceCommit();
        }
        return;
      case 'pending-move':
        // A finger that tapped an object selects it.
        if (drag.select && event.type === 'pointerup') this.events.onSelect([drag.select], 'replace');
        return;
      case 'pending-tap':
        if (event.type === 'pointerup') this.events.onSelect([], 'replace');
        return;
      case 'pending-marquee':
        // A plain click on nothing clears the selection.
        if (!drag.additive) this.events.onSelect([], 'replace');
        return;
      case 'marquee':
        this.events.onSelect(this.insideMarquee(drag.x, drag.y, event.clientX, event.clientY), drag.additive ? 'add' : 'replace');
        this.hideMarquee();
        return;
      case 'marker':
        this.events.onMarkerDrop();
        return;
      default: {
        // A press without a drag asks for the value instead.
        const press = this.press;
        this.press = null;
        if (press && event.type === 'pointerup') {
          this.events.onGestureEnd(true);
          const prompt = this.promptFor(press.handle);
          if (prompt) {
            this.prompt = { prompt, heading: this.camera.quaternion.clone() };
            this.events.onHandleClick(prompt);
          }
          return;
        }
        this.events.onGestureEnd(event.type === 'pointercancel');
      }
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.placing && !this.drag) this.events.onPlaceMove(null);
    this.hover(null);
    this.hoverSnap(null);
    this.hoverArrow(null);
    if (this.measureHot) {
      this.measureHot = null;
      this.events.onReadout(null, 0, 0);
      this.syncMeasure();
      this.requestRender();
    }
  };

  // --- measure mode ------------------------------------------------------------

  /** The features of a drawn object as placed, indexed once per geometry and placement and kept while they last. */
  private featureIndexOf(d: Drawn): FeatureIndex | null {
    const shown = d.shown;
    if (!shown) return null;
    d.mesh.updateMatrixWorld();
    const key = d.mesh.matrixWorld.elements.map((v) => v.toFixed(5)).join(',');
    const had = this.measureIndexes.get(d.item.node.id);
    if (had && had.shown === shown && had.key === key) return had.index;
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
    this.measureIndexes.set(d.item.node.id, { shown, key, index });
    return index;
  }

  /** The feature under the pointer: a centre dot first (the smaller target, and inside the object), else the nearest feature on the surface hit. */
  private pickMeasure(event?: PointerEvent): Feature | null {
    const m = this.options.measure;
    if (!m) return null;
    this.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutMeasure();
    this.overlay.updateMatrixWorld();
    this.gripScale = 1;
    let best: Feature | null = null;
    let bestDistance = Infinity;
    for (const dot of this.measureDots) {
      const hit = this.raycaster.intersectObject(dot.sprite, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = dot.feature;
        bestDistance = hit.distance;
      }
    }
    if (best) return best;
    const hit = this.pickNode();
    if (!hit) return null;
    const index = this.featureIndexOf(hit.drawn);
    if (!index) return null;
    return nearestFeature(index, hit.item.node.id, [hit.point.x, hit.point.y, hit.point.z], hit.triangle, new Set(m.kinds), MEASURE_REACH * this.pixelSize(hit.point));
  }

  private hoverMeasure(feature: Feature | null, event: PointerEvent): void {
    const same = sameFeature(this.measureHot, feature);
    this.measureHot = feature;
    this.renderer.domElement.style.cursor = feature ? 'crosshair' : '';
    this.events.onReadout(feature ? describeFeature(feature).lines.join(' · ') : null, event.clientX, event.clientY);
    if (same) return;
    this.syncMeasure();
    this.requestRender();
  }

  /** Redraws what measure mode shows: the picks, the hovered feature, the line between the picks with its figure, and the centre dots on offer. */
  private syncMeasure(): void {
    for (const child of [...this.measureGroup.children]) {
      this.measureGroup.remove(child);
      if (child instanceof Mesh || child instanceof Line) {
        child.geometry.dispose();
        (child.material as MeshBasicMaterial | LineBasicMaterial).dispose();
      } else if (child instanceof Sprite && child === this.measureLabel?.sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    this.measureDots = [];
    this.measureLabel = null;
    const m = this.options.measure;
    if (!m) {
      this.measureHot = null;
      return;
    }
    const t = THEMES[this.options.theme];
    const hotColor = this.options.theme === 'dark' ? 0xffffff : 0x1b1f27;
    this.measureMaterials ??= {
      dot: new SpriteMaterial({ map: dotTexture('#17cdd3'), depthTest: false, depthWrite: false, transparent: true }),
      dotHot: new SpriteMaterial({ map: dotTexture(this.options.theme === 'dark' ? '#ffffff' : '#1b1f27', '#17cdd3'), depthTest: false, depthWrite: false, transparent: true }),
    };
    for (const pick of m.picks) this.drawFeature(pick, t.accent, false);
    if (this.measureHot && !m.picks.some((p) => sameFeature(p, this.measureHot))) this.drawFeature(this.measureHot, hotColor, true);
    const r = m.result;
    if (r?.to) {
      const material = new LineBasicMaterial({ color: t.accent, transparent: true, opacity: 0.95, depthTest: false });
      const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([...r.from, ...r.to]), 3));
      const line = new Line(geometry, material);
      line.renderOrder = 13;
      this.measureGroup.add(line);
      for (const end of [r.from, r.to]) {
        const dot = new Sprite(this.measureMaterials.dot);
        dot.position.set(end[0], end[1], end[2]);
        dot.renderOrder = 13;
        dot.userData.pixels = 7;
        this.measureGroup.add(dot);
      }
      const label = textTexture(r.text, this.options.theme);
      const sprite = new Sprite(new SpriteMaterial({ map: label.texture, depthTest: false, depthWrite: false, transparent: true }));
      sprite.position.set((r.from[0] + r.to[0]) / 2, (r.from[1] + r.to[1]) / 2, (r.from[2] + r.to[2]) / 2);
      sprite.renderOrder = 14;
      this.measureGroup.add(sprite);
      this.measureLabel = { sprite, aspect: label.aspect };
    }
    // The centre of each object, a dot inside it to take hold of.
    if (m.kinds.includes('center')) {
      for (const d of this.drawn.values()) {
        if (!d.mesh.visible || d.item.ghost) continue;
        const index = this.featureIndexOf(d);
        if (!index) continue;
        const at = index.center;
        const feature: Feature = { kind: 'center', node: d.item.node.id, at };
        const lit = sameFeature(feature, this.measureHot) || m.picks.some((p) => sameFeature(p, feature));
        const sprite = new Sprite(lit ? this.measureMaterials.dotHot : this.measureMaterials.dot);
        sprite.position.set(at[0], at[1], at[2]);
        sprite.renderOrder = 12;
        sprite.userData.pixels = lit ? 15 : 10;
        this.measureGroup.add(sprite);
        this.measureDots.push({ sprite, feature });
      }
    }
    this.layoutMeasure();
  }

  /** One feature, drawn in a colour: a dot, a line, a ring or the face's own triangles. */
  private drawFeature(f: Feature, color: number, hot: boolean): void {
    const materials = this.measureMaterials!;
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
        this.measureGroup.add(dot);
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
        this.measureGroup.add(line);
        return;
      }
      case 'face': {
        const d = this.drawn.get(f.node);
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
        this.measureGroup.add(mesh);
        return;
      }
    }
  }

  /** Dots and the figure at the same size on screen whatever the zoom. */
  private layoutMeasure(): void {
    for (const child of this.measureGroup.children) {
      if (!(child instanceof Sprite)) continue;
      if (child === this.measureLabel?.sprite) {
        const h = MEASURE_LABEL_PIXELS * this.pixelSize(child.position);
        child.scale.set(h * this.measureLabel.aspect, h, 1);
      } else child.scale.setScalar(((child.userData.pixels as number) ?? 10) * this.pixelSize(child.position) * this.gripScale);
    }
  }

  // --- snap points (Robot mode) ------------------------------------------------

  /** One dot per snap point on offer; the dots are kept across option changes and only remade when the count changes. */
  private syncSnaps(): void {
    const wanted = this.options.snaps?.length ?? 0;
    while (this.snapDots.length > wanted) {
      const dot = this.snapDots.pop()!;
      this.overlay.remove(dot);
    }
    while (this.snapDots.length < wanted) {
      const dot = new Sprite(this.grips.dot);
      dot.renderOrder = 11;
      this.overlay.add(dot);
      this.snapDots.push(dot);
    }
    if (this.snapHot !== null && this.snapHot >= wanted) this.hoverSnap(null);
    this.snapAxis.visible = false;
  }

  /** The markers at their origins, each unit scaled to its pixel size on screen; the picked one's grips beside it. */
  private layoutMarker(): void {
    const place = (group: Group, matrix: Mat, pixels: number) => {
      const scale = pixels * this.pixelSize(new Vector3(matrix[9], matrix[10], matrix[11]));
      const m = [...matrix] as Mat;
      for (let i = 0; i < 9; i++) m[i] *= scale;
      toMatrix4(m, group.matrix);
      group.matrixWorldNeedsUpdate = true;
    };
    const mk = this.options.marker;
    if (mk) {
      place(this.marker, mk.matrix, MARKER_PIXELS);
      // The arrows stand on the design's axes whatever way the marker is turned; bigger to a finger, and the hot one a little more.
      place(this.markerArrows, [1, 0, 0, 0, 1, 0, 0, 0, 1, mk.matrix[9], mk.matrix[10], mk.matrix[11]], MARKER_PIXELS * this.gripScale);
      this.markerArrows.children.forEach((arrow, i) => arrow.scale.setScalar(i === this.hotArrow ? 1.15 : 1));
    }
    for (const d of this.options.markers ?? []) {
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
      this.overlay.remove(r);
    }
    this.rays.clear();
  }

  /** Which handle of the picked marker is under the pointer: one of its move arrows, or (a joint) its axis rod. */
  private pickMarkerHandle(event?: PointerEvent): MarkerHandle | null {
    if (!this.options.marker || !this.marker.visible || !this.options.interactive) return null;
    this.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutMarker();
    this.overlay.updateMatrixWorld();
    this.gripScale = 1;
    let best: MarkerHandle | null = null;
    let bestDistance = Infinity;
    for (const arrow of this.markerArrows.children) {
      const target = arrow.children.find((c) => c.userData.hit);
      const hit = target && this.raycaster.intersectObject(target, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = arrow.userData.axis as 0 | 1 | 2;
        bestDistance = hit.distance;
      }
    }
    if (best !== null) return best;
    const slide = this.marker.children.find((c) => c.userData.slide);
    return slide && this.raycaster.intersectObject(slide, false).length ? 'slide' : null;
  }

  private hoverArrow(handle: MarkerHandle | null): void {
    const hot = typeof handle === 'number' ? handle : null;
    if (hot === this.hotArrow) return;
    this.hotArrow = hot;
    this.requestRender();
  }

  /** The unpicked marker under the pointer, by id. */
  private pickDimMarker(): string | null {
    if (this.dimMarkers.size === 0) return null;
    this.layoutMarker();
    this.overlay.updateMatrixWorld();
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const [id, g] of this.dimMarkers) {
      const target = g.children.find((c) => c.userData.pick);
      const hit = target && this.raycaster.intersectObject(target, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = id;
        bestDistance = hit.distance;
      }
    }
    return best;
  }

  private startMarkerDrag(how: MarkerHandle): void {
    const mk = this.options.marker!;
    const origin = new Vector3(mk.matrix[9], mk.matrix[10], mk.matrix[11]);
    const axis = how === 'slide' ? new Vector3(mk.matrix[6], mk.matrix[7], mk.matrix[8]).normalize() : axisVector(how);
    this.drag = { mode: 'marker', how, origin, axis, grabT: this.alongAxis(origin, axis) ?? 0 };
    this.renderer.domElement.style.cursor = 'move';
  }

  /** The marker follows the pointer along the handle's axis; steps snap to the grid. */
  private markerTo(drag: Extract<Drag, { mode: 'marker' }>, event: PointerEvent): void {
    const t = this.alongAxis(drag.origin, drag.axis);
    if (t === null) return;
    const d = this.snap(t - drag.grabT);
    const next = drag.origin.clone().addScaledVector(drag.axis, d);
    this.events.onMarkerMove(tidyVec(next.toArray() as Vec3));
    this.events.onReadout(`${drag.how === 'slide' ? 'Along the axis' : 'XYZ'[drag.how]} ${d >= 0 ? '+' : ''}${fmt(d)}`, event.clientX, event.clientY);
  }

  private layoutSnaps(): void {
    const snaps = this.options.snaps;
    if (!snaps) return;
    snaps.forEach((snap, i) => {
      const dot = this.snapDots[i];
      if (!dot) return;
      const hot = i === this.snapHot;
      dot.material = hot ? this.grips.dotHot : this.grips.dot;
      dot.position.set(snap.at[0], snap.at[1], snap.at[2]);
      dot.scale.setScalar((hot ? 16 : 11) * this.pixelSize(dot.position) * this.gripScale);
    });
    // The hovered point's axis, drawn through it.
    const hot = this.snapHot !== null ? snaps[this.snapHot] : undefined;
    this.snapAxis.visible = Boolean(hot?.axis);
    if (hot?.axis) {
      const reach = 40 * this.pixelSize(new Vector3(...hot.at));
      const pts = this.snapAxis.geometry.getAttribute('position') as BufferAttribute;
      for (let k = 0; k < 3; k++) {
        pts.setComponent(0, k, hot.at[k] - hot.axis[k] * reach);
        pts.setComponent(1, k, hot.at[k] + hot.axis[k] * reach);
      }
      pts.needsUpdate = true;
    }
  }

  private pickSnap(event?: PointerEvent): number | null {
    if (!this.options.snaps?.length) return null;
    this.gripScale = event?.pointerType === 'touch' ? TOUCH_GRIP_SCALE : 1;
    this.layoutSnaps();
    this.overlay.updateMatrixWorld();
    this.gripScale = 1;
    let best: number | null = null;
    let bestDistance = Infinity;
    this.snapDots.forEach((dot, i) => {
      const hit = this.raycaster.intersectObject(dot, false)[0];
      if (hit && hit.distance < bestDistance) {
        best = i;
        bestDistance = hit.distance;
      }
    });
    return best;
  }

  private hoverSnap(index: number | null): void {
    if (index === this.snapHot) return;
    this.snapHot = index;
    this.events.onSnapHover(index);
    this.requestRender();
  }

  private hover(handle: Handle | null): void {
    if (handle === this.hovered) return;
    const was = this.hovered?.kind;
    this.hovered = handle;
    // Over an anchor dot the objects move there for a look; off it, they come back.
    if (handle?.kind.type === 'align') this.events.onAlignHover(handle.kind.axis, handle.kind.mode);
    else if (was?.type === 'align') this.events.onAlignHover(null, 'center');
    if (!this.placing) this.renderer.domElement.style.cursor = handle ? handle.cursor : '';
    this.requestRender();
  }

  /** Where a new shape would stand: on the flat top of whatever is under the pointer, else on the plate. */
  private landingPoint(): Vec3 | null {
    const hit = this.pickNode();
    let point: Vector3 | null = null;
    if (hit && hit.normal.z > 0.9 && !hit.item.node.hole) point = hit.point;
    else if (this.raycaster.ray.direction.z < -0.02) point = this.raycaster.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), new Vector3());
    if (!point || Math.hypot(point.x, point.y) > 5000) return null;
    return [this.snap(point.x), this.snap(point.y), tidy(point.z)];
  }

  private moveTo(drag: Extract<Drag, { mode: 'move' }>, event: PointerEvent): void {
    // A plane seen nearly edge-on would fling the object to the horizon.
    if (Math.abs(this.raycaster.ray.direction.z) < 0.04) return;
    const p = this.raycaster.ray.intersectPlane(drag.plane, new Vector3());
    if (!p) return;
    let dx = this.snap(p.x - drag.origin.x);
    let dy = this.snap(p.y - drag.origin.y);
    // Shift keeps the move on one axis.
    if (event.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    this.events.onGestureChange(drag.nodes.map((n) => ({ ...n, pos: tidyVec([n.pos[0] + dx, n.pos[1] + dy, n.pos[2]]) })));
    this.say(`${fmt(dx)}, ${fmt(dy)}`, event);
  }

  /** The selection follows the pointer along one of the design's axes; steps snap to the grid. */
  private slideTo(drag: Extract<Drag, { mode: 'slide' }>, event: PointerEvent): void {
    const t = this.alongAxis(drag.origin, axisVector(drag.axis));
    if (t === null) return;
    const d = this.snap(t - drag.grab);
    this.events.onGestureChange(drag.nodes.map((n) => ({ ...n, pos: tidyVec(n.pos.map((v, i) => (i === drag.axis ? v + d : v)) as Vec3) })));
    this.say(`${'XYZ'[drag.axis]} ${d >= 0 ? '+' : ''}${fmt(d)}`, event);
  }

  /** New size for a grip drag, with the opposite side (and the base) staying put. */
  private resized(node: SceneNode, size: Vec3, anchor: Vec3): SceneNode {
    // `anchor` is -1/0/+1 per axis: which side of the box does not move.
    const m = rotation(node.rot);
    const pos: Vec3 = [...node.pos];
    for (let c = 0; c < 3; c++) {
      const shift = (anchor[c] * (node.size[c] - size[c])) / 2;
      pos[0] += m[c * 3] * shift;
      pos[1] += m[c * 3 + 1] * shift;
      pos[2] += m[c * 3 + 2] * shift;
    }
    let next = { ...node, size: tidyVec(size), pos: tidyVec(pos) } as SceneNode;
    if (next.type === 'shape') next = { ...next, params: clampParams({ shape: next.shape, params: next.params, size: next.size }) };
    return next;
  }

  /**
   * The nodes as they are once the grip box has `size`, with the `anchor` side (-1/0/+1 per axis) staying
   * put: one object is resized on its own frame; several are stretched together about the fixed side of
   * the box round them, which is square to the axes.
   */
  private stretched(box: GripBox, nodes: SceneNode[], size: Vec3, anchor: Vec3): SceneNode[] {
    if (box.single) return [this.resized(box.single, size, anchor)];
    const factor: Vec3 = [0, 1, 2].map((c) => size[c] / Math.max(box.size[c], 1e-6)) as Vec3;
    const pivot = this.pointOf(box.matrix, [(anchor[0] * box.size[0]) / 2, (anchor[1] * box.size[1]) / 2, (anchor[2] * box.size[2]) / 2]);
    return scaleNodes(nodes, factor, pivot.toArray() as Vec3, MIN_SIZE);
  }

  private resizeTo(drag: Extract<Drag, { mode: 'resize' }>, event: PointerEvent): void {
    const { box, sx, sy } = drag;
    const p = this.resizePoint(box, sx, sy, drag.axisOnly);
    if (!p) return;
    p.sub(drag.grab);
    const size: Vec3 = [...box.size];
    if (sx !== 0) size[0] = Math.max(MIN_SIZE, this.snap(sx * p.x + box.size[0] / 2));
    if (sy !== 0) size[1] = Math.max(MIN_SIZE, this.snap(sy * p.y + box.size[1] / 2));
    if (event.shiftKey) {
      // Shift scales the whole thing evenly, following the axis that moved most.
      const fx = size[0] / box.size[0];
      const fy = size[1] / box.size[1];
      const f = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
      size[0] = box.size[0] * f;
      size[1] = box.size[1] * f;
      size[2] = box.size[2] * f;
    }
    // The side opposite the grip stays where it is; so does the base.
    this.events.onGestureChange(this.stretched(box, drag.nodes, size, [-sx as -1 | 0 | 1, -sy as -1 | 0 | 1, event.shiftKey ? -1 : 0]));
    this.say(event.shiftKey ? size.map(fmt).join(' × ') : `${fmt(size[0])} × ${fmt(size[1])}`, event);
  }

  private heightTo(drag: Extract<Drag, { mode: 'height' }>, event: PointerEvent): void {
    const { box, side } = drag;
    const z = this.boxAxis(box, 2);
    const fixed = this.pointOf(box.matrix, [0, 0, 0]).addScaledVector(z, (-side * box.size[2]) / 2);
    const t = this.alongAxis(fixed, z);
    if (t === null) return;
    const h = Math.max(MIN_SIZE, this.snap(side * (t - drag.grab)));
    const f = h / box.size[2];
    const size: Vec3 = event.shiftKey ? [box.size[0] * f, box.size[1] * f, h] : [box.size[0], box.size[1], h];
    this.events.onGestureChange(this.stretched(box, drag.nodes, size, [0, 0, -side]));
    this.say(event.shiftKey ? size.map(fmt).join(' × ') : fmt(h), event);
  }

  private rotateTo(drag: Extract<Drag, { mode: 'rotate' }>, event: PointerEvent): void {
    const angle = this.angleAbout(drag.axis, drag.pivot);
    // Seen side-on, the ring cannot be followed; fall back to sideways pointer travel.
    let delta = angle !== null && drag.start !== null ? angle - drag.start : (event.clientX - drag.x) * 0.6;
    delta = ((((delta + 180) % 360) + 360) % 360) - 180;
    const step = event.shiftKey ? ROTATE_COARSE : event.altKey || event.ctrlKey ? 1 : ROTATE_STEP;
    delta = Math.round(delta / step) * step;
    this.events.onGestureChange(delta === 0 ? drag.nodes : rotateNodes(drag.nodes, drag.axis, delta, drag.pivot));
    this.say(`${fmt(delta)}°`, event);
  }

  // --- marquee -------------------------------------------------------------

  private showMarquee(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.marquee) {
      this.marquee = document.createElement('div');
      this.marquee.className = 'marquee';
      this.container.appendChild(this.marquee);
    }
    const rect = this.container.getBoundingClientRect();
    Object.assign(this.marquee.style, {
      display: 'block',
      left: `${Math.min(x0, x1) - rect.left}px`,
      top: `${Math.min(y0, y1) - rect.top}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
  }

  private hideMarquee(): void {
    if (this.marquee) this.marquee.style.display = 'none';
  }

  /** Ids of the nodes whose bounds, as seen on screen, touch the rectangle. */
  private insideMarquee(x0: number, y0: number, x1: number, y1: number): string[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const left = Math.min(x0, x1) - rect.left;
    const right = Math.max(x0, x1) - rect.left;
    const top = Math.min(y0, y1) - rect.top;
    const bottom = Math.max(y0, y1) - rect.top;
    const ids: string[] = [];
    const v = new Vector3();
    for (const item of this.items) {
      if (item.ghost || item.node.hidden) continue;
      const b = this.events.boundsOf(item.node);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let behind = false;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).project(this.camera);
        if (v.z > 1) behind = true;
        const sx = ((v.x + 1) / 2) * rect.width;
        const sy = ((1 - v.y) / 2) * rect.height;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
      if (!behind && minX <= right && maxX >= left && minY <= bottom && maxY >= top) ids.push(item.node.id);
    }
    return ids;
  }

  // --- camera ------------------------------------------------------------

  private fitDistance(radius = this.radius, aspect = this.width && this.height ? this.width / this.height : 1): number {
    const vHalf = (FOV * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    return (radius / Math.sin(Math.min(vHalf, hHalf))) * FIT_MARGIN;
  }

  private poseFor(direction: Vector3): Pose {
    return {
      theta: Math.atan2(direction.y, direction.x),
      phi: Math.acos(clamp(direction.z, -1, 1)),
      distance: this.fitDistance(),
      target: this.center.clone(),
    };
  }

  private currentPose(): Pose {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = Math.max(offset.length(), 1e-6);
    return {
      theta: Math.atan2(offset.y, offset.x),
      phi: Math.acos(clamp(offset.z / distance, -1, 1)),
      distance,
      target,
    };
  }

  private applyPose(pose: Pose): void {
    const phi = clamp(pose.phi, MIN_PHI, Math.PI - MIN_PHI);
    const s = Math.sin(phi) * pose.distance;
    this.controls.target.copy(pose.target);
    this.camera.position.set(
      pose.target.x + s * Math.cos(pose.theta),
      pose.target.y + s * Math.sin(pose.theta),
      pose.target.z + Math.cos(phi) * pose.distance,
    );
    this.controls.update();
  }

  private animateTo(to: Pose): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.animation = null;
      this.controls.enabled = true;
      this.applyPose(to);
    } else {
      this.animation = { start: performance.now(), duration: ANIMATION_MS, from: this.currentPose(), to };
      this.controls.enabled = false;
    }
    this.requestRender();
  }

  private stepAnimation(): void {
    const a = this.animation;
    if (!a) return;
    const t = clamp((performance.now() - a.start) / a.duration, 0, 1);
    const k = easeInOut(t);
    // Take the short way round in azimuth.
    const dTheta = ((((a.to.theta - a.from.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    this.applyPose({
      theta: a.from.theta + dTheta * k,
      phi: a.from.phi + (a.to.phi - a.from.phi) * k,
      distance: a.from.distance + (a.to.distance - a.from.distance) * k,
      target: a.from.target.clone().lerp(a.to.target, k),
    });
    if (t >= 1) {
      this.animation = null;
      this.controls.enabled = true;
    } else {
      this.requestRender();
    }
  }

  // --- rendering ---------------------------------------------------------

  private readonly onCameraChange = (): void => this.followPrompt();

  private readonly requestRender = (): void => {
    if (!this.ok || this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frameTick);
  };

  private readonly frameTick = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.stepAnimation();
    // A view animation moves the camera without the controls noticing, so the boxes are told here.
    if (this.animation) this.followPrompt();
    // With damping, update() keeps emitting 'change' (and so re-requesting frames) until the motion settles.
    this.controls.update();
    this.draw();
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
  };

  private onResize(): void {
    if (!this.ok || this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    if (!width || !height) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Resizing clears the canvas; draw right away to avoid a blank frame.
    this.draw();
  }

  private draw(withOverlays = true): void {
    const { width, height, renderer, camera } = this;
    if (!width || !height) return;

    // Fit the clip planes around everything visible (parts and grid).
    const extent = Math.max(this.gridHalf * Math.SQRT2, this.center.length() + this.radius);
    const distance = camera.position.length();
    camera.near = Math.max(extent / 2000, (distance - extent) * 0.8);
    camera.far = distance + extent * 1.1;
    camera.updateProjectionMatrix();

    renderer.setViewport(0, 0, width, height);
    renderer.render(this.scene, camera);
    if (!withOverlays) return;

    this.drawPreview();
    renderer.autoClear = false;
    if (this.frame || this.pointer3d.visible || this.marker.visible || this.dimMarkers.size || this.snapDots.length || this.lockBadges.size || this.options.measure) {
      this.layoutHandles();
      this.layoutLockBadges();
      this.layoutSnaps();
      this.layoutMeasure();
      this.layoutMarker();
      renderer.clearDepth();
      renderer.render(this.overlay, camera);
    }

    // Axes triad in the bottom-left corner, sharing the main camera's orientation.
    this.triadCamera.quaternion.copy(camera.quaternion);
    this.triadCamera.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(5);
    renderer.clearDepth();
    renderer.setViewport(this.triadOrigin.x, this.triadOrigin.y, GIZMO_SIZE, GIZMO_SIZE);
    renderer.render(this.triadScene, this.triadCamera);
    renderer.autoClear = true;
    renderer.setViewport(0, 0, width, height);
  }

  /**
   * The picked camera's picture in the bottom-right corner: the scene from the sensor's frame (it looks along its X, Z up),
   * with its own field of view and clip distances, so what it sees and what the near plane cuts off can be judged.
   * A depth camera's picture is in greys, near light and far dark. Up to about a quarter of the plate wide; on a narrow
   * plate it sits above the view buttons.
   */
  private drawPreview(): void {
    const p = this.options.preview;
    if (!p) return;
    const { renderer, width, height } = this;
    const aspect = Math.min(Math.max(p.aspect, 0.2), 5);
    let w = Math.min(width * 0.28, 320);
    let h = w / aspect;
    if (h > height * 0.4) {
      h = height * 0.4;
      w = h * aspect;
    }
    w = Math.round(w);
    h = Math.round(h);
    if (w < 40 || h < 30) return;
    const x = width - w - GIZMO_MARGIN;
    const y = width < 600 ? 52 : GIZMO_MARGIN;
    const m = p.matrix;
    const camera = this.previewCamera;
    camera.matrixAutoUpdate = false;
    // The sensor's frame as a camera: right is the frame's -Y, up its Z, and the camera looks down its own -Z, the frame's X.
    camera.matrix.set(-m[3], m[6], -m[0], m[9], -m[4], m[7], -m[1], m[10], -m[5], m[8], -m[2], m[11], 0, 0, 0, 1);
    camera.matrixWorldNeedsUpdate = true;
    camera.aspect = w / h;
    camera.fov = (2 * Math.atan(Math.tan((Math.min(Math.max(p.hfov, 1), 179) * Math.PI) / 360) / camera.aspect) * 180) / Math.PI;
    camera.near = Math.max(p.near, 0.1);
    camera.far = Math.max(p.far, camera.near + 1);
    camera.updateProjectionMatrix();
    const t = THEMES[this.options.theme];
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    // A one-pixel rim in the accent color, then the picture's own backdrop: the stage, or for depth the black of nothing seen.
    renderer.setScissor(x - 1, y - 1, w + 2, h + 2);
    renderer.setClearColor(t.accent, 1);
    renderer.clear(true, true, false);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.setClearColor(p.depth ? 0x000000 : t.stage[1], 1);
    renderer.clear(true, true, false);
    if (p.depth) {
      // Greys over the distances the scene actually spans from the camera, not the far clip, which may be meters off.
      const reach = Math.hypot(m[9] - this.center.x, m[10] - this.center.y, m[11] - this.center.z) + this.radius;
      this.depthMaterial.uniforms.near.value = camera.near;
      this.depthMaterial.uniforms.far.value = Math.min(camera.far, Math.max(reach, camera.near + 1));
      this.scene.overrideMaterial = this.depthMaterial;
    }
    renderer.render(this.scene, camera);
    this.scene.overrideMaterial = null;
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.setViewport(0, 0, width, height);
  }
}
