// The left panel in Robot mode: the robot's links as a tree hanging from the
// base, each joint between a link and the one below it, and the objects no
// joint has reached yet; at the foot, what stands in the way of an export and
// the button that makes one.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { marked, plural, tr, trx } from '../i18n';
import { HOLE_COLOR } from '../model/ops';
import type { SceneNode } from '../model/types';
import { checkRobot } from '../robot/check';
import { EXPORT_FORMATS } from '../robot/export';
import { linkNodes, robotOf, spanningTree } from '../robot/model';
import type { RobotJoint, RobotSensor } from '../robot/types';
import { massProps } from '../state/massProps';
import { exportRobot, fixLooseLinks, importRobotFile, leaveRobotMode, select, selectJoint, selectSensor, setPrefs, useEditor } from '../state/store';
import { ChevronIcon, CloseIcon, DownloadIcon, JointIcon, SensorIcon, WarningIcon } from './icons';
import { Popover } from './Popover';
import { inUnit } from '../units';

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
          <span className="outline-kind">{node.id === robot.root ? tr('Base') : after}</span>
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
          <span className="outline-kind">{loop ? tr('Loop') : marked(j.type)}</span>
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
          <span className="outline-kind">{x.kind === 'imu' ? 'IMU' : marked(x.kind)}</span>
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
      else rows.push(jointRow(j, depth + 1, true), linkRow(byId.get(j.child)!, depth + 2, trx('in the tree', 'Above'), j.id));
    }
    return rows;
  };

  const rooted = robot.root !== null && byId.has(robot.root);
  const loose = tree.unreached.map((id) => byId.get(id)!).filter(Boolean);
  // Counted as the robot: the base and what hangs from it; before a base is chosen, everything.
  const linked = rooted ? nodes.length - loose.length : nodes.length;
  return (
    <div className="structure-tab robot-panel">
      <div className="structure-scroll">
        <h2 title={tr('The links hang from the base by their joints. Pick one to set it up on the right.')}>
          {tr('Robot')}
          <span className="count">{nodes.length ? tr('{links}, {joints}', { links: plural(linked, '{n} link', '{n} links'), joints: plural(robot.joints.length, '{n} joint', '{n} joints') }) : ''}</span>
        </h2>
        {nodes.length === 0 ? (
          <p className="empty">{tr('Every object in the design is a link. Leave Robot mode to add some, or import a URDF.')}</p>
        ) : !rooted ? (
          <p className="empty">{tr('Select the object the rest of the robot hangs from and make it the base link.')}</p>
        ) : (
          <ul className="outline" role="tree" aria-label={tr('Robot tree')}>
            {branch(robot.root!, 0)}
          </ul>
        )}
        {loose.length > 0 && rooted && (
          <>
            <h2 title={tr('Objects no chain of joints reaches from the base. They are left out of the robot: select one and attach it to a link.')}>{tr('Not attached')}</h2>
            <ul className="outline" role="tree" aria-label={tr('Unattached links')}>
              {loose.map((n) => linkRow(n, 0))}
            </ul>
            <div className="structure-actions">
              <button type="button" className="chip" title={tr('Hangs every unattached link from the base by a fixed joint, where the two meet')} onClick={fixLooseLinks}>
                {tr('Fix all to the base')}
              </button>
            </div>
          </>
        )}
        {!rooted && nodes.length > 0 && (
          <ul className="outline" role="tree" aria-label={tr('Links')}>
            {nodes.map((n) => linkRow(n, 0))}
          </ul>
        )}
        <div className="structure-actions">
          <button type="button" className="chip" title={tr('Brings a robot in from a URDF file, with its meshes, as links and joints')} onClick={() => void importRobotFile()}>
            {tr('Import URDF…')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** At the foot of the left panel in Robot mode: what the checks say, and the export. */
export function RobotExport() {
  const { problems, nodes } = useRobot();
  const busy = useEditor((s) => s.busy);
  const format = useEditor((s) => s.prefs.robotFormat);
  const unit = useEditor((s) => s.prefs.units);
  const active = EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0];
  const errors = problems.filter((p) => p.level === 'error').length;
  const warnings = problems.length - errors;
  const toFix = plural(errors, '{n} problem to fix', '{n} problems to fix');
  const warned = plural(warnings, '{n} warning', '{n} warnings');
  const status = errors ? (warnings ? tr('{problems}, {warnings}', { problems: toFix, warnings: warned }) : toFix) : warnings ? warned : nodes.length ? tr('Ready to export') : tr('Nothing to export yet');
  return (
    <div className="summary">
      <section className="export" aria-label={tr('Export robot')}>
        <div className="export-row">
          <span className="export-label">{tr('Format')}</span>
          <Popover
            className="select-button"
            title={tr('What the robot is written as')}
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
              <div className="menu" role="listbox" aria-label={tr('Robot format')}>
                {EXPORT_FORMATS.map((f) => (
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
        {problems.length > 0 ? (
          <button type="button" className={errors ? 'export-note problems error' : 'export-note problems warn'} title={problems.map((p) => inUnit(p.text, unit)).join('\n')} onClick={() => select([])}>
            <WarningIcon />
            <span className="clip">{status}</span>
          </button>
        ) : (
          <p className="export-note">{status}</p>
        )}
        <button type="button" className="primary" disabled={Boolean(busy) || errors > 0 || nodes.length === 0} onClick={() => void exportRobot()}>
          <DownloadIcon />
          {busy ? tr('Exporting…') : format === 'urdf' ? tr('Export package') : format === 'usd' ? tr('Export stage') : tr('Export model')}
        </button>
      </section>
    </div>
  );
}

/** The row over the left panel in Robot mode, in place of the tabs. */
export function RobotModeBar() {
  const picking = useEditor((s) => s.jointPick);
  const all = useEditor((s) => s.prefs.robotMarkers);
  return (
    <div className="tabs robot-bar">
      <div className="page-tabs">
        <span className="robot-mode-title">{picking ? tr('Click a point on the plate') : tr('Robot mode')}</span>
        <div className="robot-bar-actions">
          <button type="button" className={all ? 'icon-button on' : 'icon-button'} aria-pressed={all} title={tr('Shows every joint and sensor on the plate')} onClick={() => setPrefs({ robotMarkers: !all })}>
            <JointIcon />
          </button>
          <button type="button" className="icon-button" title={tr('Leave Robot mode')} aria-label={tr('Leave Robot mode')} onClick={leaveRobotMode}>
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
