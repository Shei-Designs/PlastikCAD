// What the viewer is given and what it reports: the options, the items to
// draw, the callbacks an edit goes out through, and the shapes of the things
// it points out (markers, snap points, the boxes to type a value in).
import type { Feature, FeatureIndex, FeatureKind } from '../geometry/features';
import type { MeshData } from '../geometry/mesh';
import type { Measurement } from '../geometry/measure';
import type { Bounds, Mat } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import type { World } from '../robot/types';
import type { Unit } from '../units';
import type { BuildResult } from '../worker/protocol';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export interface ViewerOptions {
  theme: 'dark' | 'light';
  edges: boolean;
  grid: boolean;
  /** The unit the readouts are in and the grid's lines fall on; everything else here is in millimeters. */
  units: Unit;
  /** Grid step that drags snap to, in mm; 0 = free. */
  snap: number;
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
  /**
   * What the robot's links collide as, drawn see-through over them: each as triangles in the design, moved by
   * `frame` (from where the link was designed to where the test drive has it) when there is one. Null to draw none.
   */
  collisions: { id: string; mesh: MeshData; frame: Mat | null }[] | null;
  /** Where the test drive's robot touches the floor, a dot drawn at each, mm. Null to draw none. */
  contacts: Vec3[] | null;
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
  /** The handles of one selected object follow its own axes instead of the design's. */
  objectAxes: boolean;
  /** A panel is laying the selection out (the Array panel): the view turns and zooms, but nothing in it is picked or moved. */
  frozen: boolean;
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
  /** A grip was clicked rather than dragged: show boxes to type its values (see `applyTyped`). `null` takes them away again. */
  onHandleClick(prompt: HandlePrompt | null): void;
  /** A snap point was clicked. */
  onSnapPick(index: number): void;
  /** Robot mode: the picked joint or sensor is dragged to `origin` (design mm); `onMarkerDrop` ends the drag. */
  onMarkerMove(origin: Vec3): void;
  onMarkerDrop(): void;
  /** Robot mode: one of the other joints or sensors drawn on the plate was clicked. */
  onMarkerPick(id: string): void;
  /** Measure mode: a feature clicked on the plate. */
  onMeasurePick(feature: Feature): void;
  /**
   * Measure mode: reads what the tool can take hold of on a large mesh, away from the pointer's
   * thread. The triangles (nine numbers each) are placed by `matrix`, sixteen numbers column by
   * column; the array is handed over and is empty afterwards. Without this the viewer reads every
   * mesh itself, on the spot.
   */
  featuresOf?(positions: Float32Array, matrix: number[]): Promise<FeatureIndex>;
  /** Two fingers tapped on the plate (`undo`) or three (`redo`). Returns whether there was a step to take. */
  onHistory(step: 'undo' | 'redo'): boolean;
}

export type HandleKind =
  | { type: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  /** Height grip at the top (side 1, base stays put) or at the bottom (side -1, top stays put). */
  | { type: 'height'; side: 1 | -1 }
  /** An arrow along one of the design's axes, from the middle of the selection, to move it along that axis alone. */
  | { type: 'move'; axis: 0 | 1 | 2 }
  | { type: 'rotate'; axis: 0 | 1 | 2 }
  | { type: 'align'; axis: 0 | 1 | 2; mode: AlignMode };

export interface HandlePrompt {
  kind: HandleKind;
  /** What the values are in: a length's are millimeters, whatever unit they are then shown and typed in. */
  unit: 'mm' | '°';
  /** The middle of the object, in the scene. */
  center: Vec3;
  /** One box per value, each sitting just outside the edge of the object it measures, with its place on screen. */
  fields: {
    tag: string;
    /** What the value is, in words, for the entry sheet. */
    name: string;
    /** The color of the design axis it runs along. */
    color: string;
    value: number;
    /**
     * What it measures, drawn while the box is on show: the two ends of the length, or (`axis`) the line
     * a turn goes about. `ends` is the same on screen, worked out with the box's place.
     */
    span?: { from: Vec3; to: Vec3; axis?: boolean };
    ends?: [[number, number], [number, number]];
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
