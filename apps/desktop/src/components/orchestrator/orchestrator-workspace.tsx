import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Columns2, LayoutGrid, Loader2, MessageSquare, ShieldAlert, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScopedChatInspector, type ScopedInspectorSubTab } from './scoped-chat-inspector';
import { useOrchestrationGraphStore, type OrchestratorLayoutPreset } from '@/stores/orchestration-graph-store';
import { useMissionStore } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';

const LazySchematicCanvas = lazy(() =>
  import('./schematic-canvas').then((module) => ({ default: module.SchematicCanvas })),
);

const DEFAULT_SPLIT_RATIO = 46;
const MIN_SPLIT_RATIO = 28;
const MAX_SPLIT_RATIO = 72;

export function OrchestratorWorkspace() {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const missions = useMissionStore((state) => state.missions);
  const agents = useAgentStore((state) => state.agents);

  const layoutPreset = useOrchestrationGraphStore((state) => state.layoutPreset);
  const setLayoutPreset = useOrchestrationGraphStore((state) => state.setLayoutPreset);
  const setCanvasMode = useOrchestrationGraphStore((state) => state.setCanvasMode);
  const selectNode = useOrchestrationGraphStore((state) => state.selectNode);
  const selectedNodeId = useOrchestrationGraphStore((state) => state.selectedNodeId);
  const selectedAgentId = useOrchestrationGraphStore((state) => state.selectedAgentId);
  const hydrateMissionGraph = useOrchestrationGraphStore((state) => state.hydrateMissionGraph);
  const snapshot = useOrchestrationGraphStore((state) => (activeMissionId ? state.snapshotsByMission[activeMissionId] : undefined));
  const inspectorCollapsed = useSettingsStore((state) => state.inspectorCollapsed);
  const inspectorTab = useSettingsStore((state) => state.inspectorTab);

  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_RATIO);
  const [subTab, setSubTab] = useState<ScopedInspectorSubTab>('chat');
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const mission = missions.find((m) => m.id === activeMissionId);
  const runningWorkers = activeMissionId
    ? (snapshot?.agents.filter((a) => a.status === 'running').length
      ?? agents.filter((a) => a.missionId === activeMissionId && a.status === 'running').length)
    : 0;
  const pendingApprovals = snapshot?.approvals.filter((a) => a.status === 'pending') || [];

  useEffect(() => {
    setSubTab('chat');
    selectNode(null, null);
    if (activeMissionId) {
      void hydrateMissionGraph(activeMissionId);
    }
  }, [activeMissionId, hydrateMissionGraph, selectNode]);

  useEffect(() => {
    if (inspectorCollapsed) return;
    if (inspectorTab === 'changes') {
      setSubTab('diff');
      if (layoutPreset === 'canvas') setLayoutPreset('split');
    } else if (inspectorTab === 'artifacts' || inspectorTab === 'checks') {
      setSubTab('artifacts');
      if (layoutPreset === 'canvas') setLayoutPreset('split');
    } else if (inspectorTab === 'board') {
      setLayoutPreset('split');
      setCanvasMode('pipeline');
    } else if (inspectorTab === 'activity') {
      setSubTab('console');
      setLayoutPreset('split');
      setCanvasMode('dag');
    } else {
      setLayoutPreset('split');
      setCanvasMode('dag');
    }
    useSettingsStore.setState({ inspectorCollapsed: true, inspectorExpanded: false });
  }, [inspectorCollapsed, inspectorTab, layoutPreset, setCanvasMode, setLayoutPreset]);

  const handleSelectScope = useCallback(
    (scope: { taskId: string | null; agentId: string | null }) => {
      selectNode(scope.taskId, scope.agentId);
      setSubTab('chat');
    },
    [selectNode],
  );

  const handleJumpToApproval = () => {
    const first = pendingApprovals[0];
    if (!first) return;
    const matchedAgent = first.taskId
      ? snapshot?.agents.find((a) => a.taskId === first.taskId)
      : undefined;
    selectNode(first.taskId, matchedAgent?.id ?? null);
    setSubTab('chat');
    if (layoutPreset === 'canvas') {
      setLayoutPreset('split');
    }
  };

  const updateSplitFromClientX = (clientX: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const raw = ((clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, raw)));
  };

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitFromClientX(event.clientX);
  };

  const handleDividerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSplitPercent((prev) => Math.max(MIN_SPLIT_RATIO, prev - 4));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSplitPercent((prev) => Math.min(MAX_SPLIT_RATIO, prev + 4));
    }
  };

  const showCanvas = Boolean(activeMissionId && (layoutPreset === 'split' || layoutPreset === 'canvas'));
  const showChat = !activeMissionId || layoutPreset === 'split' || layoutPreset === 'chat';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Compact top workspace bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/40 px-3 py-1.5">
        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-muted/30 p-0.5" role="group" aria-label="Workspace layout">
          {([
            { id: 'chat', label: 'Chat', icon: MessageSquare },
            { id: 'split', label: 'Split', icon: Columns2 },
            { id: 'canvas', label: 'Canvas', icon: LayoutGrid },
          ] as Array<{ id: OrchestratorLayoutPreset; label: string; icon: typeof MessageSquare }>).map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={layoutPreset === preset.id}
              disabled={!activeMissionId && preset.id !== 'chat'}
              onClick={() => setLayoutPreset(preset.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-45',
                layoutPreset === preset.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <preset.icon className="h-3.5 w-3.5" />
              <span>{preset.label}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pendingApprovals.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleJumpToApproval}
              className="h-7 gap-1.5 border-amber-500/40 bg-amber-500/10 px-2.5 text-xs text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>{pendingApprovals.length} Pending Approval{pendingApprovals.length === 1 ? '' : 's'}</span>
            </Button>
          )}

          {activeMissionId && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                <span>{runningWorkers} active</span>
              </span>
              {mission?.status && (
                <Badge variant="outline" className="h-5 px-2 text-[10px] capitalize">
                  {mission.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 2-pane split / single-pane content */}
      <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2 sm:p-2.5 lg:flex-row lg:gap-0">
        {showCanvas && activeMissionId && (
          <div
            style={layoutPreset === 'split' ? { flexBasis: `${splitPercent}%` } : undefined}
            className={cn(
              'relative flex min-h-[260px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card/50 shadow-sm lg:min-h-0',
              layoutPreset === 'canvas' ? 'flex-1' : 'lg:shrink-0 lg:grow-0',
            )}
          >
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" role="status">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading orchestration schematic…
                </div>
              }
            >
              <LazySchematicCanvas missionId={activeMissionId} onSelectScope={handleSelectScope} />
            </Suspense>

            {layoutPreset === 'canvas' && (selectedNodeId || selectedAgentId) && (
              <div className="absolute right-3 top-3 z-20">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-8 gap-1.5 border border-border bg-card/95 shadow-md backdrop-blur-sm"
                  onClick={() => setLayoutPreset('split')}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                  Open Split Inspector
                </Button>
              </div>
            )}
          </div>
        )}

        {showCanvas && showChat && (
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize schematic and chat panes"
            aria-valuenow={Math.round(splitPercent)}
            aria-valuemin={MIN_SPLIT_RATIO}
            aria-valuemax={MAX_SPLIT_RATIO}
            onPointerDown={handleDividerPointerDown}
            onPointerMove={(event) => {
              if (draggingRef.current) updateSplitFromClientX(event.clientX);
            }}
            onPointerUp={() => {
              draggingRef.current = false;
            }}
            onLostPointerCapture={() => {
              draggingRef.current = false;
            }}
            onKeyDown={handleDividerKeyDown}
            className="hidden w-2.5 shrink-0 cursor-col-resize items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
          >
            <span className="h-10 w-1 rounded-full bg-border transition-colors hover:bg-primary/60" />
          </div>
        )}

        {showChat && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ScopedChatInspector
              missionId={activeMissionId}
              activeSubTab={subTab}
              onSubTabChange={setSubTab}
            />
          </div>
        )}
      </div>
    </div>
  );
}
