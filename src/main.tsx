import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { crashActions } from './App';
import { watchWindow } from './diagnostics';
import { ErrorBoundary } from './ui/ErrorBoundary';
// The UI is set in Inter, the product name in Space Grotesk, as Shei Designs sets them; bundled so every platform matches.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/space-grotesk/latin-500.css';
import './styles.css';

// What goes wrong outside the app's own handling is noted for the report in the About box.
watchWindow();

// The browser tests' way in, in the build made for them and in no other (see e2eHook.ts).
if (import.meta.env.VITE_E2E) void import('./e2eHook');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {/* The panels and the view each catch their own failures (see App); this one is for whatever is left. */}
    <ErrorBoundary frame="window" {...crashActions}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
