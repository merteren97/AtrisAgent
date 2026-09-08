import { useEffect, useMemo } from 'react';
import {
  Activity,
  Ban,
  Bot,
  Brain,
  Hammer,
  Eye,
  Search,
  Shield,
  Check,
  X,
  Clock3,
  GitBranch,
  MessageSquare,
  Network,
  Sparkles,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { cn } from '@/lib/utils';
import { useAgentStore, type AgentInstance } from '@/stores/agent-store';
import { useMissionStore } from '@/stores/mission-store';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';

type AgentDisplayStatus = AgentInstance['status'] | 'cancelled';

function roleIcon(role: string) {
  const value = role.toLowerCase();
  if (value.includes('orchestrator')) return <Brain className="h-3.5 w-3.5 text-purple-700 dark:text-purple-400" />;
  if (value.includes('builder')) return <Hammer className="h-3.5 w-3.5 text-blue-700 dark:text-blue-400" />;
  if (value.includes('reviewer')) return <Eye className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" />;
  if (value.includes('researcher')) return <Search className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" />;
  if (value.includes('qa')) return <Shield className="h-3 w-3 text-cyan-700 dark:text-cyan-400" />;
  return <Bot className="h-3.5 w-3.5" />;
}

function statusIndicator(status: AgentDisplayStatus) {
  switch (status) {
    case 'running': return <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />;
    case 'waiting': return <Clock3 className="h-3 w-3 text-amber-700 dark:text-amber-400" />;
    case 'completed': return <Check className="h-3 w-3 text-emerald-700 dark:text-emerald-400" />;
    case 'failed': return <X className="h-3 w-3 text-destructive" />;
    case 'paused': return <span className="h-2 w-2 rounded-full bg-warning" />;
    case 'cancelled': return <Ban className="h-3 w-3 text-muted-foreground" />;
    default: return <span className="h-2 w-2 rounded-full bg-muted-foreground/60" />;
  }
}

function effectiveAgentStatus(agent: AgentInstance, missionCancelled: boolean): AgentDisplayStatus {
  if (!missionCancelled) return agent.status;
  if (agent.status === 'completed' || agent.status === 'failed') return agent.status;
  return 'cancelled';
}

function modelForAgent(agent: AgentInstance, models: DiscoveredModel[]): DiscoveredModel | undefined {
  return models.find((model) =>
    model.name === agent.model
    || model.id === agent.model
    || model.catalogId === agent.model
    || model.runtimeModelId === agent.model,
  );
}

function titleForAgent(agent: AgentInstance): string {
  return agent.displayName || agent.specialty || (agent.role.toLowerCase() === 'qa'
    ? 'QA Agent'
    : `${agent.role.charAt(0).toUpperCase()}${agent.role.slice(1)}`);
}

function AgentTreeRow({
  agent,
  allAgents,
  models,
  selectedAgentId,
  depth,
  missionCancelled,
  onSelect,
}: {
  agent: AgentInstance;
  allAgents: AgentInstance[];
  models: DiscoveredModel[];
  selectedAgentId: string | null;
  depth: number;
  missionCancelled: boolean;
  onSelect: (id: string) => void;
}) {
  const children = allAgents.filter((candidate) => candidate.parentAgentId === agent.id);
  const model = modelForAgent(agent, models);
  const displayStatus = effectiveAgentStatus(agent, missionCancelled);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        aria-pressed={selectedAgentId === agent.id}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-lg py-2.5 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selectedAgentId === agent.id ? 'bg-primary/[0.08]' : 'hover:bg-muted/50',
        )}
        style={{ paddingLeft: `${10 + Math.min(depth, 3) * 14}px` }}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/70">
          {model ? <RuntimeBrandIcon runtimeId={model.runtimeType} className="h-3.5 w-3.5" /> : roleIcon(agent.role)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{titleForAgent(agent)}</span>
            {agent.unreadMessages ? <span className="shrink-0 rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{agent.unreadMessages}</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {agent.role} · {model?.name || agent.model || 'Auto route'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] capitalize text-muted-foreground">
          {statusIndicator(displayStatus)}<span>{displayStatus === 'idle' ? 'Queued' : displayStatus}</span>
        </span>
      </button>
      {children.map((child) => (
        <AgentTreeRow
          key={child.id}
          agent={child}
          allAgents={allAgents}
          models={models}
          selectedAgentId={selectedAgentId}
          depth={depth + 1}
          missionCancelled={missionCancelled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function AgentsTab() {
  const { activeMissionId, activeTasks, missions, timeline, missionStateLoading, missionStateError, transportStatus, fetchMissionState } = useMissionStore();
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const discoveredModels = useAccountStore((state) => state.discoveredModels);

  const activeMission = missions.find((mission) => mission.id === activeMissionId);
  const missionCancelled = activeMission?.status === 'cancelled';
  const missionAgents = useMemo(
    () => activeMissionId ? agents.filter((agent) => agent.missionId === activeMissionId) : [],
    [activeMissionId, agents],
  );
  const missionAgentIds = useMemo(() => new Set(missionAgents.map((agent) => agent.id)), [missionAgents]);
  const roots = useMemo(
    () => missionAgents.filter((agent) => !agent.parentAgentId || !missionAgentIds.has(agent.parentAgentId)),
    [missionAgentIds, missionAgents],
  );

  useEffect(() => {
    if (!missionAgents.length) return;
    if (selectedAgentId && missionAgents.some((agent) => agent.id === selectedAgentId)) return;
    const preferred = missionAgents.find((agent) => agent.role.toLowerCase() === 'orchestrator' && !agent.parentAgentId) || roots[0] || missionAgents[0];
    if (preferred) setSelectedAgent(preferred.id);
  }, [missionAgents, roots, selectedAgentId, setSelectedAgent]);

  const selectedAgent = missionAgents.find((agent) => agent.id === selectedAgentId) || roots[0] || missionAgents[0];
  const selectedModel = selectedAgent ? modelForAgent(selectedAgent, discoveredModels) : undefined;
  const selectedTask = selectedAgent
    ? activeTasks.find((task) => task.id === selectedAgent.taskId)
      || activeTasks.find((task) => task.assignedAgentId === selectedAgent.id)
    : undefined;
  const selectedDisplayStatus = selectedAgent ? effectiveAgentStatus(selectedAgent, missionCancelled) : undefined;
  const selectedActivity = useMemo(() => {
    if (!selectedAgent) return [];
    return timeline.filter((item) => {
      const metadata = item.metadata as Record<string, unknown> | undefined;
      return metadata?.agentInstanceId === selectedAgent.id;
    }).slice(-16);
  }, [selectedAgent, timeline]);
  const runningCount = missionCancelled ? 0 : missionAgents.filter((agent) => agent.status === 'running').length;
  const waitingCount = missionCancelled ? 0 : missionAgents.filter((agent) => agent.status === 'waiting').length;
  const completedCount = missionAgents.filter((agent) => agent.status === 'completed').length;
  const planning = Boolean(activeMission && ['draft', 'queued', 'starting', 'planning'].includes(activeMission.status));
  const queuedTasks = activeTasks.filter((task) => !['completed', 'failed', 'cancelled', 'skipped'].includes(task.status)
    && !missionAgents.some((agent) => agent.taskId === task.id || agent.id === task.assignedAgentId));

  if (!missionAgents.length && !queuedTasks.length) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-[240px]">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted/40">
            {missionStateError ? <AlertCircle className="h-4 w-4 text-destructive" /> : missionStateLoading || planning ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none text-primary" /> : missionCancelled ? <Ban className="h-4 w-4 text-muted-foreground" /> : <Network className="h-4 w-4 text-muted-foreground" />}
          </div>
          <h3 className="mt-3 text-sm font-medium">{missionStateError ? 'Team could not be loaded' : missionStateLoading ? 'Loading team…' : planning ? 'Preparing the team' : missionCancelled ? 'Conversation stopped' : 'No agent sessions yet'}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {missionStateError ? 'Refresh to load the latest agent activity.' : planning ? 'The orchestrator is preparing the work. Agents appear here as soon as they are assigned.' : missionCancelled
              ? 'This mission ended before agent sessions were recorded.'
              : 'Start a conversation to follow the team and its progress here.'}
          </p>
          {missionStateError && activeMissionId && <Button variant="outline" size="sm" className="mt-3" onClick={() => void fetchMissionState(activeMissionId)}>Refresh team</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b border-border bg-muted/[0.08] px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold"><Network className="h-3.5 w-3.5 shrink-0 text-primary" />Agent team</div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span><strong className="text-foreground">{runningCount}</strong> active</span>
            {waitingCount > 0 && <span><strong className="text-foreground">{waitingCount}</strong> waiting</span>}
            {completedCount > 0 && <span>{completedCount} done</span>}
            <span>{missionAgents.length} agents</span>
          </div>
        </div>
        {missionCancelled && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/45 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Ban className="mt-0.5 h-3 w-3 shrink-0" />
            <span>Mission cancelled. Unfinished agent sessions are shown as cancelled instead of active.</span>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{transportStatus === 'connected' ? 'Live updates' : transportStatus === 'reconnecting' || transportStatus === 'connecting' ? 'Connecting to live updates…' : 'Showing last reported activity'} · Guide the team from chat.</p>
        {missionStateError && activeMissionId && <div role="status" className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground">
          <span>Could not refresh team details.</span>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={missionStateLoading} onClick={() => void fetchMissionState(activeMissionId)}>Retry</Button>
        </div>}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-0 p-3 pb-8">
          {missionAgents.length > 0 && <section aria-label="Agent team" className="mb-4 min-w-0 overflow-hidden rounded-lg border border-border p-1">
            {roots.map((agent) => <AgentTreeRow key={agent.id} agent={agent} allAgents={missionAgents} models={discoveredModels} selectedAgentId={selectedAgent?.id || null} depth={0} missionCancelled={missionCancelled} onSelect={setSelectedAgent} />)}
          </section>}
          {queuedTasks.length > 0 && <section aria-label="Planned work" className="mb-4">
            <div className="mb-2 flex items-center justify-between text-xs font-medium">Planned work<span className="text-muted-foreground">{queuedTasks.length}</span></div>
            <div className="divide-y divide-border rounded-lg border border-border px-3">
              {queuedTasks.map((task) => <div key={task.id} className="flex items-start gap-2 py-2.5">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0"><p className="break-words text-xs leading-relaxed">{task.title}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{task.assignedRole || 'Agent'} · {task.status === 'running' ? 'Running · awaiting session details' : task.status === 'blocked' ? 'Waiting for dependencies' : 'Awaiting assignment'}</p></div>
              </div>)}
            </div>
          </section>}
          {selectedAgent && selectedDisplayStatus && (
            <section className="mb-3 min-w-0 rounded-xl border border-border bg-card/70 p-3 shadow-sm">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                  {selectedModel ? <RuntimeBrandIcon runtimeId={selectedModel.runtimeType} className="h-4 w-4" /> : roleIcon(selectedAgent.role)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">{titleForAgent(selectedAgent)}</h3>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] capitalize text-muted-foreground">{statusIndicator(selectedDisplayStatus)}{selectedDisplayStatus}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{selectedModel?.name || selectedAgent.model || 'Auto route'} · {selectedAgent.role}</p>
                  {missionCancelled && selectedDisplayStatus === 'cancelled'
                    ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Stopped when the mission was cancelled.</p>
                    : selectedAgent.statusMessage && <p className="mt-1.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{selectedAgent.statusMessage}</p>}
                </div>
              </div>

              {!missionCancelled && selectedAgent.progress !== undefined && (selectedAgent.status === 'running' || selectedAgent.progress > 0) && (
                <div role="progressbar" aria-label={`${titleForAgent(selectedAgent)} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, selectedAgent.progress))} className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, selectedAgent.progress))}%` }} />
                </div>
              )}

              <div className="mt-3 space-y-2 border-t border-border/60 pt-2.5">
                {selectedTask && (
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Current work</div>
                    <div className="mt-0.5 break-words text-[10px] font-medium leading-relaxed text-foreground">{selectedTask.title}</div>
                  </div>
                )}
                {selectedTask && (
                  <details className="min-w-0">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Execution details</summary>
                    {selectedTask.effectiveRoute ? (
                      <div className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-foreground">
                        {[selectedTask.effectiveRoute.adapterId, selectedTask.effectiveRoute.provider, selectedTask.effectiveRoute.runtimeModelId || selectedTask.effectiveRoute.modelCatalogId].filter(Boolean).join(' / ')}
                        {selectedTask.effectiveRoute.reasoningLevel ? ` · ${selectedTask.effectiveRoute.reasoningLevel}` : ''}
                      </div>
                    ) : <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">No execution details reported yet.</p>}
                  </details>
                )}
                {selectedAgent.spawnReason && (
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Sparkles className="h-2.5 w-2.5" />Delegated because</div>
                    <p className="mt-0.5 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground">{selectedAgent.spawnReason}</p>
                  </div>
                )}
                <div className="flex min-w-0 flex-wrap gap-1">
                  {selectedAgent.workspaceMode && <Badge variant="outline" className="h-5 max-w-full px-1.5 text-[10px]"><GitBranch className="mr-1 h-2.5 w-2.5 shrink-0" /><span className="truncate">{selectedAgent.workspaceMode.replaceAll('_', ' ')}</span></Badge>}
                  {selectedAgent.unreadMessages ? <Badge variant="outline" className="h-5 px-1.5 text-[10px]"><MessageSquare className="mr-1 h-2.5 w-2.5" />{selectedAgent.unreadMessages} unread</Badge> : null}
                </div>
              </div>

              <div className="mt-3 border-t border-border/60 pt-2.5">
                <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  <Activity className="h-2.5 w-2.5" />Live activity
                </div>
                {selectedActivity.length ? (
                  <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1">
                    {selectedActivity.map((item) => (
                      <div key={item.id} className="rounded-md border border-border/60 bg-background/55 px-2 py-1.5">
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="min-w-0 truncate font-medium text-muted-foreground">{item.eventType === 'agent_thought' ? 'Progress update' : (item.eventType || item.type).replaceAll('_', ' ')}</span>
                          <span className="ml-auto">{item.timestamp}</span>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/85">{item.content}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">Waiting for the first activity update.</p>
                )}
              </div>
            </section>
          )}

        </div>
      </ScrollArea>
    </div>
  );
}
