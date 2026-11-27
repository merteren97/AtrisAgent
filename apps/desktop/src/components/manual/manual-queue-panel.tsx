import { Paperclip, RotateCcw, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ManualInboxItem, ManualQueuedPrompt } from '@/stores/manual-store';

export interface ManualQueuePanelProps {
  inbox?: ManualInboxItem[];
  queued?: ManualQueuedPrompt[];
  canSteer?: boolean;
  attention?: boolean;
  pendingActionId?: string | null;
  onSteerInbox?: (inboxId: string) => void;
  onCancelInbox?: (inboxId: string) => void;
  onSteerQueued?: (item: ManualQueuedPrompt) => void;
  onRetryQueued?: (item: ManualQueuedPrompt) => void;
  onCancelQueued?: (itemId: string) => void;
}

interface QueueEntry {
  key: string;
  text: string;
  fileCount: number;
  status: 'queued' | 'sending' | 'error';
  error?: string;
  onSteer?: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
}

export function ManualQueuePanel({
  inbox = [],
  queued = [],
  canSteer = false,
  attention = false,
  pendingActionId = null,
  onSteerInbox,
  onCancelInbox,
  onSteerQueued,
  onRetryQueued,
  onCancelQueued,
}: ManualQueuePanelProps) {
  const entries: QueueEntry[] = [
    ...inbox
      .filter(item => item.delivery === 'queue')
      .map(item => ({
        key: `inbox:${item.id}`,
        text: item.text,
        fileCount: 0,
        status: (pendingActionId === item.id ? 'sending' : 'queued') as QueueEntry['status'],
        onSteer: onSteerInbox ? () => onSteerInbox(item.id) : undefined,
        onCancel: onCancelInbox ? () => onCancelInbox(item.id) : undefined,
      })),
    ...queued.map(item => ({
      key: `queued:${item.id}`,
      text: item.text,
      fileCount: item.files.length,
      status: (pendingActionId === item.id ? 'sending' : item.status) as QueueEntry['status'],
      error: item.error,
      onSteer: onSteerQueued ? () => onSteerQueued(item) : undefined,
      onRetry: onRetryQueued ? () => onRetryQueued(item) : undefined,
      onCancel: onCancelQueued ? () => onCancelQueued(item.id) : undefined,
    })),
  ];

  if (!entries.length) return null;

  return (
    <div aria-label="Queued messages" className="shrink-0 px-4 pt-2">
      <div className="mx-auto w-full max-w-3xl space-y-1.5">
        {entries.map(entry => {
          const sending = entry.status === 'sending';
          const badge = sending
            ? 'Sending…'
            : entry.status === 'error'
              ? 'Failed'
              : attention
                ? 'Waiting for response'
                : 'Queued';
          const badgeClass = entry.status === 'error'
            ? 'bg-destructive/15 text-destructive'
            : attention
              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              : 'bg-muted text-muted-foreground';

          return (
            <div
              key={entry.key}
              className="flex items-start justify-between gap-2 rounded-xl border border-border/80 bg-muted/30 px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${badgeClass}`}>
                    {badge}
                  </span>
                  {entry.fileCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border/60">
                      <Paperclip className="h-2.5 w-2.5" />
                      {entry.fileCount} {entry.fileCount === 1 ? 'file' : 'files'}
                    </span>
                  )}
                </div>
                {entry.text.trim() ? (
                  <p className="line-clamp-2 break-words text-foreground/90">{entry.text.trim()}</p>
                ) : (
                  <p className="italic text-muted-foreground">Attachment-only message</p>
                )}
                {entry.error && <p role="alert" className="break-words text-[11px] text-destructive">{entry.error}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {entry.status === 'error' && entry.onRetry ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    aria-label="Retry queued message"
                    title="Retry"
                    disabled={sending || attention}
                    onClick={entry.onRetry}
                  >
                    <RotateCcw className="mr-1 h-3 w-3" />
                    Retry
                  </Button>
                ) : canSteer && entry.onSteer ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    aria-label="Send queued message immediately"
                    title="Send now"
                    disabled={sending || attention}
                    onClick={entry.onSteer}
                  >
                    <Zap className="mr-1 h-3 w-3" />
                    Send now
                  </Button>
                ) : null}
                {entry.onCancel && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label="Cancel queued message"
                    title="Cancel queued message"
                    disabled={sending}
                    onClick={entry.onCancel}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
