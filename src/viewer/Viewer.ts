// Framework-agnostic three.js editor view. Model space is millimetres, Z up,
// with the build plate at z=0. The viewer draws the scene it is given and
// turns pointer input into edits (select, move, lift, resize, turn), which it
// reports through callbacks; it never owns the design.
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
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
  Raycaster,
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
import { boundsCenter, builtSize, flipSigns, frameMatrix, isEmptyBounds, rotation, tidy, tidyVec, unionBounds } from '../model/math';
import type { Bounds, Mat } from '../model/math';
import { HOLE_COLOR, rotateNodes } from '../model/ops';
import type { SceneNode, Vec3 } from '../model/types';
import type { BuildResult } from '../worker/protocol';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export interface ViewerOptions {
  theme: 'dark' | 'light';
  edges: boolean;
  grid: boolean;
  /** Grid step that drags snap to, in mm; 0 = free. */
  snap: number;
  /** False while an old version is shown: look, don't touch. */
  interactive: boolean;
}

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
  onGestureEnd(cancelled: boolean): void;
  /** While placing a new shape: where it would land (null when the pointer leaves). */
  onPlaceMove(point: Vec3 | null): void;
  onPlaceCommit(): void;
  /** Live measurement to show next to the pointer during a drag. */
  onReadout(text: string | null, clientX: number, clientY: number): void;
  /** Tight bounds of a node (the viewer only knows its box). */
  boundsOf(node: SceneNode): Bounds;
}

const DEFAULTS: ViewerOptions = { theme: 'dark', edges: true, grid: true, snap: 1, interactive: true };

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
}

interface SharedGeometry {
  geometry: BufferGeometry;
  edges: BufferGeometry | null;
}

type HandleKind =
  | { type: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  | { type: 'height' }
  | { type: 'lift' }
  | { type: 'rotate'; axis: 0 | 1 | 2 };

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
  | { mode: 'resize'; node: SceneNode; sx: number; sy: number; grab: Vector3 }
  | { mode: 'height'; node: SceneNode; grab: number }
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
  private drawn = new Map<string, Drawn>();
  private shared = new Map<BuildResult, SharedGeometry>();
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
  private handles: Handle[] = [];
  private handleMode: 'none' | 'single' | 'several' | 'locked' = 'none';
  private hovered: Handle | null = null;
  private grips!: { corner: SpriteMaterial; edge: SpriteMaterial; lift: SpriteMaterial };
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

  /** The scene to draw. Cheap to call often: only what changed is touched. */
  setItems(items: ViewItem[]): void {
    this.items = items;
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
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.removeEventListener('change', this.requestRender);
    this.controls.dispose();

    for (const d of this.drawn.values()) this.discard(d);
    this.drawn.clear();
    this.empty.dispose();
    for (const s of this.shared.values()) {
      s.geometry.dispose();
      s.edges?.dispose();
    }
    this.shared.clear();
    for (const grid of [this.gridMajor, this.gridMinor, this.axes, this.outline]) {
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
    // The X and Y axes drawn on the plate, in the colours of the corner triad.
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

    canvas.addEventListener('pointerdown', this.onPointerDown);
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

    const shaft = new CylinderGeometry(0.045, 0.045, 1, 10); // along +Y, centred
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

    const grip = (map: CanvasTexture) => {
      const material = new SpriteMaterial({ map, depthTest: false, toneMapped: false });
      this.disposables.push(map, material);
      return material;
    };
    this.grips = {
      corner: grip(gripTexture('#ffffff', '#14171c')),
      edge: grip(gripTexture('#14171c', '#ffffff')),
      lift: grip(liftTexture()),
    };
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
    el.textContent = '3D view unavailable: WebGL could not be initialised.';
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
        d = { item, mesh, edges: null, shown: null, built: [1, 1, 1] };
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
      const same =
        !fresh &&
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

  /** Colours, transparency and edge lines of one node. */
  private style(d: Drawn, selected: boolean): void {
    const { node, ghost } = d.item;
    const t = THEMES[this.options.theme];
    const material = d.mesh.material;
    const color = node.hole ? HOLE_COLOR : node.color;
    material.color.set(color);
    const faint = node.hole || ghost;
    if (material.transparent !== Boolean(faint)) {
      material.transparent = Boolean(faint);
      material.needsUpdate = true;
    }
    material.opacity = ghost ? 0.6 : node.hole ? 0.38 : 1;
    material.depthWrite = !faint;
    // Selected parts glow a little in their own colour; the accent is kept for edges and handles.
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
      // A darkened shade of the part colour reads on any colour and theme.
      d.edges.material.color.copy(new Color(color)).multiplyScalar(0.22);
      d.edges.material.opacity = node.hole ? 0.5 : t.edge;
    }
  }

  private discard(d: Drawn): void {
    this.scene.remove(d.mesh);
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

  /** Build-plate grid centred on the origin: 200 mm square, growing with the design. */
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
    // A millimetre grid on a big plate is more lines than it is help.
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
    this.hovered = null;
    this.handleMode = 'none';
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
    const bounds = unionBounds(picked.map((i) => this.events.boundsOf(i.node)));
    const single = picked.length === 1 ? picked[0].node : null;
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
    const mode = picked.every((i) => i.node.locked) ? 'locked' : single ? 'single' : 'several';
    if (mode !== this.handleMode) this.buildHandles(mode);

    const f = this.frame;
    const m = [...f.matrix] as Mat;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(f.half[c] * 2, 1e-6);
    toMatrix4(m, this.outline.matrix);
    this.outline.matrixWorldNeedsUpdate = true;
    this.outline.visible = true;
  }

  private buildHandles(mode: 'single' | 'several' | 'locked'): void {
    this.clearHandles();
    this.handleMode = mode;
    if (mode === 'locked') return;
    const single = mode === 'single';
    const add = (kind: HandleKind, object: Object3D, pixels: number, cursor: string) => {
      object.renderOrder = 10;
      this.overlay.add(object);
      this.handles.push({ kind, object, pixels, cursor });
    };
    if (single) {
      for (const sx of [-1, 0, 1] as const) {
        for (const sy of [-1, 0, 1] as const) {
          if (sx === 0 && sy === 0) continue;
          const corner = sx !== 0 && sy !== 0;
          add({ type: 'resize', sx, sy }, new Sprite(corner ? this.grips.corner : this.grips.edge), corner ? 13 : 11, 'nwse-resize');
        }
      }
      add({ type: 'height' }, new Sprite(this.grips.corner), 13, 'ns-resize');
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
    for (const h of this.handles) {
      const k = h.kind;
      if (k.type === 'resize' || k.type === 'height') {
        const at = k.type === 'resize' ? this.framePoint([k.sx * hx, k.sy * hy, -hz]) : this.framePoint([0, 0, hz]);
        h.object.position.copy(at);
        h.object.scale.setScalar(h.pixels * this.pixelSize(at) * (h === this.hovered ? 1.35 : 1));
      } else if (k.type === 'lift') {
        const top = new Vector3((f.bounds.min[0] + f.bounds.max[0]) / 2, (f.bounds.min[1] + f.bounds.max[1]) / 2, f.bounds.max[2]);
        const px = this.pixelSize(top);
        h.object.position.copy(top).add(new Vector3(0, 0, 30 * px));
        h.object.scale.setScalar(h.pixels * px * (h === this.hovered ? 1.2 : 1));
      } else {
        const { at, from, to } = this.ringPlacement(k.axis);
        const s = h.pixels * this.pixelSize(at) * (h === this.hovered ? 1.15 : 1);
        const normal = from.clone().cross(to);
        h.object.matrix.makeBasis(from.multiplyScalar(s), to.multiplyScalar(s), normal.multiplyScalar(s)).setPosition(at);
        h.object.matrixWorldNeedsUpdate = true;
      }
    }
  }

  // --- pointer -------------------------------------------------------------

  private setRay(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickHandle(): Handle | null {
    if (!this.frame || this.handles.length === 0) return null;
    this.layoutHandles();
    this.overlay.updateMatrixWorld();
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
    if (event.button !== 0 || this.drag) return;
    this.animation = null;
    this.controls.enabled = true;
    const canvas = this.renderer.domElement;
    canvas.setPointerCapture(event.pointerId);
    this.setRay(event);

    if (this.placing) {
      this.drag = { mode: 'place' };
      return;
    }
    if (!this.options.interactive) return;

    const handle = this.pickHandle();
    if (handle && this.frame) {
      this.startHandleDrag(handle, event);
      return;
    }

    const hit = this.pickNode();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (!hit) {
      this.drag = { mode: 'pending-marquee', x: event.clientX, y: event.clientY, additive };
      return;
    }
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
      const grab = this.resizePoint(f.single, k.sx, k.sy);
      if (!grab) return;
      const handleLocal = new Vector3(k.sx * f.half[0], k.sy * f.half[1], 0);
      this.drag = { mode: 'resize', node: f.single, sx: k.sx, sy: k.sy, grab: grab.sub(handleLocal) };
    } else if (k.type === 'height' && f.single) {
      const t = this.alongAxis(this.framePoint([0, 0, -f.half[2]]), this.frameAxis(f.single, 2));
      if (t === null) return;
      this.drag = { mode: 'height', node: f.single, grab: t - f.single.size[2] };
    } else if (k.type === 'lift') {
      const origin = handle.object.position.clone();
      const t = this.alongAxis(origin, new Vector3(0, 0, 1));
      if (t === null) return;
      this.drag = { mode: 'lift', nodes, origin, grab: t };
    } else if (k.type === 'rotate') {
      const pivot: Vec3 = f.single ? [...f.single.pos] : boundsCenter(f.bounds);
      this.drag = { mode: 'rotate', nodes, axis: k.axis, pivot, start: this.angleAbout(k.axis, pivot), x: event.clientX };
    } else {
      return;
    }
    this.renderer.domElement.style.cursor = k.type === 'rotate' ? 'grabbing' : handle.cursor;
    this.events.onGestureStart();
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

  /** Pointer position on the plane of the node's base, in the node's own (unscaled) frame, relative to its centre. */
  private resizePoint(node: SceneNode, sx: number, sy: number): Vector3 | null {
    const m = frameMatrix(node);
    const x = new Vector3(m[0], m[1], m[2]);
    const y = new Vector3(m[3], m[4], m[5]);
    const z = new Vector3(m[6], m[7], m[8]);
    const centre = new Vector3(m[9], m[10], m[11]);
    const base = centre.clone().addScaledVector(z, -node.size[2] / 2);
    if (sx !== 0 && sy !== 0) {
      const plane = new Plane().setFromNormalAndCoplanarPoint(z, base);
      if (Math.abs(this.raycaster.ray.direction.dot(z)) < 0.06) return null;
      const p = this.raycaster.ray.intersectPlane(plane, new Vector3());
      if (!p) return null;
      p.sub(centre);
      return new Vector3(p.dot(x), p.dot(y), 0);
    }
    // Edge grips slide along one axis only, which works from any viewing angle.
    const axis = sx !== 0 ? x : y;
    const t = this.alongAxis(base, axis);
    if (t === null) return null;
    return sx !== 0 ? new Vector3(t, 0, 0) : new Vector3(0, t, 0);
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
    this.setRay(event);
    const drag = this.drag;

    if (this.placing) {
      this.events.onPlaceMove(this.landingPoint());
      return;
    }
    if (!drag) {
      if (event.buttons === 0 && this.options.interactive) this.hover(this.pickHandle());
      return;
    }

    switch (drag.mode) {
      case 'pending-move': {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD || drag.nodes.length === 0) return;
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
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return;
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
      default:
        this.events.onGestureEnd(event.type === 'pointercancel');
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.placing && !this.drag) this.events.onPlaceMove(null);
    this.hover(null);
  };

  private hover(handle: Handle | null): void {
    if (handle === this.hovered) return;
    this.hovered = handle;
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
    const p = this.resizePoint(node, sx, sy);
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
    const { node } = drag;
    const m = frameMatrix(node);
    const z = new Vector3(m[6], m[7], m[8]);
    const base = new Vector3(m[9], m[10], m[11]).addScaledVector(z, -node.size[2] / 2);
    const t = this.alongAxis(base, z);
    if (t === null) return;
    const h = Math.max(MIN_SIZE, this.snap(t - drag.grab));
    const f = h / node.size[2];
    const size: Vec3 = event.shiftKey ? [node.size[0] * f, node.size[1] * f, h] : [node.size[0], node.size[1], h];
    this.events.onGestureChange([this.resized(node, size, [0, 0, -1])]);
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

  private readonly requestRender = (): void => {
    if (!this.ok || this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frameTick);
  };

  private readonly frameTick = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.stepAnimation();
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
    if (this.frame) {
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
