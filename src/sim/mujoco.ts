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

  /** Back to the home pose, time zero, every control off. */
  reset(): void {
    if (this.model.nkey > 0) this.mj.mj_resetDataKeyframe(this.model, this.data, 0);
    else this.mj.mj_resetData(this.model, this.data);
    (this.data.ctrl as Float64Array).fill(0);
    this.mj.mj_forward(this.model, this.data);
  }

  /** Steps time on by about `seconds`; the number of steps taken. */
  step(seconds: number): number {
    const n = Math.max(0, Math.round(seconds / this.timestep));
    for (let i = 0; i < n; i++) this.mj.mj_step(this.model, this.data);
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
