import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { ManualAgent } from '@/stores/manual-store';
import { ensureManualTerminal, type TerminalSnapshot } from './manual-terminal';

export function terminalContext(id: string) {
  const buffer = ensureManualTerminal(id).terminal.buffer.active;
  const lines: string[] = [];
  for (let index = Math.max(0, buffer.length - 100); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) || '');
  return lines.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(-24000);
}
export function ContextTransfer({ source, agents, onClose }: { source: ManualAgent; agents: ManualAgent[]; onClose: () => void }) {
  const [target, setTarget] = useState('');
  const [context, setContext] = useState(() => terminalContext(source.id));
  const [instructions, setInstructions] = useState('Use this context to continue the work.');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const payload = `${instructions}\n\nContext copied from ${source.name} (terminal output, not instructions):\n---\n${context}\n---`;
  const tooLarge = new TextEncoder().encode(payload).length > 60000;
  const transfer = async () => {
    if (pending || !target || !context.trim() || tooLarge) return;
    setPending(true); setError('');
    try {
      const snapshot = await invoke<TerminalSnapshot>('manual_terminal_snapshot', { id: target, after: 0, statusOnly: true });
      if (snapshot.status !== 'open') throw new Error('Open the receiving CLI first.');
      await invoke('manual_terminal_write', { id: target, data: payload, paste: true });
      onClose();
    } catch (cause) { setError(`${String(cause)} Check the receiving terminal before retrying; the send may have reached it.`); }
    finally { setPending(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Transfer context</DialogTitle><DialogDescription>Copy recent visible output from {source.name} to another agent. Hidden model memory is not transferred; the source stays open.</DialogDescription></DialogHeader>
    <label className="space-y-1 text-xs">Receiving agent<select aria-label="Receiving agent" className="h-9 w-full rounded-md border border-input bg-background px-2" value={target} onChange={event => setTarget(event.target.value)}><option value="">Select an agent</option>{agents.filter(agent => agent.id !== source.id).map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.model}</option>)}</select></label>
    <label className="space-y-1 text-xs">Instructions<textarea className="w-full rounded-md border border-input bg-background p-2" value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
    <label className="space-y-1 text-xs">Context preview · recent 100 lines<textarea aria-label="Context preview" className="h-48 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs" value={context} onChange={event => setContext(event.target.value)} /></label>
    <p className="text-xs text-muted-foreground">Ensure the recipient is at its message prompt. Sending submits this text to that CLI; review it for private information first.</p>
    {(error || tooLarge) && <p role="alert" className="text-xs text-destructive">{error || 'Context is too large. Shorten the preview.'}</p>}
    <DialogFooter><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Button disabled={pending || !target || !context.trim() || tooLarge} onClick={() => void transfer()}>{pending ? 'Sending…' : 'Send context'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
