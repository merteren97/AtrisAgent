import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleDotDashed, TerminalSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/mission-store';

interface ActivityGroupProps {
  items: TimelineItem[];
}

const ROLE_LABELS: Record<string, string> = {
  orchestrator: 'Orchestrator',
  builder: 'Builder',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  qa: 'QA',
};

const DETAIL_KEYS = [
  'toolName',
  'taskId',
  'agentInstanceId',
  'role',
  'model',
  'path',
  'changeType',
  'progress',
  'percentage',
  'success',
  'result',
  'error',
];

function readableEventType(value?: string): string {
  return (value || 'activity').replace(/_/g, ' ');
}

function detailEntries(metadata?: Record<string, unknown>): Array<[string, string]> {
  if (!metadata) return [];
  return DETAIL_KEYS.flatMap((key) => {
    const value = metadata[key];
    if (value === undefined || value === null || value === '') return [];
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized) return [];
    return [[key, serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized] as [string, string]];
  });
}

export function ActivityGroup({ items }: ActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const role = items.find((item) => item.agentRole)?.agentRole || 'agent';
  const label = ROLE_LABELS[role] || role.charAt(0).toUpperCase() + role.slice(1);
  const latest = items[items.length - 1];
  const summary = useMemo(() => {
    const types = new Set(items.map((item) => readableEventType(item.eventType)));
    const latestContent = latest?.content?.trim();
    if (latestContent) return latestContent;
    return `${types.size} activity type${types.size === 1 ? '' : 's'}`;
  }, [items, latest]);

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-left transition-colors',
          'hover:border-border hover:bg-card/70',
          expanded && 'border-border bg-card/65',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground">
          <CircleDotDashed className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-medium text-foreground/90">{label} activity</span>
            <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[9px] font-medium">{items.length}</Badge>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{latest?.timestamp}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{summary}</div>
        </div>
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="ml-3 mt-1.5 space-y-1.5 border-l border-border/70 pl-4">
          {items.map((item) => {
            const details = detailEntries(item.metadata);
            return (
              <div key={item.id} className="rounded-md border border-border/45 bg-background/35 px-2.5 py-2">
                <div className="flex min-w-0 items-start gap-2">
                  <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-foreground/80">{item.content}</span>
                      <span className="shrink-0 text-[9px] text-muted-foreground/60">{item.timestamp}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px] capitalize text-muted-foreground">
                        {readableEventType(item.eventType)}
                      </Badge>
                      {item.agentRole && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                          {ROLE_LABELS[item.agentRole] || item.agentRole}
                        </Badge>
                      )}
                    </div>
                    {details.length > 0 && (
                      <details className="mt-1.5 text-[10px] text-muted-foreground">
                        <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
                        <dl className="mt-1.5 space-y-1 rounded border border-border/50 bg-muted/15 p-2 font-mono">
                          {details.map(([key, value]) => (
                            <div key={`${item.id}-${key}`} className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
                              <dt className="truncate text-muted-foreground/70">{key}</dt>
                              <dd className="break-all text-foreground/75">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
