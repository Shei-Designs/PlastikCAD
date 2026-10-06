import { useEffect } from 'react';
import { APP_NAME } from './app';
import * as platform from './platform';
import {
  cancelPlacing,
  copySelected,
  deleteSelected,
  dropSelected,
  duplicateSelected,
  getState,
  groupSelected,
  importModel,
  isDirty,
  mirrorSelected,
  newDesign,
  nudgeSelected,
  openDesign,
  paste,
  receiveFiles,
  redo,
  restoreSession,
  saveDesign,
  saveDesignAs,
  saveVersion,
  select,
  selectAll,
  setHole,
  setPrefs,
  undo,
  ungroupSelected,
  useEditor,
  viewVersion,
} from './state/store';
import { Inspector } from './ui/Inspector';
import { Sidebar } from './ui/Sidebar';
import { Viewport, viewerRef } from './ui/Viewport';

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // File commands work everywhere, including from inside a text box.
  if (mod && !e.altKey) {
    const command =
      key === 's' ? (e.shiftKey ? saveDesignAs : saveDesign) : key === 'o' ? openDesign : key === 'n' ? newDesign : key === 'i' ? importModel : null;
    if (command) {
      e.preventDefault();
      void command();
      return;
    }
  }
  if (typing(e.target)) return;

  if (key === 'Escape') {
    if (viewerRef.current?.cancelGesture()) return;
    const s = getState();
    if (s.placing) cancelPlacing();
    else if (s.viewing) viewVersion(null);
    else select([]);
    return;
  }
  if (getState().viewing) return;

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
                ? e.shiftKey
                  ? () => {
                      setPrefs({ panel: 'versions' });
                      saveVersion('');
                    }
                  : paste
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
    m: () => mirrorSelected(0),
  };
  const action = plain[key];
  if (action) {
    e.preventDefault();
    action();
  }
}

/** Arrow keys move by the snap step; Shift makes it ten times that. */
function step(e: KeyboardEvent): number {
  return (getState().prefs.snap || 1) * (e.shiftKey ? 10 : 1);
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
    void restoreSession();
    window.addEventListener('keydown', onKeyDown);
    const stopDrops = platform.onFilesDropped((files) => void receiveFiles(files));
    // In a browser the session copy already survives a reload; only the desktop window needs to ask.
    const stopGuard = platform.isDesktop() ? platform.guardClose(() => isDirty() && getState().doc.scene.length > 0) : () => {};
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
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="stage">
        <Viewport />
      </main>
      <Inspector />
    </div>
  );
}
