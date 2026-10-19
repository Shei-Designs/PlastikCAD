<h1 align="center">
  <img src="docs/banner.svg" alt="PlastikCAD: fast solid modelling for 3D printing" width="100%">
</h1>

Fast solid modeling for 3D printing: a desktop app for bashing out a part from
a few simple shapes.
Drop boxes, cylinders and wedges on the plate, add a gear, a pulley or a
threaded rod made to your numbers, turn some of it into holes, group, and
export a file for your slicer.

Runs locally on Linux, Windows, macOS and Android; nothing leaves your machine
unless you link a Google Drive. Free software under the GPL-3.0.

PlastikCAD is a [Shei Designs](https://sheidesigns.com) project, designed and
built by [Andrew O'Shei](https://andrewoshei.com).

PlastikCAD supersedes [Gearwright](https://github.com/AOShei/gearwright): every
part type and parameter it had is in here, as objects you can combine with
everything else.

## How it works

It is the Tinkercad way of modeling, without the cloud and without the clutter:

- **Shapes** – box and cylinder (both with optional rounded edges), sphere,
  cone, pyramid, wedge, roof, round roof, polygon prism, torus and dome. Click
  one, then click on the plate (or on top of another object) to put it down.
- **Parts** – the Gear, Pulley and Screw tiles place a parametric part. The
  panel shows what it is for, a picture menu of the kinds in that family, the
  parameters in tabs (gear, tooth form, hub, bore; thread, head; and so on),
  the dimensions that follow from them (pitch diameter, outside diameter,
  center distance...). A part is just an object: group it, cut it, scale it.
  See
  [Parts](#parts) for the list.
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
  into any panel. A group keeps each part in its own color until a color is
  picked for it, which paints the whole; ungrouping gives the parts their
  colors back. The colors go out with a GLB export.
- **Array** – copies of the selection in a row, a grid or a stack at a set
  spacing, or around a ring. Select a hole together with the plate it goes in and
  *Fit* spreads the copies over the plate, a set distance in from its edges:
  four corner holes in one go. For a ring, put the hole where the middle of
  the bolt circle goes and type its radius or diameter; or leave the hole where
  it is and ring it around the middle of the plate, or around any point. The
  pattern shows live while the numbers are typed.
- **Structure** – a grouped object shows its history as a tree in the panel:
  primitives on the left, each grouping a node further right, branches merging
  where things were grouped together. Hover a node to see that part on the
  plate; pick one and *Edit here* takes the groupings apart down to it, so the
  part can be changed, and *Done* puts them back together in the same order.
- **Notes** – words attached to an object, typed in the Notes box at the
  bottom of the Structure tab. A note stays with its part through
  grouping and ungrouping; a part with one shows an info mark in the tree.
- **Handles** – drag an object to move it, the corner and edge grips to size
  it (the top and bottom grips pull the height either way), the arrow to lift
  it, the colored arcs to turn it. Click a grip instead of dragging it and a
  box appears on that edge to type the value. Or type exact numbers in the
  panel on the right.
- **Import** – the button at the bottom of the library (or Ctrl+I) takes STL,
  OBJ, 3MF and GLB meshes, SVG and DXF drawings (extruded into a plate) and PNG or JPEG
  pictures; meshes and drawings then behave like any other object. Drop files
  on the window.
- **Pictures** – the Picture tile in the library (or importing a PNG or JPEG)
  puts the picture on a sheet. Flat, it prints straight through onto the first
  surface behind it that faces it; wrapped, it is a band around its own axis,
  facing the front, that prints inwards onto the first surface facing out. Move,
  size and turn it like anything else, then group it with the object and the
  picture is on the surface: a pun on the side of a mug, a label on a box.
  Surfaces hidden behind others stay clean, so the far wall of a cup does not
  get the picture through the near one. The object's own color shows
  everywhere the picture does not reach. An object can also wear a
  **texture** over its whole surface instead (under the colors in its
  Material settings): a picture wrapped once around
  it, bottom to top, turned to any side, or tiled every so many millimeters
  from every side, for patterns and materials. Pictures and textures are for
  scenes and renders, not printing: they travel in GLB exports and are left
  off the others.

## Parts

| Gears | Pulleys & sprockets | Screws & threads | Rails & frames | Pipes & ducts | Dev boards | Fans | Panel cutouts | Motor mounts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spur gear | GT2 timing pulley (2 / 3 / 5 mm) | Metric bolt / threaded rod (M3–M20) | Aluminum rail: 20, 30 and 40 mm series, V-slot or T-slot, one to four cells in one or two rows (2020, 2040, 4040, 3030, 3060, 6060, 4080...) | Straight pipe or duct | Raspberry Pi 5, 4, 3, Zero 2 W, Pico | Fan, 25–140 mm: the cutout (clear, or with a guard pattern of rings, slots, honeycomb or grid cut into the wall) | Panel connector: Neutrik D-series, IEC C14 / C13 / C8, D-sub 9 / 15 / 25, XT60, with their screw holes | Stepper: NEMA 8, 11, 14, 17, 23 and the 28BYJ-48 |
| Helical gear | HTD timing pulley (3M / 5M / 8M) | Metric nut | | Elbow (any angle and bend radius, legs either side) | Arduino Uno R3/R4, Mega 2560, Nano | Screw holes only, for an opening of your own | | Gearmotor: N20, TT, 25 mm (JGA25), 37 mm (JGB37) |
| Herringbone gear | T-series timing pulley (T2.5 / T5 / T10) | Trapezoidal lead screw (multi-start) | | Reducer (in line or eccentric) | ESP32-DevKitC V4, DevKit V1, NodeMCU-32S | Printed grill with the same patterns, to screw over the fan | | Servo: SG90, MG996R |
| Internal ring gear | MXL / XL timing pulley | Lead screw nut (flanged) | | Tee / wye (branch at any angle) | | The fan itself: frame, hub and blades of a typical fan, to check clearance | | DC motor: 775, 130 |
| Gear rack (straight, helical, herringbone) | Chain sprocket (#25–#41, 05B–08B, bicycle) | | | | | | | |
| Bevel gear (90° shafts) | | | | | | | | |
| Worm | | | | | | | | |

Rotating parts share the same options for the shaft: round, D-shaft, hex or
keyed bore with a fit clearance, plus an optional hub with set-screw holes.
Pipes and ducts are round or rectangular (with rounded corners), hollow with a
wall or solid, and the bends are true arcs, the tapers true frustums; a solid
elbow makes a good hole to cut a curved channel with.
A dev board part knows the board's outline, mounting holes and sockets from
its maker's drawing and makes one of five things from them: standoffs at the
holes, drilled for the screw to cut its thread, for a clearance fit or for a
heat-set insert, on an optional base plate; the holes alone, as pins to group
with a floor or lid as a hole; a blank the shape of the board, to check fit
or, grown by a gap, to pocket a floor; the board with its connectors in place,
each reaching out past the edge, to design a case round and, made a hole, to
cut the wall openings exactly where the plugs go; or corner stops, which hold
the ESP32 dev kits and anything else without holes. The ESP32 figures are the least certain: only
Espressif's own DevKitC has a published drawing, so the part says so.
A motor mount knows the motor's mounting face from its maker's drawing: the
bolt pattern, the pilot boss or the body that drops through, and the shaft.
It makes a plate with the holes and the bore, the holes alone as a cutter, the
motor itself as a body to design round (or, made a hole, to pocket for), or an
L-bracket standing the plate on a slotted, gusseted foot.
A fan part knows the frame, screw pattern and opening of an axial fan from
25 to 140 mm and makes one of four things: the cutout, clear or filled with a
guard pattern (rings on spokes, slots, honeycomb or a grid, with the bar and
opening widths yours to set) that is cut straight into the wall when the part
is made a hole; the screw holes alone; a printed grill the size of the fan
with the same patterns, to screw over it; or the fan itself, a stand-in with
the frame, hub and blades of a typical fan that size, to check clearance and
design round.
A panel cutout is an opening a wall needs that is worth looking up rather
than drawing: a connector's cutout with its screw holes as its maker draws
it, grown by a clearance. Fans and cutouts come lying flat, centered on the
wall, and are turned like anything else to face through a side; make the
cutout a hole and group it with the wall.
The rail is there to design around: make it a hole and group it with a block
to get a bracket that fits the real thing. It comes in as a 20 mm stub; its
height is its length, so pull the top grip or type the H size to make it as
long as you need.
Only the kind and its parameters are stored in the design; the geometry is
made from them.

### Custom parts

Anything you have built can go back into the library. Select an object (a
group counts as one; group several objects first to keep them as one part)
and press the save-as-part button beside its name in the right panel. The
object goes into the **Custom** bin, with its structure intact, standing at
the middle of the plate. The Custom tile in the library opens the bin in the
right panel: search, sort by name or recency, pick a part and click on the
plate to place it, or double-click it to add it at the middle. Each part can
be renamed or deleted from its menu. Custom parts are kept beside your
projects (a `Parts` folder inside the projects folder on desktop) and synced
to Google Drive with them.

## Robot mode

The robot button in the project bar turns the design into a robot for ROS 2,
RViz, Gazebo and anything else that reads URDF. Every top-level object is a
link (group what belongs together first); joints say how the links move
against each other. The left panel shows the links as a tree hanging from the
base link, the right panel sets up whatever is picked, and the design itself
is not touched: leave the mode and everything is as it was. The robot is saved
in the design file and synced with it.

- **Base link.** Pick the object the rest hangs from, on the right while
  nothing is selected or with *Make base* on a link.
- **Joints.** Select a link and attach it to another: a joint is made with the
  link as the child, placed on the child's box where it comes nearest the
  parent, and picked, drawn as a rod along its axis on the plate. Set its kind
  (revolute, continuous, prismatic, fixed), its origin and axis in the design's
  coordinates, its limits, effort, velocity, damping and friction, and whether
  it follows another joint (URDF `mimic`, for the passive joints of a linkage).
  A joint stays with its child: move the child and the joint comes along.
- **Mass.** Each link is weighed from its shape and material: pick a material
  (filaments, resin, metals, acrylic, wood, foam...) and, for a printed part,
  the infill and the shell thickness, or type the mass you weighed. The
  volume, surface, mass, center of mass and principal moments of inertia are
  shown; the inertia tensor goes into the file.
- **Collision.** A convex hull by default, or the bounding box, the exact
  mesh, or none; and the surface's coefficient of friction for Gazebo.
- **Checks.** The overview lists what stops an export (no base, a link no
  joint reaches, limits the wrong way round, a link with no mass or an
  impossible inertia) and what is only worth knowing (a joint that closes a
  loop, an open mesh, a heavy collision mesh), each with a *Show* button.
- **Export** writes a zip holding a ROS 2 package: `urdf/<name>.urdf`, a
  colored OBJ per link under `meshes/visual` and an STL under
  `meshes/collision`, `package.xml`, `CMakeLists.txt`, a launch file for RViz
  with joint sliders and one for Gazebo through `ros_gz`, and an RViz layout.
  Meters, kilograms and radians, Z up; every link's frame is parallel to the
  design's axes and sits at its joint, with its meshes written in that frame.

Loops (a four-bar linkage, a parallel gripper) can be built: the joint that
closes a loop is kept in the design and listed as a warning, since URDF cannot
hold it; mark the passive joints as following the driven one. SDF export,
which keeps loops, drive and sensor presets and `ros2_control` blocks are next.

## Projects

Designs are projects, and a project is saved as you work: a second after the
last change, and when the window is hidden or closed. There is no Save. The
dot by the project name shows while a change is still being written.

On desktop, projects are `.plastikcad` files in a projects folder, `PlastikCAD` in
your Documents folder unless you pick another in the projects browser (Ctrl+O).
(The app used to be called BashCAD: a `BashCAD` folder from then is renamed on
the first start, its `.bashcad` files with it, and a `.bashcad` file still opens.)
The browser lists every project with a thumbnail, newest first, to open,
rename, duplicate or delete them; renaming a project renames its file. On
Android, projects live in the app's own storage, and a copy saved for sharing
goes to `Download/PlastikCAD`. In a plain browser they are kept by the browser
itself, per profile.

Two commands move designs in and out of the projects folder. **Open project
file…** (Ctrl+Shift+O, also dropping or double-clicking a `.plastikcad` file,
or opening one from the Files app on Android) brings a copy in as a project
of its own, with a fresh id, so a file someone sent you never passes for one
of your own. A box says so, since edits go to the copy and not to the file,
and offers to delete the file. **Save a copy…** (Ctrl+Shift+S) writes the design
wherever you like, to share or keep; the project itself stays where it is.

### Google Drive

Projects can be kept in step across devices through Google Drive. In the
projects browser, **Link Google Drive…** signs you in with Google in your
browser; from then on PlastikCAD keeps a copy of every project in a `PlastikCAD`
folder at the top of your Drive (and of every custom part in a `Parts` folder
inside it) and syncs a few seconds after each save, when the app starts or
comes back online, every few minutes, and on **Sync now**. Exports are never
synced.

PlastikCAD asks only for access to files it created itself (Google's
`drive.file` permission), so it cannot read the rest of your Drive. The flip
side is that it also cannot see a project file you drop into that folder by
hand; bring such a file in with **Open project file…** instead.

A project edited on two devices before they sync is merged object by object.
When the same object was changed on both, both versions are kept: the other
device's copy appears as a project of its own, named "… (other device)", on
both devices. A project deleted on one device is deleted on the others,
unless it was changed there since, in which case it comes back.

Unlinking stops the syncing, tells Google the app no longer has access, and
leaves the projects where they are, here and in the Drive. While linked, the
sign-in tokens are kept in the app's own browser storage on the device, in
plain text like most desktop apps keep them; do not link on a shared account.

A `.plastikcad` file is plain JSON, written to diff well: keys in a fixed order,
one property per line, vectors on a single line. If you keep the projects
folder in git, a change to one object shows up as a change to a few lines,
plus the thumbnail line at the top.

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

## Mouse and keyboard

| | |
| --- | --- |
| Orbit / pan / zoom | Right drag / middle drag (or Shift + right drag) / wheel |
| Select | Click; Shift-click adds; drag on the plate for a box selection |
| Touch | One finger orbits, two pan and zoom; tap an object to select it, tap the plate to clear; hold an object (on the plate or in the Objects list) to add it to the selection; hold the plate and drag for a box selection |
| Move | Drag (Shift keeps to one axis); arrow keys nudge by the snap step, Shift ×10 |
| Raise or lower | Arrow handle; Ctrl+Up / Ctrl+Down |
| Resize | Corner and edge grips; the top grip pulls the height up, the bottom grip pulls it down; Shift scales evenly |
| Type a value | Click any grip instead of dragging it, type the value (two for a corner grip, e.g. `20 x 15`), Enter |
| Turn | Colored arcs, in 15° steps; Shift 45°, Alt 1° |
| Duplicate / copy / paste | Ctrl+D / Ctrl+C / Ctrl+V |
| Group / ungroup | Ctrl+G / Ctrl+Shift+G |
| Solid / hole | S / H |
| Drop onto the plate | D |
| Flip (mirror) on an axis | X / Y / Z |
| Turn 90° about an axis | Shift+X / Shift+Y / Shift+Z; add Alt to turn the other way |
| Align | L shows anchor dots on the selection: hover one to preview, click to apply; click one of the objects to make it the anchor, Esc to finish |
| Align by key | Alt+← / → / ↓ / ↑ (left / right / front / back), Alt+PgDn / PgUp (bottom / top); add Shift to center on that axis; Alt+C centers on X and Y |
| Fit to view | F |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Projects / open project file / new project / save a copy | Ctrl+O / Ctrl+Shift+O / Ctrl+N / Ctrl+Shift+S (Ctrl+S writes pending changes at once) |
| Import | Ctrl+I |

## Export formats

| Format | Use |
| --- | --- |
| STL | 3D mesh for any slicer |
| 3MF | 3D mesh with units and colors, preferred by modern slicers; a part per color for multi-material printing |
| OBJ | 3D mesh for modeling tools, with the colors in a material library beside it |
| GLB | 3D scene with colors, textures and pictures, for Blender, Godot, Unity and renderers |
| SVG | Outline of the design seen from above, for laser cutters and vector editors |
| DXF | The same outline, to extrude in CAD or cut on a laser / CNC |

The export button, at the bottom of the left panel, reads *Export selection* when something is selected and exports just
that; otherwise *Export* merges everything visible that is not a hole into one
watertight mesh (after asking, when there are several objects). On desktop a
save dialog asks where; on Android the app asks for a name, writes the file
to `Download/PlastikCAD` (an OBJ and its `.mtl` into a folder of their name
there), and says so in a box that offers *Share…* to hand it to another app
(an OBJ and its `.mtl` go as one zip). Units are millimeters, Z is up. A 3MF keeps every object separate, each with its color
as a base material; a group whose parts have colors of their own goes out as
one object made of a closed part per color, with nothing overlapping, which
slicers such as PrusaSlicer, OrcaSlicer, Bambu Studio and Cura can map to
filaments. A GLB keeps every object separate, each with its color
and, if it has one, its texture or pictures embedded as the image files they
came from; a group whose parts have colors of their own is one mesh with a
primitive per color. It is written Y up in meters, as glTF wants. An OBJ
carries its colors in a material library named after it, written beside it.
The other formats
carry the shapes alone and say so before exporting a design that has pictures
on it.

The file is made at a finer detail than the screen: round shapes, gear teeth
and threads get twice the facets they are drawn with, so prints come out
smooth while the editor stays quick. A cylinder set to a handful of sides is
left alone, since that is its shape.

## Import notes

- **STL / OBJ** carry no units; coordinates are taken as millimeters.
- A mesh that is not watertight can be placed, scaled and exported as it is,
  but cannot be grouped: there is no telling its inside from its outside.
- A file of several parts (the objects of a 3MF, the materials of an OBJ, the
  meshes of a GLB) comes in as one group, its parts where the file put them,
  each in its own color, so it looks as it did where it came from. Parts that
  are not watertight cannot be grouped, so they come in side by side instead;
  a GLB with pictures printed on it is one such, since the pictures' edges cut
  its triangles.
- **3MF**: every build item is a part, split further where its triangles
  carry different colors; colors come from the base materials and color
  groups. Textures and slicer settings are ignored.
- **OBJ**: the `.mtl` (the one the file names, or one named after it) and
  the pictures it names are read from beside the `.obj`, including the
  app's own exports on Android; only when they are not there are they asked
  for, where the picker grants one file at a time (Android, the browser).
  Each material comes in with its color (`Kd`)
  and picture (`map_Kd`), laid out by the file's texture coordinates. Without
  them, an OBJ comes in plain.
- **GLB / glTF**: meshes are placed by the scene's nodes and turned from Y up
  in meters to Z up in millimeters; each material brings its base color and
  picture, laid out by the file's texture coordinates. A `.gltf` must embed
  its buffers; one that keeps them in separate files should be saved as a
  `.glb` first. Files with Draco or meshopt compression are refused; export
  them again without compression.
- An imported picture shows on the mesh in the **Imported** texture mode; the
  mesh can still be given any other texture, wrapped or tiled.
- **SVG**: shapes are grouped by fill color, each group a part of its own.
  Every closed outline is filled and extruded, whatever its stroke or fill, so
  laser-cutter drawings work (including a gear profile exported from PlastikCAD
  as SVG). Convert text to paths first; `<use>`, images and CSS classes are
  not read.
- **DXF**: lines, polylines, circles, arcs, ellipses and splines are chained
  end to end into closed outlines and grouped by color (the entity's, else its
  layer's); a contour inside another is a hole. Blocks placed with INSERT are
  expanded, and `$INSUNITS` sets the scale, millimeters when unset. Open
  chains, text, dimensions and hatches are dropped; binary DXF is refused.

## How accurate are the parts?

- **Involute gears** are generated the way a real gear is cut: a rack cutter
  rolls around the blank. Flanks are true involutes, root fillets are the
  trochoids the cutter tip would leave, and small pinions get the same undercut
  a hobbed gear has (with a warning and the profile shift that removes it).
  Helical gears take the module and pressure angle in the normal plane.
- **Bevel gears** use Tredgold's approximation (the usual construction for cut
  and printed straight bevels), not a spherical involute.
- **Timing pulleys** use the standard pitch and outside diameters. The groove
  shapes are parametric fits to the belt standards rather than the
  manufacturers' multi-arc drawings, with a clearance setting to tune the fit
  on your printer.
- **Sprockets** use the common arc-based drafting construction, not the full
  ANSI B29.1 tooth form.
- **Threads** follow the ISO metric and ISO trapezoidal basic profiles, with a
  clearance setting for printing.
- **Extrusions** follow one maker's section drawing per size, the others
  being within a few tenths of it: OpenBuilds V-Slot for 20 mm, Misumi HFS6
  for 30 mm and HFS8 for 40 mm. Lip thickness, slot opening, channel width,
  the 45° taper down to the square core, bore, web thickness, outer corner
  radius and the corner holes (30) and hollows (40) are all read off the
  drawings; the T-slot is the same section with square lips, the V-slot the
  same with 45° lip tips. Where two cells meet, the cores and webs frame the
  hollow of the real 2040 with its short neck to the skin; where four meet,
  the middle is open with the cores' corners rounded, and in a two-row bar of
  three or four cells the inner cells get walls across it. The sectional areas
  come out within a few percent of the catalog figures (V-Slot 2020 about
  166 mm², HFS6-3030 333 mm², HFS8-4040 640 mm²). Left out are the small inner
  fillets and the scalloped bores, so check against the rail you have before
  relying on a tight fit.

Dimension tables (chain sizes, hex sizes, belt pitch-line offsets) were entered
by hand. Check critical dimensions against a datasheet before relying on them.

## Fonts

Text is set in fonts that ship with the app, so a design looks the same on
every machine: [Inter](https://rsms.me/inter/) (sans),
[Roboto Slab](https://github.com/googlefonts/robotoslab) (slab serif),
[JetBrains Mono](https://www.jetbrains.com/lp/mono/) (monospace) and
[Allerta Stencil](https://fonts.google.com/specimen/Allerta+Stencil), all in
bold or heavy cuts with Latin and extended Latin characters. Inter, JetBrains
Mono and Allerta Stencil are under the SIL Open Font License 1.1; Roboto Slab
is under the Apache License 2.0; the license texts are in
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
pnpm test           # model, geometry, part and file-format tests
pnpm typecheck
pnpm tauri build    # build installers into src-tauri/target/release/bundle
```

The icon and the banner follow the Shei Designs product rules: the shared
rounded tile in PlastikCAD's own teal, the cube-with-a-hole mark in Carbon,
the product name in Space Grotesk. `docs/brand/draw.cjs`
draws them (`node docs/brand/draw.cjs`), into `docs/brand/`, `public/icon.svg`
and `docs/banner.svg`; after a change, rasterize the tile at 1024 px
(`rsvg-convert`) and regenerate the platform icons, Android launcher icons
included, with `pnpm tauri icon docs/brand/icon.json` — see
[the Tauri docs](https://tauri.app/develop/icons/).

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds installers
for all three platforms and attaches them to a draft GitHub release.

### Google Drive sync in your own build

Sync talks to Google as an installed app and needs an OAuth client of your
own; without one the projects browser says sync is not set up. In the
[Google Cloud console](https://console.cloud.google.com/) create a project,
enable the Google Drive API, set up the OAuth consent screen (external, in
production; the only scope used is `drive.file`, which needs no
verification), and create two OAuth clients: one of type **Desktop app**,
with an id and a secret, and one of type **Android**, with no secret, given
the package name `com.sheidesigns.plastikcad` and the SHA-1 of the key the APK
is signed with (`keytool -list -v` prints it). Then build with them in the
environment:

```sh
VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com VITE_GOOGLE_CLIENT_SECRET=… VITE_GOOGLE_ANDROID_CLIENT_ID=…apps.googleusercontent.com pnpm tauri build
```

(or put them in a `.env.local`, which git ignores). For an installed app
Google does not treat the secret as secret. On desktop the sign-in opens the
system browser and comes back to a loopback port. On Android, Google takes
no redirect URL from an app, so Google Play services asks for the grant in
its own sheet and hands back access tokens; it finds the Android client by
the app's package name and signing key, and the Android client id in the
build only says that sync is set up there. A build signed with another key
(a debug build, Play App Signing) needs that key's SHA-1 on an Android
client too.

### How it is put together

```
src/
  model/              the design: nodes, transforms, grouping, the file format
  geometry/
    shapes.ts         the basic shapes: their parameters and how each is built
    kernel.ts         turns nodes into meshes (Manifold kernel), with caching
  worker/             runs the kernel off the UI thread
  state/              the editor: selection, undo, files, preferences
  viewer/             three.js view: drawing, picking, handles
  parts/              the gear, pulley, sprocket and thread generators
  io/                 STL, 3MF, OBJ, GLB, SVG, DXF, URDF writers; STL, OBJ, 3MF, GLB, SVG, DXF readers
  robot/              Robot mode: links and joints, materials and mass properties, checks, the ROS 2 package
  sync/               Google sign-in (PKCE, loopback), Drive remote, three-way merge, sync engine
  text/               fonts, and laying words out as outlines
  ui/                 React components
  platform.ts         desktop app or plain browser: dialogs, files, drops
src-tauri/            native window, file dialogs, reading and writing files (Rust)
  plugins/device/     Android: reports a hardware keyboard and the on-screen keypad, writes picked documents (Kotlin)
```

A design is a flat list of nodes: shapes, parts, text, imports, pictures, and groups of
nodes. A node has a position, a rotation and a size, plus what defines its
form (a shape's parameters, a part's kind and parameters, the words of a
text), and nothing else is stored: no meshes, no history of operations. Solids
are computed from that description by
[Manifold](https://github.com/elalish/manifold) (WebAssembly), which guarantees
watertight results from every union and cut.

What keeps it fast: the geometry of a node is cached under a key that leaves
out where the node is, how it is turned and (for most shapes) how big it is.
Moving, turning and resizing therefore only change a matrix on the graphics
card; the kernel runs when a shape's form changes or a group is made, and then
only for that node. Undo and redo reuse the same cache.

### Adding a shape

1. Add its kind to `ShapeKind` in `src/model/types.ts`.
2. Describe it in `SHAPES` in `src/geometry/shapes.ts` (name, default size,
   parameters) and build it in `buildShape`, centered on the origin and filling
   its bounding box.
3. Draw its catalog picture in `src/ui/thumbnails.tsx`.

The palette, inspector, file format and export pick it up from there.

### Adding a part

1. Write a `GeneratorDef` in `src/parts/generators/` — its parameter groups
   (each group becomes a tab) and a `build(params, quality)` function returning
   a `Solid` description, an optional 2D `outline` (which also draws its
   picture in the kind picker), and `info` rows for the dimensions tab.
2. Add it to the list in `src/parts/generators/index.ts`. Parts with no
   outline get a glyph in `src/ui/partThumbnails.tsx`.

Generators are plain functions from parameters to a shape description; they
never touch the mesh kernel, which keeps them easy to test.

## Roadmap

- Work plane on any face, ruler and snapping to other objects.
- Text on curved surfaces; more scripts and fonts.
- More parts: throated worm wheel, planetary set helper, V-belt pulleys,
  imperial threads.
- Assembly preview of meshing gears.
- Robot mode: joint placement on snap points with a pose slider, SDF output
  (with loops), cylinder and sphere collision shapes, drive and sensor
  presets, `ros2_control`, xacro, MJCF.
- STEP export. Shapes and parts are already described as profiles and
  operations rather than triangles, so a B-rep backend can evaluate the same
  descriptions.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

Copyright © 2026 Andrew O'Shei, Shei Designs.
