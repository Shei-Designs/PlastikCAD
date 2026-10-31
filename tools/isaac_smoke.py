"""Imports every exported ROS 2 package under a folder into Isaac Sim, runs it,
and says whether it behaves. Needs Isaac Sim's own Python (the pip install,
see the README); point ISAACSIM_PYTHON at it:

    ISAACSIM_PYTHON=~/isaacsim-env/bin/python pnpm smoke:isaac

Each URDF goes through the URDF importer with its package mapped so the
package:// meshes resolve, the base mobile unless the URDF hangs from `world`,
velocity drives on the continuous joints and position drives on the rest, with
gains from the URDF's effort and velocity. Then, headless: the robot is put on
a floor, the continuous joints are driven, the others told to hold, and after
two seconds a mobile robot with wheels must have moved, a fixed one must not,
no robot may have collapsed, every link with a visual must have come in as a
colored mesh, every joint must be there, and a picture is saved under
<root>/pictures. Exit code 1 on any failure, 2 when isaacsim is missing.
"""
import glob
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

WHEEL_SPEED = 6.0  # rad/s sent to every continuous joint
SECONDS = 2.0
MUST_MOVE = 0.05  # m, for a mobile robot with continuous joints
MAY_SETTLE = 0.02  # m the root may drop while settling onto the floor


def urdf_of(pkg):
    name = os.path.basename(pkg)
    path = os.path.join(pkg, 'urdf', f'{name}.urdf')
    return path if os.path.exists(path) else None


def read_urdf(path):
    """Links with a visual, the joints with their type and limits, and whether the root is `world`."""
    root = ET.parse(path).getroot()
    links = [l.get('name') for l in root.findall('link')]
    visuals = [l.get('name') for l in root.findall('link') if l.find('visual') is not None]
    joints = []
    children = set()
    for j in root.findall('joint'):
        limit = j.find('limit')
        joints.append({
            'name': j.get('name'),
            'type': j.get('type'),
            'effort': float(limit.get('effort')) if limit is not None and limit.get('effort') else None,
            'velocity': float(limit.get('velocity')) if limit is not None and limit.get('velocity') else None,
        })
        children.add(j.find('child').get('link'))
    roots = [l for l in links if l not in children]
    return {'links': links, 'visuals': visuals, 'joints': joints, 'fixed': 'world' in roots}


def one(pkg, pictures):
    """Imports and runs one package inside Isaac Sim; prints a RESULT line."""
    name = os.path.basename(pkg)
    urdf = urdf_of(pkg)
    info = read_urdf(urdf)
    result = {'name': name, 'problems': [], 'notes': []}

    from isaacsim import SimulationApp
    app = SimulationApp({'headless': True, 'width': 960, 'height': 600})
    try:
        import numpy as np
        import omni.usd
        from pxr import Gf, Usd, UsdGeom, UsdLux, UsdPhysics, UsdShade
        from isaacsim.asset.importer.urdf import URDFImporter, URDFImporterConfig
        from isaacsim.core.api import World
        from isaacsim.core.prims import Articulation
        from isaacsim.core.utils.stage import add_reference_to_stage
        from isaacsim.core.utils.viewports import set_camera_view
        from isaacsim.sensors.camera import Camera

        # Drives: velocity on the continuous joints, position on the others, gains from the URDF.
        moving = [j for j in info['joints'] if j['type'] in ('continuous', 'revolute', 'prismatic')]
        wheels = [j['name'] for j in moving if j['type'] == 'continuous']
        servos = [j['name'] for j in moving if j['type'] != 'continuous']
        pattern = lambda names: '^(' + '|'.join(re.escape(n) for n in names) + ')$'  # noqa: E731
        targets, damping, stiffness = {}, {}, {}
        for j in moving:
            kd = (j['effort'] / j['velocity']) if j['effort'] and j['velocity'] else 0.01
            if j['type'] == 'continuous':
                targets[pattern([j['name']])] = 'velocity'
                damping[pattern([j['name']])] = kd
                stiffness[pattern([j['name']])] = 0.0
            else:
                kp = (j['effort'] / 0.1) if j['effort'] else 1.0
                targets[pattern([j['name']])] = 'position'
                stiffness[pattern([j['name']])] = kp
                damping[pattern([j['name']])] = kp / 20
        out = os.path.join(pkg, 'isaac')
        os.makedirs(out, exist_ok=True)
        config = URDFImporterConfig(
            urdf_path=urdf,
            usd_path=out,
            ros_package_paths=[{'name': name, 'path': pkg}],
            fix_base=info['fixed'],
            joint_target_type=targets or None,
            override_joint_stiffness=stiffness or None,
            override_joint_damping=damping or None,
        )
        usd_path = URDFImporter(config).import_urdf()
        result['usd'] = usd_path

        world = World(stage_units_in_meters=1.0)
        world.scene.add_default_ground_plane()
        stage = omni.usd.get_context().get_stage()
        UsdLux.DomeLight.Define(stage, '/World/Dome').CreateIntensityAttr(1000.0)
        sun = UsdLux.DistantLight.Define(stage, '/World/Sun')
        sun.CreateIntensityAttr(3000.0)
        UsdGeom.Xformable(sun.GetPrim()).AddRotateXYZOp().Set(Gf.Vec3f(-50, 20, 0))
        prim_path = '/World/Robot'
        add_reference_to_stage(usd_path=usd_path, prim_path=prim_path)
        robot = stage.GetPrimAtPath(prim_path)
        vs = robot.GetVariantSet('Physics')
        if vs.IsValid() and 'physx' in vs.GetVariantNames():
            vs.SetVariantSelection('physx')
        if not info['fixed']:
            xf = UsdGeom.Xformable(robot)
            xf.ClearXformOpOrder()
            xf.AddTranslateOp().Set(Gf.Vec3d(0, 0, 0.01))

        # What came in.
        meshes, materials, joints, root = [], 0, [], None
        for prim in Usd.PrimRange(robot, Usd.TraverseInstanceProxies()):
            if prim.IsA(UsdGeom.Mesh) and UsdGeom.Imageable(prim).ComputePurpose() == 'default':
                meshes.append(prim.GetPath().name)
                if UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]:
                    materials += 1
            elif prim.IsA(UsdPhysics.Joint):
                joints.append(prim.GetPath().name)
            if prim.HasAPI(UsdPhysics.ArticulationRootAPI) and root is None:
                root = str(prim.GetPath())
        result['meshes'] = len(meshes)
        result['materials'] = materials
        result['joints'] = len(joints)
        if len(meshes) < len(info['visuals']):
            result['problems'].append(f"{len(meshes)} visual meshes came in for {len(info['visuals'])} links with a visual")
        if materials < len(meshes):
            result['problems'].append(f'{len(meshes) - materials} meshes have no material')
        missing = [j['name'] for j in info['joints'] if j['type'] != 'fixed' and j['name'] not in joints]
        if missing:
            result['problems'].append(f"joints missing: {', '.join(missing)}")
        if root is None:
            result['problems'].append('no articulation root')
            print('RESULT ' + json.dumps(result), flush=True)
            return

        camera = Camera(prim_path='/World/Camera', resolution=(960, 600))
        world.reset()
        camera.initialize()
        camera.set_clipping_range(0.01, 100.0)
        art = Articulation(prim_paths_expr=root)
        art.initialize()
        names = list(art.dof_names or [])
        kps, kds = art.get_gains()
        result['gains'] = {n: [round(float(np.asarray(kps)[0][i]), 4), round(float(np.asarray(kds)[0][i]), 4)] for i, n in enumerate(names)}
        start = np.asarray(art.get_world_poses()[0][0]).copy()
        dt = world.get_physics_dt()
        vel = np.zeros((1, len(names)), dtype=np.float32)
        for i, n in enumerate(names):
            if n in wheels:
                vel[0, i] = WHEEL_SPEED
        pos = np.zeros((1, len(names)), dtype=np.float32)
        for i in range(int(SECONDS / dt)):
            if wheels:
                art.set_joint_velocity_targets(vel)
            if servos:
                art.set_joint_position_targets(pos)
            world.step(render=(i % 10 == 0))
        end = np.asarray(art.get_world_poses()[0][0])
        moved = float(np.linalg.norm(end[:2] - start[:2]))
        dropped = float(start[2] - end[2])
        result['moved_mm'] = round(moved * 1000)
        result['dropped_mm'] = round(dropped * 1000)
        q = np.asarray(art.get_joint_positions())[0]
        result['servo_error_deg'] = round(float(np.degrees(np.max(np.abs([q[i] for i, n in enumerate(names) if n in servos])))), 1) if servos else None
        if info['fixed']:
            if moved > 0.001:
                result['problems'].append(f'fixed base moved {moved * 1000:.0f} mm')
        else:
            if wheels and moved < MUST_MOVE:
                result['problems'].append(f'moved only {moved * 1000:.0f} mm in {SECONDS:.0f} s with the wheels at {WHEEL_SPEED} rad/s')
            if dropped > MAY_SETTLE:
                result['problems'].append(f'the root dropped {dropped * 1000:.0f} mm: the robot collapsed')
        if servos and result['servo_error_deg'] is not None and result['servo_error_deg'] > 10:
            result['problems'].append(f"servos told to hold 0 drifted {result['servo_error_deg']}°")

        # A picture, aimed at the robot where it ended up.
        cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ['default'], useExtentsHint=False)
        box = cache.ComputeWorldBound(robot).ComputeAlignedRange()
        center = np.array([(a + b) / 2 for a, b in zip(box.GetMin(), box.GetMax())])
        size = max(b - a for a, b in zip(box.GetMin(), box.GetMax()))
        eye = center + np.array([2.6, -2.6, 1.6]) * max(size, 0.1)
        set_camera_view(eye=eye, target=center, camera_prim_path='/World/Camera')
        for _ in range(40):
            world.step(render=True)
        rgba = camera.get_rgba()
        if rgba is not None and getattr(rgba, 'size', 0):
            from PIL import Image
            os.makedirs(pictures, exist_ok=True)
            picture = os.path.join(pictures, f'isaac_{name}.png')
            Image.fromarray(np.asarray(rgba)[:, :, :3].astype(np.uint8)).save(picture)
            result['picture'] = picture
            colors = len(np.unique(np.asarray(rgba)[:, :, :3].reshape(-1, 3), axis=0))
            if colors < 50:
                result['problems'].append(f'the picture shows {colors} colors: nothing rendered')
        try:
            vram = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout.strip()
            result['vram_mib'] = int(vram)
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        result['problems'].append(f'{type(e).__name__}: {e}')
    finally:
        print('RESULT ' + json.dumps(result), flush=True)
        app.close()


def main():
    if len(sys.argv) > 2 and sys.argv[1] == '--one':
        one(sys.argv[2], sys.argv[3])
        return
    root = sys.argv[1] if len(sys.argv) > 1 else 'fixtures/out'
    packages = sorted(p for p in glob.glob(os.path.join(root, 'ros', '*')) if urdf_of(p))
    if not packages:
        print(f'No ROS 2 packages under {root}/ros; run pnpm smoke:robots first.')
        sys.exit(1)
    # Importing isaacsim asks about the EULA; the answer is given here and inherited by the runs.
    os.environ.setdefault('OMNI_KIT_ACCEPT_EULA', 'YES')
    try:
        import isaacsim  # noqa: F401
    except ImportError:
        print('isaacsim is not installed in this Python. Install it (pip install "isaacsim[all,extscache]" --extra-index-url https://pypi.nvidia.com, Python 3.12) and set ISAACSIM_PYTHON to that interpreter.')
        sys.exit(2)
    pictures = os.path.abspath(os.path.join(root, 'pictures'))
    env = {**os.environ, 'OMNI_KIT_ACCEPT_EULA': 'YES'}
    failures = 0
    for pkg in packages:
        name = os.path.basename(pkg)
        run = subprocess.run([sys.executable, os.path.abspath(__file__), '--one', os.path.abspath(pkg), pictures], env=env, capture_output=True, text=True)
        line = next((l for l in run.stdout.splitlines() if l.startswith('RESULT ')), None)
        if not line:
            failures += 1
            tail = '\n'.join((run.stdout + run.stderr).splitlines()[-15:])
            print(f'FAIL {name}: Isaac Sim gave no result (exit {run.returncode})\n{tail}')
            continue
        r = json.loads(line[len('RESULT '):])
        facts = [f"{r.get('meshes', 0)} meshes ({r.get('materials', 0)} colored)", f"{r.get('joints', 0)} joints"]
        if 'moved_mm' in r:
            facts.append(f"moved {r['moved_mm']} mm, settled {r['dropped_mm']} mm")
        if r.get('servo_error_deg') is not None:
            facts.append(f"servos within {r['servo_error_deg']}°")
        if 'vram_mib' in r:
            facts.append(f"{r['vram_mib']} MiB VRAM in use")
        if r['problems']:
            failures += 1
            print(f"FAIL {name}: {'; '.join(r['problems'])}  [{', '.join(facts)}]")
        else:
            print(f"PASS {name}: {', '.join(facts)}" + (f"  -> {os.path.relpath(r['picture'])}" if r.get('picture') else ''))
    print(f'{len(packages) - failures} of {len(packages)} packages pass in Isaac Sim.')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
