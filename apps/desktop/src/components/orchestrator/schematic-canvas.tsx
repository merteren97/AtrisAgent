import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  GitFork,
  Kanban,
  Maximize2,
  RefreshCw,
  Rows3,
  Sparkles,
} from 'lucide-react';
import {
  schematicNodeTypes,
  resolveTaskVisualState,
  type AgentTaskFlowNode,
  type OrchestratorRootFlowNode,
  type VerificationGateFlowNode,
} from '@/components/orchestrator/schematic-nodes';
import { SwimlaneTimeline } from '@/components/orchestrator/swimlane-timeline';
import { DependencyPipeline } from '@/components/orchestrator/dependency-pipeline';
import { computeLayeredGraphLayout, type LayoutPositionMap } from '@/lib/elk-layout';
import {
  ORCHESTRATOR_NODE_ID,
  VERIFICATION_GATE_ID,
  buildSchematicGraphStructure,
  useOrchestrationGraphStore,
  type CanvasViewMode,
} from '@/stores/orchestration-graph-store';
import { cn } from '@/lib/utils';

export interface SchematicCanvasProps {
  missionId: string;
  onSelectScope?: (scope: { taskId: string | null; agentId: string | null }) => void;
}

type SchematicFlowNode =
  | OrchestratorRootFlowNode
  | AgentTaskFlowNode
  | VerificationGateFlowNode;

export function SchematicCanvas({ missionId, onSelectScope }: SchematicCanvasProps) {
  const snapshot = useOrchestrationGraphStore((s) => s.snapshotsByMission[missionId]);
  const loading = useOrchestrationGraphStore((s) => Boolean(s.loadingByMission[missionId]));
  const error = useOrchestrationGraphStore((s) => s.errorByMission[missionId]);
  const selectedNodeId = useOrchestrationGraphStore((s) => s.selectedNodeId);
  const canvasMode = useOrchestrationGraphStore((s) => s.canvasMode);
  const hydrateMissionGraph = useOrchestrationGraphStore((s) => s.hydrateMissionGraph);
  const selectNode = useOrchestrationGraphStore((s) => s.selectNode);
  const setCanvasMode = useOrchestrationGraphStore((s) => s.setCanvasMode);

  const [positions, setPositions] = useState<LayoutPositionMap>({});
  const flowInstanceRef = useRef<ReactFlowInstance<SchematicFlowNode, Edge> | null>(null);

  useEffect(() => {
    if (!missionId) return;
    if (!snapshot && !loading) {
      void hydrateMissionGraph(missionId);
    }
  }, [missionId, snapshot, loading, hydrateMissionGraph]);

  const structure = useMemo(() => {
    if (!snapshot) return null;
    return buildSchematicGraphStructure(snapshot);
  }, [snapshot]);

  const structuralKey = structure?.structuralKey || '';

  useEffect(() => {
    if (!structure || structure.layoutNodes.length === 0) return;
    let cancelled = false;
    void computeLayeredGraphLayout(structure.layoutNodes, structure.rawEdges, {
      direction: 'RIGHT',
    }).then((computed) => {
      if (cancelled) return;
      setPositions(computed);
      window.requestAnimationFrame(() => {
        if (!cancelled) {
          flowInstanceRef.current?.fitView({ padding: 0.2, duration: 150 });
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [structuralKey]);

  const handleSelectScope = useCallback(
    (scope: { taskId: string | null; agentId: string | null }) => {
      selectNode(scope.taskId, scope.agentId);
      onSelectScope?.(scope);
    },
    [selectNode, onSelectScope],
  );

  const flowNodes = useMemo<SchematicFlowNode[]>(() => {
    if (!snapshot || !structure) return [];

    const activeCount = structure.activeTasks.filter((t) =>
      ['running', 'claimed'].includes(t.status.toLowerCase()),
    ).length;

    const nodes: SchematicFlowNode[] = [
      {
        id: ORCHESTRATOR_NODE_ID,
        type: 'orchestratorRoot',
        position: positions[ORCHESTRATOR_NODE_ID] || { x: 0, y: 0 },
        data: {
          missionId,
          title: snapshot.mission.title,
          status: snapshot.mission.status,
          taskCount: structure.activeTasks.length,
          activeCount,
          selected: selectedNodeId === null,
        },
      },
    ];

    for (const task of structure.activeTasks) {
      const agent = snapshot.agents.find(
        (a) => a.id === task.assignedAgentId || a.taskId === task.id,
      );
      const latestAttempt = snapshot.attempts
        .filter((a) => a.taskId === task.id)
        .slice(-1)[0];
      const pendingApproval = snapshot.approvals.find(
        (ap) => ap.taskId === task.id && ap.status === 'pending',
      );
      nodes.push({
        id: task.id,
        type: 'agentTask',
        position: positions[task.id] || { x: 320, y: 0 },
        data: {
          missionId,
          task,
          agent,
          latestAttempt,
          pendingApproval,
          selected: selectedNodeId === task.id,
        },
      });
    }

    if (structure.hasGate) {
      const missionStatus = snapshot.mission.status;
      const anyFailed = structure.builderTasks.some((t) =>
        ['failed', 'rejected', 'revision_requested'].includes(t.status.toLowerCase()),
      );
      const allDone = structure.builderTasks.every((t) => t.status.toLowerCase() === 'done');
      const gateStatus =
        missionStatus === 'verifying'
          ? 'verifying'
          : anyFailed
            ? 'failed'
            : allDone && missionStatus === 'completed'
              ? 'passed'
              : 'pending';

      nodes.push({
        id: VERIFICATION_GATE_ID,
        type: 'verificationGate',
        position: positions[VERIFICATION_GATE_ID] || { x: 680, y: 0 },
        data: {
          status: gateStatus,
          builderCount: structure.builderTasks.length,
          selected: selectedNodeId === VERIFICATION_GATE_ID,
        },
      });
    }

    return nodes;
  }, [snapshot, structure, positions, missionId, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!snapshot || !structure) return [];
    const taskMap = new Map(structure.activeTasks.map((t) => [t.id, t]));

    return structure.rawEdges.map((edge) => {
      const targetTask = taskMap.get(edge.target);
      const sourceTask = taskMap.get(edge.source);
      const targetAgent = targetTask
        ? snapshot.agents.find((a) => a.id === targetTask.assignedAgentId || a.taskId === targetTask.id)
        : undefined;
      const targetApproval = targetTask
        ? snapshot.approvals.find((ap) => ap.taskId === targetTask.id && ap.status === 'pending')
        : undefined;

      const targetVisual = targetTask
        ? resolveTaskVisualState(targetTask, targetAgent, targetApproval)
        : 'idle';
      const sourceVisual = sourceTask
        ? resolveTaskVisualState(
            sourceTask,
            snapshot.agents.find((a) => a.id === sourceTask.assignedAgentId || a.taskId === sourceTask.id),
            undefined,
          )
        : 'idle';

      const isActive = targetVisual === 'running' || sourceVisual === 'running';
      const isFailureOrRetry =
        targetVisual === 'failed' ||
        targetTask?.status === 'revision_requested' ||
        targetVisual === 'waiting_approval';

      const strokeColor = isFailureOrRetry
        ? targetVisual === 'waiting_approval'
          ? 'hsl(var(--warning))'
          : 'hsl(var(--destructive))'
        : isActive
          ? 'hsl(var(--primary))'
          : 'hsl(var(--muted-foreground) / 0.45)';

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: isActive,
        style: {
          stroke: strokeColor,
          strokeWidth: isActive ? 2 : 1.5,
          ...(isFailureOrRetry ? { strokeDasharray: '6 4' } : {}),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 14,
          height: 14,
        },
      };
    });
  }, [snapshot, structure]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.id === ORCHESTRATOR_NODE_ID || node.id === VERIFICATION_GATE_ID) {
        handleSelectScope({ taskId: null, agentId: null });
        return;
      }
      const task = snapshot?.tasks.find((t) => t.id === node.id);
      const agent = snapshot?.agents.find(
        (a) => a.id === task?.assignedAgentId || a.taskId === node.id,
      );
      handleSelectScope({
        taskId: node.id,
        agentId: agent?.id || task?.assignedAgentId || null,
      });
    },
    [snapshot, handleSelectScope],
  );

  const pendingApprovalsCount = snapshot?.approvals.filter((a) => a.status === 'pending').length || 0;
  const tasksCount = structure?.activeTasks.length || 0;

  const viewTabs: Array<{ id: CanvasViewMode; label: string; icon: typeof GitFork }> = [
    { id: 'dag', label: 'DAG', icon: GitFork },
    { id: 'swimlane', label: 'Timeline', icon: Rows3 },
    { id: 'pipeline', label: 'Pipeline', icon: Kanban },
  ];

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground overflow-hidden">
      {/* Compact Schematic Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border bg-card/70 px-2.5 py-1.5 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5 shrink-0">
          {viewTabs.map((tab) => {
            const Icon = tab.icon;
            const active = canvasMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCanvasMode(tab.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-muted-foreground">
            {tasksCount} {tasksCount === 1 ? 'node' : 'nodes'}
          </span>
          {pendingApprovalsCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-700 dark:text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
              {pendingApprovalsCount} approval
            </span>
          )}
          {canvasMode === 'dag' && (
            <button
              type="button"
              onClick={() => flowInstanceRef.current?.fitView({ padding: 0.2, duration: 250 })}
              title="Fit graph to view"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => void hydrateMissionGraph(missionId)}
            disabled={loading}
            title="Refresh schematic graph"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Canvas Body */}
      <div className="relative flex-1 min-h-0">
        {error && !snapshot ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-xs font-medium text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void hydrateMissionGraph(missionId)}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
            >
              Retry
            </button>
          </div>
        ) : !snapshot ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading orchestration graph…
          </div>
        ) : tasksCount === 0 && canvasMode === 'dag' ? (
          <div className="flex h-full flex-col items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Orchestrator Ready
                  </div>
                  <div className="truncate text-sm font-semibold text-foreground">
                    {snapshot.mission.title || 'Active Mission'}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                No delegated worker nodes yet. As the orchestrator generates a plan or spawns
                specialists, each task, dependency edge, worktree, and model route will appear here
                in real time.
              </p>
            </div>
          </div>
        ) : canvasMode === 'swimlane' ? (
          <SwimlaneTimeline
            snapshot={snapshot}
            selectedNodeId={selectedNodeId}
            onSelectScope={handleSelectScope}
          />
        ) : canvasMode === 'pipeline' ? (
          <DependencyPipeline
            snapshot={snapshot}
            selectedNodeId={selectedNodeId}
            onSelectScope={handleSelectScope}
          />
        ) : (
          <ReactFlow<SchematicFlowNode, Edge>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={schematicNodeTypes}
            onNodeClick={onNodeClick}
            onInit={(instance) => {
              flowInstanceRef.current = instance;
            }}
            fitView
            fitViewOptions={{ padding: 0.24 }}
            minZoom={0.25}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
            className="bg-background"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="hsl(var(--muted-foreground) / 0.22)"
            />
            <Controls
              showInteractive={false}
              className="!border !border-border !bg-card !text-card-foreground !shadow-sm [&>button]:!border-border [&>button]:!bg-card [&>button]:!text-foreground [&>button:hover]:!bg-accent"
            />
            <MiniMap
              pannable
              zoomable
              nodeColor="hsl(var(--primary) / 0.55)"
              maskColor="hsl(var(--background) / 0.72)"
              className="!border !border-border !bg-card/90 !shadow-sm"
            />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

export default SchematicCanvas;
