import { describe, expect, it } from 'vitest';
import type { Asset, OutlineShape, ShapeNode } from '../model/types';
import { Cancelled, GeometryClient } from './client';
import { buildBvh } from '../geometry/bvh';
import type { BuildResult, WorkerRequest, WorkerResponse } from './protocol';

/** A stand-in for the worker: keeps what it is sent, and says what the test tells it to. */
class FakeWorker {
  posted: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  /** What was handed over rather than copied, request by request. */
  transfers: Transferable[][] = [];
  postMessage(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.posted.push(msg);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  garble(): void {
    this.onmessageerror?.({} as MessageEvent);
  }
  /** What went with the latest thing it was sent, handed over rather than copied. */
  handedOver(): Transferable[] {
    return this.transfers[this.transfers.length - 1];
  }
  /** The latest thing it was sent. */
  last(): WorkerRequest {
    return this.posted[this.posted.length - 1];
  }
  /** The ids of the requests it holds that want an answer, oldest first. */
  ids(): number[] {
    return this.posted.flatMap((m) => ('id' in m ? [m.id] : []));
  }
  /** The names of the assets it has been handed, in order. */
  assets(): string[] {
    return this.posted.flatMap((m) => (m.type === 'assets' ? Object.keys(m.assets) : []));
  }
}

function setup(): { client: GeometryClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new GeometryClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { client, workers };
}

const box: ShapeNode = { id: 'b', type: 'shape', name: 'Box', shape: 'box', params: {}, pos: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20], hole: false, color: '#8fa3bf' };
const result = (key: string): BuildResult => ({ key, render: { positions: new Float32Array(9), normals: new Float32Array(9) }, bvh: buildBvh(new Float32Array(9)), bounds: { min: [0, 0, 0], max: [1, 1, 1] }, triangles: 1, volume: 1, watertight: true });
const mesh = (positions = 'AAAA'): Asset => ({ kind: 'mesh', positions, triangles: 'AAAA' });
const lettering = (shapes: OutlineShape[] = []): Asset => ({ kind: 'outline', shapes });

describe('the geometry client', () => {
  it('answers each request with the reply that carries its id', async () => {
    const { client, workers } = setup();
    const first = client.build('k1', box);
    const second = client.measure([box]);
    const [a, b] = workers[0].ids();
    workers[0].say({ type: 'measured', id: b, bounds: null });
    workers[0].say({ type: 'built', id: a, result: result('k1') });
    expect((await first).key).toBe('k1');
    expect(await second).toBeNull();
    const failed = client.build('k2', box);
    workers[0].say({ type: 'error', id: workers[0].ids()[2], message: 'This shape is empty.' });
    await expect(failed).rejects.toThrow('This shape is empty.');
  });

  it('replaces a worker that died, failing what it was working on and handing the new one its data again', async () => {
    const { client, workers } = setup();
    const assets = { m: mesh(), picture: { kind: 'image', name: 'p.png', mime: 'image/png', data: '', width: 1, height: 1 } as Asset };
    client.syncAssets(assets);
    expect(workers[0].assets()).toEqual(['m']);
    const lost = [client.build('k1', box), client.measure([box])];
    workers[0].crash('out of memory');
    for (const p of lost) await expect(p).rejects.toThrow(/geometry worker crashed \(out of memory\) and was restarted/);
    expect(workers[0].terminated).toBe(true);
    // Whatever the dead worker still says is not listened to.
    workers[0].say({ type: 'built', id: 1, result: result('k1') });
    // The next request starts another, which gets the imported data before the node that uses it.
    client.syncAssets(assets);
    const again = client.build('k1', box);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map((m) => m.type)).toEqual(['assets', 'build']);
    expect(workers[1].assets()).toEqual(['m']);
    workers[1].say({ type: 'built', id: workers[1].ids()[0], result: result('k1') });
    expect((await again).key).toBe('k1');
    // And a second death is survived like the first.
    const third = client.measure([box]);
    workers[1].crash('');
    await expect(third).rejects.toThrow('The geometry worker crashed and was restarted.');
    void client.measure([box]);
    expect(workers).toHaveLength(3);
  });

  it('fails only the oldest request when an answer cannot be read', async () => {
    const { client, workers } = setup();
    const big = client.export([box], false, true);
    const small = client.measure([box]);
    workers[0].garble();
    await expect(big).rejects.toThrow(/could not be read/);
    workers[0].say({ type: 'measured', id: workers[0].ids()[1], bounds: null });
    expect(await small).toBeNull();
    expect(workers).toHaveLength(1);
    // With nothing waiting there is nothing to fail.
    workers[0].garble();
  });

  it('hands over an asset once, and again when its data has changed under the same name', () => {
    const { client, workers } = setup();
    const m = mesh();
    client.syncAssets({ m });
    client.syncAssets({ m, n: mesh() });
    expect(workers[0].assets()).toEqual(['m', 'n']);
    // Other data under the name of the first (another design's, say).
    const other = mesh('AAAAAAAA');
    client.syncAssets({ m: other });
    expect(workers[0].assets()).toEqual(['m', 'n', 'm']);
    expect((workers[0].posted[2] as Extract<WorkerRequest, { type: 'assets' }>).assets.m).toBe(other);
    // Outlines are wrapped anew every time; it is their contours that tell them apart.
    const shapes: OutlineShape[] = [{ contours: [[[0, 0], [1, 0], [0, 1]]], evenodd: false }];
    client.syncAssets({ 'text:a': lettering(shapes) });
    client.syncAssets({ 'text:a': lettering(shapes) });
    expect(workers[0].assets()).toEqual(['m', 'n', 'm', 'text:a']);
  });

  it('lets the worker forget what a closed design used, and sends it again when it is back', () => {
    const { client, workers } = setup();
    const assets = { m: mesh(), n: mesh() };
    client.syncAssets(assets);
    client.forgetAssets(['n']);
    expect(workers[0].last()).toEqual({ type: 'forgetAssets', keep: ['n'] });
    client.syncAssets(assets);
    expect(workers[0].assets()).toEqual(['m', 'n', 'm']);
  });

  it('drops the outlines of lettering no longer in use once they pile up, the oldest first', () => {
    const { client, workers } = setup();
    client.syncAssets({ m: mesh() });
    // The outlines of a string are laid out once and handed over as often as a build needs them.
    const laidOut = new Map<string, OutlineShape[]>();
    const send = (...keys: string[]) => {
      for (const key of keys) if (!laidOut.has(key)) laidOut.set(key, []);
      client.syncAssets(Object.fromEntries(keys.map((key) => [key, lettering(laidOut.get(key))])));
    };
    // A label typed letter by letter: every stage of it was sent.
    for (const key of ['text:H', 'text:He', 'text:Hel', 'text:Hell', 'text:Hello']) send(key);
    client.forgetLettering(new Set(['text:Hello']), 4);
    expect(workers[0].posted.some((m) => m.type === 'forgetAssets')).toBe(false);
    send('text:Hello!');
    client.forgetLettering(new Set(['text:Hello!']), 4);
    // Five were idle: the three oldest go; imported data and what is in use stay.
    expect(workers[0].last()).toEqual({ type: 'forgetAssets', keep: ['m', 'text:Hell', 'text:Hello', 'text:Hello!'] });
    // One that went is sent again when it is back (an undo); one that stayed is not.
    send('text:He', 'text:Hell');
    expect(workers[0].assets().slice(-2)).toEqual(['text:Hello!', 'text:He']);
    // Using one again makes it the last to go.
    send('text:Hello');
    send('text:1');
    client.forgetLettering(new Set(), 4);
    expect(workers[0].last()).toEqual({ type: 'forgetAssets', keep: ['m', 'text:Hello', 'text:1'] });
  });

  it('calls off everything under way, and starts afresh for what is asked next', async () => {
    const { client, workers } = setup();
    client.syncAssets({ m: mesh() });
    const grouping = client.measure([box]);
    const building = client.build('k', box);
    client.cancel();
    await expect(grouping).rejects.toBeInstanceOf(Cancelled);
    await expect(building).rejects.toBeInstanceOf(Cancelled);
    expect(workers[0].terminated).toBe(true);
    // The next request goes to a fresh worker, which is handed the imported data again.
    const asset = mesh();
    client.syncAssets({ m: asset });
    const again = client.build('k', box);
    expect(workers).toHaveLength(2);
    expect(workers[1].assets()).toEqual(['m']);
    workers[1].say({ type: 'built', id: workers[1].ids()[0], result: result('k') });
    expect((await again).key).toBe('k');
    // The worker that was let go has nothing more to say.
    workers[0].say({ type: 'built', id: workers[0].ids()[1], result: result('stale') });
    // With nothing under way there is nothing to call off: the worker stays.
    client.cancel();
    expect(workers[1].terminated).toBe(false);
  });

  it('hands a file over to be read, or copies it when it is to be read again', () => {
    const { client, workers } = setup();
    const file = { name: 'a.stl', bytes: new Uint8Array(8), path: '/somewhere/a.stl' };
    const library = { name: 'a.mtl', bytes: new Uint8Array(2) };
    void client.import(file, [library], { handOver: true }).catch(() => undefined);
    expect(workers[0].last()).toMatchObject({ type: 'import', name: 'a.stl', companions: [{ name: 'a.mtl' }] });
    // Only what the worker needs goes over: not where the file is on this device.
    expect(Object.keys(workers[0].last()).sort()).toEqual(['bytes', 'companions', 'id', 'name', 'type']);
    expect(workers[0].handedOver()).toEqual([file.bytes.buffer]);
    void client.import(file, [], { scale: 25.4 }).catch(() => undefined);
    expect(workers[0].last()).toMatchObject({ scale: 25.4 });
    expect(workers[0].handedOver()).toEqual([]);
    // A piece of a larger buffer is copied whatever was asked: handing it over would take its neighbours along.
    const piece = { name: 'b.stl', bytes: new Uint8Array(new ArrayBuffer(16), 4, 8) };
    void client.import(piece, [], { handOver: true }).catch(() => undefined);
    expect(workers[0].handedOver()).toEqual([]);
    client.dispose();
  });

  it('fails what is waiting when it is stopped', async () => {
    const { client, workers } = setup();
    const waiting = client.measure([box]);
    client.dispose();
    await expect(waiting).rejects.toThrow('The geometry worker was stopped');
    expect(workers[0].terminated).toBe(true);
  });
});
