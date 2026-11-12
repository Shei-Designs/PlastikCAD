// Robot mode: links, joints and sensors over the design's objects, the
// drive, trying a pose, and the export of the robot description.
import { zipSync } from 'fflate';
import { mark, plural, tr } from '../../i18n';
import { zipTime } from '../../io/format';
import { eulerOf, tidyVec } from '../../model/math';
import type { Mat } from '../../model/math';
import { newId } from '../../model/ops';
import type { Doc, SceneNode, Vec3 } from '../../model/types';
import * as platform from '../../platform';
import { tell } from '../../ui/ask';
import { geometry } from '../geometry';
import { checkRobot } from '../../robot/check';
import { buildIsaacStage, buildMjcfModel, buildRobotPackage, buildSdfModel, exportSummary, EXPORT_FORMATS, packageName } from '../../robot/export';
import type { ExportFormat } from '../../robot/export';
import { fitFollowers, solvePose } from '../../robot/kinematics';
import { jointInChild, jointInDesign as jointInDesignOf, linkNodes, linkOf, meetingPoint, robotOf, sensorInDesign, sensorInLink, spanningTree } from '../../robot/model';
import { snapPointsOf } from '../../robot/snaps';
import type { SnapPoint } from '../../viewer/Viewer';
import { jointFit } from '../../robot/defaults';
import { motorFigures, motorForPart, motorOf } from '../../robot/motors';
import { massOf } from '../../robot/inertia';
import { DRIVE_KINDS, defaultJoint, defaultSensor, SENSOR_KINDS } from '../../robot/types';
import type { DriveKind, DriveRole, Robot, RobotJoint, RobotLink, RobotSensor, SensorKind, World } from '../../robot/types';
import { massProps } from '../massProps';
import { endMerge, endWork, fail, getState, notify, previewingAlign, record, set, startWork } from './core';
import type { EditorState } from './core';
import { cancelPlacing } from './placing';
import { cancelMate } from './parts';
import { refreshAlignBounds, stopAligning } from './tools';
import { exportName, reportSaved } from './exporting';
import { inUnit } from '../../units';

// --- robot mode ---------------------------------------------------------------

/** The panels turn to links and joints; whatever was being carried or lined up is let go of. */
export function enterRobotMode(): void {
  if (getState().mating) cancelMate();
  if (getState().aligning) stopAligning();
  cancelPlacing();
  set({ robot: true, joint: null, bin: false, selection: [] });
}

export function leaveRobotMode(): void {
  if (getState().aligning) stopAligning();
  set({ robot: false, joint: null, sensor: null, jointPick: null, pose: null });
}
export const toggleRobotMode = (): void => (getState().robot ? leaveRobotMode() : enterRobotMode());

export function selectJoint(id: string | null): void {
  if (getState().aligning) stopAligning();
  set(id ? { joint: id, sensor: null, selection: [], jointPick: null, pose: null } : { joint: null, jointPick: null, pose: null });
}

export function selectSensor(id: string | null): void {
  if (getState().aligning) stopAligning();
  set(id ? { sensor: id, joint: null, selection: [], jointPick: null, pose: null } : { sensor: null, jointPick: null });
}

/** Replaces the robot as one undoable step, like `commit` does the scene. A pose was for the robot as it was. */
function commitRobot(robot: Robot, merge?: string): void {
  record(merge);
  set({ doc: { ...getState().doc, robot }, pose: null });
  // The dots know what is left to line up; not while one is only being looked at.
  if (getState().aligning && !previewingAlign()) refreshAlignBounds();
}

/**
 * The picked joint or sensor is placed by a click on one of these: the
 * corners, edge middles, face centers and axis ends of the joint's two links,
 * or of the sensor's one.
 */
export function jointSnaps(s: EditorState = getState()): SnapPoint[] {
  if (!s.jointPick) return [];
  if (s.sensor) {
    const sensor = s.doc.robot?.sensors.find((x) => x.id === s.sensor);
    const link = sensor && s.doc.scene.find((n) => n.id === sensor.link);
    return link ? snapPointsOf(link) : [];
  }
  const joint = s.joint ? s.doc.robot?.joints.find((j) => j.id === s.joint) : undefined;
  if (!joint) return [];
  const link = s.doc.scene.find((n) => n.id === (s.jointPick === 'parent' ? joint.parent : joint.child));
  return link ? snapPointsOf(link) : [];
}

/** Shows the snap points of one of the picked joint's links (or the picked sensor's link) to click on. */
export const startJointPick = (side: 'child' | 'parent' = 'child'): void => set({ jointPick: getState().joint || getState().sensor ? side : null, pose: null });
export const stopJointPick = (): void => set({ jointPick: null });

/** Puts the picked joint (or sensor) on a snap point; a point that carries an axis (the end of a cylinder) gives a joint that axis too. */
export function pickJointSnap(point: SnapPoint): void {
  if (getState().sensor) {
    const sensor = robotOf(getState().doc).sensors.find((x) => x.id === getState().sensor);
    const link = sensor && getState().doc.scene.find((n) => n.id === sensor.link);
    if (sensor && link) placeSensor(sensor.id, point.at, sensorInDesign(sensor, link).matrix);
    set({ jointPick: null });
    return;
  }
  const joint = getState().joint && robotOf(getState().doc).joints.find((j) => j.id === getState().joint);
  const child = joint && getState().doc.scene.find((n) => n.id === joint.child);
  if (!joint || !child) return;
  const placed = jointInDesignOf(joint, child);
  placeJoint(joint.id, point.at, point.axis ?? placed.axis);
  set({ jointPick: null });
}

// --- sensors, drive and control ---------------------------------------------------

const sensorName = (robot: Robot, base: string): string => {
  let name = base;
  for (let n = 2; robot.sensors.some((x) => x.name === name); n++) name = `${base}_${n}`;
  return name;
};

/** Fixes a sensor to a link at the link's center, looking along the design's +X, and picks it. */
export function addSensor(link: string, kind: SensorKind): string | null {
  const node = getState().doc.scene.find((n) => n.id === link);
  if (!node) return null;
  const id = newId();
  const base = SENSOR_KINDS.find((k) => k.id === kind)?.name.toLowerCase().replace(/\s+/g, '_') ?? kind;
  // A touch sensor starts at the link's lowest point, where a foot meets the floor; the others at its middle.
  const bounds = geometry.bounds(node);
  const at: Vec3 = kind === 'touch' ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, bounds.min[2]] : node.pos;
  const local = sensorInLink(at, [0, 0, 0], node);
  editRobot((r) => ({ ...r, sensors: [...r.sensors, { ...defaultSensor(id, sensorName(r, base), kind, link, tidyVec(local.origin)), rot: tidyVec(local.rot) }] }));
  selectSensor(id);
  return id;
}

export function updateSensor(id: string, patch: Partial<Omit<RobotSensor, 'id'>>, merge?: string): void {
  editRobot((r) => ({ ...r, sensors: r.sensors.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), merge);
}

/** Puts the sensor at a place in the design, turned as `matrix` says there (it is kept in its link's frame). */
export function placeSensor(id: string, origin: Vec3, matrix: Mat, merge?: string): void {
  const sensor = robotOf(getState().doc).sensors.find((x) => x.id === id);
  const link = sensor && getState().doc.scene.find((n) => n.id === sensor.link);
  if (!sensor || !link) return;
  const local = sensorInLink(origin, eulerOf(matrix), link);
  updateSensor(id, { origin: tidyVec(local.origin), rot: tidyVec(local.rot) }, merge);
}

export function deleteSensor(id: string): void {
  editRobot((r) => ({ ...r, sensors: r.sensors.filter((x) => x.id !== id) }));
  if (getState().sensor === id) set({ sensor: null });
}

/** Sets which wheel joints the differential drive turns on each side; nothing on either side removes the drive. */
/** Picks how the robot drives, or none; the roles that fit the new kind are kept. */
export function setDriveKind(kind: DriveKind | null): void {
  editRobot((r) => {
    const { drive: old, ...rest } = r;
    const def = DRIVE_KINDS.find((k) => k.id === kind);
    if (!def) return rest;
    const roles = Object.fromEntries(Object.entries(old?.roles ?? {}).filter(([, role]) => def.roles.some((x) => x.id === role)));
    return { ...rest, drive: { kind: def.id, roles } };
  });
}

/** Gives a joint its part in the drive, or none. */
export function setDriveRole(joint: string, role: DriveRole | null): void {
  editRobot((r) => {
    if (!r.drive) return r;
    const { [joint]: _old, ...roles } = r.drive.roles;
    return { ...r, drive: { ...r.drive, roles: role ? { ...roles, [joint]: role } : roles } };
  });
}

export const setControl = (control: boolean): void => editRobot((r) => ({ ...r, control }));
export const setWorld = (world: World): void => editRobot((r) => ({ ...r, world }));
export const setScripts = (scripts: boolean): void => editRobot((r) => ({ ...r, scripts }));

/**
 * Moves the picked joint to `value` for a look, every other free joint going
 * where the loops close; null puts the robot back. The design is not touched.
 */
export function setPose(value: number | null): void {
  const joint = getState().joint;
  if (value === null || !joint) return void set({ pose: null });
  const pose = getState().pose;
  const start = pose?.joint === joint ? pose.solved.values : undefined;
  const solved = solvePose(robotOf(getState().doc), getState().doc.scene, new Map([[joint, value]]), start);
  set({ pose: { joint, value, solved } });
}

/**
 * Finds how the passive joints of a linkage follow the picked one, by
 * sweeping it over its range with the loops closed, and writes that as each
 * one's mimic: exact for a parallelogram, a fit with a reported error else.
 */
export function fitJointFollowers(id: string): void {
  const robot = robotOf(getState().doc);
  const fits = fitFollowers(robot, getState().doc.scene, id);
  const fitted = [...fits].filter(([, fit]) => fit.closed);
  if (fitted.length === 0) {
    notify(fits.size ? tr('The linkage does not close over the whole range of this joint; narrow its limits and try again.') : tr('No other joint moves with this one.'), 'error');
    return;
  }
  editRobot((r) => ({ ...r, joints: r.joints.map((j) => (fits.has(j.id) && fits.get(j.id)!.closed ? { ...j, mimic: { joint: id, multiplier: fits.get(j.id)!.multiplier, offset: fits.get(j.id)!.offset } } : j)) }));
  const worst = Math.max(...fitted.map(([, fit]) => fit.error));
  const names = fitted.map(([jid]) => robot.joints.find((j) => j.id === jid)?.name ?? jid).join(', ');
  notify(
    worst < 0.05
      ? plural(fitted.length, '{names} now follows this joint exactly.', '{names} now follow this joint exactly.', { names })
      : plural(fitted.length, '{names} now follows this joint, off by up to {error} over the range (a line cannot do better).', '{names} now follow this joint, off by up to {error} over the range (a line cannot do better).', { names, error: worst.toFixed(1) }),
    'ok',
  );
}

const editRobot = (change: (robot: Robot) => Robot, merge?: string): void => commitRobot(change(robotOf(getState().doc)), merge);

export function setRobotRoot(node: string | null): void {
  editRobot((r) => ({ ...r, root: node }));
}

export function updateLink(node: string, patch: Partial<Omit<RobotLink, 'node'>>, merge?: string): void {
  editRobot((r) => ({ ...r, links: [...r.links.filter((l) => l.node !== node), { ...linkOf(r, node), ...patch }] }), merge);
}

const jointName = (robot: Robot, base: string): string => {
  let name = base;
  for (let n = 2; robot.joints.some((j) => j.name === name); n++) name = `${base} ${n}`;
  return name;
};

/**
 * Hangs `child` from `parent` by a new joint, and picks it. The joint starts
 * where the two meet (the middle of where their boxes overlap, or of the gap
 * between them: a wheel's hub on its axle, the end of an arm segment against
 * the last), with its axis along the child's Z.
 */
export function addJoint(parent: string, child: string): string | null {
  const childNode = getState().doc.scene.find((n) => n.id === child);
  const parentNode = getState().doc.scene.find((n) => n.id === parent);
  if (!childNode || !parentNode || parent === child) return null;
  const origin = jointInChild(meetingPoint(geometry.bounds(parentNode), geometry.bounds(childNode)), [0, 0, 1], childNode).origin;
  const id = newId();
  // A mount from the parts library on either side says which motor turns the joint.
  const motor = motorForPart(parentNode) ?? motorForPart(childNode);
  editRobot((r) => {
    const made = defaultJoint(id, jointName(r, `${childNode.name} joint`), parent, child, tidyVec(origin));
    return { ...r, root: r.root ?? parent, joints: [...r.joints, { ...made, ...jointFit(r, linkNodes(getState().doc.scene), made, (n) => weighed(r, n)), ...(motor ? motorFigures(motor) : {}) }] };
  });
  selectJoint(id);
  return id;
}

/** The link's mass in grams as the kernel has weighed it, or null before it has. */
function weighed(robot: Robot, node: SceneNode): number | null {
  const p = massProps.known([node]).get(node.id);
  return p ? massOf(linkOf(robot, node.id).mass, p) : null;
}

export const setBase = (base: Robot['base']): void => editRobot((r) => ({ ...r, base }));

export function updateJoint(id: string, patch: Partial<Omit<RobotJoint, 'id'>>, merge?: string): void {
  // An effort, speed or damping typed by hand makes the motor custom again.
  const typed = ('effort' in patch || 'velocity' in patch || 'damping' in patch) && !('motor' in patch) ? { ...patch, motor: undefined } : patch;
  editRobot((r) => ({ ...r, joints: r.joints.map((j) => (j.id === id ? { ...j, ...typed } : j)) }), merge);
}

/** Gives the joint a motor from the table, and its figures. */
export function setJointMotor(id: string, motor: string): void {
  const m = motorOf(motor);
  if (m) updateJoint(id, motorFigures(m));
}

/** Puts the joint at a place and direction given in the design's coordinates (it is kept in the child's). */
export function placeJoint(id: string, origin: Vec3, axis: Vec3, merge?: string): void {
  const joint = robotOf(getState().doc).joints.find((j) => j.id === id);
  const child = joint && getState().doc.scene.find((n) => n.id === joint.child);
  if (!joint || !child) return;
  const local = jointInChild(origin, axis, child);
  updateJoint(id, { origin: tidyVec(local.origin), axis: tidyVec(local.axis) }, merge);
}

/** Where the picked joint or sensor sits in the design (mm), as `doc` has it; null when none is picked or its link is gone. */
export function markerOriginIn(doc: Doc): Vec3 | null {
  const robot = robotOf(doc);
  if (getState().sensor) {
    const sensor = robot.sensors.find((x) => x.id === getState().sensor);
    const link = sensor && doc.scene.find((n) => n.id === sensor.link);
    return sensor && link ? sensorInDesign(sensor, link).origin : null;
  }
  const joint = getState().joint ? robot.joints.find((j) => j.id === getState().joint) : undefined;
  const child = joint && doc.scene.find((n) => n.id === joint.child);
  return joint && child ? jointInDesignOf(joint, child).origin : null;
}

/** The link the picked sensor sits on, or the one the picked joint hangs from. */
export function markerLink(): string | null {
  const robot = robotOf(getState().doc);
  if (getState().sensor) return robot.sensors.find((x) => x.id === getState().sensor)?.link ?? null;
  return robot.joints.find((j) => j.id === getState().joint)?.parent ?? null;
}

/** Puts the picked joint or sensor at `origin` (design mm), keeping the way it is turned or its axis. */
export function placeMarker(origin: Vec3, merge?: string): void {
  if (getState().sensor) {
    const sensor = robotOf(getState().doc).sensors.find((x) => x.id === getState().sensor);
    const link = sensor && getState().doc.scene.find((n) => n.id === sensor.link);
    if (sensor && link) placeSensor(sensor.id, origin, sensorInDesign(sensor, link).matrix, merge);
    return;
  }
  const joint = getState().joint && robotOf(getState().doc).joints.find((j) => j.id === getState().joint);
  const child = joint && getState().doc.scene.find((n) => n.id === joint.child);
  if (joint && child) placeJoint(joint.id, origin, jointInDesignOf(joint, child).axis, merge);
}

/** Moves the picked joint or sensor to `origin` (design mm) as a drag goes on; the steps of one drag undo together, and a drag that goes nowhere records nothing. */
export function dragMarker(origin: Vec3): void {
  const at = markerOriginIn(getState().doc);
  if (at && at.some((v, i) => Math.abs(v - origin[i]) >= 1e-6)) placeMarker(origin, 'marker-drag');
}

/** The drag is over: the next one is an undo step of its own. */
export function endMarkerDrag(): void {
  endMerge();
}

/** Hangs every link no chain of joints reaches from the base by a fixed joint to the base, where the two meet. One undo step. */
export function fixLooseLinks(): void {
  const robot = robotOf(getState().doc);
  const nodes = linkNodes(getState().doc.scene);
  const base = robot.root ? nodes.find((n) => n.id === robot.root) : undefined;
  if (!base) return;
  const { unreached } = spanningTree(robot, nodes.map((n) => n.id));
  const joints: RobotJoint[] = [];
  for (const id of unreached) {
    const child = nodes.find((n) => n.id === id);
    if (!child) continue;
    const meet = meetingPoint(geometry.bounds(base), geometry.bounds(child));
    const name = jointName({ ...robot, joints: [...robot.joints, ...joints] }, `${child.name} joint`);
    const made = { ...defaultJoint(newId(), name, base.id, id, tidyVec(jointInChild(meet, [0, 0, 1], child).origin)), type: 'fixed' as const };
    joints.push({ ...made, ...jointFit({ ...robot, joints: [...robot.joints, ...joints] }, nodes, made, (n) => weighed(robot, n)) });
  }
  if (joints.length === 0) return;
  editRobot((r) => ({ ...r, joints: [...r.joints, ...joints] }));
}

export function deleteJoint(id: string): void {
  editRobot((r) => ({
    ...r,
    joints: r.joints.filter((j) => j.id !== id).map((j) => (j.mimic?.joint === id ? (({ mimic: _m, ...rest }) => rest)(j) : j)),
  }));
  if (getState().joint === id) set({ joint: null });
}

/**
 * Writes the robot as a ROS 2 package in a zip: URDF, meshes and launch files.
 * Stopped by any error the checks find; the overview lists them. False if
 * nothing was written.
 */
export async function exportRobot(format: ExportFormat = getState().prefs.robotFormat): Promise<boolean> {
  try {
    return await writeRobot(format);
  } catch (e) {
    fail(e);
    return false;
  }
}

async function writeRobot(format: ExportFormat): Promise<boolean> {
  const doc = getState().doc;
  const robot = robotOf(doc);
  const nodes = linkNodes(doc.scene);
  const stop = async (problems: ReturnType<typeof checkRobot>): Promise<boolean> => {
    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length === 0) return false;
    set({ selection: [], joint: null, sensor: null });
    await tell({ title: tr('Robot'), text: `${plural(errors.length, 'One problem stops the export.', '{n} problems stop the export.')} ${errors[0].text}`, actions: [mark('OK')] });
    return true;
  };
  const problems = checkRobot(doc, massProps.known(nodes), robot);
  if (await stop(problems)) return false;
  // What goes out and what the checks warn of, before anything is written. Ignored objects are said in the sentence, not listed.
  const unreached = new Set(spanningTree(robot, nodes.map((n) => n.id)).unreached);
  const lines = problems.filter((p) => !(p.link && unreached.has(p.link))).map((p) => inUnit(p.text, getState().prefs.units));
  const label = EXPORT_FORMATS.find((f) => f.id === format)!.label;
  set({ selection: [], joint: null, sensor: null });
  if ((await tell({ title: tr('Export {format}', { format: label }), text: exportSummary(doc, format, robot), lines, actions: [mark('Export'), mark('Cancel')] })) !== 'Export') return false;
  const name = await exportName(packageName(doc.name), 'zip');
  if (!name) return false;
  startWork(tr('Exporting the robot…'));
  try {
    const worker = await geometry.prepare(nodes, doc.assets);
    const collisions = Object.fromEntries(nodes.map((n) => [n.id, linkOf(robot, n.id).collision]));
    const geo = await worker.robotGeometry(nodes, collisions, true);
    // Checked again with every link weighed, in case some had not been when the first check ran.
    if (await stop(checkRobot(doc, new Map(geo.map((g) => [g.id, g.props])), robot))) return false;
    const build = format === 'sdf' ? buildSdfModel : format === 'mjcf' ? buildMjcfModel : format === 'usd' ? buildIsaacStage : buildRobotPackage;
    const pkg = build(doc, new Map(geo.map((g) => [g.id, g])), robot);
    for (const w of pkg.leftOut) notify(w, 'error');
    const bytes = zipSync(Object.fromEntries(pkg.files.map((f) => [`${pkg.name}/${f.name}`, f.bytes])), { level: 6, mtime: zipTime() });
    const where = await platform.saveAs(`${name}.zip`, [{ name: tr('Zip archive'), extensions: ['zip'] }], bytes, 'application/zip');
    if (!where) return false;
    await reportSaved([where.name], where.path ? where.path.slice(0, where.path.length - where.name.length).replace(/[\\/]$/, '') || where.path : tr('your downloads'), where.uri ? [where.uri] : [], 'application/zip');
    return true;
  } catch (e) {
    fail(e);
    return false;
  } finally {
    endWork();
  }
}
