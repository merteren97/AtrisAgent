import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useManualStore, type ManualConversation } from '@/stores/manual-store';
import { useMissionStore, type Mission } from '@/stores/mission-store';

export type ConversationRenameTarget = { kind: 'manual'; conversation: ManualConversation } | { kind: 'orchestrator'; mission: Mission };

export function ConversationRenameDialog({ target, onClose }: { target: ConversationRenameTarget; onClose: () => void }) {
  const currentTitle = target.kind === 'manual' ? target.conversation.title : target.mission.title;
  const [title, setTitle] = useState(currentTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = title.trim();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !trimmed || trimmed.length > 200) return;
    if (trimmed === currentTitle) { onClose(); return; }
    setPending(true); setError('');
    try {
      if (target.kind === 'manual') await useManualStore.getState().rename(target.conversation, trimmed);
      else await useMissionStore.getState().renameMission(target.mission.id, trimmed);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename the conversation. Try again.'); }
    finally { setPending(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <form onSubmit={event => void save(event)} className="space-y-5">
        <DialogHeader><DialogTitle>Rename conversation</DialogTitle><DialogDescription>Choose a name that is easy to find in your project.</DialogDescription></DialogHeader>
        <div className="space-y-2">
          <label htmlFor="conversation-name" className="text-sm font-medium">Conversation name</label>
          <Input id="conversation-name" autoFocus maxLength={200} value={title} disabled={pending} onChange={event => setTitle(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? 'conversation-rename-error' : undefined} />
          {error && <p id="conversation-rename-error" role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button type="submit" disabled={pending || !trimmed || trimmed === currentTitle}>{pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save name</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
