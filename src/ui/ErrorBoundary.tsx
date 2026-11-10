// A part of the window that threw while drawing itself is replaced by a short
// word and a way on, instead of the whole window going blank. The rest of the
// app keeps working around it.
import { noteDiagnostic } from '../diagnostics';
import { asError } from '../errors';
import { tr } from '../i18n';
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Where the boundary sits, which decides the element its message takes the place of. */
export type CrashFrame = 'sidebar' | 'viewport' | 'inspector' | 'window';

interface Actions {
  /** Writes what is pending and loads the app again. */
  onReload: () => void;
  onSaveCopy: () => void;
}

interface Props extends Actions {
  frame: CrashFrame;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** What is said of each part that failed, as a whole sentence. */
const NAMES: Record<CrashFrame, string> = {
  sidebar: tr('This panel stopped working.'),
  viewport: tr('The 3D view stopped working.'),
  inspector: tr('This panel stopped working.'),
  window: tr('The app stopped working.'),
};

/** What is shown in place of the part that failed. */
export function Crashed({ frame, error, onReload, onSaveCopy }: Actions & { frame: CrashFrame; error: Error }) {
  const body = (
    <div className="crash" role="alert">
      <strong>{NAMES[frame]}</strong>
      <p>{tr('Reload to carry on.')}</p>
      <p className="crash-detail clip" title={error.message}>
        {error.message}
      </p>
      <div className="crash-actions">
        <button type="button" className="chip" onClick={onSaveCopy}>
          {tr('Save a copy…')}
        </button>
        <button type="button" className="primary" onClick={onReload}>
          {tr('Reload')}
        </button>
      </div>
    </div>
  );
  if (frame === 'sidebar' || frame === 'inspector') return <aside className={`${frame} crashed`}>{body}</aside>;
  return <div className={frame === 'viewport' ? 'viewport crashed' : 'crashed whole'}>{body}</div>;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`The ${this.props.frame} failed to draw:`, error, info.componentStack);
    noteDiagnostic('crash', `The ${this.props.frame} failed to draw: ${asError(error).message}${info.componentStack ? ` at${info.componentStack.split('\n').slice(0, 4).join(' <')}` : ''}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <Crashed frame={this.props.frame} error={error} onReload={this.props.onReload} onSaveCopy={this.props.onSaveCopy} />;
  }
}
