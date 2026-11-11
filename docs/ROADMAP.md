# Roadmap

What is left to do on PlastikCAD, in one place: what can be built now, what
needs a session together first, what is waiting on a check or a decision,
and what was put off or dropped on purpose. It is kept here, in the
repository, until version 1.0.0; from then on the work is tracked as public
issues.

Phases 0 to 6 (the review fixes, the safety net, the tablet workspace,
versions and updates, large models, the modelling features and the file
formats) are done and merged. The README says what the app does today.

## Being built now

No decision is needed for these.

- **Parts**: a throated worm wheel; screw holes in inch sizes.
- **Gears**: a preview of meshed gears turning together.
- **Lettering**: more fonts, and scripts beyond Latin.
- **STEP export**: true surfaces for what still goes out as facets: helical
  and bevel gears, threads. (Eggs, tall domes and oval cones cannot be: a
  STEP file does not keep an oval turned round an axis.)
- **PLY**: export; colors blended across a face on import.

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
  head sizes, the motor presets.

## Waiting on a decision

- **Large imports on the device.** On the Drive they are kept apart from
  their designs; on a device a project is still one whole file. Splitting
  those too would make autosave and the earlier saves small, at the price
  of a project file that is no longer complete when copied out by hand.
- **Unused files in the Drive's `Assets` folder.** Nothing removes them
  today. The proposal is a "Clean up Drive" command that moves to the
  Drive's trash what no design names and is older than a week.
- **Pictures in a zip archive that its model does not use.** They are left
  out without a word. The proposal is to leave them out and say so.

## Put off

Not dropped: taken up when asked for.

- Languages other than English and French.
- Numbers written the way the language writes them, W / D / H translated,
  the test-drive keys by position on other keyboards, the native side's
  error messages in the app's language.
- Splitting large imports out of the project files on the device (see above).

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
