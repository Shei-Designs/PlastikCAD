"""Simulates every exported MuJoCo model under a folder and says whether it behaves.

    ROBOT_FIXTURES_OUT=fixtures/out pnpm exec vitest run src/robot/robots.test.ts
    python3 tools/mujoco_smoke.py fixtures/out

Needs the `mujoco` package (pip install mujoco, or a venv). Each model is
settled for a second, then driven: velocity motors run at their limit and the
base must travel; a mecanum drive must go forward, slide and turn as told;
a rover on tracks must go straight and turn on the spot;
position servos are sent 0.3 rad and must follow; a free
base must not collapse; and MuJoCo must raise no warnings. Exit code 1 on any
failure, 2 when mujoco is missing.
"""
import glob
import json
import os
import sys

try:
    import mujoco
except ImportError:
    print("mujoco is not installed: pip install mujoco (a venv is fine) and run this with that Python.")
    sys.exit(2)
import numpy as np

# A mecanum drive is run at this wheel speed (rad/s) for this long, and must go between these shares of what was
# asked and stray no farther than this another way (m, rad).
MECANUM_WHEEL_SPEED, MECANUM_SECONDS, MECANUM_LEAST, MECANUM_MOST, MECANUM_STRAY = 6.0, 3.0, 0.8, 1.05, 0.05

# A rover on tracks (a differential drive with a row of wheels each side) is run straight at this speed (m/s) and
# turned on the spot with its tracks at the second speed, one each way, for this long. Straight, it must go between
# these shares of what was asked: a motor here runs slower the more it is loaded, as a real one does, and its own
# damping alone costs some 5 %. Turning, a long contact skids: it must turn between these shares of what wheels
# that did not skid would turn it (the reference rover turns 35 %; plain Coulomb friction would give 70 to 80 %).
# It must stray no farther than this another way (m, rad).
TRACK_SPEED, TRACK_TURN_SPEED, TRACK_SECONDS = 0.3, 0.15, 3.0
TRACK_STRAIGHT, TRACK_TURN, TRACK_STRAY = (0.9, 1.02), (0.28, 0.7), 0.05

# A rover on two wheels a side turns by sliding them sideways. It is run straight at this speed (m/s) and told to
# turn on the spot at this rate (rad/s), for this long. Plain friction under four wheels that carry alike turns it
# t²/(t² + L²) of what was asked, t from side to side and L from axle to axle: 62 % for the rover, 20 % for the long
# one. It must turn between these shares of that (the two turn 56 % and 17 %, nine tenths of it), go straight
# between these shares of what was asked, and stray no farther than this another way (m, rad): turning, its
# middle stays where it was.
SKID_SPEED, SKID_TURN_RATE, SKID_SECONDS = 0.3, 1.0, 3.0
SKID_STRAIGHT, SKID_TURN, SKID_STRAY = (0.9, 1.02), (0.75, 1.05), 0.02
# Told to go straight, a rover on tracks or on two wheels a side must be at nine tenths of the speed within this
# long (s). A driven wheel has a rim as heavy as its load asks (see RIM_SHARE in src/robot/export.ts), which its
# motor has to bring to speed with the rover: the reference rovers take 0.03 to 0.05 s, their motors being strong
# for their weight. A rim or a gain that made them slow to start would show here.
START_WITHIN = 0.2

root = sys.argv[1] if len(sys.argv) > 1 else "fixtures/out"
# A link's friction is what holds on the floor: MuJoCo takes the larger of two surfaces' figures unless one has the
# priority, which the robot's shapes are given. A rover on two wheels a side with its wheels' friction set to this
# is pulled across them at this much under and over it, as a share of its weight: it let go between 0.300 and 0.305
# (and at 1.00, the floor's own figure, before its shapes had the priority).
GRIP, GRIP_MARGIN = 0.3, 0.05
# Each MuJoCo model is <name>/<name>.xml; the ROS and SDF packages beside them carry XML of their own.
xmls = sorted(x for x in glob.glob(os.path.join(root, "*", "*.xml")) if os.path.basename(x) == os.path.basename(os.path.dirname(x)) + ".xml")
if not xmls:
    print(f"no models under {root}")
    sys.exit(1)
failures = 0
for xml in xmls:
    name = os.path.relpath(xml, root)
    try:
        m = mujoco.MjModel.from_xml_path(xml)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {name}: {e}")
        failures += 1
        continue
    d = mujoco.MjData(m)
    # A simulation begins at the home pose: every joint at its start, every servo holding it there.
    home = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_KEY, "home")
    if home >= 0:
        mujoco.mj_resetDataKeyframe(m, d, home)
    began = d.qpos.copy()
    held = d.ctrl.copy()
    base = 1
    free = any(m.jnt_type[j] == 0 and m.jnt_bodyid[j] == base for j in range(m.njnt))
    steps = lambda seconds: range(int(seconds / m.opt.timestep))  # noqa: E731
    # A joint commanded by torque has a plain motor, which holds nothing: a spring and a damper about where it
    # began stand in for the controller, as the starter script's do.
    torques = {}
    for a in range(m.nu):
        if m.actuator_biasprm[a, 1] == 0 and m.actuator_biasprm[a, 2] == 0:
            j = m.actuator_trnid[a, 0]
            inertia = max(m.dof_M0[m.jnt_dofadr[j]], 1e-9)
            top = m.actuator_ctrlrange[a, 1]
            kp = min(top / 0.5, 0.25 * inertia / m.opt.timestep**2)
            torques[a] = [m.jnt_qposadr[j], m.jnt_dofadr[j], kp, 2 * np.sqrt(kp * inertia), top, float(began[m.jnt_qposadr[j]])]

    def tick():
        for a, (q, v, kp, kd, top, want) in torques.items():
            d.ctrl[a] = np.clip(kp * (want - d.qpos[q]) - kd * d.qvel[v], -top, top)
        mujoco.mj_step(m, d)

    for _ in steps(1.0):
        tick()
    # The base frame may sit on the floor: the robot's center of mass says how high it stands, measured square to the floor when it is a tilted plane.
    floor = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "floor")
    up = np.array([0.0, 0.0, 1.0])
    if floor >= 0 and m.geom_type[floor] == mujoco.mjtGeom.mjGEOM_PLANE:
        up = d.geom_xmat[floor].reshape(3, 3)[:, 2]
    height = lambda: float(np.dot(d.subtree_com[base], up))  # noqa: E731
    start = d.subtree_com[base].copy()
    start_height = height()
    q0 = d.qpos.copy()
    servos = [a for a in range(m.nu) if m.actuator_biasprm[a, 1] != 0 or a in torques]
    motors = [a for a in range(m.nu) if a not in servos]
    notes = []
    ok = True
    if motors:
        for a in motors:
            d.ctrl[a] = m.actuator_ctrlrange[a, 1] if m.actuator_ctrllimited[a] else 1.0
        for _ in steps(2.0):
            tick()
        moved = float(np.linalg.norm((d.subtree_com[base] - start)[:2]))
        notes.append(f"drove {moved * 1000:.0f} mm in 2 s")
        ok &= moved >= 0.01
    elif servos:
        # A walker on its servos must first stand still at its home pose, then follow a small step; an arm follows a larger one.
        if free:
            for _ in steps(1.0):
                tick()
            standing = height()
            notes.append(f"stood at {standing * 1000:.1f} mm of {start_height * 1000:.1f}")
            ok &= standing >= 0.9 * start_height
        # The joints that began away from zero must still be where they began.
        adr = [m.jnt_qposadr[m.actuator_trnid[a, 0]] for a in servos]
        started = [i for i in adr if abs(float(began[i])) > 1e-6]
        if started:
            drift = max(abs(float(d.qpos[i] - began[i])) for i in started)
            notes.append(f"{len(started)} joints held their starts within {np.degrees(drift):.1f} deg")
            ok &= drift < 0.15
        asked = 0.1 if free else 0.3
        for a in servos:
            if a in torques:
                torques[a][5] += asked
            else:
                d.ctrl[a] = held[a] + asked
        for _ in steps(1.0):
            tick()
        swung = max(abs(float(d.qpos[i] - q0[i])) for i in adr)
        notes.append(f"servos swung up to {np.degrees(swung):.1f} deg of {np.degrees(asked):.1f} asked")
        ok &= swung >= asked / 3
        # A loop is pinned shut by a connect constraint, and takes its passive joints along: the pin must hold, and
        # the hinges with no actuator must have moved with the servos.
        pins = [e for e in range(m.neq) if m.eq_type[e] == mujoco.mjtEq.mjEQ_CONNECT]
        if pins:
            gap = 0.0
            for e in pins:
                b1, b2 = m.eq_obj1id[e], m.eq_obj2id[e]
                a1 = d.xpos[b1] + d.xmat[b1].reshape(3, 3) @ m.eq_data[e, 0:3]
                a2 = d.xpos[b2] + d.xmat[b2].reshape(3, 3) @ m.eq_data[e, 3:6]
                gap = max(gap, float(np.linalg.norm(a1 - a2)))
            actuated = {m.actuator_trnid[a, 0] for a in range(m.nu)}
            passive = [j for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE and j not in actuated]
            carried = max((abs(float(d.qpos[m.jnt_qposadr[j]] - q0[m.jnt_qposadr[j]])) for j in passive), default=0.0)
            notes.append(f"{len(pins)} loop(s) shut within {gap * 1000:.2f} mm, passive joints carried up to {np.degrees(carried):.1f} deg")
            ok &= gap < 0.002 and (not passive or carried >= asked / 3)
    if free:
        now = height()
        notes.append(f"base at {now * 1000:.1f} mm, was {start_height * 1000:.1f}")
        ok &= now >= 0.7 * start_height
    # A mecanum drive, from a fresh start each time: told to go forward, to slide to its left and to turn on the
    # spot, it goes most of the way asked (its rollers slip a little, and it takes a moment to get going) and
    # hardly any other way. The mixing is the one drive.py and the test drive use.
    spec_path = os.path.join(os.path.dirname(xml), "drive.json")
    spec = json.load(open(spec_path)) if os.path.exists(spec_path) else None
    if spec and spec["kind"] == "mecanum":
        r, k = spec["wheelRadius"], (spec["wheelBase"] + spec["wheelSeparation"]) / 2
        fwd = np.array(spec["forward"][:2], float)
        left = np.array([-fwd[1], fwd[0]])
        mix = {"front-left": (-1, -1), "front-right": (1, 1), "rear-left": (1, -1), "rear-right": (-1, 1)}
        ids = {role: mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, spec["roles"][role][0]) for role in mix}
        yaw_of = lambda q: float(np.arctan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))  # noqa: E731
        speed = MECANUM_WHEEL_SPEED * r
        for label, (vx, vy, wz) in {"forward": (speed, 0, 0), "left": (0, speed, 0), "turn": (0, 0, speed / k / 2)}.items():
            e = mujoco.MjData(m)
            if home >= 0:
                mujoco.mj_resetDataKeyframe(m, e, home)
            for _ in steps(0.5):
                mujoco.mj_step(m, e)
            at, yaw, last = e.qpos[:2].copy(), 0.0, yaw_of(e.qpos[3:7])
            for role, (sy, sw) in mix.items():
                e.ctrl[ids[role]] = (vx + sy * vy + sw * k * wz) / r
            for _ in steps(MECANUM_SECONDS):
                mujoco.mj_step(m, e)
                now = yaw_of(e.qpos[3:7])
                yaw += (now - last + np.pi) % (2 * np.pi) - np.pi
                last = now
            went = [float((e.qpos[:2] - at) @ fwd), float((e.qpos[:2] - at) @ left), yaw]
            i = ("forward", "left", "turn").index(label)
            ideal = (vx, vy, wz)[i] * MECANUM_SECONDS
            stray = [abs(v) for j, v in enumerate(went) if j != i]
            notes.append(f"mecanum {label}: {went[i]:.3f} of {ideal:.3f} {'rad' if i == 2 else 'm'}")
            if not MECANUM_LEAST <= went[i] / ideal <= MECANUM_MOST or max(stray) > MECANUM_STRAY:
                ok = False
                notes.append(f"mecanum {label} FAILED: forward {went[0]:.3f} m, left {went[1]:.3f} m, turn {went[2]:.3f} rad")
            if any(w.number for w in e.warning):
                ok = False
                notes.append(f"mecanum {label}: warnings " + ", ".join(mujoco.mjtWarning(i).name for i, w in enumerate(e.warning) if w.number))
    # A rover on tracks, from a fresh start each time: told to go straight and to turn on the spot.
    if spec and spec["kind"] == "differential" and min(len(spec["roles"][side]) for side in ("left", "right")) >= 3:
        r, sep = spec["wheelRadius"], spec["wheelSeparation"]
        fwd = np.array(spec["forward"][:2], float)
        left = np.array([-fwd[1], fwd[0]])
        sides = {side: [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, a) for a in spec["roles"][side]] for side in ("left", "right")}
        yaw_of = lambda q: float(np.arctan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))  # noqa: E731
        runs = {"straight": (TRACK_SPEED, TRACK_SPEED, TRACK_SPEED * TRACK_SECONDS, TRACK_STRAIGHT), "turn": (-TRACK_TURN_SPEED, TRACK_TURN_SPEED, 2 * TRACK_TURN_SPEED / sep * TRACK_SECONDS, TRACK_TURN)}
        for label, (vl, vr, ideal, (least, most)) in runs.items():
            e = mujoco.MjData(m)
            if home >= 0:
                mujoco.mj_resetDataKeyframe(m, e, home)
            for _ in steps(0.5):
                mujoco.mj_step(m, e)
            at, yaw, last = e.qpos[:2].copy(), 0.0, yaw_of(e.qpos[3:7])
            heights = []
            told, started = e.time, None
            for side, v in (("left", vl), ("right", vr)):
                for a in sides[side]:
                    e.ctrl[a] = v / r
            for _ in steps(TRACK_SECONDS):
                mujoco.mj_step(m, e)
                if started is None and label == "straight" and float(e.qvel[:2] @ fwd) >= 0.9 * vl:
                    started = e.time - told
                now = yaw_of(e.qpos[3:7])
                yaw += (now - last + np.pi) % (2 * np.pi) - np.pi
                last = now
                heights.append(float(e.qpos[2]))
            went = [float((e.qpos[:2] - at) @ fwd), float((e.qpos[:2] - at) @ left), yaw]
            i = 0 if label == "straight" else 2
            stray = [abs(v) for j, v in enumerate(went) if j != i]
            notes.append(f"tracks {label}: {went[i]:.3f} of {ideal:.3f} {'rad' if i == 2 else 'm'} ({100 * went[i] / ideal:.0f} %), height within {(max(heights) - min(heights)) * 1000:.2f} mm")
            if label == "straight":
                notes.append(f"tracks start: at nine tenths of {vl} m/s after {'never' if started is None else f'{started:.3f} s'}")
                if started is None or started > START_WITHIN:
                    ok = False
                    notes.append(f"tracks start FAILED: more than {START_WITHIN} s")
            if not least <= went[i] / ideal <= most or max(stray) > TRACK_STRAY:
                ok = False
                notes.append(f"tracks {label} FAILED: forward {went[0]:.3f} m, left {went[1]:.3f} m, turn {went[2]:.3f} rad")
            if any(w.number for w in e.warning):
                ok = False
                notes.append(f"tracks {label}: warnings " + ", ".join(mujoco.mjtWarning(i).name for i, w in enumerate(e.warning) if w.number))
    # A rover on two wheels a side, from a fresh start each time: told to go straight and to turn on the spot.
    if spec and spec["kind"] == "differential" and all(len(spec["roles"][side]) == 2 for side in ("left", "right")):
        r, sep = spec["wheelRadius"], spec["wheelSeparation"]
        fwd = np.array(spec["forward"][:2], float)
        left = np.array([-fwd[1], fwd[0]])
        sides = {side: [mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_ACTUATOR, a) for a in spec["roles"][side]] for side in ("left", "right")}
        yaw_of = lambda q: float(np.arctan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] ** 2 + q[3] ** 2)))  # noqa: E731
        # From the back axle to the front one, as the model stands.
        along = [float(d.xpos[m.jnt_bodyid[m.actuator_trnid[a, 0]]][:2] @ fwd) for a in sides["left"] + sides["right"]]
        plain = sep**2 / (sep**2 + (max(along) - min(along)) ** 2)
        rim = SKID_TURN_RATE * sep / 2
        runs = {"straight": (SKID_SPEED, SKID_SPEED, SKID_SPEED * SKID_SECONDS, SKID_STRAIGHT), "turn": (-rim, rim, SKID_TURN_RATE * SKID_SECONDS * plain, SKID_TURN)}
        for label, (vl, vr, ideal, (least, most)) in runs.items():
            e = mujoco.MjData(m)
            if home >= 0:
                mujoco.mj_resetDataKeyframe(m, e, home)
            for _ in steps(0.5):
                mujoco.mj_step(m, e)
            at, yaw, last = e.qpos[:2].copy(), 0.0, yaw_of(e.qpos[3:7])
            told, started = e.time, None
            for side, v in (("left", vl), ("right", vr)):
                for a in sides[side]:
                    e.ctrl[a] = v / r
            for _ in steps(SKID_SECONDS):
                mujoco.mj_step(m, e)
                if started is None and label == "straight" and float(e.qvel[:2] @ fwd) >= 0.9 * vl:
                    started = e.time - told
                now = yaw_of(e.qpos[3:7])
                yaw += (now - last + np.pi) % (2 * np.pi) - np.pi
                last = now
            went = [float((e.qpos[:2] - at) @ fwd), float((e.qpos[:2] - at) @ left), yaw]
            i = 0 if label == "straight" else 2
            stray = [abs(v) for j, v in enumerate(went) if j != i]
            of = "" if i == 0 else f" that plain friction gives ({100 * plain:.0f} % of {SKID_TURN_RATE * SKID_SECONDS:.1f} asked)"
            notes.append(f"skid {label}: {went[i]:.3f} of {ideal:.3f} {'rad' if i == 2 else 'm'}{of} ({100 * went[i] / ideal:.0f} %), strayed {1000 * max(stray[:1] if i == 0 else stray[:2]):.1f} mm")
            if label == "straight":
                notes.append(f"skid start: at nine tenths of {vl} m/s after {'never' if started is None else f'{started:.3f} s'}")
                if started is None or started > START_WITHIN:
                    ok = False
                    notes.append(f"skid start FAILED: more than {START_WITHIN} s")
            if not least <= went[i] / ideal <= most or max(stray) > SKID_STRAY:
                ok = False
                notes.append(f"skid {label} FAILED: forward {went[0]:.3f} m, left {went[1]:.3f} m, turn {went[2]:.3f} rad")
            if any(w.number for w in e.warning):
                ok = False
                notes.append(f"skid {label}: warnings " + ", ".join(mujoco.mjtWarning(i).name for i, w in enumerate(e.warning) if w.number))
        # A link's friction is what holds on the floor, whatever the floor's own: with its wheels' set to GRIP the
        # rover, pulled across them (gravity leaned that way, as on a slope), holds under it and slides over it.
        for pull, holds in ((GRIP - GRIP_MARGIN, True), (GRIP + GRIP_MARGIN, False)):
            g = mujoco.MjModel.from_xml_path(xml)
            for geom in range(g.ngeom):
                if g.geom_bodyid[geom] > base and g.geom_contype[geom]:
                    g.geom_friction[geom, 0] = GRIP
            e = mujoco.MjData(g)
            if home >= 0:
                mujoco.mj_resetDataKeyframe(g, e, home)
            for _ in steps(0.5):
                mujoco.mj_step(g, e)
            lean = np.arctan(pull)
            g.opt.gravity[:] = [9.81 * np.sin(lean) * left[0], 9.81 * np.sin(lean) * left[1], -9.81 * np.cos(lean)]
            for _ in steps(1.0):
                mujoco.mj_step(g, e)
            at = e.qpos[:2].copy()
            for _ in steps(1.5):
                mujoco.mj_step(g, e)
            slid = float((e.qpos[:2] - at) @ left)
            notes.append(f"wheels of friction {GRIP} pulled across at {pull:.2f} of the weight: {'hold' if holds else 'slide'} ({1000 * slid:.0f} mm in 1.5 s)")
            if (slid > 0.01) if holds else (slid < 0.1):
                ok = False
                notes.append(f"grip FAILED: a friction of {GRIP} {'let go under' if holds else 'held over'} {pull:.2f} of the weight")
    # Every camera must render a picture of something, and a depth picture of the floor that runs away to the top.
    if m.ncam:
        try:
            renderer = mujoco.Renderer(m, 48, 64)
        except Exception as e:  # noqa: BLE001
            renderer = None
            notes.append(f"{m.ncam} camera(s) not rendered: no OpenGL here ({str(e).splitlines()[0][:60]}); try MUJOCO_GL=egl")
        for c in range(m.ncam):
            if not renderer:
                break
            cam = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_CAMERA, c)
            renderer.disable_depth_rendering()
            renderer.update_scene(d, cam)
            colours = len(np.unique(renderer.render().reshape(-1, 3), axis=0))
            renderer.enable_depth_rendering()
            renderer.update_scene(d, cam)
            depth = renderer.render()
            bottom, top = float(np.median(depth[-1])), float(np.median(depth[0]))
            # The horizon (where sky turns to floor) must sit where the camera's tilt and field of view put it;
            # a camera whose up points down (mounted upside down) has the sky at the bottom instead.
            rows = np.median(depth, axis=1)
            sky = rows >= 0.9 * rows.max()
            horizon = int(np.argmax(sky != sky[0])) if (sky != sky[0]).any() else None
            frame = d.cam_xmat[c].reshape(3, 3)
            look, up = -frame[:, 2], frame[:, 1]
            flipped = up[2] < 0
            pitch = np.arcsin(-look[2])
            offset = depth.shape[0] / 2 / np.tan(np.radians(m.cam_fovy[c]) / 2) * np.tan(pitch)
            expected = depth.shape[0] / 2 + (offset if flipped else -offset)
            notes.append(f"camera {cam}: {colours} colours, depth {bottom:.2f} m at the bottom, {top:.2f} m at the top, horizon at row {horizon} (expected {expected:.0f} for a {np.degrees(pitch):.0f} deg tilt{', upside down' if flipped else ''})")
            # The floor is a square, not endless: a camera near the ground sees its far edge some rows short of the true horizon.
            edge = 0.0
            if floor >= 0 and m.geom_size[floor][0] > 0:
                reach = max(m.geom_size[floor][0] - float(np.abs(d.cam_xpos[c][:2]).max()), 1e-6)
                edge = np.degrees(np.arctan(max(float(d.cam_xpos[c][2]), 0.0) / reach)) / (m.cam_fovy[c] / depth.shape[0])
            short = (expected - horizon) if flipped else (horizon - expected)
            ok &= colours >= 2 and horizon is not None and -2 <= short <= 2 + edge and bool(sky[0]) != bool(flipped) and (top < bottom if flipped else bottom < top)
        if renderer:
            renderer.close()
    warned = [mujoco.mjtWarning(i).name for i, w in enumerate(d.warning) if w.number]
    if warned:
        ok = False
        notes.append("warnings " + ", ".join(warned))
    # The starter scripts beside the model must run: drive.py headless, env.py's self-test when gymnasium is there.
    folder = os.path.dirname(xml)
    for script, args in (("drive.py", ["--headless", "--seconds", "0.5"]), ("env.py", [])):
        path = os.path.join(folder, script)
        if not os.path.exists(path):
            continue
        if script == "env.py":
            try:
                import gymnasium  # noqa: F401
            except ImportError:
                notes.append("env.py not run (no gymnasium)")
                continue
        import subprocess

        run = subprocess.run([sys.executable, "-I", os.path.abspath(path), *args], capture_output=True, text=True, cwd=folder)
        if run.returncode != 0:
            ok = False
            notes.append(f"{script} failed: {run.stderr.strip().splitlines()[-1] if run.stderr.strip() else run.returncode}")
        else:
            notes.append(f"{script} ok")
    print("PASS" if ok else "FAIL", name, "·", "; ".join(notes))
    failures += 0 if ok else 1
sys.exit(1 if failures else 0)
