// The left panel in Robot mode: the robot's links as a tree hanging from the
// base, each joint between a link and the one below it, and the objects no
// joint has reached yet; at the foot, what stands in the way of an export and
// the button that makes one.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import { checkRobot } from '../robot/check';
import { linkNodes, robotOf, spanningTree } from '../robot/model';
import type { RobotJoint, RobotSensor } from '../robot/types';
import { massProps } from '../state/massProps';
import { exportRobot, leaveRobotMode, select, selectJoint, selectSensor, setPrefs, useEditor } from '../state/store';
import { ChevronIcon, CloseIcon, DownloadIcon, JointIcon, SensorIcon, WarningIcon } from './icons';
import { Popover } from './Popover';

/** What the panels in Robot mode share: the links, the tree from the base, and what the checks found. */
export function useRobot() {
  const doc = useEditor((s) => s.doc);
  useSyncExternalStore(massProps.subscribe, massProps.getRevision);
  const robot = robotOf(doc);
  const nodes = useMemo(() => linkNodes(doc.scene), [doc.scene]);
  // The kernel weighs whatever has not been weighed yet, once it holds still.
  useEffect(() => massProps.ensure(nodes, doc.assets), [nodes, doc.assets]);
  const tree = useMemo(() => spanningTree(robot, nodes.map((n) => n.id)), [robot, nodes]);
  const props = massProps.known(nodes);
  const problems = checkRobot(doc, props, robot);
  return { doc, robot, nodes, tree, props, problems };
}

export function RobotPanel() {
  const { robot, nodes, tree } = useRobot();
  const selection = useEditor((s) => s.selection);
  const joint = useEditor((s) => s.joint);
  const sensor = useEditor((s) => s.sensor);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const linkRow = (node: SceneNode, depth: number, after?: ReactNode, under?: string) => {
    const on = selection.length === 1 && selection[0] === node.id;
    return (
      <li key={under ? `l:${node.id}:${under}` : `l:${node.id}`} role="none">
        <div
          className={on ? 'outline-row on' : 'outline-row'}
          style={{ paddingLeft: 8 + depth * 14 }}
          tabIndex={0}
          role="treeitem"
          aria-selected={on}
          aria-level={depth + 1}
          onClick={() => select([node.id])}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              select([node.id]);
            }
          }}
        >
          <span className="dot" style={{ background: node.color, borderColor: node.hole ? HOLE_COLOR : undefined }} />
          <span className="clip">{node.name}</span>
          <span className="outline-kind">{node.id === robot.root ? 'Base' : after}</span>
        </div>
      </li>
    );
  };
  const jointRow = (j: RobotJoint, depth: number, loop: boolean) => {
    const on = joint === j.id;
    return (
      <li key={`j:${j.id}`} role="none">
        <div
          className={['outline-row joint', on ? 'on' : ''].join(' ')}
          style={{ paddingLeft: 8 + depth * 14 }}
          tabIndex={0}
          role="treeitem"
          aria-selected={on}
          aria-level={depth + 1}
          onClick={() => selectJoint(j.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectJoint(j.id);
            }
          }}
        >
          <JointIcon />
          <span className="clip">{j.name}</span>
          <span className="outline-kind">{loop ? 'Loop' : j.type}</span>
        </div>
      </li>
    );
  };
  const sensorRow = (x: RobotSensor, depth: number) => {
    const on = sensor === x.id;
    return (
      <li key={`s:${x.id}`} role="none">
        <div
          className={['outline-row joint', on ? 'on' : ''].join(' ')}
          style={{ paddingLeft: 8 + depth * 14 }}
          tabIndex={0}
          role="treeitem"
          aria-selected={on}
          aria-level={depth + 1}
          onClick={() => selectSensor(x.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectSensor(x.id);
            }
          }}
        >
          <SensorIcon />
          <span className="clip">{x.name}</span>
          <span className="outline-kind">{x.kind === 'imu' ? 'IMU' : x.kind}</span>
        </div>
      </li>
    );
  };
  /** A link, its sensors, then every joint hanging from it with the link below each, down the tree. */
  const branch = (id: string, depth: number): ReactNode[] => {
    const node = byId.get(id);
    if (!node) return [];
    const rows: ReactNode[] = [linkRow(node, depth), ...robot.sensors.filter((x) => x.link === id).map((x) => sensorRow(x, depth + 1))];
    for (const j of robot.joints) {
      if (j.parent !== id || !byId.has(j.child)) continue;
      if (tree.parentJoint.get(j.child) === j) rows.push(jointRow(j, depth + 1, false), ...branch(j.child, depth + 2));
      else rows.push(jointRow(j, depth + 1, true), linkRow(byId.get(j.child)!, depth + 2, 'Above', j.id));
    }
    return rows;
  };

  const rooted = robot.root !== null && byId.has(robot.root);
  const loose = tree.unreached.map((id) => byId.get(id)!).filter(Boolean);
  return (
    <div className="structure-tab robot-panel">
      <div className="structure-scroll">
        <h2 title="The links hang from the base by their joints. Pick one to set it up on the right.">
          Robot
          <span className="count">{nodes.length ? `${nodes.length} link${nodes.length === 1 ? '' : 's'}, ${robot.joints.length} joint${robot.joints.length === 1 ? '' : 's'}` : ''}</span>
        </h2>
        {nodes.length === 0 ? (
          <p className="empty">Every object in the design is a link. Leave Robot mode to add some.</p>
        ) : !rooted ? (
          <p className="empty">Select the object the rest of the robot hangs from and make it the base link.</p>
        ) : (
          <ul className="outline" role="tree" aria-label="Robot tree">
            {branch(robot.root!, 0)}
          </ul>
        )}
        {loose.length > 0 && rooted && (
          <>
            <h2 title="Objects no chain of joints reaches from the base: select one and attach it to a link.">Not attached</h2>
            <ul className="outline" role="tree" aria-label="Unattached links">
              {loose.map((n) => linkRow(n, 0))}
            </ul>
          </>
        )}
        {!rooted && nodes.length > 0 && (
          <ul className="outline" role="tree" aria-label="Links">
            {nodes.map((n) => linkRow(n, 0))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** At the foot of the left panel in Robot mode: what the checks say, and the export. */
const ROBOT_FORMATS: { id: 'urdf' | 'sdf' | 'mjcf'; label: string; description: string }[] = [
  { id: 'urdf', label: 'ROS 2 package', description: 'URDF and xacro with meshes, launch files, bridge and controllers' },
  { id: 'sdf', label: 'Gazebo model', description: 'SDF with every joint, loops included, and a world' },
  { id: 'mjcf', label: 'MuJoCo model', description: 'MJCF with actuators, loops as constraints' },
];

export function RobotExport() {
  const { problems, nodes } = useRobot();
  const busy = useEditor((s) => s.busy);
  const format = useEditor((s) => s.prefs.robotFormat);
  const active = ROBOT_FORMATS.find((f) => f.id === format) ?? ROBOT_FORMATS[0];
  const errors = problems.filter((p) => p.level === 'error').length;
  const warnings = problems.length - errors;
  const status = errors ? `${errors} problem${errors === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : nodes.length ? 'Ready to export' : 'Nothing to export yet';
  return (
    <div className="summary">
      <section className="export" aria-label="Export robot">
        <div className="export-row">
          <span className="export-label">Format</span>
          <Popover
            className="select-button"
            title="What the robot is written as"
            align="left"
            side="up"
            fill
            button={
              <>
                <span>{active.label}</span>
                <ChevronIcon />
              </>
            }
          >
            {(close) => (
              <div className="menu" role="listbox" aria-label="Robot format">
                {ROBOT_FORMATS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    aria-selected={f.id === format}
                    className={f.id === format ? 'menu-item format on' : 'menu-item format'}
                    onClick={() => {
                      close();
                      setPrefs({ robotFormat: f.id });
                    }}
                  >
                    <span>{f.label}</span>
                    <small>{f.description}</small>
                  </button>
                ))}
              </div>
            )}
          </Popover>
        </div>
        <button type="button" className={errors ? 'export-note problems error' : warnings ? 'export-note problems warn' : 'export-note problems'} title="Shows the list" onClick={() => select([])}>
          {problems.length > 0 && <WarningIcon />}
          <span className="clip">{status}</span>
        </button>
        <button type="button" className="primary" disabled={Boolean(busy) || errors > 0 || nodes.length === 0} onClick={() => void exportRobot()}>
          <DownloadIcon />
          {busy ? 'Exporting…' : format === 'urdf' ? 'Export package' : 'Export model'}
        </button>
      </section>
    </div>
  );
}

/** The row over the left panel in Robot mode, in place of the tabs. */
export function RobotModeBar() {
  const picking = useEditor((s) => s.jointPick);
  return (
    <div className="tabs robot-bar">
      <div className="page-tabs">
        <span className="robot-mode-title">{picking ? 'Click a point on the plate' : 'Robot mode'}</span>
        <button type="button" className="icon-button" title="Leave Robot mode" aria-label="Leave Robot mode" onClick={leaveRobotMode}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
