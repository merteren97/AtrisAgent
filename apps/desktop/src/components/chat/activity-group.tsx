import { useMemo, useState } from 'react';
import { ChevronRight, Workflow } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/mission-store';
import { EventCard } from './event-card';

const ROLE_LABELS: Record<string, string> = {
  orchestrator: 'Orchestrator',
  builder: 'Builder',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  qa: 'QA',
  agent: 'Agent',
};

export function ActivityGroup({ items }: { items: TimelineItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const roles = useMemo(
    () => [...new Set(items.map((item) => item.agentRole).filter((role): role is string => Boolean(role)))],
    [items],
  );
  const toolCount = items.filter((item) => item.eventType === 'tool_call_started' || item.eventType === 'agent_tool_call').length;
  const latest = items[items.length - 1];
  const first = items[0];
  const title = roles.length === 1
    ? `${ROLE_LABELS[roles[0]] || roles[0]} activity`
    : 'Agent activity';

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/35 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
        aria-expanded={expanded}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-muted-foreground">
          <Workflow className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-semibold text-foreground/85">{title}</span>
            <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[9px] font-medium">
              {items.length} events
            </Badge>
            {toolCount > 0 && (
              <Badge variant="outline" className="hidden h-4 shrink-0 px-1.5 text-[9px] font-normal text-muted-foreground sm:inline-flex">
                {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">{latest?.content || 'Workflow activity'}</span>
            <span className="shrink-0">{first?.timestamp === latest?.timestamp ? latest?.timestamp : `${first?.timestamp}–${latest?.timestamp}`}</span>
          </div>
        </div>
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="border-t border-border/50 bg-background/25 px-3 py-2">
          <div className="ml-1 border-l border-border/60 pl-3">
            {items.map((item) => (
              <EventCard
                key={item.id}
                eventType={item.eventType || 'event'}
                content={item.content}
                timestamp={item.timestamp}
                agentRole={item.agentRole}
                metadata={item.metadata}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
