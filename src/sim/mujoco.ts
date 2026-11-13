// The design driving on the plate: its exported MuJoCo model loaded into the
// WebAssembly build of the engine, stepped through time, its bodies' places
// read back. Knows nothing of threads: the worker owns one of these, and the
// tests run one under Node.
import type { MainModule, MjData, MjModel, MjVFS } from '@mujoco/mujoco';
import type { DriveSpec } from '../robot/export';

export interface SimActuator {
  name: string;
  /** The model's joint it drives. */
  joint: string;
  /** A servo takes a target angle or travel; a motor a speed. */
  kind: 'servo' | 'motor';
  /** What its control may be set to: a servo's joint range, or a motor's top speed either way. Radians, meters. */
  min: number;
  max: number;
}

export interface SimFile {
  name: string;
  bytes: Uint8Array;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

let loading: Promise<MainModule> | null = null;

/** The engine, loaded once. `wasmUrl` is only needed in the browser, where the bundler relocates the file. */
export function loadMujoco(wasmUrl?: string): Promise<MainModule> {
  loading ??= import('@mujoco/mujoco')
    .then((m) => m.default(wasmUrl ? { locateFile: () => wasmUrl } : undefined))
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

export class Simulation {
  readonly timestep: number;
  /** Every body in the model, the world first. */
  readonly bodies: string[];
  readonly actuators: SimActuator[];
  private readonly index = new Map<string, number>();
  private readonly joints = new Map<string, number>();
  /** Sensor name → where its reading starts in sensordata, and how many numbers it is. */
  private readonly sensors = new Map<string, { at: number; dim: number }>();
  /** Time asked for and not yet stepped: what is left of a time step after each call, s. */
  private owed = 0;
  /** Where a free base is pinned while the robot is held in the air: its position and quaternion, as qpos has them. */
  private pinned: Float64Array | null = null;

  private constructor(
    private readonly mj: MainModule,
    private readonly model: MjModel,
    private readonly data: MjData,
    private readonly vfs: MjVFS,
    private readonly spec: DriveSpec | null,
  ) {
    this.timestep = model.opt.timestep;
    const name = (kind: number, i: number): string => mj.mj_id2name(model, kind, i);
    this.bodies = Array.from({ length: model.nbody }, (_, i) => name(mj.mjtObj.mjOBJ_BODY.value, i));
    for (let j = 0; j < model.njnt; j++) this.joints.set(name(mj.mjtObj.mjOBJ_JOINT.value, j), j);
    const sensorAdr = model.sensor_adr as Int32Array;
    const sensorDim = model.sensor_dim as Int32Array;
    for (let s = 0; s < model.nsensor; s++) this.sensors.set(name(mj.mjtObj.mjOBJ_SENSOR.value, s), { at: sensorAdr[s], dim: sensorDim[s] });
    const nbias = mj.mjNBIAS as number;
    const biasprm = model.actuator_biasprm as Float64Array;
    const trnid = model.actuator_trnid as Int32Array;
    const ctrlrange = model.actuator_ctrlrange as Float64Array;
    const ctrllimited = model.actuator_ctrllimited as Uint8Array;
    const jntrange = model.jnt_range as Float64Array;
    const jntlimited = model.jnt_limited as Uint8Array;
    this.actuators = Array.from({ length: model.nu }, (_, a) => {
      const actuator = name(mj.mjtObj.mjOBJ_ACTUATOR.value, a);
      this.index.set(actuator, a);
      const j = trnid[2 * a];
      // A position servo carries a position gain in its bias; a velocity motor only a velocity one.
      const servo = biasprm[a * nbias + 1] !== 0;
      const [min, max] = servo ? (jntlimited[j] ? [jntrange[2 * j], jntrange[2 * j + 1]] : [-Math.PI, Math.PI]) : ctrllimited[a] ? [ctrlrange[2 * a], ctrlrange[2 * a + 1]] : [-10, 10];
      return { name: actuator, joint: name(mj.mjtObj.mjOBJ_JOINT.value, j), kind: servo ? 'servo' : 'motor', min, max };
    });
  }

  /** Loads the model from its XML and the files it refers to (by the names the XML uses), at its home pose. Throws with the engine's words when the model is bad. */
  static load(mj: MainModule, xml: string, files: SimFile[], drive: DriveSpec | null): Simulation {
    const vfs = new mj.MjVFS();
    for (const f of files) vfs.addBuffer(f.name, f.bytes);
    let model: MjModel;
    try {
      model = mj.MjModel.from_xml_string(xml, vfs);
    } catch (e) {
      vfs.delete();
      throw e;
    }
    const data = new mj.MjData(model);
    const sim = new Simulation(mj, model, data, vfs, drive);
    sim.reset();
    return sim;
  }

  get time(): number {
    return this.data.time;
  }

  /** Back to the home pose and time zero: every motor off, every servo holding its joint where the home pose has it. */
  reset(): void {
    // The keyframe carries the servos' targets with the pose; a model without one starts with every control at zero.
    if (this.model.nkey > 0) this.mj.mj_resetDataKeyframe(this.model, this.data, 0);
    else this.mj.mj_resetData(this.model, this.data);
    this.owed = 0;
    this.pin();
    this.mj.mj_forward(this.model, this.data);
  }

  /** Whether the base is free to move, and so can be held: its joint is the model's first. */
  get floating(): boolean {
    return this.model.njnt > 0 && (this.model.jnt_type as Int32Array)[0] === this.mj.mjtJoint.mjJNT_FREE.value;
  }

  /**
   * Holds a free base still in the air, level as the home pose has it and high enough that no part of the
   * robot can reach the floor however its joints turn, or lets it go. The joints move as before.
   */
  hold(on: boolean): void {
    if (!on || !this.floating) {
      this.pinned = null;
      return;
    }
    // The home pose's base, raised: the farthest any of the robot's shapes reaches from the base's origin is as low as one can hang.
    const qpos = this.data.qpos as Float64Array;
    const live = qpos.slice();
    const vel = (this.data.qvel as Float64Array).slice();
    if (this.model.nkey > 0) qpos.set((this.model.key_qpos as Float64Array).subarray(0, 7));
    this.mj.mj_forward(this.model, this.data);
    const at = this.data.geom_xpos as Float64Array;
    const body = this.model.geom_bodyid as Int32Array;
    const bound = this.model.geom_rbound as Float64Array;
    const base = (this.data.xpos as Float64Array).subarray(3, 6);
    let reach = 0;
    for (let g = 0; g < this.model.ngeom; g++) if (body[g] > 0) reach = Math.max(reach, Math.hypot(at[3 * g] - base[0], at[3 * g + 1] - base[1], at[3 * g + 2] - base[2]) + bound[g]);
    this.pinned = qpos.slice(0, 7);
    this.pinned[2] = reach * 1.1 + 0.01;
    // The joints stay as they were, moving as they were.
    qpos.set(live.subarray(7), 7);
    (this.data.qvel as Float64Array).set(vel);
    this.pin();
    this.mj.mj_forward(this.model, this.data);
  }

  /** Puts a held base back where it is pinned, standing still. */
  private pin(): void {
    if (!this.pinned) return;
    (this.data.qpos as Float64Array).set(this.pinned);
    (this.data.qvel as Float64Array).fill(0, 0, 6);
  }

  /**
   * Steps time on by `seconds`: as many whole time steps as fit, the rest carried to the next call, so that
   * a frame's worth at a time keeps pace with the clock. The number of steps taken.
   */
  step(seconds: number): number {
    this.owed += Math.max(0, seconds);
    const n = Math.floor(this.owed / this.timestep + 1e-9);
    this.owed -= n * this.timestep;
    for (let i = 0; i < n; i++) {
      this.pin();
      this.mj.mj_step(this.model, this.data);
    }
    // The step moved the base a hair on from where it is pinned; what is read next is where it is held.
    if (this.pinned && n > 0) {
      this.pin();
      this.mj.mj_forward(this.model, this.data);
    }
    return n;
  }

  /** Where every body is, 7 numbers each in `bodies` order: position xyz in meters, then quaternion wxyz. */
  poses(): Float64Array {
    const n = this.model.nbody;
    const out = new Float64Array(n * 7);
    const xpos = this.data.xpos as Float64Array;
    const xquat = this.data.xquat as Float64Array;
    for (let i = 0; i < n; i++) {
      out.set(xpos.subarray(3 * i, 3 * i + 3), 7 * i);
      out.set(xquat.subarray(4 * i, 4 * i + 4), 7 * i + 3);
    }
    return out;
  }

  /** A joint's value, radians or meters; NaN for a joint the model lacks. */
  jointValue(joint: string): number {
    const j = this.joints.get(joint);
    if (j === undefined) return NaN;
    return (this.data.qpos as Float64Array)[(this.model.jnt_qposadr as Int32Array)[j]];
  }

  /** The readings of these lidars' rays (`<name>_<i>`), one after another, meters; -1 where a ray hits nothing or the model lacks it. */
  lidarRanges(lidars: { name: string; rays: number }[]): Float32Array {
    const out = new Float32Array(lidars.reduce((n, l) => n + l.rays, 0));
    const data = this.data.sensordata as Float64Array;
    let at = 0;
    for (const l of lidars) {
      for (let i = 0; i < l.rays; i++) {
        const s = this.sensors.get(`${l.name}_${i}`);
        out[at++] = s ? data[s.at] : -1;
      }
    }
    return out;
  }

  /** The force each of these touch sensors feels, newtons; -1 for a sensor the model lacks. */
  touchForces(touches: string[]): Float32Array {
    const data = this.data.sensordata as Float64Array;
    return Float32Array.from(touches, (name) => {
      const s = this.sensors.get(name);
      return s ? data[s.at] : -1;
    });
  }

  /** Where the robot touches the floor or anything else that stands still: for each point of contact its xyz, meters, then which body touches there, as `bodies` counts them. */
  floorContacts(): Float32Array {
    const body = this.model.geom_bodyid as Int32Array;
    const out: number[] = [];
    const contacts = this.data.contact;
    for (let i = 0; i < this.data.ncon; i++) {
      const c = contacts.get(i);
      if (!c) continue;
      // The world is body 0: a contact of the robot with itself has it on neither side.
      if (!c.exclude && (body[c.geom1] === 0) !== (body[c.geom2] === 0)) out.push(...(c.pos as Float64Array), body[c.geom1] || body[c.geom2]);
      c.delete();
    }
    return Float32Array.from(out);
  }

  /** A sensor's reading as it stands; empty for a sensor the model lacks. */
  sensorValue(sensor: string): number[] {
    const s = this.sensors.get(sensor);
    if (!s) return [];
    return Array.from((this.data.sensordata as Float64Array).subarray(s.at, s.at + s.dim));
  }

  /** Sets an actuator's control, within its range. */
  setTarget(actuator: string, value: number): void {
    const a = this.index.get(actuator);
    if (a === undefined) return;
    const { min, max } = this.actuators[a];
    (this.data.ctrl as Float64Array)[a] = clamp(value, min, max);
  }

  /**
   * A rover's command: `forward`, `turn` (left positive) and, for a mecanum
   * drive, `side` (left positive), each -1..1 of what the motors can do. Wheel
   * speeds and steering follow the drive's kind, as drive.py has it.
   */
  drive(forward: number, turn: number, side = 0): void {
    const d = this.spec;
    if (!d) return;
    const ctrl = this.data.ctrl as Float64Array;
    const set = (role: keyof DriveSpec['roles'], value: number) => {
      for (const name of d.roles[role] ?? []) {
        const a = this.index.get(name);
        if (a !== undefined) ctrl[a] = value;
      }
    };
    const motors = this.actuators.filter((a) => a.kind === 'motor');
    const top = motors.length ? Math.min(...motors.map((a) => a.max)) : 1;
    const r = d.wheelRadius;
    const sep = d.wheelSeparation;
    const vmax = top * r;
    const v = clamp(forward, -1, 1) * vmax;
    const wheel = (speed: number) => clamp(speed / r, -top, top);
    if (d.kind === 'differential') {
      const w = clamp(turn, -1, 1) * ((2 * vmax) / sep);
      set('left', wheel(v - (w * sep) / 2));
      set('right', wheel(v + (w * sep) / 2));
    } else if (d.kind === 'ackermann') {
      set('left', wheel(v));
      set('right', wheel(v));
      const steer = clamp(turn, -1, 1) * (d.steeringLimit ?? 0.5);
      set('steer-left', steer);
      set('steer-right', steer);
    } else {
      const vy = clamp(side, -1, 1) * vmax;
      const k = ((d.wheelBase ?? sep) + sep) / 2;
      const w = (clamp(turn, -1, 1) * vmax) / k;
      set('front-left', wheel(v - vy - k * w));
      set('front-right', wheel(v + vy + k * w));
      set('rear-left', wheel(v + vy - k * w));
      set('rear-right', wheel(v - vy + k * w));
    }
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
    this.vfs.delete();
  }
}
