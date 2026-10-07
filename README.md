<h1 align="center">
  <img src="docs/banner.svg" alt="BashCAD" width="100%">
</h1>

Fast solid modelling for 3D printing: a desktop app for bashing out a part from
a few simple shapes.
Drop boxes, cylinders and wedges on the plate, turn some of them into holes,
group them, and export a file for your slicer. Every design keeps its own
version history.

Runs locally on Linux, Windows and macOS; nothing leaves your machine. Free
software under the GPL-3.0.

## How it works

It is the Tinkercad way of modelling, without the cloud and without the clutter:

- **Shapes** – box (with rounded edges), cylinder, sphere, cone, pyramid,
  wedge, roof, round roof, polygon prism, tube, torus and dome. Click one, then
  click on the plate (or on top of another object) to put it down.
- **Text** – lettering in four print-friendly fonts (sans, slab serif,
  monospace, stencil), on one line or several. Put it on a face and group it
  to emboss; make it a hole and sink it in a little (Ctrl+Down) to engrave.
- **Fillet** – an edge cutter that comes in as a hole. Line it up with an edge
  (select both, then Align), group, and the edge is rounded; with one step it
  cuts a straight chamfer instead.
- **Solid or hole** – any object can add material or cut it away.
- **Group** – merges the selected solids and cuts the holes out of them. Groups
  can be grouped again, turned into holes themselves, and taken apart at any
  time: nothing is ever baked in. Grouping only holes gives one hole: a
  connector cut-out with its screw holes becomes a single template to drop
  into any panel.
- **Structure** – a grouped object shows its history as a tree in the panel:
  primitives on the left, each grouping a node further right, branches merging
  where things were grouped together. Hover a node to see that part on the
  plate; pick one and *Edit here* takes the groupings apart down to it, so the
  part can be changed, and *Done* puts them back together in the same order.
- **Handles** – drag an object to move it, the corner and edge grips to size it,
  the arrow to lift it, the coloured arcs to turn it. Or type exact numbers in
  the panel on the right.
- **Import** – STL, OBJ and 3MF meshes, and SVG drawings (extruded into a
  plate), which then behave like any other object. Drop files on the window.

## Versions

A design remembers where it has been.

- **Save version** keeps the design as it is now, with a name and a thumbnail.
- Click a version to look at it, **restore** it to carry on from there (the
  state you left is one undo away), or export it directly.
- Saving after restoring an old version starts a branch: every version records
  which one it was made from.
- Versions live inside the design file, so they travel with it. No account, no
  server, no folder of `bracket-v3-final-2.stl`.

A `.bashcad` file is plain JSON, written to diff well: keys in a fixed order,
one property per line, vectors on a single line. If you keep designs in git,
a change to one object shows up as a change to a few lines.

```json
{
  "id": "k5u5gu2a",
  "type": "shape",
  "name": "Box",
  "shape": "box",
  "pos": [0,0,10],
  "rot": [0,0,0],
  "size": [20,20,20],
  "color": "#8fa3bf"
}
```

The app also keeps a copy of the open design between sessions, so an unsaved
design is still there after a restart.

## Mouse and keyboard

| | |
| --- | --- |
| Orbit / pan / zoom | Right drag / middle drag (or Shift + right drag) / wheel |
| Select | Click; Shift-click adds; drag on the plate for a box selection |
| Move | Drag (Shift keeps to one axis); arrow keys nudge by the snap step, Shift ×10 |
| Raise or lower | Arrow handle; Ctrl+Up / Ctrl+Down |
| Resize | Corner and edge grips, top grip for the height; Shift scales evenly |
| Turn | Coloured arcs, in 15° steps; Shift 45°, Alt 1° |
| Duplicate / copy / paste | Ctrl+D / Ctrl+C / Ctrl+V |
| Group / ungroup | Ctrl+G / Ctrl+Shift+G |
| Solid / hole | S / H |
| Drop onto the plate | D |
| Flip (mirror) on an axis | X / Y / Z |
| Turn 90° about an axis | Shift+X / Shift+Y / Shift+Z; add Alt to turn the other way |
| Align | L shows anchor dots on the selection: hover one to preview, click to apply; click one of the objects to make it the anchor, Esc to finish |
| Align by key | Alt+← / → / ↓ / ↑ (left / right / front / back), Alt+PgDn / PgUp (bottom / top); add Shift to centre on that axis; Alt+C centres on X and Y |
| Fit to view | F |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Save / save as / open / new | Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+N |
| Import | Ctrl+I |
| Save a version | Ctrl+Shift+V |

## Export formats

| Format | Use |
| --- | --- |
| STL | 3D mesh for any slicer |
| 3MF | 3D mesh with units, preferred by modern slicers |
| OBJ | 3D mesh for modelling tools |
| SVG | Outline of the design seen from above, for laser cutters and vector editors |
| DXF | The same outline, to extrude in CAD or cut on a laser / CNC |

Everything visible that is not a hole is merged into one watertight mesh, or
just the selection when something is selected. Units are millimetres, Z is up.

## Import notes

- **STL / OBJ** carry no units; coordinates are taken as millimetres.
- A mesh that is not watertight can be placed, scaled and exported as it is,
  but cannot be grouped: there is no telling its inside from its outside.
- **3MF**: all objects on the build plate come in as one mesh; colours and
  slicer settings are ignored.
- **SVG**: every closed outline is filled and extruded, whatever its stroke or
  fill (so laser-cutter drawings work, including the profiles exported by
  [Gearwright](https://github.com/AOShei/gearwright)). Convert text to
  paths first; `<use>`, images and CSS classes are not read.

## Fonts

Text is set in fonts that ship with the app, so a design looks the same on
every machine: [Inter](https://rsms.me/inter/) (sans),
[Roboto Slab](https://github.com/googlefonts/robotoslab) (slab serif),
[JetBrains Mono](https://www.jetbrains.com/lp/mono/) (monospace) and
[Allerta Stencil](https://fonts.google.com/specimen/Allerta+Stencil), all in
bold or heavy cuts with Latin and extended Latin characters. Inter, JetBrains
Mono and Allerta Stencil are under the SIL Open Font License 1.1; Roboto Slab
is under the Apache License 2.0; the licence texts are in
`public/font-licenses/` and ship with the app. A design stores only the
words, not their outlines.

## Development

Requirements: [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io),
[Rust](https://rustup.rs), and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
platform.

```sh
pnpm install
pnpm tauri dev      # run the desktop app with hot reload
pnpm dev            # or just the UI, in a browser at http://localhost:1420
pnpm test           # model, geometry and file-format tests
pnpm typecheck
pnpm tauri build    # build installers into src-tauri/target/release/bundle
```

The app icon is drawn in `src-tauri/app-icon.svg` (Windows and Linux) and
`src-tauri/app-icon-macos.svg` (the same mark with the margin macOS expects).
After editing them, regenerate the bitmaps with `pnpm tauri icon` — see
[the Tauri docs](https://tauri.app/develop/icons/).

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds installers
for all three platforms and attaches them to a draft GitHub release.

### How it is put together

```
src/
  model/              the design: nodes, transforms, grouping, the file format
  geometry/
    shapes.ts         the basic shapes: their parameters and how each is built
    kernel.ts         turns nodes into meshes (Manifold kernel), with caching
  worker/             runs the kernel off the UI thread
  state/              the editor: selection, undo, versions, files, preferences
  viewer/             three.js view: drawing, picking, handles
  io/                 STL, 3MF, OBJ, SVG, DXF writers; STL, OBJ, 3MF, SVG readers
  text/               fonts, and laying words out as outlines
  ui/                 React components
  platform.ts         desktop app or plain browser: dialogs, files, drops
src-tauri/            native window, file dialogs, reading and writing files (Rust)
```

A design is a flat list of nodes: shapes, imports, and groups of nodes. A node
has a position, a rotation and a size, and nothing else is stored: no meshes,
no history of operations. Solids are computed from that description by
[Manifold](https://github.com/elalish/manifold) (WebAssembly), which guarantees
watertight results from every union and cut.

What keeps it fast: the geometry of a node is cached under a key that leaves
out where the node is, how it is turned and (for most shapes) how big it is.
Moving, turning and resizing therefore only change a matrix on the graphics
card; the kernel runs when a shape's form changes or a group is made, and then
only for that node. Undo, redo and switching versions reuse the same cache.

### Adding a shape

1. Add its kind to `ShapeKind` in `src/model/types.ts`.
2. Describe it in `SHAPES` in `src/geometry/shapes.ts` (name, default size,
   parameters) and build it in `buildShape`, centred on the origin and filling
   its bounding box.
3. Draw its catalog picture in `src/ui/thumbnails.tsx`.

The palette, inspector, file format and export pick it up from there.

## Roadmap

- Gearwright parts as a shape family (gears, pulleys and threads straight from
  the palette).
- Work plane on any face, ruler and snapping to other objects.
- Text on curved surfaces; more scripts and fonts.
- STEP export.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
