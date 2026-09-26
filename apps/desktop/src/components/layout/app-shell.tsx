import { ReactNode } from 'react';

interface AppShellProps {
  titlebar: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
}

export function AppShell({ titlebar, sidebar, main, inspector }: AppShellProps) {
  return (
    <div className="atris-workspace-shell relative flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-sidebar text-foreground select-none">
      {titlebar}
      <div className="atris-workspace-body relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {sidebar}
        {main}
        {inspector}
      </div>
    </div>
  );
}
