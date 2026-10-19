// Draws the PlastikCAD brand assets after the Shei Designs design system:
// the product tile (Tape square, "PC" in Inter 800, Carbon) and the README banner.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const root = path.resolve(__dirname, '..', '..');
const load = (p) => { const b = fs.readFileSync(p); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const F = (name) => path.join(root, 'node_modules/@fontsource', name);
const inter800 = load(F('inter/files/inter-latin-800-normal.woff'));
const inter400 = load(F('inter/files/inter-latin-400-normal.woff'));
const grotesk = load('/home/andrew/.local/share/fonts/freqverb/SpaceGrotesk-Medium.ttf');
const mono = load(F('jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff'));
const CARBON = '#0A0907', TAPE = '#FF6B1A', LINEN = '#E8E4D8', DUST = '#8A8580';
const TILE = 'M26 6 H74 A20 20 0 0 1 94 26 V74 A20 20 0 0 1 74 94 H26 A20 20 0 0 1 6 74 V26 A20 20 0 0 1 26 6 Z';

// Path data written out plainly (opentype's own writer drops into shorthand curves and produces NaN now and then).
const n = (v) => (Math.round(v * 100) / 100).toString();
const pathData = (commands) => commands.map((c) => (c.type === 'Z' ? 'Z' : c.type === 'Q' ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}` : c.type === 'C' ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}` : `${c.type}${n(c.x)} ${n(c.y)}`)).join('');

// Text as a path laid out glyph by glyph (opentype.js cannot shape Inter's
// substitution tables), with the font's own kerning and optional tracking in em.
function text(font, str, x, y, size, opts = {}) {
  const scale = size / font.unitsPerEm;
  const out = new opentype.Path();
  let pen = x;
  let previous = null;
  for (const char of str) {
    const glyph = font.charToGlyph(char);
    if (previous) pen += font.getKerningValue(previous, glyph) * scale;
    // The glyph's own outline, scaled and placed by hand (opentype's getPath loses a control point now and then).
    const sx = pen, sy = y;
    let lx = 0, ly = 0;
    for (const c of glyph.path.commands) {
      if (c.type === 'Z') out.commands.push({ type: 'Z' });
      // A control coordinate opentype leaves out (its TrueType reader does, once in JetBrains Mono's "a") continues from the last point.
      else if (c.type === 'Q') out.commands.push({ type: 'Q', x1: sx + (c.x1 ?? lx) * scale, y1: sy - (c.y1 ?? ly) * scale, x: sx + c.x * scale, y: sy - c.y * scale });
      else if (c.type === 'C') out.commands.push({ type: 'C', x1: sx + c.x1 * scale, y1: sy - c.y1 * scale, x2: sx + c.x2 * scale, y2: sy - c.y2 * scale, x: sx + c.x * scale, y: sy - c.y * scale });
      else out.commands.push({ type: c.type, x: sx + c.x * scale, y: sy - c.y * scale });
      if (c.type !== 'Z') (lx = c.x), (ly = c.y);
    }
    pen += glyph.advanceWidth * scale + (opts.tracking ?? 0) * size;
    previous = glyph;
  }
  return { d: pathData(out.commands), width: pen - x, bbox: out.getBoundingBox() };
}

// --- the tile: "PC" filling 70 of the 100 units, centred on the tile ---------
function glyph(width, cx, cy) {
  const probe = text(inter800, 'PC', 0, 0, 100, { tracking: -0.02 });
  const w = probe.bbox.x2 - probe.bbox.x1;
  const size = (100 * width) / w;
  const t = text(inter800, 'PC', 0, 0, size, { tracking: -0.02 });
  const b = t.bbox;
  // Shift so the ink's box is centred on (cx, cy).
  return text(inter800, 'PC', cx - (b.x1 + b.x2) / 2, cy - (b.y1 + b.y2) / 2, size, { tracking: -0.02 }).d;
}
const pc = glyph(70, 50, 50);
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${TILE}" fill="${TAPE}"/><path d="${pc}" fill="${CARBON}"/></svg>\n`;
fs.writeFileSync(path.join(root, 'docs/brand/icon.svg'), icon);
fs.writeFileSync(path.join(root, 'public/icon.svg'), icon);
// The transparent and linen variants of the design system, for use on Tape surfaces.
fs.writeFileSync(path.join(root, 'docs/brand/icon-linen.svg'), icon.replace(`fill="${CARBON}"`, `fill="${LINEN}"`));
// Android adaptive icon: the glyph alone over a full-bleed Tape background; the launcher cuts the shape.
fs.writeFileSync(path.join(root, 'docs/brand/android-fg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${glyph(44, 50, 50)}" fill="${CARBON}"/></svg>\n`);
fs.writeFileSync(path.join(root, 'docs/brand/android-bg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${TAPE}"/></svg>\n`);
// macOS wants its icons inset further than the rest (the tile sits in a 100-unit box at 82%).
fs.writeFileSync(path.join(root, 'docs/brand/icon-macos.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(9 9) scale(0.82)"><path d="${TILE}" fill="${TAPE}"/><path d="${pc}" fill="${CARBON}"/></g></svg>\n`);

// --- the banner: 1280 x 360, Carbon, tile + name + one-liner + mono metadata + Shei Designs ------
const name = text(grotesk, 'PlastikCAD', 328, 176, 96);
const line = text(inter400, 'Fast solid modelling for 3D printing.', 330, 228, 30);
const meta = text(mono, 'linux · windows · macos · android      gpl-3.0      stl · 3mf · obj · glb · svg · dxf', 332, 276, 17);
const shei = text(inter800, 'Shei Designs', 0, 0, 22, { tracking: -0.02 });
const sheiX = 1184 - shei.width - 14;
const sheiPath = text(inter800, 'Shei Designs', sheiX, 318, 22, { tracking: -0.02 });
const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 360" role="img" aria-labelledby="t">
  <title id="t">PlastikCAD: fast solid modelling for 3D printing. A Shei Designs project.</title>
  <rect width="1280" height="360" rx="28" fill="${CARBON}"/>
  <g transform="translate(80 80) scale(2)"><path d="${TILE}" fill="${TAPE}"/><path d="${pc}" fill="${CARBON}"/></g>
  <path d="${name.d}" fill="${LINEN}"/>
  <path d="${line.d}" fill="${LINEN}" opacity="0.86"/>
  <path d="${meta.d}" fill="${DUST}"/>
  <path d="${sheiPath.d}" fill="${LINEN}"/>
  <circle cx="${(sheiX + shei.width + 8).toFixed(1)}" cy="314" r="4" fill="${TAPE}"/>
</svg>
`;
fs.writeFileSync(path.join(root, 'docs/banner.svg'), banner);
console.log('name width', name.width.toFixed(0), 'meta width', meta.width.toFixed(0), 'shei x', sheiX.toFixed(0));
