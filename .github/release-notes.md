PlastikCAD is a desktop app for fast solid modelling for 3D printing: drop shapes and parametric parts on the plate, turn some into holes, group, and export for your slicer. It runs locally; nothing leaves your machine unless you link a Google Drive. Free software under the GPL-3.0.

## What's in it

- **Shapes and holes** – boxes, cylinders, wedges, domes and more; any object adds material or cuts it away, and groups never bake anything in.
- **Parametric parts** – spur, helical, herringbone, ring, rack, bevel and worm gears, timing pulleys and sprockets, metric screws and nuts, screw holes and bearing seats that cut their own fit, aluminium rails, pipes and ducts, fan cutouts, panel connectors, motor mounts, and dev boards (Raspberry Pi, Arduino, ESP32, Jetson) with their holes and sockets.
- **Mating wizard** – pick a gear and add its mate (gear, ring, rack, worm wheel or bevel pair), the other pulley or sprocket of a belt or chain drive, or the sun and planets of a ring gear, with a live preview, meshed and placed at the right centre distance.
- **Array** – a panel that copies the selection in a row, a grid or a circle, and stays open while you turn the view.
- **Text** – four print-friendly fonts, bent round a cylinder or laid along an arc.
- **Pictures and textures** – wrap a picture round an object or tile it over every side; imported meshes keep their own UV layout. Pictures and textures travel in GLB exports.
- **Robot mode** – make the design a robot: links, joints with real motor figures, sensors (camera, lidar, IMU, touch), drive setup, and a MuJoCo test drive right on the plate. Exports a ROS 2 package (RViz and Gazebo), an SDF model, a MuJoCo model with Python starters, or an Isaac Sim stage.
- **Import and export** – STL, OBJ, PLY, 3MF, GLB/glTF and Collada meshes, STEP solids from a CAD program with their names and colors, SVG and DXF drawings, PNG/JPEG pictures, URDF robots, and zip archives of any of these in; STL, 3MF, OBJ, PLY, GLB, STEP, SVG and DXF out. A STEP file carries true surfaces (planes, cylinders, cones, spheres, tori) wherever an object can be rebuilt from what it is.
- **Projects** – autosaved locally, with earlier saves to go back to and a trash, and optional Google Drive sync. A design from an older version opens in a newer one as it is; one from a newer version is offered as a copy without what the older one does not know.
- **Updates** – the desktop app looks for a newer version when it starts and installs it when you say so. The AppImage updates itself; the `.deb` and `.rpm` are updated by installing the new package.
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
