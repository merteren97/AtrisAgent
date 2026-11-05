import { useEffect, useRef, useState } from 'react';
import { Shield, Loader2 } from 'lucide-react';
import type { CodexPermissionMode } from '@atris-agent-code/domain';
import type { ManualAgent } from '@/stores/manual-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api-client';

export interface CodexLivePermissions {
  available: boolean; runtimeId?: string; threadId?: string; revision?: number;
  mode?: CodexPermissionMode; applying?: boolean; reason?: string;
}

const modes: {id: CodexPermissionMode; label: string; description: string}[] = [
  {id:'ask-for-approval', label:'Ask for approval', description:'Work inside the workspace. Ask you before escalating access.'},
  {id:'approve-for-me', label:'Approve for me', description:'Keep the workspace sandbox. Codex reviews requests for extra access.'},
  {id:'full-access', label:'Full Access', description:'Allow filesystem and network access without ordinary sandbox or approval prompts.'},
  {id:'read-only', label:'Read Only', description:'Read workspace files. Edits and extra access require approval.'},
];

export function CodexPermissions({agent, live, disabled, onApply}: {
  agent: ManualAgent; live: boolean; disabled: boolean;
  onApply: (mode: CodexPermissionMode, now: boolean, fullAccessConfirmed: boolean, target?: CodexLivePermissions) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CodexPermissionMode>(agent.codexPermissionMode || 'ask-for-approval');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyingNow, setApplyingNow] = useState(false);
  const [error, setError] = useState<string>();
  const [current, setCurrent] = useState<CodexLivePermissions>();
  const selectionTouched = useRef(false);
  useEffect(() => {
    if (!open || !live) { setCurrent(undefined); return; }
    let disposed = false, first = true;
    const refresh = async () => {
      try {
        const value = await apiRequest<CodexLivePermissions>(`/manual/agents/${agent.id}/permissions/live`);
        if (!disposed) { setCurrent(value); if (first && value.mode && !selectionTouched.current) setSelected(value.mode); first = false; }
      } catch (e) { if (!disposed) setCurrent({available:false, reason:e instanceof Error ? e.message : String(e)}); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [open, live, agent.id]);
  const apply = async (now: boolean) => {
    if (!selected || saving) return;
    setSaving(true); setApplyingNow(now); setError(undefined);
    try {
      if (await onApply(selected, now, confirmed, current)) setOpen(false);
      else setError('Could not finish applying permissions. Check the workspace error and retry.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const canApply = Boolean(selected) && (selected !== 'full-access' || confirmed) && !saving && !disabled;
  return <Dialog open={open} onOpenChange={value => {if (!saving) setOpen(value);}}>
    <DialogTrigger asChild><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={`Codex permissions for ${agent.name}`} title={`Codex permissions · Next open: ${modes.find(mode => mode.id === (agent.codexPermissionMode || 'ask-for-approval'))?.label}`} onClick={() => {selectionTouched.current = false; setSelected(agent.codexPermissionMode || 'ask-for-approval'); setConfirmed(false); setError(undefined);}}><Shield className="h-4 w-4" /></Button></DialogTrigger>
    <DialogContent className="flex flex-col overflow-hidden sm:max-w-lg"><DialogHeader>
      <DialogTitle>Codex permissions</DialogTitle>
      <DialogDescription>{agent.name} · {live ? `Current: ${modes.find(mode => mode.id === current?.mode)?.label || 'Not verified'}` : 'Choose the permission preference for the next start.'}</DialogDescription>
    </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto p-0.5"><p className="text-xs text-muted-foreground">Launch preference: <span className="font-medium text-foreground">{modes.find(mode => mode.id === (agent.codexPermissionMode || 'ask-for-approval'))?.label}</span></p>
      <fieldset disabled={saving || disabled} className="space-y-2"><legend className="sr-only">Permission mode</legend>{modes.map(mode => <label key={mode.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-ring ${selected === mode.id ? 'border-primary bg-primary/5' : 'border-border'}`}>
        <input type="radio" name={`codex-permissions-${agent.id}`} value={mode.id} checked={selected === mode.id} onChange={() => {selectionTouched.current = true; setSelected(mode.id); setConfirmed(false); setError(undefined);}} className="mt-1 shrink-0 accent-primary" />
        <span><span className="block text-sm font-medium">{mode.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{mode.description}</span></span>
      </label>)}</fieldset>
      {selected === 'full-access' && <label className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-xs leading-5"><input type="checkbox" className="mt-1 shrink-0 accent-primary" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} />I allow this Codex agent to use Full Access.</label>}
      {live && !current?.available && <p role="status" className="text-xs text-muted-foreground">{current?.reason || 'Checking the live session…'}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div><DialogFooter className="shrink-0 flex-wrap gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button type="button" variant={live ? 'outline' : 'default'} disabled={!canApply} onClick={() => void apply(false)}>{saving && !applyingNow && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{live ? 'Save for next open' : 'Save preference'}</Button>{live && <Button type="button" disabled={!canApply || !current?.available || current.applying} onClick={() => void apply(true)}>{saving && applyingNow && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Apply now</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
