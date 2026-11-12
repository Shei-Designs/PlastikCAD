"""Simulates every exported MuJoCo model under a folder and says whether it behaves.

    ROBOT_FIXTURES_OUT=fixtures/out pnpm exec vitest run src/robot/robots.test.ts
    python3 tools/mujoco_smoke.py fixtures/out

Needs the `mujoco` package (pip install mujoco, or a venv). Each model is
settled for a second, then driven: velocity motors run at their limit and the
base must travel; position servos are sent 0.3 rad and must follow; a free
base must not collapse; and MuJoCo must raise no warnings. Exit code 1 on any
failure, 2 when mujoco is missing.
"""
import glob
import os
import sys

try:
    import mujoco
except ImportError:
    print("mujoco is not installed: pip install mujoco (a venv is fine) and run this with that Python.")
    sys.exit(2)
import numpy as np

root = sys.argv[1] if len(sys.argv) > 1 else "fixtures/out"
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
    for _ in steps(1.0):
        mujoco.mj_step(m, d)
    # The base frame may sit on the floor: the robot's center of mass says how high it stands, measured square to the floor when it is a tilted plane.
    floor = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "floor")
    up = np.array([0.0, 0.0, 1.0])
    if floor >= 0 and m.geom_type[floor] == mujoco.mjtGeom.mjGEOM_PLANE:
        up = d.geom_xmat[floor].reshape(3, 3)[:, 2]
    height = lambda: float(np.dot(d.subtree_com[base], up))  # noqa: E731
    start = d.subtree_com[base].copy()
    start_height = height()
    q0 = d.qpos.copy()
    servos = [a for a in range(m.nu) if m.actuator_biasprm[a, 1] != 0]
    motors = [a for a in range(m.nu) if a not in servos]
    notes = []
    ok = True
    if motors:
        for a in motors:
            d.ctrl[a] = m.actuator_ctrlrange[a, 1] if m.actuator_ctrllimited[a] else 1.0
        for _ in steps(2.0):
            mujoco.mj_step(m, d)
        moved = float(np.linalg.norm((d.subtree_com[base] - start)[:2]))
        notes.append(f"drove {moved * 1000:.0f} mm in 2 s")
        ok &= moved >= 0.01
    elif servos:
        # A walker on its servos must first stand still at its home pose, then follow a small step; an arm follows a larger one.
        if free:
            for _ in steps(1.0):
                mujoco.mj_step(m, d)
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
            d.ctrl[a] = held[a] + asked
        for _ in steps(1.0):
            mujoco.mj_step(m, d)
        swung = max(abs(float(d.qpos[i] - q0[i])) for i in adr)
        notes.append(f"servos swung up to {np.degrees(swung):.1f} deg of {np.degrees(asked):.1f} asked")
        ok &= swung >= asked / 3
    if free:
        now = height()
        notes.append(f"base at {now * 1000:.1f} mm, was {start_height * 1000:.1f}")
        ok &= now >= 0.7 * start_height
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
            ok &= colours >= 2 and horizon is not None and abs(horizon - expected) <= 2 and bool(sky[0]) != bool(flipped) and (top < bottom if flipped else bottom < top)
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
