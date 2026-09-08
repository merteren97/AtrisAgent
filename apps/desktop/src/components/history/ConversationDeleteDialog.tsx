import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMissionStore, type ConversationDeletionResult, type Mission } from '@/stores/mission-store';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const PHASE_LABELS: Record<string, string> = {
  stop: 'Stopping active work', runtime: 'Closing agent sessions', worktrees: 'Cleaning up temporary workspaces',
  checkpoints: 'Removing checkpoints', policy: 'Cleaning up conversation settings',
  memory: 'Updating project memory', relational: 'Removing conversation history',
};

interface ConversationDeleteDialogProps {
  mission: Mission | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (mission: Mission) => void;
}

export function ConversationDeleteDialog({ mission, onOpenChange, onDeleted }: ConversationDeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConversationDeletionResult | null>(null);
  const liveMission = useMissionStore((state) => state.missions.find((item) => item.id === mission?.id));
  const trackedResult = useMissionStore((state) => mission ? state.deletionTracking[mission.id]?.result : undefined);
  const requestMissionId = useRef(mission?.id);
  const completedId = useRef<string | null>(null);
  requestMissionId.current = mission?.id;
  const currentResult = trackedResult || lastResult;
  const deletion = currentResult
    ? (currentResult.status === 'pending' || currentResult.status === 'retryable' ? currentResult : undefined)
    : liveMission?.deletionState || mission?.deletionState;

  useEffect(() => {
    setError(null);
    setLastResult(null);
    setBusy(false);
    completedId.current = null;
  }, [mission?.id]);

  useEffect(() => {
    if (mission && (trackedResult?.status === 'completed' || trackedResult?.status === 'not_found') && completedId.current !== mission.id) {
      completedId.current = mission.id;
      onDeleted?.(mission);
      onOpenChange(false);
    }
  }, [mission, trackedResult, onDeleted, onOpenChange]);

  const handleDelete = async () => {
    if (!mission || busy) return;
    const id = mission.id;
    setBusy(true);
    setError(null);
    try {
      // The backend deletion operation owns the authoritative stop, runtime,
      // worktree and relational phases. Calling it directly also lets a stale
      // cached row reconcile through its idempotent 404 outcome.
      const store = useMissionStore.getState();
      const result = await (deletion?.status === 'pending' ? store.checkMissionDeletion(id) : store.deleteMission(id));
      if (requestMissionId.current !== id) return;
      setLastResult(result);
      if (result.status === 'pending') {
        setError(null);
        return;
      }
      if (result.status === 'retryable') {
        return;
      }
      if (completedId.current !== id) {
        completedId.current = id;
        onDeleted?.(mission);
        onOpenChange(false);
      }
    } catch (cause: any) {
      if (requestMissionId.current === id) setError(cause?.message || 'Conversation deletion failed.');
    } finally {
      if (requestMissionId.current === id) setBusy(false);
    }
  };

  const deletionStatus = deletion?.status;
  const deletionPending = deletionStatus === 'pending';
  const deletionRetryable = deletionStatus === 'retryable';
  const cachedTerminal = TERMINAL_STATUSES.has((liveMission || mission)?.status || 'completed');
  const phaseLabel = deletion?.phase ? PHASE_LABELS[deletion.phase] : undefined;
  const completed = Number(deletion?.progress?.completedCount);
  const total = Number(deletion?.progress?.totalCount);
  const progress = Number.isFinite(completed) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, completed / total * 100)) : undefined;
  const visibleError = error || deletion?.error;
  return (
    <Dialog open={Boolean(mission)} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent className="min-w-0 sm:max-w-[440px]" showCloseButton={!busy}>
        <DialogHeader className="min-w-0">
          <div className={`mb-1 flex h-9 w-9 items-center justify-center rounded-lg border ${deletionPending ? 'border-border bg-muted text-muted-foreground' : 'border-destructive/25 bg-destructive/10 text-destructive'}`}>{deletionPending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-4 w-4" />}</div>
          <DialogTitle className="min-w-0 break-words">{deletionPending ? 'Deleting conversation…' : deletionRetryable ? 'Retry conversation deletion' : cachedTerminal ? 'Delete conversation?' : 'Stop and delete conversation?'}</DialogTitle>
          <DialogDescription className="min-w-0 break-words leading-relaxed">
            {deletionPending
              ? 'Cleanup continues in the background. You can close this window; the conversation will disappear when deletion is complete.'
              : deletionRetryable
                ? 'Cleanup paused before it finished. Retry to continue from the last completed step.'
                : `${cachedTerminal ? '' : 'Active agents will be stopped. '}This permanently removes the conversation, agent history, and temporary workspaces. Changes already applied to your project are kept.`}
          </DialogDescription>
        </DialogHeader>
        {mission && <div className="min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-3">
          <div className="truncate text-sm font-medium text-foreground" title={mission.title}>{mission.title}</div>
          <div role="status" aria-live="polite" className="mt-1.5 text-xs text-muted-foreground">{deletionPending ? phaseLabel || 'Confirming deletion…' : deletionRetryable ? `Paused${phaseLabel ? ` · ${phaseLabel}` : ''}` : `Current status: ${(liveMission || mission).status.replaceAll('_', ' ')}`}</div>
          {deletionPending && progress !== undefined && <div role="progressbar" aria-label="Conversation cleanup" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>}
        </div>}
        {visibleError && <div role={deletionPending ? 'status' : 'alert'} className={`min-w-0 break-words rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${deletionPending ? 'border-border bg-muted/30 text-muted-foreground' : 'border-destructive/25 bg-destructive/10 text-destructive'}`}>{visibleError}</div>}
        <DialogFooter>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{deletion ? 'Close' : 'Cancel'}</Button>
          <Button className="w-full sm:w-auto" variant={deletionPending ? 'outline' : 'destructive'} onClick={() => void handleDelete()} disabled={!mission || busy}>
            {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : deletionPending ? <RefreshCw className="mr-2 h-3.5 w-3.5" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
            {busy ? 'Please wait…' : deletionPending ? 'Refresh status' : deletionRetryable ? 'Retry deletion' : cachedTerminal ? 'Delete conversation' : 'Stop & Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
