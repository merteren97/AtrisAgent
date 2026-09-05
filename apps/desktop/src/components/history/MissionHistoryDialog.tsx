import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMissionStore, type Mission, type MissionStatus } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { ConversationDeleteDialog } from './ConversationDeleteDialog';
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FolderGit2,
  History,
  ListTodo,
  PlayCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
  XCircle,
  Trash2,
} from 'lucide-react';

interface MissionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type HistoryFilter = 'all' | 'completed' | 'attention' | 'active';

const ACTIVE_MISSION_STATUSES = new Set<MissionStatus>([
  'planning',
  'ready',
  'running',
  'waiting_for_approval',
  'applying',
  'reviewing',
  'verifying',
  'revising',
]);

function getStatusIcon(status: MissionStatus, className = 'h-4 w-4') {
  switch (status) {
    case 'completed': return <CheckCircle2 className={`${className} text-success`} />;
    case 'failed': return <XCircle className={`${className} text-destructive`} />;
    case 'cancelled': return <XCircle className={`${className} text-muted-foreground`} />;
    case 'running': return <PlayCircle className={`${className} text-primary`} />;
    default: return <AlertCircle className={`${className} text-warning`} />;
  }
}

function getStatusVariant(status: MissionStatus): 'success' | 'destructive' | 'secondary' | 'default' | 'outline' {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'destructive';
    case 'cancelled': return 'secondary';
    case 'running': return 'default';
    default: return 'outline';
  }
}

function getStatusLabel(status: MissionStatus): string {
  return status.replaceAll('_', ' ');
}

function getStatusDescription(status: MissionStatus): string {
  switch (status) {
    case 'completed': return 'This mission finished successfully. Its timeline and execution record are ready to review.';
    case 'failed': return 'This mission stopped after an error. Review its timeline to inspect the recorded failure.';
    case 'cancelled': return 'This mission was cancelled. Completed activity remains available for reference.';
    case 'blocked': return 'This mission is blocked and needs attention before it can continue.';
    default: return 'This mission is still in progress. Open it to continue following the live execution context.';
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function MissionHistoryDialog({ open, onOpenChange }: MissionHistoryDialogProps) {
  const { missions, setActiveMission, activeMissionId } = useMissionStore();
  const { workspaces, activeWorkspaceId, setActiveWorkspace, rememberMission } = useWorkspaceStore();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Mission | null>(null);

  useEffect(() => {
    if (open) setSelectedMissionId(activeMissionId);
  }, [activeMissionId, open]);

  const normalizedSearch = search.trim().toLowerCase();
  const filteredMissions = missions.filter((mission) => {
    const workspaceName = workspaces.find((workspace) => workspace.id === mission.workspaceId)?.name || '';
    const matchesSearch = !normalizedSearch
      || mission.title.toLowerCase().includes(normalizedSearch)
      || workspaceName.toLowerCase().includes(normalizedSearch)
      || Boolean(mission.checkpointId?.toLowerCase().includes(normalizedSearch));
    const matchesFilter = filter === 'all'
      || (filter === 'completed' && mission.status === 'completed')
      || (filter === 'attention' && ['failed', 'blocked'].includes(mission.status))
      || (filter === 'active' && ACTIVE_MISSION_STATUSES.has(mission.status));
    return matchesSearch && matchesFilter;
  });

  const selectedMission = filteredMissions.find((mission) => mission.id === selectedMissionId) || filteredMissions[0] || null;
  const completedCount = missions.filter((mission) => mission.status === 'completed').length;
  const attentionCount = missions.filter((mission) => ['failed', 'blocked'].includes(mission.status)).length;
  const activeCount = missions.filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status)).length;

  const filters: Array<{ id: HistoryFilter; label: string; count: number }> = [
    { id: 'all', label: 'All missions', count: missions.length },
    { id: 'completed', label: 'Completed', count: completedCount },
    { id: 'attention', label: 'Needs attention', count: attentionCount },
    { id: 'active', label: 'Active', count: activeCount },
  ];

  const handleOpenMission = (missionId: string) => {
    const mission = missions.find((item) => item.id === missionId);
    if (!mission) return;
    rememberMission(mission.workspaceId, mission.id);
    if (mission.workspaceId !== activeWorkspaceId) setActiveWorkspace(mission.workspaceId);
    setActiveMission(mission.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(780px,calc(100vh-2rem))] w-full max-w-[980px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[980px]">
        <DialogHeader className="shrink-0 border-b border-border/80 bg-card/70 px-5 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <History className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Activity archive</p>
                <DialogTitle className="mt-1 text-xl tracking-tight">Mission history</DialogTitle>
                <DialogDescription className="mt-2 max-w-xl text-xs leading-relaxed">
                  Reopen a previous conversation and inspect the execution context that shaped its result.
                </DialogDescription>
              </div>
            </div>
            <Badge variant="outline" className="shrink-0 gap-1.5 rounded-full bg-background/50 text-[10px] text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" />
              {missions.length} total
            </Badge>
          </div>

          <div className="mt-5 grid max-w-xl grid-cols-3 gap-2">
            <div className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">All missions</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{missions.length}</div>
            </div>
            <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2.5">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-success/80">Completed</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-success">{completedCount}</div>
            </div>
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2.5">
              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-warning/80">Attention</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-warning">{attentionCount}</div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <section aria-label="Mission archive list" className="flex min-h-0 max-h-[46%] flex-col border-b border-border/80 bg-background/30 lg:max-h-none lg:w-[42%] lg:border-b-0 lg:border-r">
            <div className="shrink-0 space-y-3 p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search missions, projects, or checkpoints"
                  className="h-9 border-border/70 bg-card/60 pl-9 pr-9 text-xs"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Search mission history"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Clear mission search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Mission history filters">
                <SlidersHorizontal className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {filters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === item.id}
                    onClick={() => setFilter(item.id)}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition-colors ${filter === item.id ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border/70 bg-card/40 text-muted-foreground hover:bg-card hover:text-foreground'}`}
                  >
                    {item.label}
                    <span className="tabular-nums opacity-70">{item.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1 px-3 pb-4">
              <div className="space-y-1.5">
                {filteredMissions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/80 bg-card/30 px-4 py-10 text-center">
                    <Search className="mx-auto h-5 w-5 text-muted-foreground/60" />
                    <p className="mt-3 text-xs font-medium text-foreground">No missions found</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Try another search term or clear the active filter.</p>
                  </div>
                ) : filteredMissions.map((mission) => {
                  const isSelected = selectedMission?.id === mission.id;
                  const isActive = activeMissionId === mission.id;
                  const workspaceName = workspaces.find((workspace) => workspace.id === mission.workspaceId)?.name || 'Unknown workspace';
                  return (
                    <button
                      key={mission.id}
                      type="button"
                      onClick={() => setSelectedMissionId(mission.id)}
                      aria-pressed={isSelected}
                      className={`group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all ${isSelected ? 'border-primary/40 bg-primary/[0.08] shadow-sm' : 'border-transparent bg-card/35 hover:border-border/80 hover:bg-card/70'}`}
                    >
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${isSelected ? 'border-primary/25 bg-primary/10' : 'border-border/70 bg-background/60'}`}>
                        {getStatusIcon(mission.status, 'h-4 w-4')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{mission.title}</span>
                          {isActive ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Currently open" /> : null}
                        </span>
                        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                          <FolderGit2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{workspaceName}</span>
                          <span className="shrink-0 text-muted-foreground/50">·</span>
                          <span className="shrink-0">{formatDate(mission.createdAt)}</span>
                        </span>
                      </span>
                      <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${isSelected ? 'translate-x-0.5 text-primary' : 'text-muted-foreground/50 group-hover:text-muted-foreground'}`} />
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </section>

          <section aria-label="Selected mission details" className="min-h-0 flex-1 bg-muted/[0.12]">
            {selectedMission ? (
              <ScrollArea className="h-full">
                <div className="p-5 sm:p-7">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card shadow-sm">
                        {getStatusIcon(selectedMission.status, 'h-5 w-5')}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Selected mission</p>
                        <h2 className="mt-1 break-words text-lg font-semibold tracking-tight text-foreground">{selectedMission.title}</h2>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                          <Badge variant={getStatusVariant(selectedMission.status)} className="h-5 gap-1.5 rounded-full px-2 text-[9px] capitalize">
                            {getStatusIcon(selectedMission.status, 'h-3 w-3')}
                            {getStatusLabel(selectedMission.status)}
                          </Badge>
                          <span>{formatDate(selectedMission.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setPendingDelete(selectedMission)}><Trash2 className="h-3.5 w-3.5" />Delete…</Button>
                      <Button size="sm" variant={activeMissionId === selectedMission.id ? 'outline' : 'default'} className="gap-1.5" onClick={() => handleOpenMission(selectedMission.id)}><ArrowUpRight className="h-3.5 w-3.5" />{activeMissionId === selectedMission.id ? 'Open conversation' : 'Open mission'}</Button>
                    </div>
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <div className="rounded-lg border border-border/70 bg-card/60 p-3">
                      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"><FolderGit2 className="h-3 w-3 text-primary" />Workspace</div>
                      <div className="mt-2 truncate text-xs font-medium text-foreground" title={workspaces.find((workspace) => workspace.id === selectedMission.workspaceId)?.name}>{workspaces.find((workspace) => workspace.id === selectedMission.workspaceId)?.name || 'Unknown workspace'}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-card/60 p-3">
                      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"><ListTodo className="h-3 w-3 text-primary" />Tasks</div>
                      <div className="mt-2 text-xs font-medium text-foreground">{selectedMission.taskCount ?? 'Not recorded'}</div>
                    </div>
                    <div className="col-span-2 rounded-lg border border-border/70 bg-card/60 p-3 sm:col-span-1">
                      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"><Clock3 className="h-3 w-3 text-primary" />Created</div>
                      <div className="mt-2 truncate text-xs font-medium text-foreground">{formatDate(selectedMission.createdAt)}</div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-border/70 bg-card/55 p-4">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" />Conversation brief</div>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/85">{selectedMission.description || selectedMission.title}</p>
                  </div>

                  <div className="mt-4 flex gap-3 rounded-xl border border-border/70 bg-background/40 p-4">
                    <div className="mt-0.5 shrink-0">{getStatusIcon(selectedMission.status, 'h-4 w-4')}</div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">{getStatusLabel(selectedMission.status)}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{getStatusDescription(selectedMission.status)}</p>
                    </div>
                  </div>

                  {selectedMission.checkpointId ? (
                    <div className="mt-4 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Checkpoint reference</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-foreground/80">{selectedMission.checkpointId}</p>
                    </div>
                  ) : null}

                  <p className="mt-6 text-[10px] leading-relaxed text-muted-foreground">
                    Opening a mission restores its timeline and loads the recorded agent context in the main workspace.
                  </p>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground">
                  <History className="h-5 w-5" />
                </div>
                <h2 className="mt-4 text-sm font-semibold text-foreground">Your mission archive is empty</h2>
                <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">Completed and active conversations will appear here when they are available.</p>
              </div>
            )}
          </section>
        </div>
        <ConversationDeleteDialog
          mission={pendingDelete}
          onOpenChange={(nextOpen) => !nextOpen && setPendingDelete(null)}
          onDeleted={(deleted) => setSelectedMissionId((selected) => selected === deleted.id ? null : selected)}
        />
      </DialogContent>
    </Dialog>
  );
}
