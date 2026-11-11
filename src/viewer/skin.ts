// Paints the pixels of a skin: decodes the images a design carries and lays
// them out on a canvas, which the viewer draws and the GLB export embeds.
// Decoding is asynchronous; `paint` answers with what it has and calls
// `onReady` once the rest has arrived.
import { cellRect, layoutAtlas, skinAssets } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { base64ToBytes } from '../io/base64';
import type { Asset, ImageAsset } from '../model/types';

export interface Painted {
  canvas: HTMLCanvasElement;
  /** Where each of the skin's pictures sits, as texture coordinates (v up). */
  rects: [number, number, number, number][];
}

/** `of` is the asset a failure was for (none: the design had no such image), so that another one under the same key is tried. */
type Decoded = { state: 'loading' } | { state: 'ready'; image: ImageBitmap } | { state: 'failed'; of: Asset | undefined };

export class SkinPainter {
  private images = new Map<string, Decoded>();
  private painted = new Map<string, Painted>();
  private disposed = false;

  constructor(private readonly onReady: () => void) {}

  /** The bytes of an image asset, as they came in. */
  static bytes(asset: ImageAsset): Uint8Array {
    return base64ToBytes(asset.data);
  }

  /** The decoded image, if it is in; starts decoding it otherwise. */
  image(key: string, assets: Record<string, Asset>): ImageBitmap | null {
    const have = this.images.get(key);
    if (have?.state === 'ready') return have.image;
    const asset = assets[key];
    // A failure stands for the asset it was for: one that arrives later, or replaces it, is tried afresh.
    if (have && (have.state === 'loading' || have.of === asset)) return null;
    if (asset?.kind !== 'image') {
      this.images.set(key, { state: 'failed', of: asset });
      return null;
    }
    const loading: Decoded = { state: 'loading' };
    this.images.set(key, loading);
    // Either way whoever is waiting is told, so that a failed picture is reported rather than waited for forever.
    createImageBitmap(new Blob([SkinPainter.bytes(asset) as BlobPart], { type: asset.mime })).then(
      (image) => {
        // Let go of in the meantime (see `retain`): nobody is waiting for it.
        if (this.disposed || this.images.get(key) !== loading) return image.close();
        this.images.set(key, { state: 'ready', image });
        this.onReady();
      },
      () => {
        if (this.disposed || this.images.get(key) !== loading) return;
        this.images.set(key, { state: 'failed', of: asset });
        this.onReady();
      },
    );
    return null;
  }

  /**
   * Lets go of everything but the images and paintings named: the decoded
   * pictures of objects that are gone, or no longer wear them, would otherwise
   * stay in memory for as long as the app runs.
   */
  retain(images: ReadonlySet<string>, paintings: ReadonlySet<string>): void {
    for (const [key, decoded] of this.images) {
      if (images.has(key)) continue;
      if (decoded.state === 'ready') decoded.image.close();
      this.images.delete(key);
    }
    for (const key of this.painted.keys()) if (!paintings.has(key)) this.painted.delete(key);
  }

  /**
   * The skin's pixels under `key` (see skinKey, plus whatever else they
   * depend on), or null while an image is still being decoded. A picture
   * sheet keeps the picture's transparency, so the sheet can be seen through,
   * unless `opaque` asks for it flattened onto the color (as an export needs).
   */
  paint(key: string, skin: Skin, assets: Record<string, Asset>, opaque = false): Painted | null {
    const have = this.painted.get(key);
    if (have) return have;
    const keys = skinAssets(skin);
    const images = keys.map((k) => this.image(k, assets));
    const failed = keys.find((k) => this.images.get(k)?.state === 'failed');
    if (failed !== undefined) throw new Error(`The picture "${assets[failed]?.kind === 'image' ? assets[failed].name : failed}" could not be read.`);
    if (images.some((i) => i === null)) return null;
    const ready = images as ImageBitmap[];
    const canvas = document.createElement('canvas');
    let rects: Painted['rects'];
    if (skin.kind === 'stickers') {
      const { width, height, cells } = layoutAtlas(ready);
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d')!;
      // Around the pictures a mixed group's surface shows its parts' own colors, which the corners carry; white leaves them as they are.
      g.fillStyle = skin.mixed ? '#ffffff' : skin.color;
      g.fillRect(0, 0, width, height);
      if (skin.mixed) {
        g.fillStyle = skin.color;
        for (const c of cells) g.fillRect(c.x, c.y, c.w, c.h);
      }
      cells.forEach((c, i) => g.drawImage(ready[i], c.x, c.y, c.w, c.h));
      rects = cells.map((c) => cellRect(c, width, height));
    } else {
      const image = ready[0];
      canvas.width = image.width;
      canvas.height = image.height;
      const g = canvas.getContext('2d')!;
      // A transparent picture shows the object's color through; only a sheet is left see-through.
      if (skin.kind === 'texture' || opaque) {
        g.fillStyle = skin.color;
        g.fillRect(0, 0, image.width, image.height);
      }
      g.drawImage(image, 0, 0);
      rects = [[0, 0, 1, 1]];
    }
    const result = { canvas, rects };
    this.painted.set(key, result);
    // Paintings nobody asks for again are dropped once there are many.
    if (this.painted.size > 64) {
      const first = this.painted.keys().next().value;
      if (first !== undefined && first !== key) this.painted.delete(first);
    }
    return result;
  }

  /** PNG bytes of a painting, for export. */
  static async png(painted: Painted): Promise<Uint8Array> {
    const blob = await new Promise<Blob | null>((resolve) => painted.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The picture could not be encoded.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.images.values()) if (d.state === 'ready') d.image.close();
    this.images.clear();
    this.painted.clear();
    // Nothing more is coming: anyone still waiting for a painting is let go.
    this.onReady();
  }
}
