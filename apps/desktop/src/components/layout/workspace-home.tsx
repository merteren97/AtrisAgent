import { ArrowRight, Bot, FolderGit2, MessageSquare, Plus, TerminalSquare, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';

export function ConversationChoice() {
  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const workspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  const manualConversations = useManualStore(s => s.conversations);
  const conversations = workspaceId ? manualConversations[workspaceId] || [] : [];
  const missions = useMissionStore(s => s.missions);
  const availableModels = useAccountStore(s => s.discoveredModels.filter(m => m.available).length);
  const recent = [
    ...conversations.map(c => ({id:c.id, title:c.title, mode:'Manual', detail:`${c.agents.length} independent agent${c.agents.length === 1 ? '' : 's'}`, date:c.createdAt, open:() => useManualStore.getState().select(c)})),
    ...missions.filter(m => m.workspaceId === workspaceId).map(m => ({id:m.id, title:m.title, mode:'Orchestrator', detail:m.status.replaceAll('_',' '), date:m.createdAt || '', open:() => useMissionStore.getState().setActiveMission(m.id)})),
  ].sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
  const startManual = () => { useManualStore.getState().setMode('manual'); useManualStore.getState().setCreating(true); };
  const startOrchestrator = () => { useMissionStore.getState().clearActiveMission(); useManualStore.getState().setMode('orchestrator'); };

  return <section className="workspace-home min-h-0 flex-1 overflow-y-auto" aria-label="Workspace home">
    <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-10 lg:py-10">
      <div className="mb-7 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><FolderGit2 className="h-4 w-4" />{workspace ? 'Project workspace' : 'Welcome to AtrisAgent'}</p>
          <h2 className="truncate text-2xl font-semibold tracking-tight">{workspace?.name || 'A place for your next idea'}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Start a conversation. Keep your agents and their work in one place.</p>
        </div>
        <Button variant="outline" size="sm" className="hidden shrink-0 sm:inline-flex" onClick={() => useSettingsStore.getState().setActiveView('projects')}><FolderGit2 className="mr-2 h-4 w-4" />Projects</Button>
      </div>

      <div className="mb-4 flex items-center gap-2"><h3 className="text-sm font-semibold">Start working</h3><span className="text-xs text-muted-foreground">Choose how agents work</span></div>
      <div className="grid gap-4 @min-[620px]:grid-cols-2">
        <button disabled={!workspace} onClick={startManual} className="workspace-mode-card group flex flex-col rounded-2xl border border-border bg-card p-6 text-left transition-colors hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
          <div className="mb-5 flex w-full items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><TerminalSquare className="h-5 w-5" /></span><span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground">You lead</span></div>
          <h4 className="text-lg font-semibold tracking-tight">Manual workspace</h4>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Choose a CLI and model. Talk to independent agents or work directly in their terminals.</p>
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" />Chat + Code</span><span className="flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" />Independent sessions</span></div>
          <span className="mt-6 flex w-full items-center justify-between border-t border-border pt-4 text-sm font-medium text-primary">Create manual conversation<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" /></span>
        </button>
        <button disabled={!workspace} onClick={startOrchestrator} className="workspace-mode-card group flex flex-col rounded-2xl border border-border bg-card p-6 text-left transition-colors hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
          <div className="mb-5 flex w-full items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-foreground"><Workflow className="h-5 w-5" /></span><span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground">Agents coordinate</span></div>
          <h4 className="text-lg font-semibold tracking-tight">Orchestrator</h4>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Describe a goal. Let the orchestrator plan, delegate and bring the whole workflow together.</p>
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"><span>One conversation</span><span>Coordinated workflow</span></div>
          <span className="mt-6 flex w-full items-center justify-between border-t border-border pt-4 text-sm font-medium">Start orchestrated conversation<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1 motion-reduce:transform-none" /></span>
        </button>
      </div>

      {!workspace ? <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"><p className="text-sm text-muted-foreground">Open a project before starting your first conversation.</p><Button onClick={() => useSettingsStore.getState().setActiveView('projects')}><Plus className="mr-2 h-4 w-4" />Open a project</Button></div>
        : availableModels === 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"><p className="text-xs leading-5 text-muted-foreground">No available model in the current catalog. Connect a CLI account to get started.</p><Button size="sm" variant="outline" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>Connect an account</Button></div>}

      <div className="mb-3 mt-8 flex items-center justify-between"><h3 className="text-sm font-semibold">Recent conversations</h3><span className="text-xs text-muted-foreground">{workspace ? 'In this project' : 'Your work stays organized here'}</span></div>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">
        {recent.length ? recent.map(item => <button key={item.id} onClick={item.open} className="flex w-full items-center gap-3 px-4 py-3.5 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">{item.mode === 'Manual' ? <TerminalSquare className="h-4 w-4" /> : <Workflow className="h-4 w-4" />}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{item.detail}</span></span><span className="hidden text-xs text-muted-foreground sm:inline">{item.mode}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>) : <div className="flex items-center gap-3 px-4 py-5"><MessageSquare className="h-5 w-5 shrink-0 text-muted-foreground" /><div><p className="text-sm font-medium">Ready when you are</p><p className="mt-1 text-xs text-muted-foreground">Your conversations will appear here once you start.</p></div></div>}
      </div>
    </div>
  </section>;
}
