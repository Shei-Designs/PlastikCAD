// The right panel in Robot mode: the robot itself while nothing is picked
// (name, base link, what the checks found), a link's mass and collision
// settings, or a joint's kind, place, axis and limits.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { marked, plural, tr, trx } from '../i18n';
import { rich } from '../i18n/rich';
import { eulerOf } from '../model/math';
import type { Mat } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { inertialInOwn, inertialOf, massOf, principalMoments } from '../robot/inertia';
import type { MeshProperties, Tensor } from '../robot/inertia';
import { MATERIALS, materialOf } from '../robot/materials';
import { followFault, jointInDesign, linkOf, robotForward, sensorInDesign } from '../robot/model';
import { MOTORS } from '../robot/motors';
import { COLLISION_KINDS, DRIVE_KINDS, driveJoints, JOINT_TYPES, MAX_PIECES, SENSOR_KINDS, WORLDS } from '../robot/types';
import type { CollisionShape, DriveKind, DriveRole, RobotJoint, RobotLink, RobotSensor, SensorKind, World } from '../robot/types';
import { shapeOf } from '../robot/collision';
import type { Problem } from '../robot/check';
import { addJoint, addSensor, deleteJoint, deleteSensor, fitJointFollowers, placeJoint, placeSensor, select, selectJoint, selectSensor, setBase, setControl, setDriveKind, setFaces, setDriveRole, setJointMotor, setPose, setPrefs, setRobotRoot, setScripts, setWorld, startJointPick, stopJointPick, updateJoint, updateLink, updateSensor, useEditor } from '../state/store';
import { rangeOf } from '../robot/kinematics';
import { sim } from '../state/sim';
import { inUnit, lengthFigure, lengthText, unitName } from '../units';
import type { Unit } from '../units';
import { formatNumber, NumberBox, selectOnFocus, SliderField } from './Fields';
import { Hint } from './Hint';
import { ChevronIcon, JointIcon, PinIcon, SensorIcon, TrashIcon, WarningIcon } from './icons';
import { NameField } from './Inspector';
import { useRobot } from './RobotPanel';

/** A text box that takes its value when typing is done (Enter or leaving), and gives it up on Escape. */
function TextField({ value, label, className = 'text-input', onCommit }: { value: string; label: string; className?: string; onCommit: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const clean = text.trim();
    if (clean && clean !== value) onCommit(clean);
    else setText(value);
  };
  return (
    <input
      className={className}
      aria-label={label}
      spellCheck={false}
      value={text}
      onFocus={selectOnFocus}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Select<T extends string>({ value, options, label, onChange, placeholder }: { value: T | ''; options: { value: T; label: string }[]; label: string; onChange: (v: T) => void; placeholder?: string }) {
  return (
    <label className="chip select wide" title={label}>
      <select aria-label={label} value={value} onChange={(e) => e.target.value && onChange(e.target.value as T)}>
        {placeholder !== undefined && (
          <option value="" disabled={value !== ''}>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronIcon />
    </label>
  );
}

function Problems({ problems }: { problems: Problem[] }) {
  const unit = useEditor((s) => s.prefs.units);
  if (problems.length === 0) return <p className="empty">{tr('Nothing stands in the way of an export.')}</p>;
  return (
    <ul className="problems">
      {problems.map((p, i) => (
        <li key={i} className={p.level === 'error' ? 'problem error' : 'problem warn'}>
          <WarningIcon />
          <span>{inUnit(p.text, unit)}</span>
          {(p.link || p.joint || p.sensor) && (
            <button type="button" className="chip" onClick={() => (p.joint ? selectJoint(p.joint) : p.sensor ? selectSensor(p.sensor) : select([p.link!]))}>
              {tr('Show')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Overview() {
  const { doc, robot, nodes, tree, props, problems } = useRobot();
  // The robot is the base and whatever hangs from it; objects no joint reaches are not counted or weighed.
  const attached = tree.order.length ? nodes.filter((n) => tree.order.includes(n.id)) : nodes;
  const total = attached.reduce((sum, n) => {
    const p = props.get(n.id);
    return p ? sum + massOf(linkOf(robot, n.id).mass, p) : sum;
  }, 0);
  const weighed = attached.every((n) => props.has(n.id));
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <h1>{doc.name}</h1>
          <p>{nodes.length ? tr('Pick a link or a joint on the left to set it up.') : tr('Every object in the design is a link.')}</p>
        </div>
      </header>
      <fieldset className="group">
        <legend>{tr('Robot')}</legend>
        <div className="field">
          <label>
            {tr('Base link')}
            <Hint text={tr('The link the rest hangs from: a body, a chassis, a mounting plate.')} />
          </label>
          <Select value={robot.root ?? ''} label={tr('Base link')} placeholder={tr('Choose an object…')} options={nodes.map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => setRobotRoot(id)} />
        </div>
        <div className="field inline">
          <label>
            {tr('Base')}
            <Hint text={tr('Free: the robot stands on the floor and can drive or walk. Fixed: the base is bolted to the world, as an arm on a bench.')} />
          </label>
          <div className="segmented small" role="radiogroup" aria-label={tr('Base')}>
            {(['free', 'fixed'] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={robot.base === b} className={robot.base === b ? 'on' : ''} onClick={() => setBase(b)}>
                {b === 'free' ? tr('Free') : tr('Fixed')}
              </button>
            ))}
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>{tr('Links')}</dt>
            <dd>{attached.length}</dd>
          </div>
          <div>
            <dt>{tr('Joints')}</dt>
            <dd>{robot.joints.length}</dd>
          </div>
          <div>
            <dt>{tr('Mass')}</dt>
            <dd>{nodes.length === 0 ? '–' : `${weighed ? '' : '≥ '}${grams(total)}`}</dd>
          </div>
        </dl>
      </fieldset>
      <Drive />
      <Controllers />
      <Test />
      <fieldset className="group">
        <legend>{tr('Checks')}</legend>
        <Problems problems={problems} />
      </fieldset>
    </>
  );
}

/** How the robot drives: the kind, and each turning joint's part in it. */
function Drive() {
  const { robot, nodes } = useRobot();
  const kind = DRIVE_KINDS.find((k) => k.id === robot.drive?.kind);
  const faces = kind && driveJoints(robot.drive).length ? robotForward(robot, new Map(nodes.map((n) => [n.id, n]))) : null;
  const facing = faces ? DIRECTIONS.find((d) => d.vector.every((v, i) => v === faces[i]))?.label : null;
  const wheels = robot.joints.filter((j) => j.type === 'continuous' || j.type === 'revolute');
  const roleOf = (id: string): DriveRole | 'none' => robot.drive?.roles[id] ?? 'none';
  return (
    <fieldset className="group">
      <legend>{trx('robot', 'Drive')}</legend>
      <div className="field inline">
        <label>
          {tr('Kind')}
          <Hint text={`${kind?.help ?? tr('How the robot moves on its wheels; the exports write the matching plugin and motors.')} ${facing ? tr('The wheel labels set which way is forward: this robot faces {direction}.', { direction: facing }) : tr('The wheel labels set which way is forward.')}`} />
        </label>
        <Select value={robot.drive?.kind ?? 'none'} label={tr('Drive kind')} options={[{ value: 'none', label: trx('drive', 'None') }, ...DRIVE_KINDS.map((k) => ({ value: k.id, label: k.name }))]} onChange={(v) => setDriveKind(v === 'none' ? null : (v as DriveKind))} />
      </div>
      {!kind && robot.base === 'free' && (
        <div className="field inline">
          <label>
            {tr('Forward')}
            <Hint text={tr('Sets which way is forward for a robot with no wheels.')} />
          </label>
          <div className="segmented small" role="radiogroup" aria-label={tr('Forward')}>
            {DIRECTIONS.slice(0, 4).map((d) => {
              const on = d.vector.every((v, i) => v === (robot.faces ?? [0, 1, 0])[i]);
              return (
                <button key={d.label} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => setFaces(d.vector)}>
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {kind &&
        (wheels.length === 0 ? (
          <p className="empty">{tr('Add a turning joint for each wheel first.')}</p>
        ) : (
          <ul className="drive-list">
            {wheels.map((j) => (
              <li key={j.id}>
                <span className="clip">{j.name}</span>
                {kind.roles.length <= 2 ? (
                  <div className="segmented small" role="radiogroup" aria-label={tr('{name} drives', { name: j.name })}>
                    {(['none', ...kind.roles.map((r) => r.id)] as const).map((to) => (
                      <button key={to} type="button" role="radio" aria-checked={roleOf(j.id) === to} className={roleOf(j.id) === to ? 'on' : ''} onClick={() => setDriveRole(j.id, to === 'none' ? null : to)}>
                        {to === 'none' ? tr('No') : kind.roles.find((r) => r.id === to)!.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Select value={roleOf(j.id)} label={tr('{name} drives', { name: j.name })} options={[{ value: 'none', label: tr('No') }, ...kind.roles.map((r) => ({ value: r.id, label: r.name }))]} onChange={(v) => setDriveRole(j.id, v === 'none' ? null : (v as DriveRole))} />
                )}
              </li>
            ))}
          </ul>
        ))}
    </fieldset>
  );
}

/** Whether the joints outside the drive go under ros2_control. */
function Controllers() {
  const { robot } = useRobot();
  const driven = new Set(driveJoints(robot.drive));
  const rest = robot.joints.filter((j) => j.type !== 'fixed' && !j.mimic && !driven.has(j.id));
  return (
    <fieldset className="group">
      <legend>{tr('Controllers')}</legend>
      <label className="field inline">
        <span className="switch-label">
          {tr('Controllers for the other joints')}
          <Hint text={tr('Writes ros2_control over every actuated joint that is not in the drive, with a joint trajectory controller (arm_controller) and a joint state broadcaster.')} />
        </span>
        <input type="checkbox" className="switch" checked={robot.control} onChange={(e) => setControl(e.target.checked)} />
      </label>
      {robot.control && rest.length > 0 && <p className="export-note">{rest.map((j) => j.name).join(', ')}</p>}
      <label className="field inline">
        <span className="switch-label">
          {tr('Starter scripts')}
          <Hint text={tr('Writes drive.py, a Gymnasium env.py and train.py beside the MuJoCo model.')} />
        </span>
        <input type="checkbox" className="switch" checked={robot.scripts !== false} onChange={(e) => setScripts(e.target.checked)} />
      </label>
    </fieldset>
  );
}

/** The robot driven on the plate by MuJoCo, built from the design as it stands: run, pause and reset it, steer a rover by the keys, move an arm's servos by sliders. */
function Test() {
  const { doc, robot, nodes, problems } = useRobot();
  const unit = useEditor((s) => s.prefs.units);
  useSyncExternalStore(sim.subscribe, sim.getRevision);
  const s = sim.get();
  const stopped = problems.some((p) => p.level === 'error');
  const servos = s.actuators.filter((a) => a.kind === 'servo');
  const jointOf = (id: string | null) => robot.joints.find((j) => j.id === id);
  return (
    <fieldset className="group">
      <legend>{tr('Test')}</legend>
      {s.status === 'off' && (
        <>
          <div className="field inline">
            <label>
              {tr('Floor')}
              <Hint text={`${WORLDS.find((w) => w.id === (robot.world ?? 'flat'))?.help(unit) ?? ''} ${tr('Only under the test drive: every export stands the robot on a flat floor.')}`} />
            </label>
            <Select value={robot.world ?? 'flat'} label={tr('Floor')} options={WORLDS.map((w) => ({ value: w.id, label: w.name }))} onChange={(w) => setWorld(w as World)} />
          </div>
          <div className="field">
            <button type="button" className="chip" disabled={stopped || !robot.root} title={tr("Builds the robot's MuJoCo model and runs it on the plate")} onClick={() => void sim.start(doc)}>
              {tr('Test drive')}
            </button>
            {stopped && <p className="export-note">{tr('The problems below stop the test drive, as they do the export.')}</p>}
          </div>
        </>
      )}
      {s.status === 'loading' && <p className="empty">{tr('Building the model…')}</p>}
      {s.status === 'error' && (
        <>
          <p className="export-note problems error">
            <WarningIcon />
            <span>{s.error}</span>
          </p>
          <div className="chip-row">
            <button type="button" className="chip" onClick={() => void sim.start(doc)}>
              {tr('Try again')}
            </button>
            <button type="button" className="chip" onClick={() => sim.stop()}>
              {tr('Stop')}
            </button>
          </div>
        </>
      )}
      {s.status === 'ready' && (
        <>
          <div className="chip-row">
            <button type="button" className="chip" title={s.running ? tr('Holds time still') : tr('Lets time run')} onClick={() => sim.setRunning(!s.running)}>
              {s.running ? tr('Pause') : tr('Run')}
            </button>
            <button type="button" className="chip" title={tr('Puts the robot back at its start, standing still')} onClick={() => sim.reset()}>
              {tr('Reset')}
            </button>
            {s.floating && (
              <button type="button" className={s.held ? 'chip on' : 'chip'} aria-pressed={s.held} title={s.held ? tr('Lets the robot go, back at its start') : tr('Holds the base still in the air, clear of the floor')} onClick={() => sim.hold(!s.held)}>
                {tr('Hold in the air')}
              </button>
            )}
            <button type="button" className="chip" title={tr('Ends the test drive; the plate shows the design again')} onClick={() => sim.stop()}>
              {tr('Stop')}
            </button>
          </div>
          {s.drive && (
            <p className="export-note">
              {s.drive.kind === 'mecanum'
                ? rich('Drive with {w} {a} {s} {d} or the arrow keys; {q} and {e} slide sideways.', { w: <kbd>W</kbd>, a: <kbd>A</kbd>, s: <kbd>S</kbd>, d: <kbd>D</kbd>, q: <kbd>Q</kbd>, e: <kbd>E</kbd> })
                : rich('Drive with {w} {a} {s} {d} or the arrow keys.', { w: <kbd>W</kbd>, a: <kbd>A</kbd>, s: <kbd>S</kbd>, d: <kbd>D</kbd> })}
            </p>
          )}
          {servos.map((a) => {
            const joint = jointOf(a.jointId);
            const angular = joint?.type !== 'prismatic';
            const scale = angular ? 180 / Math.PI : 1000;
            // Until it is moved, a servo holds its joint where the simulation began.
            const target = s.targets.has(a.name) ? s.targets.get(a.name)! * scale : (joint?.start ?? 0);
            return <SliderField key={a.name} label={joint?.name ?? a.joint} value={Math.round(target)} min={Math.ceil(a.min * scale)} max={Math.floor(a.max * scale)} step={1} unit={angular ? '°' : 'mm'} length={!angular} onChange={(v) => sim.setTarget(a.name, v / scale)} />;
          })}
          {s.faults.length > 0 && (
            <ul className="problems">
              {s.faults.map((f) => {
                const name = nodes.find((n) => n.id === f.id)?.name ?? '';
                const by = lengthText(f.by, unit, 0);
                return (
                  <li key={`${f.id}:${f.kind}`} className="problem warn">
                    <WarningIcon />
                    <span>
                      {f.kind === 'rides'
                        ? tr('"{name}" stands on its collision shape, {by} clear of the floor.', { name, by })
                        : f.bare
                          ? tr('"{name}" sinks {by} into the floor: it collides with nothing.', { name, by })
                          : tr('"{name}" sinks {by} into the floor: its collision shape is smaller than it.', { name, by })}
                    </span>
                    <button type="button" className="chip" onClick={() => select([f.id])}>
                      {tr('Show')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <dl className="facts">
            <div>
              <dt>{tr('Time')}</dt>
              <dd>{formatNumber(s.time, 1)} s</dd>
            </div>
            {robot.base === 'free' && s.base && (
              <>
                <div>
                  <dt>{tr('Moved')}</dt>
                  <dd>{distance(Math.hypot(s.base.pos[0], s.base.pos[1]), unit)}</dd>
                </div>
                <div>
                  <dt>{tr('Heading')}</dt>
                  <dd>{formatNumber(s.base.yaw, 0)}°</dd>
                </div>
              </>
            )}
          </dl>
        </>
      )}
    </fieldset>
  );
}

/** How far the robot drove: whole millimeters, meters from a thousand of them on, or inches. */
const distance = (v: number, unit: Unit): string => (unit === 'in' ? lengthText(v, unit, 0) : v >= 1000 ? `${formatNumber(v / 1000, 2)} m` : `${formatNumber(v, 0)} mm`);
const grams = (g: number): string => (g >= 1000 ? `${formatNumber(g / 1000, 3)} kg` : `${formatNumber(g, g < 10 ? 2 : 1)} g`);
const cm3 = (mm3: number): string => `${formatNumber(mm3 / 1000, mm3 < 10000 ? 2 : 1)} cm³`;

const INERTIA_TAGS = ['XX', 'YY', 'ZZ', 'XY', 'XZ', 'YZ'] as const;
/** The units an inertia is typed in: its name, how many g·mm² one of it is, the decimals its boxes keep and the step of their arrow keys. */
const INERTIA_UNITS = {
  gcm2: { name: 'g·cm²', scale: 100, places: 3, step: 1 },
  kgm2: { name: 'kg·m²', scale: 1e9, places: 9, step: 1e-6 },
} as const;
/** g·mm² as a figure of the readout, in the chosen unit: g·cm² is the size robot parts come in, kg·m² what datasheets and robot files give. */
const inertia = (gmm2: number, unit: keyof typeof INERTIA_UNITS): string => (unit === 'kgm2' ? String(Number((gmm2 / 1e9).toPrecision(3))) : formatNumber(gmm2 / 100, gmm2 / 100 < 10 ? 3 : 1));

/**
 * The center of mass and the inertia of a weighed link, in the object's own
 * frame. They show what the shape gives until one is typed; from then on all
 * of that row is kept as typed, until it is given back to the shape.
 */
function WeighedFigures({ node, mass, props, onChange }: { node: SceneNode; mass: Extract<RobotLink['mass'], { kind: 'measured' }>; props: MeshProperties; onChange: (mass: RobotLink['mass'], merge?: string) => void }) {
  const working = useEditor((s) => s.prefs.units);
  const own = inertialInOwn(mass, node, props);
  // To the thousandth, and no minus zero: what the boxes show is what is kept once one of them is typed in.
  const round = (x: number): number => Number(x.toFixed(3)) + 0;
  const center = own.center.map(round);
  // g·mm² in the design, the chosen unit in the boxes.
  const unitId = useEditor((s) => s.prefs.inertiaUnit);
  const unit = INERTIA_UNITS[unitId];
  const shown = own.inertia.map((x) => Number((x / unit.scale).toFixed(unit.places)) + 0);
  const box = (i: number) => (
    <NumberBox
      key={INERTIA_TAGS[i]}
      label={tr('Inertia {axes}', { axes: INERTIA_TAGS[i] })}
      tag={INERTIA_TAGS[i]}
      value={shown[i]}
      min={i < 3 ? 0 : undefined}
      step={unit.step}
      places={unit.places}
      onChange={(v) => onChange({ ...mass, inertia: shown.map((x, k) => Number(((k === i ? v : x) * unit.scale).toPrecision(12))) as Tensor }, 'link-inertia')}
    />
  );
  return (
    <>
      <div className="field">
        <label>
          {tr('Center of mass')}
          <Hint text={tr("Sets where the center of mass is, from the object's origin along its own axes ({unit}).", { unit: unitName(working) })} />
        </label>
        <div className="number-row spread">
          {(['X', 'Y', 'Z'] as const).map((tag, i) => (
            <NumberBox key={tag} label={tr('Center of mass {axis}', { axis: tag })} tag={tag} value={center[i]} length step={1} places={2} onChange={(v) => onChange({ ...mass, center: center.map((x, k) => (k === i ? v : x)) as Vec3 }, 'link-center')} />
          ))}
        </div>
      </div>
      <div className="field">
        <label>
          {tr('Inertia')}
          <Hint text={tr("Sets the inertia about the center of mass, along the object's own axes.")} />
        </label>
        <div className="segmented small" role="radiogroup" aria-label={tr('Inertia unit')}>
          {(Object.keys(INERTIA_UNITS) as (keyof typeof INERTIA_UNITS)[]).map((id) => (
            <button key={id} type="button" role="radio" aria-checked={unitId === id} className={unitId === id ? 'on' : ''} title={tr('Shows the inertia in {unit}', { unit: INERTIA_UNITS[id].name })} onClick={() => setPrefs({ inertiaUnit: id })}>
              {INERTIA_UNITS[id].name}
            </button>
          ))}
        </div>
        <div className="number-row spread pairs">{[0, 1, 2].map(box)}</div>
        <div className="number-row spread pairs">{[3, 4, 5].map(box)}</div>
      </div>
      {(mass.center || mass.inertia) && (
        <div className="field">
          <button type="button" className="chip" title={tr('Takes the center of mass and the inertia from the shape again')} onClick={() => onChange({ kind: 'measured', grams: mass.grams })}>
            {tr('From the shape')}
          </button>
        </div>
      )}
    </>
  );
}

/** The size and the place of a box, a cylinder or a ball a link collides as: what is fitted to the object until one is typed. */
function CollisionBoxes({ node, link, onChange }: { node: SceneNode; link: RobotLink; onChange: (shape: CollisionShape) => void }) {
  const working = useEditor((s) => s.prefs.units);
  const shape = shapeOf(node, link);
  const kind = link.collision;
  // A cylinder is as wide in X as in Y, a ball as wide every way: one box sets them together.
  const sizes: { tag: string; label: string; value: number; at: number[] }[] =
    kind === 'box'
      ? (['X', 'Y', 'Z'] as const).map((tag, i) => ({ tag, label: tr('Collision size {axis}', { axis: tag }), value: shape.size[i], at: [i] }))
      : kind === 'cylinder'
        ? [
            { tag: 'Ø', label: tr('Collision diameter'), value: shape.size[0], at: [0, 1] },
            { tag: 'L', label: tr('Collision length'), value: shape.size[2], at: [2] },
          ]
        : [{ tag: 'Ø', label: tr('Collision diameter'), value: shape.size[0], at: [0, 1, 2] }];
  return (
    <>
      <div className="field">
        <label>
          {tr('Size')}
          <Hint text={tr('Sets how large the collision shape is ({unit}).', { unit: unitName(working) })} />
        </label>
        <div className="number-row spread">
          {sizes.map((b) => (
            <NumberBox key={b.tag} label={b.label} tag={b.tag} value={b.value} length min={0.01} step={1} places={2} onChange={(v) => onChange({ ...shape, size: shape.size.map((x, k) => (b.at.includes(k) ? v : x)) as Vec3 })} />
          ))}
        </div>
      </div>
      <div className="field">
        <label>
          {tr('Center')}
          <Hint text={tr("Sets where the collision shape's center is, from the object's origin along its own axes ({unit}).", { unit: unitName(working) })} />
        </label>
        <div className="number-row spread">
          {(['X', 'Y', 'Z'] as const).map((tag, i) => (
            <NumberBox key={tag} label={tr('Collision center {axis}', { axis: tag })} tag={tag} value={shape.center[i]} length step={1} places={2} onChange={(v) => onChange({ ...shape, center: shape.center.map((x, k) => (k === i ? v : x)) as Vec3 })} />
          ))}
        </div>
      </div>
    </>
  );
}

function LinkPanel({ node }: { node: SceneNode }) {
  const { robot, nodes, props, problems } = useRobot();
  const unit = useEditor((s) => s.prefs.units);
  const inertiaUnit = useEditor((s) => s.prefs.inertiaUnit);
  const link = linkOf(robot, node.id);
  const p = props.get(node.id);
  const mass = p ? massOf(link.mass, p) : null;
  const figures = p ? inertialOf(link.mass, node, p) : null;
  const material = link.mass.kind === 'material' ? materialOf(link.mass.material) : null;
  const own = problems.filter((q) => q.link === node.id);
  const others = nodes.filter((n) => n.id !== node.id);
  const joints = robot.joints.filter((j) => j.parent === node.id || j.child === node.id);
  const sensors = robot.sensors.filter((x) => x.link === node.id);
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? '?';
  const set = (patch: Partial<Omit<RobotLink, 'node'>>, merge?: string) => updateLink(node.id, patch, merge);
  const setMass = (patch: Record<string, unknown>, merge?: string) => set({ mass: { ...link.mass, ...patch } as RobotLink['mass'] }, merge);
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <NameField node={node} />
          <p>{node.id === robot.root ? tr('Base link') : link.name ? tr('Link · {name}', { name: link.name }) : tr('Link')}</p>
        </div>
        {node.id !== robot.root && (
          <button type="button" className="chip" title={tr('Makes this the link the rest of the robot hangs from')} onClick={() => setRobotRoot(node.id)}>
            {tr('Make base')}
          </button>
        )}
      </header>
      <fieldset className="group">
        <legend>{tr('Mass')}</legend>
        <div className="field">
          <div className="segmented" role="radiogroup" aria-label={tr('How the mass is known')}>
            <button type="button" role="radio" aria-checked={link.mass.kind === 'material'} className={link.mass.kind === 'material' ? 'on' : ''} title={tr('Figures the mass from the shape and what it is made of')} onClick={() => link.mass.kind !== 'material' && set({ mass: { kind: 'material', material: 'pla', infill: 20, shell: 1.2 } })}>
              {tr('From material')}
            </button>
            <button type="button" role="radio" aria-checked={link.mass.kind === 'measured'} className={link.mass.kind === 'measured' ? 'on' : ''} title={tr('A mass you weighed or read off a datasheet')} onClick={() => link.mass.kind !== 'measured' && set({ mass: { kind: 'measured', grams: mass && mass > 0 ? Number(mass.toFixed(1)) : 10 } })}>
              {tr('Weighed')}
            </button>
          </div>
        </div>
        {link.mass.kind === 'measured' ? (
          <>
          <div className="field inline">
            <label>{tr('Mass')}</label>
            <NumberBox label={tr('Mass')} value={link.mass.grams} unit="g" min={0} step={1} places={2} onChange={(v) => setMass({ grams: v }, 'link-mass')} />
          </div>
          {p && <WeighedFigures node={node} mass={link.mass} props={p} onChange={(mass, merge) => set({ mass }, merge)} />}
          </>
        ) : (
          <>
            <div className="field inline">
              <label>{trx('made of', 'Material')}</label>
              <Select value={link.mass.material} label={trx('made of', 'Material')} options={MATERIALS.map((m) => ({ value: m.id, label: m.name }))} onChange={(id) => setMass({ material: id })} />
            </div>
            {material?.printed && (
              <>
                <SliderField label={tr('Infill')} help={tr('Sets how full the inside is; the shell stays solid.')} value={link.mass.infill} min={0} max={100} step={5} unit="%" onChange={(v) => setMass({ infill: v }, 'link-infill')} />
                <div className="field inline">
                  <label>
                    {tr('Shell')}
                    <Hint text={tr('Walls plus top and bottom layers, as one thickness.')} />
                  </label>
                  <NumberBox label={tr('Shell thickness')} value={link.mass.shell} unit="mm" length min={0} max={20} step={0.4} places={2} onChange={(v) => setMass({ shell: v }, 'link-shell')} />
                </div>
              </>
            )}
          </>
        )}
        <dl className="facts">
          <div>
            <dt>{tr('Volume')}</dt>
            <dd>{p ? cm3(p.volume) : '…'}</dd>
          </div>
          <div>
            <dt>{tr('Surface')}</dt>
            <dd>{p ? `${formatNumber(p.area / 100, 1)} cm²` : '…'}</dd>
          </div>
          <div>
            <dt>{tr('Mass')}</dt>
            <dd>{mass === null ? '…' : grams(mass)}</dd>
          </div>
          <div>
            <dt>{tr('Center of mass')}</dt>
            <dd>{figures ? figures.center.map((v) => lengthFigure(v, unit, 1)).join(', ') : '…'}</dd>
          </div>
          <div>
            <dt title={tr('Principal moments of inertia, {unit}', { unit: INERTIA_UNITS[inertiaUnit].name })}>{tr('Inertia')}</dt>
            <dd>
              {figures && mass
                ? principalMoments(figures.inertia)
                    .sort((a, b) => b - a)
                    .map((v) => inertia(v, inertiaUnit))
                    .join(' · ') + ` ${INERTIA_UNITS[inertiaUnit].name}`
                : '…'}
            </dd>
          </div>
        </dl>
      </fieldset>
      <fieldset className="group">
        <legend>{tr('Collision')}</legend>
        <div className="field inline">
          <label>
            {tr('Shape')}
            <Hint text={COLLISION_KINDS.find((k) => k.id === link.collision)?.help ?? ''} />
          </label>
          <Select value={link.collision} label={tr('Collision shape')} options={COLLISION_KINDS.map((k) => ({ value: k.id, label: k.name }))} onChange={(id) => set({ collision: id, shape: undefined })} />
        </div>
        {link.collision === 'hull' && (
          <div className="field inline">
            <label>
              {tr('Pieces')}
              <Hint text={tr('Sets how many convex pieces each part is split into at most.')} />
            </label>
            <NumberBox label={tr('Pieces')} value={link.pieces ?? 1} min={1} max={MAX_PIECES} step={1} places={0} onChange={(v) => set({ pieces: Math.round(v) > 1 ? Math.round(v) : undefined }, 'link-pieces')} />
          </div>
        )}
        {(link.collision === 'box' || link.collision === 'cylinder' || link.collision === 'sphere') && <CollisionBoxes node={node} link={link} onChange={(shape) => set({ shape }, 'link-shape')} />}
        {link.shape && (link.collision === 'box' || link.collision === 'cylinder' || link.collision === 'sphere') && (
          <div className="field">
            <button type="button" className="chip" title={tr("Fits the shape to the object's box again")} onClick={() => set({ shape: undefined })}>
              {tr('Fit to the object')}
            </button>
          </div>
        )}
        <div className="field inline">
          <label>
            {tr('Friction')}
            <Hint text={tr('Coefficient of friction against what it touches; rubber on floor is about 1, plastic on plastic 0.3.')} />
          </label>
          <NumberBox label={tr('Friction')} value={link.friction} min={0} max={5} step={0.1} places={2} onChange={(v) => set({ friction: v }, 'link-friction')} />
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>{tr('Joints')}</legend>
        {joints.length > 0 && (
          <ul className="joint-list">
            {joints.map((j) => (
              <li key={j.id}>
                <button type="button" className="outline-row joint" onClick={() => selectJoint(j.id)}>
                  <JointIcon />
                  <span className="clip">{j.name}</span>
                  <span className="outline-kind">{j.child === node.id ? tr('from {name}', { name: nameOf(j.parent) }) : tr('to {name}', { name: nameOf(j.child) })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 ? (
          <div className="field inline">
            <label>
              {tr('Attach to')}
              <Hint text={tr('Hangs this link from another by a new joint.')} />
            </label>
            <Select value="" label={tr('Attach to')} placeholder={tr('Choose a link…')} options={others.map((n) => ({ value: n.id, label: n.name }))} onChange={(parent) => addJoint(parent, node.id)} />
          </div>
        ) : (
          <p className="empty">{tr('Add another object to have something to attach to.')}</p>
        )}
      </fieldset>
      <fieldset className="group">
        <legend>{tr('Sensors')}</legend>
        {sensors.length > 0 && (
          <ul className="joint-list">
            {sensors.map((x) => (
              <li key={x.id}>
                <button type="button" className="outline-row joint" onClick={() => selectSensor(x.id)}>
                  <SensorIcon />
                  <span className="clip">{x.name}</span>
                  <span className="outline-kind">{x.kind === 'imu' ? 'IMU' : marked(x.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="field inline">
          <label>
            {tr('Add')}
            <Hint text={tr('Fixes a sensor to this link: a frame of its own, with a Gazebo sensor in it and its topics bridged to ROS 2.')} />
          </label>
          <Select value="" label={tr('Add a sensor')} placeholder={tr('Choose a sensor…')} options={SENSOR_KINDS.map((k) => ({ value: k.id, label: marked(k.name) }))} onChange={(kind) => addSensor(node.id, kind as SensorKind)} />
        </div>
      </fieldset>
      {own.length > 0 && (
        <fieldset className="group">
          <legend>{tr('Checks')}</legend>
          <Problems problems={own} />
        </fieldset>
      )}
    </>
  );
}

const AXES: { label: string; vector: Vec3 }[] = [
  { label: 'X', vector: [1, 0, 0] },
  { label: 'Y', vector: [0, 1, 0] },
  { label: 'Z', vector: [0, 0, 1] },
];

function JointPanel({ joint }: { joint: RobotJoint }) {
  const { robot, nodes, problems, tree } = useRobot();
  const picking = useEditor((s) => s.jointPick);
  const pose = useEditor((s) => s.pose);
  const working = useEditor((s) => s.prefs.units);
  const [lo, hi] = rangeOf(joint);
  const posed = pose?.joint === joint.id ? pose.value : 0;
  const inLoop = tree.loops.length > 0;
  const child = nodes.find((n) => n.id === joint.child);
  const parent = nodes.find((n) => n.id === joint.parent);
  const placed = child ? jointInDesign(joint, child) : { origin: joint.origin, axis: joint.axis };
  const own = problems.filter((q) => q.joint === joint.id);
  const angular = joint.type === 'revolute' || joint.type === 'continuous';
  const unit = angular ? '°' : 'mm';
  const put = (origin: Vec3, axis: Vec3, merge?: string) => placeJoint(joint.id, origin, axis, merge);
  const along = AXES.findIndex((a) => Math.abs(Math.abs(placed.axis[0] * a.vector[0] + placed.axis[1] * a.vector[1] + placed.axis[2] * a.vector[2]) - 1) < 1e-6);
  const flipped = along >= 0 && placed.axis[along] < 0;
  const row = (label: string, content: ReactNode, help?: string) => (
    <div className="field inline">
      <label>
        {label}
        {help && <Hint text={help} />}
      </label>
      {content}
    </div>
  );
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <TextField className="name-input" value={joint.name} label={tr('Joint name')} onCommit={(name) => updateJoint(joint.id, { name })} />
          <p>
            {parent?.name ?? '?'} → {child?.name ?? '?'}
          </p>
        </div>
        <button type="button" className="icon-button" title={tr('Delete this joint ({key})', { key: 'Delete' })} aria-label={tr('Delete joint')} onClick={() => deleteJoint(joint.id)}>
          <TrashIcon />
        </button>
      </header>
      <fieldset className="group">
        <legend>{tr('Joint')}</legend>
        <div className="field">
          <div className="segmented small" role="radiogroup" aria-label={tr('Joint type')}>
            {JOINT_TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={joint.type === t.id} className={joint.type === t.id ? 'on' : ''} title={t.help} onClick={() => updateJoint(joint.id, { type: t.id })}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
        {row(tr('Parent'), <Select value={joint.parent} label={tr('Parent link')} options={nodes.filter((n) => n.id !== joint.child).map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => updateJoint(joint.id, { parent: id })} />)}
        {row(tr('Child'), <Select value={joint.child} label={tr('Child link')} options={nodes.filter((n) => n.id !== joint.parent).map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => updateJoint(joint.id, { child: id })} />, tr('The link that moves. The joint is kept with it: move the child and the joint comes along.'))}
      </fieldset>
      <fieldset className="group">
        <legend>{trx('where it sits', 'Place')}</legend>
        <div className="field">
          <label>
            {tr('Pick a point')}
            <Hint text={tr('Shows the corners, edge middles, face centers and axis ends of one link; click one to put the joint there. The end of a round shape gives its axis too.')} />
          </label>
          <div className="chip-row">
            {(['child', 'parent'] as const).map((side) => (
              <button key={side} type="button" className={picking === side ? 'chip pick on' : 'chip pick'} aria-pressed={picking === side} title={side === 'child' ? tr('Points on the child, the link that moves') : tr('Points on the parent, the link it hangs from')} onClick={() => (picking === side ? stopJointPick() : startJointPick(side))}>
                <PinIcon />
                {picking === side ? (side === 'child' ? tr('Click a point on the child…') : tr('Click a point on the parent…')) : side === 'child' ? tr('On the child') : tr('On the parent')}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>
            {tr('Origin')}
            <Hint text={tr("Where the joint sits, in the design's coordinates ({unit}).", { unit: unitName(working) })} />
          </label>
          <div className="number-row spread">
            {(['X', 'Y', 'Z'] as const).map((tag, i) => (
              <NumberBox key={tag} label={tr('Origin {axis}', { axis: tag })} tag={tag} value={Number(placed.origin[i].toFixed(3))} length step={1} places={2} onChange={(v) => put(placed.origin.map((x, k) => (k === i ? v : x)) as Vec3, placed.axis, 'joint-origin')} />
            ))}
          </div>
        </div>
        {joint.type !== 'fixed' && (
          <div className="field">
            <label>
              {tr('Axis')}
              <Hint text={tr("The line it turns about or slides along, in the design's coordinates.")} />
            </label>
            <div className="axis-row">
              <div className="segmented small" role="radiogroup" aria-label={tr('Axis')}>
                {AXES.map((a, i) => (
                  <button key={a.label} type="button" role="radio" aria-checked={along === i} className={along === i ? 'on' : ''} onClick={() => put(placed.origin, flipped ? (a.vector.map((x) => -x) as Vec3) : a.vector)}>
                    {a.label}
                  </button>
                ))}
              </div>
              <button type="button" className={flipped ? 'chip on' : 'chip'} aria-pressed={flipped} title={tr('Turns the axis the other way, so positive motion goes the other way')} onClick={() => put(placed.origin, placed.axis.map((x) => -x) as Vec3)}>
                {trx('axis', 'Flip')}
              </button>
            </div>
            {along < 0 && <p className="export-note">{tr("{axis} (set by the child's turn)", { axis: placed.axis.map((v) => formatNumber(v, 3)).join(', ') })}</p>}
          </div>
        )}
      </fieldset>
      {joint.type !== 'fixed' && (
        <fieldset className="group">
          <legend>
            {tr('Try it')}
            {pose?.joint === joint.id && (
              <button type="button" className="chip" title={tr('Puts the robot back')} onClick={() => setPose(null)}>
                {tr('Reset')}
              </button>
            )}
          </legend>
          <SliderField label={angular ? tr('Angle') : tr('Travel')} help={tr('Moves the joint on the plate to see the robot move; the design stays as it is.')} value={posed} min={lo} max={hi} step={angular ? 1 : 0.5} unit={unit} length={!angular} onChange={(v) => setPose(v)} />
          {!joint.mimic && (
            <div className="field inline">
              <label>
                {tr('Start')}
                <Hint text={tr('Sets where the joint stands when a simulation begins.')} />
              </label>
              <button type="button" className="chip" title={tr("Takes the slider's value as the start")} disabled={pose?.joint !== joint.id} onClick={() => updateJoint(joint.id, { start: posed || undefined })}>
                {tr('Set as start')}
              </button>
              <NumberBox label={tr('Start')} value={joint.start ?? 0} unit={unit} length={!angular} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { start: v || undefined }, 'joint-start')} />
            </div>
          )}
          {pose?.joint === joint.id && !pose.solved.closed && <p className="export-note problems warn">{tr('The linkage cannot close here: a loop joint is {gap} apart.', { gap: lengthText(pose.solved.error, working, 1) })}</p>}
          {inLoop && (
            <div className="field">
              <button type="button" className="chip" title={tr('Sweeps this joint over its range with the loops closed and sets the passive joints to follow it (mimic), as URDF needs')} onClick={() => fitJointFollowers(joint.id)}>
                {tr('Set the others to follow this joint')}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {joint.type !== 'fixed' && (
        <fieldset className="group motion">
          <legend>{tr('Motion')}</legend>
          {angular &&
            row(
              tr('Motor'),
              <Select value={joint.motor ?? ''} label={tr('Motor')} placeholder={trx('motor', 'Custom')} options={MOTORS.map((m) => ({ value: m.id, label: `${m.name} · ${m.torque} N·m, ${m.speed}°/s` }))} onChange={(id) => setJointMotor(joint.id, id)} />,
              tr("Sets the effort, speed and damping to the motor's figures; typing any of them makes it custom again."),
            )}
          {robot.control &&
            !joint.mimic &&
            !driveJoints(robot.drive).includes(joint.id) &&
            row(
              tr('Command'),
              <div className="segmented small" role="radiogroup" aria-label={tr('Command')}>
                <button type="button" role="radio" aria-checked={!joint.command} className={joint.command ? '' : 'on'} title={tr('A controller sends a position, and the joint holds it')} onClick={() => joint.command && updateJoint(joint.id, { command: undefined })}>
                  {tr('Position')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={joint.command === 'torque'}
                  className={joint.command === 'torque' ? 'on' : ''}
                  title={angular ? tr('A controller sends a torque, and holds the joint itself') : tr('A controller sends a force, and holds the joint itself')}
                  onClick={() => !joint.command && updateJoint(joint.id, { command: 'torque' })}
                >
                  {angular ? tr('Torque') : tr('Force')}
                </button>
              </div>,
              tr('Sets what a controller sends the joint in the exported files.'),
            )}
          {joint.type !== 'continuous' && (
            <>
              {row(tr('Lower limit'), <NumberBox label={tr('Lower limit')} value={joint.lower} unit={unit} length={!angular} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { lower: v }, 'joint-lower')} />)}
              {row(tr('Upper limit'), <NumberBox label={tr('Upper limit')} value={joint.upper} unit={unit} length={!angular} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { upper: v }, 'joint-upper')} />)}
            </>
          )}
          {row(tr('Effort'), <NumberBox label={tr('Effort')} value={joint.effort} unit={angular ? 'N·m' : 'N'} min={0} step={angular ? 0.5 : 5} places={6} onChange={(v) => updateJoint(joint.id, { effort: v }, 'joint-effort')} />, tr("The most the actuator can push with: a servo's torque, a linear actuator's force."))}
          {row(tr('Velocity'), <NumberBox label={tr('Velocity')} value={joint.velocity} unit={angular ? '°/s' : 'mm/s'} min={0} step={angular ? 10 : 5} places={2} onChange={(v) => updateJoint(joint.id, { velocity: v }, 'joint-velocity')} />, tr('The fastest it moves under no load.'))}
          {row(tr('Damping'), <NumberBox label={tr('Damping')} value={joint.damping} unit={angular ? 'N·m·s' : 'N·s/m'} min={0} step={0.1} places={6} onChange={(v) => updateJoint(joint.id, { damping: v }, 'joint-damping')} />, tr('Resistance that grows with speed; a little keeps a simulation calm.'))}
          {row(tr('Friction'), <NumberBox label={tr('Joint friction')} value={joint.friction} unit={angular ? 'N·m' : 'N'} min={0} step={0.1} places={6} onChange={(v) => updateJoint(joint.id, { friction: v }, 'joint-friction')} />, tr('Resistance that is there at any speed: gearbox drag, seals.'))}
          {row(
            tr('Follows'),
            <Select
              value={joint.mimic?.joint ?? ''}
              label={tr('Follows')}
              placeholder={tr('Nothing')}
              options={robot.joints.filter((j) => j.id !== joint.id && (j.id === joint.mimic?.joint || !followFault(robot, tree, joint, j))).map((j) => ({ value: j.id, label: j.name }))}
              onChange={(id) => updateJoint(joint.id, { mimic: { joint: id, multiplier: joint.mimic?.multiplier ?? 1, offset: joint.mimic?.offset ?? 0 } })}
            />,
            tr('A passive joint moved by another, as in a linkage: it goes as far as that one times the multiplier, plus the offset.'),
          )}
          {joint.mimic && (
            <div className="field">
              <div className="number-row spread">
                <NumberBox label={tr('Multiplier')} tag="×" value={joint.mimic.multiplier} step={0.1} places={3} onChange={(v) => updateJoint(joint.id, { mimic: { ...joint.mimic!, multiplier: v } }, 'joint-mimic')} />
                <NumberBox label={tr('Offset')} tag="+" value={joint.mimic.offset} unit={unit} length={!angular} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { mimic: { ...joint.mimic!, offset: v } }, 'joint-mimic')} />
                <button type="button" className="chip" title={tr('Follows nothing')} onClick={() => updateJoint(joint.id, { mimic: undefined })}>
                  {tr('Clear')}
                </button>
              </div>
            </div>
          )}
        </fieldset>
      )}
      {own.length > 0 && (
        <fieldset className="group">
          <legend>{tr('Checks')}</legend>
          <Problems problems={own} />
        </fieldset>
      )}
    </>
  );
}

const DIRECTIONS: { label: string; vector: Vec3 }[] = [
  { label: '+X', vector: [1, 0, 0] },
  { label: '−X', vector: [-1, 0, 0] },
  { label: '+Y', vector: [0, 1, 0] },
  { label: '−Y', vector: [0, -1, 0] },
  { label: '+Z', vector: [0, 0, 1] },
  { label: '−Z', vector: [0, 0, -1] },
];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** `frame` tipped about its own Y by `tilt` degrees: a camera's look (X) goes down, a lidar's sweep axis (Z) leans forward so the sweep's front goes down. */
function tilted(frame: Mat, tilt: number): Mat {
  const a = (tilt * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const x = frame.slice(0, 3) as Vec3;
  const z = frame.slice(6, 9) as Vec3;
  return [...x.map((v, i) => v * c - z[i] * s), frame[3], frame[4], frame[5], ...z.map((v, i) => v * c + x[i] * s), frame[9], frame[10], frame[11]] as Mat;
}

/** `frame` turned about its own X by `roll` degrees: a camera rolled clockwise as seen from behind it. */
function rolled(frame: Mat, roll: number): Mat {
  const a = (roll * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const y = frame.slice(3, 6) as Vec3;
  const z = frame.slice(6, 9) as Vec3;
  return [frame[0], frame[1], frame[2], ...y.map((v, i) => v * c + z[i] * s), ...z.map((v, i) => v * c - y[i] * s), frame[9], frame[10], frame[11]] as Mat;
}

const degrees = (radians: number): number => (Math.abs(radians) < 1e-5 ? 0 : (radians * 180) / Math.PI);

/**
 * Which of the six directions a sensor's frame faces (its X for a camera, its Z for a lidar) once the tilt about
 * its own Y and, for a camera, the roll about its X are taken off; both in degrees, tilt down positive.
 * `faces` is -1 when the frame is turned some other way (a lidar rolled about its sweep, say).
 */
function facingOf(matrix: Mat, along: 'x' | 'z'): { faces: number; tilt: number; roll: number } {
  const look = (along === 'x' ? matrix.slice(0, 3) : matrix.slice(6, 9)) as Vec3;
  const y = matrix.slice(3, 6) as Vec3;
  let best = { faces: -1, tilt: 0, roll: 0 };
  DIRECTIONS.forEach((d, i) => {
    const frame = frameFacing(d.vector, along);
    const y0 = frame.slice(3, 6) as Vec3;
    // The look must lie in the plane the tilt sweeps it through, square to the untilted frame's Y.
    if (Math.abs(dot(look, y0)) > 1e-5) return;
    const tilt = Math.atan2(dot(look, cross(y0, d.vector)), dot(look, d.vector));
    const upright = tilted(frame, (tilt * 180) / Math.PI);
    const roll = Math.atan2(dot(y, upright.slice(6, 9) as Vec3), dot(y, upright.slice(3, 6) as Vec3));
    if (along === 'z' && Math.abs(roll) > 1e-5) return;
    if (best.faces < 0 || Math.abs(tilt) < Math.abs((best.tilt * Math.PI) / 180)) best = { faces: i, tilt: degrees(tilt), roll: degrees(roll) };
  });
  return best;
}

/** A frame whose X (a camera's look) or Z (a lidar's sweep axis) points along `dir`, the rest kept as upright as can be. */
function frameFacing(dir: Vec3, along: 'x' | 'z'): Mat {
  if (along === 'x') {
    const up: Vec3 = Math.abs(dir[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    const y = cross(up, dir);
    const n = Math.hypot(...y) || 1;
    const yn = y.map((v) => v / n) as Vec3;
    const z = cross(dir, yn);
    return [...dir, ...yn, ...z, 0, 0, 0] as Mat;
  }
  const ref: Vec3 = Math.abs(dir[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const y = cross(dir, ref);
  const n = Math.hypot(...y) || 1;
  const yn = y.map((v) => v / n) as Vec3;
  const x = cross(yn, dir);
  return [...x, ...yn, ...dir, 0, 0, 0] as Mat;
}

function SensorPanel({ sensor }: { sensor: RobotSensor }) {
  const { nodes, problems } = useRobot();
  const picking = useEditor((s) => s.jointPick);
  const working = useEditor((s) => s.prefs.units);
  const link = nodes.find((n) => n.id === sensor.link);
  const placed = link ? sensorInDesign(sensor, link) : null;
  const own = problems.filter((q) => q.sensor === sensor.id);
  const kind = SENSOR_KINDS.find((k) => k.id === sensor.kind)!;
  const camera = sensor.kind === 'camera' || sensor.kind === 'depth';
  const turned = sensor.kind !== 'touch';
  const along = camera ? 'x' : 'z';
  const { faces, tilt, roll } = placed ? facingOf(placed.matrix, along) : { faces: 0, tilt: 0, roll: 0 };
  // A tilt tips a level camera's view down, or an upright lidar's sweep down at its front; a roll turns a camera about its look.
  const tiltable = (dir: Vec3) => (camera ? dir[2] === 0 : sensor.kind === 'lidar' && dir[2] !== 0);
  const turn = (dir: Vec3, tiltBy: number, rollBy: number) => rolled(tilted(frameFacing(dir, along), tiltable(dir) ? tiltBy : 0), camera ? rollBy : 0);
  const put = (origin: Vec3, matrix: Mat, merge?: string) => placeSensor(sensor.id, origin, matrix, merge);
  const row = (label: string, content: ReactNode, help?: string) => (
    <div className="field inline">
      <label>
        {label}
        {help && <Hint text={help} />}
      </label>
      {content}
    </div>
  );
  const setCamera = (patch: Partial<RobotSensor['camera']>, merge?: string) => updateSensor(sensor.id, { camera: { ...sensor.camera, ...patch } }, merge);
  const setLidar = (patch: Partial<RobotSensor['lidar']>, merge?: string) => updateSensor(sensor.id, { lidar: { ...sensor.lidar, ...patch } }, merge);
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <TextField className="name-input" value={sensor.name} label={tr('Sensor name')} onCommit={(name) => updateSensor(sensor.id, { name })} />
          <p>{tr('{kind} on {link}', { kind: marked(kind.name), link: link?.name ?? '?' })}</p>
        </div>
        <button type="button" className="icon-button" title={tr('Delete this sensor ({key})', { key: 'Delete' })} aria-label={tr('Delete sensor')} onClick={() => deleteSensor(sensor.id)}>
          <TrashIcon />
        </button>
      </header>
      <fieldset className="group">
        <legend>{tr('Sensor')}</legend>
        {row(tr('Kind'), <Select value={sensor.kind} label={tr('Kind')} options={SENSOR_KINDS.map((k) => ({ value: k.id, label: marked(k.name) }))} onChange={(id) => updateSensor(sensor.id, { kind: id })} />, kind.help)}
        {row(tr('On link'), <Select value={sensor.link} label={tr('Link')} options={nodes.map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => updateSensor(sensor.id, { link: id })} />)}
        {row(tr('Rate'), <NumberBox label={tr('Rate')} value={sensor.rate} unit="Hz" min={0.1} max={1000} step={5} places={1} onChange={(v) => updateSensor(sensor.id, { rate: v }, 'sensor-rate')} />, tr('How many readings a second.'))}
      </fieldset>
      <fieldset className="group">
        <legend>{trx('where it sits', 'Place')}</legend>
        <div className="field">
          <button type="button" className={picking ? 'chip pick on' : 'chip pick'} aria-pressed={Boolean(picking)} title={tr('Shows points on the link; click one to put the sensor there.')} onClick={() => (picking ? stopJointPick() : startJointPick())}>
            <PinIcon />
            {picking ? tr('Click a point on the plate…') : tr('Pick a point on the plate')}
          </button>
        </div>
        {placed && (
          <>
            <div className="field">
              <label>
                {tr('Origin')}
                <Hint text={tr("Where the sensor sits, in the design's coordinates ({unit}).", { unit: unitName(working) })} />
              </label>
              <div className="number-row spread">
                {(['X', 'Y', 'Z'] as const).map((tag, i) => (
                  <NumberBox key={tag} label={tr('Origin {axis}', { axis: tag })} tag={tag} value={Number(placed.origin[i].toFixed(3))} length step={1} places={2} onChange={(v) => put(placed.origin.map((x, k) => (k === i ? v : x)) as Vec3, placed.matrix, 'sensor-origin')} />
                ))}
              </div>
            </div>
            {turned && (
              <div className="field">
                <label>
                  {camera ? tr('Looks along') : sensor.kind === 'lidar' ? tr('Sweeps about') : tr('Up axis')}
                  <Hint text={camera ? tr("The camera's line of sight, in the design's axes.") : sensor.kind === 'lidar' ? tr('The axis the scan turns about: up, for a scan of the floor plan.') : tr("The IMU's Z, in the design's axes.")} />
                </label>
                <div className="segmented small" role="radiogroup" aria-label={tr('Direction')}>
                  {DIRECTIONS.map((d, i) => (
                    <button key={d.label} type="button" role="radio" aria-checked={faces === i} className={faces === i ? 'on' : ''} onClick={() => put(placed.origin, turn(d.vector, tilt, roll))}>
                      {d.label}
                    </button>
                  ))}
                </div>
                {faces < 0 && <p className="export-note">{tr("{angles}° (set by the link's turn)", { angles: eulerOf(placed.matrix).map((v) => formatNumber(v, 1)).join(', ') })}</p>}
              </div>
            )}
            {faces >= 0 &&
              tiltable(DIRECTIONS[faces].vector) &&
              row(
                tr('Tilt'),
                <NumberBox label={tr('Tilt')} value={Number(tilt.toFixed(3))} unit="°" min={-90} max={90} step={5} places={1} onChange={(v) => put(placed.origin, turn(DIRECTIONS[faces].vector, v, roll), 'sensor-tilt')} />,
                camera ? tr('Tips the view down from level; negative looks up.') : tr('Tips the front of the sweep down; negative tips it up.'),
              )}
            {faces >= 0 &&
              camera &&
              row(tr('Roll'), <NumberBox label={tr('Roll')} value={Number(roll.toFixed(3))} unit="°" min={-180} max={180} step={5} places={1} onChange={(v) => put(placed.origin, turn(DIRECTIONS[faces].vector, tilt, v), 'sensor-roll')} />, tr('Turns the camera about its line of sight, clockwise seen from behind; 180 for one mounted upside down.'))}
          </>
        )}
      </fieldset>
      {camera && (
        <fieldset className="group">
          <legend>{tr('Picture')}</legend>
          {row(tr('Field of view'), <NumberBox label={tr('Field of view')} value={sensor.camera.hfov} unit="°" min={1} max={179} step={5} places={1} onChange={(v) => setCamera({ hfov: v }, 'cam-fov')} />, tr('Horizontal, in degrees.'))}
          {row(tr('Width'), <NumberBox label={tr('Width')} value={sensor.camera.width} unit="px" min={1} max={8192} step={16} integer onChange={(v) => setCamera({ width: v }, 'cam-w')} />)}
          {row(tr('Height'), <NumberBox label={tr('Height')} value={sensor.camera.height} unit="px" min={1} max={8192} step={16} integer onChange={(v) => setCamera({ height: v }, 'cam-h')} />)}
          {row(tr('Nearest'), <NumberBox label={tr('Nearest')} value={sensor.camera.near} unit="mm" length min={1} step={10} places={0} onChange={(v) => setCamera({ near: v }, 'cam-near')} />, tr('Closer than this is not seen.'))}
          {row(tr('Farthest'), <NumberBox label={tr('Farthest')} value={sensor.camera.far} unit="mm" length min={2} step={1000} places={0} onChange={(v) => setCamera({ far: v }, 'cam-far')} />, tr('Farther than this is not seen.'))}
        </fieldset>
      )}
      {sensor.kind === 'lidar' && (
        <fieldset className="group">
          <legend>{tr('Scan')}</legend>
          {row(tr('Rays'), <NumberBox label={tr('Rays')} value={sensor.lidar.samples} min={2} max={7200} step={10} integer onChange={(v) => setLidar({ samples: v }, 'lidar-n')} />, tr('Readings per sweep.'))}
          {row(trx('lidar', 'Sweep'), <NumberBox label={trx('lidar', 'Sweep')} value={sensor.lidar.hfov} unit="°" min={1} max={360} step={10} places={1} onChange={(v) => setLidar({ hfov: v }, 'lidar-fov')} />, tr('How wide the sweep is, centered on the X axis.'))}
          {row(tr('Nearest'), <NumberBox label={tr('Nearest range')} value={sensor.lidar.min} unit="mm" length min={1} step={10} places={0} onChange={(v) => setLidar({ min: v }, 'lidar-min')} />)}
          {row(tr('Farthest'), <NumberBox label={tr('Farthest range')} value={sensor.lidar.max} unit="mm" length min={2} step={1000} places={0} onChange={(v) => setLidar({ max: v }, 'lidar-max')} />)}
        </fieldset>
      )}
      {own.length > 0 && (
        <fieldset className="group">
          <legend>{tr('Checks')}</legend>
          <Problems problems={own} />
        </fieldset>
      )}
    </>
  );
}

export function RobotInspector() {
  const scene = useEditor((s) => s.doc.scene);
  const selection = useEditor((s) => s.selection);
  const jointId = useEditor((s) => s.joint);
  const joint = useEditor((s) => s.doc.robot?.joints.find((j) => j.id === jointId));
  const sensorId = useEditor((s) => s.sensor);
  const sensor = useEditor((s) => s.doc.robot?.sensors.find((x) => x.id === sensorId));
  if (joint) return <JointPanel joint={joint} />;
  if (sensor) return <SensorPanel sensor={sensor} />;
  const nodes = scene.filter((n) => selection.includes(n.id));
  if (nodes.length === 1) {
    const node = nodes[0];
    if (node.hidden || node.hole || node.type === 'picture') {
      return (
        <header className="params-head">
          <div className="grow">
            <NameField node={node} />
            <p>{node.hidden ? tr('Hidden objects are not links.') : node.hole ? tr('A hole at the top level cuts nothing, so it is not a link.') : tr('A picture is not a link.')}</p>
          </div>
        </header>
      );
    }
    return <LinkPanel node={node} />;
  }
  if (nodes.length > 1) {
    return (
      <header className="params-head">
        <div className="grow">
          <h1>{plural(nodes.length, '{n} object', '{n} objects')}</h1>
          <p>{tr('Select one link at a time to set it up.')}</p>
        </div>
      </header>
    );
  }
  return <Overview />;
}
