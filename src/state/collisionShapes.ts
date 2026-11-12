// What each of the robot's links collides as, as triangles in the design, for
// the plate to draw. A box, a cylinder or a sphere is made here; a hull or the
// shape itself is asked of the kernel once the link holds still, and kept by
// what it depends on. React reads them through `subscribe`.
import type { MeshData } from '../geometry/mesh';
import type { Asset, SceneNode } from '../model/types';
import { collisionPrimitive, primitiveMesh } from '../robot/collision';
import type { CollisionKind } from '../robot/types';
import { Cancelled } from '../worker/client';
import { geometry } from './geometry';
import { propsKey } from './massProps';

const KEEP = 300;
/** A drag changes a node every frame; the kernel is asked once it settles. */
const SETTLE_MS = 150;

type Kinds = Record<string, CollisionKind>;

const keyOf = (node: SceneNode, kind: CollisionKind): string => `${kind}|${propsKey(node)}`;
const kindOf = (node: SceneNode, kinds: Kinds): CollisionKind => kinds[node.id] ?? 'hull';

class CollisionShapesStore {
  private entries = new Map<string, MeshData | null>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: { nodes: SceneNode[]; kinds: Kinds; assets: Record<string, Asset> } | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = (): number => this.revision;

  /** The shape of every node given, by id, as far as it is known; a link that collides with nothing has none. */
  known(nodes: SceneNode[], kinds: Kinds): Map<string, MeshData> {
    const out = new Map<string, MeshData>();
    for (const node of nodes) {
      const kind = kindOf(node, kinds);
      if (kind === 'none') continue;
      const key = keyOf(node, kind);
      let mesh = this.entries.get(key);
      if (mesh === undefined && (kind === 'box' || kind === 'cylinder' || kind === 'sphere')) {
        mesh = primitiveMesh(collisionPrimitive(node, kind));
        this.keep(key, mesh);
      }
      if (mesh) out.set(node.id, mesh);
    }
    return out;
  }

  /** Asks the kernel for the hulls and meshes these nodes lack, once they have held still for a moment. */
  ensure(nodes: SceneNode[], kinds: Kinds, assets: Record<string, Asset>): void {
    const missing = nodes.filter((n) => {
      const kind = kindOf(n, kinds);
      const key = keyOf(n, kind);
      return (kind === 'hull' || kind === 'mesh') && !this.entries.has(key) && !this.pending.has(key);
    });
    if (missing.length === 0) return;
    this.waiting = { nodes: missing, kinds, assets };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fetch(), SETTLE_MS);
  }

  private keep(key: string, mesh: MeshData | null): void {
    this.entries.set(key, mesh);
    while (this.entries.size > KEEP) this.entries.delete(this.entries.keys().next().value!);
  }

  private async fetch(): Promise<void> {
    const batch = this.waiting;
    this.waiting = null;
    if (!batch) return;
    const nodes = batch.nodes.filter((n) => !this.entries.has(keyOf(n, kindOf(n, batch.kinds))) && !this.pending.has(keyOf(n, kindOf(n, batch.kinds))));
    if (nodes.length === 0) return;
    const keys = nodes.map((n) => keyOf(n, kindOf(n, batch.kinds)));
    for (const key of keys) this.pending.add(key);
    try {
      const worker = await geometry.prepare(nodes, batch.assets);
      const results = await worker.collisionMeshes(nodes, batch.kinds);
      results.forEach((mesh, i) => this.keep(keys[i], mesh));
      this.revision++;
      for (const l of this.listeners) l();
    } catch (e) {
      if (!(e instanceof Cancelled)) console.error(e);
      // Called off along with something else the worker was doing: asked for again.
      else if (!this.waiting) {
        this.waiting = { nodes, kinds: batch.kinds, assets: batch.assets };
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.fetch(), SETTLE_MS);
      }
    } finally {
      for (const key of keys) this.pending.delete(key);
    }
  }
}

export const collisionShapes = new CollisionShapesStore();
