// Draws the PlastikCAD brand assets after the Shei Designs design system and its
// product rules (design-reference/PRODUCTS.md): the product tile, a teal square
// with the cube-and-hole mark in Carbon, its Android and macOS variants, and the README banner.
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
// PlastikCAD's own colour from the product register, and the one shade the mark may add: Carbon with a quarter of the tile in it.
const TEAL = '#17CDD3', SHADE = '#0D3A3A';
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

// --- the tile: PlastikCAD's mark on its colour, after the Shei Designs product rules (PRODUCTS.md) ---
// The mark is the cube with a round hole through it, drawn as three faces in its own
// 1024 box; `place` scales it so its 912-unit height takes `height` units of the 100 box.
const TOP = 'M471.5 67.4Q512 44 552.5 67.4L835.2 230.6Q875.7 254 835.2 277.4L552.5 440.6Q512 464 471.5 440.6L188.8 277.4Q148.3 254 188.8 230.6ZM343.2 254A168.8 97.4 0 1 0 680.8 254A168.8 97.4 0 1 0 343.2 254Z';
const LEFT = 'M106.7 372.8Q106.7 326 147.2 349.4L429.9 512.6Q470.4 536 470.4 582.8L470.4 909.2Q470.4 956 429.9 932.6L147.2 769.4Q106.7 746 106.7 699.2Z';
const RIGHT = 'M553.6 582.8Q553.6 536 594.1 512.6L876.8 349.4Q917.3 326 917.3 372.8L917.3 699.2Q917.3 746 876.8 769.4L594.1 932.6Q553.6 956 553.6 909.2Z';
const mark = (height, cx = 50, cy = 50) => {
  const k = (height / 912).toFixed(5);
  return `<g transform="translate(${cx} ${cy}) scale(${k}) translate(-512 -500)"><path d="${TOP}" fill="${CARBON}" fill-rule="evenodd"/><path d="${LEFT}" fill="${CARBON}"/><path d="${RIGHT}" fill="${SHADE}"/></g>`;
};
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${TILE}" fill="${TEAL}"/>${mark(64)}</svg>\n`;
fs.writeFileSync(path.join(root, 'docs/brand/icon.svg'), icon);
fs.writeFileSync(path.join(root, 'public/icon.svg'), icon);
// Android adaptive icon: the mark alone over a full-bleed background; the launcher cuts the shape.
fs.writeFileSync(path.join(root, 'docs/brand/android-fg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${mark(44)}</svg>\n`);
fs.writeFileSync(path.join(root, 'docs/brand/android-bg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${TEAL}"/></svg>\n`);
// macOS wants its icons inset further than the rest (the tile sits in a 100-unit box at 82%).
fs.writeFileSync(path.join(root, 'docs/brand/icon-macos.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(9 9) scale(0.82)"><path d="${TILE}" fill="${TEAL}"/>${mark(64)}</g></svg>\n`);

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
  <g transform="translate(80 80) scale(2)"><path d="${TILE}" fill="${TEAL}"/>${mark(64)}</g>
  <path d="${name.d}" fill="${LINEN}"/>
  <path d="${line.d}" fill="${LINEN}" opacity="0.86"/>
  <path d="${meta.d}" fill="${DUST}"/>
  <path d="${sheiPath.d}" fill="${LINEN}"/>
  <circle cx="${(sheiX + shei.width + 8).toFixed(1)}" cy="314" r="4" fill="${TAPE}"/>
</svg>
`;
fs.writeFileSync(path.join(root, 'docs/banner.svg'), banner);
console.log('name width', name.width.toFixed(0), 'meta width', meta.width.toFixed(0), 'shei x', sheiX.toFixed(0));
