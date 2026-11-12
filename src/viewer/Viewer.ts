// Framework-agnostic three.js editor view. Model space is millimeters, Z up,
// with the build plate at z=0. The viewer draws the scene it is given and
// turns pointer input into edits (select, move, lift, resize, turn), which it
// reports through callbacks; it never owns the design.
//
// This file holds the view itself: setting it up and tearing it down, the
// draw, and the public API. The parts live beside it: what is drawn of the
// design (sceneSync), the handles round the selection (handles), the boxes to
// type a value in (prompt), pointer input (pointerInput, with gesture and
// dragMath), measure mode (measureOverlay), Robot mode (robotOverlay) and the
// camera (camera). Each is handed the stage, the few things they all share.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  NeutralToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { CanvasTexture, Object3D, WebGLRenderTarget } from 'three';
import { tr } from '../i18n';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Mat } from '../model/math';
import type { Asset, Vec3 } from '../model/types';
import { CameraRig, VIEW_DIRECTIONS } from './camera';
import { disposeGround, gridLines, groundMesh, plateGrid } from './ground';
import { DONE_DOT, Handles } from './handles';
import type { HandleParts } from './handles';
import { MARKER_ARROW, moveArrow } from './markers';
import { MeasureOverlay } from './measureOverlay';
import { PointerInput } from './pointerInput';
import { HandlePrompts } from './prompt';
import { RobotOverlay } from './robotOverlay';
import type { RobotParts } from './robotOverlay';
import { EMPTY_RADIUS, SceneSync, extent } from './sceneSync';
import type { Drawn } from './sceneSync';
import { AXIS_COLORS, FOV, THEMES, toMatrix4 } from './stage';
import type { Grips, Stage } from './stage';
import { LOCK_COLOR, dotTexture, gripTexture, labelTexture, lockTexture } from './textures';
import type { HandleKind, ViewItem, ViewPreset, ViewerEvents, ViewerOptions } from './types';

export type { AlignMode, HandleKind, HandlePrompt, Marker, SnapPoint, ViewItem, ViewPreset, ViewerEvents, ViewerOptions } from './types';

const DEFAULTS: ViewerOptions = { theme: 'dark', edges: true, grid: true, units: 'mm', snap: 1, align: null, highlight: null, snaps: null, marker: null, markers: null, ground: null, preview: null, measure: null, objectAxes: false, frozen: false };
export const GIZMO_SIZE = 92;
const GIZMO_MARGIN = 8;
const PLATE_HALF = 100;
/** The fill of a grip whose value is being typed: the accent, on either theme. */
const TYPING_GRIP = '#17cdd3';

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
  private environment: WebGLRenderTarget | null = null;

  private items: ViewItem[] = [];
  private assets: Record<string, Asset> = {};
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
  /** A box drawn round a part pointed out from elsewhere (see `highlight`). */
  private pointer3d!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private grips!: Grips;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private placing = false;
  private fallback: HTMLElement | null = null;

  /** What the parts share (see stage.ts), and the parts themselves; all made in `init`. */
  private stage!: Stage;
  private objects!: SceneSync;
  private handles!: Handles;
  private prompts!: HandlePrompts;
  private measure!: MeasureOverlay;
  private robot!: RobotOverlay;
  private rig!: CameraRig;
  private input!: PointerInput;

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
    this.rig.applyPose(this.rig.poseFor(VIEW_DIRECTIONS.iso));
    this.requestRender();
  }

  /** The scene to draw, and the images its pictures are made of. Cheap to call often: only what changed is touched. */
  setItems(items: ViewItem[], assets: Record<string, Asset> = this.assets): void {
    this.items = items;
    this.assets = assets;
    if (!this.ok || this.disposed) return;
    this.sync();
    this.handles.syncLockBadges();
    // The centre dots and a picked face sit on the objects as placed.
    if (this.options.measure) this.measure.sync();
    this.requestRender();
  }

  setOptions(options: Partial<ViewerOptions>): void {
    // Only what changed is gone over: a marker dragged or a part pointed out calls this on every pointer move.
    const changed = new Set((Object.keys(options) as (keyof ViewerOptions)[]).filter((k) => options[k] !== this.options[k]));
    if (changed.size === 0) return;
    // Boxes typed against one frame mean nothing in the other.
    if (changed.has('objectAxes')) this.dismissPrompt();
    this.options = { ...this.options, ...options };
    if (!this.ok || this.disposed) return;
    this.applyOptions(changed);
    // The selection's box and handles follow these two, and nothing else here does.
    if (changed.has('align') || changed.has('objectAxes')) {
      this.handles.updateFrame();
      this.handles.syncLockBadges();
    }
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
    this.rig.animateTo(this.rig.poseFor(VIEW_DIRECTIONS[preset]));
  }

  /** Carries the view along by `delta` (mm), as a camera following a driving robot: the view keeps its angle and distance. */
  follow(delta: Vec3): void {
    if (!this.ok || this.disposed || this.rig.animating) return;
    const d = new Vector3(...delta);
    this.controls.target.add(d);
    this.camera.position.add(d);
    this.controls.update();
    this.requestRender();
  }

  /** Frame the selection, or everything when nothing is selected. */
  fit(immediate = false): void {
    if (!this.ok || this.disposed) return;
    const picked = this.items.filter((i) => i.selected && !i.ghost);
    const { center, radius } = extent(picked.length ? picked : this.items.filter((i) => !i.ghost && !i.node.hidden), (node) => this.events.boundsOf(node));
    const pose = this.rig.currentPose();
    pose.distance = this.rig.fitDistance(radius);
    pose.target.copy(center);
    if (immediate) {
      this.rig.halt();
      this.rig.applyPose(pose);
      this.requestRender();
    } else {
      this.rig.animateTo(pose);
    }
  }

  /** Abandon the drag in progress, if any. Returns whether there was one. */
  cancelGesture(): boolean {
    return this.ok ? this.input.cancel() : false;
  }

  /** Take the typing boxes away (the boxes call this too when they close themselves). */
  dismissPrompt(): void {
    if (this.ok) this.prompts.dismiss();
  }

  /** Apply a typed value as if the handle had been dragged there (one undo step). */
  applyTyped(kind: HandleKind, values: number[]): void {
    if (this.ok) this.input.applyTyped(kind, values);
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
    const saved = this.rig.currentPose();
    const { center, radius } = extent(visible, (node) => this.events.boundsOf(node));
    const pose = { ...(wanted ? this.rig.poseFor(VIEW_DIRECTIONS.iso) : saved), target: center, distance: this.rig.fitDistance(radius, width / height) };
    const selected = [...this.objects.drawn.values()].filter((d) => d.item.selected);
    const others = wanted ? [...this.objects.drawn.values()].filter((d) => d.mesh.visible && !wanted.has(d.item.node.id)) : [];
    const grid = this.gridMajor.visible;
    const shown = (d: Drawn, on: boolean) => {
      d.mesh.visible = on;
      if (d.edges) d.edges.visible = on;
    };
    try {
      for (const d of selected) this.objects.style(d, false);
      for (const d of others) shown(d, false);
      if (wanted) this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = false;
      this.rig.applyPose(pose);
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
      for (const d of selected) this.objects.style(d, true);
      for (const d of others) shown(d, true);
      this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = grid;
      this.rig.applyPose(saved);
      this.draw();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fallback?.remove();
    if (!this.ok) return;
    this.input.removeOverlays();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.input.endHold();
    if (this.ground) {
      disposeGround(this.ground);
    }
    this.depthMaterial.dispose();
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.input.unlisten();
    this.controls.removeEventListener('change', this.requestRender);
    this.controls.removeEventListener('change', this.onCameraChange);
    this.controls.dispose();

    this.objects.dispose();
    this.robot.dispose();
    for (const grid of [this.gridMajor, this.gridMinor, this.axes, this.handles.parts.outline, this.pointer3d, this.handles.parts.alignLines, this.robot.parts.snapAxis]) {
      grid.geometry.dispose();
      grid.material.dispose();
    }
    this.measure.dispose();
    this.handles.clear();
    for (const d of this.disposables) d.dispose();
    this.environment?.dispose();
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
    // A picture, as far as a screen reader can tell; without a name it is announced as nothing at all.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', tr('3D view of the design'));
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    const scene = new Scene();
    this.scene = scene;
    this.buildEnvironment();
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
    const made = this.initOverlay();

    const controls = new OrbitControls(camera, canvas);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.9;
    // The left button edits; the camera is on the other two (as in Tinkercad).
    controls.mouseButtons = { LEFT: -1 as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    controls.addEventListener('change', this.requestRender);
    controls.addEventListener('change', this.onCameraChange);

    // The parts, each handed the stage: the viewer's own values are read through it as they stand.
    const viewer = this;
    this.stage = {
      container: this.container,
      renderer,
      scene,
      overlay: this.overlay,
      camera,
      controls,
      raycaster: this.raycaster,
      pointer: this.pointer,
      events: this.events,
      grips: this.grips,
      get options() {
        return viewer.options;
      },
      get items() {
        return viewer.items;
      },
      get assets() {
        return viewer.assets;
      },
      get height() {
        return viewer.height;
      },
      get placing() {
        return viewer.placing;
      },
      gripScale: 1,
      requestRender: this.requestRender,
    };
    this.objects = new SceneSync(this.stage, () => {
      if (!this.ok || this.disposed) return;
      this.sync();
      this.requestRender();
    });
    this.handles = new Handles(this.stage, made.handles, () => this.prompts.current?.handle);
    this.prompts = new HandlePrompts(this.stage, this.handles);
    this.measure = new MeasureOverlay(this.stage, this.objects, made.measureGroup);
    this.robot = new RobotOverlay(this.stage, made.robot);
    this.rig = new CameraRig(this.stage, {
      center: this.center,
      get radius() {
        return viewer.radius;
      },
      get aspect() {
        return viewer.width && viewer.height ? viewer.width / viewer.height : 1;
      },
    });
    this.input = new PointerInput(this.stage, { objects: this.objects, handles: this.handles, prompts: this.prompts, measure: this.measure, robot: this.robot, rig: this.rig });
    this.input.listen();

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

  /** Makes the overlay scene and the things always in it; those the parts draw with are handed back for them. */
  private initOverlay(): { measureGroup: Group; handles: HandleParts; robot: RobotParts } {
    this.overlay = new Scene();
    const measureGroup = new Group();
    this.overlay.add(measureGroup);
    // Unit cube edges; scaled to the selection's box.
    const c = 0.5;
    const corners = [-c, -c, -c, c, -c, -c, c, c, -c, -c, c, -c, -c, -c, c, c, -c, c, c, c, c, -c, c, c];
    const pairs = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const pts: number[] = [];
    for (const i of pairs) pts.push(corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]);
    const box = new BufferGeometry();
    box.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    const outline = new LineSegments(box, new LineBasicMaterial({ transparent: true, opacity: 0.7, depthTest: false }));
    outline.matrixAutoUpdate = false;
    outline.visible = false;
    this.overlay.add(outline);
    // The same box again, for pointing at a part of a group from the structure graph.
    this.pointer3d = new LineSegments(box, new LineBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, linewidth: 2 }));
    this.pointer3d.matrixAutoUpdate = false;
    this.pointer3d.visible = false;
    this.overlay.add(this.pointer3d);
    const marker = new Group();
    marker.matrixAutoUpdate = false;
    marker.visible = false;
    this.overlay.add(marker);

    const grip = (map: CanvasTexture) => {
      const material = new SpriteMaterial({ map, depthTest: false, toneMapped: false });
      this.disposables.push(map, material);
      return material;
    };
    this.grips = {
      corner: grip(gripTexture('#ffffff', '#14171c')),
      edge: grip(gripTexture('#14171c', '#ffffff')),
      typing: grip(gripTexture(TYPING_GRIP, '#ffffff')),
      dot: grip(dotTexture('#14171c')),
      dotHot: grip(dotTexture(LOCK_COLOR)),
      lock: grip(lockTexture()),
      axisDot: AXIS_COLORS.map((color) => ({ idle: grip(dotTexture(color)), hot: grip(dotTexture('#ffffff', color)) })),
      dotDone: grip(dotTexture(DONE_DOT.fill, DONE_DOT.rim)),
    };
    this.grips.dotDone.opacity = DONE_DOT.opacity;
    const markerArrows = new Group();
    markerArrows.matrixAutoUpdate = false;
    markerArrows.visible = false;
    this.overlay.add(markerArrows);
    for (const axis of [0, 1, 2] as const) {
      const arrow = moveArrow(axis, MARKER_ARROW);
      arrow.traverse((o) => {
        const material = (o as Mesh).material as MeshBasicMaterial | undefined;
        if (material) this.disposables.push(material);
      });
      markerArrows.add(arrow);
    }
    // One line per axis through its three dots, in the axis's color.
    const lines = new BufferGeometry();
    lines.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    const lineTint = AXIS_COLORS.flatMap((color) => {
      const c = new Color(color).toArray();
      return [...c, ...c];
    });
    lines.setAttribute('color', new BufferAttribute(new Float32Array(lineTint), 3));
    const alignLines = new LineSegments(lines, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthTest: false }));
    alignLines.visible = false;
    this.overlay.add(alignLines);
    const axisLine = new BufferGeometry();
    axisLine.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    const snapAxis = new LineSegments(axisLine, new LineBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }));
    snapAxis.visible = false;
    this.overlay.add(snapAxis);
    // Quarter ring with an arrowhead at each end, in the XY plane from +X to +Y.
    const arcParts = {
      arc: new TorusGeometry(1, 0.07, 8, 20, Math.PI / 2),
      head: new ConeGeometry(0.2, 0.46, 12),
      hit: new TorusGeometry(1, 0.32, 6, 12, Math.PI / 2),
    };
    this.disposables.push(arcParts.arc, arcParts.head, arcParts.hit);
    return { measureGroup, handles: { outline, alignLines, arcParts }, robot: { marker, markerArrows, snapAxis } };
  }

  private showFallback(): void {
    const el = document.createElement('div');
    el.textContent = tr('3D view unavailable: WebGL could not be initialized.');
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

  /** Brings the scene in line with the options: all of them, or those named. */
  private applyOptions(changed?: ReadonlySet<keyof ViewerOptions>): void {
    const touched = (...keys: (keyof ViewerOptions)[]) => !changed || keys.some((k) => changed.has(k));
    const { theme, grid } = this.options;
    const t = THEMES[theme];
    this.gridMajor.material.color.set(t.grid);
    this.gridMajor.material.opacity = t.major;
    this.gridMinor.material.color.set(t.grid);
    this.gridMinor.material.opacity = t.minor;
    this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = grid;
    this.handles.parts.outline.material.color.set(t.accent);
    this.robot.parts.snapAxis.material.color.set(t.accent);
    // The grid's lines fall on the unit; at the start the grid is laid once everything else is in place.
    if (changed?.has('units')) this.updateGrid();
    if (touched('snaps')) this.robot.syncSnaps();
    if (touched('measure', 'theme')) this.measure.sync();
    this.pointer3d.material.color.set(theme === 'dark' ? 0xffffff : 0x1b1f27);
    const h = this.options.highlight;
    if (h) {
      const m = [...h.matrix] as Mat;
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 3 + r] *= Math.max(h.size[c], 1e-6);
      toMatrix4(m, this.pointer3d.matrix);
      this.pointer3d.matrixWorldNeedsUpdate = true;
    }
    this.pointer3d.visible = Boolean(h);
    this.robot.syncMarkers();
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
    // Colors and edge lines are the only things about an object's look the options decide.
    if (touched('theme', 'edges')) for (const d of this.objects.drawn.values()) this.objects.style(d, d.item.selected);
  }

  private sync(): void {
    this.objects.update();
    // A feature index goes with the object, or the geometry, it was made from.
    this.measure.prune();
    this.objects.release();

    const all = extent(
      this.items.filter((i) => !i.ghost && !i.node.hidden),
      (node) => this.events.boundsOf(node),
    );
    this.center.copy(all.center);
    this.radius = all.radius;
    this.reach = all.reach;
    this.updateGrid();
    this.controls.minDistance = 1;
    this.controls.maxDistance = Math.max(this.radius, PLATE_HALF) * 40;
    this.handles.updateFrame();
  }

  /** Build-plate grid centered on the origin: 200 mm square (10 in, in inches), growing with the design. */
  private updateGrid(): void {
    const { half, major, minor } = plateGrid(Math.max(this.reach * 1.2, PLATE_HALF), this.options.units);
    if (half === this.gridHalf && major === this.gridStep) return;
    this.gridHalf = half;
    this.gridStep = major;
    this.gridMajor.geometry.dispose();
    this.gridMinor.geometry.dispose();
    this.gridMajor.geometry = gridLines(half, major, 0);
    this.gridMinor.geometry = gridLines(half, minor, major);
    this.axes.scale.set(half, half, 1);
  }

  // --- rendering ---------------------------------------------------------

  private readonly onCameraChange = (): void => this.prompts.follow();

  private readonly requestRender = (): void => {
    if (!this.ok || this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frameTick);
  };

  private readonly frameTick = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.rig.step();
    // A view animation moves the camera without the controls noticing, so the boxes are told here.
    if (this.rig.animating) this.prompts.follow();
    // With damping, update() keeps emitting 'change' (and so re-requesting frames) until the motion settles.
    this.controls.update();
    this.draw();
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
  };

  /**
   * The graphics context came back (the app was in the background, say). The renderer sends meshes
   * and pictures again from memory, but the room the parts reflect was drawn on the GPU and went
   * with the old context: without it every part is flat and dark.
   */
  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    // Nothing of the old one is left to free: it is let go as it is.
    this.environment = null;
    this.buildEnvironment();
    this.requestRender();
  };

  /** The room the parts reflect, drawn and blurred on the GPU. */
  private buildEnvironment(): void {
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.environment?.dispose();
    this.environment = environment;
    this.scene.environment = environment.texture;
  }

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
    if (this.handles.frame || this.pointer3d.visible || this.robot.shown || this.handles.lockBadges.size || this.options.measure) {
      this.handles.layout();
      this.handles.layoutLockBadges(this.input.editing);
      this.robot.layoutSnaps();
      this.measure.layout();
      this.robot.layoutMarker();
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
