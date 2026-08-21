import { useId, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Hammer, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/mission-store';

export type ToolCallStatus = 'running' | 'success' | 'failure' | 'unknown';

export interface ToolCallRowProps {
  item: TimelineItem;
}

type StatusConfig = {
  label: string;
  variant: 'warning' | 'success' | 'destructive' | 'secondary';
  iconClass: string;
};

const STATUS_CONFIG: Record<ToolCallStatus, StatusConfig> = {
  running: { label: 'Running', variant: 'warning', iconClass: 'text-warning' },
  success: { label: 'Success', variant: 'success', iconClass: 'text-success' },
  failure: { label: 'Failed', variant: 'destructive', iconClass: 'text-destructive' },
  unknown: { label: 'Unknown', variant: 'secondary', iconClass: 'text-muted-foreground' },
};

const TARGET_KEYS = [
  'target',
  'path',
  'filePath',
  'worktreePath',
  'directory',
  'dir',
  'command',
  'url',
  'query',
  'pattern',
];

const RESULT_KEYS = ['result', 'output', 'stdout', 'stderr'];
const MAX_TARGET_PREVIEW = 140;
const MAX_RESULT_PREVIEW = 220;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : compact;
}

function keyLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase();
}

function previewValue(value: unknown): string | undefined {
  const scalar = scalarText(value);
  if (scalar) return scalar;

  if (Array.isArray(value)) {
    const scalarValues = value.map(scalarText).filter((entry): entry is string => Boolean(entry));
    if (scalarValues.length > 0) return scalarValues.join(', ');
    if (value.length > 0) return `${value.length} items`;
  }

  if (isRecord(value)) {
    for (const key of TARGET_KEYS) {
      const nested = scalarText(value[key]);
      if (nested) return `${keyLabel(key)}: ${nested}`;
    }
    const keys = Object.keys(value);
    if (keys.length > 0) return `${keys.length} argument${keys.length === 1 ? '' : 's'}`;
  }

  return undefined;
}

function argumentPreview(metadata: Record<string, unknown>): string | undefined {
  for (const key of TARGET_KEYS) {
    const value = metadata[key];
    if (!hasValue(value)) continue;
    const preview = previewValue(value);
    if (preview) return `${keyLabel(key)}: ${compactText(preview, MAX_TARGET_PREVIEW)}`;
  }

  const args = metadata.args;
  const directArgs = scalarText(args);
  if (directArgs) return `args: ${compactText(directArgs, MAX_TARGET_PREVIEW)}`;

  if (isRecord(args)) {
    for (const key of TARGET_KEYS) {
      const value = scalarText(args[key]);
      if (value) return `${keyLabel(key)}: ${compactText(value, MAX_TARGET_PREVIEW)}`;
    }

    const entries = Object.entries(args).filter(([, value]) => hasValue(value));
    if (entries.length === 1) {
      const [key, value] = entries[0];
      const preview = previewValue(value);
      if (preview) return `${keyLabel(key)}: ${compactText(preview, MAX_TARGET_PREVIEW)}`;
    }
    if (entries.length > 1) {
      const names = entries.slice(0, 3).map(([key]) => keyLabel(key)).join(', ');
      return `${entries.length} args: ${names}${entries.length > 3 ? ', ...' : ''}`;
    }
    if (Object.keys(args).length > 0) return `${Object.keys(args).length} arguments`;
  }

  return undefined;
}

function structuredResultPreview(value: unknown): string | undefined {
  const scalar = scalarText(value);
  if (scalar) return scalar;
  if (value === null) return 'No result';

  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'} returned`;

  if (isRecord(value)) {
    for (const key of ['summary', 'message', 'text', 'output', 'stdout', 'status', 'path', 'detail', 'description']) {
      const nested = scalarText(value[key]);
      if (nested) return `${keyLabel(key)}: ${nested}`;
    }
    const keys = Object.keys(value);
    return keys.length > 0
      ? `${keys.length} field${keys.length === 1 ? '' : 's'} returned`
      : 'Empty object returned';
  }

  return undefined;
}

function resultPreview(value: unknown): string | undefined {
  if (!hasValue(value)) return undefined;

  if (typeof value === 'string') {
    const raw = value.trim();
    try {
      const parsed = JSON.parse(raw) as unknown;
      const parsedPreview = structuredResultPreview(parsed);
      if (parsedPreview) return compactText(parsedPreview, MAX_RESULT_PREVIEW);
    } catch {
      // Plain command output is expected; only structured JSON needs summarizing.
    }
    return compactText(raw, MAX_RESULT_PREVIEW);
  }

  const preview = structuredResultPreview(value);
  return preview ? compactText(preview, MAX_RESULT_PREVIEW) : undefined;
}

function toolCallStatus(item: TimelineItem): ToolCallStatus {
  const metadata = item.metadata || {};
  const eventType = item.eventType || '';
  const state = (scalarText(metadata.status) || scalarText(metadata.state))?.toLowerCase();

  if (
    metadata.success === false
    || metadata.success === 'false'
    || hasValue(metadata.error)
    || ['failed', 'failure', 'error'].includes(state || '')
    || ['tool_call_failed', 'tool_failed'].includes(eventType)
  ) return 'failure';
  if (
    metadata.success === true
    || metadata.success === 'true'
    || ['success', 'succeeded', 'complete', 'completed'].includes(state || '')
  ) return 'success';
  if (
    ['running', 'started', 'pending', 'in_progress'].includes(state || '')
    || eventType === 'tool_call_started'
  ) return 'running';
  return 'unknown';
}

function toolName(item: TimelineItem): string {
  const metadataName = scalarText(item.metadata?.toolName) || scalarText(item.metadata?.tool) || scalarText(item.metadata?.name);
  if (metadataName) return metadataName;

  const content = item.content.trim();
  const started = content.match(/^Tool started:\s*(.+)$/i);
  if (started?.[1]) return started[1].replace(/[.]$/, '').trim();
  const completed = content.match(/^(.+?)\s+(?:completed|failed)\.?$/i);
  if (completed?.[1]) return completed[1].trim();
  return 'Tool call';
}

function fullValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) || String(value);
  } catch {
    return String(value);
  }
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === 'running') return <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />;
  if (status === 'success') return <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />;
  if (status === 'failure') return <XCircle aria-hidden="true" className="h-3.5 w-3.5" />;
  return <CircleHelp aria-hidden="true" className="h-3.5 w-3.5" />;
}

export function ToolCallRow({ item }: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const status = toolCallStatus(item);
  const statusConfig = STATUS_CONFIG[status];
  const name = toolName(item);
  const metadata = item.metadata || {};
  const target = argumentPreview(metadata);
  const rawError = metadata.error;
  const rawResult = RESULT_KEYS.map((key) => metadata[key]).find(hasValue);
  const result = resultPreview(status === 'failure' && hasValue(rawError) ? rawError : rawResult);
  const resultLabel = status === 'failure' && hasValue(rawError) ? 'Error' : 'Result';
  const hasDetails = Boolean(
    item.eventType
    || item.content
    || hasValue(metadata.args)
    || hasValue(metadata.target)
    || hasValue(rawResult)
    || hasValue(rawError),
  );

  return (
    <div className="rounded-lg border border-border/60 bg-card/45 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60', statusConfig.iconClass)}>
          <StatusIcon status={status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Hammer aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground/90" title={name}>{name}</span>
            <Badge variant={statusConfig.variant} className="h-4 shrink-0 gap-1 px-1.5 text-[9px] font-medium">
              <StatusIcon status={status} />
              {statusConfig.label}
            </Badge>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">{item.timestamp}</span>
          </div>

          {target && (
            <div className="mt-1 truncate text-[10px] text-muted-foreground" title={target}>
              <span className="mr-1 uppercase tracking-wide text-muted-foreground/60">Target</span>
              {target}
            </div>
          )}

          {result && (
            <div className="mt-1 rounded-md border border-border/45 bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
              <span className="mr-1 uppercase tracking-wide text-muted-foreground/60">{resultLabel}</span>
              <span className="line-clamp-2 break-words">{result}</span>
            </div>
          )}

          {hasDetails && (
            <div className="mt-1 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded((value) => !value)}
                className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                {expanded
                  ? <ChevronDown aria-hidden="true" className="h-3 w-3" />
                  : <ChevronRight aria-hidden="true" className="h-3 w-3" />}
                {expanded ? 'Hide details' : 'Details'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div
        id={detailsId}
        role="region"
        aria-label={`${name} details`}
        hidden={!expanded}
        className="mt-2 border-t border-border/50 pt-2"
      >
        {expanded && (
          <dl className="space-y-1.5 text-[10px] text-muted-foreground">
            <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground/70">Event</dt>
              <dd className="break-words text-foreground/75">{item.eventType || item.type}</dd>
            </div>
            {item.agentRole && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground/70">Role</dt>
                <dd className="break-words text-foreground/75">{item.agentRole}</dd>
              </div>
            )}
            {hasValue(metadata.args) && (
              <div>
                <dt className="text-muted-foreground/70">Arguments</dt>
                <dd className="mt-1">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/15 p-2 font-mono text-foreground/75">{fullValue(metadata.args)}</pre>
                </dd>
              </div>
            )}
            {hasValue(metadata.target) && (
              <div>
                <dt className="text-muted-foreground/70">Target</dt>
                <dd className="mt-1">
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/15 p-2 font-mono text-foreground/75">{fullValue(metadata.target)}</pre>
                </dd>
              </div>
            )}
            {hasValue(rawResult) && (
              <div>
                <dt className="text-muted-foreground/70">Result</dt>
                <dd className="mt-1">
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/15 p-2 font-mono text-foreground/75">{fullValue(rawResult)}</pre>
                </dd>
              </div>
            )}
            {hasValue(rawError) && (
              <div>
                <dt className="text-muted-foreground/70">Error</dt>
                <dd className="mt-1">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-destructive/5 p-2 font-mono text-destructive">{fullValue(rawError)}</pre>
                </dd>
              </div>
            )}
            {item.content && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground/70">Summary</dt>
                <dd className="break-words text-foreground/75">{item.content}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}
