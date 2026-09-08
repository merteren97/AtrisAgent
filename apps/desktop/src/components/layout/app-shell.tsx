import { ReactNode } from 'react';

interface AppShellProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
}

export function AppShell({ sidebar, main, inspector }: AppShellProps) {
  return (
    <div className="atris-workspace-shell relative flex h-screen w-screen min-w-0 overflow-hidden bg-sidebar text-foreground select-none">
      {sidebar}
      {main}
      {inspector}
    </div>
  );
}
