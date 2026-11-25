import { useState } from 'react';
import { ChevronDown, ChevronUp, MessageSquareText, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ManualSwarmMember, ManualSwarmSummary } from '@/stores/manual-store';

function memberDotClass(member: ManualSwarmMember): string {
  if (member.state === 'killed' || member.state === 'stopped') return 'bg-muted-foreground/50';
  if (member.state === 'working') return 'bg-primary animate-pulse';
  if (member.completedSignaled) return 'bg-emerald-400';
  return 'bg-amber-400';
}

function memberStatusLabel(member: ManualSwarmMember): string {
  if (member.state === 'killed') return 'Killed';
  if (member.state === 'stopped') return 'Stopped';
  if (member.state === 'working') return 'Working';
  if (member.completedSignaled) return 'Done';
  return 'Waiting';
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  return model.replace(/^gemini-\d+-/i, '').replace(/-medium$/i, ' med').replace(/-high$/i, ' high');
}

export function ManualSwarmPanel({
  swarm,
  onOpenOverview,
  onOpenBoard,
  onInspectWorker,
}: {
  swarm: ManualSwarmSummary;
  onOpenOverview: () => void;
  onOpenBoard: () => void;
  onInspectWorker: (conversationId: string, label: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const workers = swarm.members.filter((m) => m.role !== 'coordinator');
  const workingCount = workers.filter((m) => m.state === 'working').length;
  const waitingCount = workers.filter((m) => m.state === 'waiting' && !m.completedSignaled).length;
  const doneCount = workers.filter((m) => m.state === 'waiting' && Boolean(m.completedSignaled)).length;
  const stoppedCount = workers.filter((m) => m.state === 'stopped' || m.state === 'killed').length;

  const counts = [
    workingCount ? `${workingCount} working` : null,
    waitingCount ? `${waitingCount} waiting` : null,
    doneCount ? `${doneCount} done` : null,
    stoppedCount ? `${stoppedCount} stopped` : null,
  ].filter(Boolean).join(' · ');

  const title = swarm.title || swarm.goal?.title || 'Active Swarm';

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 border-b border-border/40 px-6 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left text-xs hover:text-foreground"
        >
          <Users className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">{title}</span>
          {counts && (
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              · {counts}
            </span>
          )}
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onOpenOverview}
          >
            Roster
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={onOpenBoard}
          >
            <MessageSquareText className="h-3 w-3 text-primary" />
            Board ({swarm.totalBoardCount})
          </Button>
        </div>
      </div>

      {!collapsed && (swarm.members.length > 0 || swarm.subagents.length > 0) && (
        <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {swarm.members.map((member) => {
            const isCoordinator = member.role === 'coordinator';
            const modelBadge = shortModel(member.model);
            const statusText = memberStatusLabel(member);
            return (
              <button
                key={member.name}
                type="button"
                title={[member.name, statusText, member.model, member.task].filter(Boolean).join(' · ')}
                onClick={() => {
                  if (isCoordinator) onOpenOverview();
                  else onInspectWorker(member.conversationId, member.name);
                }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-foreground transition-colors hover:border-primary/40 hover:bg-muted/60"
              >
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${memberDotClass(member)}`} />
                <span className="font-medium">{member.name}</span>
                {isCoordinator && (
                  <span className="rounded bg-primary/15 px-1 text-[9px] font-medium text-primary">
                    coord
                  </span>
                )}
                {modelBadge && (
                  <span className="text-[10px] text-muted-foreground">{modelBadge}</span>
                )}
              </button>
            );
          })}

          {swarm.subagents
            .filter((s) => !swarm.members.some((m) => m.conversationId === s.conversationId))
            .map((sub) => (
              <button
                key={sub.conversationId}
                type="button"
                title={`${sub.role}${sub.model ? ` · ${sub.model}` : ''}`}
                onClick={() => onInspectWorker(sub.conversationId, sub.role)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-foreground transition-colors hover:border-primary/40 hover:bg-muted/60"
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${
                    sub.state === 'alive' ? 'bg-primary animate-pulse' : 'bg-muted-foreground/50'
                  }`}
                />
                <span className="font-medium">{sub.role}</span>
                {sub.model && (
                  <span className="text-[10px] text-muted-foreground">{shortModel(sub.model)}</span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
