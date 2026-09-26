import { useState, useEffect } from 'react';
import { useWorkspaceStore, type Workspace } from '@/stores/workspace-store';
import { useMissionStore, type Mission } from '@/stores/mission-store';
import { useManualStore } from '@/stores/manual-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useMemoryStore, type MemorySnapshot } from '@/stores/memory-store';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import {
  Activity,
  AlertCircle,
  Brain,
  Check,
  FolderGit2,
  FolderOpen,
  Loader2,
  ListTodo,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { missionStatusLabel } from '@/lib/mission-display';

const ACTIVE_MISSION_STATUSES = new Set([
  'planning',
  'ready',
  'running',
  'waiting_for_approval',
  'applying',
  'reviewing',
  'verifying',
  'revising',
]);

interface PendingWorkspaceRemoval {
  workspace: Workspace;
  memory: MemorySnapshot | null;
  missionCount: number;
  activeMissionCount: number;
}

export function ProjectsView() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, rememberMission, removeWorkspace, fetchWorkspaces } = useWorkspaceStore();
  const { missions, fetchMissions, setActiveMission } = useMissionStore();
  const { loadWorkspaceMemory, fetchProjects: fetchMemoryProjects, mutating: memoryMutating } = useMemoryStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingWorkspaceRemoval | null>(null);
  const [removing, setRemoving] = useState(false);
  const [loadingRemovalInfo, setLoadingRemovalInfo] = useState<string | null>(null);
  const [removeMemory, setRemoveMemory] = useState(false);
  const [removalError, setRemovalError] = useState<string | null>(null);

  useEffect(() => {
    void fetchWorkspaces();
    void fetchMissions();
  }, [fetchWorkspaces, fetchMissions]);

  useEffect(() => {
    if (activeWorkspaceId && !selectedWsId) setSelectedWsId(activeWorkspaceId);
  }, [activeWorkspaceId, selectedWsId]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === (selectedWsId || activeWorkspaceId));
  const recentSelectedMissions = selectedWorkspace
    ? missions.filter((mission) => mission.workspaceId === selectedWorkspace.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 4)
    : [];

  const flash = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 4200);
  };

  const requestRemoval = async (workspace: Workspace) => {
    setLoadingRemovalInfo(workspace.id);
    setRemovalError(null);
    setRemoveMemory(false);
    try {
      await fetchMissions(workspace.id);
      const missionState = useMissionStore.getState();
      if (missionState.error) throw new Error(`Could not verify workspace conversations: ${missionState.error}`);
      const authoritativeMissions = missionState.missions;
      const workspaceMissions = authoritativeMissions.filter((mission) => mission.workspaceId === workspace.id);
      const activeMissionCount = workspaceMissions.filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status)).length;
      const memory = await loadWorkspaceMemory(workspace.id);
      const memoryError = useMemoryStore.getState().error;
      if (memoryError) throw new Error(`Could not inspect workspace memory: ${memoryError}`);
      setPendingRemoval({ workspace, memory, missionCount: workspaceMissions.length, activeMissionCount });
    } catch (cause: any) {
      flash(`${cause?.message || 'Could not prepare workspace deletion.'} Check the local service, then retry.`);
    } finally {
      setLoadingRemovalInfo(null);
    }
  };

  const finishWorkspaceStateRemoval = (workspaceId: string) => {
    if (selectedWsId === workspaceId) setSelectedWsId(null);
    setPendingRemoval(null);
  };

  const confirmWorkspaceRemoval = async () => {
    const pending = pendingRemoval;
    if (!pending) return;
    setRemoving(true);
    setRemovalError(null);
    try {
      await fetchMissions(pending.workspace.id);
      const missionState = useMissionStore.getState();
      if (missionState.error) throw new Error(`Could not verify workspace conversations: ${missionState.error}`);
      const latestActiveCount = missionState.missions.filter((mission) => (
        mission.workspaceId === pending.workspace.id && ACTIVE_MISSION_STATUSES.has(mission.status)
      )).length;
      if (latestActiveCount > 0) {
        throw new Error(`Stop the ${latestActiveCount} active conversation${latestActiveCount === 1 ? '' : 's'} before deleting this workspace.`);
      }

      await removeWorkspace(pending.workspace.id, removeMemory);
      await fetchMissions();
      await fetchMemoryProjects();
      finishWorkspaceStateRemoval(pending.workspace.id);
      flash(removeMemory
        ? `Workspace "${pending.workspace.name}" and its workspace-attributable memory were deleted. Project files and shared memory were retained.`
        : `Workspace "${pending.workspace.name}" removed. Project files and memory were retained.`);
    } catch (cause: any) {
      setRemovalError(cause?.message || 'Workspace deletion failed.');
    } finally {
      setRemoving(false);
    }
  };

  const handleSetActive = (id: string, name: string) => {
    setActiveWorkspace(id);
    setSelectedWsId(id);
    flash(`"${name}" is now the active workspace.`);
  };
  const openWorkspace = (id: string) => {
    setActiveWorkspace(id);
    useManualStore.getState().setMode('choose');
    useSettingsStore.getState().setActiveView('chat');
  };
  const openMission = (mission: Mission) => {
    setActiveWorkspace(mission.workspaceId);
    rememberMission(mission.workspaceId, mission.id);
    setActiveMission(mission.id);
    useManualStore.getState().setMode('orchestrator');
    useSettingsStore.getState().setActiveView('chat');
  };

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col bg-background">
       <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
         <div className="min-w-0">
           <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
            <FolderGit2 className="h-5 w-5 text-primary" />
            Project Workspaces
          </h1>
           <p className="mt-0.5 text-xs text-muted-foreground">Choose a project to continue work or inspect its details.</p>
        </div>
         <div className="flex min-w-0 items-center gap-3">
          {feedback ? (
            <span role="status" aria-live="polite" className="flex max-w-[520px] items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-400">
              <Check className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{feedback}</span>
            </span>
          ) : null}
          <Button onClick={() => setIsDialogOpen(true)} size="sm" className="gap-1.5 bg-primary text-primary-foreground shadow-sm">
            <Plus className="h-4 w-4" />Add Workspace
          </Button>
        </div>
      </div>

       <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
         <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
           <div className="project-browser">
            {workspaces.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/30 py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                <FolderGit2 className="h-8 w-8 text-primary" />
              </div>
              <h3 className="mb-1 text-lg font-semibold text-foreground">No Workspaces Registered</h3>
              <p className="mb-4 max-w-md text-xs text-muted-foreground">Add a local directory to orchestrate work while AtrisAgent builds reusable, project-scoped memory over time.</p>
              <Button onClick={() => setIsDialogOpen(true)} size="sm"><Plus className="mr-2 h-4 w-4" />Add Workspace</Button>
            </div>
          ) : (
            <div className="min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {workspaces.map((workspace) => {
                const workspaceMissions = missions.filter((mission) => mission.workspaceId === workspace.id);
                const recentMissions = [...workspaceMissions]
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .slice(0, 3);
                const isSelected = (selectedWsId || activeWorkspaceId) === workspace.id;
                const isActive = activeWorkspaceId === workspace.id;
                 return (
                   <div
                     key={workspace.id}
                     data-selected={isSelected}
                     className={cn(
                       'project-workspace-row group flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40',
                       isSelected && 'bg-primary/[0.07]',
                     )}
                   >
                     <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}><FolderGit2 className="h-4 w-4" /></span>
                      <button type="button" className="min-w-0 flex-1 overflow-hidden text-left focus-visible:rounded focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSelectedWsId(workspace.id)} aria-pressed={isSelected} aria-label={`Inspect workspace ${workspace.name}`}>
                        <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 truncate text-sm font-medium" title={workspace.name}>{workspace.name}</span>{isActive && <span className="shrink-0 text-[10px] font-medium text-primary">Active</span>}</span>
                       <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={workspace.path}>{workspace.path}</span>
                        <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={recentMissions.map(m => m.title).join(' · ')}>{recentMissions.length ? recentMissions.map(m => m.title).join(' · ') : 'No orchestrated conversations yet'}</span>
                     </button>
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => openWorkspace(workspace.id)} aria-label={`Open ${workspace.name}`}>Open</Button>
                   </div>
                );
              })}
            </div>
          )}

          {selectedWorkspace ? (
              <div className="min-w-0">
                <Card className="relative min-w-0 gap-0 overflow-hidden rounded-xl border-border bg-card p-4 shadow-none sm:p-5">
                 <div className="mb-5 min-w-0 border-b border-border/80 pb-4">
                  <div className="min-w-0">
                    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
                      <h2 className="min-w-0 break-words text-base font-semibold text-foreground">{selectedWorkspace.name}</h2>
                      {activeWorkspaceId === selectedWorkspace.id ? (
                         <Badge variant="secondary" className="text-xs">Active workspace</Badge>
                      ) : <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>}
                    </div>
                     <p className="flex min-w-0 items-start gap-2 font-mono text-xs text-muted-foreground"><FolderOpen className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 select-all break-all">{selectedWorkspace.path}</span></p>
                  </div>

                 </div>

                  <div className="grid min-w-0 gap-5 @min-[550px]:grid-cols-2">
                   <div>
                     <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><Activity className="h-4 w-4" />Conversations</h3>
                     <p className="mt-3 text-sm"><strong className="mr-1 tabular-nums">{missions.filter((mission) => mission.workspaceId === selectedWorkspace.id && ACTIVE_MISSION_STATUSES.has(mission.status)).length}</strong><span className="text-muted-foreground">active</span><span className="mx-2 text-border">·</span><strong className="mr-1 tabular-nums">{missions.filter((mission) => mission.workspaceId === selectedWorkspace.id && mission.status === 'completed').length}</strong><span className="text-muted-foreground">completed</span></p>
                   </div>
                   <div>
                     <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground"><ShieldCheck className="h-4 w-4" />Repository & memory</h3>
                      <p className="mt-3 text-sm">{selectedWorkspace.gitInitialized ? 'Git repository' : 'Managed mirror'} <span className="mx-2 text-border">·</span> Project-scoped memory</p>
                     <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">Removing a workspace can retain its memory for reattachment when the folder is added again.</p>
                   </div>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/80 pt-4">
                    {activeWorkspaceId !== selectedWorkspace.id ? (
                      <Button variant="default" size="sm" onClick={() => handleSetActive(selectedWorkspace.id, selectedWorkspace.name)} className="gap-1.5"><Check className="h-4 w-4" />Set as Active</Button>
                    ) : <span className="text-xs text-muted-foreground">Workspace is ready for conversations.</span>}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void requestRemoval(selectedWorkspace)}
                      disabled={loadingRemovalInfo === selectedWorkspace.id}
                      className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      title={`Delete workspace ${selectedWorkspace.name}`}
                      aria-label={`Delete workspace ${selectedWorkspace.name}`}
                    >
                      {loadingRemovalInfo === selectedWorkspace.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      Delete workspace
                    </Button>
                  </div>
               </Card>
            </div>
           ) : null}
           </div>
           {selectedWorkspace && recentSelectedMissions.length > 0 && (
             <section aria-label={`Recent conversations in ${selectedWorkspace.name}`} className="mt-5 min-w-0 overflow-hidden rounded-xl border border-border bg-card/40">
               <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
                 <div>
                   <h3 className="text-sm font-semibold text-foreground">Recent conversations</h3>
                   <p className="mt-0.5 text-xs text-muted-foreground">Continue work in {selectedWorkspace.name} or review an earlier result.</p>
                 </div>
                 <Badge variant="outline" className="text-[10px] text-muted-foreground">{recentSelectedMissions.length} recent</Badge>
               </div>
               <div className="divide-y divide-border/60">
                 {recentSelectedMissions.map((mission) => (
                   <button key={mission.id} type="button" onClick={() => openMission(mission)} className="flex min-w-0 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                     <Activity className="h-4 w-4 shrink-0 text-primary" />
                     <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={mission.title}>{mission.title}</span>
                     <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground sm:inline">{new Date(mission.createdAt).toLocaleDateString()}</span>
                     <Badge variant={mission.status === 'completed' ? 'success' : mission.status === 'failed' ? 'destructive' : 'secondary'} className="shrink-0 text-[10px] capitalize">{missionStatusLabel(mission.status)}</Badge>
                   </button>
                 ))}
               </div>
             </section>
           )}
         </div>
       </div>

      <CreateWorkspaceDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />

      <Dialog open={Boolean(pendingRemoval)} onOpenChange={(open) => !open && !removing && setPendingRemoval(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive"><Trash2 className="h-4 w-4" /></div>
            <DialogTitle>Remove project workspace?</DialogTitle>
            <DialogDescription className="leading-relaxed">
              This removes the workspace and all conversations stored inside it, including their timelines, tasks, events, and managed worktrees. Keeping memory is the recommended option and allows the same repository/folder to continue from its previous memory later.
            </DialogDescription>
          </DialogHeader>

          {pendingRemoval ? (
            <div className="space-y-3">
               <div className="rounded-lg border border-border bg-muted/25 p-3">
                 <div className="text-sm font-semibold">{pendingRemoval.workspace.name}</div>
                 <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{pendingRemoval.workspace.path}</div>
                 <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                   <ListTodo className="h-3 w-3 text-primary" />
                   {pendingRemoval.missionCount} conversation{pendingRemoval.missionCount === 1 ? '' : 's'} will be deleted
                 </div>
               </div>

              {pendingRemoval.activeMissionCount > 0 ? (
                <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-300">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div><strong>Stop active work first.</strong><div className="mt-1 text-[11px] leading-relaxed text-amber-200/80">This workspace still has {pendingRemoval.activeMissionCount} active mission{pendingRemoval.activeMissionCount === 1 ? '' : 's'}. Cancelling/removing a project while agents are using it could destroy execution context.</div></div>
                </div>
              ) : null}

              {removalError ? <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-xs text-destructive">{removalError}</div> : null}

              {pendingRemoval.memory ? (
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-violet-200"><Brain className="h-4 w-4" />Project memory detected</div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-background/60 p-2"><div className="font-semibold">{pendingRemoval.memory.nodes.length}</div><div className="text-[9px] uppercase text-muted-foreground">Nodes</div></div>
                    <div className="rounded-md bg-background/60 p-2"><div className="font-semibold">{pendingRemoval.memory.edges.length}</div><div className="text-[9px] uppercase text-muted-foreground">Links</div></div>
                    <div className="rounded-md bg-background/60 p-2"><div className="font-semibold">{pendingRemoval.memory.evidenceCount}</div><div className="text-[9px] uppercase text-muted-foreground">Evidence</div></div>
                  </div>
                  {(pendingRemoval.memory.activeWorkspaceIds.filter((id) => id !== pendingRemoval.workspace.id).length > 0) ? (
                    <p className="mt-2 text-[10px] leading-relaxed text-amber-300">Memory shared with another workspace will be preserved; only provenance attributable to this workspace will be removed.</p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">No accumulated project-memory snapshot was found for this workspace yet.</div>
              )}
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={removeMemory}
                  onChange={(event) => setRemoveMemory(event.target.checked)}
                  disabled={!pendingRemoval.memory || removing}
                />
                <span><strong>Also remove workspace-associated memory</strong><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">Project files and already-applied code are always retained. Leave unchecked to keep memory as a detached backup.</span></span>
              </label>
            </div>
          ) : null}

          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={() => setPendingRemoval(null)} disabled={removing || memoryMutating}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmWorkspaceRemoval()} disabled={!pendingRemoval || removing}>
              {removing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
