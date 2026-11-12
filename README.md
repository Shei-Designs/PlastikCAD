<h1 align="center">
  <img src="docs/banner.svg" alt="PlastikCAD: fast solid modeling for 3D parts and robots" width="100%">
</h1>

Fast solid modeling for 3D parts and robots: an app for bashing out a part
from a few simple shapes.
Drop boxes, cylinders and wedges on the plate, add a gear, a pulley or a
threaded rod made to your numbers, turn some of it into holes, and group.
Give the parts joints, motors and sensors and they are a robot, to test-drive
on the plate and export for a simulator.

Runs locally on Linux, Windows, macOS and Android. Nothing of yours leaves
your machine unless you link a Google Drive; the desktop app asks the releases
page for a newer version when it starts, which **File → About** turns off.
Free software under the GPL-3.0.

PlastikCAD is a [Shei Designs](https://sheidesigns.com) project, designed and
built by [Andrew O'Shei](https://andrewoshei.com).

PlastikCAD supersedes [Gearwright](https://github.com/AOShei/gearwright): every
part type and parameter it had is in here, as objects you can combine with
everything else.

## Install

Installers for Windows, macOS (Apple Silicon and Intel) and Linux (AppImage,
`.deb`, `.rpm`) are on the
[releases page](https://github.com/Shei-Designs/PlastikCAD/releases/latest),
which also says which file to pick and how to get past the first-launch
warning: the builds are not code-signed yet. The desktop app looks for a
newer version when it starts (a switch in **File → About** turns that off)
and whenever asked there, and installs it when
you say so: it saves the design, fetches the update, checks it against the
app's own key, and starts again. A copy installed as a Linux package (`.deb`,
`.rpm`) is shown the way to the releases instead, since only the system can
replace it; the AppImage updates itself. The
Android app is built from source for now (see [Development](#development)).

## Languages

The app is in English and French. It starts in the language of the device, and
**File → Language…** sets another; the app then starts again in it, with the
design saved first. Names the app gives to new objects are in the language in
use and stay as they are in the design. What is translated is the words:
labels, descriptions, messages. Numbers are written the same way in every
language, with a decimal point and no thousands separator, and a comma typed
in a number box is read as the decimal point. What is written into exported
files (a URDF, a ROS package, a script) is in English whatever the language.

## Units

Lengths are shown and typed in millimeters, or in inches once **File → Units…**
is set to them: the size and position of the selection, a size typed at a
grip, the settings of shapes and parts and the dimensions parts work out, the
ruler, the readout of a drag, the array and mating panels, and the lengths in
Robot mode. Inches are decimal, to four places at the most. The snap steps
are then 1/32 in to 1 in. The design itself is in millimeters whichever
unit is on show, and so is every export.

The plate's grid is in the unit as well, and grows with the design. Under a
small one it has a heavy line every 10 mm and a light one every millimeter,
or every inch and every eighth of one. With more than thirty heavy lines
each way they move further apart: to 100 mm and then to meters, a meter in
quarters; to feet and then to yards, a yard in feet; past that to tens of
meters or of yards. A design the size of a room has no more lines than a
small one.

A part that is metric by its standard keeps its name as the standard writes
it (M8, GT2 2 mm, NEMA 17, a 40 mm fan): that is what its datasheet says.
Everything else about it is in the unit in use once it is on the plate: its
settings, a gear's module and a thread's pitch among them, the figures it
lists, the note under its name, and its warnings. A setting left as it reads keeps the
exact value it has (a module of 2 mm reads 0.0787 in and stays 2 mm), and a
slider still moves in the steps it has in millimeters. The question asked of
a file that names no unit says what it measures as millimeters, since that
is what it asks about.

## How it works

It is the Tinkercad way of modeling, without the cloud and without the clutter:

- **Shapes** – box and cylinder (both with optional rounded edges), sphere,
  cone, pyramid, wedge, roof, round roof, polygon prism, torus and dome. Click
  one, then click on the plate (or on top of another object) to put it down.
- **Parts** – a tile for each family (gears, pulleys and sprockets, screws
  and threads, bearing seats, rails, pipes and ducts, dev boards, fans, panel
  cutouts, motor mounts) places a parametric part. The panel shows what it is for, a picture
  menu of the kinds in that family, the parameters in tabs (gear, tooth form,
  hub, bore; thread, head; and so on), the dimensions that follow from them
  (pitch diameter, outside diameter, center distance...). A part is just an
  object: group it, cut it, scale it. See [Parts](#parts) for the list.
- **Mating gears** – *Add mating gear…* on a gear, rack or worm opens a small
  wizard that makes the gear that runs with it: a gear, an internal ring, a
  rack, a worm wheel (a helical gear cut to the worm's lead, or a throated
  wheel whose teeth wrap round the worm) or the second
  bevel of a pair, by tooth count or ratio,
  with backlash and extra center distance to suit the printer. The mate
  stands meshed beside its gear at the right center distance, on whichever
  side you turn it to, and follows the numbers as they are typed; *Accept*
  keeps it as a part of its own. A timing pulley or a chain sprocket has the
  same wizard for the other wheel of its drive: give the teeth (or the ratio)
  and the belt's teeth or the chain's links, and the mate stands exactly that
  belt or chain away, with the center distance and belt length shown. A
  V-belt pulley has it too, by the mate's diameter (or the ratio) and the
  belt's length, since a V-belt has no teeth to count. On an
  internal ring gear the wizard makes the planetary set: the sun, by its
  tooth count, and the planets round it, meshed with both; it starts on a
  number of planets that can be spaced evenly, and says when the teeth do
  not allow the set asked for.
- **Text** – lettering in seven print-friendly fonts (sans, slab serif,
  monospace, stencil, condensed, rounded and a joined script), in Latin,
  Cyrillic, Greek and Vietnamese, on one line or several. Put it on a face and group it
  to emboss; make it a hole and sink it in a little (Ctrl+Down) to engrave.
  Bend it round a cylinder (set the reach, or the diameter it has to fit,
  outside or inside) or lay it along an arc that rises or hangs, with its
  thickness set as a length of its own; the box then follows the curve.
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
  pattern shows live while the numbers are typed, and the panel stays while
  the view is turned and zoomed for a look at it; *Apply* keeps the pattern,
  and *Cancel*, Escape or a press on another tool drops it.
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
  panel on the right. Select several objects and the grips sit on the box
  round them all: dragging one stretches them together, and clicking the top
  grip shows their combined height. The handles follow the plate's axes
  whichever way an object is turned; *Object axes* (O) puts a single object's
  handles on its own axes instead, to size and move a turned part along
  itself.
- **Panels** – a tab on each edge of the plate hides the panel on that side
  and brings it back, to give the plate the whole window; the app remembers
  which are hidden. On a window too narrow for them beside the plate (a
  tablet held upright) the panels start hidden and lie over the plate, one at
  a time, when called for.
- **Ghosts** – the ghost button (or G) fades the selected objects to faint
  shadows that nothing picks: a click or a drag goes through them to whatever
  is around or inside, so a part nested in another can be adjusted without
  moving the other out of the way. Any number of objects can be ghosts at
  once; the un-ghost button (Shift+G, or the ghost mark on a row of the
  Objects list) brings them back.
- **Import** – the button at the bottom of the library (or Ctrl+I) takes STL,
  OBJ, PLY, 3MF and GLB meshes, STEP solids from a CAD program, SVG and DXF drawings (extruded into a plate) and PNG or JPEG
  pictures; meshes and drawings then behave like any other object. Drop files
  on the window. A zip archive is taken for the files in it.
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
  it, bottom to top, turned to any side, or tiled at a set size
  from every side, for patterns and materials. Pictures and textures are for
  scenes and renders, not printing: they travel in GLB exports and are left
  off the others.

## Parts

| Gears | Pulleys & sprockets | Screws & threads | Bearing seats | Rails & frames | Pipes & ducts | Dev boards | Fans | Panel cutouts | Motor mounts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Spur gear | GT2 timing pulley (2 / 3 / 5 mm) | Metric bolt / threaded rod (M3–M20) | Bearing seat: 623–626, 608, 688, 698, 6000–6002, 6200–6202, 6800–6802, LM6UU–LM12UU, or any size | Aluminum rail: 20, 30 and 40 mm series, V-slot or T-slot, one to four cells in one or two rows (2020, 2040, 4040, 3030, 3060, 6060, 4080...) | Straight pipe or duct | Raspberry Pi 5, 4, 3, Zero 2 W, Pico | Fan, 25–140 mm: the cutout (clear, or with a guard pattern of rings, slots, honeycomb or grid cut into the wall) | Panel connector: Neutrik D-series, IEC C14 / C13 / C8, D-sub 9 / 15 / 25, XT60, with their screw holes | Stepper: NEMA 8, 11, 14, 17, 23 and the 28BYJ-48 |
| Helical gear | HTD timing pulley (3M / 5M / 8M) | Metric nut |  | | Elbow (any angle and bend radius, legs either side) | Arduino Uno R3/R4, Mega 2560, Nano | Screw holes only, for an opening of your own | | Gearmotor: N20, TT, 25 mm (JGA25), 37 mm (JGB37) |
| Herringbone gear | T-series timing pulley (T2.5 / T5 / T10) | Trapezoidal lead screw (multi-start) |  | | Reducer (in line or eccentric) | ESP32-DevKitC V4, DevKit V1, NodeMCU-32S | Printed grill with the same patterns, to screw over the fan | | Servo: SG90, MG996R |
| Internal ring gear | MXL / XL timing pulley | Lead screw nut (flanged) |  | | Tee / wye (branch at any angle) | NVIDIA Jetson Nano, Orin Nano / Orin NX and Xavier NX developer kits | The fan itself: frame, hub and blades of a typical fan, to check clearance | | DC motor: 775, 130 |
| Gear rack (straight, helical, herringbone) | Chain sprocket (#25–#41, 05B–08B, bicycle) | Screw hole (M2–M20): clearance, threaded or for a heat-set insert, with a counterbore, countersink or nut trap |  | | | | | | |
| Bevel gear (90° shafts) | V-belt pulley (Z, A, B, C, SPZ–SPC, one groove or several) | Inch bolt / threaded rod (#6–3/4", UNC or UNF) | | |  | | | | |
| Worm | | Inch nut | | |  | | | | |
| Throated worm wheel (its teeth wrap round the worm) | | Inch screw hole (#6–3/4"): as the metric one, with an 82° countersink | | |  | | | | |

Rotating parts share the same options for the shaft: round, D-shaft, hex or
keyed bore with a fit clearance, plus an optional hub with set-screw holes.
A screw hole comes in as a hole, standing on the plate with its mouth at the
top: put it where the screw goes and group it with the object. A bearing
seat does the same for a ball bearing: a bore the outer ring sits in, as deep
as the bearing is wide, over a narrower hole that the outer ring rests on and
the inner ring turns clear of.
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
the ESP32 dev kits and anything else without holes. The Jetson developer
kits are their carrier boards, all on the same 100 × 79 mm outline with the
ports along one long edge, and say how far the module stack reaches up. Every
board has its sockets recorded; the Nano's one USB opening takes the classic's mini plug,
the Every's micro plug and the Nano ESP32's USB-C, which all sit on the same
center. The ESP32 figures are the least certain: only Espressif's own DevKitC
has a published drawing, so the part says so.
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
RViz, Gazebo, MuJoCo, Isaac Sim and anything else that reads URDF. Every
top-level object is a link (group what belongs together first); joints say
how the links move against each other. The left panel shows the links as a tree hanging from the
base link, the right panel sets up whatever is picked, and the design itself
is not touched: leave the mode and everything is as it was. The robot is saved
in the design file and synced with it.

- **Base link.** Pick the object the rest hangs from, on the right while
  nothing is selected or with *Make base* on a link, and say whether the base
  is *free* (it stands on the floor and can drive or walk) or *fixed* to the
  world, as an arm bolted to a bench. A project holds one robot: the base
  link and everything a chain of joints reaches from it. Objects no chain
  reaches are listed as *Not attached*, noted as a warning and left out of
  the exports and the test drive.
- **Joints.** Select a link and attach it to another: a joint is made with the
  link as the child, placed on the child's box where it comes nearest the
  parent, and picked, drawn as a rod along its axis on the plate. *Pick a
  point on the plate* puts dots on both links (corners, edge middles, face
  centers, and the ends of a round shape's axis, which set the axis too):
  click one to move the joint there. Set its kind (revolute, continuous,
  prismatic, fixed), its origin and axis in the design's coordinates, its
  limits, effort, velocity, damping and friction, or pick its *Motor* (hobby
  servos, Dynamixel and Feetech smart servos, N20 to 37 mm gearmotors, 28BYJ-48
  and NEMA steppers) and those figures come from its datasheet; and whether it
  follows another joint (URDF `mimic`). A joint stays with its child: move the
  child and the joint comes along.
- **Copies.** Duplicate and Paste copy a link with its mass, collision and
  friction settings, its sensors, and the joint it hangs by: from the copy
  of its parent when that was copied too, else from the same parent, so the
  copy of a leg is on the body the leg is on. Mirror keeps a link's joint
  and sensors on the same spots of it, the joint's axis turned so that the
  same angle gives the mirror image of the motion. Wheel roles are not
  copied.
- **Start.** A joint's *Start* is where it stands when a simulation begins,
  measured like its limits from the pose the robot is designed in: type it,
  or move the slider and press *Set as start*. A robot built with its legs
  straight can begin crouched. The base is raised or lowered so that the
  robot's lowest point is as far above the floor as designed. A joint
  whose limits leave out the pose it is designed in needs a start inside
  them. The MuJoCo model's `home` keyframe and the test drive begin there,
  each servo holding its joint at its start; in the ROS 2 package Gazebo
  puts each joint a controller holds at its start. The Gazebo model and the
  Isaac Sim stage do not carry it yet, and say so when exported.
- **Try it.** The slider in a joint's panel moves it on the plate, the links
  below it following, to see the range of motion and catch an axis pointing
  the wrong way. The design is not touched; *Reset* puts the robot back.
- **Linkages.** Loops (a four-bar, a parallel gripper) are built as they
  are, with a joint closing each. The slider solves the loops, so the
  linkage moves as the real one does, and says when it cannot close. *Set
  the others to follow this joint* sweeps the driven joint over its range
  and writes each passive joint's motion as a URDF `mimic` line: exact for a
  parallelogram, a fit with a reported error for other four-bars. URDF
  cannot hold the loop-closing joint, so it is left out of the package with
  a warning; the Gazebo model keeps it (and drops the mimic of joints on the
  loop, since the loop then closes for real).
- **Mass.** Each link is weighed from its shape and material: pick a material
  (filaments, resin, metals, acrylic, wood, foam...) and, for a printed part,
  the infill and the shell thickness, or type the mass you weighed. The
  volume, surface, mass, center of mass and principal moments of inertia are
  shown; the inertia tensor goes into the file. A weighed link also takes
  a center of mass and an inertia tensor (g·cm², about the center of mass):
  the boxes show what the shape gives until one is typed. They are measured
  from the object's own origin (the origin of an imported file, else the
  middle of its box) along its own axes, and turn and mirror with it.
  *From the shape* gives them back to the shape.
- **Collision.** A convex hull by default, or the object's box, a cylinder
  or a sphere filling it (turned as the object is), the exact mesh, or none;
  and the surface's coefficient of friction for Gazebo.
- **Sensors.** A link's panel adds a camera, depth camera, lidar, IMU or
  touch sensor to it: a frame of its own, placed by a point on the plate or
  by numbers, turned to look (or sweep) along any of the design's axes,
  tilted up or down and, for a camera, rolled about its line of sight, with
  its rate and, for a camera, field of view, picture size and clip distances,
  for a lidar the rays, sweep and range; a touch sensor feels what its link
  touches. A picked camera shows its picture in the corner of the plate, a
  depth camera's in greys, so what it sees and what its near plane cuts off
  can be checked before anything is exported. The export writes each as a Gazebo sensor and bridges its topics
  to ROS 2; a camera also gets the optical frame ROS expects.
- **Drive.** In the overview, pick the drive kind (differential, Ackermann
  or mecanum) and give each wheel joint its part: left or right, a steering
  side, a corner. The wheel labels say which way the robot faces, and the
  track and wheel radius are measured from the design. Gazebo's matching
  plugin takes velocity commands on `cmd_vel` and reports odometry; a driven
  robot gets a `base_footprint` root on the floor under the base link,
  facing +X as ROS expects.
- **Controllers.** The actuated joints outside the drive go under
  `ros2_control` with a joint trajectory controller (`arm_controller`) and a
  joint state broadcaster, unless switched off, and *Scripts* whether the
  MuJoCo export brings its Python starters.
- **Checks.** The overview lists what stops an export (no base, a link no
  joint reaches, limits the wrong way round, a drive missing a wheel on a
  side, a link with no mass or an impossible inertia, a joint set to follow
  one that is fixed, closes a loop, is left out or follows it back) and what
  goes through
  with a note (a joint that closes a loop, a joint with no effort or speed,
  drive wheels whose axles do not run the same way, a camera whose near
  plane clips the floor out of its picture, an open mesh, a heavy collision
  mesh), each with a *Show* button. Neither says how the robot might be
  designed better: a motor far stronger than its part needs is the builder's
  choice and passes in silence.
- **Test drive.** *Test drive* in the overview builds the MuJoCo model of the
  robot as it stands and runs it on the plate (MuJoCo compiled to
  WebAssembly, in a worker), every link drawn where the simulation has it
  and the view following the base. Drive a rover with W A S D or the arrow
  keys (Q and E slide a mecanum robot sideways), move an arm's servos with a
  slider each, and read the time, the distance moved and the heading; *Pause*,
  *Reset* and *Stop* do what they say. The sensors ride their links while it
  drives, a lidar's rays reach to whatever they measure, a touch sensor's
  pad lights while it presses on something and a picked camera's picture
  follows it, so a tilt, a range or a foot that misses the floor can be
  judged on the move. *Floor* picks what it drives on: flat,
  gentle bumps, an eight-degree slope, three low steps or a ramp ahead of
  the robot. That floor is only for the test drive. PlastikCAD builds
  robots, not worlds: every export stands the robot on a flat floor, and the
  world it goes into is made in the simulator. Whatever stops the export
  stops the test drive too; the design is not touched.
- **Export** first says what goes out, the base and everything joined to
  it, whether other objects will be ignored, and any warnings; then writes
  a zip in one of four forms. A *ROS 2 package*:
  `urdf/<name>.urdf` with the sensors, drive and friction in `<gazebo>`
  blocks (and `<name>.urdf.xacro` beside it, the same with the Gazebo blocks
  behind `use_gazebo:=false` and the controllers behind
  `use_ros2_control:=false`), a colored OBJ per link under `meshes/visual` and an STL under
  `meshes/collision`, `package.xml`, `CMakeLists.txt`, a launch file for RViz
  with joint sliders, one for Gazebo through `ros_gz` that opens the
  package's world (`worlds/<name>.sdf`, with the sensor systems on), spawns
  the robot, starts the bridge from `config/bridge.yaml` and the controllers
  from `config/controllers.yaml`, and an RViz layout framed on the robot's
  own size. Or a *Gazebo model*:
  `model.sdf` with every joint (loops included), `model.config`, the meshes
  and a world that includes the model, to open with `gz sim` and no ROS.
  Or a *MuJoCo model*: one MJCF file with the bodies nested down the tree,
  position servos on the controlled joints and velocity motors on the
  wheels, loops closed by connect constraints, followers by joint
  constraints, cameras, IMUs, touch sensors and lidars (a fan of
  rangefinders, up to 90 rays), a `home` keyframe, the floor *World* chose,
  the meshes beside it and, with *Scripts* on, `drive.py` to drive it in
  MuJoCo's viewer, a Gymnasium `env.py` and a Stable-Baselines3 `train.py`. Meters, kilograms and radians, Z up; every link's frame is parallel to the
  design's axes and sits at its joint, with its meshes written in that frame;
  the base link's frame sits at the base object's own origin (the origin of
  an imported file, else the middle of its box), so the robot comes out the
  same wherever in the design it was built, and stands in the simulator's
  world where and as high as the design had it.
  The URDF says `__PACKAGE_SHARE__` where it means the package's share
  folder; the launch files fill that in, so no xacro is needed. Or an *Isaac
  Sim stage*: one `.usda` file holding the robot as a PhysX articulation
  (rigid links with their masses, meshes and collision shapes, joints with
  limits and drives, loops as plain joints), its sensors as Isaac's own prims
  (cameras with their clip planes, an RTX lidar at the design's angular step
  over a full turn, since Isaac's laser scan is always the whole circle,
  IMUs, contact sensors), a floor, lights, and a ROS 2 action graph
  that drives it from `cmd_vel` (`ackermann_cmd` for a car, `joint_command`
  for an arm) and publishes joint states, clock, odometry, TF and every
  sensor. *File > Open*, Play, and it runs; nothing is imported or set up on
  the Isaac side. Isaac Sim can still import the ROS 2 package's URDF, but
  the stage carries what the importer cannot read from URDF: drive gains, a
  free base, sensors and clip planes.
- **Import URDF**, under the robot tree, brings a robot in from a `.urdf`
  file. Every link with a shape becomes an object standing where the file
  puts it, its meshes (STL, OBJ or Collada) read from `meshes/` beside the
  file as a package keeps them, or asked for when they are not there (an OBJ
  brings its `.mtl`);
  the joints, their `mimic` lines, and the sensors, friction and drive in
  the `<gazebo>` blocks come along, and `ros2_control` switches the
  controllers on. Links without a shape (`base_footprint`, `world`, frames)
  fold into the link they are fixed to; floating and planar joints are made
  fixed; a link two joints reach keeps the first; a xacro file must be run
  through `xacro` first. Whatever was dropped or stood in for is said in the
  message. The newcomer joins the robot the design already has, which keeps
  its base, and is left loose until it is attached.

## Projects

Designs are projects, and a project is saved as you work: a second after the
last change, and when the window is hidden or closed. There is no Save. The
dot by the project name shows while a change is still being written.

On desktop, projects are `.plastikcad` files in a projects folder, `PlastikCAD` in
your Documents folder unless you pick another in the projects browser (Ctrl+O).
(The app used to be called BashCAD: a `BashCAD` folder from then is renamed on
the first start, its `.bashcad` files with it, and a `.bashcad` file still opens.)
The browser lists every project with a thumbnail, newest first, to open,
rename, duplicate or delete them; renaming a project renames its file. A
project is dated by when it was last saved, which the design itself records
(in UTC), not by the date of its file: the order is the same on every device
it syncs to, and a copy, a sync or a restore does not make an old project
look new. On
Android, projects live in the app's own storage, and a copy saved for sharing
goes to `Download/PlastikCAD`. In a plain browser they are kept by the browser
itself, per profile.

On desktop and Android nothing is lost by a slip. A deleted project goes to
the **Trash** (a `Trash` folder inside the projects folder), shown from the
projects browser, to be put back or deleted for good; a project sync deletes
because another device did goes there too. And a project keeps up to 20
**versions**: the save about to be replaced is set aside every ten minutes
of work, and always before a sync replaces a project with another device's.
The latest twelve are all kept, and one a day further back, so a long
sitting does not push out the days before it.
*Versions…* on a project's card lists them, and *Open as a copy* brings one
back as a project of its own, leaving the project as it is. Versions live in
a `History` folder beside the projects and are not synced. A plain browser
has neither.

The projects button carries a dot when sync has left word (two versions kept
after a conflict, a project deleted from another device) or is in trouble;
the word itself is at the top of the projects browser until dismissed. *About*
in the File menu has **Copy diagnostics**: the app's version, the device and
the errors of the session, to paste into a bug report. Nothing is ever sent
by the app itself.

The app runs once: double-clicking a design while it is open hands the file
to the window that is already there rather than start a second one on the
same projects folder.

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
both devices. The robot of a design counts as one thing: changed on one
device it is taken from there, changed on both the two versions are kept the
same way. A project deleted on one device is deleted on the others, unless it
was changed there since, in which case it comes back.

Sync is careful about what it removes. A project deleted on another device
is not destroyed here: on desktop and Android it moves to the Trash (see
[Projects](#projects)); what is deleted from the Drive goes to the Drive's
own trash. A sync that would delete more than half of the projects at once,
on either side, asks first and offers to keep them instead: that is what an
emptied Drive folder or a projects folder gone missing looks like, far more
often than a wish. What two places agreed on is remembered for that pair of
places only, so linking another Google account, or choosing another projects
folder, starts over by copying what each side has to the other and deletes
nothing. A project saved while a sync is running is left for the next one.
A request that Google puts off (too many at once, or a failure on its side)
is tried again after a wait, a few times. A design over 4 MB goes up through
Drive's upload for large files, which goes on from where it stopped when the
connection breaks.

What a design imported, a scanned mesh or a large picture, can run to tens
of megabytes that never change while the design around it changes with every
edit. So that an edit does not send all of that again, the copy in the Drive
keeps each imported mesh or picture of 100 kB or more apart from its design,
in an `Assets` folder inside the app's folder, once, under a name made from
its contents: a design that moves a box sends a few kilobytes. The same mesh
in two designs is one file there. The projects on your devices stay whole,
one self-contained file each; only the Drive's copy is in parts, so a design
is taken out of the Drive by syncing or with **Save a copy…**, not by
downloading its file from the Drive by hand. A mesh that was replaced, or a
project that was deleted, leaves its file in `Assets` behind: **Clean up…**
in the projects browser reads every design in the Drive, says how many such
files there are and how much room they take, and moves them to the Drive's
trash when you say so, where Google keeps them for thirty days. A file under
a week old is left alone, since the design that names it may still be on its
way from another device. One removed while still in use is sent again by the
next save of its design on a device that has it. Custom parts are kept whole.

A design made in an older version of the app opens in a newer one as it is.
The other way round, a design saved by a newer version than the one reading
it is not opened as it is: the older version's next save would lose what it
does not know (a new kind of part, a new setting) on every device. It says
the design needs a newer version, and offers to open a copy instead, a
project of its own, without those things; it says how many there are first,
and the design itself is left untouched. Sync leaves such a design alone on
the older device and names it, until the app there is updated. So devices
that sync are best kept on the same version, and nothing is lost when they
are not.

Unlinking stops the syncing, tells Google the app no longer has access, and
leaves the projects where they are, here and in the Drive. While linked, the
desktop app keeps the sign-in in the system's keychain (the Keychain on
macOS, the Credential Manager on Windows, GNOME Keyring or KWallet on Linux),
where the system guards it; one kept by an earlier version in the app's own
storage is moved there at the next start. On a Linux session with no keychain
running it stays in the app's own storage, in plain text, and so it does in
the Android app, whose sign-in lasts an hour at a time: do not link on a
shared account there. The About box's report says which it is.

A `.plastikcad` file is plain JSON, written to diff well: keys in a fixed order,
one property per line, vectors on a single line. If you keep the projects
folder in git, a change to one object shows up as a change to a few lines,
plus the thumbnail line at the top (and `Trash/` and `History/` belong in
`.gitignore`).

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
| Touch | One finger orbits, two pan and zoom, wherever they land (on an object too); tap an object to select it, tap the plate to clear; hold an object (on the plate or in the Objects list) to add it to the selection; hold the plate and drag for a box selection; tap with two fingers to undo, with three to redo; a ring fills round a finger held still, to show the hold taking; while the pen is near, a resting hand is ignored |
| Move | Drag (Shift keeps to one axis); arrow keys nudge by the snap step, Shift ×10 |
| Raise or lower | Arrow handle; Ctrl+↑ / Ctrl+↓ |
| Resize | Corner and edge grips; the top grip pulls the height up, the bottom grip pulls it down; Shift scales evenly. With several objects selected the grips sit on the box round them all and stretch them together |
| Type a value | Click any grip instead of dragging it, type the value (two for a corner grip, e.g. `20 x 15`), Enter |
| Turn | Colored arcs, in 15° steps; Shift 45°, Alt 1° |
| Duplicate / copy / cut / paste | Ctrl+D / Ctrl+C / Ctrl+X / Ctrl+V |
| Select all / delete | Ctrl+A / Delete or Backspace |
| Group / ungroup | Ctrl+G / Ctrl+Shift+G |
| Ghost / un-ghost all | G / Shift+G |
| Solid / hole | S / H |
| Drop onto the plate | D |
| Flip (mirror) on an axis | X / Y / Z |
| Turn 90° about an axis | Shift+X / Shift+Y / Shift+Z; add Alt to turn the other way |
| Align | L shows anchor dots on the selection: hover one to preview, click to apply; click one of the objects to make it the anchor, Esc to finish |
| Measure | M: click a feature, then another, for the distance (with its X, Y and Z parts), the angle between edges or faces, or a circle's diameter; the snap symbols on the bar choose what the pointer takes hold of (points, edge middles, edges, circles, quadrants, face centers, faces, object centers), mixed as in a drafting program; Esc clears, then finishes |
| Align by key | Alt+← / Alt+→ / Alt+↓ / Alt+↑ (left / right / front / back), Alt+PgDn / Alt+PgUp (bottom / top); add Shift to center on that axis; Alt+C centers on X and Y, Alt+Shift+C on Z as well |
| Object axes | O puts a single object's handles on its own axes; again for the plate's |
| Fit to view | F |
| Undo / redo | Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z |
| Projects / open project file / new project / save a copy | Ctrl+O / Ctrl+Shift+O / Ctrl+N / Ctrl+Shift+S (Ctrl+S writes pending changes at once) |
| Import | Ctrl+I |

## Export formats

| Format | Use |
| --- | --- |
| STL | 3D mesh for any slicer |
| 3MF | 3D mesh with units and colors, preferred by modern slicers; a part per color for multi-material printing |
| OBJ | 3D mesh for modeling tools, with the colors in a material library beside it |
| PLY | 3D mesh in one piece, each face in the color of its object, for mesh and scanning tools |
| GLB | 3D scene with colors, textures and pictures, for Blender, Godot, Unity and renderers |
| STEP | Solids for CAD programs: each object with its name and color, as planes, cylinders, cones, spheres and tori where it can be rebuilt |
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

A STEP file keeps every object apart, as a solid with its name and its
color (a group whose parts have colors of their own as a solid per color),
written by [OpenCascade](https://dev.opencascade.org/), which is loaded for
the first one. An object is rebuilt there from what it is, so that a CAD
program gets surfaces it can pick, measure and build on: a box is six
planes, a cylinder a cylinder, a ball a sphere, a rounded box its flats with
cylinders along the edges and spheres at the corners, and a plate with a
hole drilled through it seven faces, the hole's wall one of them. A dome is
half a sphere while it is not stretched; a round roof is half a cylinder and
a fillet a quarter of one, or of an oval bar when they are stretched. Gears, pulleys, sprockets, rails, boards,
fans, motor mounts and cutouts go out as their profiles raised, with circles
and arcs where they have them. A helical or herringbone gear goes out with
its teeth as smooth surfaces that wind up it, one to each side of a tooth's
outline, a few megabytes where its facets were tens. A thread goes out the
same way, its flanks, crest and root each a surface that winds round it,
cut to length and given its lead-ins and its head as the part describes
them: screws, nuts, threaded rod, tapped holes, lead screws and their nuts,
and worms, in metric and inch sizes; of several alike in one file, the
thread is built once. Pipes and ducts go out as what they are: a
straight run as cylinders (or flats with rounded corners), a bend as tori
about its axis, a round reducer as cones, a tee as two pipes run together;
only a reducer off its axis or between rectangles has no simple surface, and
is the surface of straight lines from one end to the other. Whatever
is rebuilt is held against the kernel's own solid (its volume to half a
percent, its box to what a curve stands out from its facets, and for a
thread its skin as well), and written to
a STEP file of its own and read back, before it goes into yours: a solid the
file would not keep goes out as its facets instead.

What cannot be rebuilt goes out as the kernel's facets, sewn into a solid
with the facets that lie in one plane joined: bevel gears, a worm wheel, lettering, imported meshes, shapes
stretched out of round (an egg from a ball, a dome taller than half a ball,
an oval cone), a rounded rim, and any group that holds one of these or parts in
several colors. Flat sides are still true planes; a curve is as many flat strips as
it has on screen, which makes a large file (some 1.6 kB a triangle), so a
file takes 60,000 triangles of such objects and no more. A design or a
selection past that gets no STEP file: where it is known beforehand (imported
meshes and lettering), STEP is not to be had in the list of formats and the
panel names the objects that are too detailed; where only the writing shows
it, the export stops and says the same. Selecting fewer objects, or another
format, gets them out. The same holds for an object the library can make
nothing of: the export stops and names it. An object that is not watertight
goes out as a surface, which is said.

In an SVG or DXF, round things are round. A hole or a disc goes out as a
circle (in a DXF, a `CIRCLE`), and a rounded corner as an arc (a bulge on the
DXF's polyline, an arc of the SVG's path), found again from the many short
sides the shapes are built with: fifteen sides or more to the turn, with every
corner within two microns of the arc. A cylinder goes out at the size it
measures across. Anything else stays the polygon it is: a hexagon, a hole of
twelve sides. A gear's flanks come out as short arcs through their corners.

The file is made at a finer detail than the screen: round shapes, gear teeth
and threads get twice the facets they are drawn with, so prints come out
smooth while the editor stays quick. A cylinder set to a handful of sides is
left alone, since that is its shape.

## Import notes

- **STL / OBJ / PLY** carry no units; coordinates are taken as millimeters (a URDF
  says its meshes are in meters, and the robot importer scales them so). A
  model that comes out under 5 mm across was most likely made in another
  unit: the app asks whether it is in meters, inches, centimeters or
  millimeters after all, and brings it in at that.
- Whatever a drawing holds that is not read is said after the import, by the
  name of the file: an SVG's text, pictures, copies of what cannot be found
  and style rules it could not read, a DXF's outlines that do not close and
  its text.
- Large files are read away from the screen, which stays live meanwhile. The
  badge over the plate says what is going on (the file of several being
  read, the objects still being built) and its **Cancel** calls an import, an
  export or a group being made off, leaving the design as it was.
- A mesh that is not watertight can be placed, scaled and exported as it is,
  but cannot be grouped: there is no telling its inside from its outside.
- An imported mesh keeps the origin its file had. The **Origin** row under
  Position says where that point is now; a value typed there moves the
  object so the point lands on it. A joint made to such an object starts at
  its origin.
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
- **Zip archives**: an archive is unpacked and what it holds taken as if
  those files had been dropped together, so a model comes in with the
  material library and pictures packed beside it, and a robot package the
  app exported comes back as its robot. Every model in it is imported. The
  pictures its models do not use (a bundle's other maps, a preview) are
  listed afterwards to tick from: those ticked go on the plate, and Skip
  leaves them all out. An archive of pictures alone puts each on the plate. Only what the app reads is
  unpacked, up to 512 MB.
- **PLY**: text or binary, as scanners and mesh tools write it; the points
  and faces make one part. The colors a PLY file gives its points or its
  faces come in as a picture the part wears: a face with a color of its own
  is that color all over, and one whose points have colors goes from each
  corner's color to the next. A colored scan so stays one solid and goes
  out again with its colors as a GLB. A file that names a picture for
  its texture coordinates (`comment TextureFile`) wears that picture
  instead, read from beside it like an OBJ's. A file of points with no
  faces (a point cloud, a splat) is refused.
- **GLB / glTF**: meshes are placed by the scene's nodes and turned from Y up
  in meters to Z up in millimeters; each material brings its base color and
  picture, laid out by the file's texture coordinates. A `.gltf` that keeps
  its buffers and pictures in separate files reads them from beside it, as
  an OBJ does its `.mtl`; where the picker grants one file at a time, pick
  them together with it or when asked. A file compressed with Draco is
  unpacked by its decoder, which is loaded for the first such file. Files
  with meshopt compression are refused; export them again without it.
- **Collada (.dae)**: the meshes of the visual scene, placed by its nodes,
  one part per material with its diffuse color and, when the picture it names
  came along, its texture; the file's own unit and up axis are honored, so a
  Blender or ROS mesh in meters, Z up, comes in at size. Skins and morphs
  show their base mesh; animation is ignored.
- **A file of several parts** (a part per material, in any of these formats)
  comes in as a group when its parts are closed solids. When one of them is
  an open shell, which cannot be grouped, the file comes in as one object
  that wears its parts' colors; parts that carry pictures of their own stay
  apart.
- **STEP (.step, .stp)**: every solid of the file is a part, where the file
  put it and at its size (STEP says its unit), its curved faces cut into flat
  ones to within 0.02 mm; several solids come in as one group. The file is
  read by [OpenCascade](https://dev.opencascade.org/), which is loaded when
  the first STEP file is read rather than with the app. Each solid takes the
  name the file gives it (its own, or its product's) and its color; these are
  read from the file's text and given only when its solids are found, one for
  one, among those read (as many of them, their corners as far apart), so a
  file that places one shape several times keeps the names its own name
  gives. A STEP file the app exported comes back with its names and colors.
- An imported picture shows on the mesh in the **Imported** texture mode; the
  mesh can still be given any other texture, wrapped or tiled.
- **SVG**: shapes are grouped by fill color, each group a part of its own.
  Every closed outline is filled and extruded, whatever its stroke or fill, so
  laser-cutter drawings work (including a gear profile exported from PlastikCAD
  as SVG). A `<use>` draws what it names again where it says, and a style
  sheet's rules apply where their selectors are plain (a tag, classes, an
  id). Convert text to paths first; images, and style rules that reach
  across elements, are not read.
- **URDF** is imported from Robot mode (*Import URDF…* under the robot
  tree), with its meshes; see there.
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
- **The throated worm wheel** is cut the way a hob cuts one: the worm, a
  little fatter by the backlash and taller by the root clearance, is carried
  through the blank as the two turn together, and what it leaves is the
  wheel. Its teeth are exact for that worm (module, starts, pitch diameter,
  pressure angle and hand must be the worm's) and no other.
- **Bevel gears** use Tredgold's approximation (the usual construction for cut
  and printed straight bevels), not a spherical involute.
- **Timing pulleys** use the standard pitch and outside diameters. The groove
  shapes are parametric fits to the belt standards rather than the
  manufacturers' multi-arc drawings, with a clearance setting to tune the fit
  on your printer.
- **Sprockets** use the common arc-based drafting construction, not the full
  ANSI B29.1 tooth form.
- **V-belt pulleys** are grooved as ISO 4183 lays them out: the belt rides on
  its flanks at the datum diameter, 34° between them on a small pulley and
  38° on a large one, or the angle you set.
- **Threads** follow the ISO metric and ISO trapezoidal basic profiles, with a
  clearance setting for printing.
- **Inch threads** are Unified (ASME B1.1), which has the metric thread's
  60° form: the diameter in inches, the pitch as threads to the inch, coarse
  (UNC) or fine (UNF). Heads and nuts take the usual hex and socket cap
  sizes; below 1/4" the hex head and the nut are those of machine screws.
  Their figures are shown in the unit in use: in millimeters, or in inches.
- **Screw holes**: clearance holes are those of ISO 273 (close, normal and
  loose are its fine, medium and coarse series). A counterbore takes the head
  of an ISO 4762 socket cap screw, a nut trap the nut of ISO 4032, and a
  countersink is a 90° cone out to the sharp edge of an ISO 10642 head (DIN
  965 for M2 and M2.5; the M14 figure is unverified); each recess is as much
  wider than the head or nut as the hole is than the screw. Heat-set insert
  bores (M2 to M6) are the drill sizes one insert maker lists; other makers
  differ by a few tenths, so check the sheet of the inserts in hand.
  Inch holes take the drills ASME B18.2.8 names for a close, a normal and a
  loose fit, the socket cap and nut of the inch bolts, and an 82° cone out
  to the sharp edge of an ASME B18.6.3 flat head; the figures are from
  memory and unverified, and no insert bore is offered for them.
- **Bearing seats** take the bore, outside diameter and width of each
  bearing from the makers' tables (ISO 15 sizes), and the LM-UU linear
  bearings from theirs. The seat is the outside diameter plus the clearance
  all round; the hole under it is half way between the bore and the outside
  diameter, which is a rule of this app, not a maker's abutment figure.
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
[JetBrains Mono](https://www.jetbrains.com/lp/mono/) (monospace),
[Allerta Stencil](https://fonts.google.com/specimen/Allerta+Stencil),
[Oswald](https://github.com/googlefonts/OswaldFont) (condensed),
[Nunito](https://github.com/googlefonts/nunito) (rounded) and
[Pacifico](https://github.com/googlefonts/Pacifico) (script), all in bold or
heavy cuts. Every font but the stencil has Latin, extended Latin, Cyrillic
and Vietnamese characters; the sans, the slab serif and the monospace have
Greek as well. A letter a font has not got is set in the sans, not as an
empty box. Scripts that need more than letters set side by side (Arabic,
Hebrew, the Indic scripts) and those of thousands of characters (Chinese,
Japanese, Korean) are not there. All are under the SIL Open Font License
1.1 but Roboto Slab, which is under the Apache License 2.0. The app's own lettering is Inter, with the
product name in [Space Grotesk](https://floriankarsten.github.io/space-grotesk/)
(SIL Open Font License 1.1). The license texts are in `public/font-licenses/`
and ship with the app, beside `THIRD-PARTY-NOTICES.txt` with the licenses of
the libraries it is built on (Manifold, MuJoCo, OpenCascade, three.js, React,
opentype.js, fflate, earcut and the Tauri API) and
`THIRD-PARTY-NOTICES-NATIVE.txt` with those of the Rust crates the desktop
and Android apps are built with. **Licenses** in the About box shows them. A
design stores only the words, not their outlines.

## Development

Requirements: [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io),
[Rust](https://rustup.rs), and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
platform.

```sh
pnpm install
pnpm tauri dev      # run the desktop app with hot reload
pnpm dev            # or just the UI, in a browser at http://localhost:1430
pnpm test           # model, geometry, part, file-format, sync and robot export tests (cargo test in src-tauri for the Rust side)
pnpm e2e            # builds the app and drives it in a headless browser, with a mouse and with fingers (once: pnpm exec playwright install chromium)
pnpm smoke:robots   # exports the reference robots and runs them in MuJoCo (pip install mujoco)
pnpm smoke:ros      # the same in ROS 2 Jazzy, RViz (screenshots) and Gazebo, in Docker
pnpm smoke:isaac    # the same in Isaac Sim through its URDF importer (ISAACSIM_PYTHON=~/isaacsim-env/bin/python)
pnpm smoke:usd      # the exported Isaac Sim stages opened, played and driven over ROS 2 in Isaac Sim
pnpm typecheck
pnpm lint           # React hooks used wrongly, and a few plain mistakes the type checker does not see
pnpm notices        # after adding, removing or updating a dependency (npm or cargo): writes the notices in public/ again
pnpm tauri build    # build installers into src-tauri/target/release/bundle
pnpm tauri android build --apk   # the Android app, with the Tauri Android prerequisites installed
```

The icon and the banner follow the Shei Designs product rules: the shared
rounded tile in PlastikCAD's own teal, the cube-with-a-hole mark in Carbon,
the product name in Space Grotesk. `docs/brand/draw.cjs`
draws them (`node docs/brand/draw.cjs`), into `docs/brand/`, `public/icon.svg`
and `docs/banner.svg`; after a change, rasterize the tile at 1024 px
(`rsvg-convert`) and regenerate the platform icons, Android launcher icons
included, with `pnpm tauri icon docs/brand/icon.json` — see
[the Tauri docs](https://tauri.app/develop/icons/).

Every push runs `.github/workflows/ci.yml`: the type check, lint, the tests and the
build, the Rust lints and tests, a compile of the native side on macOS and
Windows, the reference robots in MuJoCo, and the browser tests in `e2e/`
(the report of a failed run is kept as an artifact). Pushing a `v*` tag runs
`.github/workflows/release.yml`, which runs the tests again, then builds
installers for all three platforms and attaches them to a draft GitHub
release. The version number is set in `package.json`, `src-tauri/tauri.conf.json`
and `src-tauri/Cargo.toml`; a test fails when they differ.

Before a tag is pushed, `pnpm check:apps` tries the built apps themselves,
which no test above does: the desktop app as a binary, off the screen, and
the Android app on the emulator, each with the tests' way in built into its
web bundle. It makes a design, exports it in every format and hands each
file back, goes through the projects folder (rename, earlier saves, trash),
opens files from other programs, exports a robot in every format and runs
its test drive, and on Android presses the real Back key and opens the share
sheet. A check also fails when the app reports an error, a refused native
call or a file its content policy kept out. It takes a few minutes once
both apps have been built before, and is not part of the CI: it needs `gamescope`, `WebKitWebDriver` and
`dbus-run-session` for the desktop, and the Android SDK with an emulator for
Android (`pnpm check:apps desktop` or `android` runs one alone;
`tools/apps/run.sh` says the rest). The desktop app is started on a message
bus and in a home folder of its own, so that it cannot reach the keychain,
and with it a linked Google Drive: the run stops if it finds one linked.

### Updates

The desktop app updates itself with Tauri's updater. A release build signs
each installer with a key of the project's own (not the operating systems'
code signing, which is still to come) and publishes an index of them,
`latest.json`, with the release; an installed app reads that index from the
latest published release and takes nothing that is not signed with the key
whose public half is in `src-tauri/tauri.conf.json`.

- The private half and its password are the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which
  the release workflow hands to the build. **Keep a copy of both somewhere
  safe.** A release signed with any other key is refused by every copy of
  the app already installed, and there is no way to give those a new key
  but a fresh install by hand.
- The update files are made only when a build is told to
  (`--config src-tauri/tauri.updater.conf.json`, as the release workflow
  does), so an ordinary `pnpm tauri build` needs no key.
- A release is a draft until it is published on GitHub, and an installed app
  sees it only then.
- In your own fork, make a key of your own with
  `pnpm tauri signer generate`, put its public half and your releases'
  address in `tauri.conf.json`, and its private half in the secrets.

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
  state/              the editor: selection, undo, projects, preferences, the test drive (store.ts is the one door to it, over the modules in store/)
  viewer/             three.js view: Viewer.ts and its parts (drawing, picking, handles, pointer input, measuring, the robot overlay)
  parts/              the part generators (gears, pulleys, threads, rails, ducts, boards, fans, cutouts, motors) and the mating-gear maths
  io/                 STL, 3MF, OBJ, GLB, STEP, SVG, DXF, URDF, SDF, MJCF, USD writers; STL, OBJ, PLY, 3MF, GLB, Collada, STEP, SVG, DXF, URDF readers
  robot/              Robot mode: links and joints, materials and mass properties, checks, the export packages
  sim/                the test drive: MuJoCo (WebAssembly) in a worker
  sync/               Google sign-in (PKCE, loopback), Drive remote, three-way merge, sync engine, large imports kept apart on the Drive
  text/               fonts, and laying words out as outlines
  ui/                 React components
  platform.ts         desktop app, Android or plain browser: dialogs, files, drops
src-tauri/            native window, file dialogs, reading and writing files (Rust)
  plugins/device/     Android: reports a hardware keyboard and the on-screen keypad, writes picked documents, signs in through Play services (Kotlin)
tools/                the simulator smoke tests (MuJoCo, ROS 2 and Gazebo in Docker, Isaac Sim), and the notices script
fixtures/robots/      the reference robots the smoke tests export
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

What keeps large models from holding up the screen: everything that grows
with the number of triangles is done in the geometry worker. A model file is
read there (`worker/importing.ts`: parsed, its corners joined, centered and
put in the form the design keeps). A build comes back with its edge lines and
with a tree of boxes over its triangles (`geometry/bvh.ts`), through which
the pointer finds the triangle it is on in a few steps rather than by trying
them all. The Measure tool reads a mesh of more than 50,000 triangles there
too, and says so while it waits. The worker cannot be interrupted in the
middle of a solid, so calling work off stops it and starts another when next
needed; the objects that were being built are simply asked for again.

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

### Words and languages

Every text a user reads is written in English where it is used, inside a call
that looks it up (`src/i18n/index.ts`):

```ts
tr('Save a copy…')                               // the English text is the key
tr('Deleted {name}.', { name })                  // with something put in
trx('verb', 'Open')                              // one English text, two meanings
plural(n, '{n} object', '{n} objects')           // a count
mark('Move') … marked(group)                     // written in one place, shown in another
rich('Made by {author}.', { author: <a>…</a> })  // with elements put in
```

The text must be written out at the call, whole sentences at a time: a test
(`src/i18n/catalog.test.ts`) reads the source for these calls and holds every
catalog to them. It fails when a catalog lacks a text, holds one the source no
longer uses, or puts other things in than the English does.

To add a language:

1. Copy `src/i18n/fr.ts` and the folder `src/i18n/fr/` under the new
   language's code, and translate the right-hand side of every entry. A text
   about a count takes one form per plural category of the language
   (`{ one: '…', other: '…' }`). `glossary.md` there lists the word chosen for
   each of the app's terms: start a new one, so that a term is translated the
   same way everywhere.
2. Add the language to `Language`, `LANGUAGES` and `CATALOGS` in
   `src/i18n/index.ts`, and to `CATALOGS` in the catalog test.
3. `pnpm test` then lists what is missing, and `pnpm e2e` runs the layout
   checks: text runs longer in some languages than in English.

The language is settled once, when the app starts, so a text can be looked up
anywhere, in a table at the top of a module as well as in a component, and the
geometry worker speaks the language of the page that started it.

Left as they are on purpose, to keep this to words. None is ruled out; each
waits until someone needs it:

- Numbers in the language's own form (a decimal comma, a space between
  thousands). A typed comma is already read as the decimal point.
- The W, D and H tags of the size boxes, which stay as in English.
- The text inside exported files.
- Errors from the native side when the system refuses to read, write, move or
  delete a file. They are shown as they come, in English, with the path and
  the system's own reason.
- The keys of the test drive, which go by letter (W, A, S, D) and so sit
  elsewhere on a keyboard that is not QWERTY. The arrow keys work on all.
- A part that still has the name the app gave it is recognised as such only
  in the language it was named in.

## Roadmap

The whole of what is planned, deferred and dropped is in
[docs/ROADMAP.md](docs/ROADMAP.md). Next are the phases it lists: robot mode
made dependable, the release on the Play Store, the viewer for phones.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

Copyright © 2026 Andrew O'Shei, Shei Designs.
