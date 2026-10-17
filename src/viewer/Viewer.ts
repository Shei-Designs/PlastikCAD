// Framework-agnostic three.js editor view. Model space is millimeters, Z up,
// with the build plate at z=0. The viewer draws the scene it is given and
// turns pointer input into edits (select, move, lift, resize, turn), which it
// reports through callbacks; it never owns the design.
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
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
import { boundsCenter, builtSize, flipSigns, frameMatrix, isEmptyBounds, rotation, tidy, tidyVec, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import { HOLE_COLOR, rotateNodes } from '../model/ops';
import type { Asset, SceneNode, Vec3 } from '../model/types';
import type { BuildResult } from '../worker/protocol';
import { SkinPainter } from './skin';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export interface ViewerOptions {
  theme: 'dark' | 'light';
  edges: boolean;
  grid: boolean;
  /** Grid step that drags snap to, in mm; 0 = free. */
  snap: number;
  /** False while an old version is shown: look, don't touch. */
  interactive: boolean;
  /** Align mode: anchor dots on this box instead of the usual handles. */
  align: { bounds: Bounds; anchor: string | null } | null;
  /** A box to point out (a part inside a group): its frame and size. */
  highlight: { matrix: Mat; size: Vec3 } | null;
}

export type AlignMode = 'min' | 'center' | 'max';

export interface ViewItem {
  node: SceneNode;
  /** Built geometry, or null while the worker is still at it. */
  result: BuildResult | null;
  selected: boolean;
  /** A shape being placed: drawn faintly and ignored by picking. */
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

const DEFAULTS: ViewerOptions = { theme: 'dark', edges: true, grid: true, snap: 1, interactive: true, align: null, highlight: null };
/** Distance of the anchor dots from the box, in pixels. */
const ALIGN_GAP = 22;
const ALIGN_MODES: AlignMode[] = ['min', 'center', 'max'];

const FOV = 35;
const FIT_MARGIN = 1.25;
const ANIMATION_MS = 250;
/** Above this, sharp-edge extraction costs more than it is worth. */
const EDGE_TRIANGLE_LIMIT = 300_000;
const MIN_PHI = 1e-3; // keeps the camera off the Z axis, where "up" is undefined
const GIZMO_SIZE = 92;
const GIZMO_MARGIN = 8;
const EMPTY_RADIUS = 70;
const PLATE_HALF = 100;
const DRAG_THRESHOLD = 4; // px
/** A typing box sits this far out from the edge it measures: clear of the grip drawn there. */
const PROMPT_PAD = 14; // px
/** A box beside a grip starts this far from the grip's center, and no box comes nearer than this to the edge of the view (more at the top, under the toolbar). */
const PROMPT_BESIDE = 30; // px
/** The lift arrow is taller than a grip, so its box sits further up. */
const PROMPT_LIFT_PAD = 30; // px
const PROMPT_MARGIN = 8; // px
const PROMPT_MARGIN_TOP = 52; // px
const PROMPT_BOX: [number, number] = [100, 28]; // px, about the size of a box
/** A finger wobbles more than a mouse before it means to drag. */
const TOUCH_DRAG_THRESHOLD = 10; // px
/** How much bigger a grip is to a finger than to the eye. */
const TOUCH_GRIP_SCALE = 2.5;
const dragThreshold = (event: PointerEvent) => (event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD);
const MIN_SIZE = 0.1; // mm
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
  dark: { grid: 0x8a94a8, major: 0.3, minor: 0.1, accent: 0xff9f4d, edge: 0.85, stage: ['#2a303b', '#14171c'] },
  light: { grid: 0x5c6675, major: 0.34, minor: 0.12, accent: 0xd86e12, edge: 0.7, stage: ['#ffffff', '#d5dae2'] },
};

const AXIS_COLORS = ['#e5484d', '#3fae5a', '#4c8dff'];

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
   */
  skin: { pixels: string; shape: string; geometry: BufferGeometry; own: boolean; map: CanvasTexture } | null;
}

interface SharedGeometry {
  geometry: BufferGeometry;
  edges: BufferGeometry | null;
}

export type HandleKind =
  | { type: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  /** Height grip at the top (side 1, base stays put) or at the bottom (side -1, top stays put). */
  | { type: 'height'; side: 1 | -1 }
  | { type: 'lift' }
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

type Drag =
  | { mode: 'pending-move'; x: number; y: number; nodes: SceneNode[]; plane: Plane; origin: Vector3 }
  | { mode: 'move'; nodes: SceneNode[]; plane: Plane; origin: Vector3 }
  | { mode: 'pending-marquee'; x: number; y: number; additive: boolean }
  | { mode: 'marquee'; x: number; y: number; additive: boolean }
  /** `axisOnly` restricts a corner grip to one base axis when the base is seen edge-on and the other cannot be followed. */
  | { mode: 'resize'; node: SceneNode; sx: number; sy: number; grab: Vector3; axisOnly?: 0 | 1 }
  /** A grip pressed from an angle it cannot be dragged from: a click still brings up its typing boxes. */
  | { mode: 'held' }
  | { mode: 'height'; node: SceneNode; side: 1 | -1; grab: number }
  | { mode: 'lift'; nodes: SceneNode[]; origin: Vector3; grab: number }
  | { mode: 'rotate'; nodes: SceneNode[]; axis: 0 | 1 | 2; pivot: Vec3; start: number | null; x: number }
  | { mode: 'place' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (v: number) => String(Number(v.toFixed(2)));

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

/** Anchor dot for align mode. */
function dotTexture(fill: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#ffffff';
    g.stroke();
  });
}

/** Up/down arrow for the handle that lifts things off the plate. */
function liftTexture(): CanvasTexture {
  return canvasTexture(64, (g) => {
    g.fillStyle = '#14171c';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(32, 5);
    g.lineTo(54, 30);
    g.lineTo(40, 30);
    g.lineTo(40, 59);
    g.lineTo(24, 59);
    g.lineTo(24, 30);
    g.lineTo(10, 30);
    g.closePath();
    g.stroke();
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
  private gridStep = 0;

  private triadScene!: Scene;
  private triadCamera!: OrthographicCamera;
  private disposables: { dispose(): void }[] = [];

  // Handles around the selection, drawn over everything else.
  private overlay!: Scene;
  private frame: Frame | null = null;
  private outline!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private pointer3d!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private handles: Handle[] = [];
  private handleMode: 'none' | 'single' | 'several' | 'locked' | 'align' = 'none';
  private alignLines!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private hovered: Handle | null = null;
  private grips!: { corner: SpriteMaterial; edge: SpriteMaterial; lift: SpriteMaterial; dot: SpriteMaterial; dotHot: SpriteMaterial };
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
    this.requestRender();
  }

  setOptions(options: Partial<ViewerOptions>): void {
    this.options = { ...this.options, ...options };
    if (!this.ok || this.disposed) return;
    this.applyOptions();
    this.sync();
    this.requestRender();
  }

  /** While true, the pointer positions a new shape instead of selecting. */
  setPlacing(placing: boolean): void {
    this.placing = placing;
    if (this.ok) this.renderer.domElement.style.cursor = placing ? 'copy' : '';
  }

  setView(preset: ViewPreset): void {
    if (!this.ok || this.disposed) return;
    this.animateTo(this.poseFor(VIEW_DIRECTIONS[preset]));
  }

  /** Frame the selection, or everything when nothing is selected. */
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
    if (drag.mode !== 'pending-move' && drag.mode !== 'pending-marquee' && drag.mode !== 'marquee' && drag.mode !== 'place') {
      this.events.onGestureEnd(true);
    }
    return true;
  }

  /** Small picture of the whole design from the current angle (JPEG data URL), for the version list. */
  capture(width = 320, height = 200): string | null {
    if (!this.ok || this.disposed || !this.width || !this.height) return null;
    const visible = this.items.filter((i) => !i.ghost && !i.node.hidden);
    if (visible.length === 0) return null;
    const saved = this.currentPose();
    const { center, radius } = this.extent(visible);
    const pose = { ...saved, target: center, distance: this.fitDistance(radius, width / height) };
    const selected = [...this.drawn.values()].filter((d) => d.item.selected);
    try {
      for (const d of selected) this.style(d, false);
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

    const grip = (map: CanvasTexture) => {
      const material = new SpriteMaterial({ map, depthTest: false, toneMapped: false });
      this.disposables.push(map, material);
      return material;
    };
    this.grips = {
      corner: grip(gripTexture('#ffffff', '#14171c')),
      edge: grip(gripTexture('#14171c', '#ffffff')),
      lift: grip(liftTexture()),
      dot: grip(dotTexture('#14171c')),
      dotHot: grip(dotTexture('#ff9f4d')),
    };
    // One line per axis through its three dots.
    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    this.alignLines = new LineSegments(lines, new LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false }));
    this.alignLines.visible = false;
    this.overlay.add(this.alignLines);
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
    this.alignLines.material.color.set(t.accent);
    this.pointer3d.material.color.set(theme === 'dark' ? 0xffffff : 0x1b1f27);
    const h = this.options.highlight;
    if (h) {
      const m = [...h.matrix] as Mat;
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(h.size[c], 1e-6);
      toMatrix4(m, this.pointer3d.matrix);
      this.pointer3d.matrixWorldNeedsUpdate = true;
    }
    this.pointer3d.visible = Boolean(h);
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
        d = { item, mesh, edges: null, shown: null, built: [1, 1, 1], skin: null };
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
      const same =
        !fresh &&
        !reskinned &&
        before.selected === item.selected &&
        before.ghost === item.ghost &&
        before.node.color === node.color &&
        before.node.hole === node.hole &&
        before.node.hidden === node.hidden;
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
    d.skin = { pixels, shape, geometry, own, map };
    d.mesh.geometry = geometry;
    return true;
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
    // A picture sheet is see-through where its picture is transparent.
    const alphaTest = map && node.type === 'picture' ? 0.5 : 0;
    if (material.alphaTest !== alphaTest) {
      material.alphaTest = alphaTest;
      material.needsUpdate = true;
    }
    material.color.set(map ? '#ffffff' : color);
    const faint = node.hole || ghost;
    if (material.transparent !== Boolean(faint)) {
      material.transparent = Boolean(faint);
      material.needsUpdate = true;
    }
    material.opacity = ghost ? 0.6 : node.hole ? 0.38 : 1;
    material.depthWrite = !faint;
    // Selected parts glow a little in their own color; the accent is kept for edges and handles.
    material.emissive.set(selected ? color : 0x000000);
    material.emissiveIntensity = selected ? 0.14 : 0;
    d.mesh.renderOrder = faint ? 1 : 0;

    const wantEdges = (this.options.edges || selected) && Boolean(d.shown) && !node.hidden;
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
      d.edges.material.color.copy(new Color(color)).multiplyScalar(0.22);
      d.edges.material.opacity = node.hole ? 0.5 : t.edge;
    }
  }

  private discard(d: Drawn): void {
    this.scene.remove(d.mesh);
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
    if (picked.length === 0) {
      this.frame = null;
      this.outline.visible = false;
      if (this.handleMode !== 'none') this.clearHandles();
      return;
    }
    const align = this.options.align;
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
    const single = mode === 'single';
    const add = (kind: HandleKind, object: Object3D, pixels: number, cursor: string) => {
      object.renderOrder = 10;
      this.overlay.add(object);
      this.handles.push({ kind, object, pixels, cursor });
    };
    if (mode === 'align') {
      for (const axis of [0, 1, 2] as const) for (const m of ALIGN_MODES) add({ type: 'align', axis, mode: m }, new Sprite(this.grips.dot), 15, 'pointer');
      this.alignLines.visible = true;
      return;
    }
    if (single) {
      for (const sx of [-1, 0, 1] as const) {
        for (const sy of [-1, 0, 1] as const) {
          if (sx === 0 && sy === 0) continue;
          const corner = sx !== 0 && sy !== 0;
          add({ type: 'resize', sx, sy }, new Sprite(corner ? this.grips.corner : this.grips.edge), corner ? 13 : 11, 'nwse-resize');
        }
      }
      add({ type: 'height', side: 1 }, new Sprite(this.grips.corner), 13, 'ns-resize');
      add({ type: 'height', side: -1 }, new Sprite(this.grips.corner), 13, 'ns-resize');
    }
    add({ type: 'lift' }, new Sprite(this.grips.lift), 26, 'ns-resize');
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

  /** World length of one pixel at a point, for handles that keep their size on screen. */
  private pixelSize(at: Vector3): number {
    const depth = at.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new Vector3()));
    return (2 * Math.max(depth, 1e-3) * Math.tan((FOV * Math.PI) / 360)) / Math.max(this.height, 1);
  }

  private framePoint(local: Vec3): Vector3 {
    const m = this.frame!.matrix;
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
    return { at: new Vector3(max[0], cy, max[2]), from: new Vector3(1, 0, 0), to: new Vector3(0, 0, 1) };
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
      } else if (k.type === 'lift') {
        const top = new Vector3((f.bounds.min[0] + f.bounds.max[0]) / 2, (f.bounds.min[1] + f.bounds.max[1]) / 2, f.bounds.max[2]);
        const px = this.pixelSize(top);
        h.object.position.copy(top).add(new Vector3(0, 0, 30 * px));
        h.object.scale.setScalar(h.pixels * px * (h === this.hovered ? 1.2 : 1) * this.gripScale);
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
      const hot = h === this.hovered;
      (h.object as Sprite).material = hot ? this.grips.dotHot : this.grips.dot;
      h.object.position.copy(p);
      h.object.scale.setScalar(h.pixels * this.pixelSize(p) * (hot ? 1.3 : 1) * this.gripScale);
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

  private pickNode(): { item: ViewItem; point: Vector3; normal: Vector3 } | null {
    const meshes: Mesh[] = [];
    for (const d of this.drawn.values()) if (d.mesh.visible && !d.item.ghost) meshes.push(d.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const d = this.drawn.get(hit.object.userData.id as string);
    if (!d) return null;
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new Vector3(0, 0, 1);
    return { item: d.item, point: hit.point, normal };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // A camera button must not take the focus off a typing box: a pan keeps the boxes.
    if (event.button !== 0 && this.prompt) event.preventDefault();
    if (this.drag) {
      // A second finger during a drag is neither ours nor the camera's.
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
    // In align mode a click on a selected object makes it the anchor instead of starting a drag.
    if (this.options.align && hit?.item.selected && !additive) {
      this.events.onAnchor(hit.item.node.id);
      claim();
      return;
    }
    if (!hit) {
      // Empty space: a mouse draws a marquee; a finger turns the camera (OrbitControls takes it from here).
      if (event.pointerType !== 'touch') this.drag = { mode: 'pending-marquee', x: event.clientX, y: event.clientY, additive };
      return;
    }
    claim();
    const { node } = hit.item;
    if (additive) {
      this.events.onSelect([node.id], 'toggle');
      return;
    }
    // Dragging something that is not selected yet selects it and moves it alone.
    const selected = hit.item.selected ? this.items.filter((i) => i.selected).map((i) => i.node) : [node];
    if (!hit.item.selected) this.events.onSelect([node.id], 'replace');
    const movable = selected.filter((n) => !n.locked);
    this.drag = {
      mode: 'pending-move',
      x: event.clientX,
      y: event.clientY,
      nodes: movable,
      plane: new Plane(new Vector3(0, 0, 1), -hit.point.z),
      origin: hit.point.clone(),
    };
  };

  private startHandleDrag(handle: Handle, event: PointerEvent): void {
    const f = this.frame!;
    const k = handle.kind;
    const nodes = this.items.filter((i) => i.selected && !i.ghost && !i.node.locked).map((i) => i.node);
    if (nodes.length === 0) return;
    if (k.type === 'resize' && f.single) {
      // A corner grip seen with the base edge-on cannot follow both axes: it follows the one seen best.
      const axisOnly = k.sx !== 0 && k.sy !== 0 && this.baseEdgeOn(f.single) ? this.bestBaseAxis(f.single) : undefined;
      const grab = this.resizePoint(f.single, k.sx, k.sy, axisOnly);
      const handleLocal = new Vector3(k.sx * f.half[0], k.sy * f.half[1], 0);
      this.drag = grab ? { mode: 'resize', node: f.single, sx: k.sx, sy: k.sy, grab: grab.sub(handleLocal), axisOnly } : { mode: 'held' };
    } else if (k.type === 'height' && f.single) {
      // Measured from the end that stays put: the base for the top grip, the top for the bottom one.
      const t = this.alongAxis(this.framePoint([0, 0, -k.side * f.half[2]]), this.frameAxis(f.single, 2));
      this.drag = t === null ? { mode: 'held' } : { mode: 'height', node: f.single, side: k.side, grab: t - k.side * f.single.size[2] };
    } else if (k.type === 'lift') {
      const origin = handle.object.position.clone();
      const t = this.alongAxis(origin, new Vector3(0, 0, 1));
      this.drag = t === null ? { mode: 'held' } : { mode: 'lift', nodes, origin, grab: t };
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
        if (!f.single) return null;
        // Right beside the height grip, so that it stays to hand on a big object seen close up; level with
        // the grip, it covers neither the grip nor the lift arrow above it.
        made = { kind: k, unit: 'mm', center, fields: [{ tag: 'H', value: f.single.size[2], anchor: handle.object.getWorldPosition(new Vector3()).toArray() as Vec3, beside: true, clientX: 0, clientY: 0 }] };
        break;
      case 'resize': {
        if (!f.single) return null;
        const fields: Field[] = [];
        if (k.sx !== 0) {
          // Width goes on a bottom edge running along X: at the grip's side, else the side facing the camera.
          const side = k.sy !== 0 ? k.sy : this.nearest([{ at: [0, -hy, -hz] as Vec3, s: -1 }, { at: [0, hy, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge('W', f.single.size[0], [0, side * hy, -hz], [1, 0, 0], [0, 0, -hz]));
        }
        if (k.sy !== 0) {
          const side = k.sx !== 0 ? k.sx : this.nearest([{ at: [-hx, 0, -hz] as Vec3, s: -1 }, { at: [hx, 0, -hz] as Vec3, s: 1 }]).s;
          fields.push(edge('D', f.single.size[1], [side * hx, 0, -hz], [0, 1, 0], [0, 0, -hz]));
        }
        made = { kind: k, unit: 'mm', center, fields };
        break;
      }
      case 'lift':
        made = { kind: k, unit: 'mm', center, fields: [{ tag: 'Z', value: f.bounds.min[2], anchor: handle.object.position.toArray() as Vec3, out: [0, 0, 1], pad: PROMPT_LIFT_PAD, clientX: 0, clientY: 0 }] };
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
    if (kind.type === 'height' && f.single) {
      if (v >= MIN_SIZE) changed = [this.resized(f.single, [f.single.size[0], f.single.size[1], v], [0, 0, -kind.side])];
    } else if (kind.type === 'resize' && f.single) {
      const size: Vec3 = [...f.single.size];
      const w = values[0];
      const d = values.length > 1 ? values[1] : values[0];
      if (kind.sx !== 0 && w >= MIN_SIZE) size[0] = w;
      if (kind.sy !== 0 && d >= MIN_SIZE) size[1] = d;
      changed = [this.resized(f.single, size, [-kind.sx as -1 | 0 | 1, -kind.sy as -1 | 0 | 1, 0])];
    } else if (kind.type === 'lift') {
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

  private frameAxis(node: SceneNode, axis: 0 | 1 | 2): Vector3 {
    const m = rotation(node.rot);
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

  /** True when the node's base plane is seen so nearly edge-on that a pointer cannot be placed on it. */
  private baseEdgeOn(node: SceneNode): boolean {
    const m = frameMatrix(node);
    return Math.abs(this.raycaster.ray.direction.dot(new Vector3(m[6], m[7], m[8]))) < 0.06;
  }

  /** Of the node's two base axes, the one squarer to the view, which the pointer can follow. */
  private bestBaseAxis(node: SceneNode): 0 | 1 {
    const m = frameMatrix(node);
    const d = this.raycaster.ray.direction;
    return Math.abs(d.dot(new Vector3(m[0], m[1], m[2]))) <= Math.abs(d.dot(new Vector3(m[3], m[4], m[5]))) ? 0 : 1;
  }

  /**
   * Pointer position on the plane of the node's base, in the node's own (unscaled) frame, relative to
   * its center. With `axisOnly`, or for an edge grip, the pointer is followed along one axis only and
   * the other is held at the grip, which works from any viewing angle.
   */
  private resizePoint(node: SceneNode, sx: number, sy: number, axisOnly?: 0 | 1): Vector3 | null {
    const m = frameMatrix(node);
    const x = new Vector3(m[0], m[1], m[2]);
    const y = new Vector3(m[3], m[4], m[5]);
    const z = new Vector3(m[6], m[7], m[8]);
    const center = new Vector3(m[9], m[10], m[11]);
    const base = center.clone().addScaledVector(z, -node.size[2] / 2);
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
    return single === 0 ? new Vector3(t, (sy * node.size[1]) / 2, 0) : new Vector3((sx * node.size[0]) / 2, t, 0);
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
      if (event.buttons === 0 && this.options.interactive) this.hover(this.pickHandle(event));
      return;
    }
    if (this.press && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= dragThreshold(event)) this.press = null;

    switch (drag.mode) {
      case 'held':
        return;
      case 'pending-move': {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event) || drag.nodes.length === 0) return;
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
      case 'lift':
        this.liftTo(drag, event);
        return;
      case 'rotate':
        this.rotateTo(drag, event);
        return;
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.otherPointer(event)) return;
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
        return;
      case 'pending-marquee':
        // A plain click on nothing clears the selection.
        if (!drag.additive) this.events.onSelect([], 'replace');
        return;
      case 'marquee':
        this.events.onSelect(this.insideMarquee(drag.x, drag.y, event.clientX, event.clientY), drag.additive ? 'add' : 'replace');
        this.hideMarquee();
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
  };

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
    this.events.onReadout(`${fmt(dx)}, ${fmt(dy)}`, event.clientX, event.clientY);
  }

  private liftTo(drag: Extract<Drag, { mode: 'lift' }>, event: PointerEvent): void {
    const t = this.alongAxis(drag.origin, new Vector3(0, 0, 1));
    if (t === null) return;
    const dz = this.snap(t - drag.grab);
    this.events.onGestureChange(drag.nodes.map((n) => ({ ...n, pos: tidyVec([n.pos[0], n.pos[1], n.pos[2] + dz]) })));
    this.events.onReadout(`Z ${dz >= 0 ? '+' : ''}${fmt(dz)}`, event.clientX, event.clientY);
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

  private resizeTo(drag: Extract<Drag, { mode: 'resize' }>, event: PointerEvent): void {
    const { node, sx, sy } = drag;
    const p = this.resizePoint(node, sx, sy, drag.axisOnly);
    if (!p) return;
    p.sub(drag.grab);
    const size: Vec3 = [...node.size];
    if (sx !== 0) size[0] = Math.max(MIN_SIZE, this.snap(sx * p.x + node.size[0] / 2));
    if (sy !== 0) size[1] = Math.max(MIN_SIZE, this.snap(sy * p.y + node.size[1] / 2));
    if (event.shiftKey) {
      // Shift scales the whole thing evenly, following the axis that moved most.
      const fx = size[0] / node.size[0];
      const fy = size[1] / node.size[1];
      const f = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
      size[0] = node.size[0] * f;
      size[1] = node.size[1] * f;
      size[2] = node.size[2] * f;
    }
    // The side opposite the grip stays where it is; so does the base.
    this.events.onGestureChange([this.resized(node, size, [-sx as -1 | 0 | 1, -sy as -1 | 0 | 1, event.shiftKey ? -1 : 0])]);
    this.events.onReadout(event.shiftKey ? size.map(fmt).join(' × ') : `${fmt(size[0])} × ${fmt(size[1])}`, event.clientX, event.clientY);
  }

  private heightTo(drag: Extract<Drag, { mode: 'height' }>, event: PointerEvent): void {
    const { node, side } = drag;
    const m = frameMatrix(node);
    const z = new Vector3(m[6], m[7], m[8]);
    const fixed = new Vector3(m[9], m[10], m[11]).addScaledVector(z, (-side * node.size[2]) / 2);
    const t = this.alongAxis(fixed, z);
    if (t === null) return;
    const h = Math.max(MIN_SIZE, this.snap(side * (t - drag.grab)));
    const f = h / node.size[2];
    const size: Vec3 = event.shiftKey ? [node.size[0] * f, node.size[1] * f, h] : [node.size[0], node.size[1], h];
    this.events.onGestureChange([this.resized(node, size, [0, 0, -side])]);
    this.events.onReadout(event.shiftKey ? size.map(fmt).join(' × ') : fmt(h), event.clientX, event.clientY);
  }

  private rotateTo(drag: Extract<Drag, { mode: 'rotate' }>, event: PointerEvent): void {
    const angle = this.angleAbout(drag.axis, drag.pivot);
    // Seen side-on, the ring cannot be followed; fall back to sideways pointer travel.
    let delta = angle !== null && drag.start !== null ? angle - drag.start : (event.clientX - drag.x) * 0.6;
    delta = ((((delta + 180) % 360) + 360) % 360) - 180;
    const step = event.shiftKey ? ROTATE_COARSE : event.altKey || event.ctrlKey ? 1 : ROTATE_STEP;
    delta = Math.round(delta / step) * step;
    this.events.onGestureChange(delta === 0 ? drag.nodes : rotateNodes(drag.nodes, drag.axis, delta, drag.pivot));
    this.events.onReadout(`${fmt(delta)}°`, event.clientX, event.clientY);
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

    renderer.autoClear = false;
    if (this.frame || this.pointer3d.visible) {
      this.layoutHandles();
      renderer.clearDepth();
      renderer.render(this.overlay, camera);
    }

    // Axes triad in the bottom-left corner, sharing the main camera's orientation.
    this.triadCamera.quaternion.copy(camera.quaternion);
    this.triadCamera.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(5);
    renderer.clearDepth();
    renderer.setViewport(GIZMO_MARGIN, GIZMO_MARGIN, GIZMO_SIZE, GIZMO_SIZE);
    renderer.render(this.triadScene, this.triadCamera);
    renderer.autoClear = true;
    renderer.setViewport(0, 0, width, height);
  }
}
