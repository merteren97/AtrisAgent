import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import type { ManualAgent } from '@/stores/manual-store';
import type { TerminalSnapshot } from './manual-terminal';
import { activityNotice, useManualActivity } from './manual-activity';
import { useManualStore } from '@/stores/manual-store';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, X } from 'lucide-react';

const cliName = (kind: string) => ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }[kind] || kind);

export interface ManualAgentSwitcherProps {
  agents: ManualAgent[];
  selectedId?: string;
  statuses: Record<string, TerminalSnapshot['status']>;
  hidden: Record<string, boolean>;
  pending: boolean;
  onSelect: (id: string) => void;
  onDelete: (agent: ManualAgent) => void;
  onAdd?: () => void;
  canAdd?: boolean;
}

export function ManualAgentSwitcher({
  agents,
  selectedId,
  statuses,
  hidden,
  pending,
  onSelect,
  onDelete,
  onAdd,
  canAdd = true,
}: ManualAgentSwitcherProps) {
  const visible = agents.filter(agent => !hidden[agent.id]);
  const observations = useManualActivity(state => state.agents);
  const acknowledged = useManualStore(state => state.acknowledgedActivity);

  return (
    <nav aria-label="Chat agents" className="flex min-w-0 flex-1 items-end overflow-hidden">
      <div
        role="tablist"
        aria-label="Agent tabs"
        className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visible.map((agent, index) => {
          const isSelected = selectedId === agent.id;
          const notice = activityNotice(observations[agent.id], acknowledged[agent.id]);
          const isOffline = statuses[agent.id] && statuses[agent.id] !== 'open';
          const isWorking = observations[agent.id]?.state === 'working';

          return (
            <div
              key={agent.id}
              className={`group relative -mb-px flex min-w-24 max-w-48 flex-1 items-center rounded-t-xl border border-b-0 transition-colors ${
                isSelected
                  ? 'border-border bg-background text-foreground z-10'
                  : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                id={`manual-tab-${agent.id}`}
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                title={`${agent.name} · ${cliName(agent.runtimeType)} · ${
                  notice === 'attention'
                    ? 'Needs your attention'
                    : notice === 'completed'
                    ? 'Turn finished'
                    : statuses[agent.id] || 'Checking session'
                }`}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-tl-xl pl-3 pr-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onSelect(agent.id)}
                onKeyDown={event => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    const nextIndex =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                        ? visible.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
                    onSelect(visible[nextIndex].id);
                    document.getElementById(`manual-tab-${visible[nextIndex].id}`)?.focus();
                  }
                }}
              >
                <RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{agent.name}</span>

                {isWorking ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                ) : notice ? (
                  <span
                    className={`shrink-0 text-[10px] font-semibold ${
                      notice === 'attention' ? 'text-amber-500' : 'text-emerald-500'
                    }`}
                  >
                    {notice === 'attention' ? 'Attention' : 'Done'}
                  </span>
                ) : isOffline ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">Offline</span>
                ) : null}
              </button>

              <button
                type="button"
                disabled={pending}
                aria-label={`Delete agent: ${agent.name}`}
                title={`Delete ${agent.name}`}
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-accent hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
                onClick={e => {
                  e.stopPropagation();
                  onDelete(agent);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {!visible.length && (
          <span className="pb-2 text-xs text-muted-foreground">No agents. Click + to add one.</span>
        )}

        {onAdd && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="mb-0.5 h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            aria-label="Add agent"
            title={canAdd ? 'Add independent agent' : '30-agent limit reached'}
            disabled={!canAdd}
            onClick={onAdd}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
    </nav>
  );
}
