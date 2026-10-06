// Built geometry, shared by the viewer (to draw it) and the editor (to know
// the true bounds of things). Entries are keyed by `geomKey`, so they survive
// moves, turns, undo and version switches without ever being rebuilt.
import { geomKey } from '../model/geomKey';
import { boxBounds, emptyBounds, nodeMatrix } from '../model/math';
import type { Bounds } from '../model/math';
import type { Asset, Scene, SceneNode } from '../model/types';
import { GeometryClient } from '../worker/client';
import type { BuildResult } from '../worker/protocol';

export type GeomEntry = { state: 'pending' } | { state: 'ready'; result: BuildResult } | { state: 'error'; message: string };

const KEEP = 400;

class GeometryStore {
  private client: GeometryClient | null = null;
  private entries = new Map<string, GeomEntry>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private tight = new WeakMap<SceneNode, { result: BuildResult; bounds: Bounds }>();

  /** The worker is started on first use. */
  worker(): GeometryClient {
    this.client ??= new GeometryClient();
    return this.client;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever an entry does; lets React re-render on arrival of geometry. */
  readonly getRevision = (): number => this.revision;

  get(node: SceneNode): GeomEntry | undefined {
    return this.entries.get(geomKey(node));
  }

  /** Request whatever the given top-level nodes need and is not there yet. */
  ensure(nodes: Scene, assets: Record<string, Asset>): void {
    let asked = false;
    for (const node of nodes) {
      const key = geomKey(node);
      const entry = this.entries.get(key);
      if (entry) {
        // Refresh its place in the eviction order.
        this.entries.delete(key);
        this.entries.set(key, entry);
        continue;
      }
      if (!asked) {
        this.worker().syncAssets(assets);
        asked = true;
      }
      this.entries.set(key, { state: 'pending' });
      this.worker()
        .build(key, node)
        .then(
          (result) => this.settle(key, { state: 'ready', result }),
          (e: Error) => this.settle(key, { state: 'error', message: e.message }),
        );
    }
    if (this.entries.size > KEEP) {
      const wanted = new Set(nodes.map(geomKey));
      for (const [key, entry] of this.entries) {
        if (this.entries.size <= KEEP) break;
        if (entry.state !== 'pending' && !wanted.has(key)) this.entries.delete(key);
      }
    }
  }

  /**
   * Axis-aligned bounds of a node in its parent's coordinates: tight (from the
   * actual surface) once the geometry is there, else those of its box.
   */
  bounds(node: SceneNode): Bounds {
    const entry = this.get(node);
    if (entry?.state !== 'ready') return boxBounds(node);
    const cached = this.tight.get(node);
    if (cached && cached.result === entry.result) return cached.bounds;
    const m = nodeMatrix(node);
    const p = entry.result.render.positions;
    const bounds = emptyBounds();
    if (p.length === 0) return boxBounds(node);
    // Written out rather than calling apply(): imported meshes have millions of corners.
    const { min, max } = bounds;
    for (let i = 0; i < p.length; i += 3) {
      for (let r = 0; r < 3; r++) {
        const v = m[r] * p[i] + m[3 + r] * p[i + 1] + m[6 + r] * p[i + 2] + m[9 + r];
        if (v < min[r]) min[r] = v;
        if (v > max[r]) max[r] = v;
      }
    }
    this.tight.set(node, { result: entry.result, bounds });
    return bounds;
  }

  private settle(key: string, entry: GeomEntry): void {
    // An entry evicted while it was being built is simply dropped.
    if (!this.entries.has(key)) return;
    this.entries.set(key, entry);
    this.revision++;
    for (const l of this.listeners) l();
  }
}

export const geometry = new GeometryStore();
