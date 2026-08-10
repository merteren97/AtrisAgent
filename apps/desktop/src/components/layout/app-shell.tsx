import { ReactNode } from 'react';

interface AppShellProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
}

export function AppShell({ sidebar, main, inspector }: AppShellProps) {
  return (
    <div className="relative flex h-screen w-screen min-w-0 overflow-hidden bg-background text-foreground select-none">
      {sidebar}
      {main}
      {inspector}
    </div>
  );
}
