// Messages between the editor and the simulation worker: a model to load,
// commands while it runs, and the bodies' places coming back each frame.
import type { DriveSpec } from '../robot/export';
import type { SimActuator } from './mujoco';

export type SimRequest =
  /** Loads a MuJoCo model: its XML and the mesh files it refers to, by the names the XML uses. Replaces any model loaded before. */
  | { type: 'load'; xml: string; files: { name: string; bytes: Uint8Array }[]; drive: DriveSpec | null; lidars: { name: string; rays: number }[]; touches: string[] }
  /** Runs time, or holds it. */
  | { type: 'run'; running: boolean }
  /** Back to the start pose, time zero, controls off. */
  | { type: 'reset' }
  /** A rover's command: forward, turn and (mecanum) sideways, each -1..1 of the motors' top speed. */
  | { type: 'drive'; forward: number; turn: number; side: number }
  /** A servo's target (radians or meters), or a motor's speed. */
  | { type: 'target'; actuator: string; value: number };

export type SimResponse =
  | { type: 'loaded'; bodies: string[]; actuators: SimActuator[]; timestep: number }
  /**
   * Where every body is: 7 numbers each in `bodies` order, position xyz (m) then quaternion wxyz; every lidar's rays in `lidars`
   * order, meters, -1 where a ray hits nothing; and every touch sensor's force in `touches` order, newtons, -1 where the model lacks it.
   */
  | { type: 'frame'; time: number; poses: Float64Array; ranges: Float32Array; touches: Float32Array }
  | { type: 'error'; message: string };
