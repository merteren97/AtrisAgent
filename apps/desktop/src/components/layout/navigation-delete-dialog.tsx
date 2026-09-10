import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useManualStore, type ManualConversation } from '@/stores/manual-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { isTauriRuntime } from '@/lib/secure-storage';
import { markManualClosed } from '@/components/manual/manual-activity';

export type NavigationDeleteTarget = { kind: 'manual'; conversation: ManualConversation } | { kind: 'workspace'; id: string; name: string };
export function NavigationDeleteDialog({ target, onClose }: { target: NavigationDeleteTarget; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [removeMemory, setRemoveMemory] = useState(false);
  const name = target.kind === 'manual' ? target.conversation.title : target.name;
  const remove = async () => {
    if (pending) return;
    setPending(true); setError('');
    try {
      if (target.kind === 'workspace') await useWorkspaceStore.getState().removeWorkspace(target.id, removeMemory);
      else {
        // Native ownership must be relinquished before deleting its durable identities.
        if (target.conversation.agents.length && !isTauriRuntime()) throw new Error('Delete this conversation in the desktop app so its CLI sessions can be closed safely.');
        for (const agent of target.conversation.agents) {
          await invoke('manual_terminal_close', { id: agent.id });
          markManualClosed(agent.id);
          useManualStore.getState().hideAgent(agent.id, true);
        }
        await useManualStore.getState().remove(target.conversation);
        const { disposeManualTerminal } = await import('@/components/manual/manual-terminal');
        target.conversation.agents.forEach(agent => disposeManualTerminal(agent.id));
      }
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Deletion failed. Try again.'); }
    finally { setPending(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{target.kind === 'manual' ? 'Delete conversation?' : 'Remove workspace?'}</DialogTitle><DialogDescription>{target.kind === 'manual' ? 'Its CLI sessions will close and this conversation will be removed from AtrisAgent. Saved project memory and provider-owned history are retained.' : 'Remove this workspace and its conversations from AtrisAgent. Project files are retained. Choose below whether to remove saved memory too. Close manual CLI sessions first; active work may prevent removal.'}</DialogDescription></DialogHeader><div className="break-words rounded-xl border border-border bg-muted/30 p-4 text-sm font-medium">{name}</div>{target.kind === 'workspace' && <label className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={removeMemory} disabled={pending} onChange={event=>setRemoveMemory(event.target.checked)}/><span>Also remove workspace memory<span className="mt-1 block text-xs text-muted-foreground">Leave unchecked to retain memory as a detached backup. Project files are never deleted.</span></span></label>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="destructive" disabled={pending} onClick={() => void remove()}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Trash2 className="mr-2 h-4 w-4"/>}{pending ? 'Removing…' : target.kind === 'manual' ? 'Delete conversation' : 'Remove workspace'}</Button></DialogFooter></DialogContent></Dialog>;
}
