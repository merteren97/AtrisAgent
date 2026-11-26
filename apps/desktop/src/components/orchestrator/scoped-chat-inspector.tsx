import { useMemo, useState, type KeyboardEvent } from 'react';
import type { RuntimeType } from '@atris-agent-code/domain';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  Clock3,
  FileCode2,
  FolderGit2,
  Loader2,
  MessageSquare,
  Package,
  Send,
  ShieldAlert,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatChangeSummary } from '@/components/chat/chat-change-summary';
import { ChatComposer } from '@/components/composer/chat-composer';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { EventCard } from '@/components/chat/event-card';
import { ChangesTab } from '@/components/inspector/changes-tab';
import { ArtifactsTab } from '@/components/inspector/artifacts-tab';
import { ChecksTab } from '@/components/inspector/checks-tab';
import { LiveProcesses } from '@/components/processes/live-processes';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { TurnProcessView } from '@/components/shared/TurnProcessView';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useAccountStore } from '@/stores/account-store';
import { useAgentStore } from '@/stores/agent-store';
import { useMissionStore, type TimelineItem } from '@/stores/mission-store';
import { useOrchestrationGraphStore } from '@/stores/orchestration-graph-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

export type ScopedInspectorSubTab = 'chat' | 'diff' | 'artifacts' | 'console';

const KNOWN_RUNTIMES = new Set<string>(['codex', 'claude_code', 'antigravity', 'opencode']);

function asRuntimeType(value?: string | null): RuntimeType | null {
  return value && KNOWN_RUNTIMES.has(value) ? (value as RuntimeType) : null;
}

function statusBadgeVariant(status?: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (!status) return 'outline';
  if (status === 'failed' || status === 'blocked' || status === 'rejected') return 'destructive';
  if (status === 'running' || status === 'working' || status === 'completed' || status === 'done') return 'default';
  return 'secondary';
}

function WorkerScopedChat({
  missionId,
  agentId,
  taskId,
}: {
  missionId: string;
  agentId: string | null;
  taskId: string | null;
}) {
  const snapshot = useOrchestrationGraphStore((state) => state.snapshotsByMission[missionId]);
  const hydrateMissionGraph = useOrchestrationGraphStore((state) => state.hydrateMissionGraph);
  const timeline = useMissionStore((state) => state.timeline);
  const storeAgents = useAgentStore((state) => state.agents);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const runtimes = useAccountStore((state) => state.runtimes);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<{ effective: string; reason?: string } | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const graphAgent = snapshot?.agents.find((a) => a.id === agentId)
    || (taskId ? snapshot?.agents.find((a) => a.taskId === taskId) : undefined);
  const storeAgent = storeAgents.find((a) => a.id === (graphAgent?.id || agentId));
  const graphTask = snapshot?.tasks.find((t) => t.id === (taskId || graphAgent?.taskId));
  const latestAttempt = useMemo(() => {
    const targetAgentId = graphAgent?.id || agentId;
    const targetTaskId = graphTask?.id || taskId;
    const matching = (snapshot?.attempts || []).filter(
      (att) => (targetAgentId && att.agentInstanceId === targetAgentId) || (targetTaskId && att.taskId === targetTaskId),
    );
    return matching.sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  }, [snapshot?.attempts, graphAgent?.id, agentId, graphTask?.id, taskId]);

  const effectiveAgentId = graphAgent?.id || agentId || null;
  const runtimeId = graphAgent?.runtimeAdapterId || latestAttempt?.routeAdapterId || '';
  const caps = snapshot?.runtimeCapabilities?.[runtimeId]
    || runtimes.find((r) => r.runtimeType === runtimeId)?.adapterCapabilities;
  const agentStatus = graphAgent?.status || storeAgent?.status || 'idle';
  const canLiveSteer = Boolean(caps?.liveSteer && agentStatus === 'running');

  const pendingApprovals = useMemo(() => {
    if (!snapshot?.approvals?.length) return [];
    const targetTaskId = graphTask?.id || taskId;
    return snapshot.approvals.filter(
      (approval) => approval.status === 'pending' && (!targetTaskId || approval.taskId === targetTaskId),
    );
  }, [snapshot?.approvals, graphTask?.id, taskId]);

  const workerTimeline = useMemo(() => {
    const targetAgentId = effectiveAgentId;
    const targetTaskId = graphTask?.id || taskId;
    return timeline.filter((item: TimelineItem) => {
      if (item.eventType?.startsWith('process_')) return false;
      const metaAgentId = typeof item.metadata?.agentInstanceId === 'string' ? item.metadata.agentInstanceId : undefined;
      const metaTaskId = typeof item.metadata?.taskId === 'string' ? item.metadata.taskId : undefined;
      if (targetAgentId && metaAgentId === targetAgentId) return true;
      if (targetTaskId && metaTaskId === targetTaskId) return true;
      return false;
    });
  }, [timeline, effectiveAgentId, graphTask?.id, taskId]);

  const workerDirectives = useMemo(() => {
    if (!effectiveAgentId || !snapshot?.directives?.length) return [];
    return snapshot.directives.filter((d) => d.targetAgentId === effectiveAgentId);
  }, [snapshot?.directives, effectiveAgentId]);

  const decideApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setApprovalBusy(approvalId);
    setApprovalError(null);
    try {
      await apiRequest(`/approvals/${encodeURIComponent(approvalId)}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await hydrateMissionGraph(missionId);
    } catch (cause) {
      setApprovalError(cause instanceof Error ? cause.message : 'Approval decision failed.');
    } finally {
      setApprovalBusy(null);
    }
  };

  const sendWorkerDirective = async () => {
    const content = draft.trim();
    if (!content || !effectiveAgentId || sending) return;
    setSending(true);
    setSendError(null);
    setDeliveryNotice(null);
    try {
      const response = await apiRequest<{
        deliveredLive?: boolean;
        effectiveDelivery?: 'live_steer' | 'queued_directive';
        reason?: string;
      }>(`/missions/${encodeURIComponent(missionId)}/agents/${encodeURIComponent(effectiveAgentId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, delivery: 'steer' }),
      });
      setDraft('');
      setDeliveryNotice({
        effective: response.effectiveDelivery || (response.deliveredLive ? 'live_steer' : 'queued_directive'),
        reason: response.reason,
      });
      await hydrateMissionGraph(missionId);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Failed to send directive to worker.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void sendWorkerDirective();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Worker metadata bar */}
      {(latestAttempt || graphTask) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/70 bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
          {latestAttempt && (
            <span>Attempt #{latestAttempt.attemptNumber} · <span className="capitalize text-foreground/80">{latestAttempt.status}</span></span>
          )}
          {latestAttempt?.worktreePath && (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[10px]" title={latestAttempt.worktreePath}>
              <FolderGit2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{latestAttempt.worktreePath}</span>
            </span>
          )}
          {latestAttempt?.routeReasoningLevel && (
            <span>Reasoning: <strong className="font-medium text-foreground/80">{latestAttempt.routeReasoningLevel}</strong></span>
          )}
        </div>
      )}

      {/* Pending approvals for this worker/task */}
      {pendingApprovals.length > 0 && (
        <div className="shrink-0 space-y-2 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2.5">
          {pendingApprovals.map((approval) => (
            <div key={approval.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
                <span className="min-w-0 truncate font-medium text-foreground">
                  {approval.description || `${approval.type.replace(/_/g, ' ')} approval required`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={approvalBusy === approval.id}
                  onClick={() => void decideApproval(approval.id, 'approved')}
                >
                  {approvalBusy === approval.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={approvalBusy === approval.id}
                  onClick={() => void decideApproval(approval.id, 'rejected')}
                >
                  <X className="mr-1 h-3 w-3" />
                  Reject
                </Button>
              </div>
            </div>
          ))}
          {approvalError && <p role="alert" className="text-xs text-destructive">{approvalError}</p>}
        </div>
      )}

      {/* Worker transcript */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {graphTask?.description && (
            <div className="rounded-xl border border-border/70 bg-card/60 p-3 text-xs">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Task Assignment
              </div>
              <p className="font-medium text-foreground">{graphTask.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{graphTask.description}</p>
            </div>
          )}

          {workerDirectives.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Directives
              </div>
              {workerDirectives.map((dir) => (
                <div key={dir.id} className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="font-medium text-primary">You → Worker</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px] capitalize">{dir.status}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-foreground/90">{dir.content}</p>
                </div>
              ))}
            </div>
          )}

          {workerTimeline.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-xs text-muted-foreground">
              <Bot className="mb-2 h-7 w-7 opacity-30" />
              <p>
                {effectiveAgentId
                  ? 'No transcript events recorded for this worker yet.'
                  : 'No worker has been assigned to this task yet.'}
              </p>
            </div>
          ) : (
            workerTimeline.map((item) => {
              if (item.eventType === 'agent_thought') {
                return (
                  <TurnProcessView
                    key={item.id}
                    thinking={item.content}
                    cwd={activeWorkspace?.path}
                  />
                );
              }
              if (item.eventType === 'agent_tool_call' || item.eventType === 'tool_call_started' || item.eventType === 'tool_call_completed') {
                return (
                  <TurnProcessView
                    key={item.id}
                    tools={[{
                      id: item.id,
                      name: String(item.metadata?.toolName || item.eventType || 'tool'),
                      summary: item.content || String(item.metadata?.toolName || 'Tool call'),
                      status: item.eventType === 'tool_call_started' ? 'running' : item.metadata?.failed ? 'failed' : 'completed',
                    }]}
                    cwd={activeWorkspace?.path}
                  />
                );
              }
              if (item.type === 'orchestrator_message') {
                return (
                  <div key={item.id} className="rounded-xl border border-border/60 bg-card/70 px-3.5 py-2.5 text-sm">
                    <MarkdownContent content={item.content} cwd={activeWorkspace?.path} />
                  </div>
                );
              }
              return (
                <EventCard
                  key={item.id}
                  eventType={item.eventType || 'event'}
                  content={item.content}
                  timestamp={item.timestamp}
                  agentRole={item.agentRole}
                  metadata={item.metadata}
                />
              );
            })
          )}

          {latestAttempt?.resultSummary && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                Attempt Summary
              </div>
              <MarkdownContent content={latestAttempt.resultSummary} cwd={activeWorkspace?.path} />
            </div>
          )}

          {latestAttempt?.error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                <AlertCircle className="h-3.5 w-3.5" />
                Attempt Error
              </div>
              <p className="whitespace-pre-wrap">{latestAttempt.error}</p>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Direct Worker Steering Composer */}
      <div className="shrink-0 border-t border-border bg-background p-3">
        <div className="rounded-xl border border-input bg-card p-2.5 shadow-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15">
          <textarea
            aria-label="Send directive to worker"
            rows={2}
            disabled={!effectiveAgentId || sending}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSendError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              !effectiveAgentId
                ? 'Waiting for a worker to be assigned…'
                : canLiveSteer
                  ? 'Steer this active worker mid-turn…'
                  : 'Queue a directive for this worker…'
            }
            className="block w-full resize-none bg-transparent text-xs leading-5 outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
            <div className="flex items-center gap-1.5">
              {canLiveSteer ? (
                <Badge variant="secondary" className="gap-1 bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-400">
                  <Zap className="h-2.5 w-2.5" />
                  Live Steer
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                  <Clock3 className="h-2.5 w-2.5" />
                  Queue Directive
                </Badge>
              )}
              {runtimeId && (
                <span className="text-[10px] text-muted-foreground">{runtimeId}</span>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              disabled={!effectiveAgentId || sending || !draft.trim()}
              onClick={() => void sendWorkerDirective()}
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </Button>
          </div>
        </div>
        {sendError && <p role="alert" className="mt-1.5 text-xs text-destructive">{sendError}</p>}
        {deliveryNotice && (
          <p role="status" className="mt-1.5 text-[11px] text-muted-foreground">
            Delivered as <strong>{deliveryNotice.effective === 'live_steer' ? 'Live Steer' : 'Queued Directive'}</strong>
            {deliveryNotice.reason ? ` · ${deliveryNotice.reason}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}

export function ScopedChatInspector({
  missionId,
  activeSubTab: controlledSubTab,
  onSubTabChange,
}: {
  missionId?: string | null;
  activeSubTab?: ScopedInspectorSubTab;
  onSubTabChange?: (tab: ScopedInspectorSubTab) => void;
}) {
  const [internalSubTab, setInternalSubTab] = useState<ScopedInspectorSubTab>('chat');
  const activeSubTab = controlledSubTab ?? internalSubTab;
  const setSubTab = onSubTabChange ?? setInternalSubTab;

  const selectedNodeId = useOrchestrationGraphStore((state) => state.selectedNodeId);
  const selectedAgentId = useOrchestrationGraphStore((state) => state.selectedAgentId);
  const selectNode = useOrchestrationGraphStore((state) => state.selectNode);
  const snapshot = useOrchestrationGraphStore((state) => (missionId ? state.snapshotsByMission[missionId] : undefined));
  const missions = useMissionStore((state) => state.missions);
  const storeAgents = useAgentStore((state) => state.agents);

  const mission = missions.find((m) => m.id === missionId);
  const isWorkerScoped = Boolean(missionId && (selectedNodeId || selectedAgentId));

  const selectedTask = isWorkerScoped
    ? snapshot?.tasks.find((t) => t.id === selectedNodeId)
    : undefined;
  const selectedGraphAgent = isWorkerScoped
    ? snapshot?.agents.find((a) => a.id === selectedAgentId)
      || (selectedTask ? snapshot?.agents.find((a) => a.taskId === selectedTask.id) : undefined)
    : undefined;
  const selectedStoreAgent = isWorkerScoped
    ? storeAgents.find((a) => a.id === (selectedGraphAgent?.id || selectedAgentId))
    : undefined;

  const workerDisplayName = selectedGraphAgent?.displayName
    || selectedStoreAgent?.displayName
    || selectedTask?.title
    || (selectedGraphAgent?.role ? `${selectedGraphAgent.role} worker` : 'Worker');
  const workerRuntime = asRuntimeType(selectedGraphAgent?.runtimeAdapterId);
  const workerStatus = selectedGraphAgent?.status || selectedStoreAgent?.status || selectedTask?.status;
  const workerModel = selectedGraphAgent?.modelProfileId || selectedStoreAgent?.model || selectedTask?.routePreference?.modelDisplayName;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card/60 shadow-sm">
      {/* Header scope bar */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {isWorkerScoped ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => selectNode(null, null)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Orchestrator
              </Button>
              <span className="h-4 w-px bg-border" />
              {workerRuntime ? (
                <RuntimeBrandIcon runtimeId={workerRuntime} className="h-3.5 w-3.5 shrink-0 text-foreground" />
              ) : (
                <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
              <span className="min-w-0 truncate text-xs font-semibold text-foreground" title={workerDisplayName}>
                {workerDisplayName}
              </span>
              {selectedGraphAgent?.sandboxTier && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
                  {selectedGraphAgent.sandboxTier}
                </Badge>
              )}
              {workerModel && (
                <Badge variant="secondary" className="hidden h-5 max-w-[140px] truncate px-1.5 text-[10px] sm:inline-flex">
                  {workerModel}
                </Badge>
              )}
              {workerStatus && (
                <Badge variant={statusBadgeVariant(workerStatus)} className="h-5 px-1.5 text-[10px] capitalize">
                  {workerStatus}
                </Badge>
              )}
            </>
          ) : (
            <>
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <span className="truncate text-xs font-semibold text-foreground">
                {mission ? mission.title : 'Orchestrator (Mission)'}
              </span>
              {mission?.status && (
                <Badge variant={statusBadgeVariant(mission.status)} className="h-5 px-1.5 text-[10px] capitalize">
                  {mission.status.replace(/_/g, ' ')}
                </Badge>
              )}
            </>
          )}
        </div>

        {/* Sub-tabs */}
        <nav aria-label="Inspector sections" className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/30 p-0.5">
          {([
            { id: 'chat', label: 'Chat', icon: MessageSquare },
            { id: 'diff', label: 'Diff & Review', icon: FileCode2 },
            { id: 'artifacts', label: 'Artifacts & Checks', icon: Package },
            { id: 'console', label: 'Console', icon: Terminal },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeSubTab === tab.id ? 'page' : undefined}
              onClick={() => setSubTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                activeSubTab === tab.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <tab.icon className="h-3 w-3 shrink-0" />
              <span className="hidden xl:inline">{tab.label}</span>
              <span className="xl:hidden">
                {tab.id === 'diff' ? 'Diff' : tab.id === 'artifacts' ? 'Checks' : tab.label}
              </span>
            </button>
          ))}
        </nav>
      </header>

      {/* Body */}
      {activeSubTab === 'chat' ? (
        isWorkerScoped && missionId ? (
          <WorkerScopedChat
            missionId={missionId}
            agentId={selectedGraphAgent?.id || selectedAgentId}
            taskId={selectedNodeId}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <ChatTimeline />
            {missionId && <ChatChangeSummary endpoint={`/missions/${encodeURIComponent(missionId)}/changes`} />}
            <ChatComposer />
          </div>
        )
      ) : activeSubTab === 'diff' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChangesTab />
        </div>
      ) : activeSubTab === 'artifacts' ? (
        <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-border overflow-hidden">
          <div className="min-h-0 overflow-hidden">
            <ArtifactsTab />
          </div>
          <div className="min-h-0 overflow-hidden">
            <ChecksTab />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <LiveProcesses />
        </div>
      )}
    </div>
  );
}
