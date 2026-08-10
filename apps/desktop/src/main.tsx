import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { initializeRuntime } from './lib/runtime-config';

const root = ReactDOM.createRoot(document.getElementById('root')!);

function RuntimeLoadingView() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <span className="h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden="true" />
        Starting the local AtrisAgent runtimeâ€¦
      </div>
    </main>
  );
}

root.render(
  <React.StrictMode>
    <RuntimeLoadingView />
  </React.StrictMode>,
);

void initializeRuntime().then((runtime) => {
  root.render(
    <React.StrictMode>
      <App runtime={runtime} />
    </React.StrictMode>,
  );
});
