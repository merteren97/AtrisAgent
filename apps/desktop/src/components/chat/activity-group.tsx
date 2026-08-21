import { useId, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleDotDashed, CircleHelp, TerminalSquare, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  'args',
  'target',
  'command',
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
  'output',
  'error',
];

type ActivityStatus = 'running' | 'success' | 'failure' | 'unknown';

const RUNNING_EVENTS = new Set([
  'agent_started',
  'agent_progressed',
  'agent_thought',
  'agent_tool_call',
  'tool_call_started',
]);

const SUCCESS_EVENTS = new Set([
  'agent_completed',
  'check_completed',
  'task_completed',
  'tool_call_completed',
]);

const FAILURE_EVENTS = new Set([
  'agent_error',
  'mission_failed',
  'task_failed',
]);

function readableEventType(value?: string): string {
  return (value || 'activity').replace(/_/g, ' ');
}

function roleLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ROLE_LABELS[normalized] || normalized.replace(/[_-]/g, ' ').replace(/^\w/, (character) => character.toUpperCase());
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function statusForItem(item: TimelineItem): ActivityStatus {
  const eventType = item.eventType || '';
  const success = item.metadata?.success;
  const passed = item.metadata?.passed;
  const approved = item.metadata?.approved;

  if (success === false || passed === false || approved === false || FAILURE_EVENTS.has(eventType)) return 'failure';
  if (success === true || passed === true || approved === true) return 'success';
  if (SUCCESS_EVENTS.has(eventType) && eventType !== 'tool_call_completed' && eventType !== 'check_completed') return 'success';
  if (RUNNING_EVENTS.has(eventType)) return 'running';
  return 'unknown';
}

function groupStatus(items: TimelineItem[]): ActivityStatus {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const status = statusForItem(items[index]);
    if (status !== 'unknown') return status;
  }
  return 'unknown';
}

const STATUS_CONFIG: Record<ActivityStatus, { label: string; variant: 'warning' | 'success' | 'destructive' | 'secondary' }> = {
  running: { label: 'Running', variant: 'warning' },
  success: { label: 'Complete', variant: 'success' },
  failure: { label: 'Failed', variant: 'destructive' },
  unknown: { label: 'Recorded', variant: 'secondary' },
};

function ActivityStatusIcon({ status }: { status: ActivityStatus }) {
  if (status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (status === 'failure') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'running') return <CircleDotDashed className="h-3.5 w-3.5 text-primary" />;
  return <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" />;
}

function detailEntries(metadata?: Record<string, unknown>): Array<[string, string]> {
  if (!metadata) return [];
  return DETAIL_KEYS.flatMap((key) => {
    const value = metadata[key];
    if (value === undefined || value === null || value === '') return [];
    let serialized: string | undefined;
    if (typeof value === 'string') {
      serialized = value;
    } else {
      try {
        serialized = JSON.stringify(value);
      } catch {
        serialized = String(value);
      }
    }
    if (!serialized) return [];
    return [[key, serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized] as [string, string]];
  });
}

export function ActivityGroup({ items }: ActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const roles = [...new Set(items.flatMap((item) => {
    const role = item.agentRole || metadataString(item.metadata, 'role');
    return role ? [role] : [];
  }))];
  const role = roles[0] || 'agent';
  const label = roles.length > 1
    ? 'Team'
    : roleLabel(role);
  const roleDescription = roles.map(roleLabel).join(', ');
  const latest = items[items.length - 1];
  const status = groupStatus(items);
  const statusConfig = STATUS_CONFIG[status];
  const summary = useMemo(() => {
    const types = new Set(items.map((item) => readableEventType(item.eventType)));
    const latestContent = latest?.content?.trim().replace(/\s+/g, ' ');
    if (latestContent) return latestContent.length > 180 ? `${latestContent.slice(0, 177)}...` : latestContent;
    return `${types.size} activity type${types.size === 1 ? '' : 's'}`;
  }, [items, latest]);
  const activityLabel = `${label} activity, ${items.length} event${items.length === 1 ? '' : 's'}, ${statusConfig.label.toLowerCase()}`;

  return (
    <div className="py-1">
      <div className={cn(
        'group flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 transition-colors',
        'hover:border-border hover:bg-card/70',
        expanded && 'border-border bg-card/65',
      )}>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${activityLabel}`}
          title={roles.length > 1 ? roleDescription : undefined}
          className="flex h-auto min-w-0 flex-1 items-center justify-start gap-2 bg-transparent p-0 text-left hover:bg-transparent"
        >
          <div aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60">
            <ActivityStatusIcon status={status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground/90">{label} activity</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={summary}>{summary}</div>
          </div>
          {expanded
            ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        </Button>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant={statusConfig.variant} className="h-4 shrink-0 gap-1 px-1.5 text-[9px] font-medium">
            <span aria-hidden="true"><ActivityStatusIcon status={status} /></span>
            {statusConfig.label}
          </Badge>
          <Badge variant="secondary" aria-label={`${items.length} event${items.length === 1 ? '' : 's'}`} className="h-4 shrink-0 px-1.5 text-[9px] font-medium">
            {items.length}
          </Badge>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">{latest?.timestamp}</span>
        </div>
      </div>

      <div
        id={detailsId}
        role="region"
        aria-label={`${label} activity details`}
        hidden={!expanded}
        className="ml-3 mt-1.5 space-y-1.5 border-l border-border/70 pl-4"
      >
        {expanded && items.map((item) => {
          const details = detailEntries(item.metadata);
          return (
            <div key={item.id} className="rounded-md border border-border/45 bg-background/35 px-2.5 py-2">
              <div className="flex min-w-0 items-start gap-2">
                <TerminalSquare aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-foreground/80">{item.content}</span>
                    <span className="shrink-0 text-[9px] text-muted-foreground/60">{item.timestamp}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px] capitalize text-muted-foreground">
                      {readableEventType(item.eventType)}
                    </Badge>
                    {item.agentRole && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
                        {roleLabel(item.agentRole)}
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
    </div>
  );
}
