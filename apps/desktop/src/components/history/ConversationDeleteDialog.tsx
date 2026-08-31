import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMissionStore, type Mission } from '@/stores/mission-store';
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
  const refreshMission = useMissionStore((state) => state.refreshMission);
  const stopMission = useMissionStore((state) => state.stopMission);
  const deleteMission = useMissionStore((state) => state.deleteMission);
  const forgetMission = useWorkspaceStore((state) => state.forgetMission);

  useEffect(() => setError(null), [mission?.id]);

  const handleDelete = async () => {
    if (!mission) return;
    setBusy(true);
    setError(null);
    try {
      let authoritative = await refreshMission(mission.id);
      if (!TERMINAL_STATUSES.has(authoritative.status)) {
        await stopMission(mission.id);
        authoritative = await refreshMission(mission.id);
      }
      if (!TERMINAL_STATUSES.has(authoritative.status)) {
        throw new Error(`Conversation is still ${authoritative.status}. Wait for it to stop, then retry deletion.`);
      }
      await deleteMission(mission.id);
      forgetMission(mission.workspaceId, mission.id);
      onDeleted?.(mission);
      onOpenChange(false);
    } catch (cause: any) {
      setError(cause?.message || 'Conversation deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  const cachedTerminal = mission ? TERMINAL_STATUSES.has(mission.status) : true;
  return (
    <Dialog open={Boolean(mission)} onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive"><Trash2 className="h-4 w-4" /></div>
          <DialogTitle>{cachedTerminal ? 'Delete conversation?' : 'Stop and delete conversation?'}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {cachedTerminal ? 'The latest status will be checked before deletion. ' : 'Active work will be stopped after checking its latest backend status. '}
            This permanently removes the timeline, tasks, agent history, events, artifacts, and managed task worktrees. Changes already applied to project files are retained.
          </DialogDescription>
        </DialogHeader>
        {mission ? <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"><div className="truncate text-xs font-medium text-foreground">{mission.title}</div><div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Last known status: {mission.status}</div></div> : null}
        {error ? <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={!mission || busy}>
            {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
            {cachedTerminal ? 'Delete conversation' : 'Stop & Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
