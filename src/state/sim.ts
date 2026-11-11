// The test drive: the robot as it stands, exported to MuJoCo and run in a
// worker, every link drawn where the simulation has it. Lives beside the
// editor's state so that sixty frames a second do not pass through it; the
// plate and the Test section read it through `subscribe`.
import { tr, WORKER_LANGUAGE } from '../i18n';
import type { Mat } from '../model/math';
import type { Doc, Vec3 } from '../model/types';
import { buildMjcfModel } from '../robot/export';
import type { DriveSpec } from '../robot/export';
import { linkNodes, linkOf, robotOf } from '../robot/model';
import type { World } from '../robot/types';
import type { SimActuator } from '../sim/mujoco';
import type { SimRequest, SimResponse } from '../sim/protocol';
import { geometry } from './geometry';

const M = 0.001;

export type SimStatus = 'off' | 'loading' | 'ready' | 'error';

export interface SimState {
  status: SimStatus;
  /** Why the model failed to load or run, in the engine's words. */
  error: string | null;
  /** Time runs. */
  running: boolean;
  /** Seconds since the start pose. */
  time: number;
  /** Where every link is, as the transform from its designed place; empty until the first frame. */
  frames: Map<string, Mat>;
  /** The base's place, mm, and its turn about Z, degrees. */
  base: { pos: Vec3; yaw: number } | null;
  /** The controls the model offers: servos by the design joint they move, motors by theirs. */
  actuators: (SimActuator & { jointId: string | null })[];
  drive: DriveSpec | null;
  world: World;
  /** The servo targets as set, radians or meters. */
  targets: Map<string, number>;
  /** The rover command as held. */
  command: { forward: number; turn: number; side: number };
  /** By the design sensor's id: a lidar's rays, mm from its origin, -1 where a ray hits nothing; a touch sensor's one number, the force it feels in newtons. */
  readings: Map<string, number[]>;
}

/** What each key does to a rover. */
const DRIVE_KEYS: Record<string, string> = {
  w: 'forward',
  ArrowUp: 'forward',
  s: 'back',
  ArrowDown: 'back',
  a: 'left',
  ArrowLeft: 'left',
  d: 'right',
  ArrowRight: 'right',
  q: 'slide-left',
  e: 'slide-right',
};

const OFF: SimState = { status: 'off', error: null, running: false, time: 0, frames: new Map(), base: null, actuators: [], drive: null, world: 'flat', targets: new Map(), command: { forward: 0, turn: 0, side: 0 }, readings: new Map() };

/** The transform taking a link from where it is designed to where the simulation has its body: a turn by the quaternion about the body's frame origin, and a move. */
function frameOf(poses: Float64Array, at: number, origin: Vec3): Mat {
  const px = poses[at] / M;
  const py = poses[at + 1] / M;
  const pz = poses[at + 2] / M;
  const [w, x, y, z] = [poses[at + 3], poses[at + 4], poses[at + 5], poses[at + 6]];
  // Columns of the rotation.
  const c0: Vec3 = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  const c1: Vec3 = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const c2: Vec3 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  const [ox, oy, oz] = origin;
  return [...c0, ...c1, ...c2, px - (c0[0] * ox + c1[0] * oy + c2[0] * oz), py - (c0[1] * ox + c1[1] * oy + c2[1] * oz), pz - (c0[2] * ox + c1[2] * oy + c2[2] * oz)];
}

const yawOf = (poses: Float64Array, at: number): number => {
  const [w, x, y, z] = [poses[at + 3], poses[at + 4], poses[at + 5], poses[at + 6]];
  return (Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
};

class SimStore {
  private state: SimState = OFF;
  private listeners = new Set<() => void>();
  private revision = 0;
  private worker: Worker | null = null;
  /** The design the running model was built from; a change to either stops the drive. */
  private built: { scene: Doc['scene']; robot: Doc['robot'] } | null = null;
  /** Body name → the link it is and where its frame sits in the design (mm). */
  private bodies = new Map<string, { node: string; frame: Vec3 }>();
  private bodyOrder: string[] = [];
  /** Joint name in the model → the design joint, for naming the controls. */
  private jointIds = new Map<string, string>();
  /** The lidars the worker reads with every frame, in the order their rays arrive. */
  private lidars: { name: string; id: string; rays: number }[] = [];
  /** The touch sensors the worker reads with every frame, in the order their forces arrive. */
  private touches: { name: string; id: string }[] = [];
  /** Counts starts, so that a start overtaken by a stop or another start lets go. */
  private starts = 0;
  private held = new Set<string>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = (): number => this.revision;

  get(): SimState {
    return this.state;
  }

  /** The drive is on: a model is loaded or loading. */
  get on(): boolean {
    return this.state.status !== 'off';
  }

  private set(patch: Partial<SimState>): void {
    this.state = { ...this.state, ...patch };
    this.revision++;
    for (const l of this.listeners) l();
  }

  /** Builds the robot's MuJoCo model from the design as it stands and loads it, standing still at its start pose. */
  async start(doc: Doc): Promise<void> {
    const turn = ++this.starts;
    const robot = robotOf(doc);
    this.built = { scene: doc.scene, robot: doc.robot };
    this.set({ ...OFF, status: 'loading', world: robot.world ?? 'flat' });
    try {
      const nodes = linkNodes(doc.scene);
      const worker = await geometry.prepare(nodes, doc.assets);
      const collisions = Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision]));
      const geo = await worker.robotGeometry(nodes, collisions, false);
      if (turn !== this.starts) return;
      // The plate draws the links itself: the model needs no visual meshes.
      const pkg = buildMjcfModel(doc, new Map(geo.map((g) => [g.id, { ...g, visual: [] }])), robot, robot.world ?? 'flat');
      const xml = new TextDecoder().decode(pkg.files.find((f) => f.name.endsWith('.xml'))!.bytes);
      const files = pkg.files.filter((f) => f.name.startsWith('meshes/'));
      this.bodies = new Map(pkg.bodies.map((b) => [b.body, { node: b.node, frame: b.frame }]));
      this.jointIds = new Map(pkg.joints.map((j) => [j.name, j.id]));
      this.lidars = pkg.lidars;
      this.touches = pkg.touches;
      this.set({ drive: pkg.drive });
      this.send({ type: 'load', id: turn, xml, files, drive: pkg.drive, lidars: pkg.lidars.map(({ name, rays }) => ({ name, rays })), touches: pkg.touches.map((t) => t.name) });
      this.listen(true);
    } catch (e) {
      if (turn !== this.starts) return;
      this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Lets the model go; the plate shows the design again. */
  stop(): void {
    this.starts++;
    this.built = null;
    this.listen(false);
    if (this.state.status === 'off') return;
    // The worker frees the model; one that was never spawned holds none.
    this.worker?.postMessage({ type: 'unload' } satisfies SimRequest);
    this.set({ ...OFF });
  }

  /** Stops the drive when the design is no longer the one it was built from, or Robot mode is left. */
  check(doc: Doc, robotMode: boolean): void {
    if (!this.built) return;
    if (!robotMode || doc.scene !== this.built.scene || doc.robot !== this.built.robot) this.stop();
  }

  setRunning(running: boolean): void {
    if (this.state.status !== 'ready' || running === this.state.running) return;
    this.send({ type: 'run', running });
    this.set({ running });
  }

  /** Back to the start pose, standing still, with every control let go of. */
  reset(): void {
    if (this.state.status !== 'ready') return;
    this.send({ type: 'reset' });
    this.set({ time: 0, targets: new Map(), command: { forward: 0, turn: 0, side: 0 } });
  }

  /** A rover's command, each part -1..1. */
  drive(forward: number, turn: number, side = 0): void {
    if (this.state.status !== 'ready' || !this.state.drive) return;
    const c = this.state.command;
    if (c.forward === forward && c.turn === turn && c.side === side) return;
    this.send({ type: 'drive', forward, turn, side });
    this.set({ command: { forward, turn, side } });
  }

  /** A servo's target, radians or meters; a motor's speed. */
  setTarget(actuator: string, value: number): void {
    if (this.state.status !== 'ready') return;
    this.send({ type: 'target', actuator, value });
    const targets = new Map(this.state.targets);
    targets.set(actuator, value);
    this.set({ targets });
  }

  private send(message: SimRequest): void {
    this.worker ??= this.spawn();
    this.worker.postMessage(message);
  }

  // --- keys -------------------------------------------------------------------

  /** While the drive is on, W A S D and the arrows steer a rover (Q and E slide a mecanum one), ahead of the editor's own shortcuts. */
  private listen(on: boolean): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    this.held.clear();
    if (!on) return;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.state.drive || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const key = DRIVE_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown') this.held.add(key);
    else this.held.delete(key);
    this.steer();
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.steer();
  };

  private steer(): void {
    const h = this.held;
    const part = (plus: string, minus: string) => (h.has(plus) ? 1 : 0) - (h.has(minus) ? 1 : 0);
    const forward = part('forward', 'back');
    const turn = part('left', 'right');
    const side = this.state.drive?.kind === 'mecanum' ? part('slide-left', 'slide-right') : 0;
    if ((forward || turn || side) && !this.state.running) this.setRunning(true);
    this.drive(forward, turn, side);
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('../sim/sim.worker.ts', import.meta.url), { type: 'module', name: WORKER_LANGUAGE });
    worker.onmessage = (e: MessageEvent<SimResponse>) => this.receive(e.data);
    worker.onerror = (e) => {
      this.set({ status: 'error', error: e.message || tr('The simulation worker crashed'), running: false });
      this.worker = null;
      worker.terminate();
    };
    return worker;
  }

  private receive(message: SimResponse): void {
    if (this.state.status === 'off') return;
    // An answer to a load that a later one has overtaken is about another model than the one waited for.
    if ((message.type === 'loaded' || message.type === 'error') && message.id !== undefined && message.id !== this.starts) return;
    switch (message.type) {
      case 'loaded': {
        this.bodyOrder = message.bodies;
        const actuators = message.actuators.map((a) => ({ ...a, jointId: this.jointIds.get(a.joint) ?? null }));
        this.set({ status: 'ready', error: null, actuators, running: false, time: 0 });
        // Time runs as soon as the model stands: a rover settles onto its wheels and waits for the keys.
        this.setRunning(true);
        break;
      }
      case 'frame': {
        if (this.state.status !== 'ready') return;
        const frames = new Map<string, Mat>();
        let base: SimState['base'] = null;
        for (let i = 0; i < this.bodyOrder.length; i++) {
          const body = this.bodies.get(this.bodyOrder[i]);
          if (!body) continue;
          const at = 7 * i;
          frames.set(body.node, frameOf(message.poses, at, body.frame));
          base ??= { pos: [message.poses[at] / M, message.poses[at + 1] / M, message.poses[at + 2] / M], yaw: yawOf(message.poses, at) };
        }
        const readings = new Map<string, number[]>();
        let from = 0;
        for (const l of this.lidars) {
          readings.set(l.id, Array.from(message.ranges.subarray(from, from + l.rays), (v) => (v < 0 ? -1 : v / M)));
          from += l.rays;
        }
        this.touches.forEach((t, i) => readings.set(t.id, [message.touches[i]]));
        this.set({ frames, base, time: message.time, readings });
        break;
      }
      case 'error':
        this.set({ status: 'error', error: message.message, running: false });
        break;
    }
  }
}

export const sim = new SimStore();
