import { useState } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrchestratorPreferencesStore, type OrchestratorPreferences } from '@/stores/orchestrator-preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const SELECT = 'mt-1.5 h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function OrchestratorPreferenceFields({ value, onChange }: { value: OrchestratorPreferences; onChange(patch: Partial<OrchestratorPreferences>): void }) {
  return <div className="grid gap-4 sm:grid-cols-2">
    <label className="text-sm font-medium">Team launch
      <select aria-label="Team launch" className={SELECT} value={value.teamLaunch} onChange={event => onChange({ teamLaunch: event.target.value as OrchestratorPreferences['teamLaunch'] })}>
        <option value="automatic">Choose and launch automatically</option><option value="confirm">Show team plan before launching</option>
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">Controls team startup. Action permissions remain separate.</span>
    </label>
    <label className="text-sm font-medium">Working mode
      <select aria-label="Working mode" className={SELECT} value={value.workMode} onChange={event => onChange({ workMode: event.target.value as OrchestratorPreferences['workMode'] })}>
        <option value="auto">Auto — follow the request</option><option value="research">Research — read-only</option><option value="plan">Plan — no workers or edits</option><option value="execute">Execute — implement and verify</option>
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">Explicit instructions to plan or wait are respected in Auto mode.</span>
    </label>
    <label className="text-sm font-medium">Model applies to
      <select aria-label="Model scope" className={SELECT} value={value.modelScope} onChange={event => onChange({ modelScope: event.target.value as OrchestratorPreferences['modelScope'] })}>
        <option value="coordinator">Coordinator only</option><option value="all">Coordinator and all specialists</option>
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">Active workers keep their model. Changes apply to new turns and tasks.</span>
    </label>
    <label className="text-sm font-medium">Action permissions
      <select aria-label="Action permissions" className={SELECT} value={value.trustMode} onChange={event => onChange({ trustMode: event.target.value as OrchestratorPreferences['trustMode'] })}>
        <option value="Review Driven">Ask before consequential actions</option><option value="Balanced">Review changes before applying</option><option value="Autonomous">Automatic within policy boundaries</option><option value="Candidate">Review alternative implementations</option>
      </select>
      <span className="mt-1.5 block text-xs font-normal leading-5 text-muted-foreground">Repository policies and runtime capabilities always apply.</span>
    </label>
  </div>;
}

export function OrchestratorDefaults() {
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const workspace = useWorkspaceStore(state => state.workspaces.find(item => item.id === workspaceId));
  const defaults = useOrchestratorPreferencesStore(state => state.defaults);
  const project = useOrchestratorPreferencesStore(state => workspaceId ? state.projects[workspaceId] : undefined);
  const [scope, setScope] = useState<'application' | 'project'>('application');
  const [saved, setSaved] = useState(false);
  const value = scope === 'project' ? project || defaults : defaults;
  const update = (patch: Partial<OrchestratorPreferences>) => {
    useOrchestratorPreferencesStore.getState().saveDefaults({ ...value, ...patch }, scope === 'project' ? workspaceId || undefined : undefined);
    setSaved(true);
  };
  return <section aria-label="Orchestrator defaults" className="space-y-5 rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><SlidersHorizontal className="h-4 w-4 text-muted-foreground" />Orchestrator defaults</h2><p className="mt-1 text-sm text-muted-foreground">Start simply. Customize a conversation from chat whenever you need to.</p></div><select aria-label="Defaults scope" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={scope} onChange={event => { setScope(event.target.value as typeof scope); setSaved(false); }}><option value="application">Application defaults</option><option value="project" disabled={!workspaceId}>This project{workspace ? ` · ${workspace.name}` : ''}</option></select></div>
    <OrchestratorPreferenceFields value={value} onChange={update} />
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><span role="status">{saved ? <span className="flex items-center gap-1"><Check className="h-3 w-3" />Saved locally</span> : 'New conversations inherit these defaults. Customized conversations keep their choices.'}</span>{scope === 'project' && project && workspaceId && <Button variant="ghost" size="sm" onClick={() => { useOrchestratorPreferencesStore.getState().resetProject(workspaceId); setSaved(false); }}>Use application defaults</Button>}</div>
  </section>;
}
