import { AlertCircle, ArrowRight, Bot, Check, ChevronRight, Loader2, MessageSquareText, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  ManualSwarmMember,
  ManualSwarmSubagent,
  ManualSwarmSummary,
  ManualToolItem,
} from '@/stores/manual-store';

export const SWARM_COORDINATION_TOOLS = new Set([
  'read_board',
  'post_message',
  'swarm_wait',
  'swarm',
]);

type EnrichedState = 'working' | 'waiting' | 'done' | 'stopped' | 'killed' | 'failed' | 'running' | 'completed';

function resolveLiveState(
  tool: ManualToolItem,
  member?: ManualSwarmMember,
  subagent?: ManualSwarmSubagent,
): EnrichedState {
  if (tool.status === 'failed') return 'failed';
  if (member) {
    if (member.state === 'killed') return 'killed';
    if (member.state === 'stopped') return 'stopped';
    if (member.state === 'working') return 'working';
    if (member.completedSignaled) return 'done';
    return 'waiting';
  }
  if (subagent) {
    if (subagent.state === 'alive') return tool.status === 'completed' ? 'done' : 'working';
    if (subagent.state === 'stopped') return 'stopped';
  }
  return tool.status === 'running' ? 'running' : 'completed';
}

function StateIndicator({ state }: { state: EnrichedState }) {
  if (state === 'working' || state === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
        <Loader2 aria-label="Running" className="h-3 w-3 animate-spin" />
        Working
      </span>
    );
  }
  if (state === 'waiting') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Waiting
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
        <AlertCircle aria-label="Failed" className="h-3 w-3" />
        Failed
      </span>
    );
  }
  if (state === 'killed' || state === 'stopped') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        {state === 'killed' ? 'Killed' : 'Stopped'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
      <Check aria-label="Completed" className="h-3 w-3" />
      Done
    </span>
  );
}

export function SubagentActivityCards({
  subagents,
  swarm,
  onOpenSubagent,
}: {
  subagents: ManualToolItem[];
  swarm?: ManualSwarmSummary;
  onOpenSubagent?: (conversationId: string, label?: string) => void;
}) {
  if (!subagents.length) return null;

  const memberByConv = new Map<string, ManualSwarmMember>();
  const memberByName = new Map<string, ManualSwarmMember>();
  for (const m of swarm?.members || []) {
    if (m.conversationId) memberByConv.set(m.conversationId.toLowerCase(), m);
    memberByName.set(m.name.toLowerCase(), m);
  }
  const subagentByConv = new Map<string, ManualSwarmSubagent>();
  for (const s of swarm?.subagents || []) {
    if (s.conversationId) subagentByConv.set(s.conversationId.toLowerCase(), s);
  }

  return (
    <div className="space-y-1.5" aria-label="Subagents">
      {subagents.map((t) => {
        const convId = t.subagent?.conversationId;
        const member = convId
          ? memberByConv.get(convId.toLowerCase())
          : (t.subagent?.role ? memberByName.get(t.subagent.role.toLowerCase()) : undefined);
        const subagentMeta = convId ? subagentByConv.get(convId.toLowerCase()) : undefined;
        const liveState = resolveLiveState(t, member, subagentMeta);
        const label = member?.name || t.subagent?.role || t.summary;
        const badge = [
          member?.workspaceMode ? `swarm · ${member.workspaceMode}` : t.subagent?.typeName,
          member?.model || t.subagent?.model,
        ].filter(Boolean).join(' · ');
        const isSwarm = t.name === 'swarm' || Boolean(member) || (t.subagent?.typeName || '').startsWith('swarm');
        const Icon = isSwarm ? Users : Bot;
        const hasExpandable = Boolean(t.detail || t.output);

        return (
          <details
            key={t.id}
            className="group rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-xs transition-colors open:border-border"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 select-none">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {hasExpandable && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                )}
                <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate font-medium text-foreground">{label}</span>
                {badge && (
                  <span className="shrink-0 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {badge}
                  </span>
                )}
                {t.detail && (
                  <span className="hidden min-w-0 flex-1 truncate text-muted-foreground/80 sm:inline group-open:hidden">
                    {t.detail}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StateIndicator state={liveState} />
                {convId && onOpenSubagent && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-primary hover:bg-primary/10 hover:text-primary"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenSubagent(convId, label);
                    }}
                  >
                    Inspect
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                )}
              </div>
            </summary>

            {hasExpandable && (
              <div className="mt-2 space-y-2 border-t border-border/50 pt-2 text-xs">
                {t.detail && (
                  <div>
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Assignment
                    </div>
                    <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
                      {t.detail}
                    </p>
                  </div>
                )}
                {t.output && (
                  <div>
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Output
                    </div>
                    <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                      {t.output}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}

export function SwarmCoordinationGroup({
  tools,
}: {
  tools: ManualToolItem[];
}) {
  if (!tools.length) return null;

  return (
    <details className="group rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 select-none text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        <span className="font-medium text-foreground/90">
          Swarm coordination ({tools.length})
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/80 group-open:hidden">
          {tools.map((t) => t.summary || t.name).join(' · ')}
        </span>
      </summary>
      <div className="mt-2 space-y-1.5 border-l-2 border-border/60 pl-3">
        {tools.map((t) => (
          <div key={t.id} className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground/90">{t.summary || t.name}</div>
              {t.detail && (
                <div className="truncate text-[11px] text-muted-foreground">{t.detail}</div>
              )}
            </div>
            <StateIndicator state={t.status === 'failed' ? 'failed' : t.status === 'running' ? 'running' : 'completed'} />
          </div>
        ))}
      </div>
    </details>
  );
}
