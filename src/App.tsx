import { useEffect } from 'react';
import { APP_NAME } from './app';
import * as platform from './platform';
import {
  alignSelected,
  alignSelectedOn,
  cancelMate,
  cancelPlacing,
  copySelected,
  deleteSelected,
  dismissNotice,
  dropSelected,
  duplicateSelected,
  getState,
  groupSelected,
  importModel,
  isDirty,
  mirrorSelected,
  newProject,
  nudgeSelected,
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
  setHole,
  stopAligning,
  toggleAligning,
  undo,
  ungroupSelected,
  useEditor,
} from './state/store';
import { Inspector } from './ui/Inspector';
import { Projects } from './ui/Projects';
import { Sidebar } from './ui/Sidebar';
import { initInput } from './ui/inputMode';
import { AskDialog } from './ui/AskDialog';
import { TouchEntrySheet } from './ui/TouchEntry';
import { Viewport, viewerRef } from './ui/Viewport';
import { CloseIcon, WarningIcon } from './ui/icons';

// Inputs that take no typing: clicking one of these must not put the shortcuts to sleep.
const CLICK_INPUTS = new Set(['checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file']);

const typing = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !CLICK_INPUTS.has(target.type);
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
};

/** Lets a box being typed in commit its value first, so a save takes the number on screen. */
const commitTyping = (): void => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) active.blur();
};

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // File commands work everywhere, including from inside a text box.
  if (mod && !e.altKey) {
    const command = key === 's' ? (e.shiftKey ? saveCopy : saveNow) : key === 'o' ? openProjects : key === 'n' ? newProject : key === 'i' ? importModel : null;
    if (command) {
      e.preventDefault();
      commitTyping();
      void command();
      return;
    }
  }
  if (typing(e.target)) return;

  if (key === 'Escape') {
    if (viewerRef.current?.cancelGesture()) return;
    const s = getState();
    if (s.mating) cancelMate();
    else if (s.aligning) stopAligning();
    else if (s.placing) cancelPlacing();
    else select([]);
    return;
  }

  // Shift + X / Y / Z turn the selection a quarter turn about that axis; with Alt, the other way.
  if (e.shiftKey && !mod && (key === 'x' || key === 'y' || key === 'z')) {
    e.preventDefault();
    rotateSelected(key === 'x' ? 0 : key === 'y' ? 1 : 2, e.altKey ? -90 : 90);
    return;
  }

  // Alt + arrows line the selection up; with Shift, on the center of that axis. Alt+C centers X and Y at once.
  if (e.altKey && !mod) {
    const axis = ALIGN_KEYS[key];
    if (axis) {
      e.preventDefault();
      alignSelected(axis[0], e.shiftKey ? 'center' : axis[1]);
      return;
    }
    if (key === 'c') {
      e.preventDefault();
      alignSelectedOn(e.shiftKey ? [[0, 'center'], [1, 'center'], [2, 'center']] : [[0, 'center'], [1, 'center']]);
      return;
    }
  }

  if (mod) {
    const action =
      key === 'z'
        ? e.shiftKey
          ? redo
          : undo
        : key === 'y'
          ? redo
          : key === 'd'
            ? duplicateSelected
            : key === 'c'
              ? copySelected
              : key === 'v'
                ? paste
                : key === 'x'
                  ? () => {
                      copySelected();
                      deleteSelected();
                    }
                  : key === 'a'
                    ? selectAll
                    : key === 'g'
                      ? e.shiftKey
                        ? ungroupSelected
                        : () => void groupSelected()
                      : key === 'ArrowUp' || key === 'ArrowDown'
                        ? () => nudgeSelected([0, 0, (key === 'ArrowUp' ? 1 : -1) * step(e)])
                        : null;
    if (action) {
      e.preventDefault();
      action();
    }
    return;
  }

  const plain: Record<string, () => void> = {
    Delete: deleteSelected,
    Backspace: deleteSelected,
    ArrowLeft: () => nudgeSelected([-step(e), 0, 0]),
    ArrowRight: () => nudgeSelected([step(e), 0, 0]),
    ArrowUp: () => nudgeSelected([0, step(e), 0]),
    ArrowDown: () => nudgeSelected([0, -step(e), 0]),
    h: () => setHole(true),
    s: () => setHole(false),
    d: dropSelected,
    f: () => viewerRef.current?.fit(),
    l: toggleAligning,
    x: () => mirrorSelected(0),
    y: () => mirrorSelected(1),
    z: () => mirrorSelected(2),
  };
  const action = plain[key];
  if (action) {
    e.preventDefault();
    action();
  }
}

/** Which side of which axis each alignment key goes to: left/right along X, front/back along Y, down/up along Z. */
const ALIGN_KEYS: Record<string, [0 | 1 | 2, 'min' | 'max']> = {
  ArrowLeft: [0, 'min'],
  ArrowRight: [0, 'max'],
  ArrowDown: [1, 'min'],
  ArrowUp: [1, 'max'],
  PageDown: [2, 'min'],
  PageUp: [2, 'max'],
};

/** Arrow keys move by the snap step; Shift makes it ten times that. */
function step(e: KeyboardEvent): number {
  return (getState().prefs.snap || 1) * (e.shiftKey ? 10 : 1);
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
        <button type="button" className="notice-close" aria-label="Dismiss" onClick={dismissNotice}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useEditor((s) => s.prefs.theme);
  const name = useEditor((s) => s.doc.name);
  const dirty = useEditor(isDirty);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    platform.setWindowTitle(`${dirty ? '• ' : ''}${name} – ${APP_NAME}`);
  }, [name, dirty]);

  useEffect(() => {
    void initInput();
    void restoreSession();
    window.addEventListener('keydown', onKeyDown);
    const stopDrops = platform.onFilesDropped((files) => void receiveFiles(files));
    // Changes are written as they happen; closing or hiding the window writes whatever is still pending.
    const stopGuard = platform.guardClose(isDirty, () => saveProject(true));
    const stopHidden = platform.onHidden(() => void saveProject(true));
    // The browser's own menu has nothing to offer here, and right-drag orbits.
    const noMenu = (e: MouseEvent) => {
      if (!typing(e.target)) e.preventDefault();
    };
    window.addEventListener('contextmenu', noMenu);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('contextmenu', noMenu);
      stopDrops();
      stopGuard();
      stopHidden();
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="stage">
        <Viewport />
      </main>
      <Inspector />
      <Projects />
      <TouchEntrySheet />
      <AskDialog />
      <Toast />
    </div>
  );
}
