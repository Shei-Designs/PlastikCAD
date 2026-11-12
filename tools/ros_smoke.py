#!/usr/bin/env python3
"""Runs PlastikCAD's exported ROS and SDF packages through ROS 2 + Gazebo.

Meant to run inside the tools/ros Docker image (tools/ros_smoke.sh does that):

    python3 ros_smoke.py <dir of ROS packages> [<dir of SDF model packages>]

For every ROS package: colcon builds it, display.launch.py runs on a virtual
display (every link must get a TF frame, RViz must stay up without errors
and its screenshot, saved beside the camera pictures, must show the robot),
Gazebo converts the URDF (gz sdf -p)
and checks the world, then gazebo.launch.py runs headless; the robot must
publish its joints, every bridged sensor must publish, a drive must move the
robot in Gazebo when told to on /cmd_vel, and ros2_control's controllers must
come up and track a trajectory. Every SDF package is checked and its world
run, the model must appear and a drive must move it. Exits non-zero on any
failure, and reports the [Err] lines Gazebo printed on the way.
"""
import glob
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

import yaml

WS = '/tmp/ros_smoke_ws'
failures = []


def fail(pkg, what):
    failures.append(f'{pkg}: {what}')
    print(f'  FAIL {what}', flush=True)


def ok(what):
    print(f'  ok   {what}', flush=True)


def run(cmd, timeout=60, env=None, check=False):
    r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, env=env)
    if check and r.returncode:
        raise RuntimeError(f'{cmd}\n{r.stdout}\n{r.stderr}')
    return r


def topic_once(topic, timeout=15):
    """One message of a ROS topic as a dict, or None."""
    try:
        r = run(['ros2', 'topic', 'echo', '--once', topic], timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode or not r.stdout.strip():
        return None
    # The echo may print QoS warnings ahead of the message, and ends with a "---" separator.
    lines = r.stdout.splitlines()
    start = next((i for i, l in enumerate(lines) if re.match(r'^[A-Za-z_]\w*:', l)), 0)
    try:
        return next((d for d in yaml.safe_load_all('\n'.join(lines[start:])) if isinstance(d, dict)), None)
    except yaml.YAMLError:
        return None

IMAGE_STATS = r"""
import json, math, struct, sys
import rclpy
from PIL import Image as Picture
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import CameraInfo, Image, PointCloud2
from sensor_msgs_py import point_cloud2

topic, kind, save = sys.argv[1], sys.argv[2], sys.argv[4] if len(sys.argv) > 4 else ''
rclpy.init()
node = Node('plastikcad_smoke_grab')
got = {}

def on_image(m):
    n = m.width * m.height
    out = {'width': m.width, 'height': m.height, 'encoding': m.encoding, 'frame': m.header.frame_id, 'bytes': len(m.data)}
    if m.encoding == '32FC1' and len(m.data) == n * 4:
        v = struct.unpack('<%df' % n, bytes(m.data))
        finite = [x for x in v if math.isfinite(x)]
        # Gazebo writes -inf for nearer than the near clip and +inf for farther than the far one.
        out.update(finite=len(finite), near=min(finite) if finite else None, far=max(finite) if finite else None, too_near=sum(1 for x in v if x == -math.inf))
        # The middle column, row by row from the top: where the floor starts and how it runs away upwards.
        column = [v[r * m.width + m.width // 2] for r in range(m.height)]
        rows = [r for r, x in enumerate(column) if math.isfinite(x)]
        out['floor_rows'] = [rows[0], rows[-1]] if rows else None
        out['floor_top'] = column[rows[0]] if rows else None
        out['floor_bottom'] = column[rows[-1]] if rows else None
        if save:
            far = out['far'] or 1
            Picture.frombytes('L', (m.width, m.height), bytes(255 - min(255, int(255 * x / far)) if math.isfinite(x) else 0 for x in v)).save(save)
    elif len(m.data) == n * 3:
        px = bytes(m.data)
        out['distinct'] = len(set(px[i:i + 3] for i in range(0, len(px), 3)))
        # Mean of the top and bottom rows: sky above, floor below; the horizon is where the rows change most.
        stride = m.width * 3
        means = [sum(px[r * stride:(r + 1) * stride]) / stride for r in range(m.height)]
        out['top'] = means[0]
        out['bottom'] = means[-1]
        out['horizon'] = max(range(1, m.height), key=lambda r: abs(means[r] - means[r - 1]))
        if save:
            Picture.frombytes('RGB', (m.width, m.height), px).save(save)
    got['msg'] = out

def on_info(m):
    got['msg'] = {'width': m.width, 'height': m.height, 'fx': m.k[0], 'cx': m.k[2], 'frame': m.header.frame_id, 'distortion': m.distortion_model}

def on_cloud(m):
    pts = list(point_cloud2.read_points(m, field_names=('x', 'y', 'z'), skip_nans=True))
    finite = [p for p in pts if all(math.isfinite(float(c)) for c in p)]
    got['msg'] = {'width': m.width, 'height': m.height, 'fields': [f.name for f in m.fields], 'points': len(finite), 'frame': m.header.frame_id,
                  'nearest': min((math.sqrt(sum(float(c) ** 2 for c in p)) for p in finite), default=None)}

cls, cb = {'image': (Image, on_image), 'info': (CameraInfo, on_info), 'cloud': (PointCloud2, on_cloud)}[kind]
node.create_subscription(cls, topic, cb, qos_profile_sensor_data)
end = node.get_clock().now().nanoseconds + int(float(sys.argv[3]) * 1e9)
while rclpy.ok() and 'msg' not in got and node.get_clock().now().nanoseconds < end:
    rclpy.spin_once(node, timeout_sec=0.2)
node.destroy_node()
rclpy.shutdown()
print(json.dumps(got.get('msg')))
"""


def grab(topic, kind, env, timeout=15, save=''):
    """One message of an image, camera-info or point-cloud topic, summarised by a small rclpy node: a dict, or None.
    An image is also saved as a PNG at `save` when given."""
    try:
        r = run(['python3', '-c', IMAGE_STATS, topic, kind, str(timeout), save], timeout=timeout + 15, env=env)
    except subprocess.TimeoutExpired:
        return None
    try:
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else None
    except (json.JSONDecodeError, IndexError):
        return None


def wait_for(predicate, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        v = predicate()
        if v:
            return v
        time.sleep(step)
    return None


def gz_pose(model, world, timeout=10):
    """The model's pose in Gazebo: (x, y, z, roll, pitch, yaw), or None."""
    try:
        r = run(['gz', 'model', '-m', model, '-p'], timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    nums = re.findall(r'\[([-\d.e+ ]+)\]', r.stdout)
    rows = [[float(v) for v in n.split()] for n in nums if len(n.split()) == 3]
    if len(rows) >= 2:
        return tuple(rows[0] + rows[1])
    return None


class Launched:
    """A launch file or gz server running in its own process group, with its output in a log."""

    def __init__(self, cmd, log, env=None):
        self.log = open(log, 'w')
        self.proc = subprocess.Popen(cmd, stdout=self.log, stderr=subprocess.STDOUT, env=env, preexec_fn=os.setsid)
        self.path = log

    def stop(self):
        try:
            os.killpg(self.proc.pid, signal.SIGINT)
            self.proc.wait(15)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.log.close()
        # Gazebo leaves its server behind when the launch is interrupted.
        subprocess.run(['pkill', '-9', '-f', 'gz sim'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'ruby'], capture_output=True)
        time.sleep(1)

    def errors(self):
        with open(self.path, errors='replace') as f:
            text = f.read()
        lines = [l for l in text.splitlines() if '[Err]' in l or 'ERROR' in l or 'error' in l.lower() and 'no error' not in l.lower()]
        # Noise that does not come from the robot.
        noise = ('XDG_RUNTIME_DIR', 'libEGL warning', 'Unable to find or download file', 'already exists')
        return [l for l in lines if not any(n in l for n in noise)]


def camera_turn(urdf_path, sensor):
    """How a camera's fixed joint turns it in the level body: (pitch down, roll) in radians, or None."""
    tree = ET.parse(urdf_path)
    for j in tree.getroot().findall('joint'):
        if j.get('name') == f'{sensor}_joint':
            rpy = [float(v) for v in (j.find('origin').get('rpy') or '0 0 0').split()]
            return rpy[1], rpy[0]
    return None


def upside_down(urdf, sensor):
    turn = camera_turn(urdf, sensor)
    return bool(turn) and abs(abs(turn[1]) - math.pi) < 0.01


def horizon_check(name, topic, urdf, sensor, w, h, horizon):
    """The horizon must sit where the camera's tilt, roll and field of view put it (a camera rolled 180° sees the floor above the sky)."""
    hfov, turn = camera_hfov(urdf, sensor), camera_turn(urdf, sensor)
    if hfov is None or turn is None or horizon is None:
        return ''
    pitch, roll = turn
    if abs(roll) > 0.01 and not upside_down(urdf, sensor):
        return f', horizon at row {horizon} (not checked: camera rolled {math.degrees(roll):.0f}°)'
    fx = w / 2 / math.tan(hfov / 2)
    expected = h / 2 + (fx * math.tan(pitch) if upside_down(urdf, sensor) else -fx * math.tan(pitch))
    how = f'a {math.degrees(pitch):.0f}° tilt' + (', upside down' if upside_down(urdf, sensor) else '')
    detail = f', horizon at row {horizon} (expected {expected:.0f} for {how})'
    if abs(horizon - expected) > max(4, 0.02 * h):
        fail(name, f'{topic} puts the horizon at row {horizon}, not {expected:.0f}: the camera is not turned as designed ({how})')
    return detail


def camera_hfov(urdf_path, sensor):
    """The horizontal field of view a camera sensor in the URDF's Gazebo blocks was given, in radians, or None."""
    with open(urdf_path) as f:
        text = f.read()
    m = re.search(r'<sensor name="%s" type="(?:depth_)?camera">.*?<horizontal_fov>([-\d.e+]+)</horizontal_fov>' % re.escape(sensor), text, re.S)
    return float(m.group(1)) if m else None


def moving_joints(urdf_path):
    tree = ET.parse(urdf_path)
    return [j.get('name') for j in tree.getroot().findall('joint') if j.get('type') != 'fixed']


def initial_values(urdf_path):
    """Where each joint under ros2_control begins, for those the URDF gives an initial position."""
    out = {}
    for joint in ET.parse(urdf_path).getroot().findall('ros2_control/joint'):
        for state in joint.findall('state_interface'):
            value = state.find("param[@name='initial_value']")
            if state.get('name') == 'position' and value is not None:
                out[joint.get('name')] = float(value.text)
    return out


def bridged(pkg_dir):
    with open(os.path.join(pkg_dir, 'config', 'bridge.yaml')) as f:
        return yaml.safe_load(f) or []


def drive_and_measure(model, world, publish, seconds=3.0):
    """Drives forward for a while through `publish(x)` and returns the distance the model moved in Gazebo."""
    before = wait_for(lambda: gz_pose(model, world), 20)
    if not before:
        return None, None, None
    publish(0.2, seconds)
    after = gz_pose(model, world)
    if not after:
        return None, None, None
    dx, dy, dz = after[0] - before[0], after[1] - before[1], after[2] - before[2]
    return math.hypot(dx, dy), after, before


def check_rviz(name, urdf, env):
    """display.launch.py on a virtual display: every link gets a frame, RViz stays up with no error, and a screenshot shows the robot in color."""
    links = [l.get('name') for l in ET.parse(urdf).getroot().findall('link')]
    base = ET.parse(urdf).getroot()
    xvfb = subprocess.Popen(['Xvfb', ':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    denv = dict(env, DISPLAY=':99', LIBGL_ALWAYS_SOFTWARE='1', QT_X11_NO_MITSHM='1', XDG_RUNTIME_DIR='/tmp/runtime-smoke')
    os.makedirs('/tmp/runtime-smoke', exist_ok=True)
    time.sleep(1)
    launched = Launched(['ros2', 'launch', name, 'display.launch.py'], f'/tmp/{name}.display.log', env=denv)
    try:
        if not wait_for(lambda: topic_once('/joint_states', 5), 40):
            fail(name, 'display.launch.py published no /joint_states within 40 s (joint_state_publisher_gui)')
            return
        # Frames: fixed joints go out once on /tf_static, moving ones with every joint state.
        def frames():
            seen = set()
            try:
                r = run(['ros2', 'topic', 'echo', '--once', '--qos-durability', 'transient_local', '--qos-reliability', 'reliable', '/tf_static'], timeout=10, env=denv)
                seen.update(re.findall(r'child_frame_id: (\S+)', r.stdout))
            except subprocess.TimeoutExpired:
                pass
            tf = topic_once('/tf', 10)
            if tf:
                seen.update(t.get('child_frame_id') for t in tf.get('transforms', []))
            return seen
        got = wait_for(lambda: (lambda f: f if len(f) >= len(links) - 1 else None)(frames()), 30) or frames()
        missing = [l for l in links if l not in got and base.find(f"joint/child[@link='{l}']") is not None]
        if missing:
            fail(name, f"TF lacks frames for: {', '.join(missing)}")
        else:
            ok(f'robot_state_publisher gives every link a frame ({len(got)} transforms)')
        # RViz has had time to load the meshes; the picture must show the robot, not just the grid.
        time.sleep(20)
        if run(['pgrep', '-f', 'rviz2'], env=denv).returncode:
            fail(name, 'rviz2 is no longer running')
            return
        picture = os.path.join(os.environ.get('SMOKE_PICTURES', '/tmp'), f'rviz_{name}.png')
        r = run(f'xwd -root -silent -display :99 | convert xwd:- png:{picture}', timeout=30, env=denv)
        if r.returncode or not os.path.exists(picture):
            fail(name, f'no screenshot of RViz: {r.stderr.strip()[:200]}')
            return
        # The robot's own colors from the URDF, so the frame axes and the grid do not pass for it.
        colors = sorted({m.get('rgba') for m in base.iter('color') if m.get('rgba')})
        r = run(['python3', '-c', PICTURE_STATS, picture, json.dumps(colors)], timeout=60)
        stats = json.loads(r.stdout.strip() or '{}') if r.returncode == 0 else {}
        if stats.get('robot', 0) < 300:
            fail(name, f"RViz's picture shows {stats.get('robot', 0)} pixels in the robot's colors: it did not render ({picture})")
        else:
            ok(f"RViz shows the robot: {stats['robot']} pixels in its colors of {stats['total']} ({picture})")
    finally:
        errs = [l for l in launched.errors() if 'joint_state_publisher_gui' not in l or 'error' in l.lower()]
        launched.stop()
        subprocess.run(['pkill', '-9', '-f', 'rviz2'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'joint_state_publisher'], capture_output=True)
        subprocess.run(['pkill', '-9', '-f', 'robot_state_publisher'], capture_output=True)
        xvfb.terminate()
        time.sleep(1)
        if errs:
            print(f'  RViz/ROS reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the display launch log')


PICTURE_STATS = r"""
import colorsys, json, sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
# The robot's colors as hues; a pixel of one of them, shaded or not, is the robot. Grey materials cannot be told from the grid and are skipped.
hues = []
for rgba in json.loads(sys.argv[2]):
    r, g, b = [float(v) for v in rgba.split()[:3]]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s > 0.25:
        hues.append(h)
robot = 0
for r, g, b in im.getdata():
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if s > 0.2 and v > 0.15 and any(min(abs(h - x), 1 - abs(h - x)) < 0.04 for x in hues):
        robot += 1
print(json.dumps({'total': im.width * im.height, 'robot': robot, 'hues': len(hues)}))
"""


def check_ros_package(pkg_dir, env):
    name = os.path.basename(pkg_dir)
    print(f'\n== {name} (ROS package)', flush=True)
    share = os.path.join(WS, 'install', name, 'share', name)
    urdf = os.path.join(share, 'urdf', f'{name}.urdf')
    world = os.path.join(share, 'worlds', f'{name}.sdf')
    if not os.path.exists(urdf):
        return fail(name, f'{urdf} was not installed')
    check_rviz(name, urdf, env)

    # Gazebo's own reading of the URDF and the world.
    with open(urdf) as f:
        text = f.read().replace('__PACKAGE_SHARE__', share)
    tmp = tempfile.NamedTemporaryFile('w', suffix='.urdf', delete=False)
    tmp.write(text)
    tmp.close()
    r = run(['gz', 'sdf', '-p', tmp.name], env=env)
    if r.returncode or '<model' not in r.stdout:
        fail(name, f'gz sdf -p rejected the URDF: {r.stderr.strip() or r.stdout[-400:]}')
    else:
        ok('gz sdf -p converts the URDF to SDF')
    if r.stderr.strip():
        print('       ' + r.stderr.strip().replace('\n', '\n       '))
    r = run(['gz', 'sdf', '-k', world], env=env)
    if r.returncode:
        fail(name, f'gz sdf -k rejected the world: {r.stderr.strip()}')
    else:
        ok('gz sdf -k accepts the world')

    joints = moving_joints(urdf)
    topics = bridged(os.path.join(pkg_dir))
    controllers = os.path.join(share, 'config', 'controllers.yaml')

    launched = Launched(['ros2', 'launch', name, 'gazebo.launch.py', 'headless:=true'], f'/tmp/{name}.launch.log', env=env)
    try:
        world_name = ET.parse(world).getroot().find('world').get('name')
        # The robot is in when its joints are published.
        js = wait_for(lambda: topic_once('/joint_states', 5), 60)
        if not js:
            fail(name, 'no /joint_states within 60 s of launch')
        else:
            missing = sorted(set(joints) - set(js.get('name', [])))
            if missing:
                fail(name, f'/joint_states lacks {missing}')
            else:
                ok(f'/joint_states carries all {len(joints)} moving joints')
        pose = wait_for(lambda: gz_pose(name, world_name), 20)
        if not pose:
            fail(name, 'gz model finds no pose for the robot')
        else:
            ok(f'robot in Gazebo at z = {pose[2]:.3f} m')
        # A joint with a start begins there and its controller holds it: read once the controllers have had time to come up.
        starts = initial_values(urdf)
        if starts:
            time.sleep(8)
            js = topic_once('/joint_states', 8) or {}
            at = dict(zip(js.get('name', []), js.get('position', [])))
            off = sorted(f'{j} at {at.get(j, float("nan")):.3f}, start {v:.3f}' for j, v in starts.items() if not abs(at.get(j, float('nan')) - v) < 0.15)
            if off:
                fail(name, f'joints not at their starts: {off}')
            else:
                settled = gz_pose(name, world_name)
                ok(f'{len(starts)} joints hold their starts' + (f', robot at z = {settled[2]:.3f} m' if settled else ''))

        # Sensors: every topic bridged from Gazebo to ROS must publish.
        for t in topics:
            if t['direction'] != 'GZ_TO_ROS' or t['ros_topic_name'] in ('/clock', '/joint_states', '/tf', '/odom'):
                continue
            heavy = {'sensor_msgs/msg/Image': 'image', 'sensor_msgs/msg/CameraInfo': 'info', 'sensor_msgs/msg/PointCloud2': 'cloud'}.get(t['ros_type_name'])
            # Pictures and clouds are too big to echo as YAML: a node sums them up instead.
            picture = os.path.join(os.environ['SMOKE_PICTURES'], f'{name}{t["ros_topic_name"].replace("/", "_")}.png') if heavy == 'image' and os.environ.get('SMOKE_PICTURES') else ''
            msg = wait_for(lambda: grab(t['ros_topic_name'], heavy, env, 10, picture), 40) if heavy else wait_for(lambda: topic_once(t['ros_topic_name'], 8), 30)
            if not msg:
                fail(name, f'{t["ros_topic_name"]} ({t["ros_type_name"]}) published nothing')
                continue
            detail = ''
            if t['ros_type_name'] == 'sensor_msgs/msg/LaserScan':
                ranges = msg.get('ranges', [])
                finite = [v for v in ranges if isinstance(v, (int, float)) and math.isfinite(v)]
                # In an empty world the only thing to see is the floor, far off: a low lidar catches it near its range's end.
                low = [v for v in finite if v < 0.8 * msg.get('range_max', 0)]
                detail = f', {len(ranges)} rays, {len(finite)} returns (floor at {min(finite):.1f}-{max(finite):.1f} m)' if finite else f', {len(ranges)} rays, nothing in range'
                if not ranges:
                    fail(name, f'{t["ros_topic_name"]} has no ranges')
                elif low:
                    fail(name, f'{t["ros_topic_name"]} sees something at {min(low):.2f} m in an empty world')
            elif t['ros_type_name'] == 'sensor_msgs/msg/Image':
                w, h = msg.get('width') or 0, msg.get('height') or 0
                sensor_name = t['ros_topic_name'].split('/')[1]
                detail = f', {w}x{h} {msg.get("encoding")}, frame {msg.get("frame")}'
                if not w or not h:
                    fail(name, f'{t["ros_topic_name"]} is an empty image')
                elif msg.get('encoding') == '32FC1':
                    # A depth picture of the floor ahead: sky (infinite) above the horizon, the floor below it
                    # running away upwards, so the lowest floor row is the nearest and the highest the farthest.
                    rows = msg.get('floor_rows')
                    detail += f', {msg["finite"]} of {w * h} pixels in range, {msg["near"]:.2f}-{msg["far"]:.2f} m, floor in rows {rows[0]}-{rows[1]} of {h} at {msg["floor_top"]:.2f}-{msg["floor_bottom"]:.2f} m' if rows else ', nothing in range'
                    if msg.get('too_near'):
                        detail += f', {msg["too_near"]} pixels nearer than the near clip'
                    if not rows:
                        fail(name, f'{t["ros_topic_name"]} sees nothing: not even the floor')
                    elif upside_down(urdf, sensor_name):
                        # Mounted upside down: the floor fills the top of the picture, nearest at the very top.
                        if rows[0] > h // 4 or rows[1] > h * 3 // 4 or not msg['floor_top'] < msg['floor_bottom']:
                            fail(name, f'{t["ros_topic_name"]} does not look out over the floor upside down{detail}')
                    elif rows[0] < h // 4 or rows[1] < h * 3 // 4 or not msg['floor_bottom'] < msg['floor_top']:
                        fail(name, f'{t["ros_topic_name"]} does not look out over the floor{detail}')
                    if rows:
                        detail += horizon_check(name, t['ros_topic_name'], urdf, sensor_name, w, h, rows[1] + 1 if upside_down(urdf, sensor_name) else rows[0])
                elif msg.get('distinct') is not None:
                    detail += f', {msg["distinct"]} colours, top row {msg["top"]:.0f} bottom row {msg["bottom"]:.0f}'
                    if msg['distinct'] < 2 or msg['bytes'] != w * h * 3:
                        fail(name, f'{t["ros_topic_name"]} renders a blank picture{detail}')
                    else:
                        detail += horizon_check(name, t['ros_topic_name'], urdf, sensor_name, w, h, msg.get('horizon'))
                    if picture:
                        detail += f', saved as {os.path.basename(picture)}'
                else:
                    fail(name, f'{t["ros_topic_name"]} has {msg.get("bytes")} bytes of {msg.get("encoding")} for {w}x{h}')
            elif t['ros_type_name'] == 'sensor_msgs/msg/CameraInfo':
                detail = f', {msg.get("width")}x{msg.get("height")} fx {msg.get("fx", 0):.1f} cx {msg.get("cx", 0):.1f}, frame {msg.get("frame")}'
                # The focal length follows from the field of view the design gave the camera.
                hfov = camera_hfov(urdf, t['ros_topic_name'].split('/')[1])
                if hfov and msg.get('width'):
                    expected = msg['width'] / 2 / math.tan(hfov / 2)
                    if abs(msg.get('fx', 0) - expected) > 0.02 * expected:
                        fail(name, f'{t["ros_topic_name"]} focal length {msg.get("fx", 0):.1f} px does not match a {math.degrees(hfov):.0f}° field of view ({expected:.1f} px)')
            elif t['ros_type_name'] == 'sensor_msgs/msg/PointCloud2':
                detail = f', {msg.get("points")} points ({", ".join(msg.get("fields") or [])}), frame {msg.get("frame")}'
                if msg.get('nearest') is not None:
                    detail += f', nearest {msg["nearest"]:.2f} m'
                # A lidar's cloud is empty when its scan has nothing in range, as in an empty world; a depth camera always sees the floor.
                if not msg.get('points') and not t['ros_topic_name'].endswith('scan/points'):
                    fail(name, f'{t["ros_topic_name"]} carries no points')
            elif t['ros_type_name'] == 'sensor_msgs/msg/Imu':
                # Standing still: gravity alone, straight up, and no turning.
                a = msg.get('linear_acceleration', {})
                w = msg.get('angular_velocity', {})
                g = math.sqrt(sum(a.get(k, 0) ** 2 for k in 'xyz'))
                spin = math.sqrt(sum(w.get(k, 0) ** 2 for k in 'xyz'))
                detail = f', accel {g:.2f} m/s2 with z = {a.get("z", 0):.2f}, turning {spin:.3f} rad/s, frame {msg.get("header", {}).get("frame_id")}'
                if abs(g - 9.81) > 0.5 or a.get('z', 0) < 9 or spin > 0.1:
                    fail(name, f'{t["ros_topic_name"]} does not read gravity straight up at rest{detail}')
            elif t['ros_type_name'] == 'ros_gz_interfaces/msg/Contacts':
                detail = f', {len(msg.get("contacts") or [])} contact(s)'
            ok(f'{t["ros_topic_name"]} publishes ({t["ros_type_name"].split("/")[-1]}{detail})')

        # Drive.
        if any(t['ros_topic_name'] == '/cmd_vel' for t in topics):
            def publish(x, seconds):
                run(['ros2', 'topic', 'pub', '-r', '20', '-t', str(int(seconds * 20)), '/cmd_vel', 'geometry_msgs/msg/Twist', f'{{linear: {{x: {x}}}}}'], timeout=seconds + 20, env=env)
                run(['ros2', 'topic', 'pub', '-1', '-w', '1', '/cmd_vel', 'geometry_msgs/msg/Twist', '{}'], timeout=20, env=env)

            odom0 = topic_once('/odom', 10)
            dist, after, before = drive_and_measure(name, world_name, publish)
            odom1 = topic_once('/odom', 10)
            if dist is None:
                fail(name, 'could not read the robot pose around the drive')
            elif dist < 0.15:
                fail(name, f'robot moved only {dist:.3f} m in Gazebo on cmd_vel x = 0.2 for 3 s')
            else:
                heading = math.degrees(math.atan2(after[1] - before[1], after[0] - before[0]))
                ok(f'cmd_vel drove the robot {dist:.3f} m in Gazebo, heading {heading:.0f}° (yaw {math.degrees(after[5]):.0f}°)')
                tipped = abs(after[3]) > 0.3 or abs(after[4]) > 0.3
                if tipped:
                    fail(name, f'robot tipped: roll {math.degrees(after[3]):.0f}°, pitch {math.degrees(after[4]):.0f}°')
            if odom0 and odom1 and not isinstance(odom0.get('pose'), type(None)):
                p0, p1 = odom0['pose']['pose']['position'], odom1['pose']['pose']['position']
                od = math.hypot(p1['x'] - p0['x'], p1['y'] - p0['y'])
                frames = f"{odom1['header']['frame_id']} -> {odom1['child_frame_id']}"
                if od < 0.1:
                    fail(name, f'/odom moved only {od:.3f} m ({frames})')
                else:
                    ok(f'/odom moved {od:.3f} m ({frames})')
            else:
                fail(name, '/odom published nothing')

        # ros2_control.
        if os.path.exists(controllers):
            with open(controllers) as f:
                cfg = yaml.safe_load(f)
            wanted = [k for k in cfg['controller_manager']['ros__parameters'] if isinstance(cfg['controller_manager']['ros__parameters'][k], dict)]

            def active():
                r = run(['ros2', 'control', 'list_controllers'], timeout=15, env=env)
                return r.stdout if all(re.search(rf'{c}\b.*\bactive', r.stdout) for c in wanted) else None

            listing = wait_for(active, 60, 2)
            if not listing:
                fail(name, f'controllers {wanted} did not all become active')
            else:
                ok(f'controllers active: {", ".join(wanted)}')
                ctrl = next((k for k in wanted if k != 'joint_state_broadcaster'), None)
                cjoints = cfg[ctrl]['ros__parameters']['joints']
                target = [0.3] + [0.0] * (len(cjoints) - 1)
                names = ', '.join(cjoints)
                positions = ', '.join(str(v) for v in target)
                run(['ros2', 'topic', 'pub', '-1', '-w', '1', f'/{ctrl}/joint_trajectory', 'trajectory_msgs/msg/JointTrajectory',
                     f'{{joint_names: [{names}], points: [{{positions: [{positions}], time_from_start: {{sec: 1}}}}]}}'], timeout=30, env=env)
                def reached():
                    js = topic_once('/joint_states', 10)
                    if js and cjoints[0] in js.get('name', []):
                        return js['position'][js['name'].index(cjoints[0])]
                    return None

                got = wait_for(lambda: (lambda v: v if v is not None and abs(v - 0.3) < 0.05 else None)(reached()), 20)
                if got is None:
                    last = reached()
                    fail(name, f'{cjoints[0]} reached {last} rad of 0.3 asked through /{ctrl}')
                else:
                    ok(f'/{ctrl} moved {cjoints[0]} to {got:.3f} rad of 0.3')
    finally:
        errs = launched.errors()
        launched.stop()
        if errs:
            print(f'  Gazebo/ROS reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the launch log')
        os.unlink(tmp.name)


def check_sdf_package(pkg_dir, env):
    name = os.path.basename(pkg_dir)
    print(f'\n== {name} (SDF model)', flush=True)
    model = os.path.join(pkg_dir, 'model.sdf')
    worlds = glob.glob(os.path.join(pkg_dir, 'worlds', '*.sdf'))
    r = run(['gz', 'sdf', '-k', model], env=env)
    if r.returncode:
        fail(name, f'gz sdf -k rejected model.sdf: {r.stderr.strip()}')
    else:
        ok('gz sdf -k accepts model.sdf')
    if not worlds:
        return fail(name, 'no world')
    world = worlds[0]
    world_name = ET.parse(world).getroot().find('world').get('name')
    # The model carries the design's name, not the folder's.
    model_name = ET.parse(model).getroot().find('model').get('name')
    env = dict(env, GZ_SIM_RESOURCE_PATH=os.path.dirname(pkg_dir))
    launched = Launched(['gz', 'sim', '-s', '-r', '--headless-rendering', world], f'/tmp/{name}.sdf.log', env=env)
    try:
        pose = wait_for(lambda: gz_pose(model_name, world_name), 60)
        if not pose:
            fail(name, f'model "{model_name}" did not appear in the world')
        else:
            ok(f'model in the world at z = {pose[2]:.3f} m')
            with open(model) as f:
                if 'cmd_vel' in f.read():
                    def publish(x, seconds):
                        end = time.time() + seconds
                        while time.time() < end:
                            run(['gz', 'topic', '-t', '/cmd_vel', '-m', 'gz.msgs.Twist', '-p', f'linear: {{x: {x}}}'], timeout=10, env=env)
                            time.sleep(0.1)
                        run(['gz', 'topic', '-t', '/cmd_vel', '-m', 'gz.msgs.Twist', '-p', 'linear: {x: 0}'], timeout=10, env=env)

                    dist, after, before = drive_and_measure(model_name, world_name, publish)
                    if dist is None:
                        fail(name, 'could not read the model pose around the drive')
                    elif dist < 0.15:
                        fail(name, f'model moved only {dist:.3f} m on cmd_vel x = 0.2 for 3 s')
                    else:
                        heading = math.degrees(math.atan2(after[1] - before[1], after[0] - before[0]))
                        ok(f'cmd_vel drove the model {dist:.3f} m, heading {heading:.0f}°')
    finally:
        errs = launched.errors()
        launched.stop()
        if errs:
            print(f'  Gazebo reported {len(errs)} error line(s):')
            for l in errs[:12]:
                print('       ' + l.strip()[:220])
            fail(name, f'{len(errs)} error line(s) in the gz log')


def main():
    ros_dir = sys.argv[1]
    sdf_dir = sys.argv[2] if len(sys.argv) > 2 else None
    env = dict(os.environ, GZ_SIM_RESOURCE_PATH=os.path.join(WS, 'install'))
    env.setdefault('ROS_DOMAIN_ID', '42')

    packages = sorted(d for d in glob.glob(os.path.join(ros_dir, '*')) if os.path.isfile(os.path.join(d, 'package.xml')))
    if packages:
        shutil.rmtree(WS, ignore_errors=True)
        os.makedirs(os.path.join(WS, 'src'))
        for p in packages:
            shutil.copytree(p, os.path.join(WS, 'src', os.path.basename(p)))
        print(f'colcon build of {len(packages)} package(s)...', flush=True)
        r = run(['bash', '-c', f'cd {WS} && colcon build --symlink-install'], timeout=600)
        if r.returncode:
            print(r.stdout[-2000:], r.stderr[-2000:])
            fail('workspace', 'colcon build failed')
            packages = []
        else:
            print('  ok   colcon build')
        setup = os.path.join(WS, 'install', 'setup.bash')
        r = run(['bash', '-c', f'source {setup} && env'], timeout=30)
        env.update(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l and not l.startswith('BASH_FUNC'))
        env['GZ_SIM_RESOURCE_PATH'] = os.path.join(WS, 'install')
        for p in packages:
            check_ros_package(p, env)

    if sdf_dir:
        for p in sorted(glob.glob(os.path.join(sdf_dir, '*'))):
            if os.path.isfile(os.path.join(p, 'model.sdf')):
                check_sdf_package(p, env)

    print()
    if failures:
        print(f'{len(failures)} failure(s):')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print('All packages pass.')


if __name__ == '__main__':
    main()
