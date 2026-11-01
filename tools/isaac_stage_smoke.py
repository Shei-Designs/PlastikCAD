"""Opens every exported Isaac Sim stage under a folder, plays it, talks to it
over ROS 2 and says whether it behaves. Run through isaac_stage_smoke.sh,
which finds Isaac Sim's Python and its bundled ROS 2 libraries:

    pnpm smoke:usd

For each <folder>/<name>/<name>.usda: the stage is opened as a user would
(no import, no script), a wall is put a meter ahead of the robot, and it is
played for a few seconds while a ROS 2 node in the same process drives it
(cmd_vel, ackermann_cmd or joint_command, by what the stage's graph takes)
and listens to what it publishes. A driven robot must move, a fixed one must
not, nothing may collapse, every joint and visual mesh must be there, joint
states and clock must arrive, odometry must agree with the robot's pose, a
lidar must see the wall at a meter with as many rays as the design has, an
IMU must read gravity straight up, a camera must send pictures, and a picture
of the scene is saved under <folder>/../pictures. Exit code 1 on any failure,
2 when isaacsim is missing.
"""
import glob
import json
import math
import os
import re
import subprocess
import sys

SECONDS = 3.0
SPEED = 0.3  # m/s asked of a rover
MUST_MOVE = 0.1  # m
MAY_SETTLE = 0.02  # m the base may drop while settling
WALL_AT = 1.0  # m ahead


def stage_of(folder):
    name = os.path.basename(folder)
    path = os.path.join(folder, f'{name}.usda')
    return path if os.path.exists(path) else None


def read_stage(path):
    """What the text promises: the ROS topics it subscribes to, the lidars' ray counts, the sensors by kind."""
    text = open(path, encoding='utf-8').read()
    topics = set(re.findall(r'inputs:topicName = "([^"]+)"', text))
    lidars = {m.group(1): int(m.group(2)) for m in re.finditer(r'string omni:sensor:modelName = "([^"]+)"[^}]*?uint omni:sensor:tickRate|def OmniLidar "([^"]+)"', text) if False}
    lidars = {}
    for m in re.finditer(r'def OmniLidar "([^"]+)"', text):
        block = text[m.end():m.end() + 6000]
        rays = re.search(r'uint omni:sensor:Core:reportRateBaseHz = (\d+)', block)
        rate = re.search(r'uint omni:sensor:Core:scanRateBaseHz = (\d+)', block)
        lidars[m.group(1)] = int(rays.group(1)) // max(int(rate.group(1)), 1) if rays and rate else None
    return {
        'topics': topics,
        'cameras': re.findall(r'def Camera "([^"]+)"', text),
        'imus': re.findall(r'def IsaacImuSensor "([^"]+)"', text),
        'touches': re.findall(r'def IsaacContactSensor "([^"]+)"', text),
        'lidars': lidars,
        'joints': re.findall(r'def Physics(?:Revolute|Prismatic)Joint "([^"]+)"', text),
        'fixed_base': 'def PhysicsFixedJoint "root_joint"' in text,
        'meshes': len(re.findall(r'def Mesh "visual_\d+"', text)),
        'wheels': re.findall(r'custom token\[\] inputs:jointNames = \[([^\]]*)\]', text),
    }


def one(path, pictures):
    name = os.path.basename(os.path.dirname(path))
    info = read_stage(path)
    result = {'name': name, 'problems': [], 'notes': []}

    from isaacsim import SimulationApp
    app = SimulationApp({'headless': True, 'width': 960, 'height': 600})
    try:
        import numpy as np
        import omni.usd
        from pxr import Gf, Usd, UsdGeom, UsdPhysics, UsdShade
        from isaacsim.core.utils.extensions import enable_extension
        for ext in ('isaacsim.core.nodes', 'isaacsim.sensors.physics', 'isaacsim.sensors.experimental.physics', 'isaacsim.sensors.rtx', 'isaacsim.robot.wheeled_robots', 'isaacsim.ros2.bridge'):
            enable_extension(ext)
        app.update()
        app.update()
        from isaacsim.core.api import World
        from isaacsim.core.prims import Articulation
        from isaacsim.core.utils.viewports import set_camera_view
        from isaacsim.sensors.camera import Camera

        ctx = omni.usd.get_context()
        if not ctx.open_stage(path):
            result['problems'].append('the stage did not open')
            return
        app.update()
        stage = ctx.get_stage()
        world = World(stage_units_in_meters=1.0)

        # The robot's articulation, its joints and meshes, as the stage has them.
        root = None
        joints, meshes, materials = [], [], 0
        for prim in stage.Traverse():
            if prim.HasAPI(UsdPhysics.ArticulationRootAPI) and root is None:
                root = str(prim.GetPath())
            if prim.IsA(UsdPhysics.Joint) and prim.GetName() != 'root_joint':
                joints.append(prim.GetName())
            if prim.IsA(UsdGeom.Mesh) and prim.GetName().startswith('visual_'):
                meshes.append(prim.GetName())
                if UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]:
                    materials += 1
        result['joints'] = len(joints)
        result['meshes'] = len(meshes)
        if root is None:
            result['problems'].append('no articulation root')
            return
        missing = [j for j in info['joints'] if j not in joints]
        if missing:
            result['problems'].append(f"joints missing: {', '.join(missing)}")
        if len(meshes) != info['meshes']:
            result['problems'].append(f"{len(meshes)} visual meshes for {info['meshes']} in the file")
        if materials < len(meshes):
            result['problems'].append(f'{len(meshes) - materials} meshes have no material')

        # Which way the robot faces: the drive's forward is where the wall goes; without a drive, +Y.
        forward = np.array([0.0, 1.0, 0.0])
        robot = stage.GetPrimAtPath(root)
        drive_kind = 'ackermann' if 'ackermann_cmd' in info['topics'] else 'twist' if 'cmd_vel' in info['topics'] else 'joints' if 'joint_command' in info['topics'] else None
        # A wall a meter ahead, half a meter wide and high, for the lidar to see.
        wall = UsdGeom.Cube.Define(stage, '/World/Wall')
        wall.CreateSizeAttr(1.0)
        xf = UsdGeom.Xformable(wall.GetPrim())
        xf.AddTranslateOp().Set(Gf.Vec3d(*(forward * WALL_AT + np.array([0, 0, 0.25]))))
        xf.AddScaleOp().Set(Gf.Vec3f(0.5, 0.05, 0.5) if abs(forward[1]) > 0.5 else Gf.Vec3f(0.05, 0.5, 0.5))
        UsdPhysics.CollisionAPI.Apply(wall.GetPrim())

        # ROS 2 in this process, through Isaac's bridge libraries.
        try:
            import rclpy
        except ImportError:
            import importlib
            importlib.import_module(f"{os.environ.get('ROS_DISTRO', 'jazzy')}.rclpy")
            import rclpy
        from geometry_msgs.msg import Twist
        from nav_msgs.msg import Odometry
        from rosgraph_msgs.msg import Clock
        from sensor_msgs.msg import Image, Imu, JointState, LaserScan
        rclpy.init()
        node = rclpy.create_node('plastikcad_smoke')
        got = {'joint_states': [], 'clock': [], 'odom': [], 'scan': {}, 'imu': {}, 'image': {}}
        node.create_subscription(JointState, 'joint_states', lambda m: got['joint_states'].append(m), 10)
        node.create_subscription(Clock, 'clock', lambda m: got['clock'].append(m), 10)
        node.create_subscription(Odometry, 'odom', lambda m: got['odom'].append(m), 10)
        for lidar in info['lidars']:
            got['scan'][lidar] = []
            node.create_subscription(LaserScan, f'{lidar}/scan', (lambda l: lambda m: got['scan'][l].append(m))(lidar), 10)
        for imu in info['imus']:
            got['imu'][imu] = []
            node.create_subscription(Imu, f'{imu}/imu', (lambda l: lambda m: got['imu'][l].append(m))(imu), 10)
        for cam in info['cameras']:
            got['image'][cam] = []
            topic = f'{cam}/image' if f'{cam}/image' in info['topics'] else f'{cam}/depth'
            node.create_subscription(Image, topic, (lambda l: lambda m: got['image'][l].append(m))(cam), 10)
        twist_pub = node.create_publisher(Twist, 'cmd_vel', 10)
        joint_pub = node.create_publisher(JointState, 'joint_command', 10)
        ackermann_pub = None
        if drive_kind == 'ackermann':
            from ackermann_msgs.msg import AckermannDriveStamped
            ackermann_pub = node.create_publisher(AckermannDriveStamped, 'ackermann_cmd', 10)

        camera = Camera(prim_path='/World/SmokeCamera', resolution=(960, 600))
        world.reset()
        camera.initialize()
        camera.set_clipping_range(0.01, 100.0)
        art = Articulation(prim_paths_expr=root)
        art.initialize()
        names = list(art.dof_names or [])
        result['dofs'] = names
        start = np.asarray(art.get_world_poses()[0][0]).copy()
        q0 = np.asarray(art.get_joint_positions())[0].copy()
        servo = None
        if drive_kind == 'joints' and names:
            # Ask the first joint for a quarter turn (or a centimeter) and see it get there.
            servo = names[0]
        dt = world.get_physics_dt()

        def run(seconds, command):
            for i in range(int(seconds / dt)):
                command(i)
                world.step(render=(i % 4 == 0))
                rclpy.spin_once(node, timeout_sec=0.0)

        def drive(speed, position):
            if drive_kind == 'twist':
                m = Twist()
                m.linear.x = speed
                twist_pub.publish(m)
            elif drive_kind == 'ackermann' and ackermann_pub is not None:
                m = AckermannDriveStamped()
                m.drive.speed = speed
                m.drive.steering_angle = 0.0
                ackermann_pub.publish(m)
            elif drive_kind == 'joints' and servo:
                m = JointState()
                m.name = [servo]
                m.position = [position]
                joint_pub.publish(m)

        # Standing still first: the sensors read the scene as built, the wall a meter ahead.
        run(1.0, lambda i: drive(0.0, 0.0))
        settled = np.asarray(art.get_world_poses()[0][0]).copy()
        first_scans = {k: list(v) for k, v in got['scan'].items()}
        # Then driven, then left to stop, so the last odometry and the pose are of the same moment.
        run(SECONDS, lambda i: drive(SPEED, 0.5))
        run(0.5, lambda i: drive(0.0, 0.5))
        end = np.asarray(art.get_world_poses()[0][0])
        q = np.asarray(art.get_joint_positions())[0]
        moved = float(np.linalg.norm(end[:2] - start[:2]))
        dropped = float(start[2] - end[2])
        result['moved_mm'] = round(moved * 1000)
        result['dropped_mm'] = round(dropped * 1000)
        result['messages'] = {'joint_states': len(got['joint_states']), 'clock': len(got['clock']), 'odom': len(got['odom']),
                              'scan': {k: len(v) for k, v in got['scan'].items()}, 'imu': {k: len(v) for k, v in got['imu'].items()}, 'image': {k: len(v) for k, v in got['image'].items()}}

        if dropped < 0 and start[2] - settled[2] > 0:
            dropped = float(start[2] - settled[2])
        if info['fixed_base']:
            if moved > 0.001:
                result['problems'].append(f'fixed base moved {moved * 1000:.0f} mm')
        else:
            if drive_kind in ('twist', 'ackermann') and moved < MUST_MOVE:
                result['problems'].append(f'moved only {moved * 1000:.0f} mm in {SECONDS:.0f} s at {SPEED} m/s')
            if dropped > MAY_SETTLE:
                result['problems'].append(f'the base dropped {dropped * 1000:.0f} mm: the robot collapsed')
        if servo:
            i = names.index(servo)
            result['servo_deg'] = round(float(math.degrees(q[i] - q0[i])), 1)
            if abs(q[i] - q0[i] - 0.5) > 0.1:
                result['problems'].append(f'{servo} told to go to 0.5 rad is at {q[i] - q0[i]:.2f}')
        if not got['joint_states']:
            result['problems'].append('no joint_states arrived')
        elif set(got['joint_states'][-1].name) != set(names):
            result['problems'].append(f"joint_states names {list(got['joint_states'][-1].name)} are not the articulation's {names}")
        if not got['clock']:
            result['problems'].append('no clock arrived')
        if not info['fixed_base']:
            if not got['odom']:
                result['problems'].append('no odom arrived')
            else:
                o = got['odom'][-1].pose.pose.position
                off = float(np.linalg.norm(np.array([o.x, o.y]) - (end[:2] - start[:2])))
                result['odom_error_mm'] = round(off * 1000)
                if off > 0.03:
                    result['problems'].append(f'odom is {off * 1000:.0f} mm off the pose')
        for lidar, rays in info['lidars'].items():
            scans = first_scans[lidar]
            if not scans:
                result['problems'].append(f'no scan from {lidar}')
                continue
            s = scans[-1]
            finite = [r for r in s.ranges if math.isfinite(r) and r > 0]
            result[f'{lidar}_rays'] = len(s.ranges)
            result[f'{lidar}_nearest_mm'] = round(min(finite) * 1000) if finite else None
            if rays and len(s.ranges) != rays:
                result['problems'].append(f'{lidar} scan has {len(s.ranges)} rays for {rays} in the design')
            if not finite or abs(min(finite) - (WALL_AT - 0.025 - abs(settled[1]))) > 0.15:
                result['problems'].append(f'{lidar} does not see the wall at about a meter: nearest {min(finite) if finite else None}')
        for imu, msgs in got['imu'].items():
            if not msgs:
                result['problems'].append(f'no imu from {imu}')
                continue
            a = msgs[-1].linear_acceleration
            result[f'{imu}_g'] = [round(a.x, 2), round(a.y, 2), round(a.z, 2)]
            if abs(a.z - 9.81) > 1.0 or abs(a.x) > 1.0 or abs(a.y) > 1.0:
                result['problems'].append(f'{imu} reads ({a.x:.2f}, {a.y:.2f}, {a.z:.2f}), not gravity up')
        for cam, msgs in got['image'].items():
            if not msgs:
                result['problems'].append(f'no pictures from {cam}')
            else:
                result[f'{cam}_px'] = f'{msgs[-1].width}x{msgs[-1].height}'
        # Touch sensors: Isaac's contact sensor interface must read a force on each pad that stands on the floor.
        if info['touches']:
            touched = {}
            try:
                from isaacsim.sensors.experimental.physics import ContactSensor
                sensors = [(prim.GetName(), ContactSensor(str(prim.GetPath()))) for prim in stage.Traverse() if prim.GetTypeName() == 'IsaacContactSensor']
                # A few more steps, so each sensor has a reading of the robot as it stands.
                run(0.2, lambda i: None)
                for pad, sensor in sensors:
                    reading = sensor.get_sensor_reading()
                    touched[pad] = round(float(reading.value), 3) if reading.is_valid else None
            except Exception as e:  # noqa: BLE001
                result['problems'].append(f'contact sensors could not be read: {type(e).__name__}: {e}')
            result['touch_N'] = touched
            quiet = [k for k, v in touched.items() if not v]
            if len(quiet) == len(touched) and touched:
                result['problems'].append('no contact sensor feels any force')

        # A picture, aimed at the robot where it ended up.
        cache = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ['default'], useExtentsHint=False)
        box = cache.ComputeWorldBound(robot).ComputeAlignedRange()
        center = np.array([(a + b) / 2 for a, b in zip(box.GetMin(), box.GetMax())])
        size = max(b - a for a, b in zip(box.GetMin(), box.GetMax()))
        eye = center + np.array([2.6, -2.6, 1.6]) * max(size, 0.1)
        set_camera_view(eye=eye, target=center, camera_prim_path='/World/SmokeCamera')
        for _ in range(40):
            world.step(render=True)
        rgba = camera.get_rgba()
        if rgba is not None and getattr(rgba, 'size', 0):
            from PIL import Image as PilImage
            os.makedirs(pictures, exist_ok=True)
            picture = os.path.join(pictures, f'isaac_stage_{name}.png')
            PilImage.fromarray(np.asarray(rgba)[:, :, :3].astype(np.uint8)).save(picture)
            result['picture'] = picture
            colors = len(np.unique(np.asarray(rgba)[:, :, :3].reshape(-1, 3), axis=0))
            if colors < 50:
                result['problems'].append(f'the picture shows {colors} colors: nothing rendered')
        node.destroy_node()
        rclpy.shutdown()
        try:
            vram = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout.strip()
            result['vram_mib'] = int(vram)
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        import traceback
        result['problems'].append(f'{type(e).__name__}: {e}')
        result['trace'] = traceback.format_exc().splitlines()[-6:]
    finally:
        print('RESULT ' + json.dumps(result), flush=True)
        app.close()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    only = sys.argv[2:]
    try:
        import isaacsim  # noqa: F401
    except ImportError:
        print('isaacsim is not installed in this Python; run through tools/isaac_stage_smoke.sh with ISAACSIM_PYTHON set', file=sys.stderr)
        return 2
    if os.environ.get('PLASTIKCAD_ONE'):
        one(os.environ['PLASTIKCAD_ONE'], os.path.join(root, '..', 'pictures'))
        return 0
    stages = [s for s in (stage_of(f) for f in sorted(glob.glob(os.path.join(root, '*')))) if s]
    if only:
        stages = [s for s in stages if os.path.basename(os.path.dirname(s)) in only]
    if not stages:
        print(f'no stages under {root}', file=sys.stderr)
        return 1
    failed = 0
    for s in stages:
        # One Isaac process per stage: it does not come up twice in one.
        env = dict(os.environ, PLASTIKCAD_ONE=s)
        proc = subprocess.run([sys.executable, __file__, root], env=env, capture_output=True, text=True)
        lines = [l for l in proc.stdout.splitlines() if l.startswith('RESULT ')]
        if not lines:
            failed += 1
            tail = '\n'.join((proc.stdout + proc.stderr).splitlines()[-25:])
            print(f'FAIL {os.path.basename(os.path.dirname(s))}: no result\n{tail}')
            continue
        r = json.loads(lines[-1][7:])
        ok = not r['problems']
        failed += 0 if ok else 1
        summary = {k: v for k, v in r.items() if k not in ('name', 'problems', 'notes', 'trace', 'dofs')}
        print(f"{'ok  ' if ok else 'FAIL'} {r['name']}: {json.dumps(summary)}")
        for p in r['problems']:
            print(f'     - {p}')
        for t in r.get('trace', []):
            print(f'       {t}')
    print(f'{len(stages) - failed} of {len(stages)} stages pass')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
