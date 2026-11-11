// What the parts of the viewer share: the three.js objects they all draw with
// and read, the few values every part needs as they stand, and the colors and
// sizes of the look. The viewer makes one stage; each part is handed it and
// names the fields it uses.
import { Vector3 } from 'three';
import type { Matrix4, PerspectiveCamera, Raycaster, Scene, SpriteMaterial, Vector2, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Mat } from '../model/math';
import type { Asset } from '../model/types';
import type { ViewItem, ViewerEvents, ViewerOptions } from './types';

export const FOV = 35;

export const THEMES = {
  dark: { grid: 0x879390, major: 0.3, minor: 0.1, accent: 0x17cdd3, edge: 0.85, stage: ['#263130', '#0a0d0d'] },
  light: { grid: 0x5f6b68, major: 0.34, minor: 0.12, accent: 0x0d9297, edge: 0.7, stage: ['#ffffff', '#d3dbd8'] },
};

export const AXIS_COLORS = ['#e5484d', '#3fae5a', '#4c8dff'];
/** How much bigger a grip is to a finger than to the eye. */
export const TOUCH_GRIP_SCALE = 2.5;

export const UP = new Vector3(0, 1, 0);

export const axisVector = (axis: 0 | 1 | 2): Vector3 => new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);

export const toMatrix4 = (m: Mat, target: Matrix4): Matrix4 =>
  target.set(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1);

export const fmt = (v: number) => String(Number(v.toFixed(2)));

/** The sprite materials the grips, dots and badges are drawn with, shared by every part that draws them. */
export interface Grips {
  corner: SpriteMaterial;
  edge: SpriteMaterial;
  /** The grip whose value is being typed. */
  typing: SpriteMaterial;
  dot: SpriteMaterial;
  dotHot: SpriteMaterial;
  lock: SpriteMaterial;
  /** Align anchor dots, one pair per axis in that axis's color: as they sit, and lit under the pointer. */
  axisDot: { idle: SpriteMaterial; hot: SpriteMaterial }[];
  /** An anchor dot that would change nothing. */
  dotDone: SpriteMaterial;
}

export interface Stage {
  readonly container: HTMLElement;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  /** Handles, markers and measurements, drawn over everything else. */
  readonly overlay: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly raycaster: Raycaster;
  readonly pointer: Vector2;
  readonly events: ViewerEvents;
  readonly grips: Grips;
  /** The viewer's own, as they stand: it replaces them, so they are read afresh each time. */
  readonly options: ViewerOptions;
  readonly items: ViewItem[];
  readonly assets: Record<string, Asset>;
  /** Height of the view, in CSS pixels. */
  readonly height: number;
  /** While true, the pointer positions a new shape instead of selecting. */
  readonly placing: boolean;
  /** Grips are laid out this much bigger than drawn while a finger is picking one. */
  gripScale: number;
  requestRender(): void;
}

/** World length of one pixel at a point, for handles that keep their size on screen. */
export function pixelSize(stage: Pick<Stage, 'camera' | 'height'>, at: Vector3): number {
  const depth = at.clone().sub(stage.camera.position).dot(stage.camera.getWorldDirection(new Vector3()));
  return (2 * Math.max(depth, 1e-3) * Math.tan((FOV * Math.PI) / 360)) / Math.max(stage.height, 1);
}

/** Where a point of the scene is on screen. */
export function toClient(stage: Pick<Stage, 'renderer' | 'camera'>, p: Vector3): { clientX: number; clientY: number } {
  const rect = stage.renderer.domElement.getBoundingClientRect();
  const v = p.clone().project(stage.camera);
  return { clientX: rect.left + ((v.x + 1) / 2) * rect.width, clientY: rect.top + ((1 - v.y) / 2) * rect.height };
}

/** Aims the pointer ray through where the event is. */
export function setRay(stage: Pick<Stage, 'renderer' | 'camera' | 'raycaster' | 'pointer'>, event: PointerEvent): void {
  const rect = stage.renderer.domElement.getBoundingClientRect();
  stage.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  stage.raycaster.setFromCamera(stage.pointer, stage.camera);
}
