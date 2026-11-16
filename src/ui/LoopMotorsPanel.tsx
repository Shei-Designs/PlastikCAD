import { tr } from '../i18n';
import { robotOf } from '../robot/model';
import { cancelLoopMotors, confirmLoopMotors, getState, loopMotorsFault, toggleLoopMotor, useEditor } from '../state/store';

/**
 * Asked before an export or a test drive of a robot with a loop nobody has said the motors of: which of the
 * loop's joints a motor moves. The plate shows those joints alone, and a click on one there picks it as a row
 * here does. OK makes the others passive and lets what was asked for go ahead, No motor makes them all passive; Cancel and Escape drop both.
 */
export function LoopMotorsPanel() {
  const asked = useEditor((s) => s.loopMotors);
  const doc = useEditor((s) => s.doc);
  if (!asked) return null;
  const joints = robotOf(doc).joints.filter((j) => asked.joints.includes(j.id));
  const fault = loopMotorsFault({ ...getState(), loopMotors: asked, doc });
  return (
    <div className="mate-panel loop-panel" role="dialog" aria-label={tr('Which joint has the motor?')}>
      <div className="array-title">{tr('Which joint has the motor?')}</div>
      <p className="field-note">{tr('Click each joint a motor moves, here or on the plate. The linkage moves the others.')}</p>
      <ul className="loop-joints">
        {joints.map((j) => {
          const on = asked.motors.includes(j.id);
          return (
            <li key={j.id}>
              <button type="button" className={on ? 'chip on' : 'chip'} aria-pressed={on} onClick={() => toggleLoopMotor(j.id)}>
                <span className="clip">{j.name}</span>
                <span className="loop-kind">{on ? tr('Motor') : tr('Passive')}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {fault?.kind === 'all' && <p className="field-note warn">{tr('Leave a joint of each loop without a motor.')}</p>}
      {fault?.kind === 'closes' && <p className="field-note warn">{tr('{name}: the loop has to close here, so it cannot have the motor. Pick another joint.', { name: fault.name })}</p>}
      <div className="array-foot">
        <button type="button" className="chip" title={tr('No motor moves these joints: they swing free')} onClick={() => confirmLoopMotors(true)}>
          {tr('No motor')}
        </button>
        <span />
        <button type="button" className="chip" onClick={cancelLoopMotors}>
          {tr('Cancel')}
        </button>
        <button type="button" className="primary" disabled={fault !== null} onClick={() => confirmLoopMotors()}>
          {tr('OK')}
        </button>
      </div>
    </div>
  );
}
