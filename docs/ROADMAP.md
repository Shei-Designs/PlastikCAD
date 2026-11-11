# Roadmap

What is left to do on PlastikCAD, in one place: what can be built now, what
needs a session together first, what is waiting on a check or a decision,
and what was put off or dropped on purpose. It is kept here, in the
repository, until version 1.0.0; from then on the work is tracked as public
issues.

Phases 0 to 6 (the review fixes, the safety net, the tablet workspace,
versions and updates, large models, the modelling features and the file
formats) are done and merged. The README says what the app does today.

## Next to build

Smaller pieces, each of which can be built without a session.

- **Screw holes in inch sizes**: clearance holes, counterbores, 82°
  countersinks and nut traps for the sizes the inch bolts come in. The
  figures need a table to work from.
- **A V-belt pulley's mate** in the mating wizard: a V-belt's length is not
  a tooth count, so it needs its own rule.
- **STEP export**: true surfaces for helical and bevel gears and for
  threads, which still go out as facets. A research piece: the library has
  to sweep a tooth along a helix and the file has to keep the result. (Eggs,
  tall domes and oval cones cannot be done: a STEP file does not keep an
  oval turned round an axis.)
- **PLY**: colors blended across a face on import, where today each face
  has one.

## Needs a word first

- **A preview of meshed gears turning together.** It needs a place in the
  interface and a way to start it (a "Turn" control on a gear that carries
  the gears meshed with it along, most likely), which is yours to say.

## Phases that need a session first

Each of these changes how the app is used, so its features and approach are
agreed in a working session before anything is built.

| Phase | What | What the session has to settle |
|---|---|---|
| 7 | **Robot mode**, made dependable | Found by building a real robot with it, start to finish, on the desktop and on the tablet. Open design questions: mecanum strafing, the kinds of joint that close a loop, the camera's optical frame, the base frame of a USD stage, the inspector's wording and touch sizes. Until then the mode is experimental: crashes and wrong output are fixed, behaviour is not polished. |
| 8 | **Release** | The Play Console set-up and the Android signing key, the APK attached to releases, the store listing and screenshots, the color register, code signing for Windows and macOS. |
| 9 | **Phone viewer** | The app on a phone as a viewer: which objects and projects it shows, what replaces the edit controls, how a design gets there. The editor itself stays for tablets and desktop. |
| 10 | **AI features** | Tests of whether it is viable and useful come before any integration: what it would do (the first idea is help with the constraints of a robot being prototyped), which service, what it costs, where a key is kept, and what "nothing leaves your machine" then means. |

## Waiting on a check

Things only the real devices and accounts can show.

- Google Drive with a large import: the `Assets` folder appears, the design
  file on the Drive stays small, and the tablet opens and edits it.
- A Drive upload of more than 4 MB.
- A STEP file from Fusion 360: that it opens, with its names and colors.
- On the tablet: PLY, zip and STEP import, STEP export, the licenses in the
  About box.
- On the desktop: saving a STEP export through the dialog; the Mac build.
- A `.gltf` with its files apart, picked on Android.
- The French glossary (`src/i18n/fr/glossary.md`).
- Figures taken from memory or a single source: the M14 countersink, the
  M14 to M20 clearance holes, the heat-set insert bores, the M2 and M2.5
  head sizes, the motor presets, the V-belt groove sizes, the inch thread,
  head and nut sizes.
- Google Drive's "Clean up…" against a real Drive.
- The desktop app on a Mac: STEP and compressed glTF files, then an export
  (see the first finding of review 1, fixed on Linux and not tried there).

## Put off

Not dropped: taken up when asked for.

- Languages other than English and French.
- Lettering in scripts that need shaping (Arabic, Hebrew, the Indic scripts)
  or thousands of characters (Chinese, Japanese, Korean): each needs fonts of
  megabytes fetched when asked for, and the first three a shaping engine.
- Numbers written the way the language writes them, W / D / H translated,
  the test-drive keys by position on other keyboards, the native side's
  error messages in the app's language.
- Splitting large imports out of the project files on the device, as is done
  on the Drive: a project stays one whole file that can be copied out by
  hand, until a real large project shows the saving is worth that.

## Dropped

Decided against; not to be proposed again.

- A gesture to select what is behind an object: Ghost is how it is reached.
- Snapping while moving, and a work plane.
- In robot mode: a two-click joint tool, dragging to re-parent, axis
  defaults for round children, shaft-aware parts, an automatic base.

## Reviews

Passes over the whole project, each ending in a list of findings to choose
from rather than in fixes. In this order:

1. **The bundled apps.** Every feature tried in the real desktop and Android
   builds: what the browser tests cannot see.
2. **Correctness and data safety.** Saving, sync, earlier saves, the trash
   and the importers: where a fault costs someone their work.
3. **Tablet usability.** Every flow at tablet size, by touch, in both
   languages.
4. **Performance and size.** Start-up, large designs, memory on the tablet,
   the size of the download.
5. **Security and privacy.** The native file commands, the content security
   policy, the sign-in, what leaves the device.
6. **Gaps and opportunities.** What someone coming from Tinkercad, FreeCAD
   or Fusion 360 would miss, and what the app does that those do not.

### Review 1: the bundled apps (2026-11-11)

The desktop app (Linux, off screen) and the Android app (emulator, tablet
size) as they are built, version 0.2.0, driven through their real native
side: every import and export format, projects (new, rename, duplicate,
earlier saves, trash, another folder), files handed in and given at
start-up, lettering in every font, pictures, custom parts, the About box,
French, and a robot (four exports and the test drive).

All of that works on both, apart from what follows.

Fixed as they were found:

- **Escape deleted the file that was opened.** Leaving the "Project added"
  box by Escape, a press beside it, or a second file dropped meanwhile
  deleted the opened file for good (desktop and Android). #44.
- **After the first STEP or compressed glTF file of a session, exports
  failed** in the Linux desktop app ("… has no letters that can be drawn",
  imported data "missing"): WebKit started the geometry worker's code a
  second time, empty. #45.

To choose from:

1. **Android: Back closes the app**, even with a box open. Nothing is lost
   (the design is saved on the way out), but a box is not closed by it.
2. **Android: a STEP export of many imported meshes can run the device out
   of memory.** Some 100 000 triangles of imports took the web view past
   3.4 GB on a 4 GB device and Android closed the app without a word; the
   project came back from its last save. One object too detailed is left
   out today; the total is not limited. For review 4 as well.
3. **A dropped file that cannot be read says nothing** (the file gone, or
   not allowed): no notice at all.
4. Small: "Writes … as a Isaac Sim stage" (an); the ten minutes between
   earlier saves are counted afresh at each start of the app (twenty are
   kept at most, so it is bounded); an empty `History` folder
   is left when a project is deleted for good; a write cut short by the app
   being closed leaves a hidden `.tmp` file that nothing removes; the Font
   box of lettering is drawn light on the dark theme in the Linux app; on
   Android an export under a name already used replaces the earlier file
   without saying so (as written, but worth a word); the package's short
   description reads "for 3D printing".

Not tried, and why: the system's own pickers and questions (no driver can
press them; the app was given their answers), closing the window with
unsaved work, the Drive sign-in and sync and the keychain (a test must
never reach the real account: a test run on the desktop does, unless it is
cut off from the session's keychain), installing an update, the Mac and
Windows apps, a real tablet, and the tablet held sideways in the app
itself.

### Review 2: correctness and data safety (2026-11-11)

Saving, the project folder, earlier saves, the trash, sync and the version
rule, read end to end, with a test written for each finding that shows it
(thirteen of them; not kept in the repository, to be turned into the tests
of whatever is fixed). "Shown" below means such a test passes.

Where work can be lost:

1. **An autosave during a sync pass puts the old copy back over what was
   just downloaded, and the next pass uploads it.** The other device's work
   on the open project is gone here and on the Drive; only that device's
   earlier saves still hold it. It needs an edit between the moment the
   pass writes the open project and the end of the pass (seconds, longer
   with large downloads): picking the tablet up and starting to edit is
   that moment. A save never checks that the file is still the one the
   editor loaded. Shown.
2. **An import that ends after the scene changed commits the scene as it
   was when it began**, into another project if one was opened meanwhile:
   that project's objects are replaced and saved. Edits made during an
   import in the same project go the same way. Undo brings them back in
   that session. Shown.
3. **Undo after a sync merge takes the other device's changes out again**,
   and the next save uploads the result. Shown.
4. **Two new projects of one name written at the same moment land in one
   file** (a download named "Untitled" and a first autosave of a new
   "Untitled"). A narrow window. Shown at the level of the store.
5. **"Empty Trash" destroys what a sync pass moved there while its question
   was up**, never having been listed. Narrow. Shown.
6. On a Mac, two names that differ only in how an accent is written
   ("é" as one character or two) are not seen as the same file. Not tried.

Where the result is wrong:

7. **A move of the projects folder that fails part-way** (a full USB
   stick) leaves the app on the old folder without the projects already
   moved, and the next pass deletes those from the Drive unasked. The files
   are safe in the new folder. Shown.
8. **A project that cannot be listed counts as deleted**: a file that
   cannot be read for a moment, or a chosen folder on a drive that is not
   mounted (it is made anew, empty), is carried to the Drive as a deletion,
   unasked when it is one project or fewer than half. Shown.
9. **A project file copied by hand keeps its id**: one of the two never
   syncs, with no word, and they share their earlier saves. Shown.
10. **A move of the projects folder leaves the Trash behind.** Shown.

Smaller: a file of the first format already in the folder loses the saved
versions it carries when opened, unasked; a field a newer app adds to an
imported mesh or picture is dropped without the "newer version" refusal
(nothing does so today); a name typed without its extension in the save
box can replace a file unasked (the box checked the name as typed); a
change of language reloads the app whether or not the save worked; a failed
save is tried again only at the next edit.

Found sound: a write never leaves a half file; a rename never lands on
another project; an edit made during a save stays to be saved; closing,
leaving a project, deleting and updating all hold on a failed save; the
earlier saves kept and dropped; sync decides by revision and never by the
clock, writes nothing it could not read whole (a cut-off file, a missing
or damaged import), and its clean-up cannot touch anything on the device;
a newer design is refused everywhere it could be opened or merged.

### Review 4: performance and size (2026-11-11)

Measured on the built app in Chromium with the picture drawn in software
(so frame rates are on the low side), at this workstation's speed and with
the processor slowed four times to stand for a tablet.

What it weighs: the installers are 11 to 12 MB (Windows, macOS); the app's
files are 39 MB unpacked, 12 MB compressed, of which OpenCascade (STEP) is
23 MB and MuJoCo (the test drive) 11 MB, each read only when first used.
Start-up reads 0.7 MB in 11 requests.

| | Workstation | Slowed 4× |
|---|---|---|
| Window drawn | 0.2 s | 0.6 s |
| First shape built and drawn | 0.8 s | 1.2 s |
| First gear / first lettering | | 0.2 s / 0.1 s |
| 400 objects placed, grouped, saved | no frame dropped, 36 MB | |
| A mesh of 200 000 triangles read | under 2 s, 76 MB | |
| A mesh of 1 000 000 triangles read | 2.5 s, 293 MB, a hole cut in 0.6 s | |
| A save with that mesh in the design (24 MB file) | 0.07 s | 0.16 s |

None of that needs work. One thing does:

1. **A STEP export of imported meshes costs about 2.5 kB of file, 0.4 ms
   and 22 kB of memory per triangle**: 20 000 triangles make a 50 MB file
   in 6 s with 0.9 GB in use, 50 000 a 128 MB file in 22 s with 1.6 GB.
   One object over 60 000 triangles is left out with a warning; the total
   is not limited, so several smaller ones pass, and on a tablet the system
   closes the app (review 1, finding 2). A limit on the whole export, said
   before it starts, would do; or meshes written as tessellated shapes,
   which STEP has and which cost a fraction (a research piece).

Not measured: the desktop and Android apps themselves (the debug builds
used in review 1 are not built for speed), memory on a real tablet, and a
project of hundreds of megabytes saved to the tablet's storage on every
edit, which is where keeping a project as one whole file will first cost.

### Review 6: gaps and opportunities (2026-11-11)

Not measured: a reading of what the app does against what someone arriving
from Tinkercad, FreeCAD or Fusion 360 is used to. Nothing here repeats what
was dropped on purpose (a work plane, snapping while moving, a gesture to
select what is behind).

What they would look for and not find:

1. **A way in.** No first-run guide, no example projects, no starter for
   each of the three kinds of work (a part to make, a robot, a model for
   Blender). Tinkercad teaches by its starters.
2. **A look inside.** No section view (the model cut by a plane, for
   looking only). Ghost shows through an object, not into one.
3. **Fillet or chamfer of a chosen edge.** Today an edge cutter is lined up
   by hand; the others pick an edge and give a radius.
4. **Hollowing a solid to a wall thickness** (shell).
5. **Keeping only the overlap of two solids** (intersect): a group adds
   solids and cuts holes, nothing more.
6. **Drawing a profile in the app** and pushing it out or turning it round
   an axis. Outlines come in as SVG or DXF only; there is no revolve.
7. **Inches as the working unit.** Everything is millimeters; inch parts
   exist, inch sizes cannot be typed.
8. **Volume and weight of what is selected**, outside robot mode.
9. **A drawing with dimensions** to print or hand over (FreeCAD, Fusion).
10. **Passing a design to someone**: a file can be sent, but there is no
    link and nothing to open one with (the phone viewer of phase 9 is the
    natural place for it).

What the app does that those do not, each a thing to lean on:

- **Real machine parts with their mates**: gears cut as a cutter cuts
  them, pulleys, sprockets, threads, and a wizard that makes the part that
  meshes. FreeCAD and Fusion need add-ons; Tinkercad has shapes that look
  the part.
- **A robot from a design in one place**: joints, mass, sensors, a drive, a
  test drive in the app, and packages that open as they are in ROS 2,
  Gazebo, MuJoCo and Isaac Sim. None of the three does this unaided.
- **Mounts and cut-outs for real boards, motors, fans and connectors.**
- **A tablet, by touch, with no account and no network**: 12 MB to
  download, files that stay on the device, free software.
- **STEP in and out** beside the mesh formats, with true surfaces where
  the shape allows; Tinkercad has no STEP at all.

Three small things that follow from the above and cost little: example
projects (they answer 1 and show off the list above); a section view (a
clipping plane in the viewer); a list of the standard parts in a design
(M3 × 10 screws, 608 bearings) to buy from.

