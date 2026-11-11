import { isTextAsset } from '../model/geomKey';
import type { Bounds } from '../model/math';
import type { Asset, PartNode, SceneNode } from '../model/types';
import type { CollisionKind } from '../robot/types';
import type { BuildResult, ColoredExport, ExportResult, LinkGeometry, LinkProperties, WorkerRequest, WorkerResponse } from './protocol';

interface Waiting {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

type Outgoing = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

const startWorker = (): Worker => new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });

const versions = new WeakMap<object, number>();
let nextVersion = 1;

/**
 * A number for the data of an asset as it was handed over: the same again
 * only for the very same object (the same contours, for outlines, which are
 * wrapped anew each time). Telling costs nothing and keeps no data alive; a
 * copy that only looks the same is sent again, and the worker sees that it is.
 */
function versionOf(asset: Asset): number {
  const data: object = asset.kind === 'outline' ? asset.shapes : asset;
  let version = versions.get(data);
  if (version === undefined) {
    version = nextVersion++;
    versions.set(data, version);
  }
  return version;
}

/**
 * Promise-based front end of the geometry worker. Requests are answered in
 * the order they were sent. A worker that dies is replaced when next needed.
 */
export class GeometryClient {
  private worker: Worker | null;
  private nextId = 1;
  /** In the order they were sent. */
  private waiting = new Map<number, Waiting>();
  /** What the worker holds, by name and version (see `versionOf`), least recently handed over first. */
  private sentAssets = new Map<string, number>();

  constructor(private readonly start: () => Worker = startWorker) {
    this.worker = this.connect();
  }

  private connect(): Worker {
    const worker = this.start();
    // A worker that has been replaced has nothing more to say.
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (worker === this.worker) this.onMessage(e.data);
    };
    worker.onerror = (e) => {
      if (worker === this.worker) this.died(e.message);
    };
    worker.onmessageerror = () => {
      if (worker === this.worker) this.unread();
    };
    return worker;
  }

  /** The worker now in use: the first one, or the one started after that died. */
  private live(): Worker {
    this.worker ??= this.connect();
    return this.worker;
  }

  /** The worker stopped on an error it did not catch. What it was working on is lost; the next request starts another. */
  private died(reason: string): void {
    this.worker?.terminate();
    this.worker = null;
    // The next worker starts with no imported data: `syncAssets` hands all of it over again.
    this.sentAssets.clear();
    this.fail(new Error(`The geometry worker crashed${reason ? ` (${reason})` : ''} and was restarted.`));
  }

  /** An answer arrived that could not be read (too large for the memory at hand, as a rule): that of the oldest request. */
  private unread(): void {
    const first = this.waiting.entries().next();
    if (first.done) return;
    const [id, w] = first.value;
    this.waiting.delete(id);
    w.reject(new Error('The answer of the geometry worker could not be read; it may have been too large.'));
  }

  private fail(error: Error): void {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.reject(error);
  }

  /** Hand over imported data the worker does not have yet, or has an older version of. Call before sending nodes that use it. */
  syncAssets(assets: Record<string, Asset>): void {
    const fresh: Record<string, Asset> = {};
    let any = false;
    for (const key of Object.keys(assets)) {
      const asset = assets[key];
      // Pictures are drawn on the main thread; the kernel never needs their pixels.
      if (asset.kind === 'image') continue;
      const version = versionOf(asset);
      const sent = this.sentAssets.get(key);
      // Moved to the end either way: the latest used are the last to be dropped.
      this.sentAssets.delete(key);
      this.sentAssets.set(key, version);
      if (sent === version) continue;
      fresh[key] = asset;
      any = true;
    }
    if (any) this.live().postMessage({ type: 'assets', assets: fresh } satisfies WorkerRequest);
  }

  /** Let the worker drop every asset but these; anything else is sent again when next needed. */
  forgetAssets(keep: Iterable<string>): void {
    const wanted = new Set(keep);
    let any = false;
    for (const key of [...this.sentAssets.keys()]) {
      if (wanted.has(key)) continue;
      this.sentAssets.delete(key);
      any = true;
    }
    if (any) this.live().postMessage({ type: 'forgetAssets', keep: [...wanted] } satisfies WorkerRequest);
  }

  /**
   * Let the worker drop the outlines of lettering that is not `used`, once more than `spare` of them
   * have piled up: a label being typed leaves one behind at every keystroke. The latest half of the
   * spare ones stay, for an undo or a build still on its way.
   */
  forgetLettering(used: ReadonlySet<string>, spare: number): void {
    const idle = [...this.sentAssets.keys()].filter((key) => isTextAsset(key) && !used.has(key));
    if (idle.length <= spare) return;
    for (const key of idle.slice(0, idle.length - Math.floor(spare / 2))) this.sentAssets.delete(key);
    this.live().postMessage({ type: 'forgetAssets', keep: [...this.sentAssets.keys()] } satisfies WorkerRequest);
  }

  build(key: string, node: SceneNode): Promise<BuildResult> {
    return this.send({ type: 'build', key, node });
  }

  measure(nodes: SceneNode[]): Promise<Bounds | null> {
    return this.send({ type: 'measure', nodes });
  }

  /** A part's box in its generator's own frame (built geometry is otherwise centered). */
  partBox(node: PartNode): Promise<Bounds | null> {
    return this.send({ type: 'partBox', node });
  }

  export(nodes: SceneNode[], outline: boolean, fine: boolean, local = false): Promise<ExportResult> {
    return this.send({ type: 'export', nodes, outline, fine, local });
  }

  /** Every node placed, one closed part per color: what a colored mesh format carries. */
  exportColored(nodes: SceneNode[], fine: boolean, local = false): Promise<ColoredExport> {
    return this.send({ type: 'exportColored', nodes, fine, local });
  }

  /** Volume, area, centroid and inertia of each node as placed in the design. */
  massProperties(nodes: SceneNode[]): Promise<LinkProperties[]> {
    return this.send({ type: 'massProperties', nodes });
  }

  /** Each node as a robot link: visual parts, collision shape and mass properties, placed in the design. */
  robotGeometry(nodes: SceneNode[], collisions: Record<string, CollisionKind>, fine: boolean): Promise<LinkGeometry[]> {
    return this.send({ type: 'robotGeometry', nodes, collisions, fine });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.sentAssets.clear();
    this.fail(new Error('The geometry worker was stopped'));
  }

  private send<T>(request: Outgoing): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      this.live().postMessage({ ...request, id });
    });
  }

  private onMessage(msg: WorkerResponse): void {
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    if (msg.type === 'error') w.reject(new Error(msg.message));
    else if (msg.type === 'built') w.resolve(msg.result as never);
    else if (msg.type === 'measured' || msg.type === 'partBoxed') w.resolve(msg.bounds as never);
    else w.resolve(msg.result as never);
  }
}
