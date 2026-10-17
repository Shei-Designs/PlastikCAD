import type { Bounds } from '../model/math';
import type { Asset, PartNode, SceneNode } from '../model/types';
import type { BuildResult, ColoredExport, ExportResult, WorkerRequest, WorkerResponse } from './protocol';

interface Waiting {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

type Outgoing = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Promise-based front end of the geometry worker. Requests are answered in the order they were sent. */
export class GeometryClient {
  private worker: Worker;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();
  private sentAssets = new Set<string>();

  constructor() {
    this.worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      const error = new Error(e.message || 'The geometry worker crashed');
      for (const w of this.waiting.values()) w.reject(error);
      this.waiting.clear();
    };
  }

  /** Hand over imported data the worker has not seen yet. Call before sending nodes that use it. */
  syncAssets(assets: Record<string, Asset>): void {
    const fresh: Record<string, Asset> = {};
    let any = false;
    for (const key of Object.keys(assets)) {
      // Pictures are drawn on the main thread; the kernel never needs their pixels.
      if (this.sentAssets.has(key) || assets[key].kind === 'image') continue;
      this.sentAssets.add(key);
      fresh[key] = assets[key];
      any = true;
    }
    if (any) this.worker.postMessage({ type: 'assets', assets: fresh } satisfies WorkerRequest);
  }

  /** Let the worker drop every asset but these; anything else is sent again when next needed. */
  forgetAssets(keep: Iterable<string>): void {
    const wanted = new Set(keep);
    let any = false;
    for (const key of [...this.sentAssets]) {
      if (wanted.has(key)) continue;
      this.sentAssets.delete(key);
      any = true;
    }
    if (any) this.worker.postMessage({ type: 'forgetAssets', keep: [...wanted] } satisfies WorkerRequest);
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

  dispose(): void {
    this.worker.terminate();
    const error = new Error('The geometry worker was stopped');
    for (const w of this.waiting.values()) w.reject(error);
    this.waiting.clear();
  }

  private send<T>(request: Outgoing): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      this.worker.postMessage({ ...request, id });
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
