// The test drive's store against a stand-in worker: what it sends, and which
// of the worker's answers it takes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, SceneNode } from '../model/types';
import { ROBOTS } from '../robot/fixtures';
import { meshProperties } from '../robot/inertia';
import type { SimRequest, SimResponse } from '../sim/protocol';
import type { LinkGeometry } from '../worker/protocol';

/** A closed box mesh where the node stands, as the kernel would hand it over. */
function boxGeometry(n: SceneNode): LinkGeometry {
  const [w, d, h] = n.size;
  const [x, y, z] = [n.pos[0] - w / 2, n.pos[1] - d / 2, n.pos[2] - h / 2];
  const positions = new Float32Array([x, y, z, x + w, y, z, x + w, y + d, z, x, y + d, z, x, y, z + h, x + w, y, z + h, x + w, y + d, z + h, x, y + d, z + h]);
  const triangles = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const mesh = { positions, triangles };
  return { id: n.id, visual: [], collision: mesh, bounds: { min: [x, y, z], max: [x + w, y + d, z + h] }, props: { id: n.id, ...meshProperties(mesh), watertight: true, triangles: 12 } };
}

vi.mock('./geometry', () => ({ geometry: { prepare: async () => ({ robotGeometry: async (nodes: SceneNode[]) => nodes.map(boxGeometry) }) } }));

/** The worker the store spawns: keeps what it is sent, and answers when the test says so. */
class FakeWorker {
  static last: FakeWorker | null = null;
  sent: SimRequest[] = [];
  onmessage: ((e: { data: SimResponse }) => void) | null = null;
  onerror: unknown = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: SimRequest): void {
    this.sent.push(message);
  }
  terminate(): void {}
  answer(data: SimResponse): void {
    this.onmessage?.({ data });
  }
}

vi.stubGlobal('Worker', FakeWorker);
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });

const make = (file: string): Doc => ROBOTS.find((r) => r.file === file)!.make();
const loads = (w: FakeWorker) => w.sent.filter((m): m is Extract<SimRequest, { type: 'load' }> => m.type === 'load');
/** The worker's word that a load is done, with the bodies its XML names in their order. */
const loaded = (load: Extract<SimRequest, { type: 'load' }>, floating = false): SimResponse => ({ type: 'loaded', id: load.id, bodies: ['world', ...[...load.xml.matchAll(/<body name="([^"]+)"/g)].map((m) => m[1])], actuators: [], timestep: 0.002, floating });

describe('the test drive', () => {
  beforeEach(() => vi.resetModules());

  it('takes the answer to its latest load only, and frees the model when stopped', async () => {
    const { sim } = await import('./sim');
    await sim.start(make('rover'));
    await sim.start(make('quadruped'));
    const worker = FakeWorker.last!;
    const [first, second] = loads(worker);
    expect(first.id).not.toBe(second.id);
    // The rover's load answers late, after the quadruped's was asked for: its bodies are not the ones waited for.
    worker.answer(loaded(first));
    expect(sim.get().status).toBe('loading');
    worker.answer({ type: 'error', message: 'the rover would not load', id: first.id });
    expect(sim.get().status).toBe('loading');
    worker.answer(loaded(second));
    expect(sim.get().status).toBe('ready');
    // A frame places every link of the quadruped, nine of them.
    const bodies = [...second.xml.matchAll(/<body name=/g)].length;
    const poses = new Float64Array(7 * (bodies + 1));
    for (let i = 0; i <= bodies; i++) poses[7 * i + 3] = 1;
    worker.answer({ type: 'frame', time: 0.1, poses, ranges: new Float32Array(0), touches: new Float32Array(4) });
    expect(sim.get().frames.size).toBe(9);
    sim.stop();
    expect(sim.get().status).toBe('off');
    expect(worker.sent[worker.sent.length - 1]).toEqual({ type: 'unload' });
  });
  it('holds a free base in the air and lets it go, and offers neither for a base bolted down', async () => {
    const { sim } = await import('./sim');
    await sim.start(make('quadruped'));
    const worker = FakeWorker.last!;
    worker.answer(loaded(loads(worker)[0], true));
    expect(sim.get().floating).toBe(true);
    sim.setTarget('Knee_front_left_servo', 0.4);
    sim.hold(true);
    expect(sim.get().held).toBe(true);
    expect(worker.sent[worker.sent.length - 1]).toEqual({ type: 'hold', on: true });
    // The sliders stay where they were while it hangs; let go, it starts again, every control let go of.
    expect(sim.get().targets.size).toBe(1);
    sim.hold(false);
    expect(sim.get().held).toBe(false);
    expect(sim.get().targets.size).toBe(0);
    expect(worker.sent[worker.sent.length - 1]).toEqual({ type: 'hold', on: false });
    // A new load begins let go.
    sim.hold(true);
    await sim.start(make('arm'));
    worker.answer(loaded(loads(worker)[1]));
    expect(sim.get().held).toBe(false);
    const sent = worker.sent.length;
    sim.hold(true);
    expect(sim.get().held).toBe(false);
    expect(worker.sent.length).toBe(sent);
  });
});
