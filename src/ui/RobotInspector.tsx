// The right panel in Robot mode: the robot itself while nothing is picked
// (name, base link, what the checks found), a link's mass and collision
// settings, or a joint's kind, place, axis and limits.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { boundsCenter } from '../model/math';
import type { SceneNode, Vec3 } from '../model/types';
import { geometry } from '../state/geometry';
import { massOf, principalMoments, tensorOf } from '../robot/inertia';
import { MATERIALS, materialOf } from '../robot/materials';
import { jointInDesign, linkOf } from '../robot/model';
import { COLLISION_KINDS, JOINT_TYPES } from '../robot/types';
import type { RobotJoint, RobotLink } from '../robot/types';
import type { Problem } from '../robot/check';
import { addJoint, deleteJoint, fitJointFollowers, placeJoint, select, selectJoint, setPose, setRobotName, setRobotRoot, startJointPick, stopJointPick, updateJoint, updateLink, useEditor } from '../state/store';
import { rangeOf } from '../robot/kinematics';
import { formatNumber, NumberBox, selectOnFocus, SliderField } from './Fields';
import { Hint } from './Hint';
import { ChevronIcon, JointIcon, PinIcon, TrashIcon, WarningIcon } from './icons';
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
  if (problems.length === 0) return <p className="empty">Nothing stands in the way of an export.</p>;
  return (
    <ul className="problems">
      {problems.map((p, i) => (
        <li key={i} className={p.level === 'error' ? 'problem error' : 'problem warn'}>
          <WarningIcon />
          <span>{p.text}</span>
          {(p.link || p.joint) && (
            <button type="button" className="chip" onClick={() => (p.joint ? selectJoint(p.joint) : select([p.link!]))}>
              Show
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Overview() {
  const { robot, nodes, props, problems } = useRobot();
  const total = nodes.reduce((sum, n) => {
    const p = props.get(n.id);
    return p ? sum + massOf(linkOf(robot, n.id).mass, p) : sum;
  }, 0);
  const weighed = nodes.every((n) => props.has(n.id));
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <TextField className="name-input" value={robot.name} label="Robot name" onCommit={setRobotName} />
          <p>{nodes.length ? 'Pick a link or a joint on the left to set it up.' : 'Every object in the design is a link.'}</p>
        </div>
      </header>
      <fieldset className="group">
        <legend>Robot</legend>
        <div className="field">
          <label>
            Base link
            <Hint text="The link the rest hangs from: a body, a chassis, a mounting plate." />
          </label>
          <Select value={robot.root ?? ''} label="Base link" placeholder="Choose an object…" options={nodes.map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => setRobotRoot(id)} />
        </div>
        <dl className="facts">
          <div>
            <dt>Links</dt>
            <dd>{nodes.length}</dd>
          </div>
          <div>
            <dt>Joints</dt>
            <dd>{robot.joints.length}</dd>
          </div>
          <div>
            <dt>Mass</dt>
            <dd>{nodes.length === 0 ? '–' : `${weighed ? '' : '≥ '}${grams(total)}`}</dd>
          </div>
        </dl>
      </fieldset>
      <fieldset className="group">
        <legend>Checks</legend>
        <Problems problems={problems} />
      </fieldset>
    </>
  );
}

const grams = (g: number): string => (g >= 1000 ? `${formatNumber(g / 1000, 3)} kg` : `${formatNumber(g, g < 10 ? 2 : 1)} g`);
const cm3 = (mm3: number): string => `${formatNumber(mm3 / 1000, mm3 < 10000 ? 2 : 1)} cm³`;
/** g·mm² shown in g·cm², the size robot parts come in. */
const inertia = (gmm2: number): string => formatNumber(gmm2 / 100, gmm2 / 100 < 10 ? 3 : 1);

function LinkPanel({ node }: { node: SceneNode }) {
  const { robot, nodes, props, problems } = useRobot();
  const link = linkOf(robot, node.id);
  const p = props.get(node.id);
  const mass = p ? massOf(link.mass, p) : null;
  const material = link.mass.kind === 'material' ? materialOf(link.mass.material) : null;
  const own = problems.filter((q) => q.link === node.id);
  const others = nodes.filter((n) => n.id !== node.id);
  const joints = robot.joints.filter((j) => j.parent === node.id || j.child === node.id);
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? '?';
  const set = (patch: Partial<Omit<RobotLink, 'node'>>, merge?: string) => updateLink(node.id, patch, merge);
  const setMass = (patch: Record<string, unknown>, merge?: string) => set({ mass: { ...link.mass, ...patch } as RobotLink['mass'] }, merge);
  return (
    <>
      <header className="params-head">
        <div className="grow">
          <NameField node={node} />
          <p>{node.id === robot.root ? 'Base link' : `Link${link.name ? ` · ${link.name}` : ''}`}</p>
        </div>
        {node.id !== robot.root && (
          <button type="button" className="chip" title="Makes this the link the rest of the robot hangs from" onClick={() => setRobotRoot(node.id)}>
            Make base
          </button>
        )}
      </header>
      <fieldset className="group">
        <legend>Mass</legend>
        <div className="field">
          <div className="segmented" role="radiogroup" aria-label="How the mass is known">
            <button type="button" role="radio" aria-checked={link.mass.kind === 'material'} className={link.mass.kind === 'material' ? 'on' : ''} title="Figures the mass from the shape and what it is made of" onClick={() => link.mass.kind !== 'material' && set({ mass: { kind: 'material', material: 'pla', infill: 20, shell: 1.2 } })}>
              From material
            </button>
            <button type="button" role="radio" aria-checked={link.mass.kind === 'measured'} className={link.mass.kind === 'measured' ? 'on' : ''} title="A mass you weighed or read off a datasheet" onClick={() => link.mass.kind !== 'measured' && set({ mass: { kind: 'measured', grams: mass && mass > 0 ? Number(mass.toFixed(1)) : 10 } })}>
              Weighed
            </button>
          </div>
        </div>
        {link.mass.kind === 'measured' ? (
          <div className="field inline">
            <label>Mass</label>
            <NumberBox label="Mass" value={link.mass.grams} unit="g" min={0} step={1} places={2} onChange={(v) => setMass({ grams: v }, 'link-mass')} />
          </div>
        ) : (
          <>
            <div className="field inline">
              <label>Material</label>
              <Select value={link.mass.material} label="Material" options={MATERIALS.map((m) => ({ value: m.id, label: m.name }))} onChange={(id) => setMass({ material: id })} />
            </div>
            {material?.printed && (
              <>
                <SliderField label="Infill" help="How full the inside is printed; the shell stays solid." value={link.mass.infill} min={0} max={100} step={5} unit="%" onChange={(v) => setMass({ infill: v }, 'link-infill')} />
                <div className="field inline">
                  <label>
                    Shell
                    <Hint text="Walls plus top and bottom layers, as one thickness." />
                  </label>
                  <NumberBox label="Shell thickness" value={link.mass.shell} unit="mm" min={0} max={20} step={0.4} places={2} onChange={(v) => setMass({ shell: v }, 'link-shell')} />
                </div>
              </>
            )}
          </>
        )}
        <dl className="facts">
          <div>
            <dt>Volume</dt>
            <dd>{p ? cm3(p.volume) : '…'}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{p ? `${formatNumber(p.area / 100, 1)} cm²` : '…'}</dd>
          </div>
          <div>
            <dt>Mass</dt>
            <dd>{mass === null ? '…' : grams(mass)}</dd>
          </div>
          <div>
            <dt>Center of mass</dt>
            <dd>{p ? p.centroid.map((v) => formatNumber(v, 1)).join(', ') : '…'}</dd>
          </div>
          <div>
            <dt title="Principal moments of inertia, g·cm²">Inertia</dt>
            <dd>
              {p && mass
                ? principalMoments(tensorOf(mass, p.unit))
                    .sort((a, b) => b - a)
                    .map(inertia)
                    .join(' · ') + ' g·cm²'
                : '…'}
            </dd>
          </div>
        </dl>
      </fieldset>
      <fieldset className="group">
        <legend>Collision</legend>
        <div className="field inline">
          <label>
            Shape
            <Hint text={COLLISION_KINDS.find((k) => k.id === link.collision)?.help ?? ''} />
          </label>
          <Select value={link.collision} label="Collision shape" options={COLLISION_KINDS.map((k) => ({ value: k.id, label: k.name }))} onChange={(id) => set({ collision: id })} />
        </div>
        <div className="field inline">
          <label>
            Friction
            <Hint text="Coefficient of friction against what it touches; rubber on floor is about 1, plastic on plastic 0.3." />
          </label>
          <NumberBox label="Friction" value={link.friction} min={0} max={5} step={0.1} places={2} onChange={(v) => set({ friction: v }, 'link-friction')} />
        </div>
      </fieldset>
      <fieldset className="group">
        <legend>Joints</legend>
        {joints.length > 0 && (
          <ul className="joint-list">
            {joints.map((j) => (
              <li key={j.id}>
                <button type="button" className="outline-row joint" onClick={() => selectJoint(j.id)}>
                  <JointIcon />
                  <span className="clip">{j.name}</span>
                  <span className="outline-kind">{j.child === node.id ? `from ${nameOf(j.parent)}` : `to ${nameOf(j.child)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 ? (
          <div className="field inline">
            <label>
              Attach to
              <Hint text="Hangs this link from another by a new joint." />
            </label>
            <Select value="" label="Attach to" placeholder="Choose a link…" options={others.map((n) => ({ value: n.id, label: n.name }))} onChange={(parent) => addJoint(parent, node.id)} />
          </div>
        ) : (
          <p className="empty">Add another object to have something to attach to.</p>
        )}
      </fieldset>
      {own.length > 0 && (
        <fieldset className="group">
          <legend>Checks</legend>
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
  const centerOf = (node: SceneNode | undefined) => (node ? boundsCenter(geometry.bounds(node)) : null);
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
          <TextField className="name-input" value={joint.name} label="Joint name" onCommit={(name) => updateJoint(joint.id, { name })} />
          <p>
            {parent?.name ?? '?'} → {child?.name ?? '?'}
          </p>
        </div>
        <button type="button" className="icon-button" title="Delete this joint (Delete)" aria-label="Delete joint" onClick={() => deleteJoint(joint.id)}>
          <TrashIcon />
        </button>
      </header>
      <fieldset className="group">
        <legend>Joint</legend>
        <div className="field">
          <div className="segmented small" role="radiogroup" aria-label="Joint type">
            {JOINT_TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={joint.type === t.id} className={joint.type === t.id ? 'on' : ''} title={t.help} onClick={() => updateJoint(joint.id, { type: t.id })}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
        {row('Parent', <Select value={joint.parent} label="Parent link" options={nodes.filter((n) => n.id !== joint.child).map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => updateJoint(joint.id, { parent: id })} />)}
        {row('Child', <Select value={joint.child} label="Child link" options={nodes.filter((n) => n.id !== joint.parent).map((n) => ({ value: n.id, label: n.name }))} onChange={(id) => updateJoint(joint.id, { child: id })} />, 'The link that moves. The joint is kept with it: move the child and the joint comes along.')}
      </fieldset>
      <fieldset className="group">
        <legend>Place</legend>
        <div className="field">
          <button type="button" className={picking ? 'chip pick on' : 'chip pick'} aria-pressed={picking} title="Shows points on both links; click one to put the joint there. The end of a round shape gives its axis too." onClick={() => (picking ? stopJointPick() : startJointPick())}>
            <PinIcon />
            {picking ? 'Click a point on the plate…' : 'Pick a point on the plate'}
          </button>
        </div>
        <div className="field">
          <label>
            Origin
            <Hint text="Where the joint sits, in the design's coordinates (mm)." />
          </label>
          <div className="number-row spread">
            {(['X', 'Y', 'Z'] as const).map((tag, i) => (
              <NumberBox key={tag} label={`Origin ${tag}`} tag={tag} value={Number(placed.origin[i].toFixed(3))} step={1} places={2} onChange={(v) => put(placed.origin.map((x, k) => (k === i ? v : x)) as Vec3, placed.axis, 'joint-origin')} />
            ))}
          </div>
          <div className="chip-row">
            <button type="button" className="chip" title="Puts the joint at the center of the child" onClick={() => centerOf(child) && put(centerOf(child)!, placed.axis)}>
              Child center
            </button>
            <button type="button" className="chip" title="Puts the joint at the center of the parent" onClick={() => centerOf(parent) && put(centerOf(parent)!, placed.axis)}>
              Parent center
            </button>
          </div>
        </div>
        {joint.type !== 'fixed' && (
          <div className="field">
            <label>
              Axis
              <Hint text="The line it turns about or slides along, in the design's coordinates." />
            </label>
            <div className="axis-row">
              <div className="segmented small" role="radiogroup" aria-label="Axis">
                {AXES.map((a, i) => (
                  <button key={a.label} type="button" role="radio" aria-checked={along === i} className={along === i ? 'on' : ''} onClick={() => put(placed.origin, flipped ? (a.vector.map((x) => -x) as Vec3) : a.vector)}>
                    {a.label}
                  </button>
                ))}
              </div>
              <button type="button" className={flipped ? 'chip on' : 'chip'} aria-pressed={flipped} title="Turns the axis the other way, so positive motion goes the other way" onClick={() => put(placed.origin, placed.axis.map((x) => -x) as Vec3)}>
                Flip
              </button>
            </div>
            {along < 0 && <p className="export-note">{placed.axis.map((v) => formatNumber(v, 3)).join(', ')} (set by the child's turn)</p>}
          </div>
        )}
      </fieldset>
      {joint.type !== 'fixed' && (
        <fieldset className="group">
          <legend>
            Try it
            {pose?.joint === joint.id && (
              <button type="button" className="chip" title="Puts the robot back" onClick={() => setPose(null)}>
                Reset
              </button>
            )}
          </legend>
          <SliderField label={angular ? 'Angle' : 'Travel'} help="Moves the joint on the plate to see the robot move; the design stays as it is." value={posed} min={lo} max={hi} step={angular ? 1 : 0.5} unit={unit} onChange={(v) => setPose(v)} />
          {pose?.joint === joint.id && !pose.solved.closed && <p className="export-note problems warn">The linkage cannot close here: a loop joint is {formatNumber(pose.solved.error, 1)} mm apart.</p>}
          {inLoop && (
            <div className="field">
              <button type="button" className="chip" title="Sweeps this joint over its range with the loops closed and sets the passive joints to follow it (mimic), as URDF needs" onClick={() => fitJointFollowers(joint.id)}>
                Set the others to follow this joint
              </button>
            </div>
          )}
        </fieldset>
      )}
      {joint.type !== 'fixed' && (
        <fieldset className="group">
          <legend>Motion</legend>
          {joint.type !== 'continuous' && (
            <>
              {row('Lower limit', <NumberBox label="Lower limit" value={joint.lower} unit={unit} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { lower: v }, 'joint-lower')} />)}
              {row('Upper limit', <NumberBox label="Upper limit" value={joint.upper} unit={unit} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { upper: v }, 'joint-upper')} />)}
            </>
          )}
          {row('Effort', <NumberBox label="Effort" value={joint.effort} unit={angular ? 'N·m' : 'N'} min={0} step={angular ? 0.5 : 5} places={3} onChange={(v) => updateJoint(joint.id, { effort: v }, 'joint-effort')} />, 'The most the actuator can push with: a servo\'s torque, a linear actuator\'s force.')}
          {row('Velocity', <NumberBox label="Velocity" value={joint.velocity} unit={angular ? '°/s' : 'mm/s'} min={0} step={angular ? 10 : 5} places={2} onChange={(v) => updateJoint(joint.id, { velocity: v }, 'joint-velocity')} />, 'The fastest it moves under no load.')}
          {row('Damping', <NumberBox label="Damping" value={joint.damping} unit={angular ? 'N·m·s' : 'N·s/m'} min={0} step={0.1} places={3} onChange={(v) => updateJoint(joint.id, { damping: v }, 'joint-damping')} />, 'Resistance that grows with speed; a little keeps a simulation calm.')}
          {row('Friction', <NumberBox label="Joint friction" value={joint.friction} unit={angular ? 'N·m' : 'N'} min={0} step={0.1} places={3} onChange={(v) => updateJoint(joint.id, { friction: v }, 'joint-friction')} />, 'Resistance that is there at any speed: gearbox drag, seals.')}
          {row(
            'Follows',
            <Select
              value={joint.mimic?.joint ?? ''}
              label="Follows"
              placeholder="Nothing"
              options={robot.joints.filter((j) => j.id !== joint.id).map((j) => ({ value: j.id, label: j.name }))}
              onChange={(id) => updateJoint(joint.id, { mimic: { joint: id, multiplier: joint.mimic?.multiplier ?? 1, offset: joint.mimic?.offset ?? 0 } })}
            />,
            'A passive joint moved by another, as in a linkage: it goes as far as that one times the multiplier, plus the offset.',
          )}
          {joint.mimic && (
            <div className="field">
              <div className="number-row spread">
                <NumberBox label="Multiplier" tag="×" value={joint.mimic.multiplier} step={0.1} places={3} onChange={(v) => updateJoint(joint.id, { mimic: { ...joint.mimic!, multiplier: v } }, 'joint-mimic')} />
                <NumberBox label="Offset" tag="+" value={joint.mimic.offset} unit={unit} step={angular ? 5 : 1} places={2} onChange={(v) => updateJoint(joint.id, { mimic: { ...joint.mimic!, offset: v } }, 'joint-mimic')} />
                <button type="button" className="chip" title="Follows nothing" onClick={() => updateJoint(joint.id, { mimic: undefined })}>
                  Clear
                </button>
              </div>
            </div>
          )}
        </fieldset>
      )}
      {own.length > 0 && (
        <fieldset className="group">
          <legend>Checks</legend>
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
  if (joint) return <JointPanel joint={joint} />;
  const nodes = scene.filter((n) => selection.includes(n.id));
  if (nodes.length === 1) {
    const node = nodes[0];
    if (node.hidden || node.hole || node.type === 'picture') {
      return (
        <header className="params-head">
          <div className="grow">
            <NameField node={node} />
            <p>{node.hidden ? 'Hidden objects are not links.' : node.hole ? 'A hole at the top level cuts nothing, so it is not a link.' : 'A picture is not a link.'}</p>
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
          <h1>{nodes.length} objects</h1>
          <p>Select one link at a time to set it up.</p>
        </div>
      </header>
    );
  }
  return <Overview />;
}
