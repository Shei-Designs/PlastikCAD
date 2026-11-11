PlastikCAD is a desktop app for fast solid modelling for 3D printing: drop shapes and parametric parts on the plate, turn some into holes, group, and export for your slicer. It runs locally; nothing of yours leaves your machine unless you link a Google Drive. Free software under the GPL-3.0.

## Fixed in 0.2.1

- **Opening a design file from outside the projects folder**: leaving the "Project added" box by Escape or a click beside it deleted the file that was opened. It now keeps it.
- **Linux**: after the first STEP file or compressed glTF of a session, exports failed until the app was started again.
- **Google Drive sync**: an edit saved while a sync was under way could put the old design back over what another device had saved; undo after a sync could take the other device's changes out; emptying the trash, moving the projects folder and a file that could not be read for a moment could each delete more than was meant.
- **Imports**: an import that finished after another project had been opened replaced that project's objects; a file with many blank lines at its top could freeze the app.
- **Android**: Back now closes what is open, and only leaves the app when nothing is; a STEP export of many imported meshes no longer runs the tablet out of memory.
- **By touch**: a finger takes the align dot or turn arrow it is on; the mating gear and array panels no longer open behind the inspector on a tablet held upright.
- **Privacy**: the look for a newer version at start can be turned off (File → About); "Copy diagnostics" leaves out the name of the computer's user.

## What's in it

- **Shapes and holes** – boxes, cylinders, wedges, domes and more; any object adds material or cuts it away, and groups never bake anything in.
- **Parametric parts** – spur, helical, herringbone, ring, rack, bevel and worm gears with a throated worm wheel, timing pulleys and sprockets, metric screws and nuts, screw holes and bearing seats that cut their own fit, aluminium rails, pipes and ducts, fan cutouts, panel connectors, motor mounts, and dev boards (Raspberry Pi, Arduino, ESP32, Jetson) with their holes and sockets.
- **Mating wizard** – pick a gear and add its mate (gear, ring, rack, worm wheel or bevel pair), the other pulley or sprocket of a belt or chain drive, or the sun and planets of a ring gear, with a live preview, meshed and placed at the right centre distance.
- **Array** – a panel that copies the selection in a row, a grid or a circle, and stays open while you turn the view.
- **Text** – seven print-friendly fonts, in Latin, Cyrillic, Greek and Vietnamese, bent round a cylinder or laid along an arc.
- **Pictures and textures** – wrap a picture round an object or tile it over every side; imported meshes keep their own UV layout. Pictures and textures travel in GLB exports.
- **Robot mode** – make the design a robot: links, joints with real motor figures, sensors (camera, lidar, IMU, touch), drive setup, and a MuJoCo test drive right on the plate. Exports a ROS 2 package (RViz and Gazebo), an SDF model, a MuJoCo model with Python starters, or an Isaac Sim stage.
- **Import and export** – STL, OBJ, PLY, 3MF, GLB/glTF and Collada meshes, STEP solids from a CAD program with their names and colors, SVG and DXF drawings, PNG/JPEG pictures, URDF robots, and zip archives of any of these in; STL, 3MF, OBJ, PLY, GLB, STEP, SVG and DXF out. A STEP file carries true surfaces (planes, cylinders, cones, spheres, tori) wherever an object can be rebuilt from what it is.
- **Projects** – autosaved locally, with earlier saves to go back to and a trash, and optional Google Drive sync. A design from an older version opens in a newer one as it is; one from a newer version is offered as a copy without what the older one does not know.
- **Updates** – the desktop app looks for a newer version when it starts (a switch in File → About turns that off) and installs it when you say so. The AppImage updates itself; the `.deb` and `.rpm` are updated by installing the new package.
- **Languages** – English and French (File → Language…).

## Download

| Platform | File to pick |
| --- | --- |
| Windows | `…_x64-setup.exe` (installer) or `…_x64_en-US.msi` |
| macOS, Apple Silicon (M1 and later) | `…_aarch64.dmg` |
| macOS, Intel | `…_x64.dmg` |
| Linux, any distribution | `…_amd64.AppImage` (make it executable, then run it) |
| Debian / Ubuntu | `…_amd64.deb` |
| Fedora / openSUSE | `….x86_64.rpm` |

## First launch

These builds are not code-signed yet, so the operating system will ask before running them.

- **Windows:** SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **macOS:** open the app once, dismiss the warning, then go to **System Settings → Privacy & Security** and choose **Open Anyway**. If macOS reports that the app is damaged, run `xattr -cr /Applications/PlastikCAD.app` in Terminal and open it again.
- **Linux:** no extra steps.
