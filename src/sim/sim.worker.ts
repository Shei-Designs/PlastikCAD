// The simulation worker: holds one MuJoCo model, steps it in time while
// told to run, and reports where its bodies are some sixty times a second.
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import type { MainModule } from '@mujoco/mujoco';
import { loadMujoco, Simulation } from './mujoco';
import type { SimRequest, SimResponse } from './protocol';

/** Time is stepped this often; a frame is posted after each. */
const TICK_MS = 1000 / 60;
/** The most that is caught up in one tick, so that a stall does not bring a long freeze after it. */
const MAX_STEP_S = 0.1;

let mj: MainModule | null = null;
let sim: Simulation | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let last = 0;
/** The lidars whose rays go out with every frame. */
let lidars: { name: string; rays: number }[] = [];
/** The touch sensors whose forces go out with every frame. */
let touches: string[] = [];
/** Counts loads, so that a load still waiting for the engine gives way to a later one. */
let loads = 0;

const post = (message: SimResponse, transfer?: Transferable[]): void => {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
};

function frame(): void {
  if (!sim) return;
  const poses = sim.poses();
  const ranges = sim.lidarRanges(lidars);
  const forces = sim.touchForces(touches);
  const contacts = sim.floorContacts();
  post({ type: 'frame', time: sim.time, poses, ranges, touches: forces, contacts }, [poses.buffer, ranges.buffer, forces.buffer, contacts.buffer]);
}

function tick(): void {
  if (!sim) return;
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, MAX_STEP_S);
  last = now;
  try {
    sim.step(dt);
  } catch (e) {
    stop();
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  frame();
}

function start(): void {
  if (timer !== undefined || !sim) return;
  last = performance.now();
  timer = setInterval(tick, TICK_MS);
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

async function load(req: Extract<SimRequest, { type: 'load' }>): Promise<void> {
  const turn = ++loads;
  stop();
  sim?.dispose();
  sim = null;
  mj ??= await loadMujoco(wasmUrl);
  if (turn !== loads) return;
  sim = Simulation.load(mj, req.xml, req.files, req.drive);
  lidars = req.lidars;
  touches = req.touches;
  post({ type: 'loaded', id: req.id, bodies: sim.bodies, actuators: sim.actuators, timestep: sim.timestep, floating: sim.floating });
  frame();
}

self.onmessage = async (e: MessageEvent<SimRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'load':
        await load(req);
        break;
      case 'unload':
        // A load still waiting for the engine gives way too.
        loads++;
        stop();
        sim?.dispose();
        sim = null;
        break;
      case 'run':
        if (req.running) start();
        else stop();
        break;
      case 'reset':
        sim?.reset();
        frame();
        break;
      case 'hold':
        sim?.hold(req.on);
        // Let go, the robot starts again from its start pose, on the floor.
        if (!req.on) sim?.reset();
        frame();
        break;
      case 'drive':
        sim?.drive(req.forward, req.turn, req.side);
        break;
      case 'target':
        sim?.setTarget(req.actuator, req.value);
        break;
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e), ...(req.type === 'load' ? { id: req.id } : {}) });
  }
};
