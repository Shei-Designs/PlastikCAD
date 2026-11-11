import { useEffect } from 'react';
import { APP_NAME } from './appInfo';
import { tr } from './i18n';
import * as platform from './platform';
import {
  alignSelected,
  alignSelectedOn,
  cancelArray,
  cancelMate,
  cancelPlacing,
  clearMeasure,
  copySelected,
  deleteJoint,
  deleteSelected,
  deleteSensor,
  dismissNotice,
  dropSelected,
  duplicateSelected,
  getState,
  ghostSelected,
  groupSelected,
  importModel,
  isDirty,
  notify,
  mirrorSelected,
  newProject,
  nudgeSelected,
  openProjectFile,
  openProjects,
  paste,
  receiveFiles,
  redo,
  restoreSession,
  rotateSelected,
  saveCopy,
  saveNow,
  saveProject,
  select,
  selectAll,
  selectJoint,
  selectSensor,
  setHole,
  setPrefs,
  stopAligning,
  stopJointPick,
  stopMeasuring,
  toggleAligning,
  toggleMeasuring,
  toggleObjectAxes,
  undo,
  unghostAll,
  ungroupSelected,
  useEditor,
} from './state/store';
import { backOut } from './ui/back';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { narrowWindow } from './state/persist';
import { Inspector } from './ui/Inspector';
import { Projects } from './ui/Projects';
import { Sidebar } from './ui/Sidebar';
import { initInput } from './ui/inputMode';
import { commandFor } from './ui/keymap';
import type { CommandId } from './ui/keymap';
import { AskDialog } from './ui/AskDialog';
import { TouchEntrySheet } from './ui/TouchEntry';
import { commitTyping } from './ui/typing';
import { Viewport, viewerRef } from './ui/Viewport';
import { CloseIcon, WarningIcon } from './ui/icons';

// Inputs that take no typing: clicking one of these must not put the shortcuts to sleep.
const CLICK_INPUTS = new Set(['checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file']);

const typing = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !CLICK_INPUTS.has(target.type);
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
};

/**
 * What a part of the window that failed to draw offers (see ErrorBoundary): load the app again, once
 * whatever is still pending has been written, or save a copy of the design first.
 */
export const crashActions = {
  // Only once what is pending is written: a save that failed has said so, and loading again would drop the edits.
  onReload: (): void => void saveProject().then((saved) => saved && window.location.reload()),
  onSaveCopy: (): void => void saveCopy(),
};

/** Arrow keys move by the snap step; Shift makes it ten times that. */
function step(e: KeyboardEvent): number {
  return (getState().prefs.snap || 1) * (e.shiftKey ? 10 : 1);
}

/** A quarter turn about an axis; with Alt, the other way. */
const turn = (axis: 0 | 1 | 2) => (e: KeyboardEvent) => rotateSelected(axis, e.altKey ? -90 : 90);

/** Lines the selection up on one side of an axis; with Shift, on the center of that axis. */
const lineUp = (axis: 0 | 1 | 2, side: 'min' | 'max') => (e: KeyboardEvent) => alignSelected(axis, e.shiftKey ? 'center' : side);

/**
 * What each command of the keymap does; which keys ask for it is the keymap's to say (see
 * ui/keymap.ts). Each is called through an arrow, so that none is handed the key press as an
 * argument it would take for something else.
 */
const ACTIONS: Record<CommandId, (e: KeyboardEvent) => void> = {
  save: () => void saveNow(),
  saveCopy: () => void saveCopy(),
  projects: () => void openProjects(),
  openFile: () => void openProjectFile(),
  newProject: () => void newProject(),
  import: () => void importModel(),

  // Escape backs out of one thing at a time: a drag first, then a mode, and the selection last.
  cancel: () => {
    if (viewerRef.current?.cancelGesture()) return;
    const s = getState();
    if (s.arraying) cancelArray();
    else if (s.mating) cancelMate();
    else if (s.measuring?.picks.length) clearMeasure();
    else if (s.measuring) stopMeasuring();
    else if (s.aligning) stopAligning();
    else if (s.placing) cancelPlacing();
    else if (s.jointPick) stopJointPick();
    else if (s.joint) selectJoint(null);
    else if (s.sensor) selectSensor(null);
    else select([]);
  },

  undo: () => undo(),
  redo: () => redo(),
  copy: () => copySelected(),
  cut: () => {
    copySelected();
    deleteSelected();
  },
  paste: () => paste(),
  selectAll: () => selectAll(),
  // In Robot mode a picked joint or sensor goes before any object.
  delete: () => {
    const { joint, sensor } = getState();
    if (joint) deleteJoint(joint);
    else if (sensor) deleteSensor(sensor);
    else deleteSelected();
  },
  duplicate: () => duplicateSelected(),
  group: () => void groupSelected(),
  ungroup: () => ungroupSelected(),

  nudgeLeft: (e) => nudgeSelected([-step(e), 0, 0]),
  nudgeRight: (e) => nudgeSelected([step(e), 0, 0]),
  nudgeBack: (e) => nudgeSelected([0, step(e), 0]),
  nudgeForward: (e) => nudgeSelected([0, -step(e), 0]),
  raise: (e) => nudgeSelected([0, 0, step(e)]),
  lower: (e) => nudgeSelected([0, 0, -step(e)]),

  solid: () => setHole(false),
  hole: () => setHole(true),
  mirrorX: () => mirrorSelected(0),
  mirrorY: () => mirrorSelected(1),
  mirrorZ: () => mirrorSelected(2),
  rotateX: turn(0),
  rotateY: turn(1),
  rotateZ: turn(2),
  ghost: () => ghostSelected(),
  unghostAll: () => unghostAll(),

  align: () => toggleAligning(),
  measure: () => toggleMeasuring(),
  objectAxes: () => toggleObjectAxes(),
  // Left and right along X, front and back along Y, bottom and top along Z.
  alignLeft: lineUp(0, 'min'),
  alignRight: lineUp(0, 'max'),
  alignFront: lineUp(1, 'min'),
  alignBack: lineUp(1, 'max'),
  alignBottom: lineUp(2, 'min'),
  alignTop: lineUp(2, 'max'),
  centerOnPlate: () => alignSelectedOn([[0, 'center'], [1, 'center']]),
  centerAll: () => alignSelectedOn([[0, 'center'], [1, 'center'], [2, 'center']]),

  drop: () => dropSelected(),
  fit: () => viewerRef.current?.fit(),
};

function onKeyDown(e: KeyboardEvent): void {
  const command = commandFor(e);
  if (!command || (typing(e.target) && !command.typing)) return;
  if (!command.keepsDefault) e.preventDefault();
  // While the Array panel has the selection laid out, only backing out and looking are open.
  if (getState().arraying && command.id !== 'cancel' && command.id !== 'fit') return;
  // A command given from inside a text box takes what was being typed there with it.
  if (command.typing) commitTyping();
  ACTIONS[command.id](e);
}

/** Word from the app, along the bottom of the window over everything, as a toast on a phone; gone by itself after a moment. */
function Toast() {
  const notice = useEditor((s) => s.notice);
  if (!notice) return null;
  const error = notice.kind === 'error';
  return (
    <div className="toast-host">
      <div className={error ? 'toast error' : notice.kind === 'ok' ? 'toast ok' : 'toast'} role={error ? 'alert' : 'status'}>
        {error && <WarningIcon />}
        <span>{notice.text}</span>
        {notice.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              dismissNotice();
              notice.action?.run();
            }}
          >
            {notice.action.label}
          </button>
        )}
        <button type="button" className="notice-close" aria-label={tr('Dismiss')} onClick={dismissNotice}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/**
 * The tab on the plate's edge that hides a side panel, or brings it back. On a narrow window the
 * panels lie over the plate, so showing one puts the other away.
 */
function PanelTab({ side, shown }: { side: 'left' | 'right'; shown: boolean }) {
  const name = side === 'left' ? (shown ? tr('Hide left panel') : tr('Show left panel')) : shown ? tr('Hide right panel') : tr('Show right panel');
  const toggle = () => {
    const key = side === 'left' ? 'leftPanel' : 'rightPanel';
    const other = side === 'left' ? 'rightPanel' : 'leftPanel';
    setPrefs(!shown && narrowWindow() ? { [key]: true, [other]: false } : { [key]: !shown });
  };
  // The chevron points the way the panel will go: towards its edge to hide, away from it to show.
  const pointsLeft = (side === 'left') === shown;
  return (
    <button type="button" className={`panel-tab ${side}`} title={name} aria-label={name} aria-expanded={shown} onClick={toggle}>
      <svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
        <path d={pointsLeft ? 'M6.5 1.5 1.5 7l5 5.5' : 'M1.5 1.5 6.5 7l-5 5.5'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export default function App() {
  const theme = useEditor((s) => s.prefs.theme);
  const left = useEditor((s) => s.prefs.leftPanel);
  const right = useEditor((s) => s.prefs.rightPanel);
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor(isDirty);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    platform.setWindowTitle(`${dirty ? '• ' : ''}${name} – ${APP_NAME}`);
  }, [name, dirty]);

  // On a narrow window the panels lie over the plate, one at a time. A window that becomes narrow with both on show
  // (a tablet turned upright) is left a strip of plate between them, so both are put away; a tab brings either back.
  useEffect(() => {
    const fit = (): void => {
      const { leftPanel, rightPanel } = getState().prefs;
      if (narrowWindow() && leftPanel && rightPanel) setPrefs({ leftPanel: false, rightPanel: false });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // The panels of the mating gear and of the array open over the plate where, on a narrow window, the inspector
  // lies: it is put away for them, or they would open behind it and nothing would seem to have happened.
  const besidePlate = useEditor((s) => s.mating !== null || s.arraying);
  useEffect(() => {
    if (besidePlate && narrowWindow() && getState().prefs.rightPanel) setPrefs({ rightPanel: false });
  }, [besidePlate]);

  useEffect(() => {
    void initInput();
    void restoreSession();
    window.addEventListener('keydown', onKeyDown);
    // A file that cannot be read (gone since, not of a kind the app opens) is said, not passed over in silence.
    const unread = (reasons: string[]): void => notify(reasons.join(' '), 'error');
    const stopDrops = platform.onFilesDropped((files) => void receiveFiles(files), unread);
    const stopOpened = platform.onFilesOpened((paths) => void Promise.all(paths.map((p) => platform.readPath(p))).then(receiveFiles).catch((e: unknown) => unread([e instanceof Error ? e.message : String(e)])));
    // Changes are written as they happen; closing or hiding the window writes whatever is still pending.
    const stopGuard = platform.guardClose(isDirty, () => saveProject(true));
    const stopHidden = platform.onHidden(() => void saveProject(true));
    const stopBack = platform.onBack(backOut);
    // The browser's own menu has nothing to offer here, and right-drag orbits.
    const noMenu = (e: MouseEvent) => {
      if (!typing(e.target)) e.preventDefault();
    };
    window.addEventListener('contextmenu', noMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('contextmenu', noMenu);
      stopDrops();
      stopOpened();
      stopGuard();
      stopHidden();
      stopBack();
    };
  }, []);

  return (
    <div className={`app${left ? '' : ' no-left'}${right ? '' : ' no-right'}`}>
      <ErrorBoundary frame="sidebar" {...crashActions}>
        <Sidebar />
      </ErrorBoundary>
      <main className="stage">
        <ErrorBoundary frame="viewport" {...crashActions}>
          <Viewport />
        </ErrorBoundary>
        <PanelTab side="left" shown={left} />
        <PanelTab side="right" shown={right} />
      </main>
      <ErrorBoundary frame="inspector" {...crashActions}>
        <Inspector />
      </ErrorBoundary>
      <Projects />
      <TouchEntrySheet />
      <AskDialog />
      <Toast />
    </div>
  );
}
