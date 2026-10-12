// Paints the pixels of a skin: decodes the images a design carries and lays
// them out on a canvas, which the viewer draws and the GLB export embeds.
// Decoding is asynchronous; `paint` answers with what it has and calls
// `onReady` once the rest has arrived.
import { ATLAS_PAD, cellRect, layoutAtlas, skinAssets } from '../geometry/skin';
import type { Skin } from '../geometry/skin';
import { base64ToBytes } from '../io/base64';
import type { Asset, ImageAsset } from '../model/types';

export interface Painted {
  canvas: HTMLCanvasElement;
  /** Where each of the skin's pictures sits, as texture coordinates (v up). */
  rects: [number, number, number, number][];
}

type Decoded = { state: 'loading' } | { state: 'ready'; image: ImageBitmap } | { state: 'failed' };

export class SkinPainter {
  private images = new Map<string, Decoded>();
  private painted = new Map<string, Painted>();

  constructor(private readonly onReady: () => void) {}

  /** The bytes of an image asset, as they came in. */
  static bytes(asset: ImageAsset): Uint8Array {
    return base64ToBytes(asset.data);
  }

  /** The decoded image, if it is in; starts decoding it otherwise. */
  image(key: string, assets: Record<string, Asset>): ImageBitmap | null {
    const have = this.images.get(key);
    if (have?.state === 'ready') return have.image;
    if (have) return null;
    const asset = assets[key];
    if (asset?.kind !== 'image') {
      this.images.set(key, { state: 'failed' });
      return null;
    }
    this.images.set(key, { state: 'loading' });
    createImageBitmap(new Blob([SkinPainter.bytes(asset) as BlobPart], { type: asset.mime })).then(
      (image) => {
        this.images.set(key, { state: 'ready', image });
        this.onReady();
      },
      () => this.images.set(key, { state: 'failed' }),
    );
    return null;
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
      g.fillStyle = skin.color;
      g.fillRect(0, 0, width, height);
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
    for (const d of this.images.values()) if (d.state === 'ready') d.image.close();
    this.images.clear();
    this.painted.clear();
  }
}

export { ATLAS_PAD };
