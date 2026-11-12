# Roadmap

What is left to do on PlastikCAD, in one place: what can be built now, what
needs a session together first, what is waiting on a check or a decision,
and what was deferred or dropped on purpose. It is kept here, in the
repository, until version 1.0.0; from then on the work is tracked as public
issues.

Phases 0 to 6 (the review fixes, the safety net, the tablet workspace,
versions and updates, large models, the modelling features and the file
formats) are done and merged. The README says what the app does today.

## From the reviews

Six reviews were made on 2026-11-11; each has its section at the end of this
file. What they found is in two lists here: what was fixed, and what is left
to choose from. What they showed could be built has each been decided: it is
under "Next to build", "Deferred" or "Dropped".

### Fixed

All merged on 2026-11-11, after version 0.2.0: they go out with the next
release.

| Pull request | What it fixes | From |
|---|---|---|
| #44 | Escape, or a press beside the box, deleted the file that was opened | 1 |
| #45 | Linux desktop: exports failed after the first STEP or compressed glTF file of a session | 1 |
| #47 | Every Linux job of the CI failed when the runners could not reach Ubuntu's package hosts | – |
| #48 | A small file could freeze the app for good; three slow readers | 5 |
| #49 | The native side's check of the kind of file could be got round | 5 |
| #50 | A save during a sync pass, undo after a merge, and an import ending in another project each lost work; two new projects of one name took one file | 2 |
| #51 | "Empty Trash" during a sync pass; a project file copied by hand; names differing by an accent's form; saved versions of an old-format file | 2 |
| #52 | A move of the projects folder that fails part-way, and its trash; a listing that is short or empty taken for deletions | 2 |
| #53 | A STEP export of many imported meshes ran a tablet out of memory | 1, 4 |
| #54 | A dropped file that cannot be read said nothing; a failed save was not tried again; reloading on a failed save; the save box replacing a file unasked; names in the diagnostics; smaller wording | 1, 2, 5 |
| #55 | Android: Back left the app with a box still open | 1 |
| #56 | The look for updates at start can be turned off; the Android sign-in asks for one access only; a stricter content policy; imported data read strictly; no installation id in a copy | 2, 5 |
| #57 | Actions named by movable tags in the job that holds the signing key; native tests before a release | 5 |
| #58 | A finger took the wrong align dot, and resized where it meant to turn; panels opening behind the inspector; both panels left over the plate; the keypad rising over the projects | 3 |
| #59 | A test of the parts that passed or failed by the speed of the CI runner | – |

### Left to choose from

By touch (review 3):

- **What the app says by touch**, put by for now, to be talked through as
  one question:
  icon buttons have no name a finger can see (they are in tooltips; a long
  press is not to be used for it), hints speak of clicks and Esc, and the
  list of shortcuts is long and always in the side panel.
- **The inspector by touch**: a part with many settings has to be scrolled;
  whether its layout can ask for less of that is to be seen on the device.
- Small targets outside what the tests measure (the view buttons, the
  buttons of an Objects row, the panel tabs); the help marks, to be tried
  on the device.

## Next to build

Nothing is waiting here: what could be built without a session has been.
The phases below are next.

## Phases that need a session first

Each of these changes how the app is used, so its features and approach are
agreed in a working session before anything is built.

| Phase | What | What the session has to settle |
|---|---|---|
| 7 | **Robot mode**, made dependable | Found by building a real robot with it, start to finish, on the desktop and on the tablet. Agreed: a control on the screen to drive with when no keyboard is attached. Open design questions: mecanum strafing, the kinds of joint that close a loop, the camera's optical frame, the base frame of a USD stage, the inspector's wording and touch sizes. Until then the mode is experimental: crashes and wrong output are fixed, behaviour is not polished. |
| 8 | **Release** | The Play Console set-up and the Android signing key, the APK attached to releases, the store listing and screenshots, the color register, code signing for Windows and macOS. Signing the update files in a step of its own, after the build, so the key is not at hand while the build runs. The tablet held upright: the app is made to be held sideways, but from Android 17 an app on a large screen can no longer refuse to turn or to be resized, so upright and split-screen have to stay usable (there the open inspector covers the Dimensions box's number boxes and six toolbar buttons, a first start shows a bare plate, the "Custom" tile opens a hidden inspector, and the hint bar is cut by the Library); it is not what the app is made for and need not be as good, but it is not to be neglected. |
| 9 | **Phone viewer** | The app on a phone as a viewer: which objects and projects it shows, what replaces the edit controls, how a design gets there. The starting point: the app as it is, linked to the user's Google Drive, showing the projects synced there, able to export a design and share the file, and little beyond that. The editor itself stays for tablets and desktop. |
| 10 | **AI features** | Tests of whether it is viable and useful come before any integration: what it would do (the first idea is help with the constraints of a robot being prototyped), which service, what it costs, where a key is kept, and what "nothing leaves your machine" then means. |

## Waiting on a check

Things only the real devices and accounts can show.

- Google Drive with a large import: the `Assets` folder appears, the design
  file on the Drive stays small, and the tablet opens and edits it.
- A Drive upload of more than 4 MB.
- A STEP file from Fusion 360: that it opens, with its names and colors.
- On the tablet: PLY, zip and STEP import, STEP export, the licenses in the
  About box.
- On the tablet held upright: that every flow can still be done.
- On the tablet: how long a STEP export of a helical gear and of a bolt
  takes (about a second each on the workstation).
- A STEP file with a helical gear and a bolt opened in Fusion 360.
- On the tablet: inches (**File → Units…**): the boxes, the entry sheet,
  the snap steps and the grid.
- On the tablet: a swipe that begins on a slider scrolls the inspector, and
  a drag along it or a tap still sets it (#66).
- On the desktop: saving a STEP export through the dialog; the Mac build.
- A `.gltf` with its files apart, picked on Android.
- The French glossary (`src/i18n/fr/glossary.md`).
- Figures taken from memory or a single source: the M14 countersink, the
  M14 to M20 clearance holes, the heat-set insert bores, the M2 and M2.5
  head sizes, the motor presets, the V-belt groove sizes, the inch thread,
  head and nut sizes, the inch clearance holes and countersunk heads.
- Google Drive's "Clean up…" against a real Drive.
- The desktop app on a Mac: STEP and compressed glTF files, then an export
  (see the first finding of review 1, fixed on Linux and not tried there).

## Deferred

Not dropped: put by, to come back to.

- Languages other than English and French.
- **Bevel gears as true surfaces in STEP files.** They go out as facets
  today, which is right for every setting but large and not to be picked
  in a CAD program. In the trial of 2026-11-11 the smooth form came out
  right for larger gears and wrong for a pinion of twelve teeth (1.2% off
  in volume; the checks would send it out as facets). To come back to:
  find why the pinion fails, then decide whether rewriting the generator
  is worth it.
- True surfaces in STEP files for a throated worm wheel and for threads of
  eight starts on a thin shaft, which also go out as facets. (Eggs, tall
  domes and oval cones cannot be done at all: a STEP file does not keep an
  oval turned round an axis.)
- Fractions of an inch typed into a box: inches are decimal.
- The browser tests in WebKit as well as Chromium: the script that tries
  the built apps before a release (`pnpm check:apps`) runs the desktop app
  itself, which is WebKit; taken up only if a fault gets past it.
- Lettering in scripts that need shaping (Arabic, Hebrew, the Indic scripts)
  or thousands of characters (Chinese, Japanese, Korean): each needs fonts of
  megabytes fetched when asked for, and the first three a shaping engine.
- Numbers written the way the language writes them, W / D / H translated,
  the test-drive keys by position on other keyboards, the native side's
  error messages in the app's language.
- French text that is cut (long names on the part tiles): the English
  layout comes first.
- Splitting large imports out of the project files on the device, as is done
  on the Drive: a project stays one whole file that can be copied out by
  hand, until a real large project shows the saving is worth that.

## Dropped

Decided against; not to be proposed again.

- A gesture to select what is behind an object: Ghost is how it is reached.
- Snapping while moving, and a work plane.
- A preview of meshed gears turning together: it shows something and does
  nothing. The wizard already places a mate where it meshes, and a mate is a
  part of its own afterwards, with nothing to say it still meshes.
- Example projects in the app: tutorials are published instead.
- An enclosure made from a board: a box is built by hand, as any other.
- Volume and weight of the selection outside robot mode: materials and
  mass belong to robot mode, where the formats ask for them.
- A list of the standard parts in a design.
- A link to pass a design on, or anything else that needs a server kept
  running: a feature works on the device or through the user's own Google
  Drive.
- A way to keep the Dimensions box off the handles: the view is moved.
- A section view (the model cut by a plane to look inside).
- STEP for meshes as tessellated shapes. Tried on 2026-11-11: the file is 35
  times smaller, but FreeCAD draws nothing for such a body and fails when
  it is cut, the slicers cannot read it, and nothing says Fusion takes it.
- Steppers on the number boxes.
- A change to Android's backup: it stays at the system's default, which
  brings the projects back after a restore.
- In robot mode: a two-click joint tool, dragging to re-parent, axis
  defaults for round children, shaft-aware parts, an automatic base.

## Reviews

Passes over the whole project, each ending in a list of findings to choose
from rather than in fixes. All six were made on 2026-11-11; what came of
them is summed up in "From the reviews" above, and each has its record
below. They were:

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

### Review 3: tablet usability (2026-11-11)

Every main flow at tablet size (1280 × 800 and 800 × 1280), with fingers,
in English and in French, on the built app in Chromium: placing, selecting,
the handles, the camera, the inspector, the toolbar, the panels, projects,
the mating wizard, custom parts, robot mode. The real keypad, the system's
pickers and the colour picker could not be walked there.

Fixed (#58): a finger on the "front" or "bottom" align dot aligned left, and
one on the turn arrow beside a corner grip resized; the mating gear and
array panels opened behind the inspector on an upright tablet; a tablet
turned upright kept both panels over the plate; the projects box raised the
keypad as it opened.

Left: see "Left to choose from" above. The three that stop a task or come
close: the test drive cannot be driven without a keyboard; upright, the
inspector covers the Dimensions box; a slider takes a swipe meant to scroll.

What works well by touch: placing by tap and double tap; tap to select,
a long press to add, a long press and drag to box-select; one finger to
orbit, two to pan and pinch; the readout above the finger; every handle
once it is reached; the entry sheet, which takes "32,5" and stays above the
keypad; the gear inspector without scrolling; the Objects list under a
finger; projects, the File menu, About, Language, the format list, the
ruler, Array, Mirror and Group in both orientations and in French.

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

### Review 5: security and privacy (2026-11-11)

The native commands and what the page may ask of them, the page itself and
its content security policy, every reader of a file from elsewhere, the
sign-in and sync, what leaves the device, the names written into exports,
and the release workflow. The details of the first finding are kept out of
this public file until it is fixed.

1. **The native side's check of the kind of file can be got round** by a
   script running in the page, for reading and for writing. No way to run
   such a script was found (nothing from a file reaches the page as HTML,
   and the policy allows no evaluated code), so it is a second line of
   defence that does not hold, not a way in. Shown by a script against the
   same parsing the app uses.
2. **A file of a few hundred bytes can freeze the app for good.** Two of
   the patterns that tell what an unnamed file is (an OBJ, an SVG) take
   twice as long for every blank line or empty comment at the top: some
   forty and the window never answers again. Any file whose ending is not a
   model, a picture or an archive is looked at this way, a `.mtl` or one
   inside a zip included; an honest file with many blank lines at its top
   does it by accident. Timed: 26 blank lines take a third of a second.
3. **The release job gives the update-signing key to everything it runs**:
   the actions are named by tags that can be moved, and the build itself
   runs with the key at hand. One of them compromised at release time would
   be a signed update. The release also runs no native tests.
4. **Slow patterns of the second kind** (the time grows with the square of
   the size): a design file padded with tens of thousands of blank lines
   stalls the list of projects for up to a minute at each start; a crafted
   SVG ties up the geometry worker.
5. **The app asks github.com for a newer version at every start, unasked**
   (desktop, installed builds), with no setting to turn it off; the
   README's first lines say nothing leaves the machine unless a Drive is
   linked. What goes is one request with no word of the user or the design.
6. **The check is by kind of file, not by place**: a script in the page
   could read any picture, model or archive on the disk, replace any file
   of a kind the app writes, and delete or move any design, anywhere. As
   designed, and only as strong as finding 1.
7. Small: the page chooses the scope asked of Google on Android (the
   consent sheet still has to be accepted) and two permissions of the
   device plugin are granted and never used; Android's backup is left at
   its default, so projects and the hour-long Drive token go into the
   device's backup; a design passed on carries an id that is the same for
   every design from one installation; "Copy diagnostics" holds the
   projects folder (so the user's name) and recent error texts with paths;
   unlinking says so even when Google could not be told; a design's name
   goes unchanged into the name offered for an export; the policy lacks
   `base-uri`, `form-action` and `object-src`.

Found sound: the page is granted the dialogs, the updater and the app's own
commands and nothing else (no file-system or opener permission, no global
bridge); nothing from a file is ever set as HTML or evaluated; no
analytics, no crash reports, no fonts or scripts fetched; the readers of
XML, zip, 3MF, STL, PLY, glTF, Collada, DXF and SVG cap what they take and
check counts against the bytes before making room, and names inside an
archive are never used as paths; the design reader takes only the fields
it knows; the sign-in uses PKCE with a checked state, a loopback on
127.0.0.1 at a random port and a page that echoes nothing, asks for
`drive.file` alone, and keeps tokens in the system keychain; every name
that reaches a robot description, a launch file, a script or a path inside
a package is reduced to letters, digits and underscores first; pull
requests run without secrets.

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
