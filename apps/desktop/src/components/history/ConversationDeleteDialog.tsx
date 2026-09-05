import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMissionStore, type ConversationDeletionResult, type Mission } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

interface ConversationDeleteDialogProps {
  mission: Mission | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (mission: Mission) => void;
}

export function ConversationDeleteDialog({ mission, onOpenChange, onDeleted }: ConversationDeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConversationDeletionResult | null>(null);
  const deleteMission = useMissionStore((state) => state.deleteMission);
  const forgetMission = useWorkspaceStore((state) => state.forgetMission);

  useEffect(() => {
    setError(null);
    setLastResult(null);
  }, [mission?.id]);

  const handleDelete = async () => {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      // The backend deletion operation owns the authoritative stop, runtime,
      // worktree and relational phases. Calling it directly also lets a stale
      // cached row reconcile through its idempotent 404 outcome.
      const result = await deleteMission(mission.id);
      setLastResult(result);
      if (result.status === 'pending') {
        setError(null);
        return;
      }
      if (result.status === 'retryable') {
        setError(result.error || 'Conversation deletion needs to be retried.');
        return;
      }
      forgetMission(mission.workspaceId, mission.id);
      onDeleted?.(mission);
      onOpenChange(false);
    } catch (cause: any) {
      setError(cause?.message || 'Conversation deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  const deletionStatus = mission?.deletionState?.status || (lastResult?.status === 'pending' || lastResult?.status === 'retryable' ? lastResult.status : null);
  const deletionPending = deletionStatus === 'pending';
  const deletionRetryable = deletionStatus === 'retryable';
  const cachedTerminal = mission ? TERMINAL_STATUSES.has(mission.status) : true;
  return (
    <Dialog open={Boolean(mission)} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent className="min-w-0 sm:max-w-[440px]">
        <DialogHeader className="min-w-0">
          <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive"><Trash2 className="h-4 w-4" /></div>
          <DialogTitle className="min-w-0 break-words">{deletionPending ? 'Deleting conversation…' : deletionRetryable ? 'Retry conversation deletion' : cachedTerminal ? 'Delete conversation?' : 'Stop and delete conversation?'}</DialogTitle>
          <DialogDescription className="min-w-0 break-words leading-relaxed">
            {deletionPending
              ? 'Deletion is still in progress. This conversation remains visible until cleanup is confirmed complete. Use Check status to refresh the operation.'
              : deletionRetryable
                ? 'The cleanup operation can be resumed safely. Retry deletion to continue removing this conversation.'
                : `${cachedTerminal ? 'The latest status will be checked before deletion. ' : 'Active work will be stopped after checking its latest backend status. '}This permanently removes the timeline, tasks, agent history, events, artifacts, and managed task worktrees. Changes already applied to project files are retained.`}
          </DialogDescription>
        </DialogHeader>
        {mission ? <div className="min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2.5"><div className="min-w-0 truncate text-xs font-medium text-foreground" title={mission.title}>{mission.title}</div><div className="mt-1 break-words text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{deletionPending ? 'Deletion status: pending' : deletionRetryable ? 'Deletion status: retryable' : `Last known status: ${mission.status}`}</div></div> : null}
        {error ? <div role="alert" className="min-w-0 break-words rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button className="w-full sm:w-auto" variant="destructive" onClick={() => void handleDelete()} disabled={!mission || busy}>
            {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
            {deletionPending ? 'Check status' : deletionRetryable ? 'Retry deletion' : cachedTerminal ? 'Delete conversation' : 'Stop & Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
