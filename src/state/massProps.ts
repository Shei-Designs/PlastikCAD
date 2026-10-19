// The mass properties of the robot's links, asked of the kernel as the panels
// need them and kept by what they depend on: a node's built geometry, where it
// is, how it is turned and how big. React reads them through `subscribe`.
import { geomKey } from '../model/geomKey';
import type { Asset, SceneNode } from '../model/types';
import type { LinkProperties } from '../worker/protocol';
import { geometry } from './geometry';

const KEEP = 300;
/** A drag changes a node every frame; the kernel is asked once it settles. */
const SETTLE_MS = 150;

const propsKey = (node: SceneNode): string => `${geomKey(node)}|${node.pos}|${node.rot}|${node.size}|${node.flip ?? ''}`;

class MassPropsStore {
  private entries = new Map<string, LinkProperties>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: { nodes: SceneNode[]; assets: Record<string, Asset> } | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = (): number => this.revision;

  get(node: SceneNode): LinkProperties | undefined {
    const key = propsKey(node);
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** The properties of every node given, by id, as far as they are known. */
  known(nodes: SceneNode[]): Map<string, LinkProperties> {
    const out = new Map<string, LinkProperties>();
    for (const node of nodes) {
      const p = this.get(node);
      if (p) out.set(node.id, p);
    }
    return out;
  }

  /** Asks for whatever these nodes lack, once they have held still for a moment. */
  ensure(nodes: SceneNode[], assets: Record<string, Asset>): void {
    const missing = nodes.filter((n) => {
      const key = propsKey(n);
      return !this.entries.has(key) && !this.pending.has(key);
    });
    if (missing.length === 0) return;
    this.waiting = { nodes: missing, assets };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fetch(), SETTLE_MS);
  }

  private async fetch(): Promise<void> {
    const batch = this.waiting;
    this.waiting = null;
    if (!batch) return;
    const nodes = batch.nodes.filter((n) => !this.entries.has(propsKey(n)) && !this.pending.has(propsKey(n)));
    if (nodes.length === 0) return;
    const keys = nodes.map(propsKey);
    for (const key of keys) this.pending.add(key);
    try {
      const worker = await geometry.prepare(nodes, batch.assets);
      const results = await worker.massProperties(nodes);
      results.forEach((p, i) => this.entries.set(keys[i], p));
      while (this.entries.size > KEEP) this.entries.delete(this.entries.keys().next().value!);
      this.revision++;
      for (const l of this.listeners) l();
    } catch (e) {
      console.error(e);
    } finally {
      for (const key of keys) this.pending.delete(key);
    }
  }
}

export const massProps = new MassPropsStore();
