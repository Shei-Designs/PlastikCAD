// Where the camera stands: a pose in Z-up spherical coordinates round a
// target, the distance that fits a design in the view, and the short glide
// from one pose to another.
import { Vector3 } from 'three';
import { FOV } from './stage';
import type { Stage } from './stage';
import type { ViewPreset } from './types';

const FIT_MARGIN = 1.25;
const ANIMATION_MS = 250;
const MIN_PHI = 1e-3; // keeps the camera off the Z axis, where "up" is undefined

/** Unit vectors from the scene towards the camera. */
export const VIEW_DIRECTIONS: Record<ViewPreset, Vector3> = {
  iso: new Vector3(1, -1.2, 0.9).normalize(),
  // Tilted a hair towards -Y so that +Y ends up at the top of the screen.
  top: new Vector3(0, -Math.sin(MIN_PHI), Math.cos(MIN_PHI)),
  front: new Vector3(0, -1, 0),
  side: new Vector3(1, 0, 0),
};

/** Camera placement in Z-up spherical coordinates around `target`. */
export interface Pose {
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** How far back the camera stands for a sphere of this radius to fit a view of these proportions. */
export function fitDistance(radius: number, aspect: number): number {
  const vHalf = (FOV * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  return (radius / Math.sin(Math.min(vHalf, hHalf))) * FIT_MARGIN;
}

/** The pose that looks at `target` from `direction`, this far away. */
export function poseToward(direction: Vector3, distance: number, target: Vector3): Pose {
  return {
    theta: Math.atan2(direction.y, direction.x),
    phi: Math.acos(clamp(direction.z, -1, 1)),
    distance,
    target,
  };
}

/** The pose of a camera at `position` looking at `target`. */
export function poseOf(position: Vector3, target: Vector3): Pose {
  const offset = position.clone().sub(target);
  const distance = Math.max(offset.length(), 1e-6);
  return {
    theta: Math.atan2(offset.y, offset.x),
    phi: Math.acos(clamp(offset.z / distance, -1, 1)),
    distance,
    target,
  };
}

/** Where the camera stands in a pose. */
export function posePosition(pose: Pose): Vector3 {
  const phi = clamp(pose.phi, MIN_PHI, Math.PI - MIN_PHI);
  const s = Math.sin(phi) * pose.distance;
  return new Vector3(pose.target.x + s * Math.cos(pose.theta), pose.target.y + s * Math.sin(pose.theta), pose.target.z + Math.cos(phi) * pose.distance);
}

/** The pose `k` of the way (0 to 1) from one to another. */
export function poseBetween(from: Pose, to: Pose, k: number): Pose {
  // Take the short way round in azimuth.
  const dTheta = ((((to.theta - from.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return {
    theta: from.theta + dTheta * k,
    phi: from.phi + (to.phi - from.phi) * k,
    distance: from.distance + (to.distance - from.distance) * k,
    target: from.target.clone().lerp(to.target, k),
  };
}

/** What the camera is fitted to: the design's middle and radius, and the view's proportions. */
export interface CameraSubject {
  readonly center: Vector3;
  readonly radius: number;
  readonly aspect: number;
}

/** Poses the camera and glides it from one pose to the next. */
export class CameraRig {
  private animation: Animation | null = null;

  constructor(
    private readonly stage: Pick<Stage, 'camera' | 'controls' | 'requestRender'>,
    private readonly subject: CameraSubject,
  ) {}

  /** True while a glide is under way. */
  get animating(): boolean {
    return this.animation !== null;
  }

  /** Ends the glide where it is and gives the camera back to the controls. */
  halt(): void {
    this.animation = null;
    this.stage.controls.enabled = true;
  }

  fitDistance(radius = this.subject.radius, aspect = this.subject.aspect): number {
    return fitDistance(radius, aspect);
  }

  poseFor(direction: Vector3): Pose {
    return poseToward(direction, this.fitDistance(), this.subject.center.clone());
  }

  currentPose(): Pose {
    return poseOf(this.stage.camera.position, this.stage.controls.target.clone());
  }

  applyPose(pose: Pose): void {
    this.stage.controls.target.copy(pose.target);
    this.stage.camera.position.copy(posePosition(pose));
    this.stage.controls.update();
  }

  animateTo(to: Pose): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.halt();
      this.applyPose(to);
    } else {
      this.animation = { start: performance.now(), duration: ANIMATION_MS, from: this.currentPose(), to };
      this.stage.controls.enabled = false;
    }
    this.stage.requestRender();
  }

  /** Moves the glide on to where it should be by now. */
  step(): void {
    const a = this.animation;
    if (!a) return;
    const t = clamp((performance.now() - a.start) / a.duration, 0, 1);
    const k = easeInOut(t);
    this.applyPose(poseBetween(a.from, a.to, k));
    if (t >= 1) {
      this.halt();
    } else {
      this.stage.requestRender();
    }
  }
}
