import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useMissionStore } from '@/stores/mission-store';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { CreateWorkspaceDialog } from '@/components/workspace/create-workspace-dialog';
import {
  FolderGit2,
  Plus,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Trash2,
  FolderOpen,
  Eye,
  Loader2,
  ListTodo,
  Activity,
  Check,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_ICONS = {
  running: <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />,
  reviewing: <Eye className="w-3.5 h-3.5 text-amber-400" />,
  planning: <ListTodo className="w-3.5 h-3.5 text-muted-foreground" />,
  blocked: <AlertCircle className="w-3.5 h-3.5 text-destructive" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />,
} as const;

export function ProjectsView() {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, removeWorkspace, fetchWorkspaces } = useWorkspaceStore();
  const { missions, fetchMissions } = useMissionStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    fetchWorkspaces();
    fetchMissions();
  }, [fetchWorkspaces, fetchMissions]);

  useEffect(() => {
    if (activeWorkspaceId && !selectedWsId) {
      setSelectedWsId(activeWorkspaceId);
    }
  }, [activeWorkspaceId, selectedWsId]);

  const selectedWorkspace = workspaces.find(w => w.id === (selectedWsId || activeWorkspaceId));

  const handleRemove = (id: string, name: string) => {
    removeWorkspace(id);
    if (selectedWsId === id) {
      setSelectedWsId(null);
    }
    setFeedback(`Workspace "${name}" removed successfully.`);
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleSetActive = (id: string, name: string) => {
    setActiveWorkspace(id);
    setSelectedWsId(id);
    setFeedback(`"${name}" is now the active workspace.`);
    setTimeout(() => setFeedback(null), 3000);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background w-full">
      <div className="px-6 py-4 border-b border-border/80 bg-card/40 backdrop-blur-md flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <FolderGit2 className="w-5 h-5 text-primary" />
            Project Workspaces
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage project directories, isolation mode, and execution missions
          </p>
        </div>
        <div className="flex items-center gap-3">
          {feedback && (
            <span className="text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1.5 rounded-full border border-emerald-500/20 animate-fade-in flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> {feedback}
            </span>
          )}
          <Button onClick={() => setIsDialogOpen(true)} size="sm" className="gap-1.5 shadow-sm bg-primary text-primary-foreground">
            <Plus className="w-4 h-4" />
            Add Workspace
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6 max-w-7xl mx-auto">
          {workspaces.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center border border-dashed border-border rounded-2xl bg-card/30">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
                <FolderGit2 className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-1">No Workspaces Registered</h3>
              <p className="text-xs text-muted-foreground mb-4 max-w-md">
                Add a local directory or project folder to allow AtrisAgent to orchestrate tasks and isolated worktrees or managed mirrors.
              </p>
              <Button onClick={() => setIsDialogOpen(true)} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Workspace
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {workspaces.map((ws) => {
                const wsMissions = missions.filter(m => m.workspaceId === ws.id);
                const recentMissions = wsMissions
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .slice(0, 3);
                const isSelected = (selectedWsId || activeWorkspaceId) === ws.id;
                const isActive = activeWorkspaceId === ws.id;
                const workspaceMode = ws.gitInitialized ? 'Git repository' : 'Managed mirror';
                const repositoryStatus = ws.gitInitialized ? 'Status not probed' : 'Non-Git isolation';

                return (
                  <Card
                    key={ws.id}
                    className={cn(
                      'p-5 flex flex-col cursor-pointer transition-all duration-200 border bg-card/60 backdrop-blur-sm relative overflow-hidden group hover:shadow-lg',
                      isSelected
                        ? 'border-primary ring-1 ring-primary/40 shadow-md'
                        : 'border-border/70 hover:border-primary/40',
                      isActive && 'bg-primary/[0.03]'
                    )}
                    onClick={() => setSelectedWsId(ws.id)}
                  >
                    {isActive && (
                      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-emerald-400 to-primary" />
                    )}

                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn(
                          'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border transition-colors',
                          isActive
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-primary/10 text-primary border-primary/20 group-hover:bg-primary/20'
                        )}>
                          <FolderGit2 className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-bold text-foreground truncate text-sm">{ws.name}</h3>
                            {isActive && (
                              <Badge variant="default" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px] h-4 px-1.5 uppercase font-bold tracking-wider">
                                ACTIVE
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground font-mono truncate" title={ws.path}>
                            {ws.path}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant="outline" className="text-[10px] uppercase font-semibold bg-background/50">
                          {wsMissions.length} Missions
                        </Badge>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 mb-3 mt-auto">
                      <div className="flex items-center gap-1.5 text-[11px] text-foreground bg-muted/60 rounded-md px-2 py-0.5 border border-border/50">
                        <GitBranch className="w-3 h-3 text-primary" />
                        <span>{workspaceMode}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground bg-muted/40 rounded-md px-2 py-0.5 border border-border/50">
                        <Activity className="w-3 h-3" />
                        <span>{repositoryStatus}</span>
                      </div>
                    </div>

                    <Separator className="my-2.5 opacity-60" />

                    <div className="space-y-1.5">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                        <span>Recent Missions</span>
                        <span className="text-[9px] opacity-75">{wsMissions.length} total</span>
                      </h4>
                      {recentMissions.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic py-1">No missions created yet</p>
                      ) : (
                        recentMissions.map(mission => (
                          <div key={mission.id} className="flex items-center gap-2 text-xs py-0.5">
                            {STATUS_ICONS[mission.status as keyof typeof STATUS_ICONS] || STATUS_ICONS.running}
                            <span className="truncate text-foreground/90 font-medium">{mission.title}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {selectedWorkspace && (
            <div className="mt-8 animate-in slide-in-from-bottom-3 fade-in duration-200">
              <Card className="p-6 border-primary/30 bg-card/80 backdrop-blur-md shadow-xl rounded-2xl relative overflow-hidden">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-border/80">
                  <div>
                    <div className="flex items-center gap-3 mb-1">
                      <h2 className="text-xl font-bold text-foreground">
                        {selectedWorkspace.name}
                      </h2>
                      {activeWorkspaceId === selectedWorkspace.id ? (
                        <Badge variant="default" className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 gap-1 text-xs">
                          <Sparkles className="w-3 h-3" /> Active Workspace
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono flex items-center gap-2">
                      <FolderOpen className="w-4 h-4 text-primary shrink-0" />
                      <span className="select-all">{selectedWorkspace.path}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {activeWorkspaceId !== selectedWorkspace.id && (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleSetActive(selectedWorkspace.id, selectedWorkspace.name)}
                        className="bg-primary text-primary-foreground gap-1.5 shadow-sm"
                      >
                        <Check className="w-4 h-4" />
                        Set as Active
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 cursor-pointer"
                      onClick={() => alert(`Workspace folder: ${selectedWorkspace.path}`)}
                    >
                      <Terminal className="w-4 h-4 text-primary" />
                      Show Folder Path
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRemove(selectedWorkspace.id, selectedWorkspace.name)}
                      className="gap-1.5 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-4">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                      <Activity className="w-4 h-4 text-primary" />
                      Mission & Task Analytics
                    </h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-muted/40 border border-border/60 rounded-xl p-3.5">
                        <div className="text-2xl font-bold text-foreground">
                          {missions.filter(m => m.workspaceId === selectedWorkspace.id && ['running', 'planning', 'applying'].includes(m.status)).length}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mt-0.5">Active Missions</div>
                      </div>
                      <div className="bg-muted/40 border border-border/60 rounded-xl p-3.5">
                        <div className="text-2xl font-bold text-emerald-400">
                          {missions.filter(m => m.workspaceId === selectedWorkspace.id && m.status === 'completed').length}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mt-0.5">Completed</div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 md:col-span-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-primary" />
                      Repository & Isolation Status
                    </h3>
                    <div className="bg-muted/30 border border-border/80 rounded-xl p-4 space-y-3">
                      <div className="flex justify-between items-center gap-4 text-xs">
                        <span className="text-muted-foreground font-medium">Workspace mode:</span>
                        <Badge variant="outline" className="font-mono">
                          {selectedWorkspace.gitInitialized ? 'Git repository' : 'Managed mirror'}
                        </Badge>
                      </div>
                      <div className="flex justify-between items-center gap-4 text-xs">
                        <span className="text-muted-foreground font-medium">Live branch / worktree telemetry:</span>
                        <Badge variant="outline" className="font-mono text-muted-foreground">
                          {selectedWorkspace.gitInitialized ? 'Not probed' : 'Not applicable'}
                        </Badge>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                        Builder isolation is created automatically per mission task. The workspace list API does not currently expose live branch, dirty-state, or active worktree telemetry, so this screen does not infer or fabricate those values.
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </ScrollArea>
      <CreateWorkspaceDialog open={isDialogOpen} onOpenChange={setIsDialogOpen} />
    </div>
  );
}
