// Picture sheets: the decoded image and the painting made from it are kept while an object
// wears them and let go when none does, and an image that cannot be read is reported once.
import type { Page } from '@playwright/test';
import { dropFiles, expect, openApp, pngBytes, settled, skins, store, test, wearsSkin } from './helpers';

test.describe('pictures', () => {
  /** The picture sheet on the plate. */
  let picture: string;

  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await dropFiles(page, [{ name: 'label.png', bytes: await pngBytes(page) }]);
    await expect.poll(() => pictureId(page), 'the dropped file becomes a picture on the plate').not.toBeNull();
    picture = (await pictureId(page))!;
    await settled(page);
  });

  const pictureId = (page: Page): Promise<string | null> => store(page, (m) => m.getState().doc.scene.find((n) => n.type === 'picture')?.id ?? null);

  test('a picture dropped on the app is decoded and drawn', async ({ page }) => {
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
  });

  test('deleting a picture lets its image and its painting go, and undo decodes it afresh', async ({ page }) => {
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.deleteSelected();
      },
      picture,
    );
    await expect.poll(() => skins(page)).toEqual({ images: [], painted: 0, worn: 0 });
    await store(page, (m) => m.undo());
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
  });

  test('a ghosted picture keeps its decoded image, and wears it again as soon as it comes back', async ({ page }) => {
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
    await store(
      page,
      (m, id) => {
        m.select([id]);
        m.ghostSelected();
      },
      picture,
    );
    // Kept decoded, so that it does not flash when it comes back; the painting is not needed meanwhile.
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 0 });
    await store(page, (m) => m.unghostAll());
    await expect.poll(() => skins(page)).toMatchObject({ images: ['ready'], worn: 1 });
  });

  test('a picture whose image cannot be read is reported once, not on every change, and drawn once the image is there', async ({ page, errors }) => {
    const image = await store(page, (m) => Object.keys(m.getState().doc.assets)[0]);
    // The picture now names an image the design does not have.
    await store(page, (m, id) => m.updateNode(id, { asset: 'gone' } as never), picture);
    for (let i = 0; i < 6; i++) {
      await store(
        page,
        (m, id) => {
          m.select([id]);
          m.nudgeSelected([1, 0, 0]);
        },
        picture,
      );
      await page.waitForTimeout(60);
    }
    expect(errors.filter((e) => e.includes('could not be read'))).toHaveLength(1);
    // The node names the real image again: it is tried again and drawn.
    await store(page, (m, [id, image]) => m.updateNode(id, { asset: image } as never), [picture, image] as [string, string]);
    await expect.poll(() => wearsSkin(page, picture)).toBe(true);
  });
});
