import { useEffect, useMemo, useState } from 'react';
import { Brain, CheckCircle2, FileText, GitBranch, Layers3, Network, Sparkles } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useAgentStore } from '@/stores/agent-store';
import { useMissionStore } from '@/stores/mission-store';

function compactNumber(value?: number): string {
  if (!value) return '—';
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

export function ContextTab() {
  const { activeMissionId, activeTasks, timeline, missions } = useMissionStore();
  const agents = useAgentStore((state) => state.agents);
  const missionAgents = useMemo(
    () => activeMissionId ? agents.filter((agent) => agent.missionId === activeMissionId) : [],
    [activeMissionId, agents],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedAgentId && missionAgents.some((agent) => agent.id === selectedAgentId)) return;
    const preferred = missionAgents.find((agent) => agent.status === 'running')
      || missionAgents.find((agent) => agent.role === 'orchestrator')
      || missionAgents[0];
    setSelectedAgentId(preferred?.id || null);
  }, [missionAgents, selectedAgentId]);

  const selectedAgent = missionAgents.find((agent) => agent.id === selectedAgentId);
  const selectedTask = selectedAgent
    ? activeTasks.find((task) => task.id === selectedAgent.taskId)
      || activeTasks.find((task) => task.assignedAgentId === selectedAgent.id)
    : undefined;
  const activeMission = missions.find((mission) => mission.id === activeMissionId);
  const userRequest = timeline.find((item) => item.type === 'user_message')?.content;
  const contextEvents = timeline.filter((item) => {
    if (!['agent_context_attached', 'agent_context_compacted'].includes(item.eventType || '')) return false;
    const metadata = item.metadata as Record<string, any> | undefined;
    return !selectedAgent || metadata?.agentInstanceId === selectedAgent.id;
  });
  const attachedTokenEstimate = contextEvents
    .filter((item) => item.eventType === 'agent_context_attached')
    .reduce((total, item) => total + (Number((item.metadata as any)?.tokenEstimate) || 0), 0);

  if (!activeMissionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <Layers3 className="mb-3 h-9 w-9 opacity-25" />
        <div className="text-sm font-medium text-foreground">No mission context</div>
        <p className="mt-1 max-w-[230px] text-xs">Open or start a mission to inspect what each agent inherits and uses.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border bg-muted/10 p-3">
        <div className="flex items-center gap-2">
          <Layers3 className="h-3.5 w-3.5 text-primary" />
          <div className="min-w-0">
            <div className="text-xs font-semibold">Context ledger</div>
            <div className="truncate text-[9px] text-muted-foreground">{activeMission?.title || 'Active mission'}</div>
          </div>
        </div>
        {missionAgents.length > 0 && (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            {missionAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => setSelectedAgentId(agent.id)}
                className={cn(
                  'shrink-0 rounded-md border px-2 py-1 text-[9px] transition-colors',
                  selectedAgentId === agent.id
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                )}
              >
                {agent.displayName || agent.specialty || agent.role}
              </button>
            ))}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3 pb-8">
          <Card className="space-y-2.5 border-border/80 bg-card/60 p-3 shadow-none">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                <Network className="h-3 w-3" /> Mission context
              </div>
              <Badge variant="outline" className="h-5 text-[9px]">{activeTasks.length} tasks</Badge>
            </div>
            {userRequest ? (
              <p className="line-clamp-5 text-[11px] leading-relaxed text-foreground/90">{userRequest}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground">The mission request will appear here when it is available in event history.</p>
            )}
          </Card>

          {selectedAgent ? (
            <>
              <Card className="space-y-3 border-border/80 bg-card/60 p-3 shadow-none">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <Brain className="h-3.5 w-3.5 text-primary" />
                      <span className="truncate">{selectedAgent.displayName || selectedAgent.specialty || selectedAgent.role}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[9px] text-muted-foreground">{selectedAgent.model}</div>
                  </div>
                  <Badge variant="outline" className="h-5 shrink-0 text-[9px] capitalize">{selectedAgent.role}</Badge>
                </div>

                <div className="space-y-2">
                  <ContextRow label="Mission requirements" detail="Inherited from the active mission request" />
                  {selectedTask && <ContextRow label="Assigned task" detail={selectedTask.title} />}
                  {selectedAgent.spawnReason && <ContextRow label="Delegation rationale" detail={selectedAgent.spawnReason} icon="sparkles" />}
                  {selectedAgent.workspaceMode && (
                    <ContextRow
                      label="Workspace boundary"
                      detail={selectedAgent.workspaceMode === 'isolated_worktree' ? 'Isolated write worktree' : selectedAgent.workspaceMode === 'read_only' ? 'Read-only workspace context' : 'Shared mission workspace'}
                      icon="branch"
                    />
                  )}
                </div>
              </Card>

              <Card className="border-border/80 bg-card/60 p-3 shadow-none">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Observed context events</div>
                    <p className="mt-0.5 text-[9px] text-muted-foreground">Explicit attachments and compaction events emitted by the runtime.</p>
                  </div>
                  <Badge variant="outline" className="h-5 shrink-0 text-[9px]">{compactNumber(attachedTokenEstimate)} tokens</Badge>
                </div>

                {contextEvents.length ? (
                  <div className="mt-3 space-y-2">
                    {contextEvents.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 bg-muted/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium text-foreground">{item.eventType === 'agent_context_compacted' ? 'Context compacted' : 'Context attached'}</span>
                          <span className="text-[9px] text-muted-foreground">{item.timestamp}</span>
                        </div>
                        <p className="mt-0.5 text-[9px] leading-relaxed text-muted-foreground">{item.content}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-dashed border-border p-3 text-center text-[9px] leading-relaxed text-muted-foreground">
                    No explicit context attachment events yet. Mission, task, delegation reason, and workspace boundary above are already inherited by this agent.
                  </div>
                )}
              </Card>
            </>
          ) : (
            <Card className="border-dashed p-4 text-center shadow-none">
              <FileText className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
              <p className="text-[10px] text-muted-foreground">No agent has been created for this mission yet.</p>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ContextRow({ label, detail, icon }: { label: string; detail: string; icon?: 'sparkles' | 'branch' }) {
  const Icon = icon === 'sparkles' ? Sparkles : icon === 'branch' ? GitBranch : CheckCircle2;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/15 p-2">
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-primary/80" />
      <div className="min-w-0">
        <div className="text-[9px] font-semibold text-foreground">{label}</div>
        <div className="mt-0.5 line-clamp-3 text-[9px] leading-relaxed text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}
