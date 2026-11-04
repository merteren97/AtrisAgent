import { useState } from 'react';
import { Shield, Loader2, Code2 } from 'lucide-react';
import type { CodexPermissionMode } from '@atris-agent-code/domain';
import type { ManualAgent } from '@/stores/manual-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

const modes: {id: CodexPermissionMode; label: string; description: string}[] = [
  {id:'ask-for-approval', label:'Ask for approval', description:'Work inside the workspace. Ask you before escalating access.'},
  {id:'approve-for-me', label:'Approve for me', description:'Keep the workspace sandbox. Codex reviews requests for extra access.'},
  {id:'full-access', label:'Full Access', description:'Allow filesystem and network access without ordinary sandbox or approval prompts.'},
  {id:'read-only', label:'Read Only', description:'Read workspace files. Edits and extra access require approval.'},
];

export function CodexPermissions({agent, live, bound, disabled, onApply, onOpenCode}: {
  agent: ManualAgent; live: boolean; bound: boolean; disabled: boolean;
  onApply: (mode: CodexPermissionMode, reopen: boolean, fullAccessConfirmed: boolean) => Promise<boolean>;
  onOpenCode: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<CodexPermissionMode>(agent.codexPermissionMode || 'ask-for-approval');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const apply = async (reopen: boolean) => {
    if (!selected || saving) return;
    setSaving(true); setError(undefined);
    try {
      if (await onApply(selected, reopen, confirmed)) setOpen(false);
      else setError('Could not finish applying permissions. Check the workspace error and retry.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const canApply = Boolean(selected) && (selected !== 'full-access' || confirmed) && !saving && !disabled;
  return <Dialog open={open} onOpenChange={value => {if (!saving) setOpen(value);}}>
    <DialogTrigger asChild><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={`Codex permissions for ${agent.name}`} title={`Codex permissions · ${modes.find(mode => mode.id === (agent.codexPermissionMode || 'ask-for-approval'))?.label}`} onClick={() => {setSelected(agent.codexPermissionMode || 'ask-for-approval'); setConfirmed(false); setError(undefined);}}><Shield className="h-4 w-4" /></Button></DialogTrigger>
    <DialogContent className="flex flex-col overflow-hidden sm:max-w-lg"><DialogHeader>
      <DialogTitle>Codex permissions</DialogTitle>
      <DialogDescription>{agent.name} · Choose this agent’s permission mode for its next start or resume. The CLI remains authoritative for live permissions.</DialogDescription>
    </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto p-0.5"><p className="text-xs text-muted-foreground">Launch preference: <span className="font-medium text-foreground">{modes.find(mode => mode.id === (agent.codexPermissionMode || 'ask-for-approval'))?.label}</span></p>
      <fieldset disabled={saving || disabled} className="space-y-2"><legend className="sr-only">Permission mode</legend>{modes.map(mode => <label key={mode.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-ring ${selected === mode.id ? 'border-primary bg-primary/5' : 'border-border'}`}>
        <input type="radio" name={`codex-permissions-${agent.id}`} value={mode.id} checked={selected === mode.id} onChange={() => {setSelected(mode.id); setConfirmed(false);}} className="mt-1 shrink-0 accent-primary" />
        <span><span className="block text-sm font-medium">{mode.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{mode.description}</span></span>
      </label>)}</fieldset>
      {selected === 'full-access' && <label className="flex items-start gap-2 rounded-lg bg-destructive/5 p-3 text-xs leading-5"><input type="checkbox" className="mt-1 shrink-0 accent-primary" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} />I allow this Codex agent to use Full Access when it starts or resumes.</label>}
      {live && <div className="rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground"><p>Apply &amp; reopen stops the current CLI and resumes its bound conversation. Wait for any active task to finish first. Save for next open leaves the running CLI as it is.</p>{!bound && <p className="mt-2">Session binding is not ready; reopening is unavailable. Complete CLI setup in Code first.</p>}<Button type="button" size="sm" variant="link" className="mt-1 h-auto p-0 text-xs" disabled={saving} onClick={() => {setOpen(false); onOpenCode();}}><Code2 className="mr-1 h-3 w-3" />Change live in Code using /permissions</Button></div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div><DialogFooter className="shrink-0 flex-wrap gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button type="button" variant={live ? 'outline' : 'default'} disabled={!canApply} onClick={() => void apply(false)}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{live ? 'Save for next open' : 'Save preference'}</Button>{live && <Button type="button" disabled={!canApply || !bound} onClick={() => void apply(true)}>Apply &amp; reopen</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
