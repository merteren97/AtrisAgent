import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { KanbanSquare, GitCompare, Loader2 } from 'lucide-react';
import { useMissionStore, TaskItem } from '@/stores/mission-store';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const COLUMNS = [
  { id: 'planned', label: 'Planned', color: 'bg-muted text-muted-foreground' },
  { id: 'ready', label: 'Ready', color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
  { id: 'running', label: 'Running', color: 'bg-primary/10 text-primary border-primary/20' },
  { id: 'review', label: 'Review', color: 'bg-warning/10 text-warning border-warning/20' },
  { id: 'blocked', label: 'Blocked', color: 'bg-destructive/10 text-destructive border-destructive/20' },
  { id: 'done', label: 'Done', color: 'bg-success/10 text-success border-success/20' },
] as const;

function isCandidateTask(task: TaskItem): boolean {
  return task.assignedRole === 'builder' && /\(Candidate [AB]\)/i.test(task.title);
}

export function BoardTab() {
  const { activeTasks, activeMissionId, fetchMissionState } = useMissionStore();
  const [selectingCandidate, setSelectingCandidate] = useState<string | null>(null);
  const candidateTasks = activeTasks.filter(isCandidateTask);
  const candidateResolved = candidateTasks.some((task) => task.status === 'superseded');
  const canSelectCandidate = candidateTasks.length > 1 && !candidateResolved && candidateTasks.every((task) => task.status === 'done');

  const selectCandidate = async (taskId: string) => {
    if (!activeMissionId || selectingCandidate) return;
    setSelectingCandidate(taskId);
    try {
      await apiRequest(`/missions/${activeMissionId}/candidates/${taskId}/select`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Selected from the Candidate comparison board after review.' }),
      });
      await fetchMissionState(activeMissionId);
    } finally {
      setSelectingCandidate(null);
    }
  };

  if (!activeMissionId || activeTasks.length === 0) {
    return (
      <ScrollArea className="h-full">
        <div className="mt-12 flex h-full flex-col items-center justify-center space-y-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
            <KanbanSquare className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Board is empty</h3>
            <p className="max-w-[220px] text-xs text-muted-foreground">Mission tasks and agent progress will appear here.</p>
          </div>
        </div>
      </ScrollArea>
    );
  }

  const tasksByColumn = COLUMNS.reduce((acc, col) => {
    acc[col.id] = activeTasks.filter((task) => {
      if (col.id === 'done') return ['completed', 'done', 'superseded'].includes(task.status);
      return task.status === col.id;
    });
    return acc;
  }, {} as Record<string, TaskItem[]>);

  return (
    <div className="flex h-full flex-col">
      {candidateTasks.length > 1 && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
          <GitCompare className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Candidate comparison</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {candidateResolved
                ? 'A Builder candidate was selected; the other result is preserved as superseded.'
                : canSelectCandidate
                  ? 'Both Builder candidates and the review are complete. Select one result before QA and apply.'
                  : 'Candidates run in separate worktrees. Selection becomes available after both results complete.'}
            </p>
          </div>
        </div>
      )}
      <ScrollArea className="w-full flex-1 pb-4">
        <div className="flex h-full min-w-max gap-4 p-4">
          {COLUMNS.map((col) => {
            const columnTasks = tasksByColumn[col.id] || [];
            return (
              <div key={col.id} className="flex h-full max-h-full w-[260px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-muted/10">
                <div className="flex items-center justify-between border-b bg-card/50 p-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">{col.label}</h3>
                    <Badge variant="secondary" className={cn('h-5 px-1.5 text-[10px]', col.color)}>{columnTasks.length}</Badge>
                  </div>
                </div>
                <ScrollArea className="flex-1">
                  <div className="space-y-2 p-2">
                    {columnTasks.length === 0 ? (
                      <p className="py-4 text-center text-xs italic text-muted-foreground">Empty</p>
                    ) : columnTasks.map((task) => (
                      <Card key={task.id} className={cn('space-y-2 p-3 transition-colors hover:border-primary/50', task.status === 'superseded' && 'opacity-55')}>
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-sm font-medium leading-tight">{task.title}</h4>
                          {task.status === 'superseded' && <Badge variant="outline" className="text-[9px]">Not selected</Badge>}
                        </div>
                        {canSelectCandidate && isCandidateTask(task) && (
                          <Button size="sm" variant="outline" className="h-7 w-full border-indigo-500/30 text-[11px] text-indigo-300" onClick={() => void selectCandidate(task.id)} disabled={Boolean(selectingCandidate)}>
                            {selectingCandidate === task.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <GitCompare className="mr-1 h-3 w-3" />}
                            Select this candidate
                          </Button>
                        )}
                        <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-2">
                          {task.assignedRole ? <Badge variant="outline" className="h-4 px-1 py-0 text-[10px] font-normal">{task.assignedRole}</Badge> : <span className="text-[10px] text-muted-foreground">Unassigned</span>}
                          <span className="text-[10px] capitalize text-muted-foreground">{task.status.replaceAll('_', ' ')}</span>
                        </div>
                      </Card>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
