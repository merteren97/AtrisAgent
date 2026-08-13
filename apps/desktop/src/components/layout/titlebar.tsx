import { useEffect, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MoreHorizontal, Play, Pause, Square, RotateCcw, Cpu, Minus, X, Maximize, SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useMissionStore } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useLanguageStore, t } from '@/stores/language-store';
import { UsageMeter } from '@/components/usage/UsageMeter';

type WindowAction = 'move' | 'minimize' | 'maximize' | 'close';

const WINDOW_COMMANDS: Record<WindowAction, string> = {
  move: 'window_start_dragging',
  minimize: 'window_minimize',
  maximize: 'window_toggle_maximize',
  close: 'window_close',
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown window error';
  }
}

export function Titlebar() {
  const { devMode, toggleDevMode, setActiveView } = useSettingsStore();
  const [feedback, setFeedback] = useState<string | null>(null);
  useLanguageStore();

  const {
    missions,
    activeMissionId,
    pauseMission,
    stopMission,
    retryMission,
    clearActiveMission,
    setComposerInput,
  } = useMissionStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const activeMission = missions.find((mission) => mission.id === activeMissionId);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  const reportWindowError = (action: WindowAction, error: unknown) => {
    const details = getErrorMessage(error);
    console.error(`[Titlebar] ${action} failed: ${details}`, error);
    setFeedback(`${action}: ${details}`);
    window.setTimeout(() => setFeedback(null), 5_000);
  };

  const runWindowAction = async (action: WindowAction): Promise<void> => {
    await invoke(WINDOW_COMMANDS[action]);
  };

  const handleDragFallback = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [data-no-drag]')) return;

    // CSS app-region provides the native Windows drag behavior. The registered
    // Rust command is retained as a fallback for WebView2/runtime combinations
    // where the CSS region is not picked up immediately.
    if (event.detail === 2) {
      void runWindowAction('maximize').catch((error) => reportWindowError('maximize', error));
      return;
    }

    void runWindowAction('move').catch((error) => reportWindowError('move', error));
  };

  const handleDevModeToggle = () => {
    toggleDevMode();
    setFeedback(devMode ? 'Developer Mode disabled' : 'Developer Mode enabled');
    window.setTimeout(() => setFeedback(null), 2_000);
  };

  const handlePlayPause = () => {
    if (!activeMission) return;
    if (activeMission.status === 'running') void pauseMission(activeMission.id);
    else void retryMission(activeMission.id);
  };

  const handleNewChat = () => {
    if (!activeWorkspaceId) return;
    clearActiveMission();
    setComposerInput('');
    setActiveView('chat');
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus());
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!activeWorkspaceId) return;
      event.preventDefault();
      clearActiveMission();
      setComposerInput('');
      setActiveView('chat');
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus());
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeWorkspaceId, clearActiveMission, setActiveView, setComposerInput]);

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center border-b border-border bg-background select-none">
      <div
        id="atris-titlebar-drag-region"
        data-tauri-drag-region
        className="atris-drag-region flex h-full min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-4"
        onMouseDown={handleDragFallback}
      >
        <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <h1 data-tauri-drag-region className="pointer-events-none min-w-0 truncate text-sm font-semibold">
            {activeMission?.title || (activeWorkspace ? 'New chat' : 'AtrisAgent')}
          </h1>
          {activeMission ? (
            <Badge data-tauri-drag-region variant={activeMission.status === 'running' ? 'success' : 'secondary'} className="pointer-events-none shrink-0 text-[10px] uppercase">
              {activeMission.status}
            </Badge>
          ) : activeWorkspace ? (
            <Badge data-tauri-drag-region variant="secondary" className="pointer-events-none shrink-0 border-primary/20 bg-primary/[0.06] text-[9px] uppercase tracking-wide text-primary">
              {activeWorkspace.name}
            </Badge>
          ) : null}
        </div>
        {feedback && <span data-tauri-drag-region className="pointer-events-none max-w-[260px] shrink truncate text-xs text-destructive">{feedback}</span>}
      </div>

      <div data-no-drag className="atris-no-drag relative z-10 flex h-full shrink-0 items-center gap-1 bg-background pr-1">
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 ${!activeMission && activeWorkspace ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={handleNewChat}
          disabled={!activeWorkspace}
          title={activeWorkspace ? `New chat in ${activeWorkspace.name} (Ctrl+N)` : 'Open a project before starting a chat'}
          aria-label={activeWorkspace ? `New chat in ${activeWorkspace.name}` : 'New chat'}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handlePlayPause} disabled={!activeMission} title={activeMission?.status === 'running' ? t('Pause') : t('Play')}>
          {activeMission?.status === 'running' ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => activeMission && void stopMission(activeMission.id)} disabled={!activeMission || activeMission.status === 'cancelled'} title={t('Stop')}>
          <Square className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => activeMission && void retryMission(activeMission.id)} disabled={!activeMission} title={t('Retry')}>
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <UsageMeter />
        <Button variant="ghost" size="sm" className={`h-7 shrink-0 gap-1.5 text-xs ${devMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`} onClick={handleDevModeToggle}>
          <Cpu className="h-3.5 w-3.5" />{t('Developer Mode')}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => console.log('More options clicked')}>
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          data-no-drag
          variant="ghost"
          size="icon"
          className="h-9 w-10 shrink-0 rounded-none"
          onClick={() => void runWindowAction('minimize').catch((error) => reportWindowError('minimize', error))}
          title="Minimize"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button
          data-no-drag
          variant="ghost"
          size="icon"
          className="h-9 w-10 shrink-0 rounded-none"
          onClick={() => void runWindowAction('maximize').catch((error) => reportWindowError('maximize', error))}
          title="Maximize or restore"
        >
          <Maximize className="h-3.5 w-3.5" />
        </Button>
        <Button
          data-no-drag
          variant="ghost"
          size="icon"
          className="h-9 w-10 shrink-0 rounded-none hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => void runWindowAction('close').catch((error) => reportWindowError('close', error))}
          title="Close AtrisAgent"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
