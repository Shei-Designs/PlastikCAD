// The store of built geometry against a stand-in for the worker: what it asks
// for, what it says is under way, and what happens to the builds under way
// when slow work is called off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBvh } from '../geometry/bvh';
import { geomKey } from '../model/geomKey';
import { makeShape } from '../model/ops';
import type { BuildResult, WorkerRequest, WorkerResponse } from '../worker/protocol';
import { Cancelled } from '../worker/client';
import { geometry } from './geometry';

/** Every worker the store started, the latest last. */
const workers: FakeWorker[] = [];

class FakeWorker {
  posted: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  constructor() {
    workers.push(this);
  }
  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** The builds it was asked for, by key. */
  builds(): string[] {
    return this.posted.flatMap((m) => (m.type === 'build' ? [m.key] : []));
  }
  /** Answers the build of `key`. */
  built(key: string): void {
    const request = this.posted.find((m) => m.type === 'build' && m.key === key);
    if (request?.type !== 'build') throw new Error(`no build of ${key} was asked for`);
    const result: BuildResult = { key, render: { positions: new Float32Array(9), normals: new Float32Array(9) }, bvh: buildBvh(new Float32Array(9)), bounds: { min: [0, 0, 0], max: [1, 1, 1] }, triangles: 1, volume: 1, watertight: true };
    this.onmessage?.({ data: { type: 'built', id: request.id, result } } as MessageEvent<WorkerResponse>);
  }
}

/** Lets the promises that are settled run their handlers. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the store of built geometry', () => {
  it('says how many objects are being built, and builds again what was called off with slow work', async () => {
    // Shapes of their own kind each, so that each has a build of its own.
    const box = makeShape('box');
    const ball = makeShape('sphere');
    const [boxKey, ballKey] = [geomKey(box), geomKey(ball)];
    const counts: number[] = [];
    const off = geometry.subscribeBuilding(() => counts.push(geometry.getBuilding()));
    geometry.ensure([box, ball], {});
    expect(workers).toHaveLength(1);
    expect(workers[0].builds()).toEqual([boxKey, ballKey]);
    expect(geometry.getBuilding()).toBe(2);
    expect(geometry.get(box)).toEqual({ state: 'pending' });

    // Someone waits on the worker for something slow (a group being measured), and calls it off.
    const grouping = geometry.worker().measure([box, ball]);
    geometry.cancel();
    await expect(grouping).rejects.toBeInstanceOf(Cancelled);
    await settle();
    expect(workers[0].terminated).toBe(true);
    // The two objects are no failures: a fresh worker is asked for them again.
    expect(workers).toHaveLength(2);
    expect(workers[1].builds().sort()).toEqual([boxKey, ballKey].sort());
    expect(geometry.get(box)).toEqual({ state: 'pending' });
    expect(geometry.get(ball)).toEqual({ state: 'pending' });
    expect(geometry.getBuilding()).toBe(2);

    workers[1].built(boxKey);
    await settle();
    expect(geometry.get(box)?.state).toBe('ready');
    expect(geometry.getBuilding()).toBe(1);
    workers[1].built(ballKey);
    await settle();
    expect(geometry.get(ball)?.state).toBe('ready');
    expect(geometry.getBuilding()).toBe(0);
    // Told at every change, and at nothing else.
    expect(counts[0]).toBe(2);
    expect(counts[counts.length - 1]).toBe(0);
    expect(counts.every((n, i) => i === 0 || n !== counts[i - 1])).toBe(true);
    off();
  });

  it('lets whoever waits for a build go on when it was called off', async () => {
    const cone = makeShape('cone');
    const ready = geometry.ready(cone, {});
    const waiting = geometry.worker().measure([cone]);
    geometry.cancel();
    await expect(waiting).rejects.toBeInstanceOf(Cancelled);
    await ready;
    // Not wanted by the scene, so not asked for again; nothing is left waiting.
    await settle();
    expect(geometry.get(cone)).toBeUndefined();
    expect(geometry.getBuilding()).toBe(0);
  });
});
