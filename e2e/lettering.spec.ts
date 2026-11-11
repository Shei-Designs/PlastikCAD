// Lettering in the built app: the fonts and the scripts beyond Latin, fetched when lettering first
// needs them, and built into a closed solid whatever the letters do (those of a script run into
// each other).
import { drawnMesh, expect, notices, openApp, settled, store, test } from './helpers';

test.describe('lettering', { tag: '@mouse' }, () => {
  const cases: [string, string, string][] = [
    ['the condensed font', 'condensed', 'Hello 42'],
    ['the rounded font', 'rounded', 'Hello 42'],
    ['the script font, whose letters join', 'script', 'Hello there'],
    ['Cyrillic', 'sans', 'Привет'],
    ['Greek', 'serif', 'Ωμέγα'],
    ['Vietnamese', 'mono', 'Việt Nam'],
    ['Greek in the stencil, which has none of its own', 'stencil', 'Ω 10 kΩ'],
  ];
  for (const [what, font, text] of cases) {
    test(`${what} is set and built as a closed solid`, async ({ page, errors }) => {
      await openApp(page);
      const done = await store(
        page,
        async (m, { font, text }) => {
          await m.addText();
          return m.editText(m.getState().doc.scene[0].id, { font, text });
        },
        { font, text },
      );
      expect(done, 'the lettering has something to draw').toBe(true);
      await settled(page);
      const node = await store(page, (m) => {
        const n = m.getState().doc.scene[0];
        return n.type === 'text' ? { font: n.font, text: n.text, width: n.size[0] } : null;
      });
      expect(node).toMatchObject({ font, text });
      expect(node!.width).toBeGreaterThan(10);
      const mesh = await drawnMesh(page);
      expect(mesh.watertight).toBe(true);
      expect(mesh.triangles).toBeGreaterThan(100);
      expect((await notices(page)).filter((n) => n.kind === 'error')).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});
