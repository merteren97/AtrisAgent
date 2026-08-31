import { useState, useEffect } from 'react';
import { useWorkspaceStore, type Workspace } from '@/stores/workspace-store';
import { useMissionStore } from '@/stores/mission-store';
import { useMemoryStore, type MemorySnapshot } from '@/stores/memory-store';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import {
  Activity,
  AlertCircle,
  Brain,
  Check,
  CheckCircle2,
  Eye,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Loader2,
  ListTodo,
  Plus,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_ICONS = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />,
  reviewing: <Eye className="h-3.5 w-3.5 text-amber-400" />,
  planning: <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />,
  blocked: <AlertCircle className="h-3.5 w-3.5 text-destructive" />,
  completed: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
} as const;

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
  const { workspaces, activeWorkspaceId, setActiveWorkspace, removeWorkspace, fetchWorkspaces } = useWorkspaceStore();
  const { missions, fetchMissions } = useMissionStore();
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

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/80 bg-card/40 px-6 py-4 backdrop-blur-md">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground">
            <FolderGit2 className="h-5 w-5 text-primary" />
            Project Workspaces
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Manage local projects, execution isolation, and persistent project memory</p>
        </div>
        <div className="flex items-center gap-3">
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

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-7xl space-y-6 p-6">
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
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
              {workspaces.map((workspace) => {
                const workspaceMissions = missions.filter((mission) => mission.workspaceId === workspace.id);
                const recentMissions = [...workspaceMissions]
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .slice(0, 3);
                const isSelected = (selectedWsId || activeWorkspaceId) === workspace.id;
                const isActive = activeWorkspaceId === workspace.id;
                const workspaceMode = workspace.gitInitialized ? 'Git repository' : 'Managed mirror';

                return (
                  <Card
                    key={workspace.id}
                    className={cn(
                      'group relative flex cursor-pointer flex-col overflow-hidden border bg-card/60 p-5 backdrop-blur-sm transition-all duration-200 hover:shadow-lg',
                      isSelected ? 'border-primary ring-1 ring-primary/40 shadow-md' : 'border-border/70 hover:border-primary/40',
                      isActive && 'bg-primary/[0.03]',
                    )}
                    onClick={() => setSelectedWsId(workspace.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      setSelectedWsId(workspace.id);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    aria-label={`Select workspace ${workspace.name}`}
                  >
                    {isActive ? <div className="absolute left-0 right-0 top-0 h-1 bg-primary" /> : null}
                    <div className="mb-3 flex items-start justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors', isActive ? 'border-primary bg-primary text-primary-foreground' : 'border-primary/20 bg-primary/10 text-primary group-hover:bg-primary/20')}>
                          <FolderGit2 className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="truncate text-sm font-bold text-foreground">{workspace.name}</h3>
                            {isActive ? <Badge className="h-4 border-emerald-500/30 bg-emerald-500/20 px-1.5 text-[9px] font-bold tracking-wider text-emerald-400">ACTIVE</Badge> : null}
                          </div>
                          <p className="truncate font-mono text-[11px] text-muted-foreground" title={workspace.path}>{workspace.path}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 bg-background/50 text-[10px] font-semibold uppercase">{workspaceMissions.length} Missions</Badge>
                    </div>

                    <div className="mb-3 mt-auto flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/60 px-2 py-0.5 text-[11px] text-foreground"><GitBranch className="h-3 w-3 text-primary" />{workspaceMode}</div>
                      <div className="flex items-center gap-1.5 rounded-md border border-violet-500/15 bg-violet-500/5 px-2 py-0.5 text-[11px] text-violet-300"><Brain className="h-3 w-3" />Persistent memory</div>
                    </div>

                    <Separator className="my-2.5 opacity-60" />
                    <div className="space-y-1.5">
                      <h4 className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><span>Recent Missions</span><span className="text-[9px] opacity-75">{workspaceMissions.length} total</span></h4>
                      {recentMissions.length === 0 ? <p className="py-1 text-xs italic text-muted-foreground">No missions created yet</p> : recentMissions.map((mission) => (
                        <div key={mission.id} className="flex items-center gap-2 py-0.5 text-xs">
                          {STATUS_ICONS[mission.status as keyof typeof STATUS_ICONS] || STATUS_ICONS.running}
                          <span className="truncate font-medium text-foreground/90">{mission.title}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {selectedWorkspace ? (
            <div className="mt-8 animate-in fade-in slide-in-from-bottom-3 duration-200">
              <Card className="relative overflow-hidden rounded-2xl border-primary/30 bg-card/80 p-6 shadow-xl backdrop-blur-md">
                <div className="mb-6 flex flex-col justify-between gap-4 border-b border-border/80 pb-4 md:flex-row md:items-center">
                  <div>
                    <div className="mb-1 flex items-center gap-3">
                      <h2 className="text-xl font-bold text-foreground">{selectedWorkspace.name}</h2>
                      {activeWorkspaceId === selectedWorkspace.id ? (
                        <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/20 text-xs text-emerald-400"><Sparkles className="h-3 w-3" />Active Workspace</Badge>
                      ) : <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>}
                    </div>
                    <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><FolderOpen className="h-4 w-4 shrink-0 text-primary" /><span className="select-all">{selectedWorkspace.path}</span></p>
                  </div>

                  <div className="flex items-center gap-2">
                    {activeWorkspaceId !== selectedWorkspace.id ? (
                      <Button variant="default" size="sm" onClick={() => handleSetActive(selectedWorkspace.id, selectedWorkspace.name)} className="gap-1.5 bg-primary text-primary-foreground shadow-sm"><Check className="h-4 w-4" />Set as Active</Button>
                    ) : null}
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.alert(`Workspace folder: ${selectedWorkspace.path}`)}><Terminal className="h-4 w-4 text-primary" />Show Folder Path</Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void requestRemoval(selectedWorkspace)}
                      disabled={loadingRemovalInfo === selectedWorkspace.id}
                      className="gap-1.5"
                      title={`Delete workspace ${selectedWorkspace.name}`}
                      aria-label={`Delete workspace ${selectedWorkspace.name}`}
                    >
                      {loadingRemovalInfo === selectedWorkspace.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      <span className="hidden sm:inline">Delete workspace</span>
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                  <div className="space-y-4">
                    <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><Activity className="h-4 w-4 text-primary" />Mission Analytics</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-border/60 bg-muted/40 p-3.5"><div className="text-2xl font-bold text-foreground">{missions.filter((mission) => mission.workspaceId === selectedWorkspace.id && ACTIVE_MISSION_STATUSES.has(mission.status)).length}</div><div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Active</div></div>
                      <div className="rounded-xl border border-border/60 bg-muted/40 p-3.5"><div className="text-2xl font-bold text-emerald-400">{missions.filter((mission) => mission.workspaceId === selectedWorkspace.id && mission.status === 'completed').length}</div><div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Completed</div></div>
                    </div>
                  </div>

                  <div className="space-y-4 md:col-span-2">
                    <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground"><ShieldCheck className="h-4 w-4 text-primary" />Repository, Isolation & Memory</h3>
                    <div className="space-y-3 rounded-xl border border-border/80 bg-muted/30 p-4">
                      <div className="flex items-center justify-between gap-4 text-xs"><span className="font-medium text-muted-foreground">Workspace mode:</span><Badge variant="outline" className="font-mono">{selectedWorkspace.gitInitialized ? 'Git repository' : 'Managed mirror'}</Badge></div>
                      <div className="flex items-center justify-between gap-4 text-xs"><span className="font-medium text-muted-foreground">Project memory lifecycle:</span><Badge variant="outline" className="border-violet-500/20 bg-violet-500/5 font-mono text-violet-300">Project-scoped</Badge></div>
                      <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        Removing this workspace no longer implies deleting what AtrisAgent learned. You can retain the memory as a detached backup and reattach it automatically when the same repository or folder is added again.
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          ) : null}
        </div>
      </ScrollArea>

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
