import { useState } from 'react';
import { Ban, CheckCircle2, ChevronRight, CircleDashed, LayoutList, ListTodo, Loader2, Map, XCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMissionStore } from '@/stores/mission-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { effectiveTaskStatus, missionStatusLabel, type EffectiveTaskStatus } from '@/lib/mission-display';

function statusIcon(status: EffectiveTaskStatus) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case 'running':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-destructive" />;
    case 'cancelled':
      return <Ban className="h-4 w-4 text-muted-foreground" />;
    default:
      return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
  }
}

function statusColor(status: EffectiveTaskStatus) {
  switch (status) {
    case 'completed':
      return 'border-success/20 bg-success/10 text-success';
    case 'running':
      return 'border-primary/20 bg-primary/10 text-primary';
    case 'failed':
      return 'border-destructive/20 bg-destructive/10 text-destructive';
    case 'cancelled':
      return 'border-border bg-muted/70 text-muted-foreground';
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

function statusLabel(status: EffectiveTaskStatus) {
  switch (status) {
    case 'completed': return 'Completed';
    case 'running': return 'Running';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return 'Planned';
  }
}

export function PlanTab() {
  const { activeMissionId, missions, activeTasks } = useMissionStore();
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const activeMission = missions.find((mission) => mission.id === activeMissionId);

  if (!activeMission) {
    return (
      <ScrollArea className="h-full">
        <div className="mt-12 flex h-full flex-col items-center justify-center space-y-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
            <ListTodo className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Plan bekleniyor</h3>
            <p className="max-w-[220px] text-xs text-muted-foreground">
              Görev incelenip plan hazırlandığında adımlar burada görünecektir.
            </p>
          </div>
        </div>
      </ScrollArea>
    );
  }

  const missionCancelled = activeMission.status === 'cancelled';

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b p-3">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="min-w-[150px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mission plan</div>
              <Badge
                variant="outline"
                className={cn(
                  'h-5 px-1.5 text-[9px] font-semibold uppercase',
                  missionCancelled
                    ? 'border-border bg-muted/70 text-muted-foreground'
                    : activeMission.status === 'completed'
                      ? 'border-success/20 bg-success/10 text-success'
                      : ['failed', 'blocked'].includes(activeMission.status)
                        ? 'border-destructive/20 bg-destructive/10 text-destructive'
                        : 'border-primary/20 bg-primary/10 text-primary',
                )}
              >
                {missionStatusLabel(activeMission.status)}
              </Badge>
            </div>
            <h2 className="mt-1 min-w-0 break-words text-sm font-medium leading-snug text-foreground">
              {activeMission.title}
            </h2>
          </div>

          <div className="ml-auto flex shrink-0 rounded-md bg-muted p-0.5">
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 px-2 text-xs', viewMode === 'list' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => setViewMode('list')}
            >
              <LayoutList className="mr-1 h-3.5 w-3.5" />
              List
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 px-2 text-xs', viewMode === 'map' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => setViewMode('map')}
            >
              <Map className="mr-1 h-3.5 w-3.5" />
              Map
            </Button>
          </div>
        </div>

        {missionCancelled && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/45 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
            <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This mission was cancelled. Completed and failed steps are preserved; unfinished steps are shown as cancelled and no longer animate as active work.
            </span>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 pb-8">
          {activeTasks.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">
                {missionCancelled ? 'Mission cancelled before executable steps were available.' : 'Görev adımları hazırlanıyor...'}
              </p>
            </div>
          ) : viewMode === 'list' ? (
            <div className="relative space-y-3 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-border">
              {activeTasks.map((task) => {
                const displayStatus = effectiveTaskStatus(task.status, activeMission.status);
                return (
                  <div key={task.id} className="relative flex min-w-0 items-start gap-3">
                    <div
                      className={cn(
                        'z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 bg-background',
                        displayStatus === 'running' ? 'border-primary' :
                        displayStatus === 'completed' ? 'border-success' :
                        displayStatus === 'failed' ? 'border-destructive' :
                        displayStatus === 'cancelled' ? 'border-muted-foreground/50' :
                        'border-muted-foreground',
                      )}
                    >
                      {statusIcon(displayStatus)}
                    </div>

                    <Card
                      className={cn(
                        'min-w-0 flex-1 cursor-pointer space-y-2 p-3 transition-colors hover:bg-muted/30',
                        displayStatus === 'running' && 'border-primary/50 bg-primary/5',
                        displayStatus === 'cancelled' && 'bg-muted/[0.12]',
                      )}
                      onClick={() => setExpandedTasks((prev) => ({ ...prev, [task.id]: !prev[task.id] }))}
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="flex min-w-0 flex-1 items-start gap-1.5">
                          <ChevronRight className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expandedTasks[task.id] && 'rotate-90')} />
                          <h4 className="min-w-0 break-words text-sm font-medium leading-snug">{task.title}</h4>
                        </div>
                        <Badge variant="outline" className={cn('h-5 shrink-0 px-1.5 text-[9px] font-semibold uppercase', statusColor(displayStatus))}>
                          {statusLabel(displayStatus)}
                        </Badge>
                      </div>

                      {task.description && expandedTasks[task.id] && (
                        <p className="whitespace-pre-wrap break-words pl-5 text-xs leading-relaxed text-muted-foreground">
                          {task.description}
                        </p>
                      )}
                      {task.description && !expandedTasks[task.id] && (
                        <p className="line-clamp-2 break-words pl-5 text-xs text-muted-foreground">
                          {task.description}
                        </p>
                      )}
                      {task.assignedRole && (
                        <div className="flex min-w-0 items-center gap-1.5 pl-5">
                          <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {task.assignedRole}
                          </span>
                        </div>
                      )}
                    </Card>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="relative flex flex-col items-center py-2">
              {activeTasks.map((task, index) => {
                const displayStatus = effectiveTaskStatus(task.status, activeMission.status);
                return (
                  <div key={task.id} className="relative flex w-full max-w-2xl flex-col items-center">
                    {index > 0 && (
                      <div className="relative h-8 w-px bg-border">
                        <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border" />
                      </div>
                    )}
                    <Card className={cn(
                      'relative z-10 w-full min-w-0 p-4 transition-all',
                      displayStatus === 'running' && 'border-primary shadow-[0_0_15px_rgba(var(--primary),0.2)]',
                      displayStatus === 'completed' && 'border-success/50',
                      displayStatus === 'failed' && 'border-destructive/50',
                      displayStatus === 'cancelled' && 'border-border bg-muted/[0.12]',
                    )}>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                          displayStatus === 'running' ? 'border-primary text-primary' :
                          displayStatus === 'completed' ? 'border-success bg-success/10 text-success' :
                          displayStatus === 'failed' ? 'border-destructive bg-destructive/10 text-destructive' :
                          displayStatus === 'cancelled' ? 'border-border bg-muted text-muted-foreground' :
                          'border-muted bg-muted text-muted-foreground',
                        )}>
                          {statusIcon(displayStatus)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="break-words text-sm font-medium leading-snug">{task.title}</h4>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className={cn('h-5 px-1.5 text-[9px] font-semibold uppercase', statusColor(displayStatus))}>
                              {statusLabel(displayStatus)}
                            </Badge>
                            {task.assignedRole && (
                              <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {task.assignedRole}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </Card>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
