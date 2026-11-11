// Built geometry, shared by the viewer (to draw it) and the editor (to know
// the true bounds of things). Entries are keyed by `geomKey`, so they survive
// moves, turns, undo and version switches without ever being rebuilt.
import { geomKey, textAssetKey } from '../model/geomKey';
import { apply, boxBounds, emptyBounds, expandBounds, nodeMatrix, squareTurn } from '../model/math';
import type { Bounds } from '../model/math';
import type { Asset, Scene, SceneNode, TextNode } from '../model/types';
import { fontReady, loadFont, outlineOf } from '../text/fonts';
import { GeometryClient } from '../worker/client';
import type { BuildResult } from '../worker/protocol';

export type GeomEntry = { state: 'pending' } | { state: 'ready'; result: BuildResult } | { state: 'error'; message: string };

const KEEP = 400;
/** How many outlines of lettering that no node shows any more the worker may hold on to. */
const SPARE_LETTERING = 32;

/** The lettering in a scene, at any depth. */
function textNodes(nodes: Scene, out: TextNode[] = []): TextNode[] {
  for (const node of nodes) {
    if (node.type === 'text') out.push(node);
    else if (node.type === 'group') textNodes(node.children, out);
  }
  return out;
}

class GeometryStore {
  private client: GeometryClient | null = null;
  private entries = new Map<string, GeomEntry>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private tight = new WeakMap<SceneNode, { result: BuildResult; bounds: Bounds }>();
  private wanted: { nodes: Scene; assets: Record<string, Asset> } | null = null;
  private fetching = new Set<string>();
  /** Nodes with a build under way, by id, and the key of it; a newer key for the same node waits its turn. */
  private inFlight = new Map<string, string>();
  private deferred = new Map<string, string>();
  /** Whether outlines of lettering have gone to the worker since the ones out of use were last let go. */
  private lettered = false;

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

  /** A design was closed: the worker keeps only the imported data of the one now open. */
  forgetAssets(keep: Iterable<string>): void {
    this.client?.forgetAssets(keep);
  }

  /** Request whatever the given top-level nodes need and is not there yet. */
  ensure(nodes: Scene, assets: Record<string, Asset>): void {
    this.wanted = { nodes, assets };
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
      // Lettering waits for its font; this runs again when the font is in.
      if (!this.sendLettering(node)) continue;
      if (!asked) {
        this.worker().syncAssets(assets);
        asked = true;
      }
      this.entries.set(key, { state: 'pending' });
      // While this node is still being built at an older key (a slider mid-drag, lettering being typed),
      // the new key waits, and a newer one again takes its place: the worker never queues stale shapes.
      if (this.inFlight.has(node.id)) {
        const stale = this.deferred.get(node.id);
        if (stale && stale !== key && this.entries.get(stale)?.state === 'pending') this.entries.delete(stale);
        this.deferred.set(node.id, key);
        continue;
      }
      this.start(node.id, key, node);
    }
    if (this.lettered) {
      // Every change to a label's words leaves its outlines with the worker; the ones no longer shown are let go.
      this.lettered = false;
      this.client?.forgetLettering(new Set(textNodes(nodes).map(textAssetKey)), SPARE_LETTERING);
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
   * Builds a node's geometry ahead of its appearance in the scene, and resolves
   * once it is there (or has failed), so that a change can be shown the moment
   * it is applied rather than through a frame of the old shape at the new size.
   */
  ready(node: SceneNode, assets: Record<string, Asset>): Promise<void> {
    const key = geomKey(node);
    if (!this.entries.has(key)) {
      if (!this.sendLettering(node)) return Promise.resolve();
      this.worker().syncAssets(assets);
      this.entries.set(key, { state: 'pending' });
      this.start(node.id, key, node);
    }
    if (this.entries.get(key)?.state !== 'pending') return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        const entry = this.entries.get(key);
        if (entry && entry.state !== 'pending') {
          off();
          resolve();
        } else if (!entry) {
          off();
          resolve();
        }
      });
    });
  }

  /**
   * The worker, with everything it needs to work on these nodes: imported
   * data, and the outlines of any lettering (once its fonts have loaded).
   */
  async prepare(nodes: Scene, assets: Record<string, Asset>): Promise<GeometryClient> {
    await Promise.all([...new Set(textNodes(nodes).map((t) => t.font))].map(loadFont));
    for (const node of nodes) this.sendLettering(node);
    const worker = this.worker();
    worker.syncAssets(assets);
    return worker;
  }

  /** Hands the worker the outlines of the lettering in `node`. False while a font for it is still loading. */
  private sendLettering(node: SceneNode): boolean {
    const texts = textNodes([node]);
    if (texts.length === 0) return true;
    const outlines: Record<string, Asset> = {};
    let ready = true;
    for (const text of texts) {
      if (!fontReady(text.font)) {
        ready = false;
        this.fetchFont(text.font);
        continue;
      }
      const outline = outlineOf(text);
      if (outline) outlines[textAssetKey(text)] = { kind: 'outline', shapes: outline.shapes };
    }
    if (ready) {
      this.worker().syncAssets(outlines);
      this.lettered = true;
    }
    return ready;
  }

  private fetchFont(id: string): void {
    if (this.fetching.has(id)) return;
    this.fetching.add(id);
    loadFont(id)
      .then(() => {
        if (this.wanted) this.ensure(this.wanted.nodes, this.wanted.assets);
      }, console.error)
      .finally(() => this.fetching.delete(id));
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
    const bounds = emptyBounds();
    if (squareTurn(node.rot)) {
      // Square to the axes, the kernel's own (double precision) box maps corner to corner. The
      // drawn mesh is single precision, and a bound off by a hair means a face missed by a hair.
      const { min, max } = entry.result.bounds;
      for (let i = 0; i < 8; i++) expandBounds(bounds, apply(m, [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]));
      this.tight.set(node, { result: entry.result, bounds });
      return bounds;
    }
    const p = entry.result.render.positions;
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

  private start(id: string, key: string, node: SceneNode): void {
    this.inFlight.set(id, key);
    this.worker()
      .build(key, node)
      .then(
        (result) => this.settle(key, { state: 'ready', result }),
        (e: Error) => this.settle(key, { state: 'error', message: e.message }),
      )
      .finally(() => {
        if (this.inFlight.get(id) === key) this.inFlight.delete(id);
        const next = this.deferred.get(id);
        if (next === undefined) return;
        this.deferred.delete(id);
        // Whatever the node's key is by now is what gets built; a waiting key it has moved on from is dropped.
        if (this.entries.get(next)?.state === 'pending') this.entries.delete(next);
        if (this.wanted) this.ensure(this.wanted.nodes, this.wanted.assets);
      });
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
